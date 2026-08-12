#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
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
const allowedModes = new Set(["--run", "--generate", "--verify", "--self-test", "--probe-gate"]);
if (!allowedModes.has(mode)) {
  console.error(`Usage:
  node scripts/run-sveltos-env-rollout-proof.mjs --run
  node scripts/run-sveltos-env-rollout-proof.mjs --generate
  node scripts/run-sveltos-env-rollout-proof.mjs --verify
  node scripts/run-sveltos-env-rollout-proof.mjs --self-test
  node scripts/run-sveltos-env-rollout-proof.mjs --probe-gate`);
  process.exit(2);
}

const expectedPolicyOrg = "helm-catalog";
const approvalFilterRef = "platform/helm-catalog-prod-gates";
const approvalGate = "platform/require-approval/vet-approvedby";
const catalogOciTargetRef =
  "bitnami-redis-27-0-0-default-pilot-live-20260705/oci-target";
// The approval gate attaches about a second after a Unit is created; the
// report that said otherwise was our own misreading, now withdrawn. The
// runner now governs one variant per cluster, and no live run has been
// recorded on that shape yet.
const pendingReason = "the per-cluster variant rework has not been recorded live yet";
const policyPath = join(
  repoRoot,
  "config-catalog",
  "policies",
  "catalog-standard.yaml",
);
const expectedTriggers = readYaml(policyPath).spec.approvalRequired.checks
  .map((item) => item.trigger)
  .sort();
// The gateway answers on the bare host. The reference the probe recorded as
// working carries no port, so every reference this runner builds carries none.
const configHubOciHost = "oci.hub.confighub.com";
const probeRecord = "docs/planning/remote-url-oci-probe.md";
const exampleRoot = join(repoRoot, "examples", "sveltos", "env-rollout");
const changePath = join(exampleRoot, "change-candidate.yaml");
const variantsPath = join(exampleRoot, "variants.yaml");
const sourceLockPath = join(exampleRoot, "source-lock.yaml");
const receiptPath = join(
  repoRoot,
  "runs",
  "sveltos-env-rollout-proof",
  "receipt.yaml",
);
const summaryPath = join(repoRoot, "data", "sveltos-env-rollout", "summary.md");
const environments = ["pilot", "staging", "prod"];
const policyUnit = "clusterprofile";
const proofLabel = "sveltos-env-rollout";
// Every record in a run carries these labels, and a wave selects its members
// with one query over them. The set scope is the one chapter five already uses.
const setScope = 'cub unit list --space "*"';
const baseRecordLabel = "base";
const variantRecordLabel = "variant";
// An operator who wants to look at the clusters and the Spaces after a run sets
// this. The default still removes everything the run created.
const keepArtifactsVariable = "HELM_EXPT_KEEP_SVELTOS_ARTIFACTS";
// Declared with the other constants because the mode dispatch runs before
// anything further down the file is initialized.
const convergenceWaitAttempts = 150;
const holdingCheckAttempts = 3;
const componentLabel = "sveltos-kyverno-env-rollout";
const ownerLabel = "platform-team";
const publishGateAttempts = 30;
const publishGatePollMs = 2_000;
// Declared here with the other constants because the mode dispatch runs before
// anything further down the file is initialized.
const yamlWriter = `
import json, sys, yaml

def represent_str(dumper, data):
    style = "|" if "\\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

yaml.add_representer(str, represent_str)
documents = json.load(sys.stdin)
with open(sys.argv[1], "w") as handle:
    handle.write(yaml.dump_all(documents, default_flow_style=False, sort_keys=False))
`;
const registrationNamespace = "projectsveltos";
const backgroundDeployment = "kyverno-background-controller";
const managementClusterRecord = "management";
const releaseTag = "latest";
const remoteFetchInterval = "1m0s";
const gatewaySecretName = "confighub-gateway";
const gatewaySecretType = "addons.projectsveltos.io/cluster-profile";
const gatewaySecretKey = "token";
const addonControllerRepository = "docker.io/projectsveltos/addon-controller";

// The self-test swaps these three seams for a fake ConfigHub, a fake
// management cluster, and a fake clock; every live lane uses the real defaults.
let commandRunner = runRealCommand;
let sleeper = realSleep;
let timeSource = () => Date.now();

if (mode === "--run") {
  run();
} else if (mode === "--probe-gate") {
  probeGate();
} else if (mode === "--self-test") {
  selfTest();
} else if (mode === "--generate") {
  check(
    existsSync(receiptPath),
    `${relativeRepo(receiptPath)} is missing; no live run has been recorded, because ${pendingReason}`,
  );
  const receipt = readYaml(receiptPath);
  check(
    !supersededReceipt(receipt),
    `${relativeRepo(receiptPath)} predates the per-cluster variant design; record the run live before regenerating the summary`,
  );
  verifyReceipt(receipt);
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos environment rollout has no live receipt yet; no live run has been recorded yet, because ${pendingReason}`,
  );
} else {
  const receipt = readYaml(receiptPath);
  if (supersededReceipt(receipt)) {
    console.log(
      "the committed Sveltos environment rollout receipt records three environment records and predates the per-cluster variant design; it awaits a live re-record, and its summary is kept as recorded",
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
    console.log("verified the Sveltos environment rollout proof");
  }
}

// The recorded run governed one record per environment, so its receipt keys
// everything by environment and carries no variant list. The verify lane keeps
// reading it until the per-cluster design is recorded live, so the old shape is
// recognized and left alone instead of being checked against a contract it
// predates or silently rewritten.
function supersededReceipt(receipt) {
  return !Array.isArray(receipt?.spec?.variants);
}

function run() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_SVELTOS_ENV_ROLLOUT === "1",
    "set HELM_EXPT_ALLOW_LIVE_SVELTOS_ENV_ROLLOUT=1 to confirm this live proof",
  );
  check(policyContext, "set CUB_CONTEXT to an authenticated helm-catalog context");
  for (const [tool, args] of [
    ["cub", ["version"]],
    ["curl", ["--version"]],
    ["docker", ["version"]],
    ["helm", ["version"]],
    ["kind", ["version"]],
    ["kubectl", ["version", "--client"]],
  ]) {
    check(tryCommand(tool, args).ok, `${tool} is required for this proof`);
  }

  const policyContextInfo = cubJson(policyContext, [
    "context", "get", policyContext, "-o", "json",
  ]);
  check(
    policyContextInfo.metadata?.organizationName === expectedPolicyOrg,
    `refusing to create policy evidence outside ${expectedPolicyOrg}`,
  );

  const plan = loadRolloutPlan();
  const sveltos = loadSveltosPin();
  const addonControllerImage = resolveAddonControllerImage(sveltos);

  const topology = readApprovalTopology(policyContext);
  const catalogTarget = cubJson(policyContext, [
    "target", "get", "--space", ...catalogOciTargetRef.split("/"), "-o", "json",
  ]).Target;
  check(
    catalogTarget?.ProviderType === "OCI",
    `${catalogOciTargetRef} is not an OCI target`,
  );

  const recordedAt = new Date().toISOString();
  const runId = safeRunId(process.env.HELM_EXPT_PROOF_RUN_ID || recordedAt);
  const keepArtifacts = keepArtifactsRequested();
  const managementName = `hx-sveltos-envmgmt-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-rollout-"));
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const fleetClusters = plan.clusters.map((row) => ({
    cluster: `${row.cluster}-${runId}`,
    logicalCluster: row.cluster,
    environment: row.environment,
    wave: row.wave,
    kubeconfig: join(workRoot, `${row.cluster}.kubeconfig`),
  }));
  const baseSpace = spaceName(`hx-sveltos-env-base-${runId}`);
  // One Space per cluster, the management cluster included, so the record that
  // says what a cluster runs is addressable on its own.
  const spaceFor = Object.fromEntries([
    ...plan.clusters.map((row) => [row.cluster, spaceName(`${row.cluster}-${runId}`)]),
    [plan.management.cluster, spaceName(`${plan.management.cluster}-${runId}`)],
  ]);
  const policySpaces = [baseSpace, ...Object.values(spaceFor)];
  const cleanup = {
    mode: keepArtifacts ? "kept" : "removed",
    keptDeliberately: keepArtifacts,
    results: {
      probeSpace: "pending",
      managementCluster: "not-created",
      workloadClusters: "not-created",
      policySpaces: "not-created",
      localFiles: "pending",
    },
    kept: [],
  };
  let managementStarted = false;
  const workloadsStarted = new Set();
  const policySpacesCreated = new Set();
  let receipt;

  // The approval gate is probed before any cluster work, so a Space whose
  // gate never attaches costs seconds, not the seven-minute fleet build the
  // two-wave runner paid per attempt.
  assertApprovalGateObservable(policyContext, runId, topology, catalogTarget);
  cleanup.results.probeSpace = "pass";
  phase("gate preflight passed; the approval gate is observable");

  try {
    for (const space of policySpaces) {
      check(!spacePresent(policyContext, space), `refusing to reuse ${space}`);
    }
    for (const row of [managementName, ...fleetClusters.map((item) => item.cluster)]) {
      check(!clusterPresent(row), `refusing to reuse the kind cluster ${row}`);
    }

    createCluster(managementName, managementKubeconfig);
    managementStarted = true;
    cleanup.results.managementCluster = "pending";
    phase("management cluster ready");

    for (const row of fleetClusters) {
      createCluster(row.cluster, row.kubeconfig);
      workloadsStarted.add(row.cluster);
    }
    cleanup.results.workloadClusters = "pending";
    phase("four workload clusters ready");

    const sveltosInstall = installSveltos({
      managementKubeconfig,
      workRoot,
      sveltos,
      addonControllerImage,
    });
    phase(`Sveltos controllers converged on ${sveltosInstall.addonControllerImage}`);

    const registrations = fleetClusters.map((row) =>
      registerWorkload({
        managementKubeconfig,
        workloadName: row.cluster,
        workloadKubeconfig: row.kubeconfig,
        workRoot,
        logicalCluster: row.logicalCluster,
        environment: row.environment,
      }));
    phase("four workload clusters registered, each with its own addressing label");

    const gatewayCredential = applyGatewayTokenSecret({
      policyContext,
      managementKubeconfig,
      workRoot,
    });
    const managementRegistration = registerManagementCluster({
      managementKubeconfig,
      managementName,
      workRoot,
    });
    phase("the management cluster can fetch its own profiles from the gateway");

    cleanup.results.policySpaces = "pending";
    const baseRecord = establishBase({
      policyContext,
      space: baseSpace,
      plan,
      topology,
      catalogTarget,
      runId,
      policySpacesCreated,
    });
    phase("the base record holds the content every cluster shares");

    const variantRecords = {};
    for (const row of plan.clusters) {
      variantRecords[row.cluster] = establishVariant({
        policyContext,
        space: spaceFor[row.cluster],
        baseSpace,
        cluster: row,
        topology,
        catalogTarget,
        runId,
        workRoot,
        policySpacesCreated,
      });
    }
    phase("four per-cluster variants cloned from the base, each carrying its own departures");

    const managementVariant = establishManagement({
      policyContext,
      space: spaceFor[plan.management.cluster],
      plan,
      topology,
      catalogTarget,
      runId,
      workRoot,
      policySpacesCreated,
      workloadSpaces: plan.clusters.map((row) => ({
        cluster: row.cluster,
        space: spaceFor[row.cluster],
      })),
    });
    phase("the management record holds one bootstrap profile per workload Space");

    const baselineMembers = [
      ...plan.clusters.map((row) => ({
        cluster: row.cluster,
        space: spaceFor[row.cluster],
        expectedDocs: [row.baselineDoc],
        revisionId: row.revisions.baseline,
      })),
      {
        cluster: plan.management.cluster,
        space: spaceFor[plan.management.cluster],
        expectedDocs: managementVariant.documents,
        revisionId: managementVariant.revisionId,
        publishesRelease: false,
      },
    ];
    const baselineSet = reviewSet({
      policyContext,
      stageName: "baseline",
      query: baselineQuery(plan, runId),
      members: baselineMembers,
    });
    for (const row of plan.clusters) {
      variantRecords[row.cluster].baseline = baselineSet.records[row.cluster];
    }
    managementVariant.baseline = baselineSet.records[plan.management.cluster];
    phase("one set operation approved every record this run created, one approval each");

    const bootstrap = applyBootstrapProfiles({
      managementKubeconfig,
      workRoot,
      profiles: managementVariant.bootstrapProfiles,
    });
    phase("the management record was applied out of band, which is what opens the gateway path");

    for (const row of plan.clusters) {
      const record = variantRecords[row.cluster];
      const delivery = waitForRemoteDeploy({
        managementKubeconfig,
        managementName,
        cluster: row.cluster,
        profileName: row.profileName,
        expectedDoc: row.baselineDoc,
        release: record.baseline.release,
      });
      check(
        delivery.result === "pass",
        `Sveltos did not fetch the ${row.cluster} baseline from the gateway: ${delivery.reason ?? "unknown"}`,
      );
      assertLiveProfileMatches({
        managementKubeconfig,
        profileName: row.profileName,
        expectedDoc: row.baselineDoc,
      });
      record.baseline.delivery = delivery;
    }
    phase("every per-cluster baseline arrived from the gateway");

    const checkpoints = [
      recordCheckpoint({
        id: "baseline",
        completedWaves: 0,
        plan,
        fleetClusters,
        managementKubeconfig,
      }),
    ];
    phase("baseline checkpoint observed on all four clusters");

    const baseChange = changeBaseRecord({
      policyContext,
      space: baseSpace,
      plan,
      workRoot,
    });
    phase("the reviewed change landed once on the base record");

    const waveRecords = [];
    for (const wave of plan.waves) {
      waveRecords.push(promoteWave({
        policyContext,
        managementKubeconfig,
        managementName,
        wave,
        plan,
        spaceFor,
        runId,
        variantRecords,
      }));
      checkpoints.push(recordCheckpoint({
        id: `after-wave-${wave.wave}`,
        completedWaves: wave.wave,
        plan,
        fleetClusters,
        managementKubeconfig,
      }));
      phase(`wave ${wave.wave} (${wave.environment}) promoted as one set operation over ${wave.clusters.length} variant(s) and observed`);
    }

    const convergenceAudit = auditConvergence({
      plan,
      fleetClusters,
      managementKubeconfig,
    });
    check(
      convergenceAudit.result === "pass",
      "the final convergence audit did not pass",
    );
    phase("final convergence audit passed on all four clusters");

    receipt = buildReceipt({
      recordedAt,
      plan,
      topology,
      catalogTarget,
      managementName,
      managementRegistration,
      sveltosInstall,
      gatewayCredential,
      registrations,
      baseRecord,
      baseChange,
      baselineSet,
      variantRecords,
      managementVariant,
      bootstrap,
      waveRecords,
      checkpoints,
      convergenceAudit,
      cleanup,
    });
  } finally {
    if (keepArtifacts) {
      phase("keeping the clusters and the Spaces, because the keep-alive flag is set");
      cleanup.results.managementCluster = "kept";
      cleanup.results.workloadClusters = "kept";
      cleanup.results.policySpaces = "kept";
      cleanup.kept = [
        ...[managementName, ...fleetClusters.map((row) => row.cluster)]
          .filter((name) => clusterPresent(name))
          .map((name) => ({
            kind: "kind cluster",
            name,
            removeWith: `kind delete cluster --name ${name}`,
          })),
        ...policySpaces
          .filter((space) =>
            policySpacesCreated.has(space) || spacePresent(policyContext, space))
          .map((space) => ({
            kind: "ConfigHub Space",
            name: space,
            removeWith: `cub space delete ${space} --recursive-force`,
          })),
      ];
    } else {
      phase("cleaning up temporary resources");
      if (managementStarted || clusterPresent(managementName)) {
        tryCommand("kind", ["delete", "cluster", "--name", managementName], {
          timeout: 180_000,
        });
      }
      cleanup.results.managementCluster = clusterPresent(managementName)
        ? "fail"
        : "pass";

      for (const row of fleetClusters) {
        if (workloadsStarted.has(row.cluster) || clusterPresent(row.cluster)) {
          tryCommand("kind", ["delete", "cluster", "--name", row.cluster], {
            timeout: 180_000,
          });
        }
      }
      cleanup.results.workloadClusters = fleetClusters.some((row) =>
        clusterPresent(row.cluster))
        ? "fail"
        : "pass";

      for (const space of policySpaces) {
        if (policySpacesCreated.has(space) || spacePresent(policyContext, space)) {
          cubTry(policyContext, [
            "space", "delete", space, "--recursive-force", "--quiet",
          ], { timeout: 240_000 });
        }
      }
      cleanup.results.policySpaces = policySpaces.some((space) =>
        spacePresent(policyContext, space))
        ? "fail"
        : "pass";
    }

    // The scratch tree holds kubeconfigs and a token, so it goes either way.
    rmSync(workRoot, { recursive: true, force: true });
    cleanup.results.localFiles = existsSync(workRoot) ? "fail" : "pass";
  }

  check(receipt, "the Sveltos environment rollout proof did not complete");
  check(
    cleanupSucceeded(cleanup),
    `Sveltos environment rollout cleanup failed: ${JSON.stringify(cleanup)}`,
  );
  writeYaml(receiptPath, receipt);
  write(summaryPath, renderSummary(receipt));
  verifyReceipt(receipt);
  if (keepArtifacts) reportKeptArtifacts(cleanup);
  console.log(
    `wrote ${relativeRepo(receiptPath)} and ${relativeRepo(summaryPath)}`,
  );
}

function keepArtifactsRequested() {
  return process.env[keepArtifactsVariable]?.trim() === "1";
}

// Cleanup passes when everything was removed, and it also passes when the
// operator asked to keep the clusters and the Spaces. What it never accepts is
// a removal that was attempted and failed.
function cleanupSucceeded(cleanup) {
  const results = Object.values(cleanup?.results ?? {});
  if (results.length === 0) return false;
  if (cleanup.mode === "kept") {
    return cleanup.keptDeliberately === true
      && results.every((value) => value === "pass" || value === "kept")
      && (cleanup.kept ?? []).length > 0;
  }
  return cleanup.mode === "removed"
    && cleanup.keptDeliberately === false
    && results.every((value) => value === "pass");
}

function reportKeptArtifacts(cleanup) {
  console.log(
    `[sveltos-env-rollout] ${keepArtifactsVariable}=1 was set, so these were left behind:`,
  );
  for (const row of cleanup.kept) {
    console.log(`[sveltos-env-rollout]   ${row.kind} ${row.name}`);
  }
  console.log("[sveltos-env-rollout] remove them with:");
  for (const row of cleanup.kept) {
    console.log(`[sveltos-env-rollout]   ${row.removeWith}`);
  }
}

// The two-minute check that this organization still wires approval gates:
// wire one throwaway Space, create one probe Unit, and watch for the
// approval gate. One passing probe unblocks every drafted fleet lane.
function probeGate() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  check(policyContext, "set CUB_CONTEXT to an authenticated helm-catalog context");
  check(tryCommand("cub", ["version"]).ok, "cub is required for this probe");
  const policyContextInfo = cubJson(policyContext, [
    "context", "get", policyContext, "-o", "json",
  ]);
  check(
    policyContextInfo.metadata?.organizationName === expectedPolicyOrg,
    `refusing to create probe evidence outside ${expectedPolicyOrg}`,
  );
  const topology = readApprovalTopology(policyContext);
  const catalogTarget = cubJson(policyContext, [
    "target", "get", "--space", ...catalogOciTargetRef.split("/"), "-o", "json",
  ]).Target;
  check(
    catalogTarget?.ProviderType === "OCI",
    `${catalogOciTargetRef} is not an OCI target`,
  );
  const runId = safeRunId(new Date().toISOString());
  assertApprovalGateObservable(policyContext, runId, topology, catalogTarget);
  console.log(
    "the approval gate attaches as expected in this organization; run the fleet lanes serially",
  );
}

