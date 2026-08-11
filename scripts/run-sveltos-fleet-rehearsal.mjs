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
const profilesRepository = "sveltos-fleet-rehearsal/profiles";
const liveTag = "live";
const layerFileName = "profiles.yaml";
const profileLayerType = "application/yaml";
const profileLayerShape = "single-layer-raw-yaml";
const remoteFetchInterval = "1m0s";
const caSecretName = "sveltos-oci-ca";
const caSecretType = "addons.projectsveltos.io/cluster-profile";
const bootstrapProfileName = "sveltos-fleet-rehearsal-bootstrap";
const probeRecord = "docs/planning/remote-url-oci-probe.md";
const registrationNamespace = "projectsveltos";
const backgroundDeployment = "kyverno-background-controller";
const rehearsalClaim =
  "Config is published as OCI images, and Sveltos fetches the configuration from the registry and sends it to all managed clusters. That path ran end to end on this machine: a five-cluster kind fleet built, four workload clusters registered by environment label, the management cluster registered as a Sveltos-managed cluster, every wave of fleet profiles published as one raw-YAML OCI artifact to a TLS registry, Sveltos fetched each wave through the bootstrap profile and applied it, Kyverno converged on all four clusters, a demo application converged on all four clusters with per-environment replica counts from the same rails, a values change and a chart version bump each landed on the pilot alone while the other clusters held their state, and injected drift was repaired. No governance is claimed.";
const rehearsalBoundaryNote =
  "This rehearsal exercises the delivery machinery the governed chapters share: the kind fleet, Sveltos registration and fan-out, fleet profiles published as OCI images and fetched by Sveltos itself, selective convergence, a version bump, and drift repair. No review, approval, or promotion is claimed, and no chapter matrix cell is filled by it.";
