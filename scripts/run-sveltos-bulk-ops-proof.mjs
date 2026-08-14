#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDepartures,
  canonicalDocs,
  canonicalValue,
  fieldsCollide,
  governedRecords,
  identity,
  isScalarMap,
  normalizeDigest,
  parentPath,
  pendingApplyGate,
  readPath,
  sameSet,
  spaceName,
  storedData,
  writeDocuments,
  writePath,
  writeStoredDocuments,
} from "./lib/per-cluster-fleet.mjs";
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
  node scripts/run-sveltos-bulk-ops-proof.mjs --run
  node scripts/run-sveltos-bulk-ops-proof.mjs --generate
  node scripts/run-sveltos-bulk-ops-proof.mjs --verify
  node scripts/run-sveltos-bulk-ops-proof.mjs --self-test`);
  process.exit(2);
}

const expectedPolicyOrg = "helm-catalog";
const approvalFilterRef = "platform/helm-catalog-prod-gates";
const approvalGate = "platform/require-approval/vet-approvedby";
// The approval gate attaches about a second after a Unit is created; the
// report that said otherwise was our own misreading, now withdrawn. The runner
// carries the gateway path chapter three recorded, and no live run of this
// chapter has been recorded on it yet.
const pendingReason = "the gateway rework has not been recorded live yet";
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
const bulkRoot = join(repoRoot, "examples", "sveltos", "bulk-ops");
const changePath = join(bulkRoot, "bulk-change.yaml");
const variantsPath = join(bulkRoot, "variants.yaml");
const sourceLockPath = join(bulkRoot, "source-lock.yaml");
const receiptPath = join(
  repoRoot,
  "runs",
  "sveltos-bulk-ops-proof",
  "receipt.yaml",
);
const summaryPath = join(repoRoot, "data", "sveltos-bulk-ops", "summary.md");
const environments = ["pilot", "staging", "prod"];
const policyUnit = "clusterprofile";
const proofLabel = "sveltos-bulk-ops";
const gateQueryWhere = `Labels.Proof = '${proofLabel}' AND LEN(ApplyGates) > 0`;
const gateQueryScope = 'cub unit list --space "*"';
// Declared with the other constants because the mode dispatch runs before
// anything further down the file is initialized.
const convergenceWaitAttempts = 150;
const holdingCheckAttempts = 3;
const registrationNamespace = "projectsveltos";
// A Target needs a BridgeWorker with announced support for its ConfigType,
// workers are space-scoped and live, and this design runs no worker per
// Space, so every cluster's named Target is hosted in the catalog's
// infrastructure Space against its long-registered OCI-capable worker.
const targetHost = {
  space: "bitnami-redis-27-0-0-default-pilot-live-20260705",
  worker: "server-worker",
};
const backgroundDeployment = "kyverno-background-controller";
const managementClusterRecord = "management";
const releaseTag = "latest";
const remoteFetchInterval = "1m0s";
const keepArtifactsVariable = "HELM_EXPT_KEEP_SVELTOS_ARTIFACTS";
const gatewaySecretName = "confighub-gateway";
const gatewaySecretType = "addons.projectsveltos.io/cluster-profile";
const gatewaySecretKey = "token";
const addonControllerRepository = "docker.io/projectsveltos/addon-controller";

// Chapter five proves the change-it-once fan-out, not a different way to hold
// a fleet, so the record machinery is the shared one and only the labels are
// its own.
const setScope = 'cub unit list --space "*"';
const baseRecordLabel = "base";
const variantRecordLabel = "variant";
const componentLabel = "sveltos-kyverno-bulk-ops";
const ownerLabel = "platform-team";
const publishGateAttempts = 30;
const publishGatePollMs = 2_000;
const {
  allowedDryRun,
  approvalCount,
  approvalObservation,
  approveSet,
  assertMergeKeptDepartures,
  assertPolicySpace,
  assertUpstreamLineage,
  blockedDryRun,
  createPolicySpace,
  establishBase,
  establishClusterTarget,
  establishVariant,
  gatewayReference,
  publishRelease,
  reviewSet,
  selectSet,
  waitForPolicy,
  applyBootstrapProfiles,
  bootstrapProfileManifest,
  bootstrapProfileName,
  establishManagement,
} = governedRecords({
  cub: (...args) => cub(...args),
  cubJson: (...args) => cubJson(...args),
  cubTry: (...args) => cubTry(...args),
  sleep: (...args) => sleep(...args),
  now: (...args) => now(...args),
  // What this chapter's reviewed change looks like once merged: the values
  // change carried inside the chart values blob, at the reviewed path.
  changedDocOf: (cluster) => cluster.changedDoc,
  changeInherited: (merged, plan) =>
    readPath(valuesOf(merged), plan.change.spec.valuesPath)
      === plan.change.spec.after,
  appLabel: "sveltos-kyverno-bulk-ops",
  bootstrapPrefix: "sveltos-bulk-ops",
  clusterCommand: (...args) => clusterCommand(...args),
  gatewaySecretName,
  managementRecordLabel: "management",
  registrationNamespace,
  remoteFetchInterval,
  stableJson: (...args) => stableJson(...args),
  approvalFilterRef,
  approvalGate,
  baseRecordLabel,
  componentLabel,
  configHubOciHost,
  ownerLabel,
  policyUnit,
  probeRecord,
  proofLabel,
  targetHost,
  publishGateAttempts,
  publishGatePollMs,
  releaseTag,
  setScope,
  variantRecordLabel,
});

// The self-test swaps these three seams for a fake ConfigHub, a fake
// management cluster, and a fake clock; every live lane uses the real defaults.
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
    `${relativeRepo(receiptPath)} is missing; no live run has been recorded, because ${pendingReason}`,
  );
  const receipt = readYaml(receiptPath);
  check(
    verifyReceipt(receipt),
    "the recorded receipt predates the per-cluster variant design; record a live run before regenerating its summary",
  );
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos bulk operations proof has no live receipt yet; no live run has been recorded yet, because ${pendingReason}`,
  );
} else {
  const receipt = readYaml(receiptPath);
  // A superseded receipt is kept as recorded, so its committed summary is kept
  // as recorded too rather than being regenerated against the new shape.
  if (verifyReceipt(receipt)) {
    check(
      existsSync(summaryPath),
      `${relativeRepo(summaryPath)} is missing; run the generator`,
    );
    check(
      readFileSync(summaryPath, "utf8") === renderSummary(receipt),
      `${relativeRepo(summaryPath)} is stale`,
    );
  }
  console.log("verified the Sveltos bulk operations proof");
}

