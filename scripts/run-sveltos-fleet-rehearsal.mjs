#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  check,
  parseDocs,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256,
  toYaml,
  write,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const allowedModes = new Set(["--run", "--generate", "--verify", "--self-test"]);
if (!allowedModes.has(mode)) {
  console.error(`Usage:
  node scripts/run-sveltos-fleet-rehearsal.mjs --run
  node scripts/run-sveltos-fleet-rehearsal.mjs --generate
  node scripts/run-sveltos-fleet-rehearsal.mjs --verify
  node scripts/run-sveltos-fleet-rehearsal.mjs --self-test`);
  process.exit(2);
}

const artifactType = "application/vnd.confighub.kubernetes.config.v1";
const deployableLayerType = "application/vnd.oci.image.layer.v1.tar+gzip";
const rehearsalRoot = join(repoRoot, "examples", "sveltos", "fleet-rehearsal");
const lockPath = join(rehearsalRoot, "source-lock.yaml");
const rolloutRoot = join(repoRoot, "examples", "sveltos", "env-rollout");
const patchRoot = join(repoRoot, "examples", "sveltos", "cve-patch");
const sveltosLockPath = join(
  repoRoot,
  "examples",
  "sveltos",
  "kyverno-fleet",
  "source-lock.yaml",
);
const receiptPath = join(
  repoRoot,
  "runs",
  "sveltos-fleet-rehearsal",
  "receipt.yaml",
);
const summaryPath = join(
  repoRoot,
  "data",
  "sveltos-fleet-rehearsal",
  "summary.md",
);
const environments = ["pilot", "staging", "prod"];
const portableRepository = "sveltos-fleet-rehearsal";
const registrationNamespace = "projectsveltos";
const backgroundDeployment = "kyverno-background-controller";
const sveltosManifestUrl =
  "https://raw.githubusercontent.com/projectsveltos/sveltos/v1.12.0/manifest/manifest.yaml";
const rehearsalClaim =
  "The delivery machinery shared by the fleet chapters works end to end on this machine: a five-cluster kind fleet built, four clusters registered by environment label, portable OCI digests reconciled by the pinned Argo CD, Kyverno converged on all four clusters, a demo application converged on all four clusters with per-environment replica counts from the same rails, a values change and a chart version bump each landed on the pilot alone while the other clusters held their state, and injected drift was repaired. No governance is claimed.";
const rehearsalBoundaryNote =
  "This rehearsal exercises the delivery machinery the governed chapters share: the kind fleet, Sveltos registration and fan-out, portable OCI through Argo CD, selective convergence, a version bump, and drift repair. No review, approval, or promotion is claimed, and no chapter matrix cell is filled by it.";
const rehearsalDifferences = [
  "Argo CD is installed from the pinned upstream manifest; the chapters receive it from cub cluster up.",
  "Argo Applications are applied with kubectl; the chapters deliver them as ConfigHub Units through the cluster Space release.",
  "Revisions come straight from the reviewed example files; the chapters store, review, and approve them in ConfigHub first.",
];

// The self-test swaps these three seams for fake surfaces and a fake clock;
// the live lane uses the real defaults.
let commandRunner = runRealCommand;
let sleeper = realSleep;
let timeSource = () => Date.now();

if (mode === "--run") {
  run();
} else if (mode === "--self-test") {
  selfTest();
} else if (mode === "--generate") {
  check(
    existsSync(receiptPath),
    `${relativeRepo(receiptPath)} is missing; run the rehearsal`,
  );
  const receipt = readYaml(receiptPath);
  verifyReceipt(receipt);
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    "the fleet rehearsal has no receipt yet; it is runnable today with no ConfigHub account because it rehearses delivery machinery only",
  );
} else {
  const receipt = readYaml(receiptPath);
  verifyReceipt(receipt);
  check(
    existsSync(summaryPath),
    `${relativeRepo(summaryPath)} is missing; run the generator`,
  );
  check(
    readFileSync(summaryPath, "utf8") === renderSummary(receipt),
    `${relativeRepo(summaryPath)} is stale`,
  );
  console.log("verified the Sveltos fleet rehearsal receipt");
}