// One reviewed plan drives the runner, the matrix generator, and the
// self-test: the revision identities computed here must match
// scripts/generate-sveltos-env-rollout.mjs exactly. The plan reads one base
// profile and one variants record, and derives every per-cluster document from
// them, so a departure is a declared departure rather than a hand-written copy.
function loadRolloutPlan(root = repoRoot) {
  const planRoot = join(root, "examples", "sveltos", "env-rollout");
  const fleet = readYaml(join(planRoot, "fleet.yaml"));
  const change = readYaml(join(planRoot, "change-candidate.yaml"));
  const variants = readYaml(join(planRoot, "variants.yaml"));
  const workloads = fleet.spec?.workloads ?? [];
  check(
    fleet.kind === "SveltosEnvRolloutFleet"
      && workloads.length === 4
      && new Set(workloads.map((row) => row.cluster)).size === 4
      && Boolean(fleet.spec?.management?.cluster),
    "the fleet record lost its management cluster or its four uniquely named workload clusters",
  );
  for (const environment of environments) {
    const expected = environment === "prod" ? 2 : 1;
    check(
      workloads.filter((row) => row.environment === environment).length
        === expected,
      `the fleet must place ${expected} cluster(s) in ${environment}`,
    );
  }
  const declaredWaves = change.spec?.waves ?? [];
  check(
    change.kind === "SveltosEnvRolloutChange"
      && change.spec.before !== change.spec.after
      && change.spec.editedRecord === "base"
      && declaredWaves.map((row) => row.environment).join(",")
      === environments.join(",")
      && declaredWaves.map((row) => row.wave).join(",") === "1,2,3",
    "the change waves must cover pilot, staging, and prod in order, and the change must edit the base record",
  );
  const selection = change.spec?.selection ?? {};
  check(
    selection.scope === setScope
      && String(selection.whereTemplate ?? "").includes("{run}")
      && String(selection.whereTemplate).includes("{environment}")
      && String(selection.baselineWhereTemplate ?? "").includes("{run}"),
    "the change candidate lost the reviewed set query each wave selects with",
  );

  const basePath = join(planRoot, variants.spec?.base?.profile ?? "");
  const baseText = readFileSync(basePath, "utf8");
  const baseDocs = parseDocs(baseText);
  check(
    variants.kind === "SveltosEnvRolloutVariants"
      && variants.spec?.base?.unit === policyUnit
      && variants.spec.base.reachesCluster === false
      && baseDocs.length === 1,
    "the variants record lost its base declaration",
  );
  const baseDoc = baseDocs[0];
  const baseSelector = baseDoc.spec?.clusterSelector?.matchLabels ?? {};
  check(
    baseDoc.kind === "ClusterProfile"
      && typeof baseDoc.metadata?.name === "string"
      && Object.keys(baseSelector).join(",") === "cluster"
      && !workloads.some((row) => row.cluster === baseSelector.cluster),
    "the base profile must carry a cluster selector that addresses no registered cluster",
  );
  check(
    baseDoc.spec?.syncMode === "ContinuousWithDriftDetection"
      && baseDoc.spec?.helmCharts?.length === 1
      && baseDoc.spec.helmCharts[0].chartName === change.spec.chart
      && String(baseDoc.spec.helmCharts[0].chartVersion)
      === String(change.spec.chartVersion),
    "the base profile chart pin or drift mode changed",
  );
  const baseValues = parseDocs(baseDoc.spec.helmCharts[0].values)[0];
  check(
    readPath(baseValues, change.spec.valuesPath) === change.spec.before,
    "the change candidate before-value does not match the base values",
  );
  // The chart values ride in one string field of the profile, so a change to
  // any value rewrites that whole field. That is the field a departure must
  // stay clear of.
  const changeField = "spec.helmCharts.0.values";

  const declaredVariants = variants.spec?.workloads ?? [];
  check(
    declaredVariants.length === workloads.length
      && declaredVariants.every((row, index) =>
        row.cluster === workloads[index].cluster
        && row.environment === workloads[index].environment),
    "the variants record must declare one variant per fleet cluster, in fleet order",
  );
  const management = variants.spec?.management ?? {};
  check(
    management.cluster === fleet.spec.management.cluster
      && management.appliedOutOfBandWith === "kubectl"
      && String(management.reason ?? "").length > 0,
    "the variants record lost the management bootstrap boundary",
  );
  const declaredSpaces = [
    variants.spec.base.space,
    ...declaredVariants.map((row) => row.space),
    management.space,
  ];
  check(
    declaredSpaces.every((space) =>
      typeof space === "string" && space === space.toLowerCase())
      && new Set(declaredSpaces).size === declaredSpaces.length,
    "every declared Space must be lowercase and belong to one record",
  );

  const waveOf = Object.fromEntries(
    declaredWaves.map((row) => [row.environment, row.wave]),
  );
  const clusters = declaredVariants.map((row) => {
    const departures = row.departures ?? {};
    const departurePaths = Object.keys(departures).sort();
    const addressing = ["metadata.name", "spec.clusterSelector.matchLabels.cluster"];
    check(
      departures["spec.clusterSelector.matchLabels.cluster"] === row.cluster
        && typeof departures["metadata.name"] === "string"
        && departurePaths.some((path) => !addressing.includes(path)),
      `${row.cluster} must depart on its own selector, its own name, and at least one field beyond addressing`,
    );
    // A change to the base and a departure that write the same field, or
    // different keys of the same map of scalars, merge with the departure
    // winning and nothing said about it. The plan refuses that shape rather
    // than letting a promotion report success it did not achieve.
    for (const path of departurePaths) {
      check(
        !fieldsCollide(path, changeField, baseDoc),
        `${row.cluster} departs on ${path}, which the reviewed change also writes; a departure wins that merge silently, so this promotion is refused`,
      );
    }
    const baselineDoc = applyDepartures(baseDoc, departures);
    const changedDoc = withChangedValue(
      baselineDoc,
      change.spec.valuesPath,
      change.spec.after,
    );
    const revisions = {
      baseline: `r1-${sha256(stableJson(baselineDoc)).slice(0, 12)}`,
      changed: `r2-${sha256(stableJson(changedDoc)).slice(0, 12)}`,
    };
    check(
      revisions.baseline !== revisions.changed,
      "the reviewed change produced no new revision identity",
    );
    return {
      cluster: row.cluster,
      environment: row.environment,
      wave: waveOf[row.environment],
      space: row.space,
      profileName: departures["metadata.name"],
      departures,
      departurePaths,
      inheritedFields: [changeField],
      baselineDoc,
      changedDoc,
      revisions,
      expectedReplicas: {
        baseline: expectedDeploymentReplicas(valuesOf(baselineDoc)),
        changed: expectedDeploymentReplicas(valuesOf(changedDoc)),
      },
    };
  });
  check(
    new Set(clusters.map((row) => row.profileName)).size === clusters.length,
    "every per-cluster profile must carry its own name",
  );

  const waves = declaredWaves.map((wave) => {
    const members = clusters
      .filter((row) => row.environment === wave.environment)
      .map((row) => row.cluster);
    check(
      sameSet(wave.clusters ?? [], members),
      `wave ${wave.wave} must name exactly the ${wave.environment} clusters`,
    );
    return { wave: wave.wave, environment: wave.environment, clusters: members };
  });
  check(
    waves.flatMap((wave) => wave.clusters).length === clusters.length,
    "the waves must cover every cluster exactly once",
  );

  const changedBaseDoc = withChangedValue(
    baseDoc,
    change.spec.valuesPath,
    change.spec.after,
  );
  return {
    fleet,
    change,
    variants,
    selection,
    changeField,
    waves,
    clusters,
    management: {
      cluster: management.cluster,
      space: management.space,
      holds: management.holds,
      appliedOutOfBandWith: management.appliedOutOfBandWith,
      reason: management.reason,
    },
    base: {
      doc: baseDoc,
      text: baseText,
      path: basePath,
      repoPath: relativeRepo(basePath),
      space: variants.spec.base.space,
      unit: policyUnit,
      changedDoc: changedBaseDoc,
      revisions: {
        baseline: `b1-${sha256(stableJson(baseDoc)).slice(0, 12)}`,
        changed: `b2-${sha256(stableJson(changedBaseDoc)).slice(0, 12)}`,
      },
    },
  };
}

// A variant is the base with its declared departures written over it. Every
// departure names a field of the profile, which is the granularity ConfigHub
// merges at when a later base change flows down.
function applyDepartures(baseDoc, departures) {
  const doc = structuredClone(baseDoc);
  for (const [path, value] of Object.entries(departures)) {
    writePath(doc, path, value, true);
  }
  return doc;
}

function withChangedValue(doc, valuesPath, next) {
  const changed = structuredClone(doc);
  const values = valuesOf(doc);
  writePath(values, valuesPath, next);
  changed.spec.helmCharts[0].values = `${toYaml(values)}\n`;
  return changed;
}

function valuesOf(doc) {
  return parseDocs(doc.spec.helmCharts[0].values)[0];
}

// Two writes collide when they name the same field or when one contains the
// other, and also when they write different keys of the same map of scalars.
// The second case is the measured one: a recorded ConfigHub run showed a
// variant whose departure sat on a map the base also wrote to receive none of
// the base's changes while its upstream pointer advanced, and nothing said so.
function fieldsCollide(left, right, doc) {
  if (left === right) return true;
  if (left.startsWith(`${right}.`) || right.startsWith(`${left}.`)) return true;
  const leftParent = parentPath(left);
  const rightParent = parentPath(right);
  if (!leftParent || leftParent !== rightParent) return false;
  return isScalarMap(readPath(doc, leftParent));
}

function parentPath(path) {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(0, index);
}

function isScalarMap(node) {
  return Boolean(node)
    && typeof node === "object"
    && !Array.isArray(node)
    && Object.values(node).every(
      (value) => value === null || typeof value !== "object",
    );
}

// The chart names one deployment per controller, so the reviewed replica counts
// are checkable on the cluster without reading the chart.
function expectedDeploymentReplicas(values) {
  const result = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value && typeof value === "object" && Number.isInteger(value.replicas)) {
      result[deploymentNameFor(key)] = value.replicas;
    }
  }
  return result;
}

function deploymentNameFor(valuesKey) {
  return `kyverno-${valuesKey.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

// Each wave selects its members with the reviewed query rather than naming
// Spaces one at a time, so promotion is one operation over a named set.
function waveQuery(plan, runId, environment) {
  return String(plan.selection.whereTemplate)
    .replaceAll("{run}", runId)
    .replaceAll("{environment}", environment);
}

function baselineQuery(plan, runId) {
  return String(plan.selection.baselineWhereTemplate).replaceAll("{run}", runId);
}

// Chapter three pins its own Sveltos release, because it runs the gateway
// fetch path the earlier chapters were recorded without.
function loadSveltosPin(path = sourceLockPath) {
  const lock = readYaml(path);
  const sveltos = lock.spec?.sveltos ?? {};
  check(
    lock.kind === "SveltosEnvRolloutLock"
      && /^[0-9a-f]{64}$/.test(String(sveltos.manifestSha256))
      && String(sveltos.manifestUrl ?? "").includes(String(sveltos.version ?? " ")),
    "the environment rollout lock lost its Sveltos pin",
  );
  return {
    version: String(sveltos.version),
    manifestUrl: String(sveltos.manifestUrl),
    manifestSha256: String(sveltos.manifestSha256),
  };
}

// The gateway serves each release as a gzipped tar layer, so this run needs an
// addon controller that gunzips. The pinned image is the default, and an
// operator holding the build with the gzip fix names it in the environment.
function resolveAddonControllerImage(sveltos) {
  const pinnedImage = `${addonControllerRepository}:${sveltos.version}`;
  const override = process.env.SVELTOS_ADDON_CONTROLLER_IMAGE?.trim() ?? "";
  if (!override) return pinnedImage;
  check(
    /^\S+$/.test(override)
      && /[:@]/.test(override.slice(override.lastIndexOf("/") + 1)),
    "SVELTOS_ADDON_CONTROLLER_IMAGE must name one image with a tag or a digest",
  );
  return override;
}

// OCI repository names are lowercase, so a Space that will be served through
// the gateway has to be lowercase to be addressable at all.
function spaceName(candidate) {
  return String(candidate).toLowerCase();
}

function assertPublishableSpaceName(space) {
  check(
    space === space.toLowerCase(),
    `refusing to create ${space}: OCI repository names are lowercase, so a Space carrying uppercase cannot be addressed through the gateway; see ${probeRecord}`,
  );
}

function gatewayReference(space) {
  assertPublishableSpaceName(space);
  return `oci://${configHubOciHost}/space/${space}:${releaseTag}`;
}

function assertApprovalGateObservable(context, runId, topology, catalogTarget) {
  const probeSpace = spaceName(`hx-sveltos-env-probe-${runId}`);
  check(
    !spacePresent(context, probeSpace),
    `refusing to reuse ${probeSpace}`,
  );
  createPolicySpace(context, probeSpace);
  try {
    assertPolicySpace(context, probeSpace, topology.triggerIds, catalogTarget.TargetID);
    cub(context, [
      "unit", "create", "--space", probeSpace, policyUnit,
      join(exampleRoot, "clusterprofile-base.yaml"),
      "--change-desc", "Probe the approval gate before building the fleet",
      "--quiet",
    ]);
    const deadline = now() + 120_000;
    let seen = approvalObservation(context, probeSpace, policyUnit);
    const gatePresent = () =>
      seen.gateKeys.some(
        (key) => key === approvalGate || key.includes("require-approval"),
      );
    while (!gatePresent() && now() < deadline) {
      sleep(5_000);
      seen = approvalObservation(context, probeSpace, policyUnit);
    }
    check(
      gatePresent(),
      `the approval gate never appeared on the probe Unit ${probeSpace}/${policyUnit}; check the Space wiring before building the fleet`,
    );
  } finally {
    // The probe Space holds only the probe Unit, so a direct recursive delete
    // is safe under the ordering constraint in confighubai/confighub#4980.
    cubTry(context, [
      "space", "delete", probeSpace, "--recursive-force", "--quiet",
    ], { timeout: 240_000 });
  }
}

// The base record holds what every cluster shares. It is given no target and
// its Space is never published, so nothing reaches a cluster from it: every
// revision that reaches a cluster is approved on the variant that owns it.
function establishBase({
  policyContext,
  space,
  plan,
  topology,
  catalogTarget,
  runId,
  policySpacesCreated,
}) {
  createPolicySpace(policyContext, space);
  policySpacesCreated.add(space);
  assertPolicySpace(
    policyContext,
    space,
    topology.triggerIds,
    catalogTarget.TargetID,
  );
  cub(policyContext, [
    "unit", "create", "--space", space, policyUnit, plan.base.path,
    "--label", "App=sveltos-kyverno-env-rollout",
    "--label", `Proof=${proofLabel}`,
    "--label", `Run=${runId}`,
    "--label", `Record=${baseRecordLabel}`,
    "--change-desc", "Store the reviewed base ClusterProfile every cluster shares",
    "--quiet",
  ]);
  const stored = cubJson(policyContext, [
    "unit", "get", "--space", space, policyUnit, "-o", "json",
  ]).Unit;
  check(
    canonicalDocs(parseDocs(storedData(stored))) === canonicalDocs([plan.base.doc]),
    "ConfigHub stored a different base ClusterProfile",
  );
  return {
    space,
    unit: policyUnit,
    revisionId: plan.base.revisions.baseline,
    revision: Number(stored.HeadRevisionNum),
    contentHash: stored.ContentHash,
    target: "none",
    published: false,
    reachesCluster: false,
    note: "The base carries no target and its Space is never published, so it reaches no cluster on its own.",
  };
}

// A variant is a clone of the base unit, linked to it, with this cluster's
// departures written over it. The link is what lets a later base change flow
// down while the departures stay.
function establishVariant({
  policyContext,
  space,
  baseSpace,
  cluster,
  topology,
  catalogTarget,
  runId,
  workRoot,
  policySpacesCreated,
}) {
  createPolicySpace(policyContext, space);
  policySpacesCreated.add(space);
  assertPolicySpace(
    policyContext,
    space,
    topology.triggerIds,
    catalogTarget.TargetID,
  );
  cub(policyContext, [
    "unit", "create", "--space", space, policyUnit,
    "--upstream-space", baseSpace,
    "--upstream-unit", policyUnit,
    "--target", catalogOciTargetRef,
    "--label", "App=sveltos-kyverno-env-rollout",
    "--label", `Cluster=${cluster.cluster}`,
    "--label", `Environment=${cluster.environment}`,
    "--label", `Wave=${cluster.wave}`,
    "--label", `Proof=${proofLabel}`,
    "--label", `Run=${runId}`,
    "--label", `Record=${variantRecordLabel}`,
    "--change-desc", `Clone the base record for ${cluster.cluster}`,
    "--quiet",
  ]);
  const cloned = cubJson(policyContext, [
    "unit", "get", "--space", space, policyUnit, "-o", "json",
  ]).Unit;
  const upstreamUnit = String(cloned.UpstreamUnitID ?? "");
  check(
    upstreamUnit.length > 0,
    `${space}/${policyUnit} records no upstream unit, so it is a copy rather than a variant`,
  );
  const departedPath = join(workRoot, `clusterprofile-${cluster.cluster}.yaml`);
  writeStoredDocuments(departedPath, [cluster.baselineDoc]);
  cub(policyContext, [
    "unit", "update", "--space", space, policyUnit, departedPath,
    "--change-desc",
    `Depart from the base for ${cluster.cluster}: ${cluster.departurePaths.join(", ")}`,
    "--quiet",
  ]);
  const departed = cubJson(policyContext, [
    "unit", "get", "--space", space, policyUnit, "-o", "json",
  ]).Unit;
  check(
    canonicalDocs(parseDocs(storedData(departed)))
      === canonicalDocs([cluster.baselineDoc]),
    `ConfigHub stored different departures for ${cluster.cluster}`,
  );
  assertUpstreamLineage(policyContext, space, cluster.cluster);
  return {
    cluster: cluster.cluster,
    environment: cluster.environment,
    wave: cluster.wave,
    space,
    unit: policyUnit,
    profile: cluster.profileName,
    selector: { cluster: cluster.cluster },
    upstream: {
      space: baseSpace,
      unit: policyUnit,
      unitLinked: true,
      revisionAtClone: Number(cloned.UpstreamRevisionNum ?? 0),
    },
    departures: cluster.departures,
    departedFields: cluster.departurePaths,
  };
}

// The management record holds one bootstrap profile per workload Space. It is
// the record that opens the gateway path, so its first revision is applied out
// of band with kubectl, and ConfigHub governs every revision after that.
function establishManagement({
  policyContext,
  space,
  plan,
  topology,
  catalogTarget,
  runId,
  workRoot,
  policySpacesCreated,
  workloadSpaces,
}) {
  createPolicySpace(policyContext, space);
  policySpacesCreated.add(space);
  assertPolicySpace(
    policyContext,
    space,
    topology.triggerIds,
    catalogTarget.TargetID,
  );
  const manifest = workloadSpaces
    .map((row) => bootstrapProfileManifest(row.cluster, row.space))
    .join("---\n");
  const manifestPath = join(workRoot, "clusterprofile-management.yaml");
  writeFileSync(manifestPath, manifest, { mode: 0o600 });
  const documents = parseDocs(manifest);
  check(
    documents.length === workloadSpaces.length,
    "the management record must hold one bootstrap profile per workload Space",
  );
  cub(policyContext, [
    "unit", "create", "--space", space, policyUnit, manifestPath,
    "--target", catalogOciTargetRef,
    "--label", "App=sveltos-kyverno-env-rollout",
    "--label", `Cluster=${plan.management.cluster}`,
    "--label", "Role=management",
    "--label", `Proof=${proofLabel}`,
    "--label", `Run=${runId}`,
    "--label", `Record=${variantRecordLabel}`,
    "--change-desc", "Store the reviewed bootstrap profiles for the management cluster",
    "--quiet",
  ]);
  return {
    cluster: plan.management.cluster,
    space,
    unit: policyUnit,
    documents,
    manifestPath,
    revisionId: `m1-${sha256(stableJson(documents)).slice(0, 12)}`,
    bootstrapProfiles: workloadSpaces.map((row) => ({
      profile: bootstrapProfileName(row.cluster),
      cluster: row.cluster,
      space: row.space,
      reference: gatewayReference(row.space),
    })),
    boundary: {
      appliedOutOfBandWith: plan.management.appliedOutOfBandWith,
      firstRevisionDeliveredThroughGateway: false,
      laterRevisionsGovernedInConfigHub: true,
      reason: plan.management.reason,
    },
  };
}

// One wave, one operation. The set is resolved with the reviewed query first,
// so a query that matches nothing, or that reaches past the wave, refuses
// before anything is approved.
function selectSet({ policyContext, stageName, query, expectedUnits }) {
  const listed = cubJson(policyContext, [
    "unit", "list", "--space", "*", "--where", query, "-o", "json",
  ]);
  const rows = Array.isArray(listed) ? listed : (listed.Units ?? []);
  const matched = rows
    .map((row) => {
      const unit = row.Unit ?? row;
      return `${unit.SpaceSlug}/${unit.Slug}`;
    })
    .sort();
  check(
    matched.length > 0,
    `the ${stageName} query matched no unit; ${query}`,
  );
  check(
    sameSet(matched, expectedUnits),
    `the ${stageName} query matched ${matched.join(", ") || "nothing"} rather than ${[...expectedUnits].sort().join(", ")}; refusing to approve a set that is not the wave`,
  );
  return { scope: setScope, query, matched };
}