function run() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_SVELTOS_BULK_OPS === "1",
    "set HELM_EXPT_ALLOW_LIVE_SVELTOS_BULK_OPS=1 to confirm this live proof",
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

  const plan = loadBulkPlan();
  const sveltos = loadSveltosPin();
  const addonControllerImage = resolveAddonControllerImage(sveltos);

  const topology = readApprovalTopology(policyContext);

  const recordedAt = new Date().toISOString();
  const runId = safeRunId(process.env.HELM_EXPT_PROOF_RUN_ID || recordedAt);
  const managementName = `hx-sveltos-bulkmgmt-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-bulk-ops-"));
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const keepArtifacts = keepArtifactsRequested();
  const fleetClusters = plan.fleet.spec.workloads.map((workload) => ({
    cluster: `${workload.cluster}-${runId}`,
    logicalCluster: workload.cluster,
    environment: workload.environment,
    kubeconfig: join(workRoot, `${workload.cluster}.kubeconfig`),
  }));
  const baseSpace = spaceName(`hx-sveltos-bulk-base-${runId}`);
  // One Space per cluster, the management cluster included, so the record that
  // says what a cluster runs is addressable on its own.
  const spaceFor = Object.fromEntries([
    ...plan.clusters.map((row) => [row.cluster, spaceName(`${row.cluster}-bulk-${runId}`)]),
    [plan.management.cluster, spaceName(`hx-sveltos-bulk-mgmt-${runId}`)],
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

  // The approval gate is probed before any cluster work, so a Space whose gate
  // never attaches costs seconds, not the seven-minute fleet build.
  assertApprovalGateObservable(policyContext, runId, topology);
  // Creating the management cluster's Target up front is the target-host
  // preflight: it is idempotent, the record establishment needs it anyway,
  // and a host worker that cannot mint OCI targets refuses here in seconds
  // rather than after the fleet build.
  establishClusterTarget(policyContext, "hx-sveltos-env-mgmt");
  cleanup.results.probeSpace = "pass";
  phase("gate preflight passed; the approval gate is observable");

  try {
    for (const space of policySpaces) {
      check(
        !spacePresent(policyContext, space),
        `refusing to reuse ${space}`,
      );
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
    phase("four workload clusters registered, each carrying its own cluster label");

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
      runId,
      workRoot,
      policySpacesCreated,
      workloadSpaces: plan.clusters.map((row) => ({
        cluster: row.cluster,
        space: spaceFor[row.cluster],
      })),
    });
    phase("the management record holds one bootstrap profile per workload Space");

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
      const delivery = waitForRemoteDeploy({
        managementKubeconfig,
        managementName,
        cluster: row.cluster,
        profileName: row.profileName,
        expectedDoc: row.baselineDoc,
        release: variantRecords[row.cluster].baseline.release,
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
      variantRecords[row.cluster].baseline.delivery = delivery;
    }
    phase("every per-cluster baseline arrived from the gateway");

    const checkpoints = [
      recordCheckpoint({
        id: "baseline",
        changed: false,
        plan,
        fleetClusters,
        managementKubeconfig,
      }),
    ];
    phase("baseline checkpoint observed on all four clusters");

    const baseChange = changeBaseRecord({
      policyContext,
      plan,
      workRoot,
      baseSpace,
    });
    phase("the reviewed edit landed once on the base record");

    const fanOut = promoteFanOut({
      policyContext,
      managementKubeconfig,
      managementName,
      plan,
      spaceFor,
      runId,
      variantRecords,
    });
    phase("the fan-out promoted every variant as one set operation, one approval per cluster");

    checkpoints.push(recordCheckpoint({
      id: "after-fanout",
      changed: true,
      plan,
      fleetClusters,
      managementKubeconfig,
    }));
    phase("after-fanout checkpoint observed on all four clusters");

    const zeroDriftAudit = auditZeroDrift({
      policyContext,
      plan,
      spaceFor,
      variantRecords,
      fleetClusters,
      managementKubeconfig,
    });
    check(
      zeroDriftAudit.result === "pass",
      `the zero-drift audit did not pass: ${JSON.stringify(zeroDriftAudit.gateQuery.matches)}`,
    );
    checkpoints.push({
      id: "zero-drift-audit",
      observations: zeroDriftAudit.clusters.map((row) => {
        const planned = plan.clusters.find(
          (item) => item.cluster === row.logicalCluster,
        );
        return {
          cluster: row.cluster,
          logicalCluster: row.logicalCluster,
          environment: row.environment,
          expectedRevisionId: planned.revisions.changed,
          expectedBackgroundReplicas: plan.change.spec.after,
          drift: row.drift,
          observation: row.observation,
        };
      }),
    });
    phase("zero-drift audit passed on every record and every cluster");

    receipt = buildReceipt({
      recordedAt,
      plan,
      topology,
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
      fanOut,
      checkpoints,
      zeroDriftAudit,
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

  check(receipt, "the Sveltos bulk operations proof did not complete");
  check(
    cleanupSucceeded(cleanup),
    `Sveltos bulk operations cleanup failed: ${JSON.stringify(cleanup)}`,
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
    `[sveltos-bulk-ops] ${keepArtifactsVariable}=1 was set, so these were left behind:`,
  );
  for (const row of cleanup.kept) {
    console.log(`[sveltos-bulk-ops]   ${row.kind} ${row.name}`);
  }
  console.log("[sveltos-bulk-ops] remove them with:");
  for (const row of cleanup.kept) {
    console.log(`[sveltos-bulk-ops]   ${row.removeWith}`);
  }
}

// One reviewed plan drives the runner, the matrix generator, and the
// self-test: the revision identities computed here must match
// scripts/generate-sveltos-bulk-ops.mjs exactly.
// The change-it-once fleet is held the same way the earlier chapters hold it:
// one base record carrying what every cluster shares, and one variant per
// cluster carrying only what differs for that cluster. The reviewed edit is
// made once on the base and every variant inherits it in one operation.
function loadBulkPlan(root = repoRoot) {
  const planBulkRoot = join(root, "examples", "sveltos", "bulk-ops");
  const planRolloutRoot = join(root, "examples", "sveltos", "env-rollout");
  const planPatchRoot = join(root, "examples", "sveltos", "cve-patch");
  const fleet = readYaml(join(planRolloutRoot, "fleet.yaml"));
  const change = readYaml(join(planBulkRoot, "bulk-change.yaml"));
  const variants = readYaml(join(planBulkRoot, "variants.yaml"));
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
  check(
    change.kind === "SveltosBulkChangeCandidate"
      && typeof change.spec?.valuesPath === "string"
      && change.spec.valuesPath.length > 0
      && change.spec.before !== change.spec.after
      && change.spec?.editedRecord === "base"
      && String(change.spec?.fanOut?.approvals ?? "")
        .includes("its own approval gate")
      && String(change.spec?.audit?.gateQuery ?? "")
        .includes("LEN(ApplyGates) > 0"),
    "the bulk change candidate lost its reviewed shape",
  );
  const selection = change.spec?.fanOut?.selection ?? {};
  check(
    String(selection.whereTemplate ?? "").includes("{run}")
      && String(selection.baselineWhereTemplate ?? "").includes("{run}"),
    "the bulk change candidate lost the reviewed set query the fan-out selects with",
  );

  const basePath = join(planBulkRoot, variants.spec?.base?.profile ?? "");
  const baseText = readFileSync(basePath, "utf8");
  const baseDocs = parseDocs(baseText);
  check(
    variants.kind === "SveltosBulkOpsVariants"
      && variants.spec?.base?.reachesCluster === false
      && baseDocs.length === 1,
    "the variants record lost its base declaration",
  );
  const baseDoc = baseDocs[0];
  check(
    baseDoc.kind === "ClusterProfile"
      && baseDoc.spec?.clusterSelector === undefined
      && Array.isArray(baseDoc.spec?.clusterRefs)
      && baseDoc.spec.clusterRefs.length === 0,
    "the base profile must name no cluster: empty clusterRefs and no clusterSelector",
  );
  check(
    baseDoc.spec?.syncMode === "ContinuousWithDriftDetection"
      && baseDoc.spec?.helmCharts?.length === 1
      && baseDoc.spec.helmCharts[0].chartName === change.spec.chart
      && String(baseDoc.spec.helmCharts[0].chartVersion)
      === String(change.spec.chartVersion),
    "the base profile chart pin or drift mode does not match the bulk change candidate",
  );

  // Chapter continuity: this baseline must equal chapter four's outcome, the
  // patched chart version carrying the values the earlier chapters promoted.
  const patchProfile = readYaml(join(planPatchRoot, "clusterprofile-base.yaml"));
  const patchCandidate = readYaml(join(planPatchRoot, "patch-candidate.yaml"));
  check(
    String(change.spec.chartVersion)
      === String(patchCandidate.spec.to.chartVersion),
    "the bulk baseline chart version no longer matches the chapter-four outcome",
  );
  const patchValues = parseDocs(patchProfile.spec.helmCharts[0].values)[0];
  const bulkValues = parseDocs(baseDoc.spec.helmCharts[0].values)[0];
  check(
    stableJson(bulkValues) === stableJson(patchValues),
    "the bulk baseline values no longer match the chapter-four outcome",
  );
  check(
    readPath(bulkValues, change.spec.valuesPath) === change.spec.before,
    "the bulk change before-value does not match the baseline values",
  );
  const changedValuesObject = structuredClone(bulkValues);
  writePath(changedValuesObject, change.spec.valuesPath, change.spec.after);
  const changedValues = `${toYaml(changedValuesObject)}\n`;

  // The reviewed edit rewrites the stored values blob, which merges as one
  // field, so a departure has to stay clear of that whole blob.
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

  const clusters = declaredVariants.map((row) => {
    const departures = row.departures ?? {};
    const departurePaths = Object.keys(departures).sort();
    const addressing = ["metadata.name", "spec.clusterRefs"];
    const refs = departures["spec.clusterRefs"];
    check(
      Array.isArray(refs) && refs.length === 1
        && refs[0]?.kind === "SveltosCluster"
        && refs[0].apiVersion === "lib.projectsveltos.io/v1beta1"
        && refs[0].name === row.cluster
        && refs[0].namespace === registrationNamespace
        && typeof departures["metadata.name"] === "string"
        && departurePaths.some((path) => !addressing.includes(path)),
      `${row.cluster} must depart on a clusterRefs list naming its own SveltosCluster, its own name, and at least one field beyond addressing`,
    );
    for (const path of departurePaths) {
      check(
        !fieldsCollide(path, changeField, baseDoc),
        `${row.cluster} departs on ${path}, which the reviewed edit also writes; a departure wins that merge silently, so this fan-out is refused`,
      );
    }
    const baselineDoc = applyDepartures(baseDoc, departures);
    const changedDoc = structuredClone(baselineDoc);
    changedDoc.spec.helmCharts[0].values = changedValues;
    const revisions = {
      baseline: `r1-${sha256(stableJson(baselineDoc)).slice(0, 12)}`,
      changed: `r2-${sha256(stableJson(changedDoc)).slice(0, 12)}`,
    };
    check(
      revisions.baseline !== revisions.changed,
      "the reviewed bulk change produced no new revision identity",
    );
    return {
      cluster: row.cluster,
      environment: row.environment,
      // The whole fleet is one wave: the fan-out reaches every variant in one
      // operation rather than promoting environment by environment.
      wave: 1,
      space: row.space,
      profileName: departures["metadata.name"],
      departures,
      departurePaths,
      clusterRef: refs[0],
      baselineDoc,
      changedDoc,
      revisions,
    };
  });

  const changedBaseDoc = structuredClone(baseDoc);
  changedBaseDoc.spec.helmCharts[0].values = changedValues;

  return {
    fleet,
    change,
    variants,
    selection,
    changeField,
    changedValues,
    base: {
      path: basePath,
      repoPath: `examples/sveltos/bulk-ops/${variants.spec.base.profile}`,
      text: baseText,
      doc: baseDoc,
      changedDoc: changedBaseDoc,
      space: variants.spec.base.space,
      revisions: {
        baseline: `r1-${sha256(stableJson(baseDoc)).slice(0, 12)}`,
        changed: `r2-${sha256(stableJson(changedBaseDoc)).slice(0, 12)}`,
      },
    },
    management,
    clusters,
  };
}

// The chart values ride in the profile as one text blob, so a check that the
// reviewed change was inherited reads the blob the merged document carries.
function valuesOf(doc) {
  return parseDocs(doc?.spec?.helmCharts?.[0]?.values ?? "")[0] ?? {};
}

function fanOutQuery(plan, runId) {
  return String(plan.selection.whereTemplate).replaceAll("{run}", runId);
}

function baselineQuery(plan, runId) {
  return String(plan.selection.baselineWhereTemplate).replaceAll("{run}", runId);
}

// Chapter five pins its own Sveltos release, because it runs the gateway fetch
// path the earlier chapters were recorded without.
function loadSveltosPin(path = sourceLockPath) {
  const lock = readYaml(path);
  const sveltos = lock.spec?.sveltos ?? {};
  check(
    lock.kind === "SveltosBulkOpsLock"
      && /^[0-9a-f]{64}$/.test(String(sveltos.manifestSha256))
      && String(sveltos.manifestUrl ?? "").includes(String(sveltos.version ?? " ")),
    "the bulk operations lock lost its Sveltos pin",
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

// The fan-out is one reviewed edit on the base and one set upgrade across the
// Spaces, but each Space still publishes its own release and each bootstrap
// profile reads its own Space. The counts say exactly what was one operation
// and what stayed per record.
function fanOutOperations(recordCount) {
  return {
    reviewedEdit: 1,
    setUpgrades: 1,
    setApprovals: 1,
    recordApprovals: recordCount,
    releasePublishes: recordCount,
    oneCommandAcrossSpaces: true,
    note: "One reviewed edit landed on the base record, and one set upgrade inherited it into every variant across the Spaces in one operation. One set approval recorded one approval per record against that record's own exact revision, and each Space still published its own release, because each bootstrap profile reads its own Space.",
  };
}

function assertApprovalGateObservable(context, runId, topology) {
  const probeSpace = spaceName(`hx-sveltos-bulk-probe-${runId}`);
  check(!spacePresent(context, probeSpace), `refusing to reuse ${probeSpace}`);
  createPolicySpace(context, probeSpace);
  try {
    assertPolicySpace(context, probeSpace, topology.triggerIds, null);
    cub(context, [
      "unit", "create", "--space", probeSpace, policyUnit,
      join(bulkRoot, "clusterprofile-base.yaml"),
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

function changeBaseRecord({ policyContext, plan, workRoot, baseSpace }) {
  const changedPath = join(workRoot, "clusterprofile-base-changed.yaml");
  writeStoredDocuments(changedPath, [plan.base.changedDoc]);
  cub(policyContext, [
    "unit", "update", "--space", baseSpace, policyUnit, changedPath,
    "--change-desc",
    `Raise ${plan.change.spec.valuesPath} from ${plan.change.spec.before} to ${plan.change.spec.after} once on the base record`,
    "--quiet",
  ]);
  const stored = waitForPolicy(policyContext, baseSpace, policyUnit, true);
  check(
    canonicalDocs(parseDocs(storedData(stored)))
      === canonicalDocs([plan.base.changedDoc]),
    "ConfigHub stored a different changed base ClusterProfile",
  );
  // The reviewed edit is itself approved once, on the base record, so the
  // zero-drift audit can demand that no record anywhere still carries an armed
  // gate. The base still publishes nothing: what reaches a cluster is each
  // variant's own approved revision.
  const beforeApproval = blockedDryRun(policyContext, baseSpace, policyUnit);
  cub(policyContext, [
    "unit", "approve", "--space", baseSpace, policyUnit,
    "--revision", "HeadRevisionNum", "--wait", "--quiet",
  ]);
  const approved = waitForPolicy(policyContext, baseSpace, policyUnit, false);
  check(
    approved.ContentHash === stored.ContentHash,
    "approval changed the base edit content",
  );
  const afterApproval = allowedDryRun(policyContext, baseSpace, policyUnit);
  return {
    space: baseSpace,
    unit: policyUnit,
    revisionId: plan.base.revisions.changed,
    revision: Number(approved.HeadRevisionNum),
    valuesPath: plan.change.spec.valuesPath,
    before: plan.change.spec.before,
    after: plan.change.spec.after,
    beforeApproval,
    approval: {
      revision: approved.HeadRevisionNum,
      recordedApprovals: approvalCount(approved.ApprovedBy),
      approverIdentityRecordedInReceipt: false,
      contentHashUnchanged: true,
    },
    afterApproval,
    approved: true,
    publishedAsRelease: false,
  };
}

// The fan-out: every variant selected as one set, upgraded from the base in
// one operation, checked for having actually inherited the edit, and approved
// as a set. ConfigHub records one approval and one release per cluster.
function promoteFanOut({
  policyContext,
  managementKubeconfig,
  managementName,
  plan,
  spaceFor,
  runId,
  variantRecords,
}) {
  const query = fanOutQuery(plan, runId);
  const clusters = plan.clusters;
  const expectedUnits = clusters.map((row) => `${spaceFor[row.cluster]}/${policyUnit}`);
  const preflight = selectSet({
    policyContext,
    stageName: "fan-out",
    query,
    expectedUnits,
  });
  const upgrade = cubTry(policyContext, [
    "unit", "update", "--patch", "--space", "*", "--where", query, "--upgrade", "--allow-exists",
    "--change-desc",
    `Inherit ${plan.change.spec.valuesPath}=${plan.change.spec.after} from the base into every variant`,
    "--quiet",
  ]);
  check(upgrade.ok, `the fan-out upgrade did not run: ${upgrade.error}`);
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
    stageName: "fan-out",
    query,
    members,
  });
  const promoted = [];
  for (const row of clusters) {
    const record = reviewed.records[row.cluster];
    check(
      record.release.manifestDigest
        !== variantRecords[row.cluster].baseline.release.manifestDigest,
      `the ${row.cluster} fan-out did not produce a new release manifest digest`,
    );
    // The fan-out leaves the bootstrap profiles alone. Publishing the release
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
      `Sveltos did not fetch the ${row.cluster} fan-out from the gateway: ${delivery.reason ?? "unknown"}`,
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
      inheritedFields: [plan.changeField],
      departedFields: row.departurePaths,
    });
  }
  return {
    method: plan.change.spec.fanOut.method,
    approvals: plan.change.spec.fanOut.approvals,
    changeDescription:
      `Raise ${plan.change.spec.valuesPath} from ${plan.change.spec.before} to ${plan.change.spec.after} once on the base and inherit it fleet-wide`,
    selection: { ...preflight, ...reviewed.selection },
    upgrade: {
      command: `cub unit update --patch --space "*" --where <query> --upgrade`,
      appliedAsOneOperation: true,
      members: clusters.length,
    },
    approval: reviewed.approval,
    operations: fanOutOperations(clusters.length),
    clusters: promoted,
  };
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
// At the baseline every cluster is installing the chart for the first time, so
// all of them earn the convergence wait. After a checkpoint that changed an
// environment, that environment converges, and the short budget on any
// environment the checkpoint left alone is what proves it held its state.
// This chapter fans one edit out to every record in one pass, so at the
// after-fanout checkpoint every environment changed and every cluster earns the
// convergence wait too. Kyverno takes over a minute to become available, so the
// generous budget has to be minutes and the short one has to stay short.
function convergenceAttempts(environmentChanged, fanOutCompleted) {
  if (!fanOutCompleted) return convergenceWaitAttempts;
  return environmentChanged ? convergenceWaitAttempts : holdingCheckAttempts;
}

function recordCheckpoint({
  id,
  changed,
  plan,
  fleetClusters,
  managementKubeconfig,
}) {
  const observations = fleetClusters.map((row) => {
    const planned = plan.clusters.find(
      (item) => item.cluster === row.logicalCluster,
    );
    const expectedBackgroundReplicas = changed
      ? plan.change.spec.after
      : plan.change.spec.before;
    const observation = observeWorkload({
      managementKubeconfig,
      workloadName: row.cluster,
      logicalCluster: row.logicalCluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: planned.profileName,
      expectedBackgroundReplicas,
      // The fan-out changes every cluster in its one pass, so the checkpoint
      // that follows it finds every cluster converging, and the checkpoint
      // before it is the baseline where nothing is installed yet.
      attempts: convergenceAttempts(changed, changed),
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
      expectedBackgroundReplicas,
      observation,
    };
  });
  return { id, observations };
}

// The chapter's distinctive close: a set-aware query across the Spaces must
// find no armed gates, no record may have changed since its approval, the
// inherited values must be byte-identical across every variant record, and
// drift injected on every cluster must be repaired.
function auditZeroDrift({
  policyContext,
  plan,
  spaceFor,
  variantRecords,
  fleetClusters,
  managementKubeconfig,
}) {
  const gateRows = JSON.parse(cub(policyContext, [
    "unit", "list",
    "--space", "*",
    "--where", gateQueryWhere,
    "--quiet", "-o", "json",
  ]));
  const matches = (Array.isArray(gateRows) ? gateRows : [])
    .map((row) => `${row.Unit?.SpaceSlug ?? ""}/${row.Unit?.Slug ?? ""}`);
  // The management record's schema-vet gate is permanently armed: its
  // bootstrap profiles carry the gateway's remoteURL extension, which the
  // upstream schema check does not know, so vet-schemas refuses the document
  // even though the record is approved. That armed gate is the recorded
  // bootstrap boundary, named here rather than swept up or silently
  // excluded: the sweep passes only when the management record is the sole
  // armed record, its only armed gate is the schema vet, and its approval
  // is on file.
  const managementSpace = spaceFor[plan.management.cluster];
  const boundaryEntry = `${managementSpace}/${policyUnit}`;
  const strays = matches.filter((entry) => entry !== boundaryEntry);
  check(
    strays.length === 0,
    `the set-aware gate query found armed gates beyond the recorded boundary: ${strays.join(", ")}`,
  );
  check(
    matches.includes(boundaryEntry),
    "the management record's armed schema-vet gate was not found; the recorded bootstrap boundary changed",
  );
  const boundaryUnit = cubJson(policyContext, [
    "unit", "get", "--space", managementSpace, policyUnit, "-o", "json",
  ]).Unit;
  const boundaryGates = Object.keys(boundaryUnit.ApplyGates ?? {})
    .filter((key) => boundaryUnit.ApplyGates[key] === true);
  check(
    boundaryGates.length === 1
      && /vet-schemas/.test(boundaryGates[0])
      && (boundaryUnit.ApprovedBy ?? []).length >= 1,
    `the management record's armed state changed: gates ${boundaryGates.join(", ") || "none"} with ${(boundaryUnit.ApprovedBy ?? []).length} approval(s); the recorded boundary is the schema-vet gate alone with an approval on file`,
  );
  const recognizedBoundary = {
    space: managementSpace,
    unit: policyUnit,
    gates: boundaryGates,
    recordedApprovals: (boundaryUnit.ApprovedBy ?? []).length,
    reason: "the management record's bootstrap profiles carry the gateway's remoteURL extension, which the upstream schema vet does not know, so its schema-vet gate stays armed; the record is approved and publishes no release",
  };

  const records = [];
  const storedValues = [];
  for (const row of plan.clusters) {
    const current = cubJson(policyContext, [
      "unit", "get", "--space", spaceFor[row.cluster], policyUnit, "-o", "json",
    ]).Unit;
    const approvedRecord = variantRecords[row.cluster].changed;
    check(
      Number(current.HeadRevisionNum)
        === Number(approvedRecord.approval.revision)
        && current.ContentHash === approvedRecord.contentHash,
      `the ${row.cluster} record changed out of band after its approval`,
    );
    const storedDoc = parseDocs(storedData(current))[0];
    storedValues.push(storedDoc.spec.helmCharts[0].values);
    records.push({
      cluster: row.cluster,
      environment: row.environment,
      space: spaceFor[row.cluster],
      revisionUnchanged: true,
      contentUnchanged: true,
    });
  }
  check(
    storedValues.every((values) => values === storedValues[0]),
    "the inherited values are not identical across the variant records",
  );

  const clusters = fleetClusters.map((row) => {
    const planned = plan.clusters.find(
      (item) => item.cluster === row.logicalCluster,
    );
    const drift = runDriftRepair({
      workloadKubeconfig: row.kubeconfig,
      expectedReplicas: plan.change.spec.after,
    });
    check(
      drift.result === "pass",
      `Sveltos did not repair injected drift on ${row.cluster}: ${drift.reason ?? "unknown"}`,
    );
    const observation = observeWorkload({
      managementKubeconfig,
      workloadName: row.cluster,
      logicalCluster: row.logicalCluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: planned.profileName,
      expectedBackgroundReplicas: plan.change.spec.after,
      attempts: 30,
    });
    check(
      observation.result === "pass",
      `${row.cluster} did not settle after the drift repair: ${observation.reason ?? "unknown"}`,
    );
    return {
      cluster: row.cluster,
      logicalCluster: row.logicalCluster,
      environment: row.environment,
      drift,
      observation,
    };
  });

  return {
    result: "pass",
    gateQuery: {
      scope: gateQueryScope,
      where: gateQueryWhere,
      matches,
      recognizedBoundary,
    },
    records,
    valuesIdenticalAcrossRecords: true,
    clusters,
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

function observeWorkload({
  managementKubeconfig,
  workloadName,
  logicalCluster,
  workloadKubeconfig,
  profileName,
  expectedBackgroundReplicas,
  attempts,
}) {
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
        return item.spec?.clusterName === logicalCluster
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
        deployments: last.deployments,
      };
    }
    if (attempt + 1 < attempts) sleep(4000);
  }
  return {
    result: "fail",
    reason: `summary=${last.summary}; helm=${last.helmStatus}; deployments=${
      JSON.stringify(last.deployments)
    }; expectedBackgroundReplicas=${expectedBackgroundReplicas}`,
  };
}