function run() {
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_SVELTOS_REHEARSAL === "1",
    "set HELM_EXPT_ALLOW_LIVE_SVELTOS_REHEARSAL=1 to confirm this live rehearsal",
  );
  for (const [tool, args] of [
    ["curl", ["--version"]],
    ["docker", ["version"]],
    ["helm", ["version"]],
    ["kind", ["version"]],
    ["kubectl", ["version", "--client"]],
    ["oras", ["version"]],
    ["tar", ["--version"]],
  ]) {
    check(tryCommand(tool, args).ok, `${tool} is required for this rehearsal`);
  }

  const plan = loadRehearsalPlan();
  const recordedAt = new Date().toISOString();
  const runId = safeRunId(process.env.HELM_EXPT_PROOF_RUN_ID || recordedAt);
  const managementName = `hx-sveltos-rehearse-mgmt-${runId}`;
  const registryName = `hx-sveltos-rehearse-reg-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-rehearsal-"));
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const fleetClusters = plan.fleet.spec.workloads.map((workload) => ({
    cluster: `${workload.cluster}-rh-${runId}`,
    logicalCluster: workload.cluster,
    environment: workload.environment,
    kubeconfig: join(workRoot, `${workload.cluster}.kubeconfig`),
  }));
  const cleanup = {
    managementCluster: "not-created",
    workloadClusters: "not-created",
    registry: "not-created",
    localFiles: "pending",
  };
  const timings = [];
  let managementStarted = false;
  const workloadsStarted = new Set();
  let registryStarted = false;
  let receipt;

  const timed = (phaseName, fn) => {
    const startedAt = now();
    const result = fn();
    timings.push({
      phase: phaseName,
      seconds: Math.round((now() - startedAt) / 100) / 10,
    });
    phase(`${phaseName} (${timings.at(-1).seconds}s)`);
    return result;
  };

  try {
    for (const row of [managementName, ...fleetClusters.map((item) => item.cluster)]) {
      check(!clusterPresent(row), `refusing to reuse the kind cluster ${row}`);
    }
    check(
      !dockerContainerPresent(registryName),
      `refusing to reuse ${registryName}`,
    );

    const registry = timed("temporary OCI registry ready", () => {
      const started = startRegistry(registryName);
      registryStarted = true;
      cleanup.registry = "pending";
      return started;
    });

    timed("management cluster ready", () => {
      command("kind", [
        "create", "cluster",
        "--name", managementName,
        "--kubeconfig", managementKubeconfig,
        "--wait", "180s",
      ], { timeout: 420_000 });
      managementStarted = true;
      cleanup.managementCluster = "pending";
    });

    const argoInstall = timed("Argo CD converged on the management cluster", () =>
      installArgo({ managementKubeconfig, workRoot, lock: plan.lock }));
    configureAnonymousOci(managementKubeconfig, registry.clusterHost, workRoot);

    timed("four workload clusters ready", () => {
      for (const row of fleetClusters) {
        command("kind", [
          "create", "cluster",
          "--name", row.cluster,
          "--kubeconfig", row.kubeconfig,
          "--wait", "180s",
        ], { timeout: 420_000 });
        workloadsStarted.add(row.cluster);
      }
      cleanup.workloadClusters = "pending";
    });

    const sveltosInstall = timed("Sveltos controllers converged", () =>
      installSveltos({
        managementKubeconfig,
        workRoot,
        expectedManifestSha: plan.sveltosManifestSha,
      }));

    const registrations = timed("four workload clusters registered", () =>
      fleetClusters.map((row) =>
        registerWorkload({
          managementKubeconfig,
          workloadName: row.cluster,
          workloadKubeconfig: row.kubeconfig,
          workRoot,
          environment: row.environment,
        })));

    const applications = {};
    const baselineWave = timed("baseline delivered to all four clusters", () => {
      const releases = {};
      for (const environment of environments) {
        const portable = publishPortableOci({
          workRoot,
          approvedText: plan.profiles[environment].text,
          registryHost: registry.host,
          clusterRegistryHost: registry.clusterHost,
          tag: `${environment}-r1`,
        });
        const applicationName = `sveltos-rehearse-${environment}-${runId}`;
        applyApplication({
          managementKubeconfig,
          applicationName,
          sourceReference: portable.clusterReference,
          sourceRevision: portable.targetRevision,
          workRoot,
        });
        const argo = waitForApplication({
          managementKubeconfig,
          applicationName,
          expectedRevision: portable.manifestDigest,
        });
        check(
          argo.result === "pass",
          `${applicationName} did not reconcile the ${environment} baseline: ${argo.reason ?? "unknown"}`,
        );
        applications[environment] = applicationName;
        releases[environment] = { portable, argo };
      }
      const observations = fleetClusters.map((row) => {
        const observation = observeWorkload({
          managementKubeconfig,
          workloadName: row.cluster,
          workloadKubeconfig: row.kubeconfig,
          profileName: `kyverno-env-${row.environment}`,
          expectedChartVersion: plan.baselineChartVersion,
          expectedBackgroundReplicas: plan.baselineBackgroundReplicas,
          attempts: 180,
        });
        check(
          observation.result === "pass",
          `${row.cluster} did not converge on the baseline: ${observation.reason ?? "unknown"}`,
        );
        return observationRecord(row, plan.revisions[row.environment].baseline, observation);
      });
      return { releases, observations };
    });

    const applicationWave = timed("application delivered to all four clusters", () => {
      const releases = {};
      for (const environment of environments) {
        const portable = publishPortableOci({
          workRoot,
          approvedText: plan.appProfiles[environment].text,
          registryHost: registry.host,
          clusterRegistryHost: registry.clusterHost,
          tag: `${environment}-app-r1`,
        });
        const applicationName = `sveltos-rehearse-app-${environment}-${runId}`;
        applyApplication({
          managementKubeconfig,
          applicationName,
          sourceReference: portable.clusterReference,
          sourceRevision: portable.targetRevision,
          workRoot,
        });
        const argo = waitForApplication({
          managementKubeconfig,
          applicationName,
          expectedRevision: portable.manifestDigest,
        });
        check(
          argo.result === "pass",
          `${applicationName} did not reconcile the ${environment} application: ${argo.reason ?? "unknown"}`,
        );
        releases[environment] = { portable, argo };
      }
      const observations = fleetClusters.map((row) => {
        const observation = observeAppWorkload({
          managementKubeconfig,
          workloadName: row.cluster,
          workloadKubeconfig: row.kubeconfig,
          profileName: `podinfo-app-${row.environment}`,
          expectedChartVersion: plan.appChartVersion,
          expectedReplicas: plan.appReplicas[row.environment],
          attempts: 180,
        });
        check(
          observation.result === "pass",
          `${row.cluster} did not converge on the application: ${observation.reason ?? "unknown"}`,
        );
        return {
          cluster: row.cluster,
          logicalCluster: row.logicalCluster,
          environment: row.environment,
          expectedRevisionId: plan.appRevisions[row.environment],
          observation,
        };
      });
      return { releases, observations };
    });

    const valuesWave = timed("values change delivered to the pilot only", () => {
      const portable = publishPortableOci({
        workRoot,
        approvedText: renderDocuments([plan.pilotChangedDoc]),
        registryHost: registry.host,
        clusterRegistryHost: registry.clusterHost,
        tag: "pilot-r2",
      });
      applyApplication({
        managementKubeconfig,
        applicationName: applications.pilot,
        sourceReference: portable.clusterReference,
        sourceRevision: portable.targetRevision,
        workRoot,
      });
      const argo = waitForApplication({
        managementKubeconfig,
        applicationName: applications.pilot,
        expectedRevision: portable.manifestDigest,
      });
      check(
        argo.result === "pass",
        `the pilot values change did not reconcile: ${argo.reason ?? "unknown"}`,
      );
      const observations = fleetClusters.map((row) => {
        const changed = row.environment === "pilot";
        const observation = observeWorkload({
          managementKubeconfig,
          workloadName: row.cluster,
          workloadKubeconfig: row.kubeconfig,
          profileName: `kyverno-env-${row.environment}`,
          expectedChartVersion: plan.baselineChartVersion,
          expectedBackgroundReplicas: changed
            ? plan.changedBackgroundReplicas
            : plan.baselineBackgroundReplicas,
          attempts: changed ? 180 : 12,
        });
        check(
          observation.result === "pass",
          `${row.cluster} did not hold the expected state after the values change: ${observation.reason ?? "unknown"}`,
        );
        return observationRecord(
          row,
          changed ? plan.revisions.pilot.valuesChanged : plan.revisions[row.environment].baseline,
          observation,
        );
      });
      return { portable, argo, observations };
    });

    const versionWave = timed("version bump delivered to the pilot only", () => {
      const portable = publishPortableOci({
        workRoot,
        approvedText: renderDocuments([plan.pilotPatchedDoc]),
        registryHost: registry.host,
        clusterRegistryHost: registry.clusterHost,
        tag: "pilot-r3",
      });
      applyApplication({
        managementKubeconfig,
        applicationName: applications.pilot,
        sourceReference: portable.clusterReference,
        sourceRevision: portable.targetRevision,
        workRoot,
      });
      const argo = waitForApplication({
        managementKubeconfig,
        applicationName: applications.pilot,
        expectedRevision: portable.manifestDigest,
      });
      check(
        argo.result === "pass",
        `the pilot version bump did not reconcile: ${argo.reason ?? "unknown"}`,
      );
      const observations = fleetClusters.map((row) => {
        const changed = row.environment === "pilot";
        const observation = observeWorkload({
          managementKubeconfig,
          workloadName: row.cluster,
          workloadKubeconfig: row.kubeconfig,
          profileName: `kyverno-env-${row.environment}`,
          expectedChartVersion: changed
            ? plan.patchedChartVersion
            : plan.baselineChartVersion,
          expectedBackgroundReplicas: changed
            ? plan.changedBackgroundReplicas
            : plan.baselineBackgroundReplicas,
          attempts: changed ? 240 : 12,
        });
        check(
          observation.result === "pass",
          `${row.cluster} did not hold the expected state after the version bump: ${observation.reason ?? "unknown"}`,
        );
        return observationRecord(
          row,
          changed ? plan.revisions.pilot.versionBumped : plan.revisions[row.environment].baseline,
          observation,
        );
      });
      return { portable, argo, observations };
    });

    const driftRepair = timed("injected drift repaired on the pilot", () => {
      const pilot = fleetClusters.find((row) => row.environment === "pilot");
      const drift = runDriftRepair({
        workloadKubeconfig: pilot.kubeconfig,
        expectedReplicas: plan.changedBackgroundReplicas,
      });
      check(
        drift.result === "pass",
        `Sveltos did not repair injected drift on ${pilot.cluster}: ${drift.reason ?? "unknown"}`,
      );
      return { cluster: pilot.cluster, logicalCluster: pilot.logicalCluster, drift };
    });

    receipt = buildReceipt({
      recordedAt,
      plan,
      managementName,
      argoInstall,
      sveltosInstall,
      registrations,
      baselineWave,
      applicationWave,
      valuesWave,
      versionWave,
      driftRepair,
      timings,
      cleanup,
    });
  } finally {
    phase("cleaning up temporary resources");
    if (managementStarted || clusterPresent(managementName)) {
      tryCommand("kind", ["delete", "cluster", "--name", managementName], {
        timeout: 180_000,
      });
    }
    cleanup.managementCluster = clusterPresent(managementName) ? "fail" : "pass";
    for (const row of fleetClusters) {
      if (workloadsStarted.has(row.cluster) || clusterPresent(row.cluster)) {
        tryCommand("kind", ["delete", "cluster", "--name", row.cluster], {
          timeout: 180_000,
        });
      }
    }
    cleanup.workloadClusters = fleetClusters.some((row) =>
      clusterPresent(row.cluster))
      ? "fail"
      : "pass";
    if (registryStarted || dockerContainerPresent(registryName)) {
      tryCommand("docker", ["rm", "-f", registryName], { timeout: 120_000 });
    }
    cleanup.registry = dockerContainerPresent(registryName) ? "fail" : "pass";
    rmSync(workRoot, { recursive: true, force: true });
    cleanup.localFiles = existsSync(workRoot) ? "fail" : "pass";
  }

  check(receipt, "the fleet rehearsal did not complete");
  check(
    Object.values(cleanup).every((value) => value === "pass"),
    `fleet rehearsal cleanup failed: ${JSON.stringify(cleanup)}`,
  );
  writeYaml(receiptPath, receipt);
  write(summaryPath, renderSummary(receipt));
  verifyReceipt(receipt);
  console.log(
    `wrote ${relativeRepo(receiptPath)} and ${relativeRepo(summaryPath)}`,
  );
}

// The rehearsal reuses the chapters' reviewed files so it exercises exactly
// the content the governed lanes will deliver, without any governance claim.
function loadRehearsalPlan(root = repoRoot) {
  const planRolloutRoot = join(root, "examples", "sveltos", "env-rollout");
  const planPatchRoot = join(root, "examples", "sveltos", "cve-patch");
  const planLockPath = join(root, "examples", "sveltos", "fleet-rehearsal", "source-lock.yaml");
  const planSveltosLock = join(root, "examples", "sveltos", "kyverno-fleet", "source-lock.yaml");
  const fleet = readYaml(join(planRolloutRoot, "fleet.yaml"));
  const change = readYaml(join(planRolloutRoot, "change-candidate.yaml"));
  const patchCandidate = readYaml(join(planPatchRoot, "patch-candidate.yaml"));
  const lock = readYaml(planLockPath);
  const sveltosManifestSha = readYaml(planSveltosLock).spec?.sveltos?.manifestSha256;
  check(sveltosManifestSha, "the Sveltos manifest lock is missing");
  check(
    lock.kind === "SveltosFleetRehearsalLock"
      && /^[0-9a-f]{64}$/.test(String(lock.spec?.argoCd?.manifestSha256))
      && String(lock.spec?.argoCd?.manifestUrl ?? "").includes(
        String(lock.spec?.argoCd?.version ?? " "),
      )
      && lock.spec?.boundary?.governanceClaim === false,
    "the rehearsal lock lost its Argo pin or its boundary",
  );

  const workloads = fleet.spec?.workloads ?? [];
  check(
    fleet.kind === "SveltosEnvRolloutFleet"
      && workloads.length === 4
      && new Set(workloads.map((row) => row.cluster)).size === 4,
    "the shared fleet record lost its four uniquely named workload clusters",
  );
  for (const environment of environments) {
    const expected = environment === "prod" ? 2 : 1;
    check(
      workloads.filter((row) => row.environment === environment).length
        === expected,
      `the shared fleet must place ${expected} cluster(s) in ${environment}`,
    );
  }

  const profiles = {};
  for (const environment of environments) {
    const profilePath = join(planRolloutRoot, `clusterprofile-${environment}.yaml`);
    const text = readFileSync(profilePath, "utf8");
    const docs = parseDocs(text);
    check(docs.length === 1, `clusterprofile-${environment}.yaml must contain one object`);
    profiles[environment] = {
      doc: docs[0],
      text,
      repoPath: `examples/sveltos/env-rollout/clusterprofile-${environment}.yaml`,
    };
  }
  const baselineValues = parseDocs(profiles.pilot.doc.spec.helmCharts[0].values)[0];
  const baselineBackgroundReplicas = readPath(baselineValues, change.spec.valuesPath);
  check(
    baselineBackgroundReplicas === change.spec.before,
    "the rollout change before-value does not match the baseline values",
  );
  const baselineChartVersion = String(profiles.pilot.doc.spec.helmCharts[0].chartVersion);
  const patchedChartVersion = String(patchCandidate.spec.to.chartVersion);
  check(
    patchedChartVersion !== baselineChartVersion,
    "the patch candidate no longer bumps the baseline chart version",
  );

  const changedValuesObject = structuredClone(baselineValues);
  writePath(changedValuesObject, change.spec.valuesPath, change.spec.after);
  const changedValues = `${toYaml(changedValuesObject)}\n`;
  const pilotChangedDoc = structuredClone(profiles.pilot.doc);
  pilotChangedDoc.spec.helmCharts[0].values = changedValues;
  const pilotPatchedDoc = structuredClone(pilotChangedDoc);
  pilotPatchedDoc.spec.helmCharts[0].chartVersion = patchedChartVersion;

  const revisions = {};
  for (const environment of environments) {
    revisions[environment] = {
      baseline: `r1-${sha256(stableJson(profiles[environment].doc)).slice(0, 12)}`,
    };
  }
  revisions.pilot.valuesChanged = `r2-${sha256(stableJson(pilotChangedDoc)).slice(0, 12)}`;
  revisions.pilot.versionBumped = `r3-${sha256(stableJson(pilotPatchedDoc)).slice(0, 12)}`;
  check(
    new Set([
      revisions.pilot.baseline,
      revisions.pilot.valuesChanged,
      revisions.pilot.versionBumped,
    ]).size === 3,
    "the rehearsal revisions are not distinct",
  );

  const podinfoPin = lock.spec?.podinfo ?? {};
  check(
    /^[0-9a-f]{64}$/.test(String(podinfoPin.chartDigest))
      && String(podinfoPin.artifact ?? "").includes(String(podinfoPin.chartVersion)),
    "the rehearsal lock lost its application chart pin",
  );
  const appProfiles = {};
  const appReplicas = {};
  const appRevisions = {};
  for (const environment of environments) {
    const appPath = join(
      root, "examples", "sveltos", "fleet-rehearsal",
      `app-profile-${environment}.yaml`,
    );
    const appText = readFileSync(appPath, "utf8");
    const appDocs = parseDocs(appText);
    check(appDocs.length === 1, `app-profile-${environment}.yaml must contain one object`);
    const appDoc = appDocs[0];
    check(
      appDoc.kind === "ClusterProfile"
        && appDoc.metadata?.name === `podinfo-app-${environment}`
        && appDoc.spec?.clusterSelector?.matchLabels?.environment === environment
        && Object.keys(appDoc.spec.clusterSelector.matchLabels).length === 1,
      `app-profile-${environment}.yaml identity or selector changed`,
    );
    check(
      appDoc.spec?.helmCharts?.length === 1
        && appDoc.spec.helmCharts[0].chartName === "podinfo/podinfo"
        && String(appDoc.spec.helmCharts[0].chartVersion)
        === String(podinfoPin.chartVersion)
        && appDoc.spec.helmCharts[0].releaseNamespace === "podinfo",
      `app-profile-${environment}.yaml chart pin does not match the lock`,
    );
    const appValues = parseDocs(appDoc.spec.helmCharts[0].values)[0];
    const replicas = Number(appValues?.replicaCount ?? 0);
    check(replicas >= 1, `app-profile-${environment}.yaml declares no replicaCount`);
    appProfiles[environment] = {
      doc: appDoc,
      text: appText,
      repoPath: `examples/sveltos/fleet-rehearsal/app-profile-${environment}.yaml`,
    };
    appReplicas[environment] = replicas;
    appRevisions[environment] = `a1-${sha256(stableJson(appDoc)).slice(0, 12)}`;
  }
  check(
    new Set(Object.values(appReplicas)).size === environments.length,
    "the application replica counts must differ per environment so the fan-out is observable",
  );

  return {
    fleet,
    lock,
    profiles,
    pilotChangedDoc,
    pilotPatchedDoc,
    revisions,
    appProfiles,
    appReplicas,
    appRevisions,
    appChartVersion: String(podinfoPin.chartVersion),
    sveltosManifestSha,
    baselineChartVersion,
    patchedChartVersion,
    baselineBackgroundReplicas,
    changedBackgroundReplicas: change.spec.after,
  };
}

function installArgo({ managementKubeconfig, workRoot, lock }) {
  const manifestPath = join(workRoot, "argo-install.yaml");
  command("curl", ["-fsSL", lock.spec.argoCd.manifestUrl, "-o", manifestPath], {
    timeout: 180_000,
  });
  const manifestText = readFileSync(manifestPath, "utf8");
  check(
    sha256(manifestText) === lock.spec.argoCd.manifestSha256,
    "the downloaded Argo CD manifest differs from the rehearsal lock",
  );
  clusterCommand(managementKubeconfig, ["create", "namespace", "argocd"]);
  // Server-side apply is required: the ApplicationSet CRD exceeds the
  // 262KB last-applied-configuration annotation cap of client-side apply.
  clusterCommand(managementKubeconfig, [
    "apply", "--server-side", "--force-conflicts", "-n", "argocd", "-f", manifestPath,
  ], { timeout: 420_000 });
  clusterCommand(managementKubeconfig, [
    "-n", "argocd",
    "wait", "--for=condition=Available", "deployment", "--all",
    "--timeout=420s",
  ], { timeout: 480_000 });
  clusterCommand(managementKubeconfig, [
    "-n", "argocd",
    "rollout", "status", "statefulset/argocd-application-controller",
    "--timeout=420s",
  ], { timeout: 480_000 });
  return {
    version: lock.spec.argoCd.version,
    manifestUrl: lock.spec.argoCd.manifestUrl,
    manifestSha256: lock.spec.argoCd.manifestSha256,
    installationMethod:
      "pinned upstream manifest applied directly; the governed chapters receive Argo CD from cub cluster up instead",
  };
}

function applyApplication({
  managementKubeconfig,
  applicationName,
  sourceReference,
  sourceRevision,
  workRoot,
}) {
  check(
    /^(pilot|staging|prod)-(r[123]|app-r1)$/.test(sourceRevision),
    `unsupported application source revision ${sourceRevision}`,
  );
  const applicationPath = join(workRoot, `${applicationName}-${sourceRevision}.yaml`);
  writeFileSync(applicationPath, `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${applicationName}
  namespace: argocd