// The gate armed with no approval, one set approval bound to each unit's own
// exact head revision, the gate cleared with the approval recorded, and the
// private release the gateway then serves at each Space's tag.
function reviewSet({ policyContext, stageName, query, members }) {
  const stored = {};
  const beforeApproval = {};
  for (const member of members) {
    const unit = waitForPolicy(policyContext, member.space, policyUnit, true);
    check(
      canonicalDocs(parseDocs(storedData(unit)))
        === canonicalDocs(member.expectedDocs),
      `ConfigHub stored a different ${stageName} record for ${member.cluster}`,
    );
    if (member.minimumRevision !== undefined) {
      check(
        Number(unit.HeadRevisionNum) >= member.minimumRevision,
        `the ${stageName} did not create a new revision for ${member.cluster}`,
      );
    }
    stored[member.cluster] = unit;
    beforeApproval[member.cluster] = blockedDryRun(
      policyContext,
      member.space,
      policyUnit,
    );
  }
  const selection = selectSet({
    policyContext,
    stageName,
    query,
    expectedUnits: members.map((member) => `${member.space}/${policyUnit}`),
  });
  approveSet(policyContext, query, stageName, stored);

  const records = {};
  for (const member of members) {
    const approved = waitForPolicy(policyContext, member.space, policyUnit, false);
    check(
      approved.ContentHash === stored[member.cluster].ContentHash,
      `approval changed the ${stageName} content for ${member.cluster}`,
    );
    const recordedApprovals = approvalCount(approved.ApprovedBy);
    check(
      recordedApprovals >= 1,
      `the ${stageName} record for ${member.cluster} has no approval`,
    );
    const afterApproval = allowedDryRun(policyContext, member.space, policyUnit);
    // The published release is not read back here. What the gateway served is
    // proved downstream, where the object that arrived on the management
    // cluster is compared field by field against the approved revision.
    //
    // The management record is the exception, and it is the record that opens
    // the gateway path. Its bootstrap profiles are what let the management
    // cluster fetch at all, so its first revision cannot arrive through the
    // gateway and is applied with kubectl instead. It is stored, gated, and
    // approved exactly like every other record; it is simply not published.
    const release = member.publishesRelease === false
      ? null
      : publishRelease(policyContext, member.space);
    records[member.cluster] = {
      cluster: member.cluster,
      space: member.space,
      revisionId: member.revisionId,
      contentHash: stored[member.cluster].ContentHash,
      beforeApproval: beforeApproval[member.cluster],
      approval: {
        revision: approved.HeadRevisionNum,
        recordedApprovals,
        approverIdentityRecordedInReceipt: false,
        contentHashUnchanged: true,
      },
      afterApproval,
      release,
    };
  }
  return {
    stage: stageName,
    selection,
    approval: {
      command: `cub unit approve --space "*" --where <query> --revision HeadRevisionNum`,
      appliedAsOneOperation: true,
      members: members.length,
      recordedApprovals: members.length,
    },
    records,
  };
}

function approveSet(policyContext, query, stageName, stored) {
  const result = cubTry(policyContext, [
    "unit", "approve", "--space", "*", "--where", query,
    "--revision", "HeadRevisionNum", "--wait", "--quiet",
  ]);
  if (result.ok) return;
  // The bulk approve can report a delayed trigger while the approvals it made
  // are already recorded, so the refusal is checked against the units.
  for (const [cluster, unit] of Object.entries(stored)) {
    const current = cubJson(policyContext, [
      "unit", "get", "--space", unit.SpaceSlug, policyUnit, "-o", "json",
    ]).Unit;
    check(
      Number(current.HeadRevisionNum) === Number(unit.HeadRevisionNum)
        && approvalCount(current.ApprovedBy) >= 1,
      `ConfigHub rejected the ${stageName} approval for ${cluster} before recording it: ${result.error}`,
    );
  }
  phase(`${stageName} approvals recorded; waiting for delayed trigger completion`);
}

// The reviewed change lands once, on the base. Every variant inherits it when
// its wave comes, and keeps its own departures through the merge.
function changeBaseRecord({ policyContext, space, plan, workRoot }) {
  const changedPath = join(workRoot, "clusterprofile-base-changed.yaml");
  writeStoredDocuments(changedPath, [plan.base.changedDoc]);
  cub(policyContext, [
    "unit", "update", "--space", space, policyUnit, changedPath,
    "--change-desc",
    `Raise ${plan.change.spec.valuesPath} from ${plan.change.spec.before} to ${plan.change.spec.after} on the base record`,
    "--quiet",
  ]);
  const stored = cubJson(policyContext, [
    "unit", "get", "--space", space, policyUnit, "-o", "json",
  ]).Unit;
  check(
    canonicalDocs(parseDocs(storedData(stored)))
      === canonicalDocs([plan.base.changedDoc]),
    "ConfigHub stored a different changed base ClusterProfile",
  );
  return {
    space,
    unit: policyUnit,
    revisionId: plan.base.revisions.changed,
    revision: Number(stored.HeadRevisionNum),
    valuesPath: plan.change.spec.valuesPath,
    before: plan.change.spec.before,
    after: plan.change.spec.after,
    approved: false,
    publishedAsRelease: false,
  };
}

function promoteWave({
  policyContext,
  managementKubeconfig,
  managementName,
  wave,
  plan,
  spaceFor,
  runId,
  variantRecords,
}) {
  const query = waveQuery(plan, runId, wave.environment);
  const clusters = wave.clusters.map((name) =>
    plan.clusters.find((row) => row.cluster === name));
  const expectedUnits = clusters.map((row) => `${spaceFor[row.cluster]}/${policyUnit}`);
  // Selecting before upgrading means a query that reaches past the wave stops
  // the wave, rather than carrying a cluster the wave never named.
  const preflight = selectSet({
    policyContext,
    stageName: `wave ${wave.wave}`,
    query,
    expectedUnits,
  });
  const upgrade = cubTry(policyContext, [
    "unit", "update", "--patch", "--space", "*", "--where", query, "--upgrade",
    "--change-desc",
    `Inherit ${plan.change.spec.valuesPath}=${plan.change.spec.after} from the base into the ${wave.environment} variants`,
    "--quiet",
  ]);
  check(
    upgrade.ok,
    `the wave ${wave.wave} upgrade did not run: ${upgrade.error}`,
  );
  for (const row of clusters) {
    assertMergeKeptDepartures({
      policyContext,
      space: spaceFor[row.cluster],
      cluster: row,
      plan,
    });
  }
  const members = clusters.map((row) => ({
    cluster: row.cluster,
    space: spaceFor[row.cluster],
    expectedDocs: [row.changedDoc],
    revisionId: row.revisions.changed,
    minimumRevision:
      Number(variantRecords[row.cluster].baseline.approval.revision) + 1,
  }));
  const reviewed = reviewSet({
    policyContext,
    stageName: `wave ${wave.wave}`,
    query,
    members,
  });
  const promoted = [];
  for (const row of clusters) {
    const record = reviewed.records[row.cluster];
    check(
      record.release.manifestDigest
        !== variantRecords[row.cluster].baseline.release.manifestDigest,
      `the ${row.cluster} promotion did not produce a new release manifest digest`,
    );
    // Promotion leaves the bootstrap profiles alone. Publishing the release
    // moved the tag the gateway serves, and Sveltos follows on its interval.
    const delivery = waitForRemoteDeploy({
      managementKubeconfig,
      managementName,
      cluster: row.cluster,
      profileName: row.profileName,
      expectedDoc: row.changedDoc,
      release: record.release,
    });
    check(
      delivery.result === "pass",
      `Sveltos did not fetch the ${row.cluster} promotion from the gateway: ${delivery.reason ?? "unknown"}`,
    );
    assertLiveProfileMatches({
      managementKubeconfig,
      profileName: row.profileName,
      expectedDoc: row.changedDoc,
    });
    variantRecords[row.cluster].changed = { ...record, delivery };
    promoted.push({
      cluster: row.cluster,
      space: record.space,
      revision: record.approval.revision,
      revisionId: record.revisionId,
      recordedApprovals: record.approval.recordedApprovals,
      releaseManifestDigest: record.release.manifestDigest,
      inheritedFields: row.inheritedFields,
      departedFields: row.departurePaths,
    });
  }
  return {
    wave: wave.wave,
    environment: wave.environment,
    selection: { ...preflight, ...reviewed.selection },
    upgrade: {
      command: `cub unit update --patch --space "*" --where <query> --upgrade`,
      appliedAsOneOperation: true,
      members: clusters.length,
    },
    approval: reviewed.approval,
    clusters: promoted,
  };
}

// A promotion that reports success while the variant kept its old content is
// the silent win the recorded ConfigHub finding describes. The runner names
// which side lost rather than letting the wave read as promoted.
function assertMergeKeptDepartures({ policyContext, space, cluster, plan }) {
  const stored = cubJson(policyContext, [
    "unit", "get", "--space", space, policyUnit, "-o", "json",
  ]).Unit;
  const documents = parseDocs(storedData(stored));
  if (canonicalDocs(documents) === canonicalDocs([cluster.changedDoc])) return;
  const merged = documents[0] ?? {};
  const inherited =
    readPath(valuesOf(merged), plan.change.spec.valuesPath)
    === plan.change.spec.after;
  const kept = cluster.departurePaths.filter(
    (path) => readPath(merged, path) === cluster.departures[path],
  );
  check(
    false,
    `${cluster.cluster} did not come out of the upgrade as the reviewed merge: inheritedTheChange=${inherited}, departuresKept=${kept.length}/${cluster.departurePaths.length}. A change and a departure that write the same field, or different keys of the same map, merge with the departure winning and nothing said about it, so this promotion is refused rather than recorded as a success.`,
  );
}

function assertLiveProfileMatches({ managementKubeconfig, profileName, expectedDoc }) {
  const live = JSON.parse(
    clusterCommand(managementKubeconfig, [
      "get", "clusterprofile", profileName, "-o", "json",
    ]).output,
  );
  check(
    sourceFieldsMatchLive(expectedDoc, live),
    `a field from the approved ${profileName} ClusterProfile changed in the live object`,
  );
}

// How long a cluster gets to reach the state this checkpoint expects.
// At the baseline every cluster is installing the chart for the first time,
// so all of them earn the convergence wait. After that only the environment
// this checkpoint just changed converges, and the short budget on the others
// is what proves they held their state rather than drifting to the new one.
// Kyverno takes over a minute to become available, so the generous budget has
// to be minutes and the short one has to stay short.
function convergenceAttempts(environmentWave, completedWaves) {
  if (completedWaves === 0) return convergenceWaitAttempts;
  return environmentWave === completedWaves
    ? convergenceWaitAttempts
    : holdingCheckAttempts;
}

function recordCheckpoint({
  id,
  completedWaves,
  plan,
  fleetClusters,
  managementKubeconfig,
}) {
  const observations = fleetClusters.map((row) => {
    const planned = plan.clusters.find(
      (item) => item.cluster === row.logicalCluster,
    );
    const changed = planned.wave <= completedWaves;
    const expectedReplicas = changed
      ? planned.expectedReplicas.changed
      : planned.expectedReplicas.baseline;
    const observation = observeWorkload({
      managementKubeconfig,
      workloadName: row.cluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: planned.profileName,
      expectedReplicas,
      attempts: convergenceAttempts(planned.wave, completedWaves),
    });
    check(
      observation.result === "pass",
      `${row.cluster} did not hold the expected state at ${id}: ${observation.reason ?? "unknown"}`,
    );
    return {
      cluster: row.cluster,
      logicalCluster: row.logicalCluster,
      environment: row.environment,
      expectedRevisionId: changed
        ? planned.revisions.changed
        : planned.revisions.baseline,
      expectedBackgroundReplicas: changed
        ? plan.change.spec.after
        : plan.change.spec.before,
      expectedReplicas,
      departedFields: planned.departurePaths,
      observation,
    };
  });
  return { id, completedWaves, observations };
}

function auditConvergence({ plan, fleetClusters, managementKubeconfig }) {
  const clusters = fleetClusters.map((row) => {
    const planned = plan.clusters.find(
      (item) => item.cluster === row.logicalCluster,
    );
    const observation = observeWorkload({
      managementKubeconfig,
      workloadName: row.cluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: planned.profileName,
      expectedReplicas: planned.expectedReplicas.changed,
      attempts: 30,
    });
    return {
      cluster: row.cluster,
      logicalCluster: row.logicalCluster,
      environment: row.environment,
      expectedReplicas: planned.expectedReplicas.changed,
      observation,
    };
  });
  return {
    result: clusters.every((row) => row.observation.result === "pass")
      ? "pass"
      : "fail",
    expectedBackgroundReplicas: plan.change.spec.after,
    clusters,
  };
}

// Every cluster is checked against its own reviewed replica counts, so an
// inherited change and a surviving departure are both observable on the
// cluster rather than only in the record.
function observeWorkload({
  managementKubeconfig,
  workloadName,
  workloadKubeconfig,
  profileName,
  expectedReplicas,
  attempts,
}) {
  const expectedBackgroundReplicas = expectedReplicas[backgroundDeployment];
  let last = { summary: "missing", helmStatus: "missing", deployments: [] };
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
    const observedFor = (name) =>
      last.deployments.find((deployment) => deployment.name === name);
    const stable =
      last.deployments.length === 4
      && last.deployments.every(
        (deployment) =>
          deployment.desired === deployment.available
          && deployment.observedGenerationMatches,
      )
      && Object.entries(expectedReplicas).every(
        ([name, replicas]) => observedFor(name)?.desired === replicas,
      );
    if (last.helmStatus === "Provisioned" && stable) {
      const releases = JSON.parse(
        helmCommand(workloadKubeconfig, ["list", "-n", "kyverno", "-o", "json"])
          .output,
      );
      const release = releases.find((item) => item.name === "kyverno");
      check(release, `the Kyverno Helm release is missing on ${workloadName}`);
      return {
        result: "pass",
        clusterSummary: last.summary,
        helmFeatureStatus: last.helmStatus,
        helmRelease: {
          name: release.name,
          namespace: release.namespace,
          chart: release.chart,
          status: release.status,
        },
        backgroundReplicas: {
          desired: background.desired,
          available: background.available,
        },
        observedReplicas: Object.fromEntries(
          Object.keys(expectedReplicas).map((name) => [
            name,
            observedFor(name).desired,
          ]),
        ),
        deployments: last.deployments,
      };
    }
    if (attempt + 1 < attempts) sleep(4000);
  }
  return {
    result: "fail",
    reason: `summary=${last.summary}; helm=${last.helmStatus}; deployments=${
      JSON.stringify(last.deployments)
    }; expectedReplicas=${JSON.stringify(expectedReplicas)}`,
  };
}

function buildReceipt({
  recordedAt,
  plan,
  topology,
  catalogTarget,
  managementName,
  managementRegistration,
  sveltosInstall,
  gatewayCredential,
  registrations,
  baseRecord,
  baseChange,
  baselineSet,
  variantRecords,
  managementVariant,
  bootstrap,
  waveRecords,
  checkpoints,
  convergenceAudit,
  cleanup,
}) {
  const variants = [
    ...plan.clusters.map((row) => {
      const record = variantRecords[row.cluster];
      return {
        cluster: row.cluster,
        role: "workload",
        environment: row.environment,
        wave: row.wave,
        space: record.space,
        gatewayReference: gatewayReference(record.space),
        unit: policyUnit,
        profile: row.profileName,
        selector: record.selector,
        upstream: record.upstream,
        departures: record.departures,
        departedFields: record.departedFields,
        inheritedFields: row.inheritedFields,
        records: [
          { stage: "baseline", wave: 0, ...record.baseline },
          { stage: "changed", wave: row.wave, ...record.changed },
        ],
      };
    }),
    {
      cluster: plan.management.cluster,
      role: "management",
      environment: "management",
      wave: 0,
      space: managementVariant.space,
      gatewayReference: gatewayReference(managementVariant.space),
      unit: policyUnit,
      profile: managementVariant.bootstrapProfiles
        .map((row) => row.profile)
        .join(","),
      selector: { role: "management" },
      upstream: null,
      departures: {},
      departedFields: [],
      inheritedFields: [],
      bootstrapProfiles: managementVariant.bootstrapProfiles,
      boundary: managementVariant.boundary,
      records: [{ stage: "baseline", wave: 0, ...managementVariant.baseline }],
    },
  ];
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosEnvRolloutProofReceipt",
    metadata: { name: "kyverno-environment-rollout" },
    spec: {
      recordedAt,
      flow: {
        path: "source -> one reviewed base record in ConfigHub -> one variant per cluster -> approval per variant -> ConfigHub release -> the ConfigHub OCI gateway -> Sveltos -> Kubernetes",
        promotion: "one reviewed values change made once on the base and inherited by the variants pilot, then staging, then both production clusters",
        mapping: "ConfigHub holds one record per cluster, so this receipt answers which cluster runs which revision without reading a Sveltos selector or a cluster",
      },
      source: {
        base: {
          path: plan.base.repoPath,
          rawSha256: sha256(plan.base.text),
        },
        variants: {
          path: relativeRepo(variantsPath),
          rawSha256: sha256(readFileSync(variantsPath, "utf8")),
        },
        change: {
          path: "examples/sveltos/env-rollout/change-candidate.yaml",
          rawSha256: sha256(readFileSync(changePath, "utf8")),
          valuesPath: plan.change.spec.valuesPath,
          before: plan.change.spec.before,
          after: plan.change.spec.after,
          editedRecord: "base",
        },
        sourceLock: relativeRepo(sourceLockPath),
        gatewayRecord: probeRecord,
      },
      revisions: {
        base: plan.base.revisions,
        clusters: Object.fromEntries(
          plan.clusters.map((row) => [row.cluster, row.revisions]),
        ),
      },
      policy: {
        organization: expectedPolicyOrg,
        profile: "catalog-standard",
        resourceClass: "system-configuration",
        filter: topology,
        approvalGate,
        target: {
          ref: catalogOciTargetRef,
          id: catalogTarget.TargetID,
          provider: catalogTarget.ProviderType,
        },
      },
      prerequisite: sveltosInstall,
      base: { ...baseRecord, change: baseChange },
      variants,
      baselineApproval: {
        scope: baselineSet.selection.scope,
        query: baselineSet.selection.query,
        matched: baselineSet.selection.matched,
        ...baselineSet.approval,
      },
      waves: waveRecords,
      gatewayDelivery: {
        host: configHubOciHost,
        tag: releaseTag,
        interval: remoteFetchInterval,
        deploymentType: "Remote",
        fetchedBy: "the Sveltos addon controller on the management cluster",
        addonControllerImage: sveltosInstall.addonControllerImage,
        secret: gatewayCredential.secret,
        bootstrap,
        clusters: Object.fromEntries(plan.clusters.map((row) => [
          row.cluster,
          {
            space: variantRecords[row.cluster].space,
            reference: gatewayReference(variantRecords[row.cluster].space),
            bootstrapProfile: bootstrapProfileName(row.cluster),
            baselineReleaseManifestDigest:
              variantRecords[row.cluster].baseline.release.manifestDigest,
            changedReleaseManifestDigest:
              variantRecords[row.cluster].changed.release.manifestDigest,
          },
        ])),
        waves: waveRecords.map((row) => ({
          wave: row.wave,
          environment: row.environment,
          clusters: row.clusters.map((member) => ({
            cluster: member.cluster,
            releaseManifestDigest: member.releaseManifestDigest,
          })),
        })),
      },
      fleet: {
        managementCluster: managementName,
        creationCommand: "kind create cluster",
        managementRegistration,
        registrations,
      },
      checkpoints,
      convergenceAudit,
      cleanup,
      limits: [
        "The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.",
        "The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.",
        "The management record was applied out of band with kubectl, because it is the record that opens the gateway path.",
        "The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.",
        "The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.",
        "The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.",
        "The proof covers one reviewed values change to this Kyverno base, not a chart version bump.",
      ],
    },
    status: {
      result: "pass",
      claim: "ConfigHub held one variant per cluster over a shared base, each carrying its own departures, and one reviewed change made on the base was inherited wave by wave. Each wave selected its variants with one query and approved that set in one operation, and every approval bound one cluster's record to its own exact revision. Each approved revision was published as a release the ConfigHub OCI gateway serves, Sveltos fetched each release itself, and every cluster converged on its own reviewed state with its departures intact, with the clusters outside the wave verified stable at every checkpoint.",
    },
  };
}