function buildReceipt({
  recordedAt,
  plan,
  topology,
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
  fanOut,
  checkpoints,
  zeroDriftAudit,
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
        clusterRef: record.clusterRef,
        upstream: record.upstream,
        departures: record.departures,
        departedFields: record.departedFields,
        inheritedFields: [plan.changeField],
        target: record.target,
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
      target: managementVariant.target,
      records: [{ stage: "baseline", wave: 0, ...managementVariant.baseline }],
    },
  ];
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosBulkOpsProofReceipt",
    metadata: { name: "kyverno-bulk-operations" },
    spec: {
      recordedAt,
      flow: {
        path: "bulk candidate -> one reviewed edit on the base record in ConfigHub -> one variant per cluster inherits it in one operation -> approval per variant -> ConfigHub release -> the ConfigHub OCI gateway -> Sveltos -> Kubernetes",
        promotion: "one reviewed edit made once on the base and inherited by every variant in one fan-out, closed by a zero-drift audit",
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
          path: "examples/sveltos/bulk-ops/bulk-change.yaml",
          rawSha256: sha256(readFileSync(changePath, "utf8")),
          valuesPath: plan.change.spec.valuesPath,
          before: plan.change.spec.before,
          after: plan.change.spec.after,
          editedRecord: "base",
        },
        continuity: { baselineMatchesChapterFourOutcome: true },
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
        targetHost: { space: targetHost.space, worker: targetHost.worker },
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
      fanOut,
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
      },
      fleet: {
        managementCluster: managementName,
        creationCommand: "kind create cluster",
        managementRegistration,
        registrations,
      },
      checkpoints,
      zeroDriftAudit,
      cleanup,
      limits: [
        "The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.",
        "The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.",
        "The management record was applied out of band with kubectl, because it is the record that opens the gateway path.",
        "The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.",
        "The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.",
        "The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.",
        "The fan-out was one reviewed edit and one set upgrade; each record still recorded its own approval and each Space still published its own release, so delivery was four publishes and four fetches rather than one.",
      ],
    },
    status: {
      result: "pass",
      claim: "ConfigHub held one variant per cluster over a shared base, and one reviewed edit made once on the base record was inherited by every variant in one set operation, with one approval recorded per cluster against that cluster's own exact revision. Each Space published its own release to the ConfigHub OCI gateway, Sveltos fetched each release itself and converged every cluster on the changed revision with its departures intact, and the zero-drift audit closed the run: the set-aware gate query across the Spaces found no armed gates, no record changed out of band, the inherited values were byte-identical across the variant records, and injected drift was repaired on every cluster.",
    },
  };
}