spec:
  project: default
  source:
    repoURL: ${sourceReference}
    targetRevision: ${sourceRevision}
    path: .
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - ServerSideApply=true
`, { mode: 0o600 });
  // The governed chapters deliver this Application as a ConfigHub Unit
  // through the cluster Space release; the rehearsal applies it directly.
  clusterCommand(managementKubeconfig, ["apply", "-f", applicationPath]);
  clusterCommand(managementKubeconfig, [
    "annotate", "application", applicationName, "-n", "argocd",
    "argocd.argoproj.io/refresh=hard", "--overwrite",
  ]);
}

function waitForApplication({ managementKubeconfig, applicationName, expectedRevision }) {
  let last = { sync: "", health: "", revision: "", comparisonError: "" };
  for (let attempt = 0; attempt < 72; attempt += 1) {
    const result = clusterTry(managementKubeconfig, [
      "-n", "argocd", "get", "application", applicationName, "-o", "json",
    ]);
    if (result.ok) {
      const application = JSON.parse(result.output);
      last = {
        sync: String(application.status?.sync?.status ?? ""),
        health: String(application.status?.health?.status ?? ""),
        revision: normalizeDigest(application.status?.sync?.revision),
        comparisonError: String(
          (application.status?.conditions ?? [])
            .find((condition) => condition.type === "ComparisonError")
            ?.message
          ?? "",
        ),
      };
      if (
        last.sync === "Synced"
        && last.health === "Healthy"
        && last.revision === expectedRevision
      ) {
        return {
          result: "pass",
          sync: last.sync,
          health: last.health,
          revision: last.revision,
          expectedRevision,
          digestMatchesPortableOci: true,
        };
      }
      if (attempt >= 3 && last.comparisonError) {
        return { result: "blocked", reason: sanitizeError(last.comparisonError) };
      }
    }
    sleep(5000);
  }
  return {
    result: "blocked",
    reason: `sync=${last.sync || "missing"}; health=${last.health || "missing"}; revision=${last.revision || "missing"}; expected=${expectedRevision}; error=${last.comparisonError || "none"}`,
  };
}

function observationRecord(row, expectedRevisionId, observation) {
  return {
    cluster: row.cluster,
    logicalCluster: row.logicalCluster,
    environment: row.environment,
    expectedRevisionId,
    observation,
  };
}

function observeWorkload({
  managementKubeconfig,
  workloadName,
  workloadKubeconfig,
  profileName,
  expectedChartVersion,
  expectedBackgroundReplicas,
  attempts,
}) {
  let last = { summary: "missing", helmStatus: "missing", deployments: [], chart: "missing" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const summaries = clusterTry(managementKubeconfig, [
      "get", "clustersummaries", "-A", "-o", "json",
    ]);
    const deployments = clusterTry(workloadKubeconfig, [
      "-n", "kyverno", "get", "deployments", "-o", "json",
    ]);
    if (summaries.ok) {
      const items = JSON.parse(summaries.output).items ?? [];
      const summary = items.find((item) => {
        const profileLabel =
          item.metadata?.labels?.["projectsveltos.io/cluster-profile-name"];
        const profileOwner = (item.metadata?.ownerReferences ?? []).some(
          (owner) => owner.kind === "ClusterProfile" && owner.name === profileName,
        );
        return item.spec?.clusterName === workloadName
          && item.spec?.clusterNamespace === registrationNamespace
          && item.spec?.clusterType === "Sveltos"
          && (profileLabel === profileName || profileOwner);
      });
      if (summary) {
        const helmFeature = (summary.status?.featureSummaries ?? []).find(
          (feature) => String(feature.featureID ?? feature.featureId) === "Helm",
        );
        last.summary = `${summary.metadata.namespace}/${summary.metadata.name}`;
        last.helmStatus = String(helmFeature?.status ?? "missing");
      }
    }
    if (deployments.ok) {
      last.deployments = JSON.parse(deployments.output).items
        .map((deployment) => ({
          name: deployment.metadata.name,
          desired: Number(deployment.spec?.replicas ?? 0),
          available: Number(deployment.status?.availableReplicas ?? 0),
          observedGenerationMatches:
            deployment.status?.observedGeneration
            === deployment.metadata?.generation,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    const background = last.deployments.find(
      (deployment) => deployment.name === backgroundDeployment,
    );
    const stable =
      last.deployments.length === 4
      && last.deployments.every(
        (deployment) =>
          deployment.desired === deployment.available
          && deployment.observedGenerationMatches,
      )
      && background?.desired === expectedBackgroundReplicas;
    if (last.helmStatus === "Provisioned" && stable) {
      const releases = JSON.parse(
        command("helm", [
          "--kubeconfig", workloadKubeconfig,
          "list", "-n", "kyverno", "-o", "json",
        ]).output,
      );
      const release = releases.find((item) => item.name === "kyverno");
      check(release, `the Kyverno Helm release is missing on ${workloadName}`);
      last.chart = release.chart;
      if (release.chart === `kyverno-${expectedChartVersion}`) {
        return {
          result: "pass",
          clusterSummary: last.summary,
          helmFeatureStatus: last.helmStatus,
          helmRelease: {
            name: release.name,
            namespace: release.namespace,
            chart: release.chart,
            applicationVersion: release.app_version,
            status: release.status,
          },
          backgroundReplicas: {
            desired: background.desired,
            available: background.available,
          },
          deployments: last.deployments,
        };
      }
    }
    if (attempt + 1 < attempts) sleep(4000);
  }
  return {
    result: "fail",
    reason: `summary=${last.summary}; helm=${last.helmStatus}; chart=${last.chart}; expectedChart=kyverno-${expectedChartVersion}; deployments=${
      JSON.stringify(last.deployments)
    }; expectedBackgroundReplicas=${expectedBackgroundReplicas}`,
  };
}

function observeAppWorkload({
  managementKubeconfig,
  workloadName,
  workloadKubeconfig,
  profileName,
  expectedChartVersion,
  expectedReplicas,
  attempts,
}) {
  let last = { summary: "missing", helmStatus: "missing", deployment: "missing" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const summaries = clusterTry(managementKubeconfig, [
      "get", "clustersummaries", "-A", "-o", "json",
    ]);
    if (summaries.ok) {
      const items = JSON.parse(summaries.output).items ?? [];
      const summary = items.find((item) => {
        const profileLabel =
          item.metadata?.labels?.["projectsveltos.io/cluster-profile-name"];
        const profileOwner = (item.metadata?.ownerReferences ?? []).some(
          (owner) => owner.kind === "ClusterProfile" && owner.name === profileName,
        );
        return item.spec?.clusterName === workloadName
          && item.spec?.clusterNamespace === registrationNamespace
          && item.spec?.clusterType === "Sveltos"
          && (profileLabel === profileName || profileOwner);
      });
      if (summary) {
        const helmFeature = (summary.status?.featureSummaries ?? []).find(
          (feature) => String(feature.featureID ?? feature.featureId) === "Helm",
        );
        last.summary = `${summary.metadata.namespace}/${summary.metadata.name}`;
        last.helmStatus = String(helmFeature?.status ?? "missing");
      }
    }
    const deployment = clusterTry(workloadKubeconfig, [
      "-n", "podinfo", "get", "deployment", "podinfo", "-o", "json",
    ]);
    if (deployment.ok) {
      const current = JSON.parse(deployment.output);
      const desired = Number(current.spec?.replicas ?? 0);
      const available = Number(current.status?.availableReplicas ?? 0);
      last.deployment = `desired=${desired} available=${available}`;
      const stable =
        desired === expectedReplicas
        && available === expectedReplicas
        && current.status?.observedGeneration === current.metadata?.generation;
      if (last.helmStatus === "Provisioned" && stable) {
        const releases = JSON.parse(
          command("helm", [
            "--kubeconfig", workloadKubeconfig,
            "list", "-n", "podinfo", "-o", "json",
          ]).output,
        );
        const release = releases.find((item) => item.name === "podinfo");
        check(release, `the podinfo Helm release is missing on ${workloadName}`);
        if (release.chart === `podinfo-${expectedChartVersion}`) {
          return {
            result: "pass",
            clusterSummary: last.summary,
            helmFeatureStatus: last.helmStatus,
            helmRelease: {
              name: release.name,
              namespace: release.namespace,
              chart: release.chart,
              applicationVersion: release.app_version,
              status: release.status,
            },
            replicas: { desired, available },
          };
        }
      }
    }
    if (attempt + 1 < attempts) sleep(4000);
  }
  return {
    result: "fail",
    reason: `summary=${last.summary}; helm=${last.helmStatus}; deployment=${last.deployment}; expectedReplicas=${expectedReplicas}`,
  };
}

function runDriftRepair({ workloadKubeconfig, expectedReplicas }) {
  clusterCommand(workloadKubeconfig, [
    "-n", "kyverno",
    "scale", "deployment", backgroundDeployment, "--replicas=1",
  ]);
  let changed = false;
  let attempts = 0;
  for (; attempts < 180; attempts += 1) {
    const current = JSON.parse(
      clusterCommand(workloadKubeconfig, [
        "-n", "kyverno", "get", "deployment", backgroundDeployment, "-o", "json",
      ]).output,
    );
    const replicas = Number(current.spec?.replicas ?? 0);
    const available = Number(current.status?.availableReplicas ?? 0);
    if (replicas === 1) changed = true;
    if (
      changed
      && replicas === expectedReplicas
      && available === expectedReplicas
      && current.status?.observedGeneration === current.metadata?.generation
    ) {
      return {
        result: "pass",
        object: `apps/v1/Deployment/kyverno/${backgroundDeployment}`,
        reviewedReplicas: expectedReplicas,
        changedReplicas: 1,
        restoredReplicas: expectedReplicas,
        pollAttempts: attempts + 1,
        pollIntervalSeconds: 3,
      };
    }
    sleep(3000);
  }
  return {
    result: "fail",
    reason: `replica drift was not restored after ${attempts} attempts`,
  };
}

function installSveltos({ managementKubeconfig, workRoot, expectedManifestSha }) {
  const manifestPath = join(workRoot, "sveltos-manifest.yaml");
  command("curl", ["-fsSL", sveltosManifestUrl, "-o", manifestPath], {
    timeout: 180_000,
  });
  const manifestText = readFileSync(manifestPath, "utf8");
  check(
    sha256(manifestText) === expectedManifestSha,
    "the downloaded Sveltos manifest differs from the source lock",
  );
  const documents = parseDocs(manifestText);
  const serviceMonitors = documents.filter(
    (document) =>
      document.apiVersion === "monitoring.coreos.com/v1"
      && document.kind === "ServiceMonitor",
  );
  const crds = documents.filter(
    (document) =>
      document.apiVersion === "apiextensions.k8s.io/v1"
      && document.kind === "CustomResourceDefinition",
  );
  const resources = documents.filter(
    (document) =>
      !serviceMonitors.includes(document) && !crds.includes(document),
  );
  check(crds.length > 0, "the Sveltos manifest contains no CRDs");
  check(resources.length > 0, "the Sveltos manifest contains no resources");
  const crdPath = join(workRoot, "sveltos-crds.yaml");
  const resourcePath = join(workRoot, "sveltos-resources.yaml");
  writeDocuments(crdPath, crds);
  writeDocuments(resourcePath, resources);
  clusterCommand(managementKubeconfig, ["apply", "-f", crdPath], {
    timeout: 300_000,
  });
  for (const crd of crds) {
    clusterCommand(managementKubeconfig, [
      "wait", "--for=condition=Established",
      `crd/${crd.metadata.name}`, "--timeout=180s",
    ], { timeout: 240_000 });
  }
  clusterCommand(managementKubeconfig, ["apply", "-f", resourcePath], {
    timeout: 420_000,
  });
  clusterCommand(managementKubeconfig, [
    "-n", registrationNamespace,
    "wait", "--for=condition=Available", "deployment", "--all",
    "--timeout=420s",
  ], { timeout: 480_000 });
  return {
    source: sveltosManifestUrl,
    version: "v1.12.0",
    manifestSha256: expectedManifestSha,
    crdCount: crds.length,
    appliedObjectCount: crds.length + resources.length,
    omittedOptionalServiceMonitorCount: serviceMonitors.length,
    installationMethod: "pinned manifest applied as a management-cluster prerequisite",
  };
}

function registerWorkload({
  managementKubeconfig,
  workloadName,
  workloadKubeconfig,
  workRoot,
  environment,
}) {
  check(
    environments.includes(environment),
    `unsupported environment label ${environment}`,
  );
  const serviceAccountPath = join(
    workRoot,
    `${workloadName}-sveltos-workload-access.yaml`,
  );
  writeFileSync(serviceAccountPath, `apiVersion: v1