function verifyReceipt(receipt) {
  check(
    receipt.kind === "SveltosEnvRolloutProofReceipt",
    "Sveltos env rollout receipt kind changed",
  );
  check(receipt.status?.result === "pass", "Sveltos env rollout proof is not pass");
  const plan = loadRolloutPlan();
  check(
    receipt.spec?.source?.base?.path === plan.base.repoPath
      && receipt.spec.source.base.rawSha256 === sha256(plan.base.text)
      && receipt.spec.source.variants?.path === relativeRepo(variantsPath)
      && receipt.spec.source.variants.rawSha256
      === sha256(readFileSync(variantsPath, "utf8")),
    "Sveltos env rollout source record changed",
  );
  check(
    receipt.spec?.source?.change?.rawSha256
      === sha256(readFileSync(changePath, "utf8"))
      && receipt.spec.source.change.valuesPath === plan.change.spec.valuesPath
      && receipt.spec.source.change.before === plan.change.spec.before
      && receipt.spec.source.change.after === plan.change.spec.after
      && receipt.spec.source.change.editedRecord === "base",
    "Sveltos env rollout change record changed",
  );
  for (const row of plan.clusters) {
    check(
      receipt.spec?.revisions?.clusters?.[row.cluster]?.baseline
        === row.revisions.baseline
        && receipt.spec.revisions.clusters[row.cluster].changed
        === row.revisions.changed,
      "the receipt revisions no longer match the reviewed example files",
    );
  }
  const recordedTriggers = receipt.spec?.policy?.filter?.triggerRefs ?? [];
  check(
    receipt.spec?.policy?.organization === expectedPolicyOrg
      && receipt.spec.policy.profile === "catalog-standard"
      && receipt.spec.policy.approvalGate === approvalGate
      && sameSet(recordedTriggers, expectedTriggers),
    "Sveltos env rollout policy record changed",
  );
  const sveltos = loadSveltosPin();
  check(
    receipt.spec?.prerequisite?.version === sveltos.version
      && receipt.spec.prerequisite.manifestSha256 === sveltos.manifestSha256
      && receipt.spec.prerequisite.deployments?.length > 0,
    "Sveltos env rollout prerequisite record changed",
  );
  verifyBaseRecord(receipt, plan);
  verifyVariants(receipt, plan);
  verifyWaves(receipt, plan);
  verifyGatewayDelivery(receipt, plan);
  check(
    receipt.spec?.fleet?.managementRegistration?.labels?.role === "management"
      && receipt.spec.fleet.managementRegistration.ready === true,
    "the management cluster must be registered so it can fetch each release",
  );
  const registrations = receipt.spec?.fleet?.registrations ?? [];
  check(
    registrations.length === plan.clusters.length
      && registrations.every(
        (registration) =>
          registration.ready === true
          && registration.credential?.storedInRepository === false,
      )
      && plan.clusters.every((row) =>
        registrations.some((registration) =>
          registration.labels?.cluster === row.cluster
          && registration.labels.environment === row.environment))
      && new Set(registrations.map((row) => row.labels?.cluster)).size
      === registrations.length,
    "every workload cluster must be registered with its own addressing label",
  );
  const checkpoints = receipt.spec?.checkpoints ?? [];
  check(
    checkpoints.map((checkpoint) => checkpoint.id).join(",")
      === "baseline,after-wave-1,after-wave-2,after-wave-3",
    "Sveltos env rollout checkpoint set changed",
  );
  for (const checkpoint of checkpoints) {
    check(
      checkpoint.observations?.length === plan.clusters.length
        && new Set(checkpoint.observations.map((row) => row.cluster)).size
        === plan.clusters.length,
      `Sveltos env rollout ${checkpoint.id} observation set changed`,
    );
    for (const row of checkpoint.observations) {
      const planned = plan.clusters.find(
        (item) => item.cluster === row.logicalCluster,
      );
      check(planned, `${checkpoint.id} observed an unplanned cluster`);
      const changed = planned.wave <= checkpoint.completedWaves;
      const expectedRevision = changed
        ? planned.revisions.changed
        : planned.revisions.baseline;
      const expectedReplicas = changed
        ? planned.expectedReplicas.changed
        : planned.expectedReplicas.baseline;
      check(
        row.expectedRevisionId === expectedRevision
          && stableJson(row.expectedReplicas) === stableJson(expectedReplicas)
          && row.observation?.result === "pass"
          && row.observation.helmFeatureStatus === "Provisioned"
          && stableJson(row.observation.observedReplicas)
          === stableJson(expectedReplicas),
        `Sveltos env rollout ${checkpoint.id} observation for ${row.cluster} changed`,
      );
    }
  }
  check(
    receipt.spec?.convergenceAudit?.result === "pass"
      && receipt.spec.convergenceAudit.clusters?.length === plan.clusters.length
      && receipt.spec.convergenceAudit.clusters.every(
        (row) => row.observation?.result === "pass",
      ),
    "Sveltos env rollout convergence audit changed",
  );
  verifyCleanup(receipt);
  const serialized = JSON.stringify(receipt);
  check(
    !/argo/i.test(serialized),
    "this proof delivers through the ConfigHub OCI gateway; a receipt naming Argo CD predates that design",
  );
  check(
    !/\bflux\b/i.test(serialized),
    "this proof delivers through the ConfigHub OCI gateway; a receipt naming Flux predates that design",
  );
  check(
    !/temporary registry|anonymous registry|registry:2|host\.docker\.internal|127\.0\.0\.1:\d+/i.test(
      serialized,
    ),
    "this proof reads each release from the ConfigHub OCI gateway; a receipt naming a temporary registry predates that design",
  );
  check(
    !serialized.includes("@confighub.com"),
    "Sveltos env rollout receipt contains a user identity",
  );
  check(
    !serialized.includes("ch_") && !serialized.includes("eyJ"),
    "Sveltos env rollout receipt contains a credential",
  );
}

// The base is the record every variant clones. It must stay a record that
// reaches no cluster, or the per-cluster mapping has a hole in it.
function verifyBaseRecord(receipt, plan) {
  const base = receipt.spec?.base ?? {};
  check(
    base.unit === policyUnit
      && base.revisionId === plan.base.revisions.baseline
      && base.target === "none"
      && base.published === false
      && base.reachesCluster === false,
    "the base record must carry no target and reach no cluster",
  );
  check(
    base.change?.revisionId === plan.base.revisions.changed
      && base.change.valuesPath === plan.change.spec.valuesPath
      && base.change.after === plan.change.spec.after
      && Number(base.change.revision) > Number(base.revision)
      && base.change.publishedAsRelease === false,
    "the reviewed change must land once on the base record and never be published from it",
  );
}

// The whole point of the rework: one record per cluster, each addressing its
// own cluster and nothing else, each holding its own departures.
function verifyVariants(receipt, plan) {
  const variants = receipt.spec?.variants ?? [];
  const expected = [...plan.clusters.map((row) => row.cluster), plan.management.cluster];
  check(
    variants.length === expected.length
      && sameSet(variants.map((row) => row.cluster), expected),
    `the receipt must record one variant per cluster, which is ${expected.length} of them`,
  );
  check(
    new Set(variants.map((row) => row.space)).size === variants.length,
    "two variants share a Space, so ConfigHub cannot answer which cluster runs which change",
  );
  check(
    new Set(variants.map((row) => row.gatewayReference)).size === variants.length,
    "two variants share a gateway reference, so they cannot be served separately",
  );
  // Selectors are evaluated against the labels the run recorded on the
  // registrations, so a selector is checked against the fleet that existed
  // rather than against the fleet the plan expected.
  const clusterLabels = Object.fromEntries(
    (receipt.spec?.fleet?.registrations ?? []).map((registration) => [
      registration.logicalCluster,
      registration.labels ?? {},
    ]),
  );
  for (const variant of variants) {
    check(
      variant.gatewayReference === gatewayReference(String(variant.space ?? ""))
        && variant.unit === policyUnit,
      `the ${variant.cluster} variant reference changed`,
    );
    for (const record of variant.records ?? []) {
      check(
        record.beforeApproval?.result === "blocked"
          && record.beforeApproval.gate === approvalGate
          && record.afterApproval?.result === "allowed"
          && record.approval?.recordedApprovals >= 1
          && record.approval.approverIdentityRecordedInReceipt === false
          && record.approval.contentHashUnchanged === true,
        `the ${variant.cluster} ${record.stage} approval record changed`,
      );
      // Only the management record may carry no release, and it must say so
      // rather than simply be missing one, so a workload record that failed to
      // publish can never pass as an out-of-band record.
      if (variant.role === "management") {
        check(
          record.release === null,
          `the ${variant.cluster} ${record.stage} record must not publish a release`,
        );
      } else {
        check(
          record.release,
          `the ${variant.cluster} ${record.stage} record published no release`,
        );
        check(
          normalizeDigest(record.release?.manifestDigest)
            === record.release.manifestDigest
            && record.release.space === variant.space
            && record.release.reference === variant.gatewayReference
            && record.release.tag === releaseTag,
          `the ${variant.cluster} ${record.stage} release record changed`,
        );
      }
    }
  }
  for (const row of plan.clusters) {
    const variant = variants.find((item) => item.cluster === row.cluster);
    check(
      variant.role === "workload"
        && variant.environment === row.environment
        && variant.wave === row.wave
        && variant.profile === row.profileName,
      `the ${row.cluster} variant identity changed`,
    );
    const selector = variant.selector ?? {};
    const matched = Object.entries(clusterLabels).filter(([, labels]) =>
      Object.entries(selector).every(([key, value]) => labels[key] === value));
    check(
      Object.keys(selector).join(",") === "cluster"
        && selector.cluster === row.cluster
        && matched.length === 1
        && matched[0][0] === row.cluster,
      `the ${row.cluster} selector must address one cluster by name and nothing else; this one matches ${matched.length} of the registered clusters, and a selector that matches an environment fans out and takes the mapping back out of ConfigHub`,
    );
    check(
      variant.upstream?.space === receipt.spec?.base?.space
        && variant.upstream.unit === policyUnit
        && variant.upstream.unitLinked === true,
      `the ${row.cluster} variant is not linked to the base record`,
    );
    check(
      sameSet(variant.departedFields ?? [], row.departurePaths)
        && stableJson(variant.departures) === stableJson(row.departures)
        && (variant.departedFields ?? []).some((path) =>
          !["metadata.name", "spec.clusterSelector.matchLabels.cluster"]
            .includes(path)),
      `the ${row.cluster} departures no longer match the reviewed variants record`,
    );
    check(
      sameSet(variant.inheritedFields ?? [], row.inheritedFields)
        && !(variant.departedFields ?? []).some((path) =>
          fieldsCollide(path, plan.changeField, plan.base.doc)),
      `the ${row.cluster} record must inherit the reviewed change rather than depart on it`,
    );
    const stages = (variant.records ?? []).map((record) => record.stage).join(",");
    check(
      stages === "baseline,changed"
        && variant.records[0].revisionId === row.revisions.baseline
        && variant.records[1].revisionId === row.revisions.changed
        && variant.records[1].wave === row.wave
        && variant.records[0].release.manifestDigest
        !== variant.records[1].release.manifestDigest
        && Number(variant.records[1].approval.revision)
        > Number(variant.records[0].approval.revision),
      `the ${row.cluster} revision record changed`,
    );
    for (const record of variant.records) {
      check(
        record.delivery?.result === "pass"
          && record.delivery.status === "Provisioned"
          && record.delivery.releaseManifestDigest
          === record.release.manifestDigest
          && record.delivery.profileMatchesApprovedRevision === true
          && record.delivery.reviewedProfile === row.profileName,
        `the ${row.cluster} ${record.stage} gateway delivery record changed`,
      );
    }
  }
  verifyManagementBoundary(receipt, plan, variants);
}

// The management record is the one that opens the gateway path, so it is the
// one record that arrives out of band. The receipt says so rather than
// implying the management cluster governed itself from the beginning.
function verifyManagementBoundary(receipt, plan, variants) {
  const variant = variants.find((row) => row.cluster === plan.management.cluster);
  check(
    variant?.role === "management" && variant.upstream === null,
    "the management record must be recorded as the management cluster's own record",
  );
  const boundary = variant.boundary ?? {};
  check(
    boundary.appliedOutOfBandWith === "kubectl"
      && boundary.firstRevisionDeliveredThroughGateway === false
      && boundary.laterRevisionsGovernedInConfigHub === true
      && String(boundary.reason ?? "").length > 0,
    "the management bootstrap boundary changed",
  );
  const profiles = variant.bootstrapProfiles ?? [];
  check(
    profiles.length === plan.clusters.length
      && plan.clusters.every((row) =>
        profiles.some((profile) =>
          profile.cluster === row.cluster
          && profile.profile === bootstrapProfileName(row.cluster)))
      && new Set(profiles.map((profile) => profile.reference)).size
      === profiles.length,
    "the management record must hold one bootstrap profile per workload Space",
  );
  const bootstrap = receipt.spec?.gatewayDelivery?.bootstrap ?? {};
  check(
    bootstrap.appliedWith === "kubectl as management-cluster setup"
      && bootstrap.changedByPromotion === false
      && (bootstrap.profiles ?? []).length === plan.clusters.length,
    "the bootstrap profiles must be applied once as cluster setup and left alone by promotion",
  );
}

// A wave is one operation over a named set. The receipt keeps the query, the
// members it matched, and one approval per member bound to its own revision.
function verifyWaves(receipt, plan) {
  const waves = receipt.spec?.waves ?? [];
  check(
    waves.map((row) => `${row.wave}:${row.environment}`).join(",")
      === plan.waves.map((row) => `${row.wave}:${row.environment}`).join(","),
    "Sveltos env rollout wave set changed",
  );
  const baseline = receipt.spec?.baselineApproval ?? {};
  check(
    baseline.scope === setScope
      && String(baseline.query ?? "").length > 0
      && baseline.appliedAsOneOperation === true
      && (baseline.matched ?? []).length === plan.clusters.length + 1
      && baseline.recordedApprovals === plan.clusters.length + 1,
    "the baseline must be approved as one set operation over every record this run created",
  );
  for (const wave of waves) {
    const planned = plan.waves.find((row) => row.wave === wave.wave);
    const members = wave.clusters ?? [];
    check(
      sameSet(members.map((row) => row.cluster), planned.clusters),
      `wave ${wave.wave} approved ${members.map((row) => row.cluster).join(", ")} rather than the ${wave.environment} clusters`,
    );
    check(
      wave.selection?.scope === setScope
        && String(wave.selection.query ?? "").includes(wave.environment)
        && sameSet(
          wave.selection.matched ?? [],
          members.map((row) => `${row.space}/${policyUnit}`),
        ),
      `wave ${wave.wave} must record the query that selected its set and the units it matched`,
    );
    check(
      wave.upgrade?.appliedAsOneOperation === true
        && wave.upgrade.members === members.length
        && wave.approval?.appliedAsOneOperation === true
        && wave.approval.recordedApprovals === members.length,
      `wave ${wave.wave} must promote its set in one operation and record one approval per member`,
    );
    for (const member of members) {
      const planCluster = plan.clusters.find(
        (row) => row.cluster === member.cluster,
      );
      check(
        member.revisionId === planCluster.revisions.changed
          && member.recordedApprovals >= 1
          && normalizeDigest(member.releaseManifestDigest)
          === member.releaseManifestDigest
          && sameSet(member.inheritedFields ?? [], planCluster.inheritedFields)
          && sameSet(member.departedFields ?? [], planCluster.departurePaths),
        `wave ${wave.wave} recorded a different approval for ${member.cluster}`,
      );
    }
  }
  const approved = waves.flatMap((wave) =>
    (wave.clusters ?? []).map((row) => row.cluster));
  check(
    sameSet(approved, plan.clusters.map((row) => row.cluster)),
    "every cluster must be approved in exactly one wave",
  );
}

// The delivery record carries this chapter's whole claim, so it is checked as
// one block: the gateway reference per cluster, the release manifest digest per
// wave, the fetch interval, the Secret type the fetcher requires, and the
// controller image the run actually ran.
function verifyGatewayDelivery(receipt, plan) {
  const delivery = receipt.spec?.gatewayDelivery ?? {};
  check(
    delivery.host === configHubOciHost
      && delivery.tag === releaseTag
      && delivery.interval === remoteFetchInterval
      && delivery.deploymentType === "Remote",
    "Sveltos env rollout gateway delivery contract changed",
  );
  check(
    delivery.secret?.name === gatewaySecretName
      && delivery.secret.namespace === registrationNamespace
      && delivery.secret.type === gatewaySecretType
      && delivery.secret.key === gatewaySecretKey
      && delivery.secret.tokenRecordedInReceipt === false,
    `the gateway credential record changed; the fetcher requires a Secret of type ${gatewaySecretType}`,
  );
  check(
    typeof delivery.addonControllerImage === "string"
      && /[:@]/.test(delivery.addonControllerImage)
      && delivery.addonControllerImage
      === receipt.spec?.prerequisite?.addonControllerImage,
    "the receipt must record the addon controller image the run used",
  );
  const digests = [];
  for (const row of plan.clusters) {
    const record = delivery.clusters?.[row.cluster] ?? {};
    check(
      record.reference === gatewayReference(String(record.space ?? ""))
        && record.reference.startsWith(`oci://${configHubOciHost}/space/`)
        && record.bootstrapProfile === bootstrapProfileName(row.cluster),
      `the ${row.cluster} gateway reference changed`,
    );
    for (const digest of [
      record.baselineReleaseManifestDigest,
      record.changedReleaseManifestDigest,
    ]) {
      check(
        normalizeDigest(digest) === digest,
        `the ${row.cluster} gateway delivery lost a release manifest digest`,
      );
      digests.push(digest);
    }
  }
  check(
    new Set(digests).size === digests.length,
    "every published release must carry its own manifest digest",
  );
  const waves = delivery.waves ?? [];
  check(
    waves.map((row) => `${row.wave}:${row.environment}`).join(",")
      === plan.waves.map((row) => `${row.wave}:${row.environment}`).join(","),
    "the gateway delivery waves changed",
  );
  const waveDigests = waves.flatMap((wave) =>
    (wave.clusters ?? []).map((row) => {
      check(
        row.releaseManifestDigest
          === delivery.clusters?.[row.cluster]?.changedReleaseManifestDigest,
        `wave ${wave.wave} published a different release for ${row.cluster}`,
      );
      return row.releaseManifestDigest;
    }));
  check(
    new Set(waveDigests).size === waveDigests.length
      && waveDigests.length === plan.clusters.length,
    "every cluster in every wave must publish its own release manifest digest",
  );
}

// Cleanup is a pass when everything was removed and also when the operator
// asked to keep the artifacts. Kept artifacts must say what was left and how
// to remove it, so a kept run never reads as a failed cleanup.
function verifyCleanup(receipt) {
  const cleanup = receipt.spec?.cleanup ?? {};
  check(
    cleanupSucceeded(cleanup),
    "Sveltos env rollout cleanup did not pass",
  );
  if (cleanup.mode !== "kept") return;
  check(
    (cleanup.kept ?? []).every((row) =>
      typeof row.kind === "string"
      && typeof row.name === "string"
      && /^(kind delete cluster|cub space delete) /.test(String(row.removeWith ?? ""))),
    "a kept artifact must record what it is and the command that removes it",
  );
}

function renderSummary(receipt) {
  const change = receipt.spec.source.change;
  const rows = receipt.spec.variants
    .filter((variant) => variant.role === "workload")
    .map((variant) => {
      const changed = variant.records[1];
      return `| ${variant.wave} | ${variant.cluster} | ${variant.space} | ${variant.departedFields.filter((path) => path.startsWith("values.")).join(", ")} | \`${changed.release.manifestDigest}\` | ${changed.delivery.status} |`;
    });
  const waves = receipt.spec.waves.map((wave) =>
    `| ${wave.wave} | ${wave.environment} | ${wave.clusters.length} | ${wave.approval.recordedApprovals} |`);
  const finalCheckpoint = receipt.spec.checkpoints.at(-1);
  const delivery = receipt.spec.gatewayDelivery;
  return `# ConfigHub promotes one change through a fleet it maps cluster by cluster

This run starts with four workload clusters and a management cluster. ConfigHub
holds one reviewed base record and one variant per cluster, so the answer to
which cluster runs which revision comes from ConfigHub rather than from a
selector on a cluster. Each variant carries its own departures from the base,
and its selector addresses its own cluster and nothing else.

One reviewed change raises \`${change.valuesPath}\` from ${change.before} to
${change.after} on the base record. Each wave selected its variants with one
query over the labels they carry and approved that set in one operation, so the
operator acted once per wave and ConfigHub still recorded one approval per
cluster against that cluster's own exact revision. Every approved revision was
published as a release the OCI gateway serves, and Sveltos fetched each release
itself from \`oci://${delivery.host}/space/<space>:${delivery.tag}\` on a
${delivery.interval} interval.

The management record holds one bootstrap profile per workload Space. It was
applied out of band with kubectl, because it is the record that opens the
gateway path. Promotion never touched it. Publishing a new release moved the
tag, and Sveltos followed it.

| Wave | Cluster | Space | Departure kept through the change | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

| Wave | Group | Variants selected | Approvals recorded |
| --- | --- | --- | --- |
${waves.join("\n")}

| Check | Result |
| --- | --- |
| Checkpoints observed | ${receipt.spec.checkpoints.length}/4 |
| Clusters at their own changed revision after wave 3 | ${finalCheckpoint.observations.filter((row) => row.observation.result === "pass").length}/4 |
| Convergence audit | ${receipt.spec.convergenceAudit.result} |
| Addon controller image | \`${delivery.addonControllerImage}\` |
| Cleanup | ${receipt.spec.cleanup.mode === "kept" ? "Artifacts kept deliberately" : "Pass"} |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows which cluster ran which revision at each
checkpoint.

## Limits

${receipt.spec.limits.map((limit) => `- ${limit}`).join("\n")}

- [Committed receipt](../../runs/sveltos-env-rollout-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/env-rollout/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/env-rollout/variants.yaml)
- [Reviewed change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
`;
}