function verifyReceipt(receipt) {
  check(
    receipt.kind === "SveltosBulkOpsProofReceipt",
    "Sveltos bulk ops receipt kind changed",
  );
  check(receipt.status?.result === "pass", "Sveltos bulk ops proof is not pass");
  const plan = loadBulkPlan();
  // The committed receipt records three environment records. This chapter now
  // governs one record per cluster, so that receipt describes a fleet this
  // chapter no longer builds. It is named as superseded and kept as recorded,
  // rather than being checked against a plan it never ran.
  const recordedRevisions = receipt.spec?.revisions?.clusters ?? {};
  const perCluster = plan.clusters.every(
    (row) => recordedRevisions[row.cluster]?.baseline !== undefined,
  );
  if (!perCluster) {
    console.log(
      "the recorded receipt governs three environment records and predates the per-cluster variant design; it awaits a live re-record",
    );
    return false;
  }
  check(
    receipt.spec?.source?.base?.path === plan.base.repoPath
      && receipt.spec.source.base.rawSha256 === sha256(plan.base.text)
      && receipt.spec.source.variants?.path === relativeRepo(variantsPath)
      && receipt.spec.source.variants.rawSha256
      === sha256(readFileSync(variantsPath, "utf8")),
    "Sveltos bulk ops source record changed",
  );
  check(
    receipt.spec?.revisions?.base?.baseline === plan.base.revisions.baseline
      && receipt.spec.revisions.base.changed === plan.base.revisions.changed,
    "the receipt revisions no longer match the reviewed example files",
  );
  for (const row of plan.clusters) {
    check(
      recordedRevisions[row.cluster]?.baseline === row.revisions.baseline
        && recordedRevisions[row.cluster].changed === row.revisions.changed,
      "the receipt revisions no longer match the reviewed example files",
    );
  }
  check(
    receipt.spec?.source?.change?.rawSha256
      === sha256(readFileSync(changePath, "utf8"))
      && receipt.spec.source.change.valuesPath === plan.change.spec.valuesPath
      && receipt.spec.source.change.before === plan.change.spec.before
      && receipt.spec.source.change.after === plan.change.spec.after
      && receipt.spec.source.change.editedRecord === "base",
    "Sveltos bulk ops change record changed",
  );
  check(
    receipt.spec?.source?.continuity?.baselineMatchesChapterFourOutcome === true,
    "Sveltos bulk ops continuity record changed",
  );
  const recordedTriggers = receipt.spec?.policy?.filter?.triggerRefs ?? [];
  check(
    receipt.spec?.policy?.organization === expectedPolicyOrg
      && receipt.spec.policy.profile === "catalog-standard"
      && receipt.spec.policy.approvalGate === approvalGate
      && sameSet(recordedTriggers, expectedTriggers),
    "Sveltos bulk ops policy record changed",
  );
  const sveltos = loadSveltosPin();
  check(
    receipt.spec?.prerequisite?.version === sveltos.version
      && receipt.spec.prerequisite.manifestSha256 === sveltos.manifestSha256
      && receipt.spec.prerequisite.deployments?.length > 0,
    "Sveltos bulk ops prerequisite record changed",
  );
  verifyBaseRecord(receipt, plan);
  verifyVariants(receipt, plan);
  verifyFanOut(receipt, plan);
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
          registration.cluster === row.cluster
          && registration.labels?.environment === row.environment
          && registration.labels?.cluster === undefined))
      && new Set(registrations.map((row) => row.cluster)).size
      === registrations.length,
    "Sveltos bulk ops registration record changed",
  );
  const checkpoints = receipt.spec?.checkpoints ?? [];
  check(
    checkpoints.map((checkpoint) => checkpoint.id).join(",")
      === "baseline,after-fanout,zero-drift-audit",
    "Sveltos bulk ops checkpoint set changed",
  );
  for (const checkpoint of checkpoints) {
    check(
      checkpoint.observations?.length === plan.clusters.length
        && new Set(checkpoint.observations.map((row) => row.cluster)).size
        === plan.clusters.length,
      `Sveltos bulk ops ${checkpoint.id} observation set changed`,
    );
    const changed = checkpoint.id !== "baseline";
    for (const row of checkpoint.observations) {
      const planned = plan.clusters.find(
        (item) => item.cluster === row.logicalCluster,
      );
      check(planned, `${checkpoint.id} observed an unplanned cluster`);
      const expectedRevision = changed
        ? planned.revisions.changed
        : planned.revisions.baseline;
      const expectedReplicas = changed
        ? plan.change.spec.after
        : plan.change.spec.before;
      check(
        row.expectedRevisionId === expectedRevision
          && row.expectedBackgroundReplicas === expectedReplicas
          && row.observation?.result === "pass"
          && row.observation.helmFeatureStatus === "Provisioned"
          && row.observation.backgroundReplicas?.desired === expectedReplicas
          && row.observation.backgroundReplicas.available === expectedReplicas,
        `Sveltos bulk ops ${checkpoint.id} observation for ${row.cluster} changed`,
      );
      if (checkpoint.id === "zero-drift-audit") {
        check(
          row.drift?.result === "pass"
            && row.drift.changedReplicas === 1
            && row.drift.restoredReplicas === plan.change.spec.after,
          `Sveltos bulk ops drift repair for ${row.cluster} changed`,
        );
      }
    }
  }
  const audit = receipt.spec?.zeroDriftAudit;
  check(
    audit?.result === "pass"
      && audit.gateQuery?.where === gateQueryWhere
      && Array.isArray(audit.gateQuery.matches)
      && audit.gateQuery.matches.length === 1
      && audit.gateQuery.matches[0]
      === `${audit.gateQuery.recognizedBoundary?.space}/${policyUnit}`
      && audit.gateQuery.recognizedBoundary?.space
      === (receipt.spec?.variants ?? []).find((row) => row.role === "management")?.space
      && audit.gateQuery.recognizedBoundary.unit === policyUnit
      && (audit.gateQuery.recognizedBoundary.gates ?? []).length === 1
      && /vet-schemas/.test(audit.gateQuery.recognizedBoundary.gates[0])
      && audit.gateQuery.recognizedBoundary.recordedApprovals >= 1
      && String(audit.gateQuery.recognizedBoundary.reason ?? "").includes("remoteURL")
      && (audit.records ?? []).length === plan.clusters.length
      && plan.clusters.every((row) =>
        audit.records.some((record) => record.cluster === row.cluster))
      && audit.records.every(
        (row) => row.revisionUnchanged === true && row.contentUnchanged === true,
      )
      && audit.valuesIdenticalAcrossRecords === true
      && audit.clusters?.length === plan.clusters.length
      && audit.clusters.every(
        (row) => row.drift?.result === "pass" && row.observation?.result === "pass",
      ),
    "Sveltos bulk ops zero-drift audit changed",
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
    "Sveltos bulk ops receipt contains a user identity",
  );
  check(
    !serialized.includes("ch_") && !serialized.includes("eyJ"),
    "Sveltos bulk ops receipt contains a credential",
  );
  return true;
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
      && base.change.approved === true
      && base.change.beforeApproval?.result === "blocked"
      && base.change.approval?.recordedApprovals >= 1
      && base.change.afterApproval?.result === "allowed"
      && base.change.publishedAsRelease === false,
    "the reviewed edit must land once on the base record, clear its own gate, and never be published from it",
  );
}

// The whole point of the shared fleet design: one record per cluster, each
// addressing its own cluster and nothing else, each holding its own departures.
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
    "two variants share a Space, so ConfigHub cannot answer which cluster runs which revision",
  );
  check(
    new Set(variants.map((row) => row.gatewayReference)).size === variants.length,
    "two variants share a gateway reference, so they cannot be served separately",
  );
  // ConfigHub's destination model: each variant's Space carries a Target
  // named for its cluster and releases to it, so what runs where is a
  // model-level answer. A receipt recorded before this model released every
  // Space to one shared catalog target; it is recognized and awaits its
  // re-record, while a receipt that mixes the two shapes is refused.
  const targeted = variants.some((row) => row.target);
  if (!targeted) {
    console.log(
      "the recorded receipt predates the per-cluster Target model and releases to a shared catalog target; it awaits its re-record",
    );
  } else {
    check(
      receipt.spec?.policy?.target === undefined,
      "the shared catalog target is retired; a per-cluster Target receipt must not carry one",
    );
    for (const variant of variants) {
      check(
        variant.target?.name === variant.cluster
          && variant.target.ref === `${targetHost.space}/${variant.cluster}`
          && variant.target.host === targetHost.space
          && variant.target.provider === "OCI"
          && String(variant.target.id ?? "").length > 0,
        `the ${variant.cluster} variant must release to its own cluster's Target on the declared host`,
      );
    }
    check(
      receipt.spec?.policy?.targetHost?.space === targetHost.space
        && receipt.spec.policy.targetHost.worker === targetHost.worker,
      "the receipt must record the Space and worker hosting the cluster Targets",
    );
    check(
      new Set(variants.map((row) => row.target.id)).size === variants.length,
      "two variants share a Target, so ConfigHub's model cannot say what runs where",
    );
  }
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
    check(
      variant.selector === undefined
        && variant.clusterRef?.kind === "SveltosCluster"
        && variant.clusterRef.apiVersion === "lib.projectsveltos.io/v1beta1"
        && variant.clusterRef.name === row.cluster
        && variant.clusterRef.namespace === registrationNamespace,
      `the ${row.cluster} variant must name its own SveltosCluster and nothing else`,
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
      sameSet(variant.inheritedFields ?? [], [plan.changeField])
        && !(variant.departedFields ?? []).some((path) =>
          fieldsCollide(path, plan.changeField, plan.base.doc)),
      `the ${row.cluster} record must inherit the reviewed edit rather than depart on it`,
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

// The fan-out is one operation over the whole named set. The receipt keeps the
// query, the members it matched, and one approval per member bound to its own
// revision, and the counts refuse to round any of that up or down.
function verifyFanOut(receipt, plan) {
  const baseline = receipt.spec?.baselineApproval ?? {};
  check(
    baseline.scope === setScope
      && String(baseline.query ?? "").length > 0
      && baseline.appliedAsOneOperation === true
      && (baseline.matched ?? []).length === plan.clusters.length + 1
      && baseline.recordedApprovals === plan.clusters.length + 1,
    "the baseline must be approved as one set operation over every record this run created",
  );
  const fanOut = receipt.spec?.fanOut ?? {};
  const members = fanOut.clusters ?? [];
  check(
    String(fanOut.method ?? "").includes("one operation")
      && String(fanOut.approvals ?? "").includes("its own approval gate"),
    "Sveltos bulk ops fan-out record changed",
  );
  check(
    sameSet(
      members.map((row) => row.cluster),
      plan.clusters.map((row) => row.cluster),
    ),
    `the fan-out approved ${members.map((row) => row.cluster).join(", ")} rather than every fleet cluster`,
  );
  check(
    fanOut.selection?.scope === setScope
      && String(fanOut.selection.query ?? "").length > 0
      && sameSet(
        fanOut.selection.matched ?? [],
        members.map((row) => `${row.space}/${policyUnit}`),
      ),
    "the fan-out must record the query that selected its set and the units it matched",
  );
  check(
    fanOut.upgrade?.appliedAsOneOperation === true
      && fanOut.upgrade.members === members.length
      && fanOut.approval?.appliedAsOneOperation === true
      && fanOut.approval.recordedApprovals === members.length,
    "the fan-out must promote its set in one operation and record one approval per member",
  );
  // The fan-out is one reviewed edit and one set upgrade, and it is four
  // approvals and four publishes. A receipt that rounds any of that down
  // claims something this run did not do.
  check(
    fanOut.operations?.reviewedEdit === 1
      && fanOut.operations.setUpgrades === 1
      && fanOut.operations.setApprovals === 1
      && fanOut.operations.recordApprovals === plan.clusters.length
      && fanOut.operations.releasePublishes === plan.clusters.length
      && fanOut.operations.oneCommandAcrossSpaces === true,
    "Sveltos bulk ops fan-out operation counts changed",
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
        && sameSet(member.inheritedFields ?? [], [plan.changeField])
        && sameSet(member.departedFields ?? [], planCluster.departurePaths),
      `the fan-out recorded a different approval for ${member.cluster}`,
    );
  }
}