kind: Namespace
metadata:
  name: ${registrationNamespace}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sveltos-manager
  namespace: ${registrationNamespace}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sveltos-manager
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: sveltos-manager
    namespace: ${registrationNamespace}
`, { mode: 0o600 });
  clusterCommand(workloadKubeconfig, ["apply", "-f", serviceAccountPath]);
  const token = clusterCommand(workloadKubeconfig, [
    "-n", registrationNamespace,
    "create", "token", "sveltos-manager", "--duration=6h",
  ]).output.trim();
  check(token.length > 40, "Kubernetes returned no registration token");
  const workloadConfig = JSON.parse(
    clusterCommand(workloadKubeconfig, [
      "config", "view", "--raw", "-o", "json",
    ]).output,
  );
  const cluster = workloadConfig.clusters?.[0]?.cluster;
  check(
    cluster?.["certificate-authority-data"],
    "the workload kubeconfig contains no certificate authority",
  );
  const registeredKubeconfig = `apiVersion: v1
kind: Config
clusters:
  - name: workload
    cluster:
      server: https://${workloadName}-control-plane:6443
      certificate-authority-data: ${cluster["certificate-authority-data"]}
users:
  - name: sveltos-manager
    user:
      token: ${token}
contexts:
  - name: workload
    context:
      cluster: workload
      user: sveltos-manager