// Documents that are applied to a cluster with kubectl are written as JSON,
// which is valid YAML and makes every scalar quoted, so a check for a pinned
// image cannot be satisfied by a longer tag that merely starts the same way.
function writeDocuments(path, documents) {
  writeFileSync(
    path,
    `${documents.map((document) =>
      JSON.stringify(document, null, 2)).join("\n---\n")}\n`,
  );
}

// Documents that ConfigHub stores are a different matter. ConfigHub tracks a
// variant against its base by aligning the resources in the two stored
// documents. A unit stored as YAML that is later written as JSON does not
// align: ConfigHub records the base resource as deleted and a different
// resource as added, which severs the upstream lineage. The variant then keeps
// its departures forever, inherits nothing, and every later promotion is a
// silent no-op that still reports success. That cost a live run before it was
// understood. Everything this runner stores is therefore written as YAML, the
// shape the base itself is stored from, with multi-line strings as block
// scalars so a values blob reads the way it does in the example files.
function writeStoredDocuments(path, documents) {
  const written = spawnSync("python3", ["-c", yamlWriter, path], {
    input: JSON.stringify(documents),
    encoding: "utf8",
  });
  check(
    written.status === 0,
    `could not write ${path} as YAML: ${written.stderr ?? written.error}`,
  );
  check(
    !readFileSync(path, "utf8").trimStart().startsWith("{"),
    `${path} was written as JSON, which severs a variant's upstream lineage`,
  );
}

function createPolicySpace(context, space) {
  assertPublishableSpaceName(space);
  cub(context, [
    "space", "create", space,
    "--label", "App=sveltos-kyverno-env-rollout",
    // The ConfigHub component view groups Spaces by their Component label and
    // files them under their Owner. Without these two the base and its
    // variants are invisible there, which is the one view where a reader
    // would look to see that a variant and a cluster stand one to one.
    "--label", `Component=${componentLabel}`,
    "--label", `Owner=${ownerLabel}`,
    "--label", "ApplyPolicyProfile=catalog-standard",
    "--label", "Proof=sveltos-env-rollout",
    "--label", "ResourceClass=system-configuration",
    "--label", "SourceType=sveltos",
    "--trigger-filter", approvalFilterRef,
    "--where-trigger", "-",
    "--quiet",
  ]);
  cub(context, [
    "space", "update", space,
    "--release-target", catalogOciTargetRef,
    "--quiet",
  ]);
  cub(context, [
    "space", "update", "--patch", space, "--refresh-triggers", "--quiet",
  ]);
}

function readApprovalTopology(context) {
  const filter = getByRef(context, "filter", approvalFilterRef).Filter;
  const triggers = expectedTriggers.map(
    (ref) => getByRef(context, "trigger", ref).Trigger,
  );
  return {
    ref: approvalFilterRef,
    id: filter.FilterID,
    hash: String(filter.Hash ?? "").trim(),
    triggerRefs: expectedTriggers,
    triggerIds: triggers.map((trigger) => trigger.TriggerID).sort(),
  };
}

function assertPolicySpace(context, space, expectedTriggerIds, expectedReleaseTargetId) {
  const actual = cubJson(context, ["space", "get", space, "-o", "json"]).Space;
  check(
    sameSet(actual.TriggerIDs ?? [], expectedTriggerIds),
    `${space} received the wrong Trigger set`,
  );
  check(
    actual.ReleaseTargetID === expectedReleaseTargetId,
    `${space} received the wrong release target`,
  );
}

function waitForPolicy(context, space, unit, approvalExpected) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const current = cubJson(
      context,
      ["unit", "get", unit, "--space", space, "-o", "json"],
    ).Unit;
    const waiting = current.ApplyGates?.["awaiting/triggers"] === true;
    const approvalPresent = current.ApplyGates?.[approvalGate] === true;
    if (!waiting && approvalPresent === approvalExpected) return current;
    sleep(1000);
  }
  throw new Error(`${space}/${unit} did not reach the expected policy state`);
}

function approvalObservation(context, space, unit) {
  // Read the whole Unit. `--select ApplyGates,ApprovedBy` does not project
  // those fields; it answers with an unrelated object, so a parser reading
  // them off the top level always saw an ungated Unit. That misreading is
  // what confighubai/confighub#4975 reported before it was withdrawn: the
  // gate attaches about a second after the Unit is created.
  const unitRecord = cubJson(context, [
    "unit", "get", "--space", space, unit,
    "-o", "json",
  ]);
  const info = unitRecord?.Unit ?? unitRecord;
  const gateKeys = Object.keys(info?.ApplyGates ?? {});
  const approvals = info?.ApprovedBy;
  const recorded = Array.isArray(approvals)
    ? approvals.length
    : Object.keys(approvals ?? {}).length;
  return { gateKeys, approvalCount: recorded };
}

function blockedDryRun(context, space, unit) {
  let seen = approvalObservation(context, space, unit);
  const gatePresent = () =>
    seen.gateKeys.some((key) => key === approvalGate || key.includes("require-approval"));
  const deadline = now() + 120_000;
  while (!gatePresent() && now() < deadline) {
    sleep(5_000);
    seen = approvalObservation(context, space, unit);
  }
  check(
    gatePresent(),
    `${space}/${unit} carries no ${approvalGate} apply gate before approval`,
  );
  check(
    seen.approvalCount === 0,
    `${space}/${unit} was already approved before the gate observation`,
  );
  return {
    result: "blocked",
    gate: approvalGate,
    observation: "apply-gate-present-approval-absent",
    dryRun: false,
    exitCode: 0,
  };
}

function allowedDryRun(context, space, unit) {
  const seen = approvalObservation(context, space, unit);
  check(
    seen.approvalCount > 0,
    `${space}/${unit} records no approval after the gate cleared`,
  );
  return {
    result: "allowed",
    observation: "approval-recorded",
    dryRun: false,
    exitCode: 0,
  };
}

// The server evaluates apply gates asynchronously, so a publish can arrive
// while a gate trigger is still queued. The server says so in those words, and
// re-queues the trigger. That is a race and not a refusal, so the publish waits
// for a bounded budget and then fails with the gate the server named. A gate
// that genuinely refuses reports something else and still stops the run here.
function pendingApplyGate(message) {
  return message.includes("outstanding ApplyGates")
    && message.includes("re-queued for evaluation");
}

function publishRelease(context, space) {
  let lastPending = "";
  let response;
  for (let attempt = 0; attempt < publishGateAttempts; attempt += 1) {
    try {
      response = cubJson(
        context,
        ["release", "publish", space, "-o", "json"],
        { timeout: 300_000 },
      );
      break;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!pendingApplyGate(message)) throw error;
      lastPending = message;
      response = undefined;
      sleep(publishGatePollMs);
    }
  }
  check(
    response,
    `${space} still had outstanding apply gates after ${
      Math.round((publishGateAttempts * publishGatePollMs) / 1000)
    }s; ${lastPending}`,
  );
  const release = response.Release ?? response.release ?? response;
  const manifestDigest = normalizeDigest(
    release.ManifestDigest ?? release.manifestDigest,
  );
  check(manifestDigest, `${space} release publish returned no manifest digest`);
  return {
    space,
    reference: gatewayReference(space),
    tag: releaseTag,
    manifestDigest,
    bundleDigest: normalizeDigest(release.Digest ?? release.digest),
    releaseId: String(release.ReleaseID ?? release.releaseId ?? ""),
  };
}