// The delivery record carries the half of this chapter's claim that moved to
// the gateway, so it is checked as one block: the gateway reference per
// cluster, the release manifest digest per record, the fetch interval, the
// Secret type the fetcher requires, and the controller image the run ran.
function verifyGatewayDelivery(receipt, plan) {
  const delivery = receipt.spec?.gatewayDelivery ?? {};
  check(
    delivery.host === configHubOciHost
      && delivery.tag === releaseTag
      && delivery.interval === remoteFetchInterval
      && delivery.deploymentType === "Remote",
    "Sveltos bulk ops gateway delivery contract changed",
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
  const fanOutDigests = (receipt.spec?.fanOut?.clusters ?? []).map((row) => {
    check(
      row.releaseManifestDigest
        === delivery.clusters?.[row.cluster]?.changedReleaseManifestDigest,
      `the fan-out published a different release for ${row.cluster}`,
    );
    return row.releaseManifestDigest;
  });
  check(
    new Set(fanOutDigests).size === fanOutDigests.length
      && fanOutDigests.length === plan.clusters.length,
    "every cluster in the fan-out must publish its own release manifest digest",
  );
}

// Cleanup is a pass when everything was removed and also when the operator
// asked to keep the artifacts. Kept artifacts must say what was left and how
// to remove it, so a kept run never reads as a failed cleanup.
function verifyCleanup(receipt) {
  const cleanup = receipt.spec?.cleanup ?? {};
  check(
    cleanupSucceeded(cleanup),
    "Sveltos bulk ops cleanup did not pass",
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
      return `| ${variant.cluster} | ${variant.space} | ${variant.records[0].beforeApproval.result} and ${changed.beforeApproval.result} | \`${changed.release.manifestDigest}\` | ${changed.delivery.status} |`;
    });
  const audit = receipt.spec.zeroDriftAudit;
  const delivery = receipt.spec.gatewayDelivery;
  const operations = receipt.spec.fanOut.operations;
  const clusterCount = receipt.spec.fanOut.clusters.length;
  return `# ConfigHub changes a fleet once and proves it everywhere

This run starts with four workload clusters and a management cluster.
ConfigHub holds one reviewed base record and one variant per cluster, so the
answer to which cluster runs which revision comes from ConfigHub rather than
from a selector on a cluster. One reviewed edit raises \`${change.valuesPath}\`
from ${change.before} to ${change.after} once on the base record, and one set
operation inherits it into every variant. Each record still enforces its own
approval gate, and each approved revision was published as a release the
ConfigHub OCI gateway serves.

Sveltos fetched each release itself from
\`oci://${delivery.host}/space/<space>:${delivery.tag}\` on a
${delivery.interval} interval, so no other controller took part. The fan-out
is one reviewed edit and one set upgrade across the Spaces, and it is
${operations.recordApprovals} recorded approvals and
${operations.releasePublishes} publishes, because every approval binds one
cluster's record to its own exact revision and each Space publishes its own
release.

The zero-drift audit closed the run. A set-aware query across the Spaces
found no armed gates, no record changed out of band after its approval, the
inherited values were byte-identical across the variant records, and drift
injected on every cluster was repaired.

| Cluster | Space | Blocked before approval | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

| Check | Result |
| --- | --- |
| Variants selected by the fan-out | ${clusterCount}/4 in one operation |
| Approvals and release publishes | ${operations.recordApprovals} and ${operations.releasePublishes} |
| Set-aware gate query matches | ${audit.gateQuery.matches.length}, the management record's schema-vet boundary alone |
| Records unchanged after approval | ${audit.records.filter((row) => row.revisionUnchanged && row.contentUnchanged).length}/4 |
| Inherited values identical across records | ${audit.valuesIdenticalAcrossRecords ? "yes" : "no"} |
| Drift repaired | ${audit.clusters.filter((row) => row.drift.result === "pass").length}/4 clusters |
| Addon controller image | \`${delivery.addonControllerImage}\` |
| Cleanup | ${receipt.spec.cleanup.mode === "kept" ? "Artifacts kept deliberately" : "Pass"} |${receipt.spec.variants.some((row) => row.target) ? `\n| Release targets | one Target per cluster, named for it |` : ""}

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows every cluster at every checkpoint.

## Limits

${receipt.spec.limits.map((limit) => `- ${limit}`).join("\n")}

- [Committed receipt](../../runs/sveltos-bulk-ops-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/bulk-ops/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/bulk-ops/variants.yaml)
- [Reviewed bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)
`;
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
  // The committed clusterRefs departure names the logical cluster, so the
  // SveltosCluster this kind cluster answers to must be registered under
  // that logical name; the kubeconfig Secret follows Sveltos's own naming
  // convention for the SveltosCluster it pairs with.
  const registrationPath = join(
    workRoot,
    `${workloadName}-sveltos-registration.yaml`,
  );
  writeFileSync(registrationPath, `apiVersion: v1
kind: Secret
metadata:
  name: ${logicalCluster}-sveltos-kubeconfig
  namespace: ${registrationNamespace}
type: Opaque
data:
  kubeconfig: ${Buffer.from(registeredKubeconfig).toString("base64")}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata:
  name: ${logicalCluster}
  namespace: ${registrationNamespace}
  labels:
    environment: ${environment}
    sveltos-agent: present
spec: {}
`, { mode: 0o600 });
  clusterCommand(managementKubeconfig, ["apply", "-f", registrationPath]);
  const observed = waitForRegistration(managementKubeconfig, logicalCluster);
  check(
    observed.ready,
    `Sveltos did not register ${logicalCluster}: ${observed.reason}`,
  );
  return {
    method: "programmatic SveltosCluster registration",
    namespace: registrationNamespace,
    cluster: logicalCluster,
    kindCluster: workloadName,
    labels: {
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
  console.log(`[sveltos-bulk-ops] ${message}`);
}

function selfTest() {
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-bulk-self-test-"));
  const realRunner = commandRunner;
  const realSleeper = sleeper;
  const realTime = timeSource;
  const policyContext = "self-test-policy";
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const managementName = "hx-sveltos-bulkmgmt-selftest";
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

    const plan = loadBulkPlan();
    check(
      plan.clusters.every((row) =>
        row.revisions.baseline.startsWith("r1-")
        && row.revisions.changed.startsWith("r2-"))
        && plan.base.revisions.baseline.startsWith("r1-")
        && plan.base.revisions.changed.startsWith("r2-"),
      "the bulk plan lost its revision identities",
    );

    // Chapter three cost two live fleet builds to learn this: the baseline
    // gives every cluster its first install, so a checkpoint that hands out the
    // holding budget there can never pass.
    check(
      convergenceAttempts(false, false) === convergenceWaitAttempts
        && convergenceAttempts(true, false) === convergenceWaitAttempts,
      "the baseline checkpoint must let every cluster converge",
    );
    check(
      convergenceAttempts(true, true) === convergenceWaitAttempts
        && convergenceAttempts(false, true) === holdingCheckAttempts,
      "after the fan-out, a changed environment converges and an unchanged one must hold",
    );
    check(
      convergenceWaitAttempts * 4 >= 150,
      "the convergence budget must cover a first Kyverno install, which takes over a minute",
    );

    // The pin this chapter reads, and the controller image rule the gateway
    // forces on top of it.
    const sveltos = loadSveltosPin();
    const pinnedImage = `${addonControllerRepository}:${sveltos.version}`;
    check(
      sveltos.version === "v1.13.0"
        && sveltos.manifestUrl.includes(sveltos.version)
        && /^[0-9a-f]{64}$/.test(sveltos.manifestSha256),
      "the chapter five Sveltos pin lost its shape",
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
      gatewayReference("hx-sveltos-bulk-pilot-20260812")
        === "oci://oci.hub.confighub.com/space/hx-sveltos-bulk-pilot-20260812:latest",
      "the gateway reference changed shape",
    );
    check(
      spaceName(`hx-sveltos-bulk-pilot-${safeRunId("2026-08-12T09:15:00Z")}`)
        === "hx-sveltos-bulk-pilot-20260812091500",
      "the run identifier no longer produces a lowercase Space name",
    );
    expectFailure(
      () => gatewayReference("HX-Sveltos-Bulk-Pilot"),
      /OCI repository names are lowercase/,
      "uppercase gateway reference refusal",
    );
    expectFailure(
      () => createPolicySpace(policyContext, "HX-Sveltos-Bulk-Pilot"),
      /OCI repository names are lowercase/,
      "uppercase Space creation refusal",
    );

    // The registrations the gateway path stands on: each workload cluster by
    // its own cluster label, and the management cluster by its role.
    const workloadRegistration = registerWorkload({
      managementKubeconfig,
      workloadName: "hx-sveltos-bulk-pilot-selftest",
      workloadKubeconfig: join(workRoot, "pilot.kubeconfig"),
      workRoot,
      logicalCluster: "hx-sveltos-env-pilot",
      environment: "pilot",
    });
    check(
      workloadRegistration.cluster === "hx-sveltos-env-pilot"
        && workloadRegistration.labels.environment === "pilot"
        && workloadRegistration.labels.cluster === undefined
        && workloadRegistration.ready === true
        && workloadRegistration.credential.storedInRepository === false,
      "the workload registration record changed",
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

    // The bootstrap profile the management cluster receives.
    const bootstrap = bootstrapProfileManifest("pilot", "self-test-bulk-pilot");
    check(
      bootstrap.includes("deploymentType: Remote")
        && bootstrap.includes(`url: ${gatewayReference("self-test-bulk-pilot")}`)
        && bootstrap.includes(`interval: ${remoteFetchInterval}`)
        && bootstrap.includes("role: management")
        && bootstrap.includes(`name: ${gatewaySecretName}`)
        && bootstrap.includes(`namespace: ${registrationNamespace}`),
      "the bootstrap profile lost its remote fetch contract",
    );

    const topology = readApprovalTopology(policyContext);

    // The gate preflight is the gate preflight: it must pass when the
    // gate materializes and refuse fast, naming the issue, when it never does.
    assertApprovalGateObservable(policyContext, "20260807000000", topology);
    check(
      !spacePresent(policyContext, "hx-sveltos-bulk-probe-20260807000000"),
      "the gate preflight did not delete its probe Space",
    );
    hub.state.neverPopulateGates = true;
    expectFailure(
      () => assertApprovalGateObservable(policyContext, "20260807000001", topology),
      /the approval gate never appeared on the probe Unit .*; check the Space wiring before building the fleet/,
      "gate preflight refusal",
    );
    check(
      !spacePresent(policyContext, "hx-sveltos-bulk-probe-20260807000001"),
      "the refused gate preflight did not delete its probe Space",
    );
    hub.state.neverPopulateGates = false;

    // The whole path: one base record, four variants cloned from it, the
    // management record, one set approval for the baseline, delivery through
    // the gateway, one reviewed edit on the base, and one fan-out that has to
    // actually inherit it into every variant.
    const policySpacesCreated = new Set();
    const runId = "20260813000000";
    const baseSpace = spaceName(`hx-sveltos-bulk-base-${runId}`);
    const spaceFor = Object.fromEntries([
      ...plan.clusters.map((row) => [row.cluster, spaceName(`${row.cluster}-bulk-${runId}`)]),
      [plan.management.cluster, spaceName(`hx-sveltos-bulk-mgmt-${runId}`)],
    ]);
    const baseRecord = establishBase({
      policyContext,
      space: baseSpace,
      plan,
      topology,
      runId,
      policySpacesCreated,
    });
    const variantRecords = {};
    for (const row of plan.clusters) {
      variantRecords[row.cluster] = establishVariant({
        policyContext,
        space: spaceFor[row.cluster],
        baseSpace,
        cluster: row,
        topology,
        runId,
        workRoot,
        policySpacesCreated,
      });
    }
    check(
      plan.clusters.every((row) =>
        variantRecords[row.cluster].upstream.space === baseSpace
        && variantRecords[row.cluster].upstream.unitLinked === true
        && variantRecords[row.cluster].clusterRef.name === row.cluster
        && variantRecords[row.cluster].clusterRef.kind === "SveltosCluster"),
      "every variant must be linked to the base and name its own cluster",
    );
    const managementVariant = establishManagement({
      policyContext,
      space: spaceFor[plan.management.cluster],
      plan,
      topology,
      runId,
      workRoot,
      policySpacesCreated,
      workloadSpaces: plan.clusters.map((row) => ({
        cluster: row.cluster,
        space: spaceFor[row.cluster],
      })),
    });
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
        && baselineSet.approval.appliedAsOneOperation === true
        && baselineSet.records[plan.management.cluster].release === null,
      "the baseline must be approved as one set operation over five records, and the management record must publish nothing",
    );
    for (const row of plan.clusters) {
      variantRecords[row.cluster].baseline = baselineSet.records[row.cluster];
    }
    managementVariant.baseline = baselineSet.records[plan.management.cluster];
    const bootstrapRecord = applyBootstrapProfiles({
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
        delivery.result === "pass",
        `the ${row.cluster} baseline did not arrive from the gateway in the self-test walk`,
      );
      variantRecords[row.cluster].baseline.delivery = delivery;
    }
    const baseChange = changeBaseRecord({
      policyContext,
      plan,
      workRoot,
      baseSpace,
    });
    check(
      baseChange.revisionId === plan.base.revisions.changed
        && baseChange.publishedAsRelease === false,
      "the base change record changed",
    );

    // The trap: when the merge hands back the variant's own content, the
    // fan-out is refused rather than recorded as promoted.
    hub.state.mergeKeepsDepartureOnly = true;
    expectFailure(
      () => promoteFanOut({
        policyContext,
        managementKubeconfig,
        managementName,
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

    const fanOut = promoteFanOut({
      policyContext,
      managementKubeconfig,
      managementName,
      plan,
      spaceFor,
      runId,
      variantRecords,
    });
    check(
      fanOut.clusters.length === 4
        && fanOut.approval.recordedApprovals === 4
        && fanOut.upgrade.appliedAsOneOperation === true
        && fanOut.operations.oneCommandAcrossSpaces === true
        && new Set(fanOut.clusters.map((row) => row.revisionId)).size === 4
        && new Set(fanOut.clusters.map((row) => row.releaseManifestDigest)).size === 4,
      "the fan-out must reach all four variants in one operation with one approval each",
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
          && record.changed.delivery.profileMatchesApprovedRevision === true,
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
    const pilotRow = plan.clusters.find((row) => row.environment === "pilot");
    expectFailure(
      () => waitForRemoteDeploy({
        managementKubeconfig,
        managementName,
        cluster: pilotRow.cluster,
        profileName: pilotRow.profileName,
        expectedDoc: pilotRow.changedDoc,
        release: variantRecords[pilotRow.cluster].changed.release,
        attempts: 2,
      }),
      /addon controller that gunzips/,
      "gzip fetch refusal",
    );
    cluster.state.failureMode = null;
    cluster.tick();

    // The record half of the zero-drift audit runs against the fake hub for
    // real: the set-aware gate query, the out-of-band re-reads, and the
    // inherited byte identity across the variant records.
    const gateRows = JSON.parse(cub(policyContext, [
      "unit", "list", "--space", "*", "--where", gateQueryWhere,
      "--quiet", "-o", "json",
    ]));
    // The one armed record the sweep may find is the management record's
    // schema-vet gate, which the fake arms the way the live check does.
    check(
      Array.isArray(gateRows)
        && gateRows.length === 1
        && gateRows[0].Unit?.SpaceSlug === spaceFor[plan.management.cluster]
        && Object.keys(gateRows[0].Unit?.ApplyGates ?? {}).join(",")
        === "platform/vet-schemas/vet-schemas",
      "the set-aware gate query found armed gates beyond the management record's schema-vet boundary",
    );
    const storedValues = plan.clusters.map((row) => {
      const current = cubJson(policyContext, [
        "unit", "get", "--space", spaceFor[row.cluster], policyUnit, "-o", "json",
      ]).Unit;
      check(
        current.ContentHash
          === variantRecords[row.cluster].changed.contentHash,
        `the ${row.cluster} record changed out of band in the fake walk`,
      );
      return parseDocs(storedData(current))[0].spec.helmCharts[0].values;
    });
    check(
      storedValues.every((values) => values === storedValues[0]),
      "the inherited values are not identical across the variant records",
    );
    // A rogue unapproved unit under the proof label must surface in the query.
    createPolicySpace(policyContext, "self-test-bulk-rogue");
    cub(policyContext, [
      "unit", "create", "--space", "self-test-bulk-rogue", policyUnit,
      plan.base.path,
      "--label", `Proof=${proofLabel}`,
      "--change-desc", "A rogue record that never clears its gate",
      "--quiet",
    ]);
    sleep(1000);
    const rogueRows = JSON.parse(cub(policyContext, [
      "unit", "list", "--space", "*", "--where", gateQueryWhere,
      "--quiet", "-o", "json",
    ]));
    check(
      rogueRows.length === 2
        && rogueRows.some((row) => row.Unit?.SpaceSlug === "self-test-bulk-rogue"),
      "the set-aware gate query did not surface the rogue armed gate beside the boundary",
    );

    const registrations = plan.fleet.spec.workloads.map((workload) =>
      fakeRegistration(workload));
    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      topology,
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
      bootstrap: bootstrapRecord,
      fanOut,
      checkpoints: synthesizeCheckpoints(plan),
      zeroDriftAudit: synthesizeAudit(plan, managementVariant.space),
      cleanup: {
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
      },
    });
    check(
      verifyReceipt(receipt) === true,
      "the self-test receipt was not recognized as a per-cluster record",
    );
    const summary = renderSummary(receipt);
    check(
      summary.includes(fanOut.clusters.at(-1).releaseManifestDigest)
        && summary.includes(`oci://${configHubOciHost}/space/`)
        && summary.includes(overrideImage)
        && summary.includes("schema-vet boundary alone")
        && summary.includes("Drift repaired | 4/4"),
      "the rendered summary lost its evidence",
    );

    const variantOf = (c, cluster) =>
      c.spec.variants.find((row) => row.cluster === cluster);
    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /proof is not pass/],
      ["source hash", (c) => { c.spec.source.base.rawSha256 = "0".repeat(64); }, /source record changed/],
      ["revision drift", (c) => { c.spec.revisions.clusters["hx-sveltos-env-staging"].changed = "r2-000000000000"; }, /revisions no longer match the reviewed example files/],
      ["base revision drift", (c) => { c.spec.revisions.base.changed = "r2-000000000000"; }, /revisions no longer match the reviewed example files/],
      ["change record", (c) => { c.spec.source.change.after = 9; }, /change record changed/],
      ["continuity", (c) => { c.spec.source.continuity.baselineMatchesChapterFourOutcome = false; }, /continuity record changed/],
      ["policy triggers", (c) => { c.spec.policy.filter.triggerRefs = ["platform/bogus"]; }, /policy record changed/],
      ["sveltos pin", (c) => { c.spec.prerequisite.manifestSha256 = "0".repeat(64); }, /prerequisite record changed/],
      ["controller image dropped", (c) => {
        delete c.spec.prerequisite.addonControllerImage;
        delete c.spec.gatewayDelivery.addonControllerImage;
      }, /must record the addon controller image/],
      ["controller image disagreement", (c) => {
        c.spec.gatewayDelivery.addonControllerImage = `${addonControllerRepository}:v0.0.0`;
      }, /must record the addon controller image/],
      ["base reaches a cluster", (c) => {
        c.spec.base.reachesCluster = true;
        c.spec.base.target = "bitnami-redis-27-0-0-default-pilot-live-20260705/oci-target";
      }, /base record must carry no target and reach no cluster/],
      ["base edit published", (c) => { c.spec.base.change.publishedAsRelease = true; }, /never be published from it/],
      ["variant unlinked", (c) => { variantOf(c, "hx-sveltos-env-staging").upstream.unitLinked = false; }, /not linked to the base record/],
      ["reference names another cluster", (c) => {
        variantOf(c, "hx-sveltos-env-prod-a").clusterRef.name = "hx-sveltos-env-prod-b";
      }, /must name its own SveltosCluster and nothing else/],
      ["reference wrong kind", (c) => {
        variantOf(c, "hx-sveltos-env-prod-a").clusterRef.kind = "Cluster";
      }, /must name its own SveltosCluster and nothing else/],
      ["selector reintroduced", (c) => {
        variantOf(c, "hx-sveltos-env-prod-a").selector = { environment: "prod" };
      }, /must name its own SveltosCluster and nothing else/],
      ["departure dropped", (c) => {
        const variant = variantOf(c, "hx-sveltos-env-prod-b");
        variant.departures = {};
        variant.departedFields = [];
      }, /departures no longer match the reviewed variants record/],
      ["inherited field drift", (c) => { variantOf(c, "hx-sveltos-env-pilot").inheritedFields = []; }, /must inherit the reviewed edit/],
      ["target dropped", (c) => { delete variantOf(c, "hx-sveltos-env-pilot").target; }, /must release to its own cluster's Target/],
      ["target renamed", (c) => { variantOf(c, "hx-sveltos-env-pilot").target.name = "somewhere-else"; }, /must release to its own cluster's Target/],
      ["target provider", (c) => { variantOf(c, "hx-sveltos-env-pilot").target.provider = "Kubernetes"; }, /must release to its own cluster's Target/],
      ["targets shared", (c) => {
        const donor = variantOf(c, "hx-sveltos-env-pilot").target;
        const recipient = variantOf(c, "hx-sveltos-env-staging");
        recipient.target = { ...donor, name: recipient.cluster, ref: `${targetHost.space}/${recipient.cluster}` };
      }, /two variants share a Target/],
      ["shared catalog target reintroduced", (c) => { c.spec.policy.target = { ref: "catalog/oci-target" }; }, /shared catalog target is retired/],
      ["fetch interval", (c) => { c.spec.gatewayDelivery.interval = "24h0m0s"; }, /gateway delivery contract changed/],
      ["gateway host", (c) => { c.spec.gatewayDelivery.host = "registry.example.com"; }, /gateway delivery contract changed/],
      ["secret type", (c) => { c.spec.gatewayDelivery.secret.type = "Opaque"; }, /requires a Secret of type/],
      ["token in the receipt", (c) => { c.spec.gatewayDelivery.secret.tokenRecordedInReceipt = true; }, /requires a Secret of type/],
      ["gateway reference", (c) => {
        c.spec.gatewayDelivery.clusters["hx-sveltos-env-pilot"].reference =
          "oci://registry.example.com/space/hx-sveltos-env-pilot-bulk:latest";
      }, /hx-sveltos-env-pilot gateway reference changed/],
      ["release digest reuse", (c) => {
        const record = c.spec.gatewayDelivery.clusters["hx-sveltos-env-prod-a"];
        record.changedReleaseManifestDigest = record.baselineReleaseManifestDigest;
      }, /own manifest digest/],
      ["management unregistered", (c) => { c.spec.fleet.managementRegistration.ready = false; }, /management cluster must be registered/],
      ["registration shape", (c) => { c.spec.fleet.registrations[3].labels.environment = "staging"; }, /registration record changed/],
      ["fan-out coverage", (c) => {
        c.spec.fanOut.clusters.pop();
      }, /rather than every fleet cluster/],
      ["fan-out approvals statement", (c) => { c.spec.fanOut.approvals = "one approval covered everything"; }, /fan-out record changed/],
      ["fan-out approval count", (c) => { c.spec.fanOut.operations.recordApprovals = 1; }, /fan-out operation counts changed/],
      ["fan-out publish count", (c) => { c.spec.fanOut.operations.releasePublishes = 1; }, /fan-out operation counts changed/],
      ["fan-out one command claim", (c) => { c.spec.fanOut.operations.oneCommandAcrossSpaces = false; }, /fan-out operation counts changed/],
      ["fan-out iterated", (c) => { c.spec.fanOut.upgrade.appliedAsOneOperation = false; }, /one operation/],
      ["approval bracket", (c) => {
        variantOf(c, "hx-sveltos-env-pilot").records[1].beforeApproval.result = "allowed";
      }, /hx-sveltos-env-pilot changed approval record changed/],
      ["approval count", (c) => {
        variantOf(c, "hx-sveltos-env-prod-a").records[0].approval.recordedApprovals = 0;
      }, /hx-sveltos-env-prod-a baseline approval record changed/],
      ["release reference", (c) => {
        variantOf(c, "hx-sveltos-env-staging").records[1].release.reference =
          "oci://oci.hub.confighub.com/space/somewhere-else:latest";
      }, /hx-sveltos-env-staging changed release record changed/],
      ["delivery status", (c) => {
        variantOf(c, "hx-sveltos-env-pilot").records[0].delivery.status = "Failed";
      }, /hx-sveltos-env-pilot baseline gateway delivery record changed/],
      ["delivery digest", (c) => {
        variantOf(c, "hx-sveltos-env-pilot").records[0].delivery.releaseManifestDigest =
          `sha256:${"0".repeat(64)}`;
      }, /hx-sveltos-env-pilot baseline gateway delivery record changed/],
      ["bootstrap rewired", (c) => { c.spec.gatewayDelivery.bootstrap.changedByPromotion = true; }, /left alone by promotion/],
      ["management publishes a release", (c) => {
        variantOf(c, "hx-sveltos-env-mgmt").records[0].release = {
          manifestDigest: `sha256:${"0".repeat(64)}`,
        };
      }, /must not publish a release/],
      ["revision digest reuse", (c) => {
        const variant = variantOf(c, "hx-sveltos-env-prod-b");
        variant.records[1].release.manifestDigest =
          variant.records[0].release.manifestDigest;
        variant.records[1].delivery.releaseManifestDigest =
          variant.records[0].release.manifestDigest;
      }, /hx-sveltos-env-prod-b revision record changed/],
      ["checkpoint set", (c) => { c.spec.checkpoints.pop(); }, /checkpoint set changed/],
      ["checkpoint math", (c) => { c.spec.checkpoints[1].observations[0].expectedBackgroundReplicas = 2; }, /observation for .* changed/],
      ["observation result", (c) => { c.spec.checkpoints[2].observations[0].observation.result = "fail"; }, /observation for .* changed/],
      ["drift repair", (c) => { c.spec.checkpoints[2].observations[1].drift.result = "fail"; }, /drift repair for .* changed/],
      ["armed gate", (c) => { c.spec.zeroDriftAudit.gateQuery.matches = ["rogue-space/clusterprofile"]; }, /zero-drift audit changed/],
      ["stray armed record beside the boundary", (c) => { c.spec.zeroDriftAudit.gateQuery.matches.push("rogue-space/clusterprofile"); }, /zero-drift audit changed/],
      ["boundary unapproved", (c) => { c.spec.zeroDriftAudit.gateQuery.recognizedBoundary.recordedApprovals = 0; }, /zero-drift audit changed/],
      ["boundary gains a second gate", (c) => { c.spec.zeroDriftAudit.gateQuery.recognizedBoundary.gates.push(approvalGate); }, /zero-drift audit changed/],
      ["boundary rewired", (c) => { c.spec.zeroDriftAudit.gateQuery.recognizedBoundary.space = "somewhere-else"; }, /zero-drift audit changed/],
      ["out-of-band record", (c) => { c.spec.zeroDriftAudit.records[1].contentUnchanged = false; }, /zero-drift audit changed/],
      ["values identity", (c) => { c.spec.zeroDriftAudit.valuesIdenticalAcrossRecords = false; }, /zero-drift audit changed/],
      ["cleanup", (c) => { c.spec.cleanup.results.policySpaces = "fail"; }, /cleanup did not pass/],
      ["cleanup kept silently", (c) => {
        c.spec.cleanup.mode = "kept";
        c.spec.cleanup.results.policySpaces = "kept";
      }, /cleanup did not pass/],
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
      "sveltos bulk ops runner self-test passed: the Sveltos pin and its refusal, the addon controller image override, the workload and management registrations, the lowercase Space and Secret type refusals the gateway imposes, the gate preflight pass and its refusal, one base record and four variants and the management record approved as one baseline set and delivered through the gateway to a fake management cluster, the silent departure-win refusal, one fan-out set operation that inherited the edit into every variant, the gzip fetch refusal, the set-aware gate query recognizing the management record's schema-vet gate as the recorded boundary and refusing a rogue armed record beside it, inherited byte identity across the variant records, and the receipt tamper battery",
    );
  } finally {
    commandRunner = realRunner;
    sleeper = realSleeper;
    timeSource = realTime;
    rmSync(workRoot, { recursive: true, force: true });
  }
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

function fakeRegistration(workload) {
  return {
    method: "programmatic SveltosCluster registration",
    namespace: registrationNamespace,
    cluster: workload.cluster,
    kindCluster: `${workload.cluster}-selftest`,
    labels: {
      environment: workload.environment,
      "sveltos-agent": "present",
    },
    credential: {
      type: "short-lived Kubernetes service-account token",
      duration: "2h",
      storedInRepository: false,
      removedWithClusters: true,
    },
    ready: true,
    kubernetesVersion: "v1.35.0",
  };
}

function synthesizeCheckpoints(plan) {
  return ["baseline", "after-fanout", "zero-drift-audit"].map((id) => ({
    id,
    observations: plan.clusters.map((row) => {
      const changed = id !== "baseline";
      const expectedBackgroundReplicas = changed
        ? plan.change.spec.after
        : plan.change.spec.before;
      return {
        cluster: `${row.cluster}-selftest`,
        logicalCluster: row.cluster,
        environment: row.environment,
        expectedRevisionId: changed
          ? row.revisions.changed
          : row.revisions.baseline,
        expectedBackgroundReplicas,
        ...(id === "zero-drift-audit"
          ? {
            drift: {
              result: "pass",
              object: `apps/v1/Deployment/kyverno/${backgroundDeployment}`,
              reviewedReplicas: plan.change.spec.after,
              changedReplicas: 1,
              restoredReplicas: plan.change.spec.after,
              pollAttempts: 3,
              pollIntervalSeconds: 3,
            },
          }
          : {}),
        observation: fakeObservation(expectedBackgroundReplicas),
      };
    }),
  }));
}

function synthesizeAudit(plan, managementSpace) {
  return {
    result: "pass",
    gateQuery: {
      scope: gateQueryScope,
      where: gateQueryWhere,
      matches: [`${managementSpace}/${policyUnit}`],
      recognizedBoundary: {
        space: managementSpace,
        unit: policyUnit,
        gates: ["platform/vet-schemas/vet-schemas"],
        recordedApprovals: 1,
        reason: "the management record's bootstrap profiles carry the gateway's remoteURL extension, which the upstream schema vet does not know, so its schema-vet gate stays armed; the record is approved and publishes no release",
      },
    },
    records: plan.clusters.map((row) => ({
      cluster: row.cluster,
      environment: row.environment,
      space: `${row.cluster}-bulk-selftest`,
      revisionUnchanged: true,
      contentUnchanged: true,
    })),
    valuesIdenticalAcrossRecords: true,
    clusters: plan.clusters.map((row) => ({
      cluster: `${row.cluster}-selftest`,
      logicalCluster: row.cluster,
      environment: row.environment,
      drift: {
        result: "pass",
        object: `apps/v1/Deployment/kyverno/${backgroundDeployment}`,
        reviewedReplicas: plan.change.spec.after,
        changedReplicas: 1,
        restoredReplicas: plan.change.spec.after,
        pollAttempts: 3,
        pollIntervalSeconds: 3,
      },
      observation: fakeObservation(plan.change.spec.after),
    })),
  };
}

function fakeObservation(expectedBackgroundReplicas) {
  return {
    result: "pass",
    clusterSummary: "projectsveltos/self-test-summary",
    helmFeatureStatus: "Provisioned",
    helmRelease: {
      name: "kyverno",
      namespace: "kyverno",
      chart: "kyverno-3.8.2",
      status: "deployed",
    },
    backgroundReplicas: {
      desired: expectedBackgroundReplicas,
      available: expectedBackgroundReplicas,
    },
    deployments: [],
  };
}

function createFakeConfigHub() {
  const filterId = "self-test-filter-0001";
  const targets = new Map();
  const targetKey = (space, slug) => `${space}/${slug}`;

  const resolveTargetRef = (ref, fallbackSpace) => {
    const key = String(ref).includes("/")
      ? String(ref)
      : targetKey(fallbackSpace, ref);
    return targets.get(key) ?? null;
  };
  const triggerIdFor = (ref) => `self-test-trigger-${ref.split("/")[1]}`;
  const spaces = new Map();
  const units = new Map();
  const releases = new Map();
  const pending = new Set();
  // The catalog's infrastructure Space and its long-registered OCI-capable
  // worker exist before any run, so the fake seeds them the way the live
  // organization carries them.
  const workers = new Map([[
    targetKey(targetHost.space, targetHost.worker),
    { supports: new Set(["OCI/Any"]) },
  ]]);
  spaces.set(targetHost.space, {
    Slug: targetHost.space,
    SpaceID: `self-test-space-${targetHost.space}`,
    TriggerIDs: [],
    ReleaseTargetID: null,
    TriggerFilterID: filterId,
  });
  let releaseSequence = 0;
  const state = {
    refuseUpstreamLink: false,
    severUpstreamLineage: false,
    mergeKeepsDepartureOnly: false,
    neverPopulateGates: false,
    approveFails: false,
    stripReleaseManifestDigest: false,
    triggerIdOverride: null,
    releaseTargetOverride: null,
  };
  const unitKey = (space, slug) => `${space}/${slug}`;
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
  const labelsFrom = (labels) => Object.fromEntries(
    [labels ?? []].flat().map((pair) => {
      const at = String(pair).indexOf("=");
      return [String(pair).slice(0, at), String(pair).slice(at + 1)];
    }),
  );
  const projectUnit = (unit) => {
    const { history, UpstreamUnitKey, snapshot, ...rest } = unit;
    return structuredClone(rest);
  };
  const store = (unit, text) => {
    unit.Data = Buffer.from(text).toString("base64");
    unit.ContentHash = sha256(text);
    unit.history.set(unit.HeadRevisionNum, text);
  };
  const dataOf = (unit) => Buffer.from(unit.Data, "base64").toString("utf8");
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
    // The live schema vet refuses the gateway's remoteURL extension and its
    // gate stays armed regardless of approvals, so the fake says the same
    // thing and the audit's boundary recognition is exercised, not skipped.
    if (!state.neverPopulateGates) {
      for (const unit of units.values()) {
        if (dataOf(unit).includes("remoteURL")) {
          unit.ApplyGates = {
            ...unit.ApplyGates,
            "platform/vet-schemas/vet-schemas": true,
          };
        }
      }
    }
  };
  const ok = (output) => ({ ok: true, status: 0, output, error: "" });
  const refuse = (error) => ({ ok: false, status: 1, output: "", error });
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
      });
      return ok("");
    }
    if (entity === "space" && verb === "update") {
      const row = spaces.get(rest[0]);
      if (!row) return refuse(`space ${rest[0]} not found`);
      if (flags["release-target"]) {
        const target = resolveTargetRef(flags["release-target"], rest[0]);
        if (!target) return refuse(`release target ${flags["release-target"]} not found`);
        row.ReleaseTargetID = state.releaseTargetOverride ?? target.TargetID;
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
    if (entity === "target" && verb === "create") {
      const [slug, , workerSlug] = rest;
      if (!spaces.has(flags.space)) return refuse(`space ${flags.space} not found`);
      if (!workerSlug) return refuse("BridgeWorkerID is required");
      const worker = workers.get(targetKey(flags.space, workerSlug));
      if (!worker) return refuse(`worker ${workerSlug} not found in ${flags.space}`);
      const configType = `${flags.provider ?? "Kubernetes"}/${flags.toolchain ?? "Any"}`;
      if (!worker.supports.has(configType)) {
        return refuse(`BridgeWorker does not support ConfigType with ProviderType '${flags.provider}', ToolchainType '${flags.toolchain}'`);
      }
      if (targets.has(targetKey(flags.space, slug))) {
        return flags["allow-exists"]
          ? ok("")
          : refuse(`target ${slug} already exists`);
      }
      targets.set(targetKey(flags.space, slug), {
        Slug: slug,
        SpaceSlug: flags.space,
        WorkerSlug: workerSlug,
        TargetID: `self-test-target-${flags.space}-${slug}`,
        ProviderType: flags.provider ?? "Kubernetes",
        ToolchainType: flags.toolchain ?? "Any",
      });
      return ok("");
    }
    if (entity === "target" && verb === "get") {
      const row = resolveTargetRef(rest[0], flags.space);
      if (!row) return refuse(`target ${flags.space}/${rest[0]} not found`);
      return ok(JSON.stringify({ Target: structuredClone(row) }));
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
    // One verb clones the Space and every unit in it, links each clone to its
    // upstream, stamps the Variant label, and copies the approval wiring from
    // the upstream Space. The release target is deliberately not copied, which
    // is why the runner sets it afterwards.
    if (entity === "variant" && verb === "create") {
      const [variantName, upstreamSlug] = rest;
      const upstream = spaces.get(upstreamSlug);
      if (!upstream) return refuse(`upstream space ${upstreamSlug} not found`);
      const pattern = String(flags["space-pattern"] ?? "");
      if (!pattern.startsWith("template:") || pattern.includes("{{")) {
        return refuse(`the self-test fake hub resolves only literal space patterns, not ${pattern || "a derived slug"}`);
      }
      const slug = pattern.slice("template:".length);
      if (spaces.has(slug)) return refuse(`space ${slug} already exists`);
      spaces.set(slug, {
        Slug: slug,
        SpaceID: `self-test-space-${slug}`,
        TriggerIDs: state.triggerIdOverride ?? [...upstream.TriggerIDs],
        ReleaseTargetID: null,
        TriggerFilterID: upstream.TriggerFilterID,
        Labels: { ...(upstream.Labels ?? {}), Variant: variantName },
      });
      for (const [key, row] of [...units.entries()]) {
        if (row.SpaceSlug !== upstreamSlug) continue;
        const clone = {
          Slug: row.Slug,
          SpaceSlug: slug,
          UnitID: `self-test-unit-${slug}-${row.Slug}`,
          UpstreamUnitID: state.refuseUpstreamLink ? null : row.UnitID,
          UpstreamSpaceID: `self-test-space-${upstreamSlug}`,
          UpstreamUnitKey: key,
          UpstreamRevisionNum: row.HeadRevisionNum,
          TargetID: null,
          Labels: { ...(row.Labels ?? {}) },
          history: new Map(),
          HeadRevisionNum: 1,
          ApplyGates: { "awaiting/triggers": true },
          ApprovedBy: [],
        };
        store(clone, dataOf(row));
        units.set(unitKey(slug, row.Slug), clone);
        pending.add(unitKey(slug, row.Slug));
      }
      return ok("");
    }
    if (entity === "unit" && verb === "set-target") {
      const key = unitKey(flags.space, rest[0]);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      const target = resolveTargetRef(rest[1], flags.space);
      if (!target) return refuse(`target ${rest[1]} not found`);
      unit.TargetID = target.TargetID;
      return ok("");
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
    if (entity === "unit" && verb === "list") {
      if (flags.space !== "*") return refuse("the set query needs --space \"*\"");
      // The zero-drift audit asks a different question from the fan-out: not
      // which units match a label set, but which units still carry an armed
      // gate anywhere under the proof label.
      if (String(flags.where ?? "").includes("LEN(ApplyGates) > 0")) {
        const rows = [...units.values()]
          .filter((unit) =>
            unit.Labels?.Proof === proofLabel
            && Object.keys(unit.ApplyGates ?? {}).length > 0)
          .map((unit) => ({ Unit: projectUnit(unit) }));
        return ok(JSON.stringify(rows));
      }
      const selected = matching(flags.where);
      if (!selected) return refuse(`unsupported where expression ${flags.where}`);
      return ok(JSON.stringify(selected.map((unit) => ({ Unit: projectUnit(unit) }))));
    }
    if (entity === "unit" && verb === "create") {
      const [slug, path] = rest;
      const key = unitKey(flags.space, slug);
      // A variant is created as a clone of its base, so this form carries an
      // upstream unit instead of a file, and the clone starts as a byte copy
      // of what the base holds.
      const upstreamKey = flags["upstream-unit"]
        ? unitKey(flags["upstream-space"], flags["upstream-unit"])
        : null;
      if (upstreamKey && !units.has(upstreamKey)) {
        return refuse(`upstream unit ${upstreamKey} not found`);
      }
      const data = upstreamKey
        ? dataOf(units.get(upstreamKey))
        : readFileSync(path, "utf8");
      const unit = {
        Slug: slug,
        SpaceSlug: flags.space,
        UnitID: `self-test-unit-${flags.space}-${slug}`,
        UpstreamUnitID: upstreamKey && !state.refuseUpstreamLink
          ? units.get(upstreamKey).UnitID
          : null,
        UpstreamSpaceID: upstreamKey ? `self-test-space-${flags["upstream-space"]}` : null,
        UpstreamUnitKey: upstreamKey,
        UpstreamRevisionNum: upstreamKey
          ? units.get(upstreamKey).HeadRevisionNum
          : 0,
        TargetID: flags.target ? resolveTargetRef(flags.target, flags.space)?.TargetID ?? null : null,
        Labels: labelsFrom(flags.label),
        history: new Map(),
        HeadRevisionNum: 1,
        ApplyGates: { "awaiting/triggers": true },
        ApprovedBy: [],
      };
      store(unit, data);
      units.set(key, unit);
      pending.add(key);
      return ok("");
    }
    // A label patch on one unit is a metadata change: the labels merge and the
    // stored revision is untouched, so the gate and approval state stay as
    // they were.
    if (entity === "unit" && verb === "update" && flags.patch && flags.space !== "*") {
      const key = unitKey(flags.space, rest[0]);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      if (flags.upgrade) return refuse("the self-test fake hub upgrades sets, not single units");
      unit.Labels = { ...(unit.Labels ?? {}), ...labelsFrom(flags.label) };
      return ok(JSON.stringify({ Unit: projectUnit(unit) }));
    }
    if (entity === "unit" && verb === "update" && flags.patch) {
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
    if (entity === "unit" && verb === "get") {
      const key = unitKey(flags.space, rest[0]);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      if (flags.select) {
        const projection = {};
        for (const field of flags.select.split(",")) {
          projection[field] = structuredClone(unit[field]);
        }
        return ok(JSON.stringify(projection));
      }
      return ok(JSON.stringify({ Unit: structuredClone(unit) }));
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
        .filter((unit) => unit.SpaceSlug === spaceSlug)
        .sort((left, right) => left.Slug.localeCompare(right.Slug));
      const digestInput = rows
        .map((unit) => `${unit.Slug}:${unit.ContentHash}:${unit.HeadRevisionNum}`)
        .join("|");
      releaseSequence += 1;
      const manifestDigest = state.stripReleaseManifestDigest
        ? ""
        : `sha256:${sha256(`manifest:${spaceSlug}:${releaseSequence}:${digestInput}`)}`;
      // The gateway serves what was published, so the fake keeps the published
      // bytes and the fake cluster reads them back through the tag.
      releases.set(spaceSlug, {
        manifestDigest,
        data: rows
          .map((unit) => Buffer.from(unit.Data, "base64").toString("utf8"))
          .join("\n---\n"),
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
    filterId,
  };
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
  const booleans = new Set(["--quiet", "--wait", "--patch", "--refresh-triggers", "--recursive-force", "--upgrade"]);
  const repeatable = new Set(["label"]);
  const positionals = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (booleans.has(token)) {
      flags[token.slice(2)] = true;
      continue;
    }
    const name = token.replace(/^--?/, "");
    if (repeatable.has(name)) flags[name] = [...(flags[name] ?? []), args[index + 1]];
    else flags[name] = args[index + 1];
    index += 1;
  }
  return { positionals, flags };
}

// The fake management cluster answers the reads the runner makes and, once a
// bootstrap profile points it at a Space, serves whatever that Space last
// published. Publishing again moves the tag, and the next poll picks it up,
// which is exactly how a patch wave reaches the cluster on the live path.
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