current-context: workload
`;
  const registrationPath = join(
    workRoot,
    `${workloadName}-sveltos-registration.yaml`,
  );
  writeFileSync(registrationPath, `apiVersion: v1
kind: Secret
metadata:
  name: ${workloadName}-sveltos-kubeconfig
  namespace: ${registrationNamespace}
type: Opaque
data:
  kubeconfig: ${Buffer.from(registeredKubeconfig).toString("base64")}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata:
  name: ${workloadName}
  namespace: ${registrationNamespace}
  labels:
    environment: ${environment}
    sveltos-agent: present
spec: {}
`, { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", registrationPath]);
  const observed = waitForRegistration(managementKubeconfig, workloadName);
  check(
    observed.ready,
    `Sveltos did not register ${workloadName}: ${observed.reason}`,
  );
  return {
    method: "programmatic SveltosCluster registration",
    namespace: registrationNamespace,
    cluster: workloadName,
    labels: { environment, "sveltos-agent": "present" },
    credential: {
      type: "short-lived Kubernetes service-account token",
      duration: "6h",
      storedInRepository: false,
      removedWithClusters: true,
    },
    ready: true,
    kubernetesVersion: observed.kubernetesVersion,
  };
}

function waitForRegistration(managementKubeconfig, workloadName) {
  let reason = "SveltosCluster status is missing";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = clusterTry(managementKubeconfig, [
      "-n", registrationNamespace,
      "get", "sveltoscluster", workloadName, "-o", "json",
    ]);
    if (result.ok) {
      const cluster = JSON.parse(result.output);
      const conditions = cluster.status?.conditions ?? [];
      const readyCondition = conditions.find(
        (condition) =>
          ["Ready", "ConnectionStatus"].includes(condition.type)
          && condition.status === "True",
      );
      const ready =
        cluster.status?.ready === true
        || cluster.status?.connectionStatus === "Healthy"
        || Boolean(readyCondition);
      reason = conditions
        .map((condition) =>
          `${condition.type}=${condition.status}:${condition.message ?? ""}`)
        .join("; ")
        || JSON.stringify(cluster.status ?? {});
      if (ready) {
        return {
          ready: true,
          kubernetesVersion: String(
            cluster.status?.version
            ?? cluster.status?.kubernetesVersion
            ?? "",
          ),
        };
      }
    }
    sleep(3000);
  }
  return { ready: false, reason: sanitizeError(reason) };
}

function configureAnonymousOci(managementKubeconfig, registryHost, workRoot) {
  const secretPath = join(workRoot, "anonymous-oci.yaml");
  writeFileSync(secretPath, `apiVersion: v1
kind: Secret
metadata:
  name: helm-expt-anonymous-oci
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repo-creds
type: Opaque
stringData:
  url: oci://${registryHost}
  type: oci
  enableOCI: "true"
  insecureOCIForceHttp: "true"
`, { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", secretPath]);
}

function startRegistry(name) {
  const started = tryCommand("docker", [
    "run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::5000", "registry:2",
  ], { timeout: 120_000 });
  check(started.ok, `could not start the temporary OCI registry: ${started.error}`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = tryCommand("docker", ["port", name, "5000/tcp"]);
    const match = port.output.match(/127\.0\.0\.1:(\d+)/);
    if (match) {
      const host = `127.0.0.1:${match[1]}`;
      if (tryCommand("curl", ["-fsS", `http://${host}/v2/`]).ok) {
        return { host, clusterHost: `host.docker.internal:${match[1]}` };
      }
    }
    sleep(1000);
  }
  tryCommand("docker", ["rm", "-f", name], { timeout: 120_000 });
  throw new Error("temporary OCI registry did not publish a host port");
}

function publishPortableOci({
  workRoot,
  approvedText,
  registryHost,
  clusterRegistryHost,
  tag,
}) {
  check(
    /^(pilot|staging|prod)-(r[123]|app-r1)$/.test(tag),
    `unsupported OCI tag ${tag}`,
  );
  const outputRoot = join(workRoot, `portable-output-${tag}`);
  const pullRoot = join(workRoot, `portable-output-${tag}-pulled`);
  const outputFile = join(outputRoot, "clusterprofile.yaml");
  const bundleFile = join(outputRoot, "bundle.tar.gz");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(outputFile, approvedText);
  command("tar", ["-czf", bundleFile, "clusterprofile.yaml"], { cwd: outputRoot });
  const localReference = `${registryHost}/${portableRepository}:${tag}`;
  command("oras", [
    "push", "--plain-http",
    "--artifact-type", artifactType,
    "--format", "json",
    localReference,
    `bundle.tar.gz:${deployableLayerType}`,
  ], { cwd: outputRoot, timeout: 180_000 });
  const descriptor = JSON.parse(command("oras", [
    "manifest", "fetch", "--plain-http", "--descriptor", localReference,
  ]).output);
  const manifestDigest = normalizeDigest(descriptor.digest);
  check(manifestDigest, "portable rehearsal OCI has no manifest digest");
  command("oras", [
    "pull", "--plain-http", "--output", pullRoot,
    `${registryHost}/${portableRepository}@${manifestDigest}`,
  ], { timeout: 120_000 });
  const pulledBundle = join(pullRoot, "bundle.tar.gz");
  check(existsSync(pulledBundle), "pulled portable OCI is missing bundle.tar.gz");
  command("tar", ["-xzf", pulledBundle, "-C", pullRoot]);
  const pulledFile = join(pullRoot, "clusterprofile.yaml");
  check(existsSync(pulledFile), "pulled portable OCI is missing the profile");
  const pulledText = readFileSync(pulledFile, "utf8");
  check(
    canonicalDocs(parseDocs(pulledText)) === canonicalDocs(parseDocs(approvedText)),
    "pulled portable OCI differs from the packaged content",
  );
  return {
    reference: `oci://${localReference}`,
    clusterReference: `oci://${clusterRegistryHost}/${portableRepository}`,
    targetRevision: tag,
    manifestDigest,
    objectCount: 1,
    packagedDataSha256: sha256(approvedText),
    pulledDataSha256: sha256(pulledText),
    objectsMatchPackagedData: true,
    anonymousPull: true,
    registryLifetime: "temporary",
  };
}

function buildReceipt({
  recordedAt,
  plan,
  managementName,
  argoInstall,
  sveltosInstall,
  registrations,
  baselineWave,
  applicationWave,
  valuesWave,
  versionWave,
  driftRepair,
  timings,
  cleanup,
}) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosFleetRehearsalReceipt",
    metadata: { name: "fleet-delivery-rehearsal" },
    spec: {
      recordedAt,
      boundary: {
        governanceClaim: false,
        configHubUsed: false,
        note: rehearsalBoundaryNote,
        differencesFromGovernedLanes: rehearsalDifferences,
      },
      source: {
        profiles: Object.fromEntries(environments.map((environment) => [
          environment,
          {
            path: plan.profiles[environment].repoPath,
            rawSha256: sha256(plan.profiles[environment].text),
          },
        ])),
        appProfiles: Object.fromEntries(environments.map((environment) => [
          environment,
          {
            path: plan.appProfiles[environment].repoPath,
            rawSha256: sha256(plan.appProfiles[environment].text),
          },
        ])),
        appChart: {
          chartVersion: plan.appChartVersion,
          chartDigest: plan.lock.spec.podinfo.chartDigest,
          artifact: plan.lock.spec.podinfo.artifact,
        },
        rehearsalLock: "examples/sveltos/fleet-rehearsal/source-lock.yaml",
        sveltosLock: relativeRepo(sveltosLockPath),
        baselineChartVersion: plan.baselineChartVersion,
        patchedChartVersion: plan.patchedChartVersion,
        baselineBackgroundReplicas: plan.baselineBackgroundReplicas,
        changedBackgroundReplicas: plan.changedBackgroundReplicas,
      },
      revisions: { ...plan.revisions, app: plan.appRevisions },
      prerequisites: { argoCd: argoInstall, sveltos: sveltosInstall },
      fleet: {
        managementCluster: managementName,
        creationCommand: "kind create cluster",
        registrations,
      },
      waves: {
        baseline: baselineWave,
        application: applicationWave,
        valuesChange: valuesWave,
        versionBump: versionWave,
      },
      driftRepair,
      timings,
      cleanup,
      limits: [
        "No ConfigHub organization, review, approval, or release was involved; this is not a governance proof.",
        "The portable OCI used a temporary anonymous registry; this is not a permanent public package.",
        "The rehearsal used five local kind clusters on one machine. It measures this machine, not a production fleet.",
        "The chapter matrices are untouched; only the governed lanes may fill their observed cells.",
      ],
    },
    status: {
      result: "pass",
      claim: rehearsalClaim,
    },
  };
}