const rehearsalDifferences = [
  "The registry is a temporary TLS stand-in for ConfigHub's OCI gateway.",
  "Profiles come straight from the reviewed example files; the chapters store, review, and approve them in ConfigHub first.",
  "The bootstrap profile is applied with kubectl as cluster setup.",
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
  check(
    !isLegacyReceipt(receipt),
    "the committed receipt predates the OCI-native design; re-record the rehearsal live before regenerating the summary",
  );
  verifyReceipt(receipt);
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    "the fleet rehearsal has no receipt yet; it is runnable today with no ConfigHub account because it rehearses delivery machinery only",
  );
} else {
  const receipt = readYaml(receiptPath);
  if (isLegacyReceipt(receipt)) {
    console.log(
      "the committed fleet rehearsal receipt predates the OCI-native design and awaits a live re-record; its summary is kept as recorded",
    );
  } else {
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
}

// The first recorded rehearsal delivered the artifacts through a GitOps
// controller; its receipt carries argoCd prerequisite fields. The verify
// lane keeps reading that committed receipt until the OCI-native design is
// re-recorded live, so the old schema is recognized and left alone instead
// of being verified against the new contract or silently rewritten.
function isLegacyReceipt(receipt) {
  return Boolean(receipt?.spec?.prerequisites?.argoCd);
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
    ["openssl", ["version"]],
    ["oras", ["version"]],
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

    const registry = timed("temporary TLS OCI registry ready", () => {
      const started = startRegistry(registryName, workRoot);
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
        sveltos: plan.sveltos,
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

    const managementRegistration = timed(
      "management cluster enrolled for remote fetch",
      () => {
        applyCaSecret({ managementKubeconfig, workRoot, caFile: registry.caFile });
        return registerManagementCluster({
          managementKubeconfig,
          managementName,
          workRoot,
        });
      },
    );

    const kyvernoTexts = (pilotDoc) => [
      pilotDoc ? renderDocuments([pilotDoc]) : plan.profiles.pilot.text,
      plan.profiles.staging.text,
      plan.profiles.prod.text,
    ];
    const appTexts = environments.map(
      (environment) => plan.appProfiles[environment].text,
    );
    const publishWave = (waveName, profileTexts) => {
      const { publish, documents } = publishProfileSet({
        workRoot,
        waveName,
        profileTexts,
        registryHost: registry.host,
        clusterRegistryHost: registry.clusterHost,
        caFile: registry.caFile,
      });
      return { publish, documents };
    };
    const awaitWave = (waveName, publish, documents) => {
      const remoteDeploy = waitForRemoteDeploy({
        managementKubeconfig,
        managementName,
        profileName: bootstrapProfileName,
        expectedDigest: publish.manifestDigest,
        expectedProfiles: documents,
      });
      check(
        remoteDeploy.result === "pass",
        `Sveltos did not fetch and apply the ${waveName} profile set: ${remoteDeploy.reason ?? "unknown"}`,
      );
      return remoteDeploy;
    };

    const baselineWave = timed("baseline delivered to all four clusters", () => {
      // The artifact is published before the bootstrap profile exists, so
      // the very first remote fetch already finds the :live tag.
      const { publish, documents } = publishWave("baseline", kyvernoTexts(null));
      applyBootstrapProfile({
        managementKubeconfig,
        workRoot,
        clusterRegistryHost: registry.clusterHost,
      });
      const remoteDeploy = awaitWave("baseline", publish, documents);
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
      return { publish, remoteDeploy, observations };
    });

    const applicationWave = timed("application delivered to all four clusters", () => {
      const { publish, documents } = publishWave("application", [
        ...kyvernoTexts(null),
        ...appTexts,
      ]);
      const remoteDeploy = awaitWave("application", publish, documents);
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
      return { publish, remoteDeploy, observations };
    });

    const valuesWave = timed("values change delivered to the pilot only", () => {
      const { publish, documents } = publishWave("values-change", [
        ...kyvernoTexts(plan.pilotChangedDoc),
        ...appTexts,
      ]);
      const remoteDeploy = awaitWave("values-change", publish, documents);
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
      return { publish, remoteDeploy, observations };
    });

    const versionWave = timed("version bump delivered to the pilot only", () => {
      const { publish, documents } = publishWave("version-bump", [
        ...kyvernoTexts(plan.pilotPatchedDoc),
        ...appTexts,
      ]);
      const remoteDeploy = awaitWave("version-bump", publish, documents);
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
      return { publish, remoteDeploy, observations };
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
      managementRegistration,
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
  const fleet = readYaml(join(planRolloutRoot, "fleet.yaml"));
  const change = readYaml(join(planRolloutRoot, "change-candidate.yaml"));
  const patchCandidate = readYaml(join(planPatchRoot, "patch-candidate.yaml"));
  const lock = readYaml(planLockPath);
  // The rehearsal pins its own Sveltos release, because it runs the remote
  // fetch path the recorded chapters have not been re-recorded on yet.
  const sveltos = lock.spec?.sveltos ?? {};
  check(
    lock.kind === "SveltosFleetRehearsalLock"
      && /^[0-9a-f]{64}$/.test(String(sveltos.manifestSha256))
      && String(sveltos.manifestUrl ?? "").includes(String(sveltos.version ?? " "))
      && lock.spec?.boundary?.governanceClaim === false,
    "the rehearsal lock lost its Sveltos pin or its boundary",
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
    sveltos,
    baselineChartVersion,
    patchedChartVersion,
    baselineBackgroundReplicas,
    changedBackgroundReplicas: change.spec.after,
  };
}

// The management cluster is itself registered with Sveltos, so one bootstrap
// profile can hand it every wave of fleet profiles from the registry. The
// registration mirrors the workload pattern: a service account on the target,
// a short-lived token, and a kubeconfig Secret the controller reads.
function registerManagementCluster({ managementKubeconfig, managementName, workRoot }) {
  const accessPath = join(workRoot, "management-sveltos-access.yaml");
  writeFileSync(accessPath, `apiVersion: v1
kind: ServiceAccount
metadata:
  name: sveltos-management-self
  namespace: ${registrationNamespace}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sveltos-management-self
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: sveltos-management-self
    namespace: ${registrationNamespace}
`, { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", accessPath]);
  const token = clusterCommand(managementKubeconfig, [
    "-n", registrationNamespace,
    "create", "token", "sveltos-management-self", "--duration=2h",
  ]).output.trim();
  check(token.length > 40, "Kubernetes returned no management registration token");
  const config = JSON.parse(
    clusterCommand(managementKubeconfig, ["config", "view", "--raw", "-o", "json"]).output,
  );
  const authority = config.clusters?.[0]?.cluster?.["certificate-authority-data"];
  check(authority, "the management kubeconfig contains no certificate authority");
  const selfKubeconfig = `apiVersion: v1
kind: Config
clusters:
  - name: management
    cluster:
      server: https://${managementName}-control-plane:6443
      certificate-authority-data: ${authority}
users:
  - name: sveltos-management-self
    user:
      token: ${token}
contexts:
  - name: management
    context:
      cluster: management
      user: sveltos-management-self
current-context: management
`;
  const registrationPath = join(workRoot, "management-sveltos-registration.yaml");
  writeFileSync(registrationPath, `apiVersion: v1
kind: Secret
metadata:
  name: management-sveltos-kubeconfig
  namespace: ${registrationNamespace}
type: Opaque
data:
  kubeconfig: ${Buffer.from(selfKubeconfig).toString("base64")}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata:
  name: management
  namespace: ${registrationNamespace}
  labels:
    role: management
spec: {}
`, { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", registrationPath]);
  const observed = waitForRegistration(managementKubeconfig, "management");
  check(
    observed.ready,
    `Sveltos did not register the management cluster: ${observed.reason}`,
  );
  return {
    method: "programmatic SveltosCluster registration of the management cluster",
    namespace: registrationNamespace,
    cluster: "management",
    labels: { role: "management" },
    credential: {
      type: "short-lived Kubernetes service-account token",
      duration: "2h",
      storedInRepository: false,
      removedWithClusters: true,
    },
    ready: true,
    kubernetesVersion: observed.kubernetesVersion,
  };
}

// The registry certificate is private to this run, so the controller needs
// the CA. Sveltos refuses an Opaque Secret here; the recorded probe names
// the required type, so the manifest builder refuses any other one.
function caSecretManifest(caFile) {
  check(
    caSecretType === "addons.projectsveltos.io/cluster-profile",
    `the CA Secret must carry the Sveltos cluster-profile type; see ${probeRecord}`,
  );
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${caSecretName}
  namespace: ${registrationNamespace}
type: ${caSecretType}
data:
  caFile: ${Buffer.from(caFile).toString("base64")}
`;
}

function applyCaSecret({ managementKubeconfig, workRoot, caFile }) {
  const secretPath = join(workRoot, "sveltos-oci-ca-secret.yaml");
  writeFileSync(secretPath, caSecretManifest(caFile), { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", secretPath]);
}

// One bootstrap profile, applied once as cluster setup. Every later wave
// republishes the same tag, and Sveltos fetches it on its own interval.
function bootstrapProfileManifest(clusterRegistryHost) {
  return `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: ${bootstrapProfileName}
spec:
  clusterSelector:
    matchLabels:
      role: management
  policyRefs:
    - deploymentType: Remote
      remoteURL:
        url: oci://${clusterRegistryHost}/${profilesRepository}:${liveTag}
        interval: ${remoteFetchInterval}
        secretRef:
          name: ${caSecretName}
          namespace: ${registrationNamespace}
`;
}

function applyBootstrapProfile({ managementKubeconfig, workRoot, clusterRegistryHost }) {
  const profilePath = join(workRoot, "bootstrap-clusterprofile.yaml");
  writeFileSync(profilePath, bootstrapProfileManifest(clusterRegistryHost), { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", profilePath]);
}

// The layer contract comes from the recorded probe: a single raw-YAML layer.
// A gzipped layer or a tar layer would be accepted by the registry and then
// misread by the controller, so the runner refuses to publish either.
function assertRawYamlLayer(bytes) {
  check(
    !(bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b),
    `refusing to publish a gzipped layer; the fetcher reads raw YAML, see ${probeRecord}`,
  );
  check(
    !(bytes.length > 262 && bytes.subarray(257, 262).toString("latin1") === "ustar"),
    `refusing to publish a tar layer; this rehearsal publishes raw YAML, see ${probeRecord}`,
  );
  const text = bytes.toString("utf8");
  check(
    /^\s*(apiVersion|kind):/m.test(text),
    "the published layer does not contain Kubernetes documents",
  );
}

function publishProfileSet({
  workRoot,
  waveName,
  profileTexts,
  registryHost,
  clusterRegistryHost,
  caFile,
}) {
  const documents = profileTexts.flatMap((text) => parseDocs(text));
  check(documents.length > 0, `the ${waveName} wave publishes no profiles`);
  const payload = `${documents.map((document) => toYaml(document).trim()).join("\n---\n")}\n`;
  const bytes = Buffer.from(payload, "utf8");
  assertRawYamlLayer(bytes);
  const waveRoot = join(workRoot, `wave-${waveName}`);
  mkdirSync(waveRoot, { recursive: true });
  const layerPath = join(waveRoot, layerFileName);
  writeFileSync(layerPath, payload);
  const caPath = join(workRoot, "registry-ca.pem");
  writeFileSync(caPath, caFile);
  const pushed = command("oras", [
    "push",
    "--ca-file", caPath,
    `${registryHost}/${profilesRepository}:${liveTag}`,
    `${layerFileName}:${profileLayerType}`,
  ], { cwd: waveRoot, timeout: 180_000 });
  const manifestDigest = pushed.output.match(/Digest:\s+(sha256:[0-9a-f]{64})/)?.[1] ?? "";
  check(
    /^sha256:[0-9a-f]{64}$/.test(manifestDigest),
    `oras did not report a manifest digest for the ${waveName} wave`,
  );
  return {
    documents,
    publish: {
      wave: waveName,
      reference: `oci://${clusterRegistryHost}/${profilesRepository}:${liveTag}`,
      manifestDigest,
      layerShape: profileLayerShape,
      layerMediaType: profileLayerType,
      profileCount: documents.length,
      payloadSha256: sha256(payload),
    },
  };
}

// Convergence is proved by the workload observations; this only confirms the
// management cluster actually fetched and applied the wave it was given.
function waitForRemoteDeploy({
  managementKubeconfig,
  managementName,
  profileName,
  expectedDigest,
  expectedProfiles,
  attempts = 240,
}) {
  const expectedNames = new Set(
    (expectedProfiles ?? []).map((document) => document?.metadata?.name).filter(Boolean),
  );
  let last = { status: "missing", reason: "no ClusterSummary observed" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const summaries = clusterTry(managementKubeconfig, [
      "get", "clustersummaries", "-A", "-o", "json",
    ]);
    if (summaries.ok) {
      const items = JSON.parse(summaries.output).items ?? [];
      const summary = items.find((item) =>
        item.metadata?.labels?.["projectsveltos.io/cluster-profile-name"] === profileName);
      const feature = (summary?.status?.featureSummaries ?? [])
        .find((row) => row.featureID === "Resources");
      if (feature) {
        last = {
          status: feature.status ?? "missing",
          reason: feature.failureMessage ?? "none",
        };
        check(
          feature.status !== "Failed",
          `the bootstrap profile failed to apply the fetched profiles: ${feature.failureMessage ?? "unknown"}`,
        );
      }
      const applied = clusterTry(managementKubeconfig, [
        "get", "clusterprofiles", "-o", "json",
      ]);
      if (applied.ok && last.status === "Provisioned") {
        const names = new Set(
          (JSON.parse(applied.output).items ?? [])
            .map((item) => item.metadata?.name)
            .filter(Boolean),
        );
        const missing = [...expectedNames].filter((name) => !names.has(name));
        if (!missing.length) {
          return {
            result: "pass",
            profile: profileName,
            cluster: managementName,
            fetchedDigest: expectedDigest,
            appliedProfiles: [...expectedNames].sort(),
            status: last.status,
          };
        }
        last = { status: last.status, reason: `missing profiles: ${missing.join(", ")}` };
      }
    }
    sleep(5000);
  }
  return {
    result: "fail",
    profile: profileName,
    cluster: managementName,
    fetchedDigest: expectedDigest,
    reason: `status=${last.status}; detail=${last.reason}`,
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

function installSveltos({ managementKubeconfig, workRoot, sveltos }) {
  const manifestPath = join(workRoot, "sveltos-manifest.yaml");
  command("curl", ["-fsSL", sveltos.manifestUrl, "-o", manifestPath], {
    timeout: 180_000,
  });
  const manifestText = readFileSync(manifestPath, "utf8");
  check(
    sha256(manifestText) === sveltos.manifestSha256,
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
    source: sveltos.manifestUrl,
    version: sveltos.version,
    manifestSha256: sveltos.manifestSha256,
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

function startRegistry(name, workRoot) {
  const certRoot = join(workRoot, "registry-certs");
  mkdirSync(certRoot, { recursive: true });
  const certPath = join(certRoot, "tls.crt");
  const keyPath = join(certRoot, "tls.key");
  // The controller pulls over HTTPS only, so the stand-in registry needs a
  // certificate and the management cluster needs its CA.
  command("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", keyPath, "-out", certPath,
    "-subj", "/CN=host.docker.internal",
    "-addext", "subjectAltName=DNS:host.docker.internal,IP:127.0.0.1",
  ], { timeout: 120_000 });
  const started = tryCommand("docker", [
    "run", "-d", "--rm", "--name", name,
    "-v", `${certRoot}:/certs:ro`,
    "-e", "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/tls.crt",
    "-e", "REGISTRY_HTTP_TLS_KEY=/certs/tls.key",
    "-p", "127.0.0.1::5000", "registry:2",
  ], { timeout: 120_000 });
  check(started.ok, `could not start the temporary OCI registry: ${started.error}`);
  const caFile = readFileSync(certPath, "utf8");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = tryCommand("docker", ["port", name, "5000/tcp"]);
    const match = port.output.match(/127\.0\.0\.1:(\d+)/);
    if (match) {
      const host = `127.0.0.1:${match[1]}`;
      if (tryCommand("curl", ["-fsS", "--cacert", certPath, `https://${host}/v2/`]).ok) {
        return { host, clusterHost: `host.docker.internal:${match[1]}`, caFile };
      }
    }
    sleep(1000);
  }
  tryCommand("docker", ["rm", "-f", name], { timeout: 120_000 });
  throw new Error("temporary OCI registry did not publish a host port");
}

function buildReceipt({
  recordedAt,
  plan,
  managementName,
  managementRegistration,
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
        layerContract: probeRecord,
        baselineChartVersion: plan.baselineChartVersion,
        patchedChartVersion: plan.patchedChartVersion,
        baselineBackgroundReplicas: plan.baselineBackgroundReplicas,
        changedBackgroundReplicas: plan.changedBackgroundReplicas,
      },
      revisions: { ...plan.revisions, app: plan.appRevisions },
      prerequisites: { sveltos: sveltosInstall },
      remoteFetch: {
        bootstrapProfile: bootstrapProfileName,
        reference: `oci://<registry>/${profilesRepository}:${liveTag}`,
        tag: liveTag,
        interval: remoteFetchInterval,
        layerShape: profileLayerShape,
        layerMediaType: profileLayerType,
        secretType: caSecretType,
        registryTls: true,
        fetchedBy: "the Sveltos addon controller on the management cluster",
        digests: {
          baseline: baselineWave.publish.manifestDigest,
          application: applicationWave.publish.manifestDigest,
          valuesChange: valuesWave.publish.manifestDigest,
          versionBump: versionWave.publish.manifestDigest,
        },
      },
      fleet: {
        managementCluster: managementName,
        creationCommand: "kind create cluster",
        managementRegistration,
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
        "The profile artifacts used a temporary TLS registry standing in for the ConfigHub OCI gateway; they are not permanent public packages.",
        "The layer contract is the one recorded by the remote fetch probe: a single raw-YAML layer. Gzipped and tar layers are refused before publication.",
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
    !/argo/i.test(serialized),
    "this rehearsal delivers through the Sveltos remote fetch path; a receipt naming a GitOps controller predates that design",
  );
  check(
    receipt.spec?.prerequisites?.sveltos?.manifestSha256
      === plan.sveltos.manifestSha256
      && receipt.spec.prerequisites.sveltos.version === plan.sveltos.version,
    "the rehearsal prerequisite pins changed",
  );
  const remoteFetch = receipt.spec?.remoteFetch ?? {};
  check(
    remoteFetch.bootstrapProfile === bootstrapProfileName
      && remoteFetch.tag === liveTag
      && remoteFetch.interval === remoteFetchInterval
      && remoteFetch.layerShape === profileLayerShape
      && remoteFetch.secretType === caSecretType
      && remoteFetch.registryTls === true,
    "the rehearsal remote fetch contract changed",
  );
  check(
    ["baseline", "application", "valuesChange", "versionBump"].every((wave) =>
      /^sha256:[0-9a-f]{64}$/.test(String(remoteFetch.digests?.[wave] ?? ""))),
    "every wave must record the exact OCI manifest digest Sveltos fetched",
  );
  check(
    receipt.spec?.fleet?.managementRegistration?.labels?.role === "management"
      && receipt.spec.fleet.managementRegistration.ready === true,
    "the management cluster must be registered so it can fetch the profile waves",
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
      && applicationWave.remoteDeploy?.result === "pass"
      && applicationWave.remoteDeploy.fetchedDigest
      === applicationWave.publish?.manifestDigest,
    "fleet rehearsal application wave changed",
  );
  const checkSelective = (wave, expectedPilotChart, expectedPilotReplicas, waveName) => {
    check(
      (wave?.observations ?? []).length === 4
        && wave.remoteDeploy?.result === "pass"
        && wave.remoteDeploy.fetchedDigest === wave.publish?.manifestDigest
        && wave.publish?.layerShape === profileLayerShape
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
      waves.baseline.publish.manifestDigest,
      waves.application.publish.manifestDigest,
      waves.valuesChange.publish.manifestDigest,
      waves.versionBump.publish.manifestDigest,
    ]).size === 4,
    "each rehearsal wave must publish a distinct OCI manifest digest",
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

Boundary: no review, approval, or promotion is claimed. The registry stands
in for the ConfigHub OCI gateway, the profiles come straight from the
reviewed example files instead of an approved ConfigHub revision, and the
chapter matrices are untouched. When this receipt was recorded
(${receipt.spec.recordedAt.slice(0, 10)}), the governed lanes were still
blocked by confighubai/confighub#4975.

The delivery path: each wave of fleet profiles was published as one
raw-YAML OCI image, and Sveltos ${receipt.spec.prerequisites.sveltos.version}
on the management cluster fetched it from the registry and sent it to every
managed cluster.

What ran: a five-cluster kind fleet (one management cluster, four workload
clusters registered by environment label), Kyverno
${receipt.spec.source.baselineChartVersion} converged on all four clusters
from the fetched profile set, a values change landed on the
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
| Distinct wave digests fetched | 4 |
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
    // Inline flag groups are non-capturing, so the $1 this replacement uses was
    // always empty and the key name was dropped along with the value. They are
    // also newer than the Node this runs on in CI, where the expression throws
    // and takes the whole redaction with it. A capturing group with the i flag
    // does what the line always meant.
    .replace(/\b(password|token|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>")
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
    const canned = { manifestBytes: "self-test-sveltos-manifest" };
    commandRunner = (file, args, options = {}) => {
      if (file === "oras") return registry.handle(args, options);
      if (file === "tar") return realRunner(file, args, options);
      if (file === "curl") {
        const outputPath = args[args.indexOf("-o") + 1];
        writeFileSync(outputPath, canned.manifestBytes);
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

    // The publication path, against the contract the live probe recorded.
    const fakeRegistry = {
      host: "registry.self-test.invalid:5000",
      clusterHost: "cluster.self-test.invalid:5000",
      caFile: "-----BEGIN CERTIFICATE-----\nself-test\n-----END CERTIFICATE-----\n",
    };
    const publishArgs = (waveName, profileTexts) => ({
      workRoot: join(workRoot, waveName),
      waveName,
      profileTexts,
      registryHost: fakeRegistry.host,
      clusterRegistryHost: fakeRegistry.clusterHost,
      caFile: fakeRegistry.caFile,
    });
    const baselineTexts = environments.map((environment) => plan.profiles[environment].text);
    const published = publishProfileSet(publishArgs("baseline", baselineTexts));
    check(
      published.publish.layerShape === profileLayerShape
        && published.publish.layerMediaType === profileLayerType
        && published.publish.profileCount === environments.length
        && /^sha256:[0-9a-f]{64}$/.test(published.publish.manifestDigest)
        && published.publish.reference.startsWith("oci://")
        && published.publish.reference.endsWith(`:${liveTag}`),
      "the profile set publication lost its raw-YAML single-layer contract",
    );
    check(
      published.documents.length === environments.length
        && published.documents.every((document) => document.kind === "ClusterProfile"),
      "the published profile set lost its ClusterProfile documents",
    );
    // Every wave republishes the same tag, so a later wave must change the digest.
    const republished = publishProfileSet(publishArgs("values-change", [
      renderDocuments([plan.pilotChangedDoc]),
      plan.profiles.staging.text,
      plan.profiles.prod.text,
    ]));
    check(
      republished.publish.manifestDigest !== published.publish.manifestDigest,
      "republishing a changed profile set must change the fetched digest",
    );

    // The two layer shapes the live probe proved the fetcher cannot read.
    expectFailure(
      () => assertRawYamlLayer(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00])),
      /refusing to publish a gzipped layer/,
      "gzip layer refusal",
    );
    const tarHeader = Buffer.alloc(512);
    tarHeader.write("profiles.yaml");
    tarHeader.write("ustar", 257, "latin1");
    expectFailure(
      () => assertRawYamlLayer(tarHeader),
      /refusing to publish a tar layer/,
      "tar layer refusal",
    );
    expectFailure(
      () => assertRawYamlLayer(Buffer.from("not kubernetes content\n")),
      /does not contain Kubernetes documents/,
      "non-Kubernetes payload refusal",
    );

    // The auth Secret type the controller requires, and the bootstrap profile.
    const caSecret = caSecretManifest(fakeRegistry.caFile);
    check(
      caSecret.includes(`type: ${caSecretType}`)
        && !caSecret.includes("type: Opaque")
        && caSecret.includes("caFile:"),
      "the CA Secret manifest lost the type the Sveltos fetcher requires",
    );
    const bootstrap = bootstrapProfileManifest(fakeRegistry.clusterHost);
    check(
      bootstrap.includes(`url: oci://${fakeRegistry.clusterHost}/${profilesRepository}:${liveTag}`)
        && bootstrap.includes(`interval: ${remoteFetchInterval}`)
        && bootstrap.includes("deploymentType: Remote")
        && bootstrap.includes("role: management"),
      "the bootstrap profile lost its remote fetch contract",
    );

    // The Sveltos pin check against the fake download surface.
    expectFailure(
      () => installSveltos({
        managementKubeconfig: join(workRoot, "fake.kubeconfig"),
        workRoot,
        sveltos: plan.sveltos,
      }),
      /differs from the source lock/,
      "sveltos pin refusal",
    );

    // The receipt contract over a synthesized rehearsal.
    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      managementName: "hx-sveltos-rehearse-mgmt-selftest",
      managementRegistration: {
        method: "programmatic SveltosCluster registration of the management cluster",
        namespace: registrationNamespace,
        cluster: "management",
        labels: { role: "management" },
        credential: {
          type: "short-lived Kubernetes service-account token",
          duration: "2h",
          storedInRepository: false,
          removedWithClusters: true,
        },
        ready: true,
        kubernetesVersion: "v1.35.0",
      },
      sveltosInstall: {
        source: plan.sveltos.manifestUrl,
        version: plan.sveltos.version,
        manifestSha256: plan.sveltos.manifestSha256,
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
        { phase: "temporary TLS OCI registry ready", seconds: 2 },
        { phase: "management cluster ready", seconds: 30 },
        { phase: "four workload clusters ready", seconds: 120 },
        { phase: "Sveltos controllers converged", seconds: 60 },
        { phase: "management cluster enrolled for remote fetch", seconds: 10 },
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
        && summary.includes("Total measured")
        && summary.includes("fetched it from the registry"),
      "the rendered rehearsal summary lost its boundary, its timings, or its delivery path",
    );

    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /is not pass/],
      ["boundary", (c) => { c.spec.boundary.governanceClaim = true; }, /boundary was weakened/],
      ["claim rewrite", (c) => { c.status.claim = "The fleet change was reviewed, approved, and promoted."; }, /boundary was weakened/],
      ["differences reworded", (c) => { c.spec.boundary.differencesFromGovernedLanes = [...c.spec.boundary.differencesFromGovernedLanes.slice(1), "Nothing differs."]; }, /boundary was weakened/],
      ["governance shape", (c) => { c.spec.notes = { beforeApproval: "blocked" }; }, /must not resemble a governance receipt/],
      ["carrier reintroduced", (c) => { c.spec.remoteFetch.fetchedBy = "Argo CD on the management cluster"; }, /predates that design/],
      ["source hash", (c) => { c.spec.source.profiles.pilot.rawSha256 = "0".repeat(64); }, /pilot source record changed/],
      ["revision drift", (c) => { c.spec.revisions.pilot.versionBumped = "r3-000000000000"; }, /pilot revisions no longer match/],
      ["sveltos pin", (c) => { c.spec.prerequisites.sveltos.manifestSha256 = "0".repeat(64); }, /prerequisite pins changed/],
      ["fetch interval", (c) => { c.spec.remoteFetch.interval = "24h0m0s"; }, /remote fetch contract changed/],
      ["secret type", (c) => { c.spec.remoteFetch.secretType = "Opaque"; }, /remote fetch contract changed/],
      ["layer shape", (c) => { c.spec.remoteFetch.layerShape = "gzipped-tar"; }, /remote fetch contract changed/],
      ["plaintext registry", (c) => { c.spec.remoteFetch.registryTls = false; }, /remote fetch contract changed/],
      ["missing wave digest", (c) => { c.spec.remoteFetch.digests.versionBump = "unknown"; }, /exact OCI manifest digest/],
      ["management unregistered", (c) => { c.spec.fleet.managementRegistration.ready = false; }, /management cluster must be registered/],
      ["registrations", (c) => { c.spec.fleet.registrations[3].labels.environment = "staging"; }, /registration record changed/],
      ["baseline wave", (c) => { c.spec.waves.baseline.observations[0].observation.backgroundReplicas.desired = 9; }, /baseline wave changed/],
      ["app source hash", (c) => { c.spec.source.appProfiles.pilot.rawSha256 = "0".repeat(64); }, /pilot application source record changed/],
      ["app replica math", (c) => { c.spec.waves.application.observations.find((row) => row.environment === "staging").observation.replicas.desired = 9; }, /application wave changed/],
      ["app fetch mismatch", (c) => { c.spec.waves.application.remoteDeploy.fetchedDigest = `sha256:${"a".repeat(64)}`; }, /application wave changed/],
      ["selective values", (c) => {
        const stagingRow = c.spec.waves.valuesChange.observations.find((row) => row.environment === "staging");
        stagingRow.observation.backgroundReplicas.desired = c.spec.source.changedBackgroundReplicas;
      }, /values-change wave changed/],
      ["selective version", (c) => {
        const prodRow = c.spec.waves.versionBump.observations.find((row) => row.environment === "prod");
        prodRow.observation.helmRelease.chart = `kyverno-${c.spec.source.patchedChartVersion}`;
      }, /version-bump wave changed/],
      ["digest ladder", (c) => {
        c.spec.waves.versionBump.publish.manifestDigest =
          c.spec.waves.valuesChange.publish.manifestDigest;
        c.spec.waves.versionBump.remoteDeploy.fetchedDigest =
          c.spec.waves.valuesChange.publish.manifestDigest;
      }, /distinct OCI manifest digest/],
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
      "sveltos fleet rehearsal self-test passed: the revision ladder, the raw-YAML publication contract with its gzip and tar refusals, the Secret type and bootstrap profile the fetcher requires, the Sveltos pin refusal, the application pin and replica bindings, the pinned boundary contract, and the tamper battery",
    );
  } finally {
    commandRunner = realRunner;
    sleeper = realSleeper;
    timeSource = realTime;
    rmSync(workRoot, { recursive: true, force: true });
  }
}

// The synthesized waves mirror what the live lane records: one published
// profile set per wave, the management cluster's fetch of it, and the
// per-cluster observations that prove convergence.
function synthesizePublish(waveName, profileCount) {
  const digest = `sha256:${sha256(`self-test-${waveName}`)}`;
  return {
    wave: waveName,
    reference: `oci://cluster.self-test.invalid:5000/${profilesRepository}:${liveTag}`,
    manifestDigest: digest,
    layerShape: profileLayerShape,
    layerMediaType: profileLayerType,
    profileCount,
    payloadSha256: sha256(`self-test-payload-${waveName}`),
  };
}

function synthesizeRemoteDeploy(publish, profileNames) {
  return {
    result: "pass",
    profile: bootstrapProfileName,
    cluster: "hx-sveltos-rehearse-mgmt-selftest",
    fetchedDigest: publish.manifestDigest,
    appliedProfiles: [...profileNames].sort(),
    status: "Provisioned",
  };
}

function synthesizeAppWave(plan) {
  const publish = synthesizePublish("application", environments.length * 2);
  const profileNames = environments.flatMap((environment) => [
    `kyverno-env-${environment}`,
    `podinfo-app-${environment}`,
  ]);
  return {
    publish,
    remoteDeploy: synthesizeRemoteDeploy(publish, profileNames),
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
  const publish = synthesizePublish(waveName, environments.length);
  const profileNames = environments.map((environment) => `kyverno-env-${environment}`);
  const pilotChanged = waveName !== "baseline";
  const pilotChart = waveName === "versionBump"
    ? plan.patchedChartVersion
    : plan.baselineChartVersion;
  const pilotReplicas = pilotChanged
    ? plan.changedBackgroundReplicas
    : plan.baselineBackgroundReplicas;
  const expectedRevision = (environment) => {
    if (environment !== "pilot") return plan.revisions[environment].baseline;
    if (waveName === "valuesChange") return plan.revisions.pilot.valuesChanged;
    if (waveName === "versionBump") return plan.revisions.pilot.versionBumped;
    return plan.revisions.pilot.baseline;
  };
  return {
    publish,
    remoteDeploy: synthesizeRemoteDeploy(publish, profileNames),
    observations: plan.fleet.spec.workloads.map((workload) => {
      const pilot = workload.environment === "pilot";
      return {
        cluster: `${workload.cluster}-selftest`,
        logicalCluster: workload.cluster,
        environment: workload.environment,
        expectedRevisionId: expectedRevision(workload.environment),
        observation: {
          result: "pass",
          clusterSummary: "projectsveltos/self-test-summary",
          helmFeatureStatus: "Provisioned",
          helmRelease: {
            name: "kyverno",
            namespace: "kyverno",
            chart: `kyverno-${pilot ? pilotChart : plan.baselineChartVersion}`,
            status: "deployed",
          },
          backgroundReplicas: {
            desired: pilot ? pilotReplicas : plan.baselineBackgroundReplicas,
            available: pilot ? pilotReplicas : plan.baselineBackgroundReplicas,
          },
        },
      };
    }),
  };
}


function createFakeOciRegistry() {
  const tags = new Map();
  const blobs = new Map();
  const state = { dropBundleOnPull: false, substituteBundle: null };
  const ok = (output) => ({ ok: true, status: 0, output, error: "" });
  const refuse = (error) => ({ ok: false, status: 1, output: "", error });
  const positionalsOf = (args) => {
    const valueFlags = new Set(["--artifact-type", "--ca-file", "--format", "--output"]);
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
      return ok(`Pushed [registry] ${reference}\nDigest: ${digest}`);
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