// The management cluster reads the gateway with the operator's own ConfigHub
// token. Sveltos refuses an Opaque Secret here, and the recorded probe names
// the type it requires, so the manifest builder refuses any other one.
function gatewayTokenSecretManifest(token, secretType = gatewaySecretType) {
  check(
    secretType === "addons.projectsveltos.io/cluster-profile",
    `the ConfigHub token Secret must carry the Sveltos cluster-profile type; an Opaque Secret fails with unsupported secret type, see ${probeRecord}`,
  );
  const value = String(token ?? "").trim();
  check(
    value.length > 20 && !/\s/.test(value),
    "cub returned no usable gateway token",
  );
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${gatewaySecretName}
  namespace: ${registrationNamespace}
type: ${secretType}
data:
  ${gatewaySecretKey}: ${Buffer.from(value).toString("base64")}
`;
}

function applyGatewayTokenSecret({
  policyContext,
  managementKubeconfig,
  workRoot,
}) {
  // The token goes straight from cub into the manifest. It is never logged,
  // never passed as an argument, and never recorded in the receipt.
  const token = cub(policyContext, ["auth", "get-token"]);
  const secretPath = join(workRoot, "confighub-gateway-secret.yaml");
  writeFileSync(secretPath, gatewayTokenSecretManifest(token), { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", secretPath]);
  return {
    secret: {
      name: gatewaySecretName,
      namespace: registrationNamespace,
      type: gatewaySecretType,
      key: gatewaySecretKey,
      source: "cub auth get-token",
      storedInRepository: false,
      tokenRecordedInReceipt: false,
      removedWithClusters: true,
    },
  };
}

function bootstrapProfileName(cluster) {
  return `sveltos-env-rollout-${cluster}-bootstrap`;
}

// One bootstrap profile per workload Space, applied once as cluster setup. It
// selects the management cluster and points at that cluster's Space on the
// gateway. Promotion never touches it: publishing a release moves the tag, and
// Sveltos follows on its interval.
function bootstrapProfileManifest(cluster, space) {
  return `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: ${bootstrapProfileName(cluster)}
spec:
  clusterSelector:
    matchLabels:
      role: management
  policyRefs:
    - deploymentType: Remote
      remoteURL:
        url: ${gatewayReference(space)}
        interval: ${remoteFetchInterval}
        secretRef:
          name: ${gatewaySecretName}
          namespace: ${registrationNamespace}
`;
}

// The reviewed management record is applied out of band, which is the one step
// that cannot come through the gateway, because it is what opens the gateway
// path in the first place.
function applyBootstrapProfiles({ managementKubeconfig, workRoot, profiles }) {
  const profilePath = join(workRoot, "bootstrap-clusterprofiles.yaml");
  writeFileSync(
    profilePath,
    profiles
      .map((row) => bootstrapProfileManifest(row.cluster, row.space))
      .join("---\n"),
    { mode: 0o600 },
  );
  clusterCommand(managementKubeconfig, ["apply", "-f", profilePath]);
  return {
    profiles,
    interval: remoteFetchInterval,
    deploymentType: "Remote",
    clusterSelector: { role: "management" },
    secret: { name: gatewaySecretName, namespace: registrationNamespace },
    appliedWith: "kubectl as management-cluster setup",
    changedByPromotion: false,
  };
}

// An addon controller without the gzip fix reads the gateway's gzipped layer as
// YAML and stops on the binary noise. The runner names that failure, because
// the decoder error on its own says nothing about which build to run.
function looksLikeGzipDecodeFailure(message) {
  const text = String(message ?? "");
  return /failed to decode k8s resource/i.test(text)
    && (/control characters are not allowed/i.test(text)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text));
}

// Convergence on the workload clusters is proved by the per-cluster
// observations. This confirms the one step before it: the management cluster
// fetched the release from the gateway and the reviewed profile arrived.
function waitForRemoteDeploy({
  managementKubeconfig,
  managementName,
  cluster,
  profileName: reviewedProfile,
  expectedDoc,
  release,
  attempts = 90,
}) {
  const profileName = bootstrapProfileName(cluster);
  let last = { status: "missing", reason: "no ClusterSummary observed" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const summaries = clusterTry(managementKubeconfig, [
      "get", "clustersummaries", "-A", "-o", "json",
    ]);
    if (summaries.ok) {
      const items = JSON.parse(summaries.output).items ?? [];
      const summary = items.find((item) =>
        item.metadata?.labels?.["projectsveltos.io/cluster-profile-name"]
        === profileName);
      const feature = (summary?.status?.featureSummaries ?? [])
        .find((row) => row.featureID === "Resources");
      if (feature) {
        const failureMessage = String(feature.failureMessage ?? "");
        last = {
          status: String(feature.status ?? "missing"),
          reason: sanitizeError(failureMessage) || "none",
        };
        check(
          !looksLikeGzipDecodeFailure(failureMessage),
          `the addon controller could not read the ${cluster} release: it decoded gzipped bytes as YAML. The gateway serves each release as a gzipped tar layer, so this run needs an addon controller that gunzips. Set SVELTOS_ADDON_CONTROLLER_IMAGE to that build and see ${probeRecord}.`,
        );
        check(
          feature.status !== "Failed",
          `the ${cluster} bootstrap profile failed to apply the fetched release: ${last.reason}`,
        );
      }
      if (last.status === "Provisioned") {
        const live = clusterTry(managementKubeconfig, [
          "get", "clusterprofile", reviewedProfile, "-o", "json",
        ]);
        if (live.ok && sourceFieldsMatchLive(expectedDoc, JSON.parse(live.output))) {
          return {
            result: "pass",
            profile: profileName,
            cluster: managementName,
            reviewedProfile,
            reference: release.reference,
            releaseManifestDigest: release.manifestDigest,
            interval: remoteFetchInterval,
            status: last.status,
            profileMatchesApprovedRevision: true,
          };
        }
        last = {
          status: last.status,
          reason: `${reviewedProfile} has not arrived from the gateway yet`,
        };
      }
    }
    sleep(5000);
  }
  return {
    result: "fail",
    profile: profileName,
    cluster: managementName,
    reviewedProfile,
    reference: release.reference,
    releaseManifestDigest: release.manifestDigest,
    reason: `status=${last.status}; detail=${last.reason}`,
  };
}

// The management cluster is itself registered with Sveltos, so a bootstrap
// profile can hand it each release the gateway serves. The registration
// mirrors the workload pattern: a service account on the target, a short-lived
// token, and a kubeconfig Secret the controller reads.
function registerManagementCluster({
  managementKubeconfig,
  managementName,
  workRoot,
}) {
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
    clusterCommand(managementKubeconfig, [
      "config", "view", "--raw", "-o", "json",
    ]).output,
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
  const registrationPath = join(
    workRoot,
    "management-sveltos-registration.yaml",
  );
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
  name: ${managementClusterRecord}
  namespace: ${registrationNamespace}
  labels:
    role: management
spec: {}
`, { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", registrationPath]);
  const observed = waitForRegistration(managementKubeconfig, managementClusterRecord);
  check(
    observed.ready,
    `Sveltos did not register the management cluster: ${observed.reason}`,
  );
  return {
    method: "programmatic SveltosCluster registration of the management cluster",
    namespace: registrationNamespace,
    cluster: managementClusterRecord,
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

function installSveltos({
  managementKubeconfig,
  workRoot,
  sveltos,
  addonControllerImage,
}) {
  const manifestPath = join(workRoot, "sveltos-manifest.yaml");
  command("curl", ["-fsSL", sveltos.manifestUrl, "-o", manifestPath], {
    timeout: 180_000,
  });
  const downloaded = readFileSync(manifestPath, "utf8");
  // The pin covers the bytes upstream published, so it is checked before the
  // image substitution rewrites any of them.
  check(
    sha256(downloaded) === sveltos.manifestSha256,
    "the downloaded Sveltos manifest differs from the source lock",
  );
  const pinnedImage = `${addonControllerRepository}:${sveltos.version}`;
  const overridden = addonControllerImage !== pinnedImage;
  // The substitution matches whole image lines. A plain string replacement
  // would also fire inside a longer tag, and the build carrying the gzip fix
  // is the pinned tag with a suffix.
  const pinnedImageLines = (text) => text.match(imageLinePattern(pinnedImage)) ?? [];
  const substitutedLines = pinnedImageLines(downloaded).length;
  check(
    substitutedLines > 0,
    `the pinned manifest does not run ${pinnedImage}, so the run cannot say which addon controller it installed`,
  );
  const manifestText = overridden
    ? downloaded.replace(
      imageLinePattern(pinnedImage),
      (line) => line.replace(pinnedImage, addonControllerImage),
    )
    : downloaded;
  check(
    !overridden || pinnedImageLines(manifestText).length === 0,
    `the addon controller image override left ${pinnedImage} in the manifest`,
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
  const deployments = waitForExactDeployments({
    managementKubeconfig,
    namespace: registrationNamespace,
    timeoutAttempts: 120,
    pollSeconds: 3,
  });
  check(
    deployments.length > 0,
    "the Sveltos management namespace contains no deployments",
  );
  return {
    source: sveltos.manifestUrl,
    version: sveltos.version,
    manifestSha256: sveltos.manifestSha256,
    addonControllerImage,
    pinnedAddonControllerImage: pinnedImage,
    addonControllerImageOverridden: overridden,
    addonControllerImageLines: substitutedLines,
    objectCount: documents.length,
    crdCount: crds.length,
    appliedObjectCount: crds.length + resources.length,
    omittedOptionalServiceMonitorCount: serviceMonitors.length,
    deployments,
    installationMethod: "pinned manifest applied as a management-cluster prerequisite",
  };
}

// A manifest names each container image on its own line, so the whole line is
// the unit of substitution.
function imageLinePattern(image) {
  const literal = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^([ \\t]*)image:[ \\t]*${literal}[ \\t]*$`, "gm");
}

function waitForExactDeployments({
  managementKubeconfig,
  namespace,
  timeoutAttempts,
  pollSeconds,
}) {
  let deployments = [];
  for (let attempt = 0; attempt < timeoutAttempts; attempt += 1) {
    deployments = JSON.parse(
      clusterCommand(managementKubeconfig, [
        "-n", namespace, "get", "deployments", "-o", "json",
      ]).output,
    ).items.map((deployment) => ({
      name: deployment.metadata.name,
      desired: Number(deployment.spec?.replicas ?? 0),
      updated: Number(deployment.status?.updatedReplicas ?? 0),
      ready: Number(deployment.status?.readyReplicas ?? 0),
      available: Number(deployment.status?.availableReplicas ?? 0),
      observedGenerationMatches:
        deployment.status?.observedGeneration === deployment.metadata?.generation,
    })).sort((left, right) => left.name.localeCompare(right.name));
    if (
      deployments.length > 0
      && deployments.every(
        (deployment) =>
          deployment.desired === deployment.updated
          && deployment.desired === deployment.ready
          && deployment.desired === deployment.available
          && deployment.observedGenerationMatches,
      )
    ) {
      return deployments;
    }
    sleep(pollSeconds * 1000);
  }
  throw new Error(
    `Sveltos management deployments did not converge: ${JSON.stringify(deployments)}`,
  );
}

// Every cluster in the fleet, management included, is built the same way and
// keeps its own kubeconfig inside the run's scratch tree.
function createCluster(name, kubeconfigPath) {
  command("kind", [
    "create", "cluster",
    "--name", name,
    "--kubeconfig", kubeconfigPath,
    "--wait", "180s",
  ], { timeout: 420_000 });
}

// Each workload cluster gains a unique addressing label, so one record can
// address one cluster. The environment label stays as a grouping label, which
// is what a wave selects on.
function registerWorkload({
  managementKubeconfig,
  workloadName,
  workloadKubeconfig,
  workRoot,
  logicalCluster,
  environment,
}) {
  check(
    environments.includes(environment),
    `unsupported environment label ${environment}`,
  );
  check(
    typeof logicalCluster === "string" && logicalCluster.length > 0,
    "a workload registration needs the stable logical cluster name",
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
    "create", "token", "sveltos-manager", "--duration=2h",
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
    cluster: ${logicalCluster}
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
    logicalCluster,
    labels: {
      cluster: logicalCluster,
      environment,
      "sveltos-agent": "present",
    },
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

// Every cluster this run touches is addressed by its own kubeconfig, so the
// same two helpers serve the management cluster and the workload clusters.
function clusterCommand(kubeconfig, args, options = {}) {
  return command("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function clusterTry(kubeconfig, args, options = {}) {
  return tryCommand("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function helmCommand(kubeconfig, args, options = {}) {
  return command("helm", ["--kubeconfig", kubeconfig, ...args], options);
}

function clusterPresent(name) {
  const result = tryCommand("kind", ["get", "clusters"]);
  return result.ok && result.output.split(/\r?\n/).includes(name);
}

function spacePresent(context, space) {
  return cubTry(context, ["space", "get", space, "-o", "json"]).ok;
}

function getByRef(context, entity, ref) {
  const [space, slug] = ref.split("/");
  return cubJson(context, [entity, "get", "--space", space, slug, "-o", "json"]);
}

function storedData(unit) {
  check(unit.Data, `${unit.SpaceSlug}/${unit.Slug} has no stored data`);
  return Buffer.from(unit.Data, "base64").toString("utf8");
}

function approvalCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value ? 1 : 0;
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

function sourceFieldsMatchLive(source, live) {
  const canonicalSource = canonicalValue(source);
  const canonicalLive = canonicalValue(live);
  return JSON.stringify(projectToShape(canonicalLive, canonicalSource))
    === JSON.stringify(canonicalSource);
}

function projectToShape(actual, shape) {
  if (Array.isArray(shape)) {
    if (!Array.isArray(actual)) return actual;
    return shape.map((item, index) => projectToShape(actual[index], item));
  }
  if (!shape || typeof shape !== "object") return actual;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return actual;
  }
  return Object.fromEntries(
    Object.keys(shape).map(
      (key) => [key, projectToShape(actual[key], shape[key])],
    ),
  );
}

// ConfigHub reports what it can still merge from the base as a mutation list.
// A variant that kept its lineage shows one resource carrying field-level
// updates. A variant that lost it shows the base resource deleted and a
// different resource added, and from then on no change to the base can reach
// it. The failure is silent at the point it happens and only surfaces waves
// later as a promotion that reported success without landing, so the lineage is
// checked the moment the departures are stored.
function assertUpstreamLineage(context, space, cluster) {
  const mutations = cub(context, [
    "unit", "get", "--space", space, policyUnit, "-o", "mutations",
  ]).replace(/\[[0-9;]*m/g, "");
  const resources = [...mutations.matchAll(/^Resource: /gm)].length;
  const deleted = /\[Delete\]/.test(mutations);
  check(
    resources === 1 && !deleted,
    `${cluster} lost its upstream lineage when its departures were stored: ConfigHub tracks ${resources} resources${deleted ? " and records the base resource as deleted" : ""}, so no later change to the base can merge into it`,
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

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
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

// A departure may add a field the base never carried, so the writer can create
// the map on the way down when the caller asks for it.
function writePath(value, path, next, createMissing = false) {
  const keys = path.split(".");
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (createMissing && !(current[key] && typeof current[key] === "object")) {
      current[key] = {};
    }
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

function cub(context, args, options = {}) {
  return command("cub", args, {
    ...options,
    env: cubEnvironment(context),
  }).output;
}

function cubTry(context, args, options = {}) {
  return tryCommand("cub", args, {
    ...options,
    env: cubEnvironment(context),
  });
}

function cubJson(context, args, options = {}) {
  return JSON.parse(cub(context, args, options));
}

function cubEnvironment(context) {
  return {
    ...process.env,
    CONFIGHUB_AGENT: "1",
    CUB_CONTEXT: context,
  };
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
  console.log(`[sveltos-env-rollout] ${message}`);
}
function selfTest() {
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-self-test-"));
  const realRunner = commandRunner;
  const realSleeper = sleeper;
  const realTime = timeSource;
  const policyContext = "self-test-policy";
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const managementName = "hx-sveltos-envmgmt-selftest";
  const runId = "20260812091500";
  try {
    let clockMs = 0;
    const hub = createFakeConfigHub();
    const cluster = createFakeManagementCluster(hub);
    const download = { bytes: "self-test-sveltos-manifest" };
    commandRunner = (file, args, options = {}) => {
      if (file === "cub") return hub.handle(args, options);
      if (file === "kubectl") return cluster.handle(args, options);
      if (file === "curl") {
        writeFileSync(args[args.indexOf("-o") + 1], download.bytes);
        return { ok: true, status: 0, output: "", error: "" };
      }
      return {
        ok: false,
        status: 1,
        output: "",
        error: `the self-test fake surface refuses ${file}`,
      };
    };
    sleeper = (milliseconds) => {
      clockMs += milliseconds;
      hub.tick();
      cluster.tick();
    };
    timeSource = () => clockMs;

    const plan = loadRolloutPlan();

    // A live run cost two fleet builds to learn this: the baseline gives every
    // cluster its first install, so a checkpoint that only waits for the
    // cluster matching completedWaves gives all of them the holding budget and
    // can never pass. The waves are numbered from one, so nothing ever equals
    // zero.
    check(
      convergenceAttempts(1, 0) === convergenceWaitAttempts
        && convergenceAttempts(2, 0) === convergenceWaitAttempts
        && convergenceAttempts(3, 0) === convergenceWaitAttempts,
      "the baseline checkpoint must let every cluster converge",
    );
    check(
      convergenceAttempts(1, 1) === convergenceWaitAttempts
        && convergenceAttempts(2, 1) === holdingCheckAttempts
        && convergenceAttempts(3, 1) === holdingCheckAttempts,
      "after a wave, only the promoted clusters converge and the others must hold",
    );
    check(
      convergenceWaitAttempts * 4 >= 150,
      "the convergence budget must cover a first Kyverno install, which takes over a minute",
    );

    // One record per cluster, each addressing its own cluster and departing
    // from the base in a field the reviewed change never writes.
    check(
      plan.clusters.length === 4
        && plan.clusters.every((row) =>
          row.baselineDoc.spec.clusterSelector.matchLabels.cluster === row.cluster
          && Object.keys(row.baselineDoc.spec.clusterSelector.matchLabels).length === 1)
        && new Set(plan.clusters.map((row) => row.space)).size === 4
        && new Set(plan.clusters.map((row) => row.profileName)).size === 4,
      "the plan must hold one single-cluster variant per workload cluster",
    );
    for (const row of plan.clusters) {
      check(
        row.revisions.baseline.startsWith("r1-")
          && row.revisions.changed.startsWith("r2-")
          && row.departurePaths.length >= 3
          && readPath(row.baselineDoc, "spec.stopMatchingBehavior")
          === row.departures["spec.stopMatchingBehavior"]
          && readPath(valuesOf(row.changedDoc), plan.change.spec.valuesPath)
          === plan.change.spec.after
          && readPath(row.changedDoc, "spec.stopMatchingBehavior")
          === row.departures["spec.stopMatchingBehavior"],
        `the ${row.cluster} variant lost its departures or its inherited change`,
      );
    }
    check(
      plan.waves.map((wave) => wave.clusters.length).join(",") === "1,1,2",
      "wave three must carry both production clusters",
    );

    // The collision rule, from the recorded finding: same field, and different
    // keys of the same map of scalars.
    check(
      fieldsCollide(
        "spec.helmCharts.0.values",
        "spec.helmCharts.0.values",
        plan.base.doc,
      )
        && fieldsCollide(
          "spec.helmCharts.0.values.admissionController.replicas",
          "spec.helmCharts.0.values",
          plan.base.doc,
        )
        && fieldsCollide(
          "spec.clusterSelector.matchLabels.cluster",
          "spec.clusterSelector.matchLabels.environment",
          plan.base.doc,
        )
        && !fieldsCollide(
          "spec.stopMatchingBehavior",
          "spec.helmCharts.0.values",
          plan.base.doc,
        ),
      "the departure collision rule changed",
    );
    expectFailure(
      () => loadRolloutPlan(tamperedExampleRoot(workRoot, "collision", (text) =>
        text.replace(
          "        spec.stopMatchingBehavior: WithdrawPolicies\n    - cluster: hx-sveltos-env-staging",
          "        spec.helmCharts.0.values: the whole values document\n    - cluster: hx-sveltos-env-staging",
        ))),
      /departs on spec\.helmCharts\.0\.values, which the reviewed change also writes/,
      "departure collision refusal",
    );
    expectFailure(
      () => loadRolloutPlan(tamperedExampleRoot(workRoot, "fanout", (text) =>
        text.replace(
          "        spec.clusterSelector.matchLabels.cluster: hx-sveltos-env-prod-a",
          "        spec.clusterSelector.matchLabels.environment: prod",
        ))),
      /must depart on its own selector/,
      "environment selector refusal",
    );
    expectFailure(
      () => loadRolloutPlan(tamperedExampleRoot(workRoot, "shared-space", (text) =>
        text.replace(
          "      space: sveltos-kyverno-env-prod-b",
          "      space: sveltos-kyverno-env-prod-a",
        ))),
      /belong to one record/,
      "shared Space refusal",
    );
    expectFailure(
      () => loadRolloutPlan(tamperedExampleRoot(workRoot, "addressing-only", (text) =>
        text.replace(
          "        spec.stopMatchingBehavior: WithdrawPolicies\n    - cluster: hx-sveltos-env-staging",
          "    - cluster: hx-sveltos-env-staging",
        ))),
      /at least one field beyond addressing/,
      "addressing-only variant refusal",
    );

    // The pin this chapter reads, and the controller image rule the gateway
    // forces on top of it.
    const sveltos = loadSveltosPin();
    const pinnedImage = `${addonControllerRepository}:${sveltos.version}`;
    check(
      sveltos.version === "v1.13.0"
        && sveltos.manifestUrl.includes(sveltos.version)
        && /^[0-9a-f]{64}$/.test(sveltos.manifestSha256),
      "the chapter three Sveltos pin lost its shape",
    );
    check(
      resolveAddonControllerImage(sveltos) === pinnedImage,
      "the default addon controller image no longer follows the pin",
    );
    expectFailure(
      () => installSveltos({
        managementKubeconfig,
        workRoot,
        sveltos,
        addonControllerImage: pinnedImage,
      }),
      /differs from the source lock/,
      "sveltos pin refusal",
    );

    // A small pinned manifest exercises the install path and the image
    // override without downloading twenty thousand lines.
    const overrideImage = `${addonControllerRepository}:v1.13.0-ch`;
    download.bytes = fakeSveltosManifest(pinnedImage);
    const syntheticPin = {
      version: sveltos.version,
      manifestUrl: sveltos.manifestUrl,
      manifestSha256: sha256(download.bytes),
    };
    const installed = installSveltos({
      managementKubeconfig,
      workRoot,
      sveltos: syntheticPin,
      addonControllerImage: overrideImage,
    });
    // The applied documents are written as JSON, so the quoted value is the
    // whole image reference and a longer tag cannot pass for the pinned one.
    check(
      installed.addonControllerImage === overrideImage
        && installed.addonControllerImageOverridden === true
        && installed.pinnedAddonControllerImage === pinnedImage
        && installed.addonControllerImageLines === 2
        && cluster.appliedText().includes(`"${overrideImage}"`)
        && !cluster.appliedText().includes(`"${pinnedImage}"`),
      "the addon controller image override did not reach the applied manifest",
    );
    download.bytes = fakeSveltosManifest("docker.io/projectsveltos/other:v1");
    expectFailure(
      () => installSveltos({
        managementKubeconfig,
        workRoot,
        sveltos: {
          ...syntheticPin,
          manifestSha256: sha256(download.bytes),
        },
        addonControllerImage: overrideImage,
      }),
      /does not run docker\.io\/projectsveltos\/addon-controller/,
      "unknown addon controller image refusal",
    );

    // The two constraints the gateway imposes, starting with lowercase names.
    check(
      gatewayReference("hx-sveltos-env-pilot-20260812")
        === "oci://oci.hub.confighub.com/space/hx-sveltos-env-pilot-20260812:latest",
      "the gateway reference changed shape",
    );
    check(
      spaceName(`hx-sveltos-env-pilot-${safeRunId("2026-08-12T09:15:00Z")}`)
        === "hx-sveltos-env-pilot-20260812091500",
      "the run identifier no longer produces a lowercase Space name",
    );
    expectFailure(
      () => gatewayReference("HX-Sveltos-Env-Pilot"),
      /OCI repository names are lowercase/,
      "uppercase gateway reference refusal",
    );
    expectFailure(
      () => createPolicySpace(policyContext, "HX-Sveltos-Env-Pilot"),
      /OCI repository names are lowercase/,
      "uppercase Space creation refusal",
    );

    // The registrations the gateway path stands on: each workload cluster by
    // its own addressing label, and the management cluster by its role.
    const registrations = plan.clusters.map((row) =>
      registerWorkload({
        managementKubeconfig,
        workloadName: `${row.cluster}-${runId}`,
        workloadKubeconfig: join(workRoot, `${row.cluster}.kubeconfig`),
        workRoot,
        logicalCluster: row.cluster,
        environment: row.environment,
      }));
    check(
      registrations.every((registration, index) =>
        registration.labels.cluster === plan.clusters[index].cluster
        && registration.labels.environment === plan.clusters[index].environment
        && registration.ready === true
        && registration.credential.storedInRepository === false)
        && new Set(registrations.map((row) => row.labels.cluster)).size === 4,
      "the workload registrations lost their addressing labels",
    );
    const managementRegistration = registerManagementCluster({
      managementKubeconfig,
      managementName,
      workRoot,
    });
    check(
      managementRegistration.cluster === managementClusterRecord
        && managementRegistration.labels.role === "management"
        && managementRegistration.ready === true,
      "the management registration record changed",
    );

    // The Secret the fetcher requires, and the token it must never leak.
    const selfTestToken = `self-test-gateway-token-${"a".repeat(48)}`;
    const secretManifest = gatewayTokenSecretManifest(selfTestToken);
    check(
      secretManifest.includes(`type: ${gatewaySecretType}`)
        && !secretManifest.includes("type: Opaque")
        && secretManifest.includes(`${gatewaySecretKey}: `)
        && !secretManifest.includes(selfTestToken),
      "the gateway token Secret lost its required type or carried the token in the clear",
    );
    expectFailure(
      () => gatewayTokenSecretManifest(selfTestToken, "Opaque"),
      /cluster-profile type/,
      "Opaque gateway Secret refusal",
    );
    expectFailure(
      () => gatewayTokenSecretManifest(""),
      /no usable gateway token/,
      "empty gateway token refusal",
    );
    check(
      sanitizeError(`token: ${selfTestToken}`).includes("<redacted")
        && !sanitizeError(`token: ${selfTestToken}`).includes(selfTestToken),
      "the error redaction no longer covers the gateway token",
    );
    const gatewayCredential = applyGatewayTokenSecret({
      policyContext,
      managementKubeconfig,
      workRoot,
    });
    check(
      gatewayCredential.secret.type === gatewaySecretType
        && gatewayCredential.secret.key === gatewaySecretKey
        && gatewayCredential.secret.tokenRecordedInReceipt === false,
      "the gateway credential record changed",
    );

    // One bootstrap profile per workload Space, each addressing its own Space.
    const bootstrapSample = bootstrapProfileManifest(
      "hx-sveltos-env-pilot",
      "self-test-pilot",
    );
    check(
      bootstrapSample.includes("deploymentType: Remote")
        && bootstrapSample.includes(`url: ${gatewayReference("self-test-pilot")}`)
        && bootstrapSample.includes(`interval: ${remoteFetchInterval}`)
        && bootstrapSample.includes("role: management")
        && bootstrapSample.includes(`name: ${gatewaySecretName}`)
        && bootstrapSample.includes(`namespace: ${registrationNamespace}`),
      "the bootstrap profile lost its remote fetch contract",
    );

    const topology = readApprovalTopology(policyContext);
    const catalogTarget = { TargetID: hub.catalogTargetId, ProviderType: "OCI" };

    // The gate preflight is the gate preflight: it must pass when the
    // gate materializes and refuse fast, naming the issue, when it never does.
    assertApprovalGateObservable(policyContext, "20260807000000", topology, catalogTarget);
    check(
      !spacePresent(policyContext, "hx-sveltos-env-probe-20260807000000"),
      "the gate preflight did not delete its probe Space",
    );
    hub.state.neverPopulateGates = true;
    expectFailure(
      () => assertApprovalGateObservable(policyContext, "20260807000001", topology, catalogTarget),
      /the approval gate never appeared on the probe Unit .*; check the Space wiring before building the fleet/,
      "gate preflight refusal",
    );
    check(
      !spacePresent(policyContext, "hx-sveltos-env-probe-20260807000001"),
      "the refused gate preflight did not delete its probe Space",
    );
    hub.state.neverPopulateGates = false;

    // The whole path: one base record, four variants cloned from it, the
    // management record, one set approval for the baseline, delivery through
    // the gateway, one change on the base, and three waves of set promotion.
    const policySpacesCreated = new Set();
    const baseSpace = spaceName(`hx-sveltos-env-base-${runId}`);
    const spaceFor = Object.fromEntries([
      ...plan.clusters.map((row) => [row.cluster, spaceName(`${row.cluster}-${runId}`)]),
      [plan.management.cluster, spaceName(`${plan.management.cluster}-${runId}`)],
    ]);
    const baseRecord = establishBase({
      policyContext,
      space: baseSpace,
      plan,
      topology,
      catalogTarget,
      runId,
      policySpacesCreated,
    });
    check(
      baseRecord.published === false
        && baseRecord.target === "none"
        && baseRecord.revisionId === plan.base.revisions.baseline,
      "the base record must be stored without a target and without a release",
    );
    const variantRecords = {};
    for (const row of plan.clusters) {
      variantRecords[row.cluster] = establishVariant({
        policyContext,
        space: spaceFor[row.cluster],
        baseSpace,
        cluster: row,
        topology,
        catalogTarget,
        runId,
        workRoot,
        policySpacesCreated,
      });
    }
    check(
      plan.clusters.every((row) =>
        variantRecords[row.cluster].upstream.space === baseSpace
        && variantRecords[row.cluster].upstream.unitLinked === true
        && variantRecords[row.cluster].selector.cluster === row.cluster),
      "every variant must be linked to the base and address its own cluster",
    );
    // A variant can be linked to the base and still be unable to inherit from
    // it. When ConfigHub reports the base resource deleted and a different one
    // added, every later promotion is a no-op that still reports success, and
    // the symptom appears waves away from the cause. The guard must refuse at
    // the point the departures are stored.
    hub.state.severUpstreamLineage = true;
    expectFailure(
      () => assertUpstreamLineage(
        policyContext,
        spaceFor[plan.clusters[0].cluster],
        plan.clusters[0].cluster,
      ),
      /lost its upstream lineage when its departures were stored/,
      "severed upstream lineage refusal",
    );
    hub.state.severUpstreamLineage = false;
    hub.state.refuseUpstreamLink = true;
    expectFailure(
      () => establishVariant({
        policyContext,
        space: spaceName(`self-test-unlinked-${runId}`),
        baseSpace,
        cluster: plan.clusters[0],
        topology,
        catalogTarget,
        runId,
        workRoot,
        policySpacesCreated: new Set(),
      }),
      /records no upstream unit, so it is a copy rather than a variant/,
      "unlinked variant refusal",
    );
    hub.state.refuseUpstreamLink = false;
    // The refused clone carries this run's labels, so it would join the set a
    // wave query selects. A live run stops on that refusal; the self-test walks
    // on, so it removes the record the refusal left behind.
    cubTry(policyContext, [
      "space", "delete", spaceName(`self-test-unlinked-${runId}`),
      "--recursive-force", "--quiet",
    ]);

    const managementVariant = establishManagement({
      policyContext,
      space: spaceFor[plan.management.cluster],
      plan,
      topology,
      catalogTarget,
      runId,
      workRoot,
      policySpacesCreated,
      workloadSpaces: plan.clusters.map((row) => ({
        cluster: row.cluster,
        space: spaceFor[row.cluster],
      })),
    });
    // The component view groups Spaces by Component and files them under
    // Owner. A run whose Spaces lack those labels is invisible in the one view
    // that shows a base and its per-cluster variants together, so the labels
    // are part of the record rather than something added by hand afterwards.
    check(
      [baseSpace, ...Object.values(spaceFor)].every((space) => {
        const labels = hub.spaceLabels(space) ?? {};
        return labels.Component === componentLabel
          && labels.Owner === ownerLabel;
      }),
      `every Space the run creates must carry its Component and Owner labels; missing on ${[baseSpace, ...Object.values(spaceFor)].filter((space) => { const l = hub.spaceLabels(space) ?? {}; return l.Component !== componentLabel || l.Owner !== ownerLabel; }).join(", ") || "none"}`,
    );
    check(
      managementVariant.bootstrapProfiles.length === 4
        && new Set(managementVariant.bootstrapProfiles.map((row) => row.reference))
          .size === 4
        && managementVariant.boundary.firstRevisionDeliveredThroughGateway === false,
      "the management record must hold one bootstrap profile per workload Space",
    );

    // The set query is the wave. It must match the wave and nothing else.
    const stagingQuery = waveQuery(plan, runId, "staging");
    check(
      stagingQuery.includes(runId) && stagingQuery.includes("staging"),
      "the wave query no longer names the run and the group",
    );
    expectFailure(
      () => selectSet({
        policyContext,
        stageName: "empty wave",
        query: waveQuery(plan, "20990101000000", "staging"),
        expectedUnits: [`${spaceFor["hx-sveltos-env-staging"]}/${policyUnit}`],
      }),
      /matched no unit/,
      "empty query refusal",
    );
    expectFailure(
      () => selectSet({
        policyContext,
        stageName: "over-broad wave",
        query: baselineQuery(plan, runId),
        expectedUnits: [`${spaceFor["hx-sveltos-env-staging"]}/${policyUnit}`],
      }),
      /refusing to approve a set that is not the wave/,
      "over-broad query refusal",
    );
    expectFailure(
      () => selectSet({
        policyContext,
        stageName: "wrong group",
        query: waveQuery(plan, runId, "prod"),
        expectedUnits: [`${spaceFor["hx-sveltos-env-staging"]}/${policyUnit}`],
      }),
      /refusing to approve a set that is not the wave/,
      "outside-the-wave query refusal",
    );

    const baselineSet = reviewSet({
      policyContext,
      stageName: "baseline",
      query: baselineQuery(plan, runId),
      members: [
        ...plan.clusters.map((row) => ({
          cluster: row.cluster,
          space: spaceFor[row.cluster],
          expectedDocs: [row.baselineDoc],
          revisionId: row.revisions.baseline,
        })),
        {
          cluster: plan.management.cluster,
          space: spaceFor[plan.management.cluster],
          expectedDocs: managementVariant.documents,
          revisionId: managementVariant.revisionId,
          publishesRelease: false,
        },
      ],
    });
    check(
      baselineSet.selection.matched.length === 5
        && baselineSet.approval.recordedApprovals === 5
        && baselineSet.approval.appliedAsOneOperation === true,
      "the baseline must be approved as one set operation over five records",
    );
    for (const row of plan.clusters) {
      variantRecords[row.cluster].baseline = baselineSet.records[row.cluster];
    }
    managementVariant.baseline = baselineSet.records[plan.management.cluster];

    const bootstrap = applyBootstrapProfiles({
      managementKubeconfig,
      workRoot,
      profiles: managementVariant.bootstrapProfiles,
    });
    for (const row of plan.clusters) {
      const delivery = waitForRemoteDeploy({
        managementKubeconfig,
        managementName,
        cluster: row.cluster,
        profileName: row.profileName,
        expectedDoc: row.baselineDoc,
        release: variantRecords[row.cluster].baseline.release,
      });
      check(
        delivery.result === "pass" && delivery.status === "Provisioned",
        `the ${row.cluster} baseline did not arrive from the gateway`,
      );
      assertLiveProfileMatches({
        managementKubeconfig,
        profileName: row.profileName,
        expectedDoc: row.baselineDoc,
      });
      variantRecords[row.cluster].baseline.delivery = delivery;
    }

    const baseChange = changeBaseRecord({
      policyContext,
      space: baseSpace,
      plan,
      workRoot,
    });
    check(
      baseChange.revisionId === plan.base.revisions.changed
        && baseChange.publishedAsRelease === false,
      "the base change record changed",
    );

    // The trap: when the merge hands back the variant's own content, the wave
    // is refused rather than recorded as promoted.
    hub.state.mergeKeepsDepartureOnly = true;
    expectFailure(
      () => promoteWave({
        policyContext,
        managementKubeconfig,
        managementName,
        wave: plan.waves[0],
        plan,
        spaceFor,
        runId,
        variantRecords,
      }),
      /did not come out of the upgrade as the reviewed merge: inheritedTheChange=false/,
      "silent departure win refusal",
    );
    hub.state.mergeKeepsDepartureOnly = false;
    hub.restoreVariantBaselines();

    const waveRecords = [];
    for (const wave of plan.waves) {
      waveRecords.push(promoteWave({
        policyContext,
        managementKubeconfig,
        managementName,
        wave,
        plan,
        spaceFor,
        runId,
        variantRecords,
      }));
    }
    check(
      waveRecords.map((wave) => wave.clusters.length).join(",") === "1,1,2"
        && waveRecords[2].approval.recordedApprovals === 2
        && waveRecords[2].clusters.every((row) => row.recordedApprovals === 1)
        && new Set(waveRecords[2].clusters.map((row) => row.revisionId)).size === 2
        && new Set(waveRecords[2].clusters.map((row) => row.releaseManifestDigest))
          .size === 2,
      "wave three must approve both production variants separately from one operation",
    );
    const walkDigests = [];
    for (const row of plan.clusters) {
      const record = variantRecords[row.cluster];
      walkDigests.push(
        record.baseline.release.manifestDigest,
        record.changed.release.manifestDigest,
      );
      check(
        record.baseline.delivery.result === "pass"
          && record.changed.delivery.result === "pass"
          && record.changed.delivery.profileMatchesApprovedRevision === true
          && record.baseline.release.reference === gatewayReference(record.space),
        `the ${row.cluster} walk did not deliver both revisions through the gateway`,
      );
    }
    check(
      new Set(walkDigests).size === walkDigests.length,
      "each published release must carry its own manifest digest",
    );

    // The failure an addon controller without the gzip fix produces.
    check(
      looksLikeGzipDecodeFailure(gzipDecodeFailureMessage())
        && looksLikeGzipDecodeFailure(gzipDecodeFailureMessage(false))
        && !looksLikeGzipDecodeFailure("the reviewed profile is missing"),
      "the gzip failure detector no longer recognizes the un-fixed controller",
    );
    cluster.state.failureMode = "gzip";
    cluster.tick();
    expectFailure(
      () => waitForRemoteDeploy({
        managementKubeconfig,
        managementName,
        cluster: plan.clusters[0].cluster,
        profileName: plan.clusters[0].profileName,
        expectedDoc: plan.clusters[0].changedDoc,
        release: variantRecords[plan.clusters[0].cluster].changed.release,
        attempts: 2,
      }),
      /addon controller that gunzips/,
      "gzip fetch refusal",
    );
    cluster.state.failureMode = null;
    cluster.tick();

    // A publish can land while the server is still evaluating an apply gate.
    // The server says the triggers were re-queued, and only that message may
    // be waited out. A gate that refuses must still stop the run, so the two
    // messages are told apart here rather than by a substring that matches
    // both.
    check(
      pendingApplyGate(
        "Failed: HTTP 422 for req tWgw: outstanding ApplyGates; triggers"
          + " re-queued for evaluation Metadata: Apply Gates:"
          + " platform/vet-schemas/vet-schemas",
      ),
      "the re-queued apply-gate message was not recognised as transient",
    );
    check(
      !pendingApplyGate(
        "Failed: HTTP 422 for req tWgw: outstanding ApplyGates Metadata:"
          + " Apply Gates: platform/vet-schemas/vet-schemas",
      ),
      "a refusing apply gate was mistaken for a transient re-queue",
    );

    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      topology,
      catalogTarget,
      managementName,
      managementRegistration,
      sveltosInstall: fakeSveltosInstall(sveltos, overrideImage),
      gatewayCredential,
      registrations,
      baseRecord,
      baseChange,
      baselineSet,
      variantRecords,
      managementVariant,
      bootstrap,
      waveRecords,
      checkpoints: synthesizeCheckpoints(plan),
      convergenceAudit: synthesizeAudit(plan),
      cleanup: removedCleanup(),
    });
    verifyReceipt(receipt);
    const summary = renderSummary(receipt);
    check(
      summary.includes(
        receipt.spec.variants[3].records[1].release.manifestDigest,
      )
        && summary.includes(`oci://${configHubOciHost}/space/`)
        && summary.includes(overrideImage)
        && summary.includes("Convergence audit"),
      "the rendered summary lost its evidence",
    );

    // The keep-alive flag leaves the record honest rather than reading as a
    // failed cleanup, and it still has to say what it left and how to remove it.
    const kept = structuredClone(receipt);
    kept.spec.cleanup = keptCleanup();
    verifyReceipt(kept);
    check(
      renderSummary(kept).includes("Artifacts kept deliberately"),
      "a kept run must say so in its summary",
    );
    const keptWithoutCommands = structuredClone(kept);
    keptWithoutCommands.spec.cleanup.kept[0].removeWith = "rm -rf /";
    expectFailure(
      () => verifyReceipt(keptWithoutCommands),
      /must record what it is and the command that removes it/,
      "kept artifact without a removal command",
    );
    const keptWithoutList = structuredClone(kept);
    keptWithoutList.spec.cleanup.kept = [];
    expectFailure(
      () => verifyReceipt(keptWithoutList),
      /cleanup did not pass/,
      "kept run that names nothing it kept",
    );

    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /proof is not pass/],
      ["source hash", (c) => { c.spec.source.base.rawSha256 = "0".repeat(64); }, /source record changed/],
      ["variants hash", (c) => { c.spec.source.variants.rawSha256 = "0".repeat(64); }, /source record changed/],
      ["revision drift", (c) => { c.spec.revisions.clusters["hx-sveltos-env-staging"].changed = "r2-000000000000"; }, /revisions no longer match the reviewed example files/],
      ["change record", (c) => { c.spec.source.change.after = 9; }, /change record changed/],
      ["policy triggers", (c) => { c.spec.policy.filter.triggerRefs = ["platform/bogus"]; }, /policy record changed/],
      ["sveltos pin", (c) => { c.spec.prerequisite.manifestSha256 = "0".repeat(64); }, /prerequisite record changed/],
      ["base published", (c) => { c.spec.base.published = true; }, /base record must carry no target and reach no cluster/],
      ["base change published", (c) => { c.spec.base.change.publishedAsRelease = true; }, /must land once on the base record and never be published from it/],
      ["variant dropped", (c) => { c.spec.variants.pop(); }, /must record one variant per cluster/],
      ["shared Space", (c) => {
        c.spec.variants[1].space = c.spec.variants[0].space;
      }, /two variants share a Space/],
      ["shared gateway reference", (c) => {
        c.spec.variants[1].gatewayReference = c.spec.variants[0].gatewayReference;
      }, /two variants share a gateway reference/],
      ["environment selector", (c) => {
        c.spec.variants[2].selector = { environment: "prod" };
      }, /must address one cluster by name and nothing else/],
      ["selector fans out", (c) => {
        c.spec.variants[2].selector = { "sveltos-agent": "present" };
      }, /must address one cluster by name and nothing else/],
      ["upstream link dropped", (c) => { c.spec.variants[0].upstream = null; }, /is not linked to the base record/],
      ["departures dropped", (c) => {
        c.spec.variants[0].departures = {};
        c.spec.variants[0].departedFields = [];
      }, /departures no longer match the reviewed variants record/],
      ["departure on the changed field", (c) => {
        c.spec.variants[0].departedFields = [
          ...c.spec.variants[0].departedFields,
          "spec.helmCharts.0.values",
        ];
      }, /departures no longer match the reviewed variants record/],
      ["management boundary", (c) => {
        c.spec.variants[4].boundary.firstRevisionDeliveredThroughGateway = true;
      }, /management bootstrap boundary changed/],
      ["management bootstrap profiles", (c) => {
        c.spec.variants[4].bootstrapProfiles.pop();
      }, /one bootstrap profile per workload Space/],
      ["bootstrap changed by promotion", (c) => {
        c.spec.gatewayDelivery.bootstrap.changedByPromotion = true;
      }, /applied once as cluster setup and left alone by promotion/],
      ["controller image dropped", (c) => {
        delete c.spec.prerequisite.addonControllerImage;
        delete c.spec.gatewayDelivery.addonControllerImage;
      }, /must record the addon controller image/],
      ["controller image disagreement", (c) => {
        c.spec.gatewayDelivery.addonControllerImage = `${addonControllerRepository}:v0.0.0`;
      }, /must record the addon controller image/],
      ["fetch interval", (c) => { c.spec.gatewayDelivery.interval = "24h0m0s"; }, /gateway delivery contract changed/],
      ["gateway host", (c) => { c.spec.gatewayDelivery.host = "registry.example.com"; }, /gateway delivery contract changed/],
      ["secret type", (c) => { c.spec.gatewayDelivery.secret.type = "Opaque"; }, /requires a Secret of type/],
      ["token in the receipt", (c) => { c.spec.gatewayDelivery.secret.tokenRecordedInReceipt = true; }, /requires a Secret of type/],
      ["gateway reference", (c) => {
        c.spec.gatewayDelivery.clusters["hx-sveltos-env-pilot"].reference =
          "oci://registry.example.com/space/hx-sveltos-env-pilot:latest";
      }, /the hx-sveltos-env-pilot gateway reference changed/],
      ["wave digest reuse", (c) => {
        c.spec.gatewayDelivery.waves[2].clusters[1].releaseManifestDigest =
          c.spec.gatewayDelivery.waves[2].clusters[0].releaseManifestDigest;
      }, /published a different release for/],
      ["release digest reuse", (c) => {
        c.spec.gatewayDelivery.clusters["hx-sveltos-env-prod-a"].changedReleaseManifestDigest =
          c.spec.gatewayDelivery.clusters["hx-sveltos-env-prod-a"].baselineReleaseManifestDigest;
      }, /own manifest digest/],
      ["management unregistered", (c) => { c.spec.fleet.managementRegistration.ready = false; }, /management cluster must be registered/],
      ["registration relabelled", (c) => { c.spec.fleet.registrations[3].labels.cluster = "hx-sveltos-env-prod-a"; }, /matches 2 of the registered clusters/],
      ["registration not ready", (c) => { c.spec.fleet.registrations[3].ready = false; }, /own addressing label/],
      ["approval bracket", (c) => { c.spec.variants[0].records[1].beforeApproval.result = "allowed"; }, /approval record changed/],
      ["approval count", (c) => { c.spec.variants[2].records[0].approval.recordedApprovals = 0; }, /approval record changed/],
      ["release reference", (c) => {
        c.spec.variants[1].records[1].release.reference =
          "oci://oci.hub.confighub.com/space/somewhere-else:latest";
      }, /release record changed/],
      ["delivery status", (c) => { c.spec.variants[0].records[0].delivery.status = "Failed"; }, /gateway delivery record changed/],
      ["delivery digest", (c) => {
        c.spec.variants[0].records[0].delivery.releaseManifestDigest = `sha256:${"0".repeat(64)}`;
      }, /gateway delivery record changed/],
      ["variant digest reuse", (c) => {
        c.spec.variants[2].records[1].release.manifestDigest =
          c.spec.variants[2].records[0].release.manifestDigest;
        c.spec.variants[2].records[1].delivery.releaseManifestDigest =
          c.spec.variants[2].records[0].release.manifestDigest;
      }, /revision record changed/],
      ["baseline set collapsed", (c) => { c.spec.baselineApproval.recordedApprovals = 1; }, /approved as one set operation/],
      ["baseline approvals iterated", (c) => { c.spec.baselineApproval.appliedAsOneOperation = false; }, /approved as one set operation/],
      ["wave query dropped", (c) => { c.spec.waves[2].selection.query = ""; }, /must record the query that selected its set/],
      ["wave matched set", (c) => { c.spec.waves[2].selection.matched.pop(); }, /must record the query that selected its set/],
      ["wave member dropped", (c) => { c.spec.waves[2].clusters.pop(); }, /rather than the prod clusters/],
      ["wave approvals miscounted", (c) => { c.spec.waves[2].approval.recordedApprovals = 1; }, /one approval per member/],
      ["wave approval iterated", (c) => { c.spec.waves[2].approval.appliedAsOneOperation = false; }, /one operation/],
      ["wave upgrade iterated", (c) => { c.spec.waves[2].upgrade.appliedAsOneOperation = false; }, /one operation/],
      ["checkpoint set", (c) => { c.spec.checkpoints.pop(); }, /checkpoint set changed/],
      ["checkpoint math", (c) => { c.spec.checkpoints[1].observations.find((row) => row.environment === "staging").expectedReplicas[backgroundDeployment] = 2; }, /observation for .* changed/],
      ["observation result", (c) => { c.spec.checkpoints[2].observations[0].observation.result = "fail"; }, /observation for .* changed/],
      ["audit", (c) => { c.spec.convergenceAudit.result = "fail"; }, /convergence audit changed/],
      ["cleanup", (c) => { c.spec.cleanup.results.policySpaces = "fail"; }, /cleanup did not pass/],
      ["cleanup mode", (c) => { c.spec.cleanup.keptDeliberately = true; }, /cleanup did not pass/],
      ["carrier reintroduced", (c) => { c.spec.notes = "Argo CD reconciled the management cluster"; }, /naming Argo CD predates that design/],
      ["other carrier reintroduced", (c) => { c.spec.notes = "Flux pulled the bundle"; }, /naming Flux predates that design/],
      ["registry reintroduced", (c) => { c.spec.notes = "published to a temporary registry on host.docker.internal"; }, /naming a temporary registry predates that design/],
      ["identity leak", (c) => { c.spec.notes = "approved by someone@confighub.com"; }, /contains a user identity/],
      ["credential leak", (c) => { c.spec.notes = "ch_selftesttoken"; }, /contains a credential/],
      ["bearer token leak", (c) => { c.spec.notes = "eyJhbGciOiJIUzI1NiJ9.self-test.signature"; }, /contains a credential/],
    ];
    for (const [label, tamper, pattern] of tampers) {
      const clone = structuredClone(receipt);
      tamper(clone);
      expectFailure(() => verifyReceipt(clone), pattern, `receipt ${label}`);
    }

    console.log(
      "sveltos env rollout runner self-test passed: one base and five per-cluster variants with single-cluster selectors, the departure collision and fan-out refusals, the upstream link and its refusal, the component and owner labels the component view groups by, the severed-lineage refusal that a serialization change causes, the set query with its empty and over-broad refusals, one set approval per wave with wave three approving two variants separately, the silent departure win refusal, the Sveltos pin and image override, the lowercase Space and Secret type refusals the gateway imposes, the gate preflight pass and its refusal, nine approval brackets of which the eight workload ones are delivered through the gateway to a fake management cluster while the management record is applied out of band and publishes no release, the gzip fetch refusal, the queued apply-gate wait told apart from a refusing gate, the keep-alive cleanup record, and the receipt tamper battery",
    );
  } finally {
    commandRunner = realRunner;
    sleeper = realSleeper;
    timeSource = realTime;
    rmSync(workRoot, { recursive: true, force: true });
  }
}