function verifyReceipt(receipt) {
  check(
    receipt.kind === "SveltosFleetRehearsalReceipt",
    "fleet rehearsal receipt kind changed",
  );
  check(receipt.status?.result === "pass", "fleet rehearsal is not pass");
  const plan = loadRehearsalPlan();
  check(
    receipt.spec?.boundary?.governanceClaim === false
      && receipt.spec.boundary.configHubUsed === false
      && receipt.spec.boundary.note === rehearsalBoundaryNote
      && JSON.stringify(receipt.spec.boundary.differencesFromGovernedLanes)
      === JSON.stringify(rehearsalDifferences)
      && receipt.status.claim === rehearsalClaim,
    "the rehearsal boundary was weakened",
  );
  const serialized = JSON.stringify(receipt);
  check(
    !serialized.includes("beforeApproval") && !serialized.includes("ApprovedBy"),
    "the rehearsal receipt must not resemble a governance receipt",
  );
  for (const environment of environments) {
    check(
      receipt.spec?.source?.profiles?.[environment]?.rawSha256
        === sha256(plan.profiles[environment].text),
      `fleet rehearsal ${environment} source record changed`,
    );
    check(
      receipt.spec?.revisions?.[environment]?.baseline
        === plan.revisions[environment].baseline,
      "the rehearsal revisions no longer match the reviewed example files",
    );
  }
  check(
    receipt.spec.revisions.pilot.valuesChanged === plan.revisions.pilot.valuesChanged
      && receipt.spec.revisions.pilot.versionBumped === plan.revisions.pilot.versionBumped,
    "the rehearsal pilot revisions no longer match the reviewed example files",
  );
  check(
    receipt.spec?.prerequisites?.argoCd?.manifestSha256
      === plan.lock.spec.argoCd.manifestSha256
      && receipt.spec.prerequisites.argoCd.version
      === plan.lock.spec.argoCd.version
      && receipt.spec.prerequisites.sveltos?.manifestSha256
      === plan.sveltosManifestSha,
    "the rehearsal prerequisite pins changed",
  );
  const registrations = receipt.spec?.fleet?.registrations ?? [];
  check(
    registrations.length === 4
      && registrations.every(
        (registration) =>
          registration.ready === true
          && registration.credential?.storedInRepository === false,
      )
      && registrations.filter((registration) =>
        registration.labels?.environment === "prod").length === 2,
    "fleet rehearsal registration record changed",
  );
  const waves = receipt.spec?.waves;
  check(
    (waves?.baseline?.observations ?? []).length === 4
      && waves.baseline.observations.every(
        (row) => row.observation?.result === "pass"
          && row.observation.helmRelease?.chart
          === `kyverno-${plan.baselineChartVersion}`
          && row.observation.backgroundReplicas?.desired
          === plan.baselineBackgroundReplicas,
      ),
    "fleet rehearsal baseline wave changed",
  );
  for (const environment of environments) {
    check(
      receipt.spec?.source?.appProfiles?.[environment]?.rawSha256
        === sha256(plan.appProfiles[environment].text),
      `fleet rehearsal ${environment} application source record changed`,
    );
    check(
      receipt.spec?.revisions?.app?.[environment]
        === plan.appRevisions[environment],
      "the rehearsal application revisions no longer match the reviewed example files",
    );
  }
  check(
    receipt.spec?.source?.appChart?.chartDigest
      === plan.lock.spec.podinfo.chartDigest
      && receipt.spec.source.appChart.chartVersion === plan.appChartVersion,
    "the rehearsal application chart pin changed",
  );
  const applicationWave = receipt.spec?.waves?.application;
  check(
    (applicationWave?.observations ?? []).length === 4
      && applicationWave.observations.every(
        (row) =>
          row.observation?.result === "pass"
          && row.observation.helmRelease?.chart
          === `podinfo-${plan.appChartVersion}`
          && row.observation.replicas?.desired
          === plan.appReplicas[row.environment]
          && row.observation.replicas.available
          === plan.appReplicas[row.environment],
      )
      && environments.every((environment) => {
        const release = applicationWave.releases?.[environment];
        return release?.argo?.result === "pass"
          && release.argo.revision === release.portable.manifestDigest;
      })
      && new Set(environments.map((environment) =>
        applicationWave.releases[environment].portable.manifestDigest)).size === 3,
    "fleet rehearsal application wave changed",
  );
  const checkSelective = (wave, expectedPilotChart, expectedPilotReplicas, waveName) => {
    check(
      (wave?.observations ?? []).length === 4
        && wave.argo?.result === "pass"
        && wave.argo.revision === wave.portable.manifestDigest
        && wave.observations.every((row) => {
          const pilot = row.environment === "pilot";
          const expectedChart = pilot ? expectedPilotChart : plan.baselineChartVersion;
          const expectedReplicas = pilot
            ? expectedPilotReplicas
            : plan.baselineBackgroundReplicas;
          return row.observation?.result === "pass"
            && row.observation.helmRelease?.chart === `kyverno-${expectedChart}`
            && row.observation.backgroundReplicas?.desired === expectedReplicas;
        }),
      `fleet rehearsal ${waveName} wave changed`,
    );
  };
  checkSelective(
    waves?.valuesChange,
    plan.baselineChartVersion,
    plan.changedBackgroundReplicas,
    "values-change",
  );
  checkSelective(
    waves?.versionBump,
    plan.patchedChartVersion,
    plan.changedBackgroundReplicas,
    "version-bump",
  );
  check(
    new Set([
      waves.baseline.releases.pilot.portable.manifestDigest,
      waves.valuesChange.portable.manifestDigest,
      waves.versionBump.portable.manifestDigest,
    ]).size === 3,
    "the rehearsal waves did not produce three distinct pilot digests",
  );
  check(
    receipt.spec?.driftRepair?.drift?.result === "pass"
      && receipt.spec.driftRepair.drift.restoredReplicas
      === plan.changedBackgroundReplicas,
    "fleet rehearsal drift repair changed",
  );
  check(
    (receipt.spec?.timings ?? []).length >= 6
      && receipt.spec.timings.every(
        (row) => typeof row.seconds === "number" && row.seconds >= 0,
      ),
    "fleet rehearsal timings changed",
  );
  check(
    (receipt.spec?.limits ?? []).some((limit) =>
      limit.includes("not a governance proof")),
    "fleet rehearsal limits lost the no-governance boundary",
  );
  for (const key of ["managementCluster", "workloadClusters", "registry", "localFiles"]) {
    check(
      receipt.spec?.cleanup?.[key] === "pass",
      "fleet rehearsal cleanup did not pass",
    );
  }
  check(
    !serialized.includes("@confighub.com"),
    "fleet rehearsal receipt contains a user identity",
  );
  check(!serialized.includes("ch_"), "fleet rehearsal receipt contains a credential");
}

function renderSummary(receipt) {
  const timingRows = receipt.spec.timings
    .map((row) => `| ${row.phase} | ${row.seconds}s |`)
    .join("\n");
  const totalSeconds = Math.round(
    receipt.spec.timings.reduce((sum, row) => sum + row.seconds, 0),
  );
  return `# The fleet delivery machinery works on this machine

This rehearsal exists so the governed chapters do not meet their cluster
machinery for the first time on patch day. It built the full reference fleet
and drove the shared delivery path end to end with no ConfigHub involved.

Boundary: no review, approval, or promotion is claimed. Argo CD came from the
pinned upstream manifest instead of cub cluster up, Applications were applied
with kubectl instead of delivered as ConfigHub Units, and the chapter
matrices are untouched. When this receipt was recorded
(${receipt.spec.recordedAt.slice(0, 10)}), the governed lanes were still
blocked by confighubai/confighub#4975.

What ran: a five-cluster kind fleet (one management cluster, four workload
clusters registered by environment label), Kyverno
${receipt.spec.source.baselineChartVersion} converged on all four clusters
from portable OCI digests reconciled by Argo CD
${receipt.spec.prerequisites.argoCd.version}, a values change landed on the
pilot alone, a chart version bump to
${receipt.spec.source.patchedChartVersion} landed on the pilot alone with the
values intact, the other three clusters held their state through both, and
injected drift was repaired. The demo application rode the same rails:
podinfo ${receipt.spec.source.appChart.chartVersion} converged on all four
clusters with per-environment replica counts.

| Phase | Duration |
| --- | --- |
${timingRows}
| Total measured | ${totalSeconds}s |

| Check | Result |
| --- | --- |
| Clusters converged at baseline | ${receipt.spec.waves.baseline.observations.filter((row) => row.observation.result === "pass").length}/4 |
| Application clusters converged | ${receipt.spec.waves.application.observations.filter((row) => row.observation.result === "pass").length}/4, replicas per environment |
| Selective values change | pilot only |
| Selective version bump | pilot only, values intact |
| Distinct pilot digests across waves | 3 |
| Drift repaired | ${receipt.spec.driftRepair.drift.result} |
| Cleanup | ${Object.values(receipt.spec.cleanup).every((value) => value === "pass") ? "Pass" : "Fail"} |

## Limits

${receipt.spec.limits.map((limit) => `- ${limit}`).join("\n")}

- [Committed receipt](../../runs/sveltos-fleet-rehearsal/receipt.yaml)
- [Rehearsal source lock](../../examples/sveltos/fleet-rehearsal/source-lock.yaml)
`;
}

function renderDocuments(documents) {
  return `${documents.map((document) =>
    JSON.stringify(document, null, 2)).join("\n---\n")}\n`;
}

function writeDocuments(path, documents) {
  writeFileSync(path, renderDocuments(documents));
}