// A tampered copy of the reviewed example files, so a plan refusal is proved
// against a real fixture rather than a hand-built object.
function tamperedExampleRoot(workRoot, label, edit) {
  const root = join(workRoot, `tamper-${label}`);
  const planRoot = join(root, "examples", "sveltos", "env-rollout");
  mkdirSync(planRoot, { recursive: true });
  for (const name of [
    "fleet.yaml",
    "change-candidate.yaml",
    "variants.yaml",
    "clusterprofile-base.yaml",
  ]) {
    cpSync(join(exampleRoot, name), join(planRoot, name));
  }
  const path = join(planRoot, "variants.yaml");
  const text = readFileSync(path, "utf8");
  const next = edit(text);
  check(next !== text, `the ${label} tamper did not change the fixture`);
  writeFileSync(path, next);
  return root;
}

function removedCleanup() {
  return {
    mode: "removed",
    keptDeliberately: false,
    results: {
      probeSpace: "pass",
      managementCluster: "pass",
      workloadClusters: "pass",
      policySpaces: "pass",
      localFiles: "pass",
    },
    kept: [],
  };
}

function keptCleanup() {
  return {
    mode: "kept",
    keptDeliberately: true,
    results: {
      probeSpace: "pass",
      managementCluster: "kept",
      workloadClusters: "kept",
      policySpaces: "kept",
      localFiles: "pass",
    },
    kept: [
      {
        kind: "kind cluster",
        name: "hx-sveltos-env-pilot-20260812091500",
        removeWith: "kind delete cluster --name hx-sveltos-env-pilot-20260812091500",
      },
      {
        kind: "ConfigHub Space",
        name: "hx-sveltos-env-pilot-20260812091500",
        removeWith: "cub space delete hx-sveltos-env-pilot-20260812091500 --recursive-force",
      },
    ],
  };
}

// The install path only needs a manifest with one CRD and one workload, so the
// self-test writes a small one instead of pulling the pinned twenty thousand
// lines over the network.
function fakeSveltosManifest(image) {
  return `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: clusterprofiles.config.projectsveltos.io
spec:
  group: config.projectsveltos.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: addon-controller
  namespace: ${registrationNamespace}
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: controller
          image: ${image}
        - name: initialization
          image: ${image}
`;
}

// The message an addon controller without the gzip fix writes into the
// ClusterSummary. The gzip header is rebuilt from its bytes here so this file
// carries no control characters of its own.
function gzipDecodeFailureMessage(namesControlCharacters = true) {
  const noise = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x03]
    .map((byte) => String.fromCharCode(byte))
    .join("");
  const tail = namesControlCharacters
    ? ": yaml: control characters are not allowed"
    : "";
  return `failed to decode k8s resource ${noise}${tail}`;
}

function fakeSveltosInstall(sveltos, addonControllerImage) {
  return {
    source: sveltos.manifestUrl,
    version: sveltos.version,
    manifestSha256: sveltos.manifestSha256,
    addonControllerImage,
    pinnedAddonControllerImage: `${addonControllerRepository}:${sveltos.version}`,
    addonControllerImageOverridden:
      addonControllerImage !== `${addonControllerRepository}:${sveltos.version}`,
    objectCount: 3,
    crdCount: 1,
    appliedObjectCount: 3,
    omittedOptionalServiceMonitorCount: 0,
    deployments: [{
      name: "addon-controller",
      desired: 1,
      updated: 1,
      ready: 1,
      available: 1,
      observedGenerationMatches: true,
    }],
    installationMethod: "self-test fake surface",
  };
}

function synthesizeCheckpoints(plan) {
  return [0, 1, 2, 3].map((completedWaves) => ({
    id: completedWaves === 0 ? "baseline" : `after-wave-${completedWaves}`,
    completedWaves,
    observations: plan.clusters.map((row) => {
      const changed = row.wave <= completedWaves;
      const expectedReplicas = changed
        ? row.expectedReplicas.changed
        : row.expectedReplicas.baseline;
      return {
        cluster: `${row.cluster}-selftest`,
        logicalCluster: row.cluster,
        environment: row.environment,
        expectedRevisionId: changed
          ? row.revisions.changed
          : row.revisions.baseline,
        expectedBackgroundReplicas: changed
          ? plan.change.spec.after
          : plan.change.spec.before,
        expectedReplicas,
        departedFields: row.departurePaths,
        observation: fakeObservation(expectedReplicas),
      };
    }),
  }));
}

function synthesizeAudit(plan) {
  return {
    result: "pass",
    expectedBackgroundReplicas: plan.change.spec.after,
    clusters: plan.clusters.map((row) => ({
      cluster: `${row.cluster}-selftest`,
      logicalCluster: row.cluster,
      environment: row.environment,
      expectedReplicas: row.expectedReplicas.changed,
      observation: fakeObservation(row.expectedReplicas.changed),
    })),
  };
}

function fakeObservation(expectedReplicas) {
  return {
    result: "pass",
    clusterSummary: "projectsveltos/self-test-summary",
    helmFeatureStatus: "Provisioned",
    helmRelease: {
      name: "kyverno",
      namespace: "kyverno",
      chart: "kyverno-3.8.1",
      status: "deployed",
    },
    backgroundReplicas: {
      desired: expectedReplicas[backgroundDeployment],
      available: expectedReplicas[backgroundDeployment],
    },
    observedReplicas: { ...expectedReplicas },
    deployments: [],
  };
}

function createFakeConfigHub() {
  const filterId = "self-test-filter-0001";
  const catalogTargetId = "self-test-oci-target-0001";
  const triggerIdFor = (ref) => `self-test-trigger-${ref.split("/")[1]}`;
  const spaces = new Map();
  const units = new Map();
  const releases = new Map();
  const pending = new Set();
  let releaseSequence = 0;
  const state = {
    neverPopulateGates: false,
    refuseUpstreamLink: false,
    mergeKeepsDepartureOnly: false,
    severUpstreamLineage: false,
    triggerIdOverride: null,
    releaseTargetOverride: null,
  };
  const unitKey = (space, slug) => `${space}/${slug}`;
  const approvalsOn = (unit) =>
    Array.isArray(unit.ApprovedBy) ? unit.ApprovedBy.length : 0;
  const tick = () => {
    for (const key of pending) {
      const unit = units.get(key);
      if (!unit) continue;
      if (state.neverPopulateGates) unit.ApplyGates = {};
      else if (approvalsOn(unit) >= 1) unit.ApplyGates = {};
      else unit.ApplyGates = { [approvalGate]: true };
    }
    pending.clear();
  };
  const ok = (output) => ({ ok: true, status: 0, output, error: "" });
  const refuse = (error) => ({ ok: false, status: 1, output: "", error });
  const store = (unit, text) => {
    unit.Data = Buffer.from(text).toString("base64");
    unit.ContentHash = sha256(text);
    unit.history.set(unit.HeadRevisionNum, text);
  };
  const dataOf = (unit) => Buffer.from(unit.Data, "base64").toString("utf8");
  // The where evaluator understands the label conjunctions this chapter
  // queries with, and refuses anything else rather than matching by accident.
  const matching = (where) => {
    const clauses = String(where ?? "").split(/\s+AND\s+/);
    const predicates = clauses.map((clause) =>
      clause.trim().match(/^Labels\.([A-Za-z0-9_-]+)\s*=\s*'([^']*)'$/));
    if (predicates.some((predicate) => !predicate)) return null;
    return [...units.values()].filter((unit) =>
      predicates.every(
        (predicate) => unit.Labels?.[predicate[1]] === predicate[2],
      ));
  };
  const handle = (args) => {
    const { positionals, flags } = parseCubCommand(args);
    const [entity, verb, ...rest] = positionals;
    if (entity === "auth" && verb === "get-token") {
      return ok(`self-test-gateway-token-${"a".repeat(48)}`);
    }
    if (entity === "filter" && verb === "get") {
      return ok(JSON.stringify({ Filter: { FilterID: filterId, Hash: "self-test-filter-hash" } }));
    }
    if (entity === "trigger" && verb === "get") {
      return ok(JSON.stringify({ Trigger: { TriggerID: `self-test-trigger-${rest[0]}` } }));
    }
    if (entity === "space" && verb === "create") {
      const slug = rest[0];
      if (flags["trigger-filter"] !== approvalFilterRef) {
        return refuse(`unexpected trigger filter ${flags["trigger-filter"]}`);
      }
      spaces.set(slug, {
        Slug: slug,
        SpaceID: `self-test-space-${slug}`,
        TriggerIDs: [],
        ReleaseTargetID: null,
        TriggerFilterID: filterId,
        Labels: Object.fromEntries((flags.label ?? []).map((pair) => {
          const at = String(pair).indexOf("=");
          return [String(pair).slice(0, at), String(pair).slice(at + 1)];
        })),
      });
      return ok("");
    }
    if (entity === "space" && verb === "update") {
      const row = spaces.get(rest[0]);
      if (!row) return refuse(`space ${rest[0]} not found`);
      if (flags["release-target"]) {
        row.ReleaseTargetID = state.releaseTargetOverride ?? catalogTargetId;
      }
      if (flags["refresh-triggers"]) {
        row.TriggerIDs = state.triggerIdOverride
          ?? expectedTriggers.map(triggerIdFor).sort();
      }
      return ok("");
    }
    if (entity === "space" && verb === "get") {
      const row = spaces.get(rest[0]);
      if (!row) return refuse(`space ${rest[0]} not found`);
      return ok(JSON.stringify({ Space: structuredClone(row) }));
    }
    if (entity === "space" && verb === "delete") {
      const slug = rest[0];
      if (!spaces.has(slug)) return refuse(`space ${slug} not found`);
      spaces.delete(slug);
      releases.delete(slug);
      for (const key of [...units.keys()]) {
        if (key.startsWith(`${slug}/`)) units.delete(key);
      }
      return ok("");
    }
    if (entity === "unit" && verb === "create") {
      const [slug, path] = rest;
      const key = unitKey(flags.space, slug);
      const upstreamKey = flags["upstream-unit"]
        ? unitKey(flags["upstream-space"], flags["upstream-unit"])
        : null;
      if (upstreamKey && !units.has(upstreamKey)) {
        return refuse(`upstream unit ${upstreamKey} not found`);
      }
      const text = upstreamKey
        ? dataOf(units.get(upstreamKey))
        : readFileSync(path, "utf8");
      const unit = {
        Slug: slug,
        SpaceSlug: flags.space,
        UnitID: `self-test-unit-${flags.space}-${slug}`,
        HeadRevisionNum: 1,
        ApplyGates: { "awaiting/triggers": true },
        ApprovedBy: [],
        Labels: labelsFrom(flags.label),
        TargetID: flags.target ? `self-test-target-${flags.target}` : null,
        UpstreamUnitID: upstreamKey && !state.refuseUpstreamLink
          ? units.get(upstreamKey).UnitID
          : "",
        UpstreamUnitKey: upstreamKey,
        UpstreamRevisionNum: upstreamKey
          ? units.get(upstreamKey).HeadRevisionNum
          : 0,
        history: new Map(),
      };
      store(unit, text);
      units.set(key, unit);
      pending.add(key);
      return ok("");
    }
    if (entity === "unit" && verb === "update" && flags.patch) {
      if (flags.space !== "*") return refuse("bulk patch needs --space \"*\"");
      if (!flags.upgrade) return refuse("the self-test fake hub only patches upgrades");
      const selected = matching(flags.where);
      if (!selected) return refuse(`unsupported where expression ${flags.where}`);
      for (const unit of selected) {
        const upstream = units.get(unit.UpstreamUnitKey ?? "");
        if (!upstream) return refuse(`${unit.SpaceSlug}/${unit.Slug} has no upstream`);
        const merged = state.mergeKeepsDepartureOnly
          ? parseDocs(dataOf(unit))
          : mergeUpstream(
            parseDocs(upstream.history.get(unit.UpstreamRevisionNum)),
            parseDocs(dataOf(upstream)),
            parseDocs(dataOf(unit)),
          );
        unit.snapshot = {
          HeadRevisionNum: unit.HeadRevisionNum,
          Data: unit.Data,
          ContentHash: unit.ContentHash,
          UpstreamRevisionNum: unit.UpstreamRevisionNum,
        };
        unit.HeadRevisionNum += 1;
        unit.UpstreamRevisionNum = upstream.HeadRevisionNum;
        unit.ApprovedBy = [];
        unit.ApplyGates = { "awaiting/triggers": true };
        store(unit, documentsToText(merged));
        pending.add(unitKey(unit.SpaceSlug, unit.Slug));
      }
      return ok("");
    }
    if (entity === "unit" && verb === "update") {
      const [slug, path] = rest;
      const key = unitKey(flags.space, slug);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      unit.HeadRevisionNum += 1;
      unit.ApprovedBy = [];
      unit.ApplyGates = { "awaiting/triggers": true };
      store(unit, readFileSync(path, "utf8"));
      pending.add(key);
      return ok(JSON.stringify({ Unit: projectUnit(unit) }));
    }
    // ConfigHub reports what it can still merge from the base as a mutation
    // list. A variant stored in a different serialization from its base does
    // not align resource for resource: the base resource is recorded as deleted
    // and a different one added, and the lineage is gone. The fake models that
    // from the stored text so the runner's lineage check is exercised rather
    // than bypassed offline.
    if (entity === "unit" && verb === "get" && flags.o === "mutations") {
      const key = unitKey(flags.space, rest[0]);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      const resourceKind = "config.projectsveltos.io/v1beta1/ClusterProfile";
      const nameOf = (text) => {
        const json = String(text).match(/"name"\s*:\s*"([^"]+)"/);
        if (json) return json[1];
        const yaml = String(text).match(/^\s*name:\s*(\S+)\s*$/m);
        return yaml ? yaml[1] : "unknown";
      };
      const isJson = (text) => String(text).trimStart().startsWith("{");
      const own = dataOf(unit);
      const upstream = unit.UpstreamUnitID
        ? [...units.values()].find((row) => row.UnitID === unit.UpstreamUnitID)
        : null;
      const severed = upstream
        && (state.severUpstreamLineage || isJson(own) !== isJson(dataOf(upstream)));
      if (severed) {
        return ok([
          "Eligible for upstream merges:",
          `Resource: ${resourceKind} /${nameOf(dataOf(upstream))}`,
          "  - [Delete] (#2)",
          "",
          `Resource: ${resourceKind} /${nameOf(own)}`,
          "  + [Add] (#2)",
          "",
        ].join("\n"));
      }
      return ok([
        "Eligible for upstream merges:",
        `Resource: ${resourceKind} /${nameOf(own)}`,
        "  + [Add] (#1)",
        "  ~ [Update] metadata.name  (#2)",
        "",
      ].join("\n"));
    }
    if (entity === "unit" && verb === "get") {
      const key = unitKey(flags.space, rest[0]);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      return ok(JSON.stringify({ Unit: projectUnit(unit) }));
    }
    if (entity === "unit" && verb === "list") {
      if (flags.space !== "*") return refuse("the set query needs --space \"*\"");
      const selected = matching(flags.where);
      if (!selected) return refuse(`unsupported where expression ${flags.where}`);
      return ok(JSON.stringify(selected.map((unit) => ({ Unit: projectUnit(unit) }))));
    }
    if (entity === "unit" && verb === "approve") {
      const selected = flags.where
        ? matching(flags.where)
        : [units.get(unitKey(flags.space, rest[0]))].filter(Boolean);
      if (!selected) return refuse(`unsupported where expression ${flags.where}`);
      if (flags.where && flags.space !== "*") {
        return refuse("bulk approve across Spaces needs --space \"*\"");
      }
      if (selected.length === 0) return refuse("no unit matched the approval query");
      if (flags.revision !== "HeadRevisionNum") {
        return refuse(`the self-test fake hub approves HeadRevisionNum, not ${flags.revision}`);
      }
      for (const unit of selected) {
        unit.ApprovedBy = ["self-test-reviewer"];
        pending.add(unitKey(unit.SpaceSlug, unit.Slug));
      }
      return ok("");
    }
    if (entity === "release" && verb === "publish") {
      const spaceSlug = rest[0];
      const rows = [...units.values()]
        .filter((unit) => unit.SpaceSlug === spaceSlug && unit.TargetID)
        .sort((left, right) => left.Slug.localeCompare(right.Slug));
      if (rows.length === 0) return refuse(`${spaceSlug} has no unit to publish`);
      const digestInput = rows
        .map((unit) => `${unit.Slug}:${unit.ContentHash}:${unit.HeadRevisionNum}`)
        .join("|");
      releaseSequence += 1;
      const manifestDigest = `sha256:${sha256(`manifest:${spaceSlug}:${releaseSequence}:${digestInput}`)}`;
      // The gateway serves what was published, so the fake keeps the published
      // bytes and the fake cluster reads them back through the tag.
      releases.set(spaceSlug, {
        manifestDigest,
        data: rows.map((unit) => dataOf(unit)).join("\n---\n"),
      });
      return ok(JSON.stringify({
        Release: {
          ReleaseID: `self-test-release-${releaseSequence}`,
          Digest: `sha256:${sha256(`bundle:${spaceSlug}:${digestInput}`)}`,
          ManifestDigest: manifestDigest,
        },
      }));
    }
    return refuse(`the self-test fake hub refuses: cub ${args.join(" ")}`);
  };
  const projectUnit = (unit) => {
    const { history, UpstreamUnitKey, snapshot, ...rest } = unit;
    return structuredClone(rest);
  };
  // The refused promotion left the variants a revision ahead, so the walk that
  // follows it starts from the departed baseline again.
  const restoreVariantBaselines = () => {
    for (const unit of units.values()) {
      if (!unit.snapshot) continue;
      unit.history.delete(unit.HeadRevisionNum);
      Object.assign(unit, unit.snapshot);
      unit.ApprovedBy = ["self-test-reviewer"];
      unit.ApplyGates = {};
      delete unit.snapshot;
    }
  };
  const releaseFor = (space) => releases.get(space) ?? null;
  return {
    state,
    handle,
    tick,
    releaseFor,
    restoreVariantBaselines,
    spaceLabels: (slug) => spaces.get(slug)?.Labels ?? null,
    filterId,
    catalogTargetId,
  };
}

function labelsFrom(value) {
  const rows = Array.isArray(value) ? value : [value].filter(Boolean);
  return Object.fromEntries(rows.map((row) => {
    const index = String(row).indexOf("=");
    return [String(row).slice(0, index), String(row).slice(index + 1)];
  }));
}

function documentsToText(documents) {
  return `${documents.map((document) => JSON.stringify(document, null, 2)).join("\n---\n")}\n`;
}

// The merge the fake performs is the one the recorded finding describes: a
// field the downstream left alone takes the upstream's new value, a field the
// downstream departed on keeps the departure, and a departure inside a map of
// scalars keeps that whole map, which is how a base change goes missing.
function mergeUpstream(baseOld, baseNew, mine) {
  return baseNew.map((document, index) =>
    mergeValue(baseOld[index], document, mine[index]));
}

function mergeValue(baseOld, baseNew, mine) {
  if (mine === undefined) return structuredClone(baseNew);
  if (baseNew === undefined) return structuredClone(mine);
  if (stableJson(baseOld) === stableJson(mine)) return structuredClone(baseNew);
  if (stableJson(baseOld) === stableJson(baseNew)) return structuredClone(mine);
  if (Array.isArray(baseNew) && Array.isArray(mine) && baseNew.length === mine.length) {
    return baseNew.map((item, index) =>
      mergeValue(baseOld?.[index], item, mine[index]));
  }
  if (
    baseNew && mine && typeof baseNew === "object" && typeof mine === "object"
    && !Array.isArray(baseNew) && !Array.isArray(mine)
  ) {
    if (isScalarMap(baseNew) && isScalarMap(mine)) return structuredClone(mine);
    const keys = [...new Set([...Object.keys(baseNew), ...Object.keys(mine)])];
    return Object.fromEntries(keys.map((key) => [
      key,
      mergeValue(baseOld?.[key], baseNew[key], mine[key]),
    ]));
  }
  return structuredClone(mine);
}

function parseCubCommand(args) {
  const booleans = new Set([
    "--quiet", "--wait", "--patch", "--refresh-triggers", "--recursive-force",
    "--upgrade",
  ]);
  const repeatable = new Set(["label"]);
  const positionals = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-") || token === "-" || token === "*") {
      positionals.push(token);
      continue;
    }
    if (booleans.has(token)) {
      flags[token.slice(2)] = true;
      continue;
    }
    const name = token.replace(/^--?/, "");
    const value = args[index + 1];
    if (repeatable.has(name)) flags[name] = [...(flags[name] ?? []), value];
    else flags[name] = value;
    index += 1;
  }
  // The set commands pass the wildcard Space as a positional-looking value, so
  // it is put back where the reader expects it.
  const wildcard = positionals.indexOf("*");
  if (wildcard >= 0 && args[args.indexOf("*") - 1] === "--space") {
    flags.space = "*";
    positionals.splice(wildcard, 1);
  }
  return { positionals, flags };
}

// The fake management cluster answers the reads the runner makes and, once a
// bootstrap profile points it at a Space, serves whatever that Space last
// published. Publishing again moves the tag, and the next poll picks it up,
// which is exactly how promotion reaches the cluster on the live path.
function createFakeManagementCluster(hub) {
  const state = { failureMode: null };
  const bootstraps = new Map();
  const summaries = new Map();
  const profiles = new Map();
  const documentCache = new Map();
  const applied = [];
  const ok = (output) => ({ ok: true, status: 0, output, error: "" });
  const refuse = (error) => ({ ok: false, status: 1, output: "", error });
  const documentsOf = (text) => {
    const key = sha256(text);
    if (!documentCache.has(key)) documentCache.set(key, parseDocs(text));
    return documentCache.get(key);
  };
  const deliver = () => {
    for (const [profileName, space] of bootstraps) {
      const release = hub.releaseFor(space);
      if (!release) {
        summaries.set(profileName, { status: "Provisioning", failureMessage: "" });
        continue;
      }
      if (state.failureMode === "gzip") {
        summaries.set(profileName, {
          status: "Failed",
          failureMessage: gzipDecodeFailureMessage(),
        });
        continue;
      }
      for (const document of documentsOf(release.data)) {
        if (document.metadata?.name) profiles.set(document.metadata.name, document);
      }
      summaries.set(profileName, { status: "Provisioned", failureMessage: "" });
    }
  };
  const handle = (args) => {
    const rest = args.slice(2);
    if (rest[0] === "apply") {
      const text = readFileSync(rest[rest.indexOf("-f") + 1], "utf8");
      applied.push(text);
      let wired = false;
      for (const chunk of text.split(/^---$/m)) {
        const bootstrapName = chunk.match(/^ {2}name: (\S+)$/m)?.[1];
        const space = chunk.match(/url: oci:\/\/[^/]+\/space\/([^:\s]+):/)?.[1];
        if (bootstrapName && space && chunk.includes("deploymentType: Remote")) {
          bootstraps.set(bootstrapName, space);
          wired = true;
        }
      }
      if (wired) deliver();
      return ok("");
    }
    if (rest.includes("create") && rest.includes("token")) {
      return ok(`self-test-service-account-token-${"b".repeat(48)}`);
    }
    if (rest[0] === "config" && rest[1] === "view") {
      return ok(JSON.stringify({
        clusters: [{
          cluster: {
            "certificate-authority-data": Buffer.from("self-test-ca").toString("base64"),
          },
        }],
      }));
    }
    const getIndex = rest.indexOf("get");
    if (getIndex >= 0) {
      const resource = rest[getIndex + 1];
      if (resource === "clustersummaries") {
        return ok(JSON.stringify({
          items: [...summaries].map(([profileName, summary]) => ({
            metadata: {
              name: `self-test-${profileName}`,
              namespace: registrationNamespace,
              labels: { "projectsveltos.io/cluster-profile-name": profileName },
            },
            status: {
              featureSummaries: [{
                featureID: "Resources",
                status: summary.status,
                failureMessage: summary.failureMessage,
              }],
            },
          })),
        }));
      }
      if (resource === "clusterprofile") {
        const document = profiles.get(rest[getIndex + 2]);
        if (!document) return refuse(`clusterprofile ${rest[getIndex + 2]} not found`);
        return ok(JSON.stringify(document));
      }
      if (resource === "sveltoscluster") {
        return ok(JSON.stringify({
          status: { ready: true, version: "v1.35.0", connectionStatus: "Healthy" },
        }));
      }
      if (resource === "deployments") {
        return ok(JSON.stringify({
          items: [{
            metadata: { name: "addon-controller", generation: 1 },
            spec: { replicas: 1 },
            status: {
              updatedReplicas: 1,
              readyReplicas: 1,
              availableReplicas: 1,
              observedGeneration: 1,
            },
          }],
        }));
      }
      return refuse(`the self-test fake cluster refuses: kubectl get ${resource}`);
    }
    if (rest.includes("wait")) return ok("");
    return refuse(`the self-test fake cluster refuses: kubectl ${rest.join(" ")}`);
  };
  return {
    state,
    handle,
    tick: deliver,
    appliedText: () => applied.join("\n"),
  };
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