function clusterCommand(kubeconfig, args, options = {}) {
  return command("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function clusterTry(kubeconfig, args, options = {}) {
  return tryCommand("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function clusterPresent(name) {
  const result = tryCommand("kind", ["get", "clusters"]);
  return result.ok && result.output.split(/\r?\n/).includes(name);
}

function dockerContainerPresent(name) {
  const result = tryCommand("docker", [
    "ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}",
  ]);
  return result.ok && result.output.split(/\r?\n/).includes(name);
}

function canonicalDocs(documents) {
  return JSON.stringify(
    documents
      .map((document) => ({
        identity: identity(document),
        document: canonicalValue(document),
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
  );
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) =>
        !key.startsWith("$comment$")
        && key !== "status"
        && key !== "managedFields"
        && key !== "creationTimestamp"
        && key !== "generation"
        && key !== "resourceVersion"
        && key !== "uid")
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function identity(document) {
  return [
    document.apiVersion ?? "",
    document.kind ?? "",
    document.metadata?.namespace ?? "",
    document.metadata?.name ?? "",
  ].join("|");
}

function normalizeDigest(value) {
  const match = String(value ?? "").match(/sha256:[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : "";
}

function readPath(value, path) {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function writePath(value, path, next) {
  const keys = path.split(".");
  let current = value;
  for (const key of keys.slice(0, -1)) {
    check(
      current[key] && typeof current[key] === "object",
      `values path ${path} does not exist in the baseline values`,
    );
    current = current[key];
  }
  current[keys.at(-1)] = next;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function command(file, args, options = {}) {
  const result = tryCommand(file, args, options);
  if (!result.ok) {
    throw new Error(
      `${file} ${args.slice(0, 6).join(" ")} failed: ${result.error}`,
    );
  }
  return result;
}

function tryCommand(file, args, options = {}) {
  return commandRunner(file, args, options);
}

function runRealCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
    maxBuffer: 1024 * 1024 * 100,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    output: result.stdout ?? "",
    error: sanitizeError(
      result.error?.message
      ?? result.stderr
      ?? result.stdout
      ?? `exit ${result.status}`,
    ),
  };
}

function sanitizeError(value) {
  return String(value ?? "")
    .replace(/(?i:password|token|secret)\s*[:=]\s*\S+/g, "$1=<redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<redacted-long-value>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function safeRunId(value) {
  const compact = String(value).replace(/\D/g, "").slice(0, 14);
  check(
    compact.length >= 8,
    "HELM_EXPT_PROOF_RUN_ID must contain at least eight digits",
  );
  return compact;
}

function sleep(milliseconds) {
  sleeper(milliseconds);
}

function realSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function now() {
  return timeSource();
}

function phase(message) {
  console.log(`[sveltos-fleet-rehearsal] ${message}`);
}

function selfTest() {
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-rehearsal-self-test-"));
  const realRunner = commandRunner;
  const realSleeper = sleeper;
  const realTime = timeSource;
  try {
    let clockMs = 0;
    const registry = createFakeOciRegistry();
    const canned = { argoBytes: "self-test-argo-manifest" };
    commandRunner = (file, args, options = {}) => {
      if (file === "oras") return registry.handle(args, options);
      if (file === "tar") return realRunner(file, args, options);
      if (file === "curl") {
        const outputPath = args[args.indexOf("-o") + 1];
        writeFileSync(outputPath, canned.argoBytes);
        return { ok: true, status: 0, output: "", error: "" };
      }
      return {
        ok: false,
        status: 1,
        output: "",
        error: `the self-test fake surface refuses ${file}`,
      };
    };
    sleeper = (milliseconds) => { clockMs += milliseconds; };
    timeSource = () => clockMs;

    const plan = loadRehearsalPlan();
    check(
      plan.baselineChartVersion !== plan.patchedChartVersion
        && plan.baselineBackgroundReplicas !== plan.changedBackgroundReplicas
        && plan.revisions.pilot.valuesChanged.startsWith("r2-")
        && plan.revisions.pilot.versionBumped.startsWith("r3-"),
      "the rehearsal plan lost its revision ladder",
    );

    // The portable OCI round trip with the rehearsal tag set.
    const fakeRegistry = {
      host: "registry.self-test.invalid:5000",
      clusterHost: "cluster.self-test.invalid:5000",
    };
    const portable = publishPortableOci({
      workRoot,
      approvedText: plan.profiles.pilot.text,
      registryHost: fakeRegistry.host,
      clusterRegistryHost: fakeRegistry.clusterHost,
      tag: "pilot-r1",
    });
    check(
      portable.objectsMatchPackagedData === true
        && portable.manifestDigest.startsWith("sha256:"),
      "the rehearsal portable round trip failed",
    );
    expectFailure(
      () => publishPortableOci({
        workRoot,
        approvedText: plan.profiles.pilot.text,
        registryHost: fakeRegistry.host,
        clusterRegistryHost: fakeRegistry.clusterHost,
        tag: "pilot-r4",
      }),
      /unsupported OCI tag/,
      "tag ladder refusal",
    );
    registry.state.dropBundleOnPull = true;
    expectFailure(
      () => publishPortableOci({
        workRoot: join(workRoot, "drop"),
        approvedText: plan.profiles.pilot.text,
        registryHost: fakeRegistry.host,
        clusterRegistryHost: fakeRegistry.clusterHost,
        tag: "pilot-r1",
      }),
      /missing bundle\.tar\.gz/,
      "missing pulled bundle refusal",
    );
    registry.state.dropBundleOnPull = false;
    const tamperedRoot = join(workRoot, "tampered");
    mkdirSync(tamperedRoot, { recursive: true });
    writeFileSync(
      join(tamperedRoot, "clusterprofile.yaml"),
      plan.profiles.pilot.text.replace("replicas: 3", "replicas: 1"),
    );
    command("tar", ["-czf", join(tamperedRoot, "bundle.tar.gz"), "clusterprofile.yaml"], {
      cwd: tamperedRoot,
    });
    registry.state.substituteBundle = readFileSync(join(tamperedRoot, "bundle.tar.gz"));
    expectFailure(
      () => publishPortableOci({
        workRoot: join(workRoot, "swap"),
        approvedText: plan.profiles.pilot.text,
        registryHost: fakeRegistry.host,
        clusterRegistryHost: fakeRegistry.clusterHost,
        tag: "pilot-r1",
      }),
      /differs from the packaged content/,
      "tampered pulled payload refusal",
    );
    registry.state.substituteBundle = null;

    // The Argo pin check against the fake download surface.
    expectFailure(
      () => installArgo({
        managementKubeconfig: join(workRoot, "fake.kubeconfig"),
        workRoot,
        lock: plan.lock,
      }),
      /differs from the rehearsal lock/,
      "argo pin refusal",
    );

    // The receipt contract over a synthesized rehearsal.
    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      managementName: "hx-sveltos-rehearse-mgmt-selftest",
      argoInstall: {
        version: plan.lock.spec.argoCd.version,
        manifestUrl: plan.lock.spec.argoCd.manifestUrl,
        manifestSha256: plan.lock.spec.argoCd.manifestSha256,
        installationMethod: "self-test synthesized record",
      },
      sveltosInstall: {
        source: sveltosManifestUrl,
        version: "v1.12.0",
        manifestSha256: plan.sveltosManifestSha,
        crdCount: 1,
        appliedObjectCount: 3,
        omittedOptionalServiceMonitorCount: 0,
        installationMethod: "self-test synthesized record",
      },
      registrations: plan.fleet.spec.workloads.map((workload) => ({
        method: "programmatic SveltosCluster registration",
        namespace: registrationNamespace,
        cluster: `${workload.cluster}-selftest`,
        labels: { environment: workload.environment, "sveltos-agent": "present" },
        credential: {
          type: "short-lived Kubernetes service-account token",
          duration: "6h",
          storedInRepository: false,
          removedWithClusters: true,
        },
        ready: true,
        kubernetesVersion: "v1.35.0",
      })),
      baselineWave: synthesizeWave(plan, "baseline"),
      applicationWave: synthesizeAppWave(plan),
      valuesWave: synthesizeWave(plan, "valuesChange"),
      versionWave: synthesizeWave(plan, "versionBump"),
      driftRepair: {
        cluster: "hx-sveltos-env-pilot-selftest",
        logicalCluster: "hx-sveltos-env-pilot",
        drift: {
          result: "pass",
          object: `apps/v1/Deployment/kyverno/${backgroundDeployment}`,
          reviewedReplicas: plan.changedBackgroundReplicas,
          changedReplicas: 1,
          restoredReplicas: plan.changedBackgroundReplicas,
          pollAttempts: 3,
          pollIntervalSeconds: 3,
        },
      },
      timings: [
        { phase: "temporary OCI registry ready", seconds: 1 },
        { phase: "management cluster ready", seconds: 30 },
        { phase: "Argo CD converged on the management cluster", seconds: 60 },
        { phase: "four workload clusters ready", seconds: 120 },
        { phase: "Sveltos controllers converged", seconds: 60 },
        { phase: "baseline delivered to all four clusters", seconds: 180 },
      ],
      cleanup: {
        managementCluster: "pass",
        workloadClusters: "pass",
        registry: "pass",
        localFiles: "pass",
      },
    });
    verifyReceipt(receipt);
    const summary = renderSummary(receipt);
    check(
      summary.includes("no ConfigHub involved")
        && summary.includes("Total measured"),
      "the rendered rehearsal summary lost its boundary or its timings",
    );

    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /is not pass/],
      ["boundary", (c) => { c.spec.boundary.governanceClaim = true; }, /boundary was weakened/],
      ["claim rewrite", (c) => { c.status.claim = "The fleet change was reviewed, approved, and promoted."; }, /boundary was weakened/],
      ["differences reworded", (c) => { c.spec.boundary.differencesFromGovernedLanes = [...c.spec.boundary.differencesFromGovernedLanes.slice(1), "Nothing differs."]; }, /boundary was weakened/],
      ["governance shape", (c) => { c.spec.notes = { beforeApproval: "blocked" }; }, /must not resemble a governance receipt/],
      ["source hash", (c) => { c.spec.source.profiles.pilot.rawSha256 = "0".repeat(64); }, /pilot source record changed/],
      ["revision drift", (c) => { c.spec.revisions.pilot.versionBumped = "r3-000000000000"; }, /pilot revisions no longer match/],
      ["argo pin", (c) => { c.spec.prerequisites.argoCd.manifestSha256 = "0".repeat(64); }, /prerequisite pins changed/],
      ["registrations", (c) => { c.spec.fleet.registrations[3].labels.environment = "staging"; }, /registration record changed/],
      ["baseline wave", (c) => { c.spec.waves.baseline.observations[0].observation.backgroundReplicas.desired = 9; }, /baseline wave changed/],
      ["app source hash", (c) => { c.spec.source.appProfiles.pilot.rawSha256 = "0".repeat(64); }, /pilot application source record changed/],
      ["app replica math", (c) => { c.spec.waves.application.observations.find((row) => row.environment === "staging").observation.replicas.desired = 9; }, /application wave changed/],
      ["app digest collapse", (c) => {
        c.spec.waves.application.releases.staging.portable.manifestDigest =
          c.spec.waves.application.releases.pilot.portable.manifestDigest;
        c.spec.waves.application.releases.staging.argo.revision =
          c.spec.waves.application.releases.pilot.portable.manifestDigest;
      }, /application wave changed/],
      ["selective values", (c) => {
        const stagingRow = c.spec.waves.valuesChange.observations.find((row) => row.environment === "staging");
        stagingRow.observation.backgroundReplicas.desired = c.spec.source.changedBackgroundReplicas;
      }, /values-change wave changed/],
      ["selective version", (c) => {
        const prodRow = c.spec.waves.versionBump.observations.find((row) => row.environment === "prod");
        prodRow.observation.helmRelease.chart = `kyverno-${c.spec.source.patchedChartVersion}`;
      }, /version-bump wave changed/],
      ["digest ladder", (c) => {
        c.spec.waves.versionBump.portable.manifestDigest =
          c.spec.waves.valuesChange.portable.manifestDigest;
        c.spec.waves.versionBump.argo.revision =
          c.spec.waves.valuesChange.portable.manifestDigest;
      }, /three distinct pilot digests/],
      ["drift", (c) => { c.spec.driftRepair.drift.result = "fail"; }, /drift repair changed/],
      ["timings", (c) => { c.spec.timings = []; }, /timings changed/],
      ["limits", (c) => { c.spec.limits = c.spec.limits.filter((limit) => !limit.includes("not a governance proof")); }, /lost the no-governance boundary/],
      ["cleanup", (c) => { c.spec.cleanup.registry = "fail"; }, /cleanup did not pass/],
      ["cleanup removed", (c) => { delete c.spec.cleanup; }, /cleanup did not pass/],
      ["identity leak", (c) => { c.spec.notes = "run by someone@confighub.com"; }, /contains a user identity/],
      ["credential leak", (c) => { c.spec.notes = "ch_selftesttoken"; }, /contains a credential/],
    ];
    for (const [label, tamper, pattern] of tampers) {
      const clone = structuredClone(receipt);
      tamper(clone);
      expectFailure(() => verifyReceipt(clone), pattern, `receipt ${label}`);
    }

    console.log(
      "sveltos fleet rehearsal self-test passed: the revision ladder, the application pin and replica bindings, the portable round trip with its tag and tamper refusals, the Argo pin refusal, the pinned boundary contract, and the tamper battery",
    );
  } finally {
    commandRunner = realRunner;
    sleeper = realSleeper;
    timeSource = realTime;
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function synthesizeAppWave(plan) {
  const releases = {};
  for (const environment of environments) {
    const digest = `sha256:${sha256(`self-test-app-${environment}`)}`;
    releases[environment] = {
      portable: {
        reference: `oci://registry.self-test.invalid:5000/${portableRepository}:${environment}-app-r1`,
        clusterReference: `oci://cluster.self-test.invalid:5000/${portableRepository}`,
        targetRevision: `${environment}-app-r1`,
        manifestDigest: digest,
        objectCount: 1,
        objectsMatchPackagedData: true,
        anonymousPull: true,
        registryLifetime: "temporary",
      },
      argo: {
        result: "pass",
        sync: "Synced",
        health: "Healthy",
        revision: digest,
        expectedRevision: digest,
        digestMatchesPortableOci: true,
      },
    };
  }
  return {
    releases,
    observations: plan.fleet.spec.workloads.map((workload) => ({
      cluster: `${workload.cluster}-selftest`,
      logicalCluster: workload.cluster,
      environment: workload.environment,
      expectedRevisionId: plan.appRevisions[workload.environment],
      observation: {
        result: "pass",
        clusterSummary: "projectsveltos/self-test-app-summary",
        helmFeatureStatus: "Provisioned",
        helmRelease: {
          name: "podinfo",
          namespace: "podinfo",
          chart: `podinfo-${plan.appChartVersion}`,
          status: "deployed",
        },
        replicas: {
          desired: plan.appReplicas[workload.environment],
          available: plan.appReplicas[workload.environment],
        },
      },
    })),
  };
}

function synthesizeWave(plan, waveName) {
  const digestSeed = `self-test-${waveName}`;
  const portable = {
    reference: `oci://registry.self-test.invalid:5000/${portableRepository}:pilot-r1`,
    clusterReference: `oci://cluster.self-test.invalid:5000/${portableRepository}`,
    targetRevision: waveName === "baseline"
      ? "pilot-r1"
      : waveName === "valuesChange" ? "pilot-r2" : "pilot-r3",
    manifestDigest: `sha256:${sha256(digestSeed)}`,
    objectCount: 1,
    objectsMatchPackagedData: true,
    anonymousPull: true,
    registryLifetime: "temporary",
  };
  const argo = {
    result: "pass",
    sync: "Synced",
    health: "Healthy",
    revision: portable.manifestDigest,
    expectedRevision: portable.manifestDigest,
    digestMatchesPortableOci: true,
  };
  const observations = plan.fleet.spec.workloads.map((workload) => {
    const pilot = workload.environment === "pilot";
    const changedValues = waveName !== "baseline" && pilot;
    const bumped = waveName === "versionBump" && pilot;
    return {
      cluster: `${workload.cluster}-selftest`,
      logicalCluster: workload.cluster,
      environment: workload.environment,
      expectedRevisionId: bumped
        ? plan.revisions.pilot.versionBumped
        : changedValues
          ? plan.revisions.pilot.valuesChanged
          : plan.revisions[workload.environment].baseline,
      observation: {
        result: "pass",
        clusterSummary: "projectsveltos/self-test-summary",
        helmFeatureStatus: "Provisioned",
        helmRelease: {
          name: "kyverno",
          namespace: "kyverno",
          chart: `kyverno-${bumped ? plan.patchedChartVersion : plan.baselineChartVersion}`,
          status: "deployed",
        },
        backgroundReplicas: {
          desired: changedValues
            ? plan.changedBackgroundReplicas
            : plan.baselineBackgroundReplicas,
          available: changedValues
            ? plan.changedBackgroundReplicas
            : plan.baselineBackgroundReplicas,
        },
        deployments: [],
      },
    };
  });
  if (waveName === "baseline") {
    const releases = {};
    for (const environment of environments) {
      releases[environment] = {
        portable: {
          ...portable,
          targetRevision: `${environment}-r1`,
          manifestDigest: `sha256:${sha256(`${digestSeed}-${environment}`)}`,
        },
        argo: {
          ...argo,
          revision: `sha256:${sha256(`${digestSeed}-${environment}`)}`,
          expectedRevision: `sha256:${sha256(`${digestSeed}-${environment}`)}`,
        },
      };
    }
    return { releases, observations };
  }
  return { portable, argo, observations };
}

function createFakeOciRegistry() {
  const tags = new Map();
  const blobs = new Map();
  const state = { dropBundleOnPull: false, substituteBundle: null };
  const ok = (output) => ({ ok: true, status: 0, output, error: "" });
  const refuse = (error) => ({ ok: false, status: 1, output: "", error });
  const positionalsOf = (args) => {
    const valueFlags = new Set(["--artifact-type", "--format", "--output"]);
    const positionals = [];
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index];
      if (valueFlags.has(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("--")) continue;
      positionals.push(token);
    }
    return positionals;
  };
  const outputFlag = (args) => args[args.indexOf("--output") + 1];
  const handle = (args, options = {}) => {
    const positionals = positionalsOf(args);
    if (positionals[0] === "push") {
      const [, reference, layerSpec] = positionals;
      const bytes = readFileSync(join(options.cwd, layerSpec.split(":")[0]));
      const digest = `sha256:${sha256(bytes)}`;
      tags.set(reference, digest);
      blobs.set(digest, Buffer.from(bytes));
      return ok(JSON.stringify({ reference, digest }));
    }
    if (positionals[0] === "manifest" && positionals[1] === "fetch") {
      const reference = positionals[2];
      if (!tags.has(reference)) return refuse(`unknown reference ${reference}`);
      return ok(JSON.stringify({
        digest: tags.get(reference),
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      }));
    }
    if (positionals[0] === "pull") {
      const reference = positionals[1];
      const digest = reference.split("@")[1];
      const bytes = state.substituteBundle ?? blobs.get(digest);
      if (!bytes) return refuse(`unknown digest ${digest}`);
      const output = outputFlag(args);
      mkdirSync(output, { recursive: true });
      if (!state.dropBundleOnPull) {
        writeFileSync(join(output, "bundle.tar.gz"), bytes);
      }
      return ok("");
    }
    return refuse(`the self-test fake registry refuses: oras ${args.join(" ")}`);
  };
  return { state, handle };
}

function expectFailure(fn, pattern, label) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  check(
    error && pattern.test(String(error.message)),
    `${label}: expected ${pattern}, got ${error?.message ?? "success"}`,
  );
}
