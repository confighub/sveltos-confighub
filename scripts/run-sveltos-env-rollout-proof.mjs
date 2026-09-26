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
import { dirname, join } from "node:path";

import {
  applyDepartures,
  governedRecords,
  canonicalValue,
  isScalarMap,
  parentPath,
  assertUpstreamLineage as assertLineageFromMutations,
  canonicalDocs,
  fieldsCollide,
  identity,
  normalizeDigest,
  pendingApplyGate,
  readPath,
  sameSet,
  spaceName,
  storedData,
  waveUnlockEvidence,
  writeDocuments,
  writePath,
  writeStoredDocuments,
  preloadSveltosImages,
  knownCubCommand,
  manifestImages,
  retiredApprovalLaneMarker,
  runScopedComponents,
  sveltosAgentPreloaded,
  sveltosPreloadList,
  unknownCubFlag,
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
// Every Space the run creates is still wired to the platform trigger filter,
// because its validating triggers still run: schema, placeholder, and the
// other catalog checks. Approval is no longer one of them. ConfigHub removed
// the old approval mechanism on 2026-09-25 (confighubai/confighub#5495),
// and with it the platform/require-approval trigger this filter used to
// resolve. Which triggers the filter resolves is read live, never assumed.
const gateFilterRef = "platform/helm-catalog-prod-gates";
const retiredApprovalTrigger = "platform/require-approval";
const pendingReason = "the attestation design has not been recorded live yet";
const policyPath = join(
  repoRoot,
  "config-catalog",
  "policies",
  "catalog-standard.yaml",
);
// The triggers the committed profile defines. A resolved trigger must be one
// of them, and the retired approval trigger must not be among those resolved.
const catalogTriggerRefs = readYaml(policyPath).spec.triggerDefinitions
  .map((item) => item.ref)
  .sort();
// The gateway answers on the bare host. The reference the probe recorded as
// working carries no port, so every reference this runner builds carries none.
const configHubOciHost = "oci.hub.confighub.com";
const probeRecord = "docs/planning/remote-url-oci-probe.md";
const exampleRoot = join(repoRoot, "examples", "sveltos", "env-rollout");
const changePath = join(exampleRoot, "change-candidate.yaml");
const variantsPath = join(exampleRoot, "variants.yaml");
const workflowPath = join(exampleRoot, "change-workflow.yaml");
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
const gatewaySecretName = "confighub-gateway";
const gatewaySecretType = "addons.projectsveltos.io/cluster-profile";
const gatewaySecretKey = "token";
const addonControllerRepository = "docker.io/projectsveltos/addon-controller";
// Each wave is a stage of one ConfigHub ChangeWorkflow per run, created from
// the reviewed file examples/sveltos/env-rollout/change-workflow.yaml. A stage
// selects the variants of the run's component whose Space carries that Stage
// label, and the server enforces two kinds of gate, for every client:
//
// - Prerequisites, evaluated over every Space of the stage ahead when a
//   promotion into the stage is attempted. Staging and prod declare Released:
//   the stage ahead must have published a release carrying the change.
// - ReleasePrerequisites, evaluated over the Revisions a release bundles when
//   a release of a change order is published into one of the stage's Spaces.
//   Every stage declares the approval requirement: one Approval attestation.
//
// Healthy is deliberately not declared, for the reason recorded in every
// receipt.
const entryPrerequisites = ["Released"];
const approvalRequirement = "approval";
// The runs are single-operator, and ConfigHub counts the user who promoted a
// change into a Space as one of its authors there, so under the default
// separation of duties that user's own approval does not count. The workflow
// therefore sets AllowAuthors: true, and every receipt says so, quoting what
// the strict setting did when it was measured.
const separationOfDutiesStatement = "This single-operator demo relaxes separation of duties: its approval requirement sets AllowAuthors: true, so the operator who promoted a change may also approve it. A production workflow sets AllowAuthors: false and has a second approver sign off, because ConfigHub counts whoever promoted a change into a Space as one of its authors there and does not count an author's approval.";
const strictModeRefusal = "unable to publish a release of change order '<change-order>' in stage '<stage>': requires approval: 1 Approval attestation(s) from eligible attesters who did not write the change; <unit> revision <n> has 0 of 1";
const strictModeMeasuredOn = "2026-09-26";
// Measured on 2026-09-26: a component can declare that its promotions and
// releases require a ChangeWorkflow, and ConfigHub records the declaration,
// but a plain publish of one of its Spaces, outside any change order,
// still succeeded. The runner declares it to state the intent and records
// that it is not enforced there yet.
const workflowRequiredNote = "Declared on the run's component to state that its promotions and releases go through this workflow. Measured on 2026-09-26, ConfigHub does not yet refuse a plain publish of one of its Spaces outside a change order, so every release in this run goes through a change order because the runner sends it there, not because the server would refuse the other path.";
const healthyNotDeclaredReason = "Healthy reads the confighub.com/live-status annotation and passes only on the literal words Synced, Succeeded and Healthy. Sveltos has no reporter that writes it yet (confighub/sveltos-confighub#33), and ConfigHub does not yet recognise the provider (confighubai/confighub#5049), so declaring it would hold every stage forever. Until both exist, the checkpoint evidence each wave records as unlockedBy is the observed-health layer.";
const managementComponentReason = "The management Space is not a variant of the base, and a change order's scope is every Space attached to its base's component, so the management Space has a run-scoped component of its own: it keeps a home in the component view and never sits in a change order's scope.";
const baseComponentReason = "Recorded Spaces from earlier runs are kept on purpose, and a change order's scope is every Space attached to its base's component, so the component is per run: a component shared across runs would put an earlier run's variants in this change order's scope, where a promotion into a stage would reach them.";
const workflowSlug = (runId) => `rollout-${runId}`;
// Short on purpose: the server's refusal names the change order, and error
// text passes through a redaction that hides any run of forty or more
// identifier characters.
const changeOrderSlug = (runId) => `bg-replicas-${runId}`;
// The baseline is released through a change order of its own, one that
// carries no change to the base, so every release that reaches a cluster in
// this run passes the approval gate. Promoting it marks each variant's own
// reviewed head, and the release pinned to it bundles exactly that.
const baselineOrderSlug = (runId) => `baseline-${runId}`;
const baselinePath = "baseline change order";
const promoteCommand = (stage) =>
  `cub variant promote --change-order <base-space>/<change-order> --target-stage ${stage}`;
const releaseCommand = "cub release publish <space> --revision ChangeOrder:<change-order>";
const stageApprovalCommand = (stage) =>
  `cub variant approve --change-order <base-space>/<change-order> --stage ${stage}`;
const managementApprovalCommand = "cub variant approve <management-space>";
const managementUngatedReason = "The management record is applied out of band with kubectl, because it is what opens the gateway path, and no release of it is published, so no release gate reads its approval. It is recorded as an attestation all the same, and nothing server-side gates it.";
// What every wave of a receipt recorded before this design carries instead of
// a promotion: the set upgrade the runner issued itself.
const recordedUpgradeCommand = 'cub unit update --patch --space "*" --where <query> --upgrade';

// The chapters differ in what they prove, not in how a governed record works,
// so the record machinery comes from one place and is told this chapter's own
// labels and hub access.
const {
  assertMergeKeptDepartures,
  assertPolicySpace,
  assertUpstreamLineage,
  attemptGatedRelease,
  attestUnpublishedRecord,
  attestedReleaseSet,
  createChangeOrder,
  createChangeWorkflowFromFile,
  createComponent,
  createPolicySpace,
  establishBase,
  establishClusterTarget,
  establishVariant,
  gatewayReference,
  promoteStage,
  publishRelease,
  releaseGateRefused,
  requireChangeWorkflow,
  selectSet,
  waitForTriggers,
  applyBootstrapProfiles,
  bootstrapProfileManifest,
  bootstrapProfileName,
  establishManagement,
} = governedRecords({
  stableJson: (...args) => stableJson(...args),
  // What this chapter's reviewed change looks like once merged: the values
  // change carried inside the chart values blob, at the reviewed path.
  changedDocOf: (cluster) => cluster.changedDoc,
  changeInherited: (merged, plan) =>
    readPath(valuesOf(merged), plan.change.spec.valuesPath)
      === plan.change.spec.after,
  cub: (...args) => cub(...args),
  cubJson: (...args) => cubJson(...args),
  cubTry: (...args) => cubTry(...args),
  sleep: (...args) => sleep(...args),
  appLabel: "sveltos-kyverno-env-rollout",
  bootstrapPrefix: "sveltos-env-rollout",
  clusterCommand: (...args) => clusterCommand(...args),
  gatewaySecretName,
  managementRecordLabel: "management",
  registrationNamespace,
  remoteFetchInterval,
  // The lib's name for the filter every Space is wired to. It resolves only
  // validating triggers now; no approval gate is passed, because chapter
  // three no longer has one.
  approvalFilterRef: gateFilterRef,
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
  now: (...args) => now(...args),
});

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
    verifyReceipt(receipt),
    `${relativeRepo(receiptPath)} predates the current design; record a live run before regenerating its summary`,
  );
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos environment rollout has no live receipt yet; no live run has been recorded yet, because ${pendingReason}`,
  );
} else {
  const receipt = readYaml(receiptPath);
  // A superseded receipt is kept as recorded, so its committed summary is
  // kept as recorded too rather than being regenerated against the new shape.
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
  console.log("verified the Sveltos environment rollout proof");
}

// The recorded run governed one record per environment, so its receipt keys
// everything by environment and carries no variant list. The verify lane keeps
// reading it until the per-cluster design is recorded live, so the old shape is
// recognized and left alone instead of being checked against a contract it
// predates or silently rewritten.
function supersededReceipt(receipt) {
  return !Array.isArray(receipt?.spec?.variants);
}

// A receipt recorded before the ChangeWorkflow design moved its waves itself:
// every wave carries the set upgrade the runner issued and nothing records a
// component, a workflow, or a change order. That is the shape of the receipt
// committed on 2026-08-21. It is recognized by that shape, so a receipt of the
// current design that merely lost its change management is refused as a
// tamper rather than waved through as an old recording.
function predatesChangeWorkflow(receipt) {
  const waves = receipt?.spec?.waves ?? [];
  return receipt?.spec?.changeManagement === undefined
    && waves.length > 0
    && waves.every((wave) =>
      wave.upgrade?.command === recordedUpgradeCommand
      && wave.promotion === undefined);
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
  assertAddonControllerFitsPin(sveltos, addonControllerImage);
  assertAttestationClient();

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
  // A Space is removed before the Space it depends on: every variant before
  // the base it was cloned from, whose units its upstream links point at.
  const spaceRemovalOrder = [...Object.values(spaceFor), baseSpace];
  // One component per run for the base and its variants, and one per run for
  // the management Space. Both are run-scoped for the reasons the receipt
  // records under changeManagement.
  const components = runScopedComponents(componentLabel, runId);
  const cleanup = {
    mode: keepArtifacts ? "kept" : "removed",
    keptDeliberately: keepArtifacts,
    results: {
      probeSpace: "pending",
      managementCluster: "not-created",
      workloadClusters: "not-created",
      policySpaces: "not-created",
      components: "not-created",
      localFiles: "pending",
    },
    kept: [],
  };
  let managementStarted = false;
  const workloadsStarted = new Set();
  const policySpacesCreated = new Set();
  const componentsCreated = new Set();
  let receipt;

  // The gates are probed before any cluster work, so a filter that no longer
  // resolves what the run expects, or a server that does not keep an
  // attestation requirement, costs seconds, not the seven-minute fleet build.
  const topology = probeGates(policyContext, runId, plan);
  // Creating the management cluster's Target up front is the target-host
  // preflight: it is idempotent, the record establishment needs it anyway,
  // and a host worker that cannot mint OCI targets refuses here in seconds
  // rather than after the fleet build.
  establishClusterTarget(policyContext, "hx-sveltos-env-mgmt");
  cleanup.results.probeSpace = "pass";
  phase(`gate preflight passed: ${gateFilterRef} resolves ${topology.triggerRefs.length} validating triggers and no approval trigger, and ConfigHub keeps a workflow's approval requirement`);

  try {
    for (const space of policySpaces) {
      check(!spacePresent(policyContext, space), `refusing to reuse ${space}`);
    }
    for (const slug of [components.base, components.management]) {
      check(
        !componentPresent(policyContext, slug),
        `refusing to reuse the component ${slug}; a component shared across runs would put another run's variants in this change order's scope`,
      );
    }
    for (const row of [managementName, ...fleetClusters.map((item) => item.cluster)]) {
      check(!clusterPresent(row), `refusing to reuse the kind cluster ${row}`);
    }
    // The pinned manifest is fetched and checked against the lock before any
    // cluster exists, because its own image lines are the preload list.
    const pinnedManifest = fetchPinnedManifest({ workRoot, sveltos });

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

    const preloadedImages = preloadSveltosImages({
      clusters: [managementName, ...fleetClusters.map((row) => row.cluster)],
      version: sveltos.version,
      addonControllerImage,
      images: manifestImages(pinnedManifest),
    });
    phase(`the ${preloadedImages.length} images the pinned manifest names loaded into every cluster from the local daemon`);

    const sveltosInstall = {
      ...installSveltos({
        managementKubeconfig,
        workRoot,
        sveltos,
        addonControllerImage,
        pinnedManifest,
      }),
      imagePreload: imagePreloadRecord(sveltos, preloadedImages),
    };
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
    cleanup.results.components = "pending";
    createComponent(policyContext, components.base, runId);
    componentsCreated.add(components.base);
    const baseRecord = establishBase({
      policyContext,
      space: baseSpace,
      plan,
      topology,
      runId,
      policySpacesCreated,
      component: components.base,
    });
    phase(`the base record holds the content every cluster shares, in the run's own component ${components.base}`);

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
        stage: row.environment,
      });
    }
    phase("four per-cluster variants cloned from the base, each carrying its own departures and its environment as its stage");

    createComponent(policyContext, components.management, runId);
    componentsCreated.add(components.management);
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
      component: components.management,
    });
    phase("the management record holds one bootstrap profile per workload Space, in a component of its own");

    const membership = assertComponentMembership({
      policyContext,
      baseSpace,
      spaceFor,
      plan,
      components,
    });
    const workflow = openChangeWorkflow({
      policyContext,
      baseSpace,
      plan,
      runId,
      component: components.base,
    });
    phase(`the ChangeWorkflow ${workflow.ref} holds the stages ${workflow.stages.join(", ")}, every one gated at release on one Approval attestation`);

    const baselineRelease = releaseBaseline({
      policyContext,
      baseSpace,
      plan,
      runId,
      spaceFor,
      workflow,
      membership,
      managementVariant,
    });
    for (const row of plan.clusters) {
      variantRecords[row.cluster].baseline = baselineRelease.records[row.cluster];
    }
    managementVariant.baseline = baselineRelease.management;
    phase(`every variant's baseline passed its release gate through the ${baselineRelease.changeOrder.slug} change order, stage by stage, and the management record's approval is recorded`);

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

    const changeOrder = openChangeOrder({
      policyContext,
      baseSpace,
      plan,
      runId,
      workflow,
      membership,
      baseChange,
    });
    phase(`the change order ${changeOrder.ref} captured the edit, headed for exactly the base and its four variants`);

    const gateRefusal = assertStageGateRefuses({
      policyContext,
      plan,
      changeOrder,
      spaceFor,
    });
    phase(`ConfigHub refused to promote into ${gateRefusal.targetStage} before ${gateRefusal.stageAhead} released the change: ${gateRefusal.message}`);

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
        checkpoints,
        changeOrder,
        membership,
      }));
      checkpoints.push(recordCheckpoint({
        id: `after-wave-${wave.wave}`,
        completedWaves: wave.wave,
        plan,
        fleetClusters,
        managementKubeconfig,
      }));
      phase(`wave ${wave.wave} promoted the change order into the ${wave.environment} stage, ${wave.clusters.length} variant(s): release refused until approved, approved, released, and observed`);
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
      managementName,
      managementRegistration,
      sveltosInstall,
      gatewayCredential,
      registrations,
      baseRecord,
      baseChange,
      baselineRelease,
      variantRecords,
      managementVariant,
      bootstrap,
      waveRecords,
      checkpoints,
      convergenceAudit,
      cleanup,
      changeManagement: {
        membership,
        workflow,
        changeOrder,
        gateRefusal,
      },
    });
  } finally {
    if (keepArtifacts) {
      phase("keeping the clusters, the Spaces, and the components, because the keep-alive flag is set");
      cleanup.results.managementCluster = "kept";
      cleanup.results.workloadClusters = "kept";
      cleanup.results.policySpaces = "kept";
      cleanup.results.components = componentsCreated.size > 0
        ? "kept"
        : "not-created";
      cleanup.kept = [
        ...[managementName, ...fleetClusters.map((row) => row.cluster)]
          .filter((name) => clusterPresent(name))
          .map((name) => ({
            kind: "kind cluster",
            name,
            removeWith: `kind delete cluster --name ${name}`,
          })),
        ...spaceRemovalOrder
          .filter((space) =>
            policySpacesCreated.has(space) || spacePresent(policyContext, space))
          .map((space) => ({
            kind: "ConfigHub Space",
            name: space,
            removeWith: `cub space delete ${space} --recursive-force`,
          })),
        // A component outlives its Spaces, so it is listed after them and
        // removed last.
        ...[components.base, components.management]
          .filter((slug) => componentsCreated.has(slug))
          .map((slug) => ({
            kind: "ConfigHub Component",
            name: slug,
            removeWith: `cub component delete ${slug}`,
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

      for (const space of spaceRemovalOrder) {
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

      // The components go last, once no Space is attached to them. The
      // workflow and the change order lived in the base Space and went with it.
      for (const slug of [components.base, components.management]) {
        if (componentsCreated.has(slug) || componentPresent(policyContext, slug)) {
          cubTry(policyContext, ["component", "delete", slug, "--quiet"]);
        }
      }
      cleanup.results.components = [components.base, components.management]
        .some((slug) => componentPresent(policyContext, slug))
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

// The two-minute check that this organization still has what chapter three
// gates on: the platform trigger filter, resolving validating triggers and no
// approval trigger, and a server that keeps a ChangeWorkflow's attestation
// requirement. It wires one throwaway Space, creates the reviewed workflow in
// it, reads both back, and removes the Space. A passing probe unblocks the
// chapter three lane; the other chapters' lanes refuse to start until they
// move to attestations.
function probeGate() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  check(policyContext, "set CUB_CONTEXT to an authenticated helm-catalog context");
  check(tryCommand("cub", ["version"]).ok, "cub is required for this probe");
  assertAttestationClient();
  const policyContextInfo = cubJson(policyContext, [
    "context", "get", policyContext, "-o", "json",
  ]);
  check(
    policyContextInfo.metadata?.organizationName === expectedPolicyOrg,
    `refusing to create probe evidence outside ${expectedPolicyOrg}`,
  );
  const runId = safeRunId(new Date().toISOString());
  const topology = probeGates(policyContext, runId, loadRolloutPlan());
  console.log(
    `${gateFilterRef} resolves ${topology.triggerRefs.join(", ")} and no approval trigger, and ConfigHub keeps the reviewed workflow's approval requirement; run the fleet lanes serially`,
  );
}

// The local cub must be one that records approvals as attestations. A client
// from before them has no --change-order on variant approve, and the lane
// would fail at its first approval after building a fleet.
function assertAttestationClient() {
  const help = tryCommand("cub", ["variant", "approve", "--help"]);
  check(
    help.ok
      && /--change-order/.test(help.output)
      && /--stage/.test(help.output),
    "this cub cannot record an approval of a change order in a stage (cub variant approve --change-order --stage); update cub before a live run",
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
  check(
    baseDoc.kind === "ClusterProfile"
      && typeof baseDoc.metadata?.name === "string"
      && Array.isArray(baseDoc.spec?.clusterRefs)
      && baseDoc.spec.clusterRefs.length === 0
      && baseDoc.spec?.clusterSelector === undefined,
    "the base profile must carry an empty clusterRefs list, no clusterSelector, and reach no cluster",
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
    const addressing = ["metadata.name", "spec.clusterRefs"];
    const refs = departures["spec.clusterRefs"];
    check(
      Array.isArray(refs) && refs.length === 1
        && refs[0]?.kind === "SveltosCluster"
        && refs[0]?.apiVersion === "lib.projectsveltos.io/v1beta1"
        && refs[0]?.name === row.cluster
        && refs[0]?.namespace === registrationNamespace
        && typeof departures["metadata.name"] === "string"
        && departurePaths.some((path) => !addressing.includes(path)),
      `${row.cluster} must depart on a clusterRefs list naming its own SveltosCluster, its own name, and at least one field beyond addressing`,
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
      clusterRef: refs[0],
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
  const workflow = loadChangeWorkflow(join(planRoot, "change-workflow.yaml"), waves);

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
    workflow,
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

// The reviewed workflow is configuration like the rest of the plan, so its
// shape is checked against the waves before anything is built: one stage per
// wave, in wave order, each selecting its environment's Stage label; the
// Released entry gate on every stage after the first; the approval
// requirement on every stage's release; and that requirement exactly one
// Approval attestation with AllowAuthors set, which the single-operator demo
// needs and every receipt states. Healthy is named nowhere.
function loadChangeWorkflow(path, waves) {
  const text = readFileSync(path, "utf8");
  const spec = readYaml(path);
  const requirements = spec?.AttestationPrerequisites ?? [];
  const stages = spec?.Stages ?? [];
  check(
    requirements.length === 1
      && requirements[0].Name === approvalRequirement
      && requirements[0].Type === "Approval"
      && Number(requirements[0].Count) === 1
      && requirements[0].AllowAuthors === true,
    `the reviewed workflow must declare one requirement, ${approvalRequirement}: one Approval attestation with AllowAuthors: true, which a single-operator run needs and its receipt states`,
  );
  check(
    stages.map((stage) => stage.Name).join(",")
      === waves.map((wave) => wave.environment).join(","),
    `the reviewed workflow's stages must be the waves in order: ${waves.map((wave) => wave.environment).join(", ")}`,
  );
  stages.forEach((stage, index) => {
    check(
      stage.WhereSpace === `Labels.Stage = '${stage.Name}'`,
      `the ${stage.Name} stage must select the Spaces labelled Stage=${stage.Name}`,
    );
    check(
      stableJson(stage.ReleasePrerequisites ?? []) === stableJson([approvalRequirement]),
      `the ${stage.Name} stage must gate its releases on ${approvalRequirement}, and on nothing else`,
    );
    check(
      stableJson(stage.Prerequisites ?? [])
        === stableJson(index === 0 ? [] : entryPrerequisites),
      index === 0
        ? `the first stage's entry prerequisites are never evaluated, so ${stage.Name} declares none`
        : `the ${stage.Name} stage must be entered only once the stage ahead has ${entryPrerequisites.join(", ")} the change`,
    );
  });
  check(
    !/\bHealthy\b/.test(text),
    "the reviewed workflow must not declare Healthy until a Sveltos status reporter exists (#33) and ConfigHub recognises the provider (confighubai/confighub#5049)",
  );
  return {
    path,
    repoPath: relativeRepo(path),
    rawSha256: sha256(text),
    spec,
    stages: stages.map((stage) => stage.Name),
    requirement: requirements[0],
  };
}

// A variant is the base with its declared departures written over it. Every
// departure names a field of the profile, which is the granularity ConfigHub
// merges at when a later base change flows down.

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
// fetch path the earlier chapters were recorded without. The lock also says
// whether that release's own addon controller reads the gateway's gzipped
// layers, which decides whether a run may override the controller image.
function loadSveltosPin(path = sourceLockPath) {
  const lock = readYaml(path);
  const sveltos = lock.spec?.sveltos ?? {};
  check(
    lock.kind === "SveltosEnvRolloutLock"
      && /^v\d+\.\d+\.\d+$/.test(String(sveltos.version ?? ""))
      && /^[0-9a-f]{64}$/.test(String(sveltos.manifestSha256))
      && String(sveltos.manifestUrl ?? "").includes(String(sveltos.version ?? " "))
      && typeof sveltos.releasedControllerReadsGatewayLayers === "boolean",
    "the environment rollout lock lost its Sveltos pin or its word on whether the released addon controller reads the gateway's layers",
  );
  return {
    version: String(sveltos.version),
    manifestUrl: String(sveltos.manifestUrl),
    manifestSha256: String(sveltos.manifestSha256),
    releasedControllerReadsGatewayLayers:
      sveltos.releasedControllerReadsGatewayLayers,
  };
}

function pinnedAddonControllerImage(sveltos) {
  return `${addonControllerRepository}:${sveltos.version}`;
}

// A pin whose released addon controller reads the gateway's layers runs that
// controller as released, and its receipt says so. An override there would
// record a run the verifier refuses, so the run refuses it before building
// anything. The override mechanism itself stays, for a pin that needs it.
function assertAddonControllerFitsPin(sveltos, addonControllerImage) {
  check(
    !sveltos.releasedControllerReadsGatewayLayers
      || addonControllerImage === pinnedAddonControllerImage(sveltos),
    `the pinned Sveltos ${sveltos.version} addon controller reads the gateway's gzipped layers itself, so this chapter runs ${pinnedAddonControllerImage(sveltos)} as released; unset SVELTOS_ADDON_CONTROLLER_IMAGE rather than record an override this pin does not need`,
  );
}

// The pinned manifest, fetched once and checked against the lock before a
// byte of it is used: its image lines are the preload list, and its text is
// what the install applies.
function fetchPinnedManifest({ workRoot, sveltos }) {
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
  return downloaded;
}

// What the receipt says about the preload: that the list came from the pinned
// manifest's own image lines, and what happened to the sveltos-agent, which
// no manifest line names because Sveltos deploys it into each workload
// cluster itself.
function imagePreloadRecord(sveltos, images) {
  return {
    source: "the image lines of the pinned manifest",
    images,
    sveltosAgent: sveltosAgentPreloaded(sveltos.version)
      ? "preloaded by the digest the shared fleet library pins for this version"
      : `not preloaded: no sveltos-agent digest is recorded for ${sveltos.version}, so each workload node pulls the agent directly by the digest Sveltos deploys it with`,
  };
}

// The gateway serves each release as a gzipped tar layer, so this run needs an
// addon controller that gunzips. The pinned image is the default. For a pin
// whose released controller does not gunzip, an operator holding a build with
// the fix names it in the environment.
function resolveAddonControllerImage(sveltos) {
  const pinnedImage = pinnedAddonControllerImage(sveltos);
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

function assertPublishableSpaceName(space) {
  check(
    space === space.toLowerCase(),
    `refusing to create ${space}: OCI repository names are lowercase, so a Space carrying uppercase cannot be addressed through the gateway; see ${probeRecord}`,
  );
}


// The gate preflight. It reads the platform filter, wires one throwaway Space
// to it, and reads which triggers the filter resolved for that Space, naming
// each by reading it back: that is the set every Space the run creates must
// carry, read live rather than assumed. It refuses a set that is empty, that
// still carries the retired approval trigger, or that holds a trigger the
// committed profile does not define. It then creates the reviewed workflow in
// the same Space and reads it back, so a server that does not keep the
// attestation requirement is found out in seconds. The Space goes either way.
function probeGates(context, runId, plan) {
  const filter = getByRef(context, "filter", gateFilterRef).Filter;
  check(
    Boolean(filter?.FilterID),
    `${gateFilterRef} is missing; every Space this chapter creates is wired to it for its validating triggers`,
  );
  const probeSpace = spaceName(`hx-sveltos-env-probe-${runId}`);
  check(
    !spacePresent(context, probeSpace),
    `refusing to reuse ${probeSpace}`,
  );
  createPolicySpace(context, probeSpace);
  try {
    const wired = cubJson(context, ["space", "get", probeSpace, "-o", "json"]).Space;
    const triggerIds = [...(wired?.TriggerIDs ?? [])].map(String).sort();
    check(
      triggerIds.length > 0,
      `${gateFilterRef} resolved no trigger for ${probeSpace}, so the Spaces would carry no validating gate`,
    );
    const triggerRefs = triggerIds
      .map((id) => {
        const trigger = cubJson(context, [
          "trigger", "get", "--space", "platform", id, "-o", "json",
        ]).Trigger;
        return `platform/${trigger?.Slug}`;
      })
      .sort();
    check(
      !triggerRefs.includes(retiredApprovalTrigger),
      `${gateFilterRef} still resolves ${retiredApprovalTrigger}, whose function ConfigHub removed with the old approval mechanism (confighubai/confighub#5495); its gates could never clear, so delete that trigger and refresh the Spaces' triggers before a run`,
    );
    const undefinedRefs = triggerRefs.filter((ref) => !catalogTriggerRefs.includes(ref));
    check(
      undefinedRefs.length === 0,
      `${gateFilterRef} resolves ${undefinedRefs.join(", ")}, which the committed profile ${relativeRepo(policyPath)} does not define`,
    );
    const workflow = createChangeWorkflowFromFile(context, {
      space: probeSpace,
      slug: "probe-attestation-gates",
      path: plan.workflow.path,
    });
    assertWorkflowKept(workflow, plan);
    return {
      ref: gateFilterRef,
      id: filter.FilterID,
      hash: String(filter.Hash ?? "").trim(),
      triggerRefs,
      triggerIds,
      resolvedFrom: "the TriggerIDs a Space wired to the filter carries after a refresh, each named by reading it back",
      approvalTrigger: `none: ${retiredApprovalTrigger} was removed with the old approval mechanism (confighubai/confighub#5495), and approval is an attestation the workflow requires`,
    };
  } finally {
    // The probe Space holds only the probe workflow, so a direct recursive
    // delete is safe under the ordering constraint in
    // confighubai/confighub#4980.
    cubTry(context, [
      "space", "delete", probeSpace, "--recursive-force", "--quiet",
    ], { timeout: 240_000 });
  }
}

// What the server kept of the reviewed workflow must be the reviewed
// workflow: the stages in order, the release gate on each, and the approval
// requirement with AllowAuthors as reviewed.
function assertWorkflowKept(workflow, plan) {
  const requirement = (workflow.attestationPrerequisites ?? [])
    .find((row) => row?.Name === approvalRequirement);
  check(
    requirement
      && requirement.Type === "Approval"
      && Number(requirement.Count ?? 1) === 1
      && requirement.AllowAuthors === plan.workflow.requirement.AllowAuthors,
    `ConfigHub kept ${workflow.ref} without the reviewed ${approvalRequirement} requirement, so its stages would release unapproved content`,
  );
  check(
    workflow.stages.map((stage) => stage?.Name).join(",") === plan.workflow.stages.join(",")
      && workflow.stages.every((stage) =>
        (stage?.ReleasePrerequisites ?? []).includes(approvalRequirement)),
    `ConfigHub kept ${workflow.ref} with stages that do not gate every release on ${approvalRequirement}`,
  );
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

// The workflow's stages select within the component ENTITY a Space is
// attached to, by the Space's Stage label, so the run reads every Space it
// created back and checks the shape the design depends on before any change
// exists: the base and its four variants in the run's own component, each
// variant carrying its environment as its Stage, the base carrying no Stage so
// no stage ever selects it, the Component label every other surface groups by
// still on each Space, and the management Space in a component of its own.
function assertComponentMembership({
  policyContext,
  baseSpace,
  spaceFor,
  plan,
  components,
}) {
  const read = (space) =>
    cubJson(policyContext, ["space", "get", space, "-o", "json"]).Space;
  const managementSpace = spaceFor[plan.management.cluster];
  const rows = [
    { space: baseSpace, stage: undefined },
    ...plan.clusters.map((row) => ({
      space: spaceFor[row.cluster],
      stage: row.environment,
    })),
    { space: managementSpace, stage: undefined },
  ].map((row) => ({ ...row, record: read(row.space) }));
  for (const row of rows) {
    check(
      row.record?.Labels?.Component === componentLabel,
      `${row.space} lost its Component label, so the component view no longer groups it with the run`,
    );
  }
  const componentOf = (row) => String(row.record?.ComponentID ?? "");
  const base = rows[0];
  const componentId = componentOf(base);
  check(
    componentId.length > 0,
    `${baseSpace} is attached to no component, so a ChangeWorkflow has no component for its stages to select within`,
  );
  check(
    !base.record?.Labels?.Stage,
    `${baseSpace} carries the Stage label ${base.record?.Labels?.Stage}, so a workflow stage would select the base`,
  );
  const variants = rows.slice(1, -1);
  for (const row of variants) {
    check(
      componentOf(row) === componentId,
      `${row.space} is not attached to the base's component ${components.base}, so no stage of the workflow can select it`,
    );
    check(
      row.record?.Labels?.Stage === row.stage,
      `${row.space} carries Stage=${row.record?.Labels?.Stage ?? "none"} rather than ${row.stage}, so the ${row.stage} stage would not select it`,
    );
  }
  const management = rows.at(-1);
  const managementComponentId = componentOf(management);
  check(
    managementComponentId.length > 0 && managementComponentId !== componentId,
    `the management Space ${managementSpace} must sit in a component of its own, never in the base's, or it would join every change order's scope`,
  );
  const spaceIds = Object.fromEntries(
    rows.map((row) => [row.space, String(row.record?.SpaceID ?? "")]),
  );
  check(
    Object.values(spaceIds).every((id) => id.length > 0),
    "a Space the run created answered without its SpaceID",
  );
  return {
    component: {
      slug: components.base,
      id: componentId,
      label: componentLabel,
      runScoped: true,
      reason: baseComponentReason,
      spaces: [baseSpace, ...variants.map((row) => row.space)],
    },
    managementComponent: {
      slug: components.management,
      id: managementComponentId,
      runScoped: true,
      reason: managementComponentReason,
      spaces: [managementSpace],
    },
    spaceIds,
  };
}

// The Spaces a stage selects: those of the run's component whose Stage label
// names the stage. Read live before each wave, because the workflow selects
// on what the Spaces carry now, not on what they carried at creation.
function stageMembers({ policyContext, membership, stage }) {
  return membership.component.spaces
    .filter((space) => {
      const record = cubJson(policyContext, [
        "space", "get", space, "-o", "json",
      ]).Space;
      return String(record?.ComponentID ?? "") === membership.component.id
        && record?.Labels?.Stage === stage;
    })
    .sort();
}

// One workflow per run, in the base Space, created from the reviewed file and
// read back. The run's component then declares it required, which states the
// intent and which, as measured, ConfigHub does not yet enforce on a plain
// publish.
function openChangeWorkflow({ policyContext, baseSpace, plan, runId, component }) {
  const created = createChangeWorkflowFromFile(policyContext, {
    space: baseSpace,
    slug: workflowSlug(runId),
    path: plan.workflow.path,
  });
  assertWorkflowKept(created, plan);
  requireChangeWorkflow(policyContext, {
    component,
    workflowRef: created.ref,
  });
  const requirement = plan.workflow.requirement;
  return {
    space: created.space,
    slug: created.slug,
    ref: created.ref,
    file: {
      path: plan.workflow.repoPath,
      rawSha256: plan.workflow.rawSha256,
    },
    stages: plan.workflow.stages,
    stageSelector: "Labels.Stage = '<stage>' within the change order's component",
    prerequisites: [...entryPrerequisites],
    stageGates: plan.workflow.spec.Stages.map((stage) => ({
      stage: stage.Name,
      prerequisites: stage.Prerequisites ?? [],
      releasePrerequisites: stage.ReleasePrerequisites ?? [],
    })),
    attestationPrerequisites: [{
      Name: requirement.Name,
      Type: requirement.Type,
      Count: Number(requirement.Count),
      AllowAuthors: requirement.AllowAuthors,
    }],
    separationOfDuties: {
      allowAuthors: requirement.AllowAuthors,
      relaxed: requirement.AllowAuthors === true,
      statement: separationOfDutiesStatement,
      strictModeRefusal,
      strictModeMeasuredOn,
    },
    healthy: { declared: false, reason: healthyNotDeclaredReason },
    workflowRequired: {
      component,
      declared: true,
      command: "cub component update --patch <component> --change-workflow-required --allowed-change-workflow <base-space>/<workflow>",
      enforcedOnPlainPublish: false,
      measuredOn: "2026-09-26",
      note: workflowRequiredNote,
    },
    command: "cub changeworkflow create --space <base-space> <workflow> --filename examples/sveltos/env-rollout/change-workflow.yaml",
  };
}

// The baseline goes through a change order of its own, one that carries no
// change to the base, so every release that reaches a cluster in this run
// passes the approval gate. Stage by stage it is promoted, which marks each
// variant's own reviewed head, refused at release until approved, approved,
// and released; each later stage is entered only once the stage ahead has
// released it. The management record is approved as an attestation too,
// though no release gate reads it. If any step does not behave that way live,
// the run stops and names the step: it never falls back to a release outside
// a change order.
function releaseBaseline({
  policyContext,
  baseSpace,
  plan,
  runId,
  spaceFor,
  workflow,
  membership,
  managementVariant,
}) {
  const failClosed = (step, detail) =>
    `the ${baselinePath} path failed at ${step}: ${detail}. Every release that reaches a cluster in this run must pass the approval gate, so the run stops rather than publish a baseline outside a change order.`;
  // Every record the run created, the management record included, is the
  // baseline set, and the reviewed query must select exactly it.
  const everyRecord = selectSet({
    policyContext,
    stageName: "baseline",
    query: baselineQuery(plan, runId),
    expectedUnits: [
      ...plan.clusters.map((row) => `${spaceFor[row.cluster]}/${policyUnit}`),
      `${spaceFor[plan.management.cluster]}/${policyUnit}`,
    ],
  });
  let created;
  try {
    created = createChangeOrder(policyContext, {
      space: baseSpace,
      slug: baselineOrderSlug(runId),
      workflowRef: workflow.ref,
      description: "Release each variant's reviewed baseline through the workflow; the base itself does not change",
    });
  } catch (error) {
    throw new Error(failClosed("creating the baseline change order", error.message));
  }
  const changeOrder = {
    space: created.space,
    slug: created.slug,
    ref: created.ref,
    workflow: workflow.ref,
    description: created.description,
    carriesBaseChange: false,
    inScopeSpaces: assertChangeOrderScope(created, membership),
    command: "cub changeorder create --space <base-space> <baseline-change-order> --change-workflow <base-space>/<workflow> --description <text>",
  };
  const records = {};
  const stages = [];
  for (const wave of plan.waves) {
    const clusters = wave.clusters.map((name) =>
      plan.clusters.find((row) => row.cluster === name));
    const stageSpaces = stageMembers({ policyContext, membership, stage: wave.environment });
    check(
      sameSet(stageSpaces, clusters.map((row) => spaceFor[row.cluster])),
      failClosed(`the ${wave.environment} stage`, `it selects ${stageSpaces.join(", ") || "no Space"} rather than the wave's variants`),
    );
    const heads = Object.fromEntries(clusters.map((row) => [
      row.cluster,
      Number(cubJson(policyContext, [
        "unit", "get", "--space", spaceFor[row.cluster], policyUnit, "-o", "json",
      ]).Unit.HeadRevisionNum),
    ]));
    const promoted = promoteStage(policyContext, {
      changeOrderRef: changeOrder.ref,
      stage: wave.environment,
      changeDesc: `Mark ${wave.environment}'s reviewed baseline for release through ${changeOrder.slug}`,
    });
    check(
      promoted.ok,
      failClosed(`promoting it into ${wave.environment}`, promoted.error),
    );
    // A change order with no change marks each variant where it already
    // stands, so the baseline cuts no revision. One that moved a variant is
    // caught here, before anything is released.
    for (const row of clusters) {
      const head = Number(cubJson(policyContext, [
        "unit", "get", "--space", spaceFor[row.cluster], policyUnit, "-o", "json",
      ]).Unit.HeadRevisionNum);
      check(
        head === heads[row.cluster],
        failClosed(`promoting it into ${wave.environment}`, `${row.cluster} moved from revision ${heads[row.cluster]} to ${head}, but a change order with no change must mark the variant where it stands`),
      );
    }
    let set;
    try {
      set = attestedReleaseSet({
        policyContext,
        stageName: `baseline ${wave.environment}`,
        query: waveQuery(plan, runId, wave.environment),
        members: clusters.map((row) => ({
          cluster: row.cluster,
          space: spaceFor[row.cluster],
          expectedDocs: [row.baselineDoc],
          revisionId: row.revisions.baseline,
        })),
        changeOrder,
        stage: wave.environment,
      });
    } catch (error) {
      throw new Error(failClosed(`releasing ${wave.environment}`, error.message));
    }
    for (const row of clusters) {
      records[row.cluster] = set.records[row.cluster];
    }
    stages.push({
      stage: wave.environment,
      selection: set.selection,
      members: stageSpaces,
      promotion: {
        command: promoteCommand(wave.environment),
        changeOrder: changeOrder.ref,
        cutRevisions: false,
      },
      approval: set.approval,
    });
  }
  const management = attestUnpublishedRecord({
    policyContext,
    member: {
      cluster: plan.management.cluster,
      space: spaceFor[plan.management.cluster],
      expectedDocs: managementVariant.documents,
      revisionId: managementVariant.revisionId,
    },
    reason: managementUngatedReason,
  });
  return {
    path: baselinePath,
    changeOrder,
    selection: everyRecord,
    stages,
    records,
    management,
  };
}

// The change order is created after the reviewed edit landed on the base, so
// it captures exactly that edit as the change. Its scope is read back from the
// server and must be exactly the base and its four variants: a Space of an
// earlier run, or the management Space, in that scope is the failure the
// run-scoped components exist to prevent.
function openChangeOrder({
  policyContext,
  baseSpace,
  plan,
  runId,
  workflow,
  membership,
  baseChange,
}) {
  const created = createChangeOrder(policyContext, {
    space: baseSpace,
    slug: changeOrderSlug(runId),
    workflowRef: workflow.ref,
    description: `Raise ${plan.change.spec.valuesPath} from ${plan.change.spec.before} to ${plan.change.spec.after} on the base record`,
  });
  return {
    space: created.space,
    slug: created.slug,
    ref: created.ref,
    workflow: workflow.ref,
    description: created.description,
    createdAfterBaseRevision: baseChange.revision,
    inScopeSpaces: assertChangeOrderScope(created, membership),
    command: "cub changeorder create --space <base-space> <change-order> --change-workflow <base-space>/<workflow> --description <text>",
  };
}

function assertChangeOrderScope(changeOrder, membership) {
  const slugFor = Object.fromEntries(
    Object.entries(membership.spaceIds).map(([space, id]) => [id, space]),
  );
  const inScope = changeOrder.inScopeSpaceIds.map((id) => slugFor[id] ?? id);
  const managementSpace = membership.managementComponent.spaces[0];
  check(
    !inScope.includes(managementSpace),
    `${changeOrder.ref} holds the management Space ${managementSpace} in its scope; it must sit in a component of its own`,
  );
  check(
    sameSet(inScope, membership.component.spaces),
    `${changeOrder.ref} is headed for ${[...inScope].sort().join(", ") || "nothing"} rather than exactly the base and its four variants; a Space outside this run is in its scope`,
  );
  return [...inScope].sort();
}

// Before wave one, the change is asked to skip straight into the second stage.
// Nothing in the first stage has released it, so the Released gate cannot
// hold, and the server must refuse. The refusal is the evidence that the stage
// order is ConfigHub's to enforce rather than this runner's to choreograph, so
// a promotion that succeeds here stops the run. The message is recorded as the
// server wrote it; the runner does not depend on its wording, only on the
// refusal and on the second stage's variants not having moved.
function assertStageGateRefuses({ policyContext, plan, changeOrder, spaceFor }) {
  const [first, second] = plan.waves;
  const heads = () => Object.fromEntries(second.clusters.map((cluster) => [
    cluster,
    Number(cubJson(policyContext, [
      "unit", "get", "--space", spaceFor[cluster], policyUnit, "-o", "json",
    ]).Unit.HeadRevisionNum),
  ]));
  const before = heads();
  const attempt = promoteStage(policyContext, {
    changeOrderRef: changeOrder.ref,
    stage: second.environment,
    changeDesc: `Attempt ${changeOrder.slug} in ${second.environment} before ${first.environment} has released it`,
  });
  check(
    !attempt.ok,
    `ConfigHub promoted ${changeOrder.ref} into ${second.environment} before ${first.environment} released it; the Released gate did not hold the stage order`,
  );
  const message = String(attempt.error ?? "").trim();
  check(
    message.length > 0 && !/unknown (flag|command)/i.test(message),
    `the promotion into ${second.environment} failed for a reason other than its gate: ${message || "no message"}`,
  );
  const after = heads();
  check(
    stableJson(before) === stableJson(after),
    `the refused promotion still moved a ${second.environment} variant: ${stableJson(before)} became ${stableJson(after)}`,
  );
  return {
    command: promoteCommand(second.environment),
    attempted: "after the change order was created and before wave 1",
    targetStage: second.environment,
    stageAhead: first.environment,
    refused: true,
    enforcedBy: "the ConfigHub server",
    message,
    headsUnchanged: true,
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
  checkpoints,
  changeOrder,
  membership,
}) {
  // Before this wave touches anything, the preceding checkpoint must show the
  // clusters it depends on reporting healthy: the whole fleet at the baseline
  // for wave one, the environment the previous wave promoted after that. An
  // unhealthy cluster refuses the wave here, before its set is even listed,
  // and the record of what unlocked the wave goes into the receipt. The
  // server's Released gate says the stage ahead published the change; this
  // evidence says its clusters are running it, which ConfigHub cannot yet
  // read for itself.
  const previous = wave.wave === 1
    ? null
    : plan.waves.find((row) => row.wave === wave.wave - 1);
  const unlockedBy = waveUnlockEvidence({
    wave: wave.wave,
    previousEnvironment: previous?.environment ?? null,
    expectedClusters: previous
      ? previous.clusters
      : plan.clusters.map((row) => row.cluster),
    checkpoints,
  });
  const query = waveQuery(plan, runId, wave.environment);
  const clusters = wave.clusters.map((name) =>
    plan.clusters.find((row) => row.cluster === name));
  const expectedUnits = clusters.map((row) => `${spaceFor[row.cluster]}/${policyUnit}`);
  // Selecting before promoting means a query that reaches past the wave stops
  // the wave, rather than carrying a cluster the wave never named. The label
  // query is what the set approval uses; the stage is what the promotion
  // uses. Both must name exactly the wave's variants before anything moves.
  const preflight = selectSet({
    policyContext,
    stageName: `wave ${wave.wave}`,
    query,
    expectedUnits,
  });
  const stageSpaces = stageMembers({
    policyContext,
    membership,
    stage: wave.environment,
  });
  check(
    sameSet(stageSpaces, clusters.map((row) => spaceFor[row.cluster])),
    `the ${wave.environment} stage selects ${stageSpaces.join(", ") || "no Space"} rather than the wave's variants; refusing to promote a stage that is not the wave`,
  );
  const promotion = promoteStage(policyContext, {
    changeOrderRef: changeOrder.ref,
    stage: wave.environment,
    changeDesc: `Promote ${changeOrder.slug}: inherit ${plan.change.spec.valuesPath}=${plan.change.spec.after} from the base into the ${wave.environment} variants`,
  });
  check(
    promotion.ok,
    `ConfigHub did not promote ${changeOrder.ref} into the ${wave.environment} stage: ${promotion.error}`,
  );
  for (const row of clusters) {
    assertMergeKeptDepartures({
      policyContext,
      space: spaceFor[row.cluster],
      cluster: row,
      plan,
    });
  }
  // Each variant's release bundles its unit where the change arrived, which
  // is what the next stage's Released gate reads. The release is attempted
  // before anyone approves it and must be refused by the stage's release
  // gate; that refusal is the wave's gate observation. Then one approval of
  // the change as it stands in the stage, and the release.
  const releaseRevision = `ChangeOrder:${changeOrder.slug}`;
  const members = clusters.map((row) => ({
    cluster: row.cluster,
    space: spaceFor[row.cluster],
    expectedDocs: [row.changedDoc],
    revisionId: row.revisions.changed,
    minimumRevision:
      Number(variantRecords[row.cluster].baseline.approval.revision) + 1,
  }));
  const reviewed = attestedReleaseSet({
    policyContext,
    stageName: `wave ${wave.wave}`,
    query,
    members,
    changeOrder,
    stage: wave.environment,
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
      releaseRefusal: record.releaseGate.message,
      approval: record.approval.kind,
      releaseManifestDigest: record.release.manifestDigest,
      releaseRevision: record.release.revision,
      inheritedFields: row.inheritedFields,
      departedFields: row.departurePaths,
    });
  }
  return {
    wave: wave.wave,
    environment: wave.environment,
    unlockedBy,
    selection: { ...preflight, ...reviewed.selection },
    stage: {
      name: wave.environment,
      members: stageSpaces,
    },
    promotion: {
      command: promoteCommand(wave.environment),
      changeOrder: changeOrder.ref,
      targetStage: wave.environment,
      serverGate: previous
        ? `${entryPrerequisites.join(", ")} over the ${previous.environment} stage`
        : "none; the first stage's gates are never evaluated",
      appliedAsOneOperation: true,
      members: clusters.length,
    },
    release: {
      command: releaseCommand,
      revision: releaseRevision,
      gate: `${approvalRequirement}, the stage's release prerequisite`,
    },
    approval: reviewed.approval,
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
      logicalCluster: row.logicalCluster,
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
      logicalCluster: row.logicalCluster,
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
  logicalCluster,
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
  managementName,
  managementRegistration,
  sveltosInstall,
  gatewayCredential,
  registrations,
  baseRecord,
  baseChange,
  baselineRelease,
  variantRecords,
  managementVariant,
  bootstrap,
  waveRecords,
  checkpoints,
  convergenceAudit,
  cleanup,
  changeManagement,
}) {
  const { membership, workflow, changeOrder, gateRefusal } = changeManagement;
  const variants = [
    ...plan.clusters.map((row) => {
      const record = variantRecords[row.cluster];
      return {
        cluster: row.cluster,
        role: "workload",
        environment: row.environment,
        wave: row.wave,
        stage: record.stage,
        component: membership.component.slug,
        space: record.space,
        gatewayReference: gatewayReference(record.space),
        unit: policyUnit,
        profile: row.profileName,
        clusterRef: record.clusterRef,
        upstream: record.upstream,
        departures: record.departures,
        departedFields: record.departedFields,
        inheritedFields: row.inheritedFields,
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
      component: membership.managementComponent.slug,
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
    kind: "SveltosEnvRolloutProofReceipt",
    metadata: { name: "kyverno-environment-rollout" },
    spec: {
      recordedAt,
      flow: {
        path: "source -> one reviewed base record in ConfigHub -> one variant per cluster -> one change order promoted stage by stage through a ChangeWorkflow -> a release refused by the stage's approval gate -> one Approval attestation of the change in the stage -> ConfigHub release of the change order -> the ConfigHub OCI gateway -> Sveltos -> Kubernetes",
        promotion: "one reviewed values change made once on the base, captured by one change order, and promoted by ConfigHub into the pilot stage, then staging, then the production stage holding both production clusters, each stage entered only once every variant of the stage ahead had released the change",
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
        workflow: {
          path: plan.workflow.repoPath,
          rawSha256: plan.workflow.rawSha256,
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
        approval: {
          kind: "attestation",
          requiredBy: `the ChangeWorkflow's ${approvalRequirement} release prerequisite on every stage`,
          recordedWith: "cub variant approve",
          retired: "ConfigHub removed its trigger-based approval gate and the per-unit approve verb on 2026-09-25 (confighubai/confighub#5495, API_MINOR 6). No trigger in this run gates approval.",
        },
        targetHost: { space: targetHost.space, worker: targetHost.worker },
      },
      prerequisite: sveltosInstall,
      base: { ...baseRecord, change: baseChange },
      variants,
      baselineRelease: {
        path: baselineRelease.path,
        changeOrder: baselineRelease.changeOrder,
        scope: baselineRelease.selection.scope,
        query: baselineRelease.selection.query,
        matched: baselineRelease.selection.matched,
        stages: baselineRelease.stages,
        management: {
          cluster: plan.management.cluster,
          approval: managementApprovalCommand,
          gatedServerSide: false,
          reason: managementUngatedReason,
        },
      },
      advance: {
        evidenceGated: true,
        rule: "No wave's approval is requested until the preceding checkpoint shows every cluster the wave depends on reporting healthy: the whole fleet at the baseline for wave one, the environment the previous wave promoted after that. Each wave records the evidence that unlocked it.",
      },
      changeManagement: {
        component: membership.component,
        managementComponent: membership.managementComponent,
        workflow,
        changeOrder,
        gateRefusal,
        release: {
          command: releaseCommand,
          gate: `every stage's ReleasePrerequisites name ${approvalRequirement}, so a release of a change order into a stage is refused with HTTP 422 until the change as it stands there is approved`,
          baseline: `The baseline went through the ${baselineRelease.changeOrder.slug} change order, which carries no change to the base, so every release that reached a cluster in this run passed the approval gate.`,
        },
        approval: {
          kind: "attestation",
          command: stageApprovalCommand("<stage>"),
          management: managementApprovalCommand,
          observation: "Before each approval the release was attempted and refused by the stage's release gate, and the refusal is recorded as that wave's gate observation.",
        },
        observedHealth: "The server's Released gate says the stage ahead published the change. The unlockedBy evidence on each wave says its clusters are running it, which ConfigHub cannot yet read for itself.",
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
        sveltosInstall.addonControllerImageOverridden
          ? "The gateway serves each release as a gzipped tar layer, and the pinned release's addon controller does not gunzip, so the run replaced it with a build that does. The image it ran is recorded above."
          : "The gateway serves each release as a gzipped tar layer, and the pinned release's own addon controller gunzips it, so the run installed the manifest's images as released. The image it ran is recorded above.",
        "The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.",
        "The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.",
        "The proof covers one reviewed values change to this Kyverno base, not a chart version bump.",
        "The ChangeWorkflow declares Released and not Healthy, because nothing reports Sveltos's view of a cluster to ConfigHub yet. The observed-health evidence is the runner's own checkpoints.",
        separationOfDutiesStatement,
        workflowRequiredNote,
        managementUngatedReason,
      ],
    },
    status: {
      result: "pass",
      claim: "ConfigHub held one variant per cluster over a shared base, each carrying its own departures and its environment as its stage, and released every variant's baseline through a change order of its own, so every release that reached a cluster passed the approval gate. One reviewed change made on the base was captured by one change order under a ChangeWorkflow. ConfigHub refused to promote that change into staging before pilot had released it, then promoted it stage by stage, pilot, staging, and production, each stage entered only once the stage ahead had released it. In every stage ConfigHub refused the release until the change as it stood there was approved, the approval was recorded as an attestation on that exact revision in one operation for the stage, and each variant then published the release the change order arrived at. The single-operator run relaxed separation of duties and says so. The ConfigHub OCI gateway served each release, Sveltos fetched it itself, and every cluster converged on its own reviewed state with its departures intact, with the clusters outside the wave verified stable at every checkpoint.",
    },
  };
}

// A receipt recorded before the per-cluster variant design held one record
// per environment, and predates a plan this function can check it against.
// It is recognized, not verified, so the re-record does not silently rewrite
// it or check it against a contract it was never built to satisfy.
function verifyReceipt(receipt) {
  if (supersededReceipt(receipt)) {
    console.log(
      "the recorded receipt records one record per environment and predates the per-cluster variant design; it awaits a live re-record",
    );
    return false;
  }
  check(
    receipt.kind === "SveltosEnvRolloutProofReceipt",
    "Sveltos env rollout receipt kind changed",
  );
  check(receipt.status?.result === "pass", "Sveltos env rollout proof is not pass");

  // A per-cluster receipt recorded before the Target and clusterRefs model
  // hashed the example files as they were reviewed then, so it cannot be
  // checked against a plan computed from today's files. It is recognized,
  // kept as recorded, and replaced by the re-record.
  const targeted = (receipt.spec?.variants ?? []).some((row) => row.target);
  if (!targeted) {
    console.log(
      "the recorded receipt predates the per-cluster Target model and releases to a shared catalog target; it awaits its re-record",
    );
    return false;
  }

  // A receipt recorded before the ChangeWorkflow design moved each wave with
  // a set upgrade the runner issued, and ConfigHub held no stage order of its
  // own. It is kept as recorded, recognized by that shape, and fills nothing,
  // so the re-record replaces it rather than this verifier rewriting history.
  if (predatesChangeWorkflow(receipt)) {
    console.log(
      "the recorded receipt predates the ChangeWorkflow design: its waves were set upgrades the runner issued rather than stages ConfigHub promoted and gated, and its approvals used the per-unit mechanism ConfigHub has since removed rather than attestations; it awaits a live re-record",
    );
    return false;
  }

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
  check(
    receipt.spec?.source?.workflow?.path === plan.workflow.repoPath
      && receipt.spec.source.workflow.rawSha256 === plan.workflow.rawSha256,
    "Sveltos env rollout workflow record changed: the receipt must name the reviewed change-workflow.yaml the run created its workflow from",
  );
  // The filter's trigger set is whatever it resolved live, so the verifier
  // checks its shape rather than a list: non-empty, every trigger one the
  // committed profile defines, the retired approval trigger absent, and one
  // ID per name.
  const recordedTriggers = receipt.spec?.policy?.filter?.triggerRefs ?? [];
  check(
    receipt.spec?.policy?.organization === expectedPolicyOrg
      && receipt.spec.policy.profile === "catalog-standard"
      && receipt.spec.policy.filter?.ref === gateFilterRef
      && recordedTriggers.length > 0
      && recordedTriggers.every((ref) => catalogTriggerRefs.includes(ref))
      && (receipt.spec.policy.filter.triggerIds ?? []).length === recordedTriggers.length,
    "Sveltos env rollout policy record changed",
  );
  check(
    !recordedTriggers.includes(retiredApprovalTrigger)
      && receipt.spec.policy.approvalGate === undefined
      && receipt.spec.policy.approval?.kind === "attestation",
    `approval is an attestation the workflow requires; a receipt carrying ${retiredApprovalTrigger} or its vet-approvedby gate records the mechanism ConfigHub removed`,
  );
  check(
    !/"command":"cub unit approve/.test(JSON.stringify(receipt)),
    "a receipt must not record the removed per-unit approve command as a command it ran",
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
  verifyChangeManagement(receipt, plan);
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
          registration.cluster === row.cluster
          && registration.labels?.environment === row.environment))
      && new Set(registrations.map((row) => row.cluster)).size
      === registrations.length,
    "every workload cluster must be registered under its own SveltosCluster name",
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
      && base.change.publishedAsRelease === false,
    "the reviewed change must land once on the base record and never be published from it",
  );
}

// The ChangeWorkflow design, checked as one block: a run-scoped component
// holding exactly the base and its four variants, the management Space in a
// run-scoped component of its own, one workflow whose stages are the reviewed
// waves gated on Released and not on Healthy, one change order headed for
// exactly the base's component, and the server's own refusal to skip a stage.
function requireChangeManagement(receipt) {
  const managed = receipt.spec?.changeManagement;
  check(
    managed && typeof managed === "object"
      && managed.component && managed.managementComponent
      && managed.workflow && managed.changeOrder,
    "the receipt must record its change management: the component, the workflow, the change order, and the server's gate refusal",
  );
  return managed;
}

function verifyChangeManagement(receipt, plan) {
  const managed = requireChangeManagement(receipt);
  const baseSpace = String(receipt.spec?.base?.space ?? "");
  const runId = /^hx-sveltos-env-base-(\d{8,14})$/.exec(baseSpace)?.[1];
  check(runId, `the base Space ${baseSpace || "(missing)"} carries no run id to scope its component by`);
  const expected = runScopedComponents(componentLabel, runId);
  const variants = receipt.spec?.variants ?? [];
  const workloadSpaces = variants
    .filter((row) => row.role === "workload")
    .map((row) => row.space);
  const managementSpace = variants.find((row) => row.role === "management")?.space;
  const component = managed.component ?? {};
  const managementComponent = managed.managementComponent ?? {};
  check(
    component.slug === expected.base
      && component.runScoped === true
      && component.label === componentLabel
      && String(component.id ?? "").length > 0,
    `the base's component must be run-scoped as ${expected.base}; a component shared across runs puts another run's variants in the change order's scope`,
  );
  check(
    !(component.spaces ?? []).includes(managementSpace),
    "the management Space must not join the base's component; it is not a variant of the base, and there it would sit in every change order's scope",
  );
  check(
    sameSet(component.spaces ?? [], [baseSpace, ...workloadSpaces]),
    "the base's component must hold exactly the base and its four variants",
  );
  check(
    managementComponent.slug === expected.management
      && managementComponent.runScoped === true
      && String(managementComponent.id ?? "").length > 0
      && managementComponent.id !== component.id
      && managementComponent.slug !== component.slug
      && sameSet(managementComponent.spaces ?? [], [managementSpace]),
    `the management Space must sit alone in its own run-scoped component ${expected.management}`,
  );

  const workflow = managed.workflow ?? {};
  const stages = plan.waves.map((wave) => wave.environment);
  check(
    workflow.space === baseSpace
      && workflow.ref === `${baseSpace}/${workflow.slug}`
      && stableJson(workflow.stages ?? []) === stableJson(stages)
      && stableJson(workflow.prerequisites ?? []) === stableJson(entryPrerequisites)
      && workflow.file?.path === plan.workflow.repoPath
      && workflow.file.rawSha256 === plan.workflow.rawSha256,
    `the ChangeWorkflow must live in the base Space, be created from the reviewed ${plan.workflow.repoPath}, hold the stages ${stages.join(", ")} in that order, and enter each later one on ${entryPrerequisites.join(", ")}`,
  );
  // Every stage gates its releases on the approval requirement, and every
  // stage after the first is entered only once the stage ahead released.
  check(
    stableJson(workflow.stageGates ?? []) === stableJson(plan.workflow.spec.Stages.map((stage) => ({
      stage: stage.Name,
      prerequisites: stage.Prerequisites ?? [],
      releasePrerequisites: stage.ReleasePrerequisites ?? [],
    }))),
    `every stage must gate its releases on ${approvalRequirement} and every later stage its entry on ${entryPrerequisites.join(", ")}, as the reviewed workflow declares`,
  );
  // The approval requirement is recorded as reviewed. A single-operator run
  // needs AllowAuthors: true, and the receipt must say that it relaxes
  // separation of duties and quote what the strict setting refused.
  const requirement = (workflow.attestationPrerequisites ?? [])[0] ?? {};
  const duties = workflow.separationOfDuties ?? {};
  check(
    (workflow.attestationPrerequisites ?? []).length === 1
      && requirement.Name === approvalRequirement
      && requirement.Type === "Approval"
      && requirement.Count === 1
      && requirement.AllowAuthors === plan.workflow.requirement.AllowAuthors
      && duties.allowAuthors === requirement.AllowAuthors,
    `the approval requirement must be recorded as the reviewed workflow declares it: one Approval attestation, AllowAuthors ${plan.workflow.requirement.AllowAuthors}`,
  );
  check(
    duties.relaxed === (requirement.AllowAuthors === true)
      && duties.statement === separationOfDutiesStatement
      && duties.strictModeRefusal === strictModeRefusal
      && /who did not write the change/.test(String(duties.strictModeRefusal ?? ""))
      && duties.strictModeMeasuredOn === strictModeMeasuredOn,
    "the receipt must say plainly that the single-operator run relaxes separation of duties, and quote what the strict setting refused when it was measured",
  );
  check(
    workflow.workflowRequired?.declared === true
      && workflow.workflowRequired.component === component.slug
      && workflow.workflowRequired.enforcedOnPlainPublish === false
      && workflow.workflowRequired.note === workflowRequiredNote,
    "the run's component must declare the workflow required, and the receipt must say that ConfigHub does not yet enforce it on a plain publish",
  );
  check(
    !(workflow.prerequisites ?? []).includes("Healthy")
      && workflow.healthy?.declared === false
      && /#33\b/.test(String(workflow.healthy?.reason ?? ""))
      && /#5049\b/.test(String(workflow.healthy?.reason ?? "")),
    "the Healthy gate must stay undeclared, with its reason recorded, until a Sveltos reporter exists (#33) and ConfigHub recognises the provider (confighubai/confighub#5049)",
  );

  const changeOrder = managed.changeOrder ?? {};
  check(
    changeOrder.space === baseSpace
      && changeOrder.ref === `${baseSpace}/${changeOrder.slug}`
      && changeOrder.workflow === workflow.ref
      && Number(changeOrder.createdAfterBaseRevision)
        === Number(receipt.spec?.base?.change?.revision),
    "the change order must live in the base Space, be governed by the run's workflow, and be created after the reviewed edit landed on the base",
  );
  check(
    !(changeOrder.inScopeSpaces ?? []).includes(managementSpace)
      && sameSet(changeOrder.inScopeSpaces ?? [], component.spaces ?? []),
    "the change order must be headed for exactly the base's component, never the management Space or another run's variants",
  );

  const refusal = managed.gateRefusal;
  check(
    refusal
      && refusal.refused === true
      && refusal.targetStage === stages[1]
      && refusal.stageAhead === stages[0]
      && refusal.command === promoteCommand(stages[1])
      && refusal.headsUnchanged === true
      && String(refusal.message ?? "").trim().length > 0,
    `the receipt must record the server refusing to promote into ${stages[1]} before ${stages[0]} released the change, in the server's own words`,
  );
  check(
    managed.release?.command === releaseCommand
      && managed.approval?.kind === "attestation"
      && managed.approval.command === stageApprovalCommand("<stage>")
      && managed.approval.management === managementApprovalCommand,
    "the change management must record the release and attestation commands the waves used",
  );

  // The baseline must record the path it took, and the only path this design
  // accepts is a change order of its own that carries no change, promoted
  // stage by stage, so every release that reached a cluster passed the gate.
  const baseline = receipt.spec?.baselineRelease ?? {};
  check(
    baseline.path === baselinePath,
    `the receipt must record which path the baseline took, and the only accepted one is the ${baselinePath}`,
  );
  check(
    baseline.changeOrder?.space === baseSpace
      && baseline.changeOrder.ref === `${baseSpace}/${baseline.changeOrder.slug}`
      && baseline.changeOrder.slug !== changeOrder.slug
      && baseline.changeOrder.workflow === workflow.ref
      && baseline.changeOrder.carriesBaseChange === false
      && sameSet(baseline.changeOrder.inScopeSpaces ?? [], component.spaces ?? []),
    "the baseline change order must live in the base Space under the run's workflow, carry no change, and be headed for exactly the base's component",
  );
  check(
    (baseline.stages ?? []).map((row) => row.stage).join(",") === stages.join(",")
      && baseline.stages.every((row) =>
        row.promotion?.command === promoteCommand(row.stage)
        && row.promotion.changeOrder === baseline.changeOrder.ref
        && row.promotion.cutRevisions === false
        && row.approval?.kind === "attestation"
        && row.approval.command === stageApprovalCommand(row.stage)),
    "the baseline must be promoted, approved as an attestation, and released stage by stage, in the workflow's order",
  );
  check(
    baseline.scope === setScope
      && (baseline.matched ?? []).length === workloadSpaces.length + 1
      && baseline.management?.approval === managementApprovalCommand
      && baseline.management.gatedServerSide === false
      && baseline.management.reason === managementUngatedReason,
    "the baseline must select every record the run created and record the management approval as an attestation nothing server-side gates",
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
  // ConfigHub's destination model: each variant's Space carries a Target
  // named for its cluster and releases to it, so what runs where is a
  // model-level answer. A receipt recorded before this model was recognized
  // before verifyVariants was ever reached, so every receipt here carries
  // targets.
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
  for (const variant of variants) {
    check(
      variant.gatewayReference === gatewayReference(String(variant.space ?? ""))
        && variant.unit === policyUnit,
      `the ${variant.cluster} variant reference changed`,
    );
    for (const record of variant.records ?? []) {
      // Every approval is an attestation that changed nothing it approved.
      check(
        record.approval?.kind === "attestation"
          && record.approval.type === "Approval"
          && record.approval.approverIdentityRecordedInReceipt === false
          && record.approval.contentHashUnchanged === true
          && record.approval.headUnchanged === true,
        `the ${variant.cluster} ${record.stage} approval must be recorded as an Approval attestation that left the record's head and content unchanged`,
      );
      // Only the management record may carry no release, and it must say so
      // rather than simply be missing one, so a workload record that failed to
      // publish can never pass as an out-of-band record. It is approved as an
      // attestation that nothing server-side gates.
      if (variant.role === "management") {
        check(
          record.release === null
            && record.approval.command === managementApprovalCommand
            && record.approval.gatedServerSide === false
            && record.releaseGate?.result === "not-applicable"
            && record.releaseGate.reason === managementUngatedReason,
          `the ${variant.cluster} ${record.stage} record must publish no release and record its approval as an attestation nothing server-side gates`,
        );
      } else {
        // A workload approval never stands without the release gate's
        // refusal before it: the release was attempted first and ConfigHub
        // refused it for want of this approval.
        check(
          record.releaseGate?.result === "refused"
            && record.releaseGate.httpStatus === 422
            && record.releaseGate.requirement === approvalRequirement
            && releaseGateRefused(String(record.releaseGate.message ?? ""))
            && record.afterApproval?.result === "published",
          `the ${variant.cluster} ${record.stage} approval must follow the release gate's refusal in ConfigHub's words, and the release must follow the approval`,
        );
        check(
          record.approval.command.startsWith("cub variant approve --change-order <base-space>/<change-order> --stage ")
            && record.approval.gatedServerSide === undefined,
          `the ${variant.cluster} ${record.stage} approval must be of the change order in its stage`,
        );
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
  const managed = requireChangeManagement(receipt);
  const changedRevision = `ChangeOrder:${managed.changeOrder.slug}`;
  const baselineRevision = `ChangeOrder:${receipt.spec?.baselineRelease?.changeOrder?.slug}`;
  for (const row of plan.clusters) {
    const variant = variants.find((item) => item.cluster === row.cluster);
    check(
      variant.role === "workload"
        && variant.environment === row.environment
        && variant.wave === row.wave
        && variant.profile === row.profileName,
      `the ${row.cluster} variant identity changed`,
    );
    // The workflow's stages select on the Space's Stage label within the
    // base's component, so a variant outside either is a cluster no stage
    // can reach.
    check(
      variant.stage === row.environment
        && variant.component === managed.component.slug,
      `the ${row.cluster} variant must carry ${row.environment} as its stage inside the base's component`,
    );
    // Both releases are pinned to a change order: the baseline to the one
    // that carries no change, the change to the one that carries it. That is
    // what each stage's release gate evaluates and what the next stage's
    // Released gate reads.
    const [baselineRecord, changedRecord] = variant.records ?? [];
    check(
      baselineRecord?.release?.revision === baselineRevision
        && changedRecord?.release?.revision === changedRevision
        && baselineRecord.approval?.command === stageApprovalCommand(row.environment)
        && changedRecord.approval?.command === stageApprovalCommand(row.environment),
      `the ${row.cluster} baseline release must bundle ${baselineRevision} and its changed release ${changedRevision}, each approved in the ${row.environment} stage`,
    );
    check(
      variant.clusterRef?.kind === "SveltosCluster"
        && variant.clusterRef.apiVersion === "lib.projectsveltos.io/v1beta1"
        && variant.clusterRef.name === row.cluster
        && variant.clusterRef.namespace === registrationNamespace
        && variant.selector === undefined,
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
          !["metadata.name", "spec.clusterRefs"]
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
        > Number(variant.records[0].approval.revision)
        && variant.records[1].releaseGate.message
        !== variant.records[0].releaseGate.message,
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
  check(
    variant.stage === undefined
      && variant.component === requireChangeManagement(receipt).managementComponent.slug,
    "the management record must sit in its own component and carry no stage, so no workflow stage can select it",
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
  // The baseline's own record is checked with the change management; here
  // only that no receipt of this design carries the retired set approval.
  check(
    receipt.spec?.baselineApproval === undefined,
    "the baseline is released through its own change order and approved as attestations; a set approval of every record is the mechanism ConfigHub removed",
  );
  // A receipt that declares evidence-gated advance must record, on every wave,
  // the checkpoint evidence that unlocked its approval, and that evidence must
  // agree with the checkpoints the receipt itself carries. A receipt recorded
  // before the guard existed declares nothing and carries nothing; one that
  // carries unlock evidence without declaring it, or declares it without
  // carrying it, is refused.
  const evidenceGated = receipt.spec?.advance?.evidenceGated === true;
  const carrying = waves.filter((row) => row.unlockedBy).length;
  if (!evidenceGated) {
    check(
      carrying === 0,
      "waves carry unlock evidence the receipt does not declare; the advance record changed",
    );
    console.log(
      "the recorded receipt predates evidence-gated advance and records no unlock evidence; it awaits a live re-record",
    );
  }
  for (const wave of waves) {
    const planned = plan.waves.find((row) => row.wave === wave.wave);
    const members = wave.clusters ?? [];
    if (evidenceGated) {
      const unlocked = wave.unlockedBy ?? {};
      const expectedId = wave.wave === 1
        ? "baseline"
        : `after-wave-${wave.wave - 1}`;
      const previous = wave.wave === 1
        ? null
        : plan.waves.find((row) => row.wave === wave.wave - 1);
      const checkpoint = (receipt.spec?.checkpoints ?? []).find(
        (row) => row.id === unlocked.precedingCheckpointId,
      );
      const dependedOn = previous
        ? previous.clusters
        : plan.clusters.map((row) => row.cluster);
      const scope = (checkpoint?.observations ?? []).filter(
        (row) => dependedOn.includes(row.logicalCluster),
      );
      check(
        unlocked.approvalFollowedEvidence === true
          && unlocked.precedingCheckpointId === expectedId
          && unlocked.environment === (previous ? previous.environment : "baseline")
          && Boolean(checkpoint)
          && sameSet(
            (unlocked.clusters ?? []).map((row) => row.logicalCluster),
            dependedOn,
          )
          && scope.length === dependedOn.length
          && (unlocked.clusters ?? []).every((row) => row.result === "pass")
          && scope.every((row) => row.observation?.result === "pass"),
        `wave ${wave.wave} must record the evidence that unlocked its approval: every cluster it depends on healthy at ${expectedId}`,
      );
    }
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
    // A wave is a stage of the change order's workflow, promoted by ConfigHub.
    // The runner-issued set upgrade it replaced may not come back.
    const managed = requireChangeManagement(receipt);
    check(
      wave.upgrade === undefined
        && wave.promotion?.command === promoteCommand(wave.environment)
        && wave.promotion.changeOrder === managed.changeOrder.ref
        && wave.promotion.targetStage === wave.environment,
      `wave ${wave.wave} must be the ${wave.environment} stage promoted with ${promoteCommand(wave.environment)}, not a set upgrade the runner issued`,
    );
    check(
      wave.stage?.name === wave.environment
        && sameSet(wave.stage.members ?? [], members.map((row) => row.space)),
      `wave ${wave.wave} must record that the ${wave.environment} stage selected exactly its variants`,
    );
    check(
      wave.release?.command === releaseCommand
        && wave.release.revision === `ChangeOrder:${managed.changeOrder.slug}`,
      `wave ${wave.wave} must publish each variant where the change order arrived`,
    );
    check(
      wave.promotion.appliedAsOneOperation === true
        && wave.promotion.members === members.length
        && wave.approval?.appliedAsOneOperation === true
        && wave.approval.kind === "attestation"
        && wave.approval.command === stageApprovalCommand(wave.environment)
        && wave.approval.recordedApprovals === members.length,
      `wave ${wave.wave} must promote its set in one operation and approve the change in its stage as one attestation operation`,
    );
    for (const member of members) {
      const planCluster = plan.clusters.find(
        (row) => row.cluster === member.cluster,
      );
      // The wave's gate observation: the release refused for want of the
      // approval, before the approval was recorded.
      check(
        releaseGateRefused(String(member.releaseRefusal ?? "")),
        `wave ${wave.wave} must record, for ${member.cluster}, the release gate refusing the release before the approval`,
      );
      check(
        member.revisionId === planCluster.revisions.changed
          && member.approval === "attestation"
          && normalizeDigest(member.releaseManifestDigest)
          === member.releaseManifestDigest
          && member.releaseRevision === wave.release.revision
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
  // Pin-aware: a pin whose released controller reads the gateway's layers
  // must have run that controller as released. A receipt recorded on the
  // v1.13.0 pin with the v1.13.0-ch build predates this check and is
  // recognised before any check here is reached.
  const sveltos = loadSveltosPin();
  if (sveltos.releasedControllerReadsGatewayLayers) {
    check(
      receipt.spec.prerequisite.addonControllerImage
        === pinnedAddonControllerImage(sveltos)
        && receipt.spec.prerequisite.addonControllerImageOverridden === false,
      `the pinned Sveltos ${sveltos.version} addon controller reads the gateway's layers itself, so the run must record ${pinnedAddonControllerImage(sveltos)} as released and not overridden`,
    );
  }
  const preload = receipt.spec.prerequisite.imagePreload ?? {};
  const preloaded = preload.images ?? [];
  check(
    preload.source === "the image lines of the pinned manifest"
      && preloaded.length > 0
      && preloaded.includes(receipt.spec.prerequisite.addonControllerImage)
      && preloaded.every((image) =>
        image === receipt.spec.prerequisite.addonControllerImage
        || image.includes("@sha256:")
        || image.endsWith(`:${sveltos.version}`))
      && String(preload.sveltosAgent ?? "").length > 0,
    `the receipt must record the images preloaded from the pinned manifest, each at ${sveltos.version}, and what happened to the sveltos-agent`,
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
      && /^(kind delete cluster|cub space delete|cub component delete) /.test(String(row.removeWith ?? ""))),
    "a kept artifact must record what it is and the command that removes it",
  );
}

function renderSummary(receipt) {
  const change = receipt.spec.source.change;
  const rows = receipt.spec.variants
    .filter((variant) => variant.role === "workload")
    .map((variant) => {
      const changed = variant.records[1];
      // The departure worth showing is the one beyond addressing: the name
      // and the clusterRefs entry every variant carries say nothing here.
      const kept = variant.departedFields
        .filter((path) => !["metadata.name", "spec.clusterRefs"].includes(path))
        .map((path) => `\`${path}=${variant.departures[path]}\``)
        .join(", ");
      return `| ${variant.wave} | ${variant.cluster} | ${variant.space} | ${kept} | \`${changed.release.manifestDigest}\` | ${changed.delivery.status} |`;
    });
  const waves = receipt.spec.waves.map((wave) =>
    `| ${wave.wave} | ${wave.environment} | ${wave.promotion.serverGate} | ${wave.clusters.length} refused, then ${wave.approval.recordedApprovals} released |`);
  const finalCheckpoint = receipt.spec.checkpoints.at(-1);
  const delivery = receipt.spec.gatewayDelivery;
  const managed = receipt.spec.changeManagement;
  const baseline = receipt.spec.baselineRelease;
  const firstRefusal = receipt.spec.waves[0].clusters[0].releaseRefusal;
  // A receipt recorded before evidence-gated advance carries no unlock
  // records, and its summary stays exactly as recorded.
  const advance = receipt.spec.advance?.evidenceGated === true
    ? `
No wave's approval was requested on a schedule. Each one was unlocked by the
preceding checkpoint showing every cluster it depends on reporting healthy,
and each wave records that evidence:

| Wave | Unlocked by checkpoint | Clusters observed healthy there |
| --- | --- | --- |
${receipt.spec.waves.map((wave) =>
    `| ${wave.wave} | \`${wave.unlockedBy.precedingCheckpointId}\` (${wave.unlockedBy.environment}) | ${wave.unlockedBy.clusters.map((row) => row.logicalCluster).join(", ")} |`).join("\n")}
`
    : "";
  return `# ConfigHub promotes one change through a fleet it maps cluster by cluster

This run starts with four workload clusters and a management cluster. ConfigHub
holds one reviewed base record and one variant per cluster, so the answer to
which cluster runs which revision comes from ConfigHub rather than from a
selector on a cluster. Each variant carries its own departures from the base,
and its clusterRefs entry names its own cluster and nothing else.

The ChangeWorkflow \`${managed.workflow.slug}\` was created from the reviewed
[change-workflow.yaml](../../examples/sveltos/env-rollout/change-workflow.yaml).
Its stages are ${managed.workflow.stages.join(", then ")}. Every stage after the
first is entered only once every variant of the stage ahead has released the
change (its \`${managed.workflow.prerequisites.join("`, `")}\` gate), and every
stage's releases need one Approval attestation. The base
and its four variants sit in the run's own component
\`${managed.component.slug}\`, and the management record in a component of its
own.

Every variant's baseline went through the \`${baseline.changeOrder.slug}\` change
order, which carries no change to the base, stage by stage, so every release
that reached a cluster in this run passed the approval gate.

One reviewed change raises \`${change.valuesPath}\` from ${change.before} to
${change.after} on the base record, and the change order
\`${managed.changeOrder.slug}\` captured it. Before wave one, ConfigHub itself
refused to promote the change into ${managed.gateRefusal.targetStage} while
${managed.gateRefusal.stageAhead} had not released it:

> ${managed.gateRefusal.message}

Every wave was one of the stages. \`cub variant promote --change-order\` moved
exactly the change into the variants the stage selects, and the release was
attempted before anyone approved it. ConfigHub refused it, in wave one in
these words:

> ${firstRefusal}

One \`cub variant approve --change-order … --stage …\` then recorded the
approval of the change as it stood in the stage, an attestation on each
variant's exact revision, and each variant published the release its change
order arrived at. Sveltos fetched each release itself from
\`oci://${delivery.host}/space/<space>:${delivery.tag}\` on a
${delivery.interval} interval. The Healthy gate is not declared: nothing
reports Sveltos's view of a cluster to ConfigHub yet, so the checkpoints below
are the observed-health evidence.

${managed.workflow.separationOfDuties.statement} Measured on
${managed.workflow.separationOfDuties.strictModeMeasuredOn}, the strict setting
refused the promoter's own approval:

> ${managed.workflow.separationOfDuties.strictModeRefusal}

The management record holds one bootstrap profile per workload Space. It was
applied out of band with kubectl, because it is the record that opens the
gateway path, and its approval is an attestation that nothing server-side
gates. Promotion never touched it. Publishing a new release moved the tag, and
Sveltos followed it.

| Wave | Cluster | Space | Departure kept through the change | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

| Wave | Stage | Entry gate ConfigHub checked | Releases before and after the approval |
| --- | --- | --- | --- |
${waves.join("\n")}
${advance}
| Check | Result |
| --- | --- |
| Checkpoints observed | ${receipt.spec.checkpoints.length}/4 |
| Clusters at their own changed revision after wave 3 | ${finalCheckpoint.observations.filter((row) => row.observation.result === "pass").length}/4 |
| Convergence audit | ${receipt.spec.convergenceAudit.result} |
| Addon controller image | \`${delivery.addonControllerImage}\` |
| Cleanup | ${receipt.spec.cleanup.mode === "kept" ? "Artifacts kept deliberately" : "Pass"} |${receipt.spec.variants.some((row) => row.target) ? `\n| Release targets | one Target per cluster, named for it |` : ""}

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows which cluster ran which revision at each
checkpoint.

## Limits

${receipt.spec.limits.map((limit) => `- ${limit}`).join("\n")}

- [Committed receipt](../../runs/sveltos-env-rollout-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/env-rollout/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/env-rollout/variants.yaml)
- [Reviewed change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
- [Reviewed change workflow](../../examples/sveltos/env-rollout/change-workflow.yaml)
`;
}

// Documents that are applied to a cluster with kubectl are written as JSON,
// which is valid YAML and makes every scalar quoted, so a check for a pinned
// image cannot be satisfied by a longer tag that merely starts the same way.

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







// The server evaluates apply gates asynchronously, so a publish can arrive
// while a gate trigger is still queued. The server says so in those words, and
// re-queues the trigger. That is a race and not a refusal, so the publish waits
// for a bounded budget and then fails with the gate the server named. A gate
// that genuinely refuses reports something else and still stops the run here.


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
          `the addon controller could not read the ${cluster} release: it decoded gzipped bytes as YAML. The gateway serves each release as a gzipped tar layer, so this run needs an addon controller that gunzips, which released Sveltos does from v1.14.0; check the image the run installed against the pin in ${relativeRepo(sourceLockPath)} and see ${probeRecord}.`,
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
  pinnedManifest,
}) {
  // A run fetches the manifest before building anything and hands it in; a
  // caller that has not fetched it gets the same checked fetch here.
  const downloaded = pinnedManifest ?? fetchPinnedManifest({ workRoot, sveltos });
  check(
    sha256(downloaded) === sveltos.manifestSha256,
    "the downloaded Sveltos manifest differs from the source lock",
  );
  const pinnedImage = pinnedAddonControllerImage(sveltos);
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
    timeout: 900_000,
  });
  clusterCommand(managementKubeconfig, [
    "-n", registrationNamespace,
    "wait", "--for=condition=Available", "deployment", "--all",
    "--timeout=900s",
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
  ], { timeout: 900_000 });
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

function componentPresent(context, slug) {
  return cubTry(context, ["component", "get", slug, "-o", "json"]).ok;
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






// A departure may add a field the base never carried, so the writer can create
// the map on the way down when the caller asks for it.

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
    // The flag surface is enforced the way the live CLI enforces it: a flag
    // that belongs to another verb refuses instead of parsing permissively.
    const strayFlagAnswer = hub.handle([
      "unit", "update", "--patch", "--space", "*",
      "--where", "Labels.Proof = 'self-test'", "--upgrade", "--allow-exists",
    ]);
    check(
      !strayFlagAnswer.ok && /unknown flag: --allow-exists/.test(strayFlagAnswer.error),
      "the fake hub must refuse a flag the live CLI refuses",
    );
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
          row.baselineDoc.spec.clusterRefs.length === 1
          && row.baselineDoc.spec.clusterRefs[0].kind === "SveltosCluster"
          && row.baselineDoc.spec.clusterRefs[0].name === row.cluster)
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
          "spec.helmCharts.0.chartName",
          "spec.helmCharts.0.releaseNamespace",
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
      () => loadRolloutPlan(tamperedExampleRoot(workRoot, "clusterref-wrong-cluster", (text) =>
        text.replace(
          "          name: hx-sveltos-env-prod-a",
          "          name: hx-sveltos-env-prod-b",
        ))),
      /must depart on a clusterRefs list naming its own SveltosCluster/,
      "clusterRefs naming another cluster refusal",
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
    // The reviewed workflow is part of the plan, and each way it could drift
    // from the waves or from the approval design is refused before anything
    // is built.
    check(
      plan.workflow.stages.join(",") === "pilot,staging,prod"
        && plan.workflow.requirement.AllowAuthors === true
        && plan.workflow.repoPath === "examples/sveltos/env-rollout/change-workflow.yaml",
      "the plan must carry the reviewed workflow",
    );
    for (const [label, edit, pattern] of [
      ["AllowAuthors off", (text) => text.replace("AllowAuthors: true", "AllowAuthors: false"), /AllowAuthors: true, which a single-operator run needs/],
      ["two approvals", (text) => text.replace("Count: 1", "Count: 2"), /one Approval attestation with AllowAuthors: true/],
      ["a stage released without approval", (text) => text.replace(
        "    Prerequisites:\n      - Released\n    ReleasePrerequisites:\n      - approval\n  - Name: prod",
        "    Prerequisites:\n      - Released\n  - Name: prod",
      ), /the staging stage must gate its releases on approval/],
      ["staging entered without Released", (text) => text.replace(
        "  - Name: staging\n    WhereSpace: \"Labels.Stage = 'staging'\"\n    Prerequisites:\n      - Released\n",
        "  - Name: staging\n    WhereSpace: \"Labels.Stage = 'staging'\"\n",
      ), /the staging stage must be entered only once the stage ahead has Released/],
      ["Healthy declared", (text) => text.replace(
        "  - Name: prod\n    WhereSpace: \"Labels.Stage = 'prod'\"\n    Prerequisites:\n      - Released\n",
        "  - Name: prod\n    WhereSpace: \"Labels.Stage = 'prod'\"\n    Prerequisites:\n      - Released\n      - Healthy\n",
      ), /the prod stage must be entered only once|must not declare Healthy/],
      ["stages out of wave order", (text) => text
        .replace("Name: pilot", "Name: placeholder")
        .replace("Name: staging", "Name: pilot")
        .replace("Name: placeholder", "Name: staging"), /stages must be the waves in order/],
      ["a stage selecting another label", (text) => text.replace("WhereSpace: \"Labels.Stage = 'pilot'\"", "WhereSpace: \"Labels.Environment = 'pilot'\""), /the pilot stage must select the Spaces labelled Stage=pilot/],
    ]) {
      expectFailure(
        () => loadRolloutPlan(tamperedExampleRoot(workRoot, `workflow-${label.replaceAll(" ", "-")}`, edit, "change-workflow.yaml")),
        pattern,
        `reviewed workflow refusal: ${label}`,
      );
    }

    // The pin this chapter reads, and the controller image rule the gateway
    // forces on top of it. The checks read the lock rather than naming a
    // version, the way the rehearsal checks its own pin.
    const sveltos = loadSveltosPin();
    const pinnedImage = pinnedAddonControllerImage(sveltos);
    check(
      /^v\d+\.\d+\.\d+$/.test(sveltos.version)
        && sveltos.manifestUrl.includes(sveltos.version)
        && /^[0-9a-f]{64}$/.test(sveltos.manifestSha256)
        && typeof sveltos.releasedControllerReadsGatewayLayers === "boolean",
      "the chapter three Sveltos pin lost its shape",
    );
    // The committed pin is a release whose own controller reads the gateway's
    // layers, so the run records it as released and never overrides it.
    check(
      sveltos.releasedControllerReadsGatewayLayers === true
        && pinnedImage === `${addonControllerRepository}:${sveltos.version}`,
      "the chapter three pin must be a release whose addon controller reads the gateway's layers",
    );
    check(
      resolveAddonControllerImage(sveltos) === pinnedImage,
      "the default addon controller image no longer follows the pin",
    );
    const overrideImage = `${pinnedImage}-ch`;
    assertAddonControllerFitsPin(sveltos, pinnedImage);
    expectFailure(
      () => assertAddonControllerFitsPin(sveltos, overrideImage),
      /reads the gateway's gzipped layers itself, so this chapter runs .* as released; unset SVELTOS_ADDON_CONTROLLER_IMAGE/,
      "override on a pin whose released controller reads the layers",
    );
    // A pin whose released controller does not read the layers, as v1.13.0's
    // did not, still takes the override; the mechanism stays for that case.
    assertAddonControllerFitsPin(
      { ...sveltos, releasedControllerReadsGatewayLayers: false },
      overrideImage,
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
    download.bytes = fakeSveltosManifest(pinnedImage, sveltos.version);
    const syntheticPin = {
      version: sveltos.version,
      manifestUrl: sveltos.manifestUrl,
      manifestSha256: sha256(download.bytes),
      releasedControllerReadsGatewayLayers: false,
    };
    // The preload list is the manifest's own image lines: every controller it
    // names, the one the hardcoded list never knew included, with the pinned
    // addon controller swapped for the image the lane runs, and no agent
    // digest invented for a version that has none recorded.
    const pinnedManifest = fetchPinnedManifest({ workRoot, sveltos: syntheticPin });
    const fromManifest = manifestImages(pinnedManifest);
    check(
      fromManifest.length === 2
        && fromManifest.includes(pinnedImage)
        && fromManifest.includes(`docker.io/projectsveltos/register-mgmt-cluster:${sveltos.version}`),
      "the manifest's image lines must be read once each",
    );
    const releasedPreload = sveltosPreloadList({
      version: sveltos.version,
      addonControllerImage: pinnedImage,
      images: fromManifest,
    });
    const overriddenPreload = sveltosPreloadList({
      version: sveltos.version,
      addonControllerImage: overrideImage,
      images: fromManifest,
    });
    check(
      sameSet(releasedPreload, fromManifest)
        && overriddenPreload.includes(overrideImage)
        && !overriddenPreload.includes(pinnedImage)
        && sveltosAgentPreloaded(sveltos.version) === false
        && !releasedPreload.some((image) => image.includes("sveltos-agent")),
      "the preload must be exactly the pinned manifest's images, with no agent digest invented",
    );
    // The other chapters pass no manifest and keep the list they always had.
    const legacyPreload = sveltosPreloadList({
      version: "v1.13.0",
      addonControllerImage: `${addonControllerRepository}:v1.13.0-ch`,
    });
    check(
      legacyPreload.length === 10
        && legacyPreload.includes(`${addonControllerRepository}:v1.13.0-ch`)
        && legacyPreload.some((image) => image.includes("sveltos-agent@sha256:"))
        && !legacyPreload.some((image) => image.includes("register-mgmt-cluster")),
      "the v1.13.0 chapters' preload list must stay exactly as it was",
    );
    check(
      imagePreloadRecord(sveltos, releasedPreload).sveltosAgent.startsWith("not preloaded"),
      "the receipt must say the agent is pulled by the nodes when no digest is recorded",
    );
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
    download.bytes = fakeSveltosManifest("docker.io/projectsveltos/other:v1", sveltos.version);
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
        registration.cluster === plan.clusters[index].cluster
        && registration.labels.environment === plan.clusters[index].environment
        && registration.ready === true
        && registration.credential.storedInRepository === false)
        && new Set(registrations.map((row) => row.cluster)).size === 4,
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

    // The gate preflight is what npm run sveltos-gate:probe runs live. It
    // reads the filter's resolved triggers through a wired probe Space,
    // creates the reviewed workflow there and reads it back, and removes the
    // Space. It must pass on what the organization carries now and refuse,
    // naming the problem, each way the organization or the client could
    // still carry the old mechanism.
    assertAttestationClient();
    hub.state.clientPredatesAttestations = true;
    expectFailure(
      () => assertAttestationClient(),
      /cannot record an approval of a change order in a stage/,
      "a cub that predates attestations",
    );
    hub.state.clientPredatesAttestations = false;
    const topology = probeGates(policyContext, "20260807000000", plan);
    check(
      topology.triggerRefs.length > 0
        && !topology.triggerRefs.includes(retiredApprovalTrigger)
        && topology.triggerRefs.every((ref) => catalogTriggerRefs.includes(ref))
        && topology.triggerIds.length === topology.triggerRefs.length
        && !spacePresent(policyContext, "hx-sveltos-env-probe-20260807000000"),
      "the gate preflight must read the filter's validating triggers, none of them the retired approval trigger, and remove its probe Space",
    );
    for (const [label, setUp, pattern] of [
      ["the retired approval trigger still resolved", () => {
        hub.state.resolvedTriggerRefs = [...hub.state.resolvedTriggerRefs, retiredApprovalTrigger];
      }, /still resolves platform\/require-approval, whose function ConfigHub removed/],
      ["a filter that resolves nothing", () => {
        hub.state.resolvedTriggerRefs = [];
      }, /resolved no trigger for .*, so the Spaces would carry no validating gate/],
      ["a trigger the profile does not define", () => {
        hub.state.resolvedTriggerRefs = [...hub.state.resolvedTriggerRefs, "platform/somebody-elses-check"];
      }, /resolves platform\/somebody-elses-check, which the committed profile .* does not define/],
      ["a server that drops the approval requirement", () => {
        hub.state.dropAttestationPrerequisites = true;
      }, /answered without Stages and AttestationPrerequisites|without the reviewed approval requirement/],
    ]) {
      const saved = [...hub.state.resolvedTriggerRefs];
      setUp();
      expectFailure(
        () => probeGates(policyContext, "20260807000001", plan),
        pattern,
        `gate preflight refusal: ${label}`,
      );
      check(
        !spacePresent(policyContext, "hx-sveltos-env-probe-20260807000001"),
        `the refused gate preflight (${label}) did not delete its probe Space`,
      );
      hub.state.resolvedTriggerRefs = saved;
      hub.state.dropAttestationPrerequisites = false;
    }

    // The fake answers the ChangeWorkflow verbs the way the live probe of
    // 2026-09-26 recorded the server answering, and the attestation verbs
    // the way the probe of the same day recorded them, before the walk
    // relies on either.
    replayChangeWorkflowProbe(hub, workRoot);
    replayAttestationProbe(hub, workRoot);

    // The whole path: one run-scoped component, one base record in it, four
    // variants cloned from it each carrying its environment as its stage, the
    // management record in a component of its own, one workflow from the
    // reviewed file, the baseline released through a change order of its
    // own stage by stage with each release refused until approved, delivery
    // through the gateway, one change on the base captured by one change
    // order, the server refusing a skipped stage, and three stages promoted
    // by ConfigHub, each release refused until approved.
    const policySpacesCreated = new Set();
    const baseSpace = spaceName(`hx-sveltos-env-base-${runId}`);
    const spaceFor = Object.fromEntries([
      ...plan.clusters.map((row) => [row.cluster, spaceName(`${row.cluster}-${runId}`)]),
      [plan.management.cluster, spaceName(`${plan.management.cluster}-${runId}`)],
    ]);
    const components = runScopedComponents(componentLabel, runId);
    check(
      components.base === `${componentLabel}-${runId}`
        && components.management === `${componentLabel}-management-${runId}`
        && components.base !== runScopedComponents(componentLabel, "20260812091501").base,
      "each run must get components of its own, named for the run",
    );
    createComponent(policyContext, components.base, runId);
    const baseRecord = establishBase({
      policyContext,
      space: baseSpace,
      plan,
      topology,
      runId,
      policySpacesCreated,
      component: components.base,
    });
    check(
      baseRecord.published === false
        && baseRecord.target === "none"
        && baseRecord.component === components.base
        && baseRecord.revisionId === plan.base.revisions.baseline,
      "the base record must be stored in the run's component without a target and without a release",
    );
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
        stage: row.environment,
      });
    }
    check(
      plan.clusters.every((row) =>
        variantRecords[row.cluster].upstream.space === baseSpace
        && variantRecords[row.cluster].upstream.unitLinked === true
        && variantRecords[row.cluster].stage === row.environment
        && hub.spaceLabels(spaceFor[row.cluster])?.Stage === row.environment
        && variantRecords[row.cluster].clusterRef.name === row.cluster),
      "every variant must be linked to the base, carry its environment as its stage, and address its own cluster",
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

    createComponent(policyContext, components.management, runId);
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
      component: components.management,
    });
    const membershipArgs = {
      policyContext,
      baseSpace,
      spaceFor,
      plan,
      components,
    };
    const membership = assertComponentMembership(membershipArgs);
    check(
      membership.component.slug === components.base
        && sameSet(membership.component.spaces, [
          baseSpace,
          ...plan.clusters.map((row) => spaceFor[row.cluster]),
        ])
        && membership.managementComponent.id !== membership.component.id
        && sameSet(membership.managementComponent.spaces, [
          spaceFor[plan.management.cluster],
        ]),
      "the base and its four variants must share the run's component and the management Space must sit alone in its own",
    );
    // The management Space attached to the base's component is the shape that
    // would put it in every change order's scope, so membership refuses it.
    hub.handle([
      "space", "update", spaceFor[plan.management.cluster],
      "--component", components.base, "--quiet",
    ]);
    expectFailure(
      () => assertComponentMembership(membershipArgs),
      /must sit in a component of its own, never in the base's/,
      "management Space in the base's component",
    );
    hub.handle([
      "space", "update", spaceFor[plan.management.cluster],
      "--component", components.management, "--quiet",
    ]);
    // A variant whose Space lost its Stage label is a cluster no stage reaches.
    hub.setSpaceLabel(spaceFor["hx-sveltos-env-staging"], "Stage", "prod");
    expectFailure(
      () => assertComponentMembership(membershipArgs),
      /carries Stage=prod rather than staging/,
      "variant carrying the wrong stage",
    );
    hub.setSpaceLabel(spaceFor["hx-sveltos-env-staging"], "Stage", "staging");
    // The base carrying a Stage label would be selected by a stage.
    hub.setSpaceLabel(baseSpace, "Stage", "pilot");
    expectFailure(
      () => assertComponentMembership(membershipArgs),
      /so a workflow stage would select the base/,
      "base carrying a stage",
    );
    hub.setSpaceLabel(baseSpace, "Stage", undefined);
    const workflow = openChangeWorkflow({
      policyContext,
      baseSpace,
      plan,
      runId,
      component: components.base,
    });
    check(
      workflow.ref === `${baseSpace}/${workflowSlug(runId)}`
        && workflow.stages.join(",") === "pilot,staging,prod"
        && workflow.prerequisites.join(",") === "Released"
        && workflow.stageGates.every((row) =>
          stableJson(row.releasePrerequisites) === stableJson([approvalRequirement]))
        && workflow.stageGates.map((row) => row.prerequisites.join("+")).join(",") === ",Released,Released"
        && workflow.attestationPrerequisites[0].AllowAuthors === true
        && workflow.separationOfDuties.relaxed === true
        && workflow.healthy.declared === false
        && workflow.workflowRequired.enforcedOnPlainPublish === false
        && hub.componentRequires(components.base) === workflow.ref,
      "the run must hold one workflow from the reviewed file in the base Space, every stage gated at release on one approval, the later ones entered on Released, and the component declaring it required",
    );
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

    // The baseline path fails closed. Each way it can misbehave stops the
    // run with the step named, before anything is released outside the
    // gate; the fake is rolled back after each so the real baseline starts
    // clean.
    const baselineArgs = {
      policyContext,
      baseSpace,
      plan,
      runId,
      spaceFor,
      workflow,
      membership,
      managementVariant,
    };
    for (const [label, flag, pattern] of [
      ["a baseline change order ConfigHub refuses", "refuseChangeOrderCreate", /the baseline change order path failed at creating the baseline change order: .*so the run stops rather than publish a baseline outside a change order/],
      ["a baseline promotion ConfigHub refuses", "refusePromotion", /the baseline change order path failed at promoting it into pilot: /],
      ["a no-change promotion that cuts a revision", "noChangePromotionCutsRevision", /failed at promoting it into pilot: hx-sveltos-env-pilot moved from revision \d+ to \d+, but a change order with no change must mark the variant where it stands/],
      ["a release gate that does not hold", "releaseGateDisabled", /failed at releasing pilot: ConfigHub published .* before anyone approved it; the pilot stage's release gate did not hold/],
      ["a release refused for another reason", "refuseIdenticalBundles", /failed at releasing pilot: the baseline pilot release of hx-sveltos-env-pilot was refused for a reason other than its missing approval: .*no changes were made since :latest bundle/],
      ["an approval ConfigHub does not record", "refuseApprovals", /failed at releasing pilot: ConfigHub did not record the approval of .* in the pilot stage/],
    ]) {
      const saved = hub.snapshot();
      if (flag === "refuseIdenticalBundles") {
        // What the probe measured: a plain publish earlier left identical
        // content published, so the pinned one has nothing new to bundle.
        hub.handle(["release", "publish", spaceFor["hx-sveltos-env-pilot"], "-o", "json"]);
      } else {
        hub.state[flag] = true;
      }
      expectFailure(() => releaseBaseline(baselineArgs), pattern, `baseline fails closed on ${label}`);
      hub.restore(saved);
    }
    const baselineRelease = releaseBaseline(baselineArgs);
    check(
      baselineRelease.path === baselinePath
        && baselineRelease.changeOrder.slug === baselineOrderSlug(runId)
        && baselineRelease.changeOrder.carriesBaseChange === false
        && baselineRelease.stages.map((row) => row.stage).join(",") === "pilot,staging,prod"
        && baselineRelease.selection.matched.length === 5
        && plan.clusters.every((row) => {
          const record = baselineRelease.records[row.cluster];
          return releaseGateRefused(record.releaseGate.message)
            && /has 0 of 1/.test(record.releaseGate.message)
            && /from eligible attesters;/.test(record.releaseGate.message)
            && record.release.revision === `ChangeOrder:${baselineOrderSlug(runId)}`
            && record.approval.command === stageApprovalCommand(row.environment);
        })
        && baselineRelease.management.release === null
        && baselineRelease.management.approval.gatedServerSide === false,
      "every baseline release must be refused by its stage's gate, approved as an attestation, and published through the baseline change order, and the management record approved without a release",
    );
    check(
      plan.clusters.every((row) =>
        hub.releasedChangeOrders(spaceFor[row.cluster])
          .includes(baselineRelease.changeOrder.ref))
        && hub.attestationsOn(spaceFor[plan.management.cluster]) === 1,
      "every variant must have released the baseline change order, and the management record must carry one approval",
    );
    for (const row of plan.clusters) {
      variantRecords[row.cluster].baseline = baselineRelease.records[row.cluster];
    }
    managementVariant.baseline = baselineRelease.management;

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

    // A Space outside the run attached to the run's component is the shape a
    // shared component produces: an earlier run's variant in this change
    // order's scope. The scope check refuses it.
    const strayVariant = spaceName(`hx-sveltos-env-staging-20260101000000`);
    hub.handle([
      "space", "create", strayVariant,
      "--label", `Component=${componentLabel}`,
      "--trigger-filter", gateFilterRef, "--where-trigger", "-",
      "--component", components.base, "--quiet",
    ]);
    const strayOrder = createChangeOrder(policyContext, {
      space: baseSpace,
      slug: "self-test-stray-scope",
      workflowRef: workflow.ref,
      description: "Change order created while another run's Space shares the component",
    });
    expectFailure(
      () => assertChangeOrderScope(strayOrder, membership),
      /rather than exactly the base and its four variants; a Space outside this run is in its scope/,
      "another run's variant in the change order's scope",
    );
    hub.handle(["space", "delete", strayVariant, "--recursive-force", "--quiet"]);

    const changeOrder = openChangeOrder({
      policyContext,
      baseSpace,
      plan,
      runId,
      workflow,
      membership,
      baseChange,
    });
    check(
      changeOrder.ref === `${baseSpace}/${changeOrderSlug(runId)}`
        && changeOrder.workflow === workflow.ref
        && sameSet(changeOrder.inScopeSpaces, membership.component.spaces)
        && !changeOrder.inScopeSpaces.includes(spaceFor[plan.management.cluster]),
      "the change order must be headed for exactly the base and its four variants",
    );

    // The runner fails if the server lets the change skip a stage. With the
    // gate switched off in the fake the skipped promotion lands, the runner
    // refuses to record it, and the variants it moved are put back.
    hub.state.ignoreStageGates = true;
    expectFailure(
      () => assertStageGateRefuses({ policyContext, plan, changeOrder, spaceFor }),
      /promoted .* into staging before pilot released it; the Released gate did not hold the stage order/,
      "a skipped stage that the server allowed",
    );
    hub.state.ignoreStageGates = false;
    hub.restoreVariantBaselines();
    const gateRefusal = assertStageGateRefuses({
      policyContext,
      plan,
      changeOrder,
      spaceFor,
    });
    check(
      gateRefusal.refused === true
        && gateRefusal.targetStage === "staging"
        && gateRefusal.stageAhead === "pilot"
        && gateRefusal.headsUnchanged === true
        && gateRefusal.message.includes("unable to promote to stage 'staging'"),
      "the server's refusal to skip into staging must be recorded in its own words",
    );

    // The trap: when the merge hands back the variant's own content, the wave
    // is refused rather than recorded as promoted.
    const walkCheckpoints = synthesizeCheckpoints(plan);
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
        checkpoints: walkCheckpoints.slice(0, 1),
        changeOrder,
        membership,
      }),
      /did not come out of the upgrade as the reviewed merge: inheritedTheChange=false/,
      "silent departure win refusal",
    );
    hub.state.mergeKeepsDepartureOnly = false;
    hub.restoreVariantBaselines();

    // A stage whose Stage labels no longer name the wave is refused before
    // the promotion runs.
    hub.setSpaceLabel(spaceFor["hx-sveltos-env-pilot"], "Stage", "staging");
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
        checkpoints: walkCheckpoints.slice(0, 1),
        changeOrder,
        membership,
      }),
      /the pilot stage selects no Space rather than the wave's variants/,
      "a stage that is not the wave",
    );
    hub.setSpaceLabel(spaceFor["hx-sveltos-env-pilot"], "Stage", "pilot");

    // The guard: a wave whose preceding checkpoint shows an unhealthy cluster
    // in the environment just promoted refuses to request the next approval,
    // before its set is even listed.
    const sickCheckpoints = synthesizeCheckpoints(plan).slice(0, 2);
    sickCheckpoints[1].observations
      .find((row) => row.environment === "pilot").observation.result = "fail";
    expectFailure(
      () => promoteWave({
        policyContext,
        managementKubeconfig,
        managementName,
        wave: plan.waves[1],
        plan,
        spaceFor,
        runId,
        variantRecords,
        checkpoints: sickCheckpoints,
        changeOrder,
        membership,
      }),
      /wave 2 approval refused: .* did not report healthy at after-wave-1/,
      "unhealthy pilot refuses wave two's approval",
    );
    // And a wave whose evidence is missing a cluster is refused the same way.
    const incompleteCheckpoints = synthesizeCheckpoints(plan).slice(0, 1);
    incompleteCheckpoints[0].observations.pop();
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
        checkpoints: incompleteCheckpoints,
        changeOrder,
        membership,
      }),
      /the evidence is incomplete/,
      "a checkpoint missing a cluster is not unlock evidence",
    );

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
        checkpoints: walkCheckpoints.slice(0, wave.wave),
        changeOrder,
        membership,
      }));
    }
    check(
      waveRecords.map((wave) => wave.clusters.length).join(",") === "1,1,2"
        && waveRecords[2].approval.recordedApprovals === 2
        && waveRecords[2].approval.command === stageApprovalCommand("prod")
        && waveRecords[2].clusters.every((row) =>
          row.approval === "attestation" && releaseGateRefused(row.releaseRefusal))
        && new Set(waveRecords[2].clusters.map((row) => row.revisionId)).size === 2
        && new Set(waveRecords[2].clusters.map((row) => row.releaseManifestDigest))
          .size === 2,
      "wave three must refuse both production releases, approve the change in the prod stage in one operation, and release both variants separately",
    );
    // Each attestation covers the exact revision it approved. The change's
    // approval is a second one on each variant, because the change is new
    // content that the baseline's approval does not cover.
    check(
      plan.clusters.every((row) => hub.attestationsOn(spaceFor[row.cluster]) === 2),
      "each variant must carry exactly two approvals: its baseline and the change",
    );
    check(
      waveRecords.every((wave) =>
        wave.upgrade === undefined
        && wave.promotion.command === promoteCommand(wave.environment)
        && wave.promotion.changeOrder === changeOrder.ref
        && wave.clusters.every((row) =>
          row.releaseRevision === `ChangeOrder:${changeOrder.slug}`)),
      "every wave must be a stage ConfigHub promoted, each variant releasing where the change order arrived",
    );
    // The fake records which releases carried the change, which is what the
    // Released gate read before letting each later stage in.
    check(
      plan.clusters.every((row) =>
        hub.releasedChangeOrders(spaceFor[row.cluster]).includes(changeOrder.ref)),
      "every variant must have released the change order before the rollout closed",
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
      managementName,
      managementRegistration,
      sveltosInstall: fakeSveltosInstall(sveltos, pinnedImage, releasedPreload),
      gatewayCredential,
      registrations,
      baseRecord,
      baseChange,
      baselineRelease,
      variantRecords,
      managementVariant,
      bootstrap,
      waveRecords,
      checkpoints: synthesizeCheckpoints(plan),
      convergenceAudit: synthesizeAudit(plan),
      cleanup: removedCleanup(),
      changeManagement: {
        membership,
        workflow,
        changeOrder,
        gateRefusal,
      },
    });
    check(verifyReceipt(receipt) === true, "the self-test receipt was not recognized as an attestation-design record");
    const summary = renderSummary(receipt);
    check(
      summary.includes(
        receipt.spec.variants[3].records[1].release.manifestDigest,
      )
        && summary.includes(`oci://${configHubOciHost}/space/`)
        && summary.includes(pinnedImage)
        && summary.includes("Convergence audit")
        && summary.includes(gateRefusal.message)
        && summary.includes(changeOrder.slug)
        && summary.includes(workflowSlug(runId))
        && summary.includes("`spec.stopMatchingBehavior=LeavePolicies`"),
      "the rendered summary lost its evidence",
    );

    // The keep-alive flag leaves the record honest rather than reading as a
    // failed cleanup, and it still has to say what it left and how to remove it.
    const kept = structuredClone(receipt);
    kept.spec.cleanup = keptCleanup();
    check(verifyReceipt(kept) === true, "a kept run must still verify");
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

    // A receipt still on the per-environment path, or still on the shared
    // catalog target, is recognized, not verified, and does not throw.
    const superseded = structuredClone(receipt);
    delete superseded.spec.variants;
    check(
      verifyReceipt(superseded) === false,
      "a per-environment receipt must be recognized as recorded, not verified as current",
    );
    const untargeted = structuredClone(receipt);
    for (const variant of untargeted.spec.variants) delete variant.target;
    check(
      verifyReceipt(untargeted) === false,
      "a receipt without any Target must be recognized as pre-dating the per-cluster Target model",
    );
    // The shape committed on 2026-08-21: every wave a set upgrade the runner
    // issued, and no component, workflow, or change order recorded.
    const preWorkflow = structuredClone(receipt);
    delete preWorkflow.spec.changeManagement;
    for (const wave of preWorkflow.spec.waves) {
      delete wave.promotion;
      delete wave.stage;
      delete wave.release;
      wave.upgrade = {
        command: recordedUpgradeCommand,
        appliedAsOneOperation: true,
        members: wave.clusters.length,
      };
    }
    check(
      predatesChangeWorkflow(preWorkflow) && verifyReceipt(preWorkflow) === false,
      "a receipt of the runner-issued upgrade shape must be recognized as pre-dating the ChangeWorkflow design",
    );
    // Half of that shape is not that shape: waves still promoted as stages
    // with the change management removed is a tamper, not an old recording.
    const halfPreWorkflow = structuredClone(receipt);
    halfPreWorkflow.spec.waves[0].upgrade = { command: recordedUpgradeCommand };
    check(
      !predatesChangeWorkflow(halfPreWorkflow),
      "a receipt with one upgraded wave among promoted stages must not pass as an old recording",
    );
    // The committed recording is that shape, and it stays recognised as
    // awaiting its re-record, never verified against this design.
    if (existsSync(receiptPath)) {
      check(
        verifyReceipt(readYaml(receiptPath)) === false,
        "the committed chapter-three receipt must be recognised as predating the attestation design and awaiting its live re-record",
      );
    }

    const managementSpaceOf = (c) =>
      c.spec.variants.find((row) => row.role === "management").space;
    const renameBaseComponent = (c, slug) => {
      c.spec.changeManagement.component.slug = slug;
      for (const row of c.spec.variants) {
        if (row.role === "workload") row.component = slug;
      }
    };
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
      ["target dropped", (c) => { delete c.spec.variants[0].target; }, /must release to its own cluster's Target/],
      ["target renamed", (c) => { c.spec.variants[0].target.name = "somewhere-else"; }, /must release to its own cluster's Target/],
      ["target provider", (c) => { c.spec.variants[0].target.provider = "Kubernetes"; }, /must release to its own cluster's Target/],
      ["targets shared", (c) => { c.spec.variants[1].target = { ...c.spec.variants[0].target }; c.spec.variants[1].target.name = c.spec.variants[1].cluster; c.spec.variants[1].target.ref = `${targetHost.space}/${c.spec.variants[1].cluster}`; }, /two variants share a Target/],
      ["shared catalog target reintroduced", (c) => { c.spec.policy.target = { ref: "catalog/oci-target" }; }, /shared catalog target is retired/],
      ["clusterRef renamed", (c) => {
        c.spec.variants[2].clusterRef.name = c.spec.variants[3].cluster;
      }, /must name its own SveltosCluster/],
      ["clusterRef wrong kind", (c) => {
        c.spec.variants[2].clusterRef.kind = "Cluster";
      }, /must name its own SveltosCluster/],
      ["clusterRef dropped", (c) => {
        delete c.spec.variants[2].clusterRef;
      }, /must name its own SveltosCluster/],
      ["selector reintroduced", (c) => {
        c.spec.variants[2].selector = { cluster: c.spec.variants[2].cluster };
      }, /must name its own SveltosCluster/],
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
      ["controller overridden on a released pin", (c) => {
        const override = `${pinnedImage}-ch`;
        c.spec.prerequisite.addonControllerImage = override;
        c.spec.prerequisite.addonControllerImageOverridden = true;
        c.spec.gatewayDelivery.addonControllerImage = override;
        c.spec.prerequisite.imagePreload.images = c.spec.prerequisite.imagePreload.images
          .map((image) => (image === pinnedImage ? override : image));
      }, /reads the gateway's layers itself, so the run must record .* as released and not overridden/],
      ["controller marked overridden on a released pin", (c) => {
        c.spec.prerequisite.addonControllerImageOverridden = true;
      }, /as released and not overridden/],
      ["the v1.13.0-ch build on the v1.15.0 pin", (c) => {
        const historical = `${addonControllerRepository}:v1.13.0-ch`;
        c.spec.prerequisite.addonControllerImage = historical;
        c.spec.gatewayDelivery.addonControllerImage = historical;
      }, /as released and not overridden/],
      ["prerequisite on the old pin", (c) => { c.spec.prerequisite.version = "v1.13.0"; }, /prerequisite record changed/],
      ["preload list dropped", (c) => { delete c.spec.prerequisite.imagePreload; }, /images preloaded from the pinned manifest/],
      ["preload from another version", (c) => {
        c.spec.prerequisite.imagePreload.images.push("docker.io/projectsveltos/classifier:v1.13.0");
      }, /images preloaded from the pinned manifest, each at/],
      ["preload without the controller that ran", (c) => {
        c.spec.prerequisite.imagePreload.images = c.spec.prerequisite.imagePreload.images
          .filter((image) => image !== pinnedImage);
      }, /images preloaded from the pinned manifest/],
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
      ["registration renamed", (c) => { c.spec.fleet.registrations[3].cluster = c.spec.fleet.registrations[2].cluster; }, /registered under its own SveltosCluster name/],
      ["registration not ready", (c) => { c.spec.fleet.registrations[3].ready = false; }, /registered under its own SveltosCluster name/],
      // The attestation path.
      ["gate observation dropped", (c) => { delete c.spec.variants[0].records[1].releaseGate; }, /approval must follow the release gate's refusal/],
      ["approval without a preceding refusal", (c) => {
        c.spec.variants[1].records[0].releaseGate.result = "not-attempted";
      }, /approval must follow the release gate's refusal/],
      ["refusal for another reason", (c) => {
        c.spec.variants[2].records[1].releaseGate.message = "Failed: HTTP 400 for req self-test: no changes were made since :latest bundle";
      }, /approval must follow the release gate's refusal/],
      ["wave gate observation dropped", (c) => { delete c.spec.waves[1].clusters[0].releaseRefusal; }, /must record, for hx-sveltos-env-staging, the release gate refusing the release before the approval/],
      ["approval not an attestation", (c) => { c.spec.variants[2].records[0].approval.kind = "ApprovedBy"; }, /must be recorded as an Approval attestation/],
      ["approval changed the head", (c) => { c.spec.variants[3].records[1].approval.headUnchanged = false; }, /left the record's head and content unchanged/],
      ["old unit approve command reintroduced", (c) => {
        c.spec.waves[1].approval.command = 'cub unit approve --space "*" --where <query> --revision HeadRevisionNum';
      }, /must not record the removed per-unit approve command/],
      ["old unit approve on a variant record", (c) => {
        c.spec.variants[0].records[0].approval.command = "cub unit approve --space <space> clusterprofile";
      }, /must not record the removed per-unit approve command/],
      ["approval gate reintroduced", (c) => { c.spec.policy.approvalGate = "platform/require-approval/vet-approvedby"; }, /records the mechanism ConfigHub removed/],
      ["approval trigger reintroduced", (c) => {
        c.spec.policy.filter.triggerRefs = [...c.spec.policy.filter.triggerRefs, retiredApprovalTrigger];
        c.spec.policy.filter.triggerIds = [...c.spec.policy.filter.triggerIds, "self-test-trigger-require-approval"];
      }, /records the mechanism ConfigHub removed/],
      ["management approval missing", (c) => {
        delete c.spec.variants.find((row) => row.role === "management").records[0].approval;
      }, /approval must be recorded as an Approval attestation/],
      ["management approval claimed gated", (c) => {
        c.spec.variants.find((row) => row.role === "management").records[0].approval.gatedServerSide = true;
      }, /nothing server-side gates/],
      ["management approval dropped from the baseline", (c) => { delete c.spec.baselineRelease.management; }, /record the management approval as an attestation nothing server-side gates/],
      ["baseline path unrecorded", (c) => { delete c.spec.baselineRelease.path; }, /must record which path the baseline took/],
      ["baseline released at the head", (c) => { c.spec.baselineRelease.path = "plain publish at the head"; }, /must record which path the baseline took/],
      ["baseline release unpinned", (c) => { delete c.spec.variants[0].records[0].release.revision; }, /baseline release must bundle ChangeOrder:baseline-/],
      ["baseline change order carries a change", (c) => { c.spec.baselineRelease.changeOrder.carriesBaseChange = true; }, /carry no change/],
      ["baseline stage skipped", (c) => { c.spec.baselineRelease.stages.pop(); }, /released stage by stage, in the workflow's order/],
      ["baseline set approval reintroduced", (c) => {
        c.spec.baselineApproval = { command: 'cub unit approve --space "*" --where <query> --revision HeadRevisionNum' };
      }, /must not record the removed per-unit approve command|set approval of every record is the mechanism ConfigHub removed/],
      ["AllowAuthors silently flipped", (c) => {
        c.spec.changeManagement.workflow.attestationPrerequisites[0].AllowAuthors = false;
      }, /approval requirement must be recorded as the reviewed workflow declares it/],
      ["AllowAuthors flipped with its statement", (c) => {
        c.spec.changeManagement.workflow.attestationPrerequisites[0].AllowAuthors = false;
        c.spec.changeManagement.workflow.separationOfDuties.allowAuthors = false;
        c.spec.changeManagement.workflow.separationOfDuties.relaxed = false;
      }, /approval requirement must be recorded as the reviewed workflow declares it/],
      ["separation of duties unstated", (c) => { delete c.spec.changeManagement.workflow.separationOfDuties.statement; }, /relaxes separation of duties/],
      ["strict-mode refusal unquoted", (c) => { c.spec.changeManagement.workflow.separationOfDuties.strictModeRefusal = "it was refused"; }, /quote what the strict setting refused/],
      ["release gate dropped from a stage", (c) => { c.spec.changeManagement.workflow.stageGates[2].releasePrerequisites = []; }, /every stage must gate its releases on approval/],
      ["workflow from another file", (c) => { c.spec.changeManagement.workflow.file.rawSha256 = "0".repeat(64); }, /be created from the reviewed/],
      ["workflow source unrecorded", (c) => { delete c.spec.source.workflow; }, /workflow record changed/],
      ["workflow-required claimed enforced", (c) => { c.spec.changeManagement.workflow.workflowRequired.enforcedOnPlainPublish = true; }, /does not yet enforce it on a plain publish/],
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
      ["baseline set shrunk", (c) => { c.spec.baselineRelease.matched.pop(); }, /must select every record the run created/],
      ["baseline stage approval iterated", (c) => { c.spec.baselineRelease.stages[1].approval.kind = "ApprovedBy"; }, /approved as an attestation, and released stage by stage/],
      ["wave query dropped", (c) => { c.spec.waves[2].selection.query = ""; }, /must record the query that selected its set/],
      ["wave matched set", (c) => { c.spec.waves[2].selection.matched.pop(); }, /must record the query that selected its set/],
      ["wave member dropped", (c) => { c.spec.waves[2].clusters.pop(); }, /rather than the prod clusters/],
      ["wave approvals miscounted", (c) => { c.spec.waves[2].approval.recordedApprovals = 1; }, /approve the change in its stage as one attestation operation/],
      ["wave approval iterated", (c) => { c.spec.waves[2].approval.appliedAsOneOperation = false; }, /one operation/],
      ["wave promotion iterated", (c) => { c.spec.waves[2].promotion.appliedAsOneOperation = false; }, /one operation/],
      ["change management dropped", (c) => { delete c.spec.changeManagement; }, /must record its change management/],
      ["gate refusal dropped", (c) => { delete c.spec.changeManagement.gateRefusal; }, /server refusing to promote into staging before pilot released the change/],
      ["gate not refused", (c) => { c.spec.changeManagement.gateRefusal.refused = false; }, /server refusing to promote into staging/],
      ["gate refusal message dropped", (c) => { c.spec.changeManagement.gateRefusal.message = ""; }, /in the server's own words/],
      ["gate refusal moved a variant", (c) => { c.spec.changeManagement.gateRefusal.headsUnchanged = false; }, /server refusing to promote into staging/],
      ["management Space in the base component", (c) => {
        c.spec.changeManagement.component.spaces.push(managementSpaceOf(c));
      }, /management Space must not join the base's component/],
      ["management Space in the change order's scope", (c) => {
        c.spec.changeManagement.changeOrder.inScopeSpaces.push(managementSpaceOf(c));
      }, /headed for exactly the base's component, never the management Space/],
      // A coherent forgery: the receipt says, everywhere, that the base and
      // its variants sit in a component another run could share.
      ["shared component", (c) => { renameBaseComponent(c, componentLabel); }, /must be run-scoped/],
      ["another run's component", (c) => {
        renameBaseComponent(c, `${componentLabel}-20260101000000`);
      }, /must be run-scoped/],
      ["component not marked run-scoped", (c) => { c.spec.changeManagement.component.runScoped = false; }, /must be run-scoped/],
      ["management shares the base component", (c) => {
        c.spec.changeManagement.managementComponent.id = c.spec.changeManagement.component.id;
      }, /must sit alone in its own run-scoped component/],
      ["management component shared across runs", (c) => {
        c.spec.changeManagement.managementComponent.slug = `${componentLabel}-management`;
        c.spec.variants.find((row) => row.role === "management").component =
          `${componentLabel}-management`;
      }, /must sit alone in its own run-scoped component/],
      ["another run's variant in scope", (c) => {
        c.spec.changeManagement.changeOrder.inScopeSpaces.push("hx-sveltos-env-staging-20260101000000");
      }, /headed for exactly the base's component/],
      ["Healthy declared", (c) => { c.spec.changeManagement.workflow.prerequisites.push("Healthy"); }, /must live in the base Space, be created from the reviewed .*, hold the stages/],
      ["Healthy reason dropped", (c) => { c.spec.changeManagement.workflow.healthy.reason = "not needed"; }, /Healthy gate must stay undeclared/],
      ["workflow stages reordered", (c) => {
        c.spec.changeManagement.workflow.stages = ["staging", "pilot", "prod"];
      }, /hold the stages pilot, staging, prod in that order/],
      ["change order before the edit", (c) => {
        c.spec.changeManagement.changeOrder.createdAfterBaseRevision = c.spec.base.revision;
      }, /created after the reviewed edit landed on the base/],
      ["wave upgrade reintroduced", (c) => {
        c.spec.waves[1].upgrade = { command: recordedUpgradeCommand, appliedAsOneOperation: true, members: 1 };
      }, /not a set upgrade the runner issued/],
      ["wave promoted into another stage", (c) => { c.spec.waves[1].promotion.targetStage = "prod"; }, /must be the staging stage promoted/],
      ["wave promotion under another change order", (c) => {
        c.spec.waves[0].promotion.changeOrder = `${c.spec.base.space}/some-other-change`;
      }, /must be the pilot stage promoted/],
      ["stage selected the wrong variants", (c) => { c.spec.waves[2].stage.members.pop(); }, /stage selected exactly its variants/],
      ["wave released at the head", (c) => { delete c.spec.waves[1].release.revision; }, /must publish each variant where the change order arrived/],
      ["changed release at the head", (c) => { delete c.spec.variants[0].records[1].release.revision; }, /its changed release ChangeOrder:bg-replicas-/],
      ["baseline release under the change order", (c) => {
        c.spec.variants[1].records[0].release.revision = c.spec.variants[1].records[1].release.revision;
      }, /baseline release must bundle ChangeOrder:baseline-/],
      ["variant outside its stage", (c) => { c.spec.variants[3].stage = "staging"; }, /must carry prod as its stage inside the base's component/],
      ["variant outside the component", (c) => { c.spec.variants[0].component = `${componentLabel}-management-20260101000000`; }, /must carry pilot as its stage inside the base's component/],
      ["management given a stage", (c) => {
        c.spec.variants.find((row) => row.role === "management").stage = "prod";
      }, /management record must sit in its own component and carry no stage/],
      ["wave unlock dropped", (c) => { delete c.spec.waves[0].unlockedBy; }, /must record the evidence that unlocked its approval/],
      ["wave unlock unmarked", (c) => { c.spec.waves[1].unlockedBy.approvalFollowedEvidence = false; }, /must record the evidence that unlocked its approval/],
      ["wave unlock wrong checkpoint", (c) => { c.spec.waves[2].unlockedBy.precedingCheckpointId = "baseline"; }, /must record the evidence that unlocked its approval/],
      ["wave unlock unhealthy", (c) => { c.spec.waves[1].unlockedBy.clusters[0].result = "fail"; }, /must record the evidence that unlocked its approval/],
      ["wave unlock cluster dropped", (c) => { c.spec.waves[0].unlockedBy.clusters.pop(); }, /must record the evidence that unlocked its approval/],
      ["advance undeclared", (c) => { delete c.spec.advance; }, /unlock evidence the receipt does not declare/],
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

    // Every other governed live lane is written against the approval API
    // ConfigHub removed, so each must stop before building anything, with its
    // named reason. Each is started for real, with no ConfigHub context and
    // no cub, kind, or kubectl on its PATH, so a lane that lost its refusal
    // fails at its own first check rather than reaching anything live.
    const pythonDir = dirname(spawnSync(
      "python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" },
    ).stdout.trim());
    for (const [script, laneMode] of [
      ["scripts/run-sveltos-oci-delivery-proof.mjs", "--run"],
      ["scripts/run-sveltos-cve-patch-proof.mjs", "--run"],
      ["scripts/run-sveltos-bulk-ops-proof.mjs", "--run"],
      ["scripts/run-sveltos-held-cluster-proof.mjs", "--run"],
      ["scripts/verify-sveltos-example.mjs", "--hub-record"],
      ["scripts/verify-sveltos-example.mjs", "--hub-verify"],
    ]) {
      const lane = spawnSync(process.execPath, [join(repoRoot, script), laneMode], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          PATH: [dirname(process.execPath), pythonDir].join(":"),
          HOME: process.env.HOME ?? "",
        },
      });
      check(
        lane.status !== 0
          && String(lane.stderr).includes(retiredApprovalLaneMarker)
          && String(lane.stderr).includes("confighubai/confighub#5495"),
        `${script} ${laneMode} must stop before building anything and name the removed approval API; it answered ${lane.status}: ${String(lane.stderr).trim().split("\n").slice(-3).join(" ")}`,
      );
    }

    console.log(
      "sveltos env rollout runner self-test passed: the 2026-09-26 ChangeWorkflow and attestation probes replayed against the fake hub, with the Released gate and the release gate refusing in the server's own words, the strict separation-of-duties refusal and a second approver clearing it, the declared-but-unenforced workflow requirement, the no-change change order and its identical-bundle refusal, the removed per-unit approve verb, and unknown flags and verbs refused; the gate preflight reading the filter's validating triggers through a probe Space and the reviewed workflow read back, with its approval-trigger, empty-filter, undefined-trigger, dropped-requirement, and old-client refusals; the reviewed workflow's refusals for AllowAuthors, count, missing release gate, missing Released, Healthy, stage order, and stage label; one base and five per-cluster variants each naming its own SveltosCluster, the base and its four variants in a run-scoped component with each variant's environment as its stage and the management Space in a component of its own, with the management-in-base, wrong-stage, and staged-base refusals; one workflow from the reviewed file, declared required on the component; the baseline released through a change order of its own stage by stage, every release refused until approved, failing closed on a refused change order, a refused promotion, a no-change promotion that cuts a revision, a release gate that does not hold, a release refused for another reason, and an approval not recorded; the management record approved as an attestation nothing server-side gates; one change order headed for exactly the run's five Spaces, with another run's Space in its scope refused; the server refusing a promotion into staging before pilot released, and the runner refusing to record a skip the server allowed; the departure collision and clusterRefs-addressing refusals, the upstream link and its refusal, the component and owner labels the component view groups by, the severed-lineage refusal that a serialization change causes, the set query with its empty and over-broad refusals, three stages promoted by ConfigHub, each release refused by its gate, approved once for the stage as an attestation, and released, with wave three releasing two variants separately, a stage that is not the wave refused, the silent departure win refusal, the evidence-gated advance with its unhealthy-cluster and incomplete-evidence refusals, the Sveltos pin read from the lock with its released controller run as released and an override refused on that pin, the preload list taken from the pinned manifest's own image lines with no agent digest invented, the image override mechanism kept for a pin that needs it, the lowercase Space and Secret type refusals the gateway imposes, eight workload releases delivered through the gateway to a fake management cluster while the management record is applied out of band and publishes no release, the gzip fetch refusal, the queued apply-gate wait told apart from a refusing gate, the keep-alive cleanup record, the receipt tamper battery, and every other governed live lane stopping before it builds anything because the approval API it was written against is gone",
    );
  } finally {
    commandRunner = realRunner;
    sleeper = realSleeper;
    timeSource = realTime;
    rmSync(workRoot, { recursive: true, force: true });
  }
}

// The live probe of 2026-09-26 against cub v0.6.2, replayed step for step
// against the fake: a change order needs its base Space attached to a
// component entity, a label is not enough; --stage labels a variant's Space
// and the variant inherits the component; a change order created after an
// edit captures it; a promotion into a stage moves exactly the change; the
// Released gate refuses the next stage while the one ahead has taken the
// change without releasing it, in the server's own words; a release pinned
// to the change order satisfies it; and a Space attached to the component
// with no Stage label sits in the change order's scope while no stage
// selects it. The fake is only worth what it answers, so it answers this
// before the walk depends on it.
function replayChangeWorkflowProbe(hub, workRoot) {
  const answer = (args) => hub.handle(args);
  const must = (args, label) => {
    const result = answer(args);
    check(result.ok, `probe replay, ${label}: ${result.error}`);
    return result;
  };
  const probe = "probe-cw";
  const base = `${probe}-base`;
  const wiring = ["--trigger-filter", gateFilterRef, "--where-trigger", "-"];
  must([
    "space", "create", base,
    "--label", `Component=${probe}`,
    ...wiring, "--quiet",
  ], "base Space");
  must([
    "unit", "create", "--space", base, policyUnit,
    join(exampleRoot, "clusterprofile-base.yaml"), "--quiet",
  ], "base unit");
  must([
    "changeworkflow", "create", "--space", base, "line",
    "--stage", "dev", "--stage", "prod",
    "--prerequisites", "Released", "--quiet",
  ], "workflow");
  const detached = answer([
    "changeorder", "create", "--space", base, "early",
    "--change-workflow", `${base}/line`, "--description", "Too early", "--quiet",
  ]);
  check(
    !detached.ok
      && detached.error === `Space '${base}' has no ComponentID, so there is no component for a ChangeWorkflow's stages to select within`,
    `probe replay: a Space with only a Component label must be refused a change order in the server's words, got ${detached.error || "success"}`,
  );
  must(["component", "create", probe, "--quiet"], "component");
  must(["space", "update", base, "--component", probe, "--quiet"], "attach the base");
  must(["target", "create", `${probe}-dev`, "{}", targetHost.worker,
    "--space", targetHost.space, "--provider", "OCI", "--toolchain", "Any",
    "--quiet"], "dev Target");
  for (const stage of ["dev", "prod"]) {
    must([
      "variant", "create", stage, base,
      "--space-pattern", `template:${probe}-${stage}`,
      "--stage", stage, "--quiet",
    ], `${stage} variant`);
  }
  must([
    "unit", "set-target", policyUnit, `${targetHost.space}/${probe}-dev`,
    "--space", `${probe}-dev`, "--quiet",
  ], "dev unit target");
  const spaceOf = (slug) =>
    JSON.parse(must(["space", "get", slug, "-o", "json"], `read ${slug}`).output).Space;
  check(
    ["dev", "prod"].every((stage) =>
      spaceOf(`${probe}-${stage}`).Labels?.Stage === stage
      && spaceOf(`${probe}-${stage}`).ComponentID === spaceOf(base).ComponentID),
    "probe replay: a variant must carry its --stage as its Stage label and inherit the base's component",
  );
  must([
    "space", "create", `${probe}-loose`,
    "--label", `Component=${probe}`,
    ...wiring, "--component", probe, "--quiet",
  ], "a Space attached with no stage");

  const changedPath = join(workRoot, "probe-cw-changed.yaml");
  const baseDoc = parseDocs(readFileSync(join(exampleRoot, "clusterprofile-base.yaml"), "utf8"))[0];
  const changedDoc = structuredClone(baseDoc);
  changedDoc.metadata.labels = { ...(changedDoc.metadata.labels ?? {}), probe: "changed" };
  writeStoredDocuments(changedPath, [changedDoc]);
  must(["unit", "update", "--space", base, policyUnit, changedPath, "--quiet"], "edit the base");
  must([
    "changeorder", "create", "--space", base, "bump",
    "--change-workflow", `${base}/line`, "--description", "Bump", "--quiet",
  ], "change order after the edit");
  const order = JSON.parse(must([
    "changeorder", "get", "--space", base, "bump", "-o", "json",
  ], "read the change order").output).ChangeOrder;
  check(
    sameSet(
      order.InScopeSpaceIDs,
      [base, `${probe}-dev`, `${probe}-prod`, `${probe}-loose`]
        .map((slug) => spaceOf(slug).SpaceID),
    ),
    "probe replay: a change order's scope must be every Space attached to the component, the unstaged one included",
  );

  const devBefore = JSON.parse(must([
    "unit", "get", "--space", `${probe}-dev`, policyUnit, "-o", "json",
  ], "read dev").output).Unit;
  const skipped = answer([
    "variant", "promote", "--change-order", `${base}/bump`,
    "--target-stage", "prod", "--change-desc", "Skip dev", "--quiet",
  ]);
  check(!skipped.ok, "probe replay: prod must be refused before dev has taken the change");
  must([
    "variant", "promote", "--change-order", `${base}/bump`,
    "--target-stage", "dev", "--change-desc", "Promote dev", "--quiet",
  ], "promote dev");
  const devAfter = JSON.parse(must([
    "unit", "get", "--space", `${probe}-dev`, policyUnit, "-o", "json",
  ], "read dev").output).Unit;
  check(
    Number(devAfter.HeadRevisionNum) === Number(devBefore.HeadRevisionNum) + 1
      && parseDocs(storedData(devAfter))[0]?.metadata?.labels?.probe === "changed",
    "probe replay: promoting dev must move exactly the change into dev",
  );
  const held = answer([
    "variant", "promote", "--change-order", `${base}/bump`,
    "--target-stage", "prod", "--change-desc", "Promote prod", "--quiet",
  ]);
  check(
    !held.ok
      && held.error === "unable to promote to stage 'prod', Variant 'dev' has taken change order 'bump' but has not released it",
    `probe replay: prod must be refused in the server's words while dev has not released, got ${held.error || "success"}`,
  );
  must([
    "release", "publish", `${probe}-dev`, "--revision", "ChangeOrder:bump", "-o", "json",
  ], "release dev at the change order");
  must([
    "variant", "promote", "--change-order", `${base}/bump`,
    "--target-stage", "prod", "--change-desc", "Promote prod", "--quiet",
  ], "promote prod once dev released");

  // The surface stays closed: a flag the probe never used and a verb the
  // table does not name are both refused.
  for (const [args, pattern, label] of [
    [["changeorder", "create", "--space", base, "wide", "--change-workflow", `${base}/line`, "--in-scope-space", `${probe}-dev`], /unknown flag: --in-scope-space/, "an unused changeorder flag"],
    [["variant", "promote", "--change-order", `${base}/bump`, "--target-stage", "prod", "--force"], /unknown flag: --force/, "a gate override"],
    [["changeorder", "abort", `${base}/bump`], /unknown command "changeorder abort"/, "a verb outside the table"],
    [["variant", "approve", "--change-order", `${base}/bump`, "--stage", "dev", "--no-wait"], /unknown flag: --no-wait/, "the approve flag removed with the old mechanism"],
    [["changeworkflow", "create", "--space", base, "other", "--stage", "dev", "--allow-exists"], /unknown flag: --allow-exists/, "a stray --allow-exists"],
  ]) {
    const result = answer(args);
    check(!result.ok && pattern.test(result.error), `probe replay: ${label} must be refused, got ${result.error || "success"}`);
  }

  for (const slug of [`${probe}-dev`, `${probe}-prod`, `${probe}-loose`, base]) {
    must(["space", "delete", slug, "--recursive-force", "--quiet"], `remove ${slug}`);
  }
  must(["component", "delete", probe, "--quiet"], "remove the component");
}

// The attestation probe of 2026-09-26, replayed against the fake: a workflow
// with an approval requirement is created from a file; a release of a change
// order into a stage is refused with HTTP 422 until the change as it stands
// there is approved, in the server's words; once approved it publishes; with
// AllowAuthors false the promoter's own approval does not count, and a second
// approver's does; a component can declare the workflow required, and a plain
// publish outside a change order still succeeds; a change order that carries
// no change can be promoted and approved, and its pinned release is refused
// only when identical content is already published; and the per-unit approve
// verb is gone.
function replayAttestationProbe(hub, workRoot) {
  const answer = (args) => hub.handle(args);
  const must = (args, label) => {
    const result = answer(args);
    check(result.ok, `attestation probe replay, ${label}: ${result.error}`);
    return result;
  };
  const probe = "probe-at";
  const base = `${probe}-base`;
  const operator = hub.state.actingUser;
  const wiring = ["--trigger-filter", gateFilterRef, "--where-trigger", "-"];
  const gone = answer([
    "unit", "approve", "--space", "*", "--where", "Labels.Proof = 'probe'",
    "--revision", "HeadRevisionNum", "--wait", "--quiet",
  ]);
  check(
    !gone.ok && gone.error === "Failed: unknown flag: --revision",
    `attestation probe replay: the per-unit approve verb must be gone, got ${gone.error || "success"}`,
  );
  must(["component", "create", probe, "--quiet"], "component");
  must([
    "space", "create", base, "--label", `Component=${probe}`,
    ...wiring, "--component", probe, "--quiet",
  ], "base Space");
  must([
    "unit", "create", "--space", base, policyUnit,
    join(exampleRoot, "clusterprofile-base.yaml"), "--quiet",
  ], "base unit");
  for (const stage of ["dev", "prod"]) {
    must([
      "target", "create", `${probe}-${stage}`, "{}", targetHost.worker,
      "--space", targetHost.space, "--provider", "OCI", "--toolchain", "Any", "--quiet",
    ], `${stage} Target`);
    must([
      "variant", "create", stage, base,
      "--space-pattern", `template:${probe}-${stage}`, "--stage", stage, "--quiet",
    ], `${stage} variant`);
    must([
      "unit", "set-target", policyUnit, `${targetHost.space}/${probe}-${stage}`,
      "--space", `${probe}-${stage}`, "--quiet",
    ], `${stage} unit target`);
  }
  const workflowFile = (allowAuthors) => {
    const path = join(workRoot, `probe-at-workflow-${allowAuthors}.yaml`);
    writeFileSync(path, [
      "AttestationPrerequisites:",
      `  - {Name: approval, Type: Approval, Count: 1, AllowAuthors: ${allowAuthors}}`,
      "Stages:",
      "  - {Name: dev, WhereSpace: \"Labels.Stage = 'dev'\", ReleasePrerequisites: [approval]}",
      "  - {Name: prod, WhereSpace: \"Labels.Stage = 'prod'\", Prerequisites: [Released], ReleasePrerequisites: [approval]}",
      "",
    ].join("\n"));
    return path;
  };
  must([
    "changeworkflow", "create", "--space", base, "line",
    "--filename", workflowFile(true), "--quiet",
  ], "workflow with an approval requirement, from a file");
  must([
    "component", "update", "--patch", probe, "--change-workflow-required",
    "--allowed-change-workflow", `${base}/line`, "--quiet",
  ], "declare the workflow required");
  check(
    hub.componentRequires(probe) === `${base}/line`,
    "attestation probe replay: the component must record the workflow it requires",
  );

  // A change order with no change: promoted, refused at release until
  // approved, approved, released.
  must([
    "changeorder", "create", "--space", base, "baseline",
    "--change-workflow", `${base}/line`, "--description", "Baseline", "--quiet",
  ], "a change order with no change");
  must([
    "variant", "promote", "--change-order", `${base}/baseline`,
    "--target-stage", "dev", "--change-desc", "Baseline", "--quiet",
  ], "promote the baseline into dev");
  const unapproved = answer([
    "release", "publish", `${probe}-dev`, "--revision", "ChangeOrder:baseline", "-o", "json",
  ]);
  check(
    !unapproved.ok
      && unapproved.error.endsWith("unable to publish a release of change order 'baseline' in stage 'dev': requires approval: 1 Approval attestation(s) from eligible attesters; clusterprofile revision 1 has 0 of 1"),
    `attestation probe replay: an unapproved release must be refused with 422 in the server's words, got ${unapproved.error || "success"}`,
  );
  must([
    "variant", "approve", "--change-order", `${base}/baseline`, "--stage", "dev", "--quiet",
  ], "approve the baseline in dev");
  must([
    "release", "publish", `${probe}-dev`, "--revision", "ChangeOrder:baseline", "-o", "json",
  ], "release dev once approved");

  // Declared, not enforced: a plain publish outside any change order on a
  // component that requires a workflow succeeds.
  must(["release", "publish", `${probe}-prod`, "-o", "json"], "a plain publish on a workflow-required component");
  // And the pinned release of that same content is then refused, for
  // having nothing new to bundle.
  must([
    "variant", "promote", "--change-order", `${base}/baseline`,
    "--target-stage", "prod", "--change-desc", "Baseline", "--quiet",
  ], "promote the baseline into prod once dev released it");
  must([
    "variant", "approve", "--change-order", `${base}/baseline`, "--stage", "prod", "--quiet",
  ], "approve the baseline in prod");
  const identical = answer([
    "release", "publish", `${probe}-prod`, "--revision", "ChangeOrder:baseline", "-o", "json",
  ]);
  check(
    !identical.ok && /no changes were made since :latest bundle/.test(identical.error),
    `attestation probe replay: a pinned release of already-published content must be refused, got ${identical.error || "success"}`,
  );

  // Separation of duties: with AllowAuthors false, the operator who promoted
  // the change is one of its authors in dev, and that approval reads 0 of 1
  // in the words the receipt quotes. A second approver's counts.
  must([
    "changeworkflow", "create", "--space", base, "strict",
    "--filename", workflowFile(false), "--quiet",
  ], "a strict workflow");
  const changedPath = join(workRoot, "probe-at-changed.yaml");
  const baseDoc = parseDocs(readFileSync(join(exampleRoot, "clusterprofile-base.yaml"), "utf8"))[0];
  writeStoredDocuments(changedPath, [{
    ...baseDoc,
    metadata: { ...baseDoc.metadata, labels: { ...(baseDoc.metadata.labels ?? {}), probe: "strict" } },
  }]);
  must(["unit", "update", "--space", base, policyUnit, changedPath, "--quiet"], "edit the base");
  must([
    "changeorder", "create", "--space", base, "strict-change",
    "--change-workflow", `${base}/strict`, "--description", "Strict", "--quiet",
  ], "a change order under the strict workflow");
  must([
    "variant", "promote", "--change-order", `${base}/strict-change`,
    "--target-stage", "dev", "--change-desc", "Strict", "--quiet",
  ], "promote the change into dev");
  must([
    "variant", "approve", "--change-order", `${base}/strict-change`, "--stage", "dev", "--quiet",
  ], "the promoter approves their own promotion");
  const selfApproved = answer([
    "release", "publish", `${probe}-dev`, "--revision", "ChangeOrder:strict-change", "-o", "json",
  ]);
  const template = new RegExp(`${strictModeRefusal
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("<change-order>", "strict-change")
    .replace("<stage>", "dev")
    .replace("<unit>", policyUnit)
    .replace("<n>", "\\d+")}$`);
  check(
    !selfApproved.ok && template.test(selfApproved.error),
    `attestation probe replay: under AllowAuthors false the promoter's own approval must read 0 of 1 in the words the receipt quotes, got ${selfApproved.error || "success"}`,
  );
  hub.state.actingUser = "self-test-second-approver";
  must([
    "variant", "approve", "--change-order", `${base}/strict-change`, "--stage", "dev", "--quiet",
  ], "a second approver approves");
  hub.state.actingUser = operator;
  must([
    "release", "publish", `${probe}-dev`, "--revision", "ChangeOrder:strict-change", "-o", "json",
  ], "release dev once a second approver approved");

  for (const slug of [`${probe}-dev`, `${probe}-prod`, base]) {
    must(["space", "delete", slug, "--recursive-force", "--quiet"], `remove ${slug}`);
  }
  must(["component", "delete", probe, "--quiet"], "remove the component");
}

// A tampered copy of the reviewed example files, so a plan refusal is proved
// against a real fixture rather than a hand-built object.
function tamperedExampleRoot(workRoot, label, edit, target = "variants.yaml") {
  const root = join(workRoot, `tamper-${label}`);
  const planRoot = join(root, "examples", "sveltos", "env-rollout");
  mkdirSync(planRoot, { recursive: true });
  for (const name of [
    "fleet.yaml",
    "change-candidate.yaml",
    "variants.yaml",
    "clusterprofile-base.yaml",
    "change-workflow.yaml",
  ]) {
    cpSync(join(exampleRoot, name), join(planRoot, name));
  }
  const path = join(planRoot, target);
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
function fakeSveltosManifest(image, version) {
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
---
apiVersion: batch/v1
kind: Job
metadata:
  name: register-mgmt-cluster-job
  namespace: ${registrationNamespace}
spec:
  template:
    spec:
      containers:
        - name: register-mgmt-cluster
          image: docker.io/projectsveltos/register-mgmt-cluster:${version}
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

function fakeSveltosInstall(sveltos, addonControllerImage, preloadedImages) {
  return {
    source: sveltos.manifestUrl,
    version: sveltos.version,
    manifestSha256: sveltos.manifestSha256,
    addonControllerImage,
    pinnedAddonControllerImage: pinnedAddonControllerImage(sveltos),
    addonControllerImageOverridden:
      addonControllerImage !== pinnedAddonControllerImage(sveltos),
    objectCount: 4,
    crdCount: 1,
    appliedObjectCount: 4,
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
    imagePreload: imagePreloadRecord(sveltos, preloadedImages),
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
    mergeKeepsDepartureOnly: false,
    severUpstreamLineage: false,
    ignoreStageGates: false,
    triggerIdOverride: null,
    releaseTargetOverride: null,
    // What the platform filter resolves today: the profile's seven
    // validating triggers. The approval trigger was deleted with the old
    // approval mechanism, so the filter's selector no longer finds it.
    resolvedTriggerRefs: readYaml(policyPath).spec.baseline.checks
      .map((item) => item.trigger)
      .sort(),
    // Every write and every attestation in the fake is this one user's, as
    // every live run of this chapter is one operator's.
    actingUser: "self-test-operator",
    dropAttestationPrerequisites: false,
    clientPredatesAttestations: false,
    refuseChangeOrderCreate: false,
    refusePromotion: false,
    noChangePromotionCutsRevision: false,
    releaseGateDisabled: false,
    refuseApprovals: false,
  };
  // The ChangeWorkflow model: component entities Spaces attach to, workflows
  // and change orders held in a Space, and, per Space, the change orders a
  // release of that Space has carried. A unit that has taken a change order
  // carries its end tag in `tags`, keyed by the change order.
  const components = new Map();
  const workflows = new Map();
  const changeOrders = new Map();
  const releasedChangeOrders = new Map();
  const componentFor = (value) =>
    components.get(value)
    ?? [...components.values()].find((row) => row.ComponentID === value)
    ?? null;
  const resolveChangeOrder = (ref, fallbackSpace) => {
    const text = String(ref ?? "");
    if (text.includes("/")) return changeOrders.get(text) ?? null;
    const named = [...changeOrders.values()].filter((row) => row.Slug === text);
    if (fallbackSpace) {
      const local = named.find((row) => row.SpaceSlug === fallbackSpace);
      if (local) return local;
    }
    return named.length === 1 ? named[0] : null;
  };
  const repeated = (value) => [value ?? []].flat()
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  const unitKey = (space, slug) => `${space}/${slug}`;
  // A new revision queues the Space's validating triggers. None of them is
  // an approval gate any more, so once they have run the unit carries no
  // blocking gate: what holds a release back is the workflow's release gate.
  const tick = () => {
    for (const key of pending) {
      const unit = units.get(key);
      if (!unit) continue;
      unit.ApplyGates = {};
    }
    pending.clear();
  };
  const ok = (output) => ({ ok: true, status: 0, output, error: "" });
  const refuse = (error) => ({ ok: false, status: 1, output: "", error });
  // Each revision records who wrote it, which is what a release gate's
  // separation of duties reads.
  const store = (unit, text) => {
    unit.Data = Buffer.from(text).toString("base64");
    unit.ContentHash = sha256(text);
    unit.history.set(unit.HeadRevisionNum, text);
    unit.authors = { ...(unit.authors ?? {}), [unit.HeadRevisionNum]: state.actingUser };
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
  // The Spaces a stage selects: in the change order's scope, attached to its
  // component, and carrying the stage's Stage label.
  const stageSpacesOf = (order, stage) => [...spaces.values()]
    .filter((row) =>
      row.ComponentID === order.ComponentID
      && row.Labels?.Stage === stage.StageLabel
      && order.InScopeSpaceIDs.includes(row.SpaceID))
    .sort((left, right) => left.Slug.localeCompare(right.Slug));
  // A stage's release gate, evaluated as confighubai/confighub's
  // checkReleasePrerequisites does and worded as it words a refusal: for
  // every bundled revision, the distinct users with a Pass of the required
  // type on it, or on an earlier revision of the same unit with the same
  // content, not counting an author of the change there unless the
  // requirement allows authors. The authors are whoever wrote the unit's
  // revisions after the change order's start, and always the revision's own
  // writer.
  const releaseGateRefusal = (order, spaceSlug, bundled) => {
    const workflow = workflows.get(order.ChangeWorkflow);
    const stage = workflow.Stages.find((row) =>
      stageSpacesOf(order, row).some((space) => space.Slug === spaceSlug));
    if (!stage || stage.ReleasePrerequisites.length === 0) return null;
    const failures = [];
    for (const name of stage.ReleasePrerequisites) {
      const requirement = workflow.AttestationPrerequisites.find((row) => row.Name === name);
      if (!requirement) {
        failures.push(`unrecognized release prerequisite '${name}'`);
        continue;
      }
      const count = Number(requirement.Count ?? 1);
      const type = requirement.Type ?? "Approval";
      const unitFailures = [];
      for (const row of bundled) {
        const start = row.unit.changeStarts?.[order.Key] ?? row.revision;
        const authors = new Set([row.unit.authors?.[row.revision]]);
        for (let revision = start + 1; revision <= row.revision; revision += 1) {
          authors.add(row.unit.authors?.[revision]);
        }
        const content = sha256(row.text);
        const passes = new Set();
        let failed = false;
        for (const attestation of row.unit.attestations ?? []) {
          if (attestation.type !== type || attestation.revision > row.revision) continue;
          if (sha256(row.unit.history.get(attestation.revision) ?? "") !== content) continue;
          if (!requirement.AllowAuthors && authors.has(attestation.user)) continue;
          if (attestation.result === "Fail") failed = true;
          else passes.add(attestation.user);
        }
        if (failed && !requirement.IgnoreFail) {
          unitFailures.push(`${row.unit.Slug} revision ${row.revision} was rejected`);
        } else if (passes.size < count) {
          unitFailures.push(`${row.unit.Slug} revision ${row.revision} has ${passes.size} of ${count}`);
        }
      }
      if (unitFailures.length > 0) {
        const who = requirement.AllowAuthors
          ? "eligible attesters"
          : "eligible attesters who did not write the change";
        failures.push(`requires ${requirement.Name}: ${count} ${type} attestation(s) from ${who}; ${unitFailures.join("; ")}`);
      }
    }
    return failures.length === 0
      ? null
      : `unable to publish a release of change order '${order.Slug}' in stage '${stage.Name}': ${failures.join("; ")}`;
  };
  const handle = (args) => {
    const { positionals, flags } = parseCubCommand(args);
    const [entity, verb, ...rest] = positionals;
    // The per-unit approve verb is gone from ConfigHub and from cub. Asked
    // with the flags the old approval path passed, cub v0.6.2 answered this,
    // measured on 2026-09-26; the fake answers the same, whatever the shared
    // flag table still lists for the chapters that have not moved.
    if (entity === "unit" && verb === "approve") {
      return refuse(args.includes("--revision")
        ? "Failed: unknown flag: --revision"
        : 'unknown command "approve" for "cub unit"');
    }
    // The runner asks the local client whether it records approvals as
    // attestations before it builds anything. A client from before them has
    // no --change-order on variant approve.
    if (args.includes("--help")) {
      if (entity === "variant" && verb === "approve") {
        return ok(state.clientPredatesAttestations
          ? "Usage:\n  cub variant approve <space> [flags]\n\nFlags:\n      --no-wait\n"
          : "Usage:\n  cub variant approve [<space>] [flags]\n\nFlags:\n      --change-order string\n      --stage string\n");
      }
      return refuse(`the self-test fake hub has no help for cub ${positionals.join(" ")}`);
    }
    // The surface is closed both ways: a verb the flag table does not name is
    // refused before its flags are read, and a flag outside a verb's row is
    // refused in the CLI's own words.
    if (!knownCubCommand(positionals)) {
      return refuse(`unknown command "${positionals.slice(0, 2).join(" ")}" for "cub"`);
    }
    const strayFlag = unknownCubFlag(positionals, flags);
    if (strayFlag) return refuse(strayFlag);
    if (entity === "auth" && verb === "get-token") {
      return ok(`self-test-gateway-token-${"a".repeat(48)}`);
    }
    if (entity === "filter" && verb === "get") {
      return ok(JSON.stringify({ Filter: { FilterID: filterId, Hash: "self-test-filter-hash" } }));
    }
    // A trigger is read by slug or by ID. The approval trigger was deleted,
    // and reading it answers as the live run found on 2026-09-26.
    if (entity === "trigger" && verb === "get") {
      const slug = String(rest[0]).replace(/^self-test-trigger-/, "");
      const ref = `${flags.space}/${slug}`;
      if (!state.resolvedTriggerRefs.includes(ref)) return refuse("trigger not found");
      return ok(JSON.stringify({ Trigger: { TriggerID: triggerIdFor(ref), Slug: slug } }));
    }
    // Declaring that a component requires a workflow is recorded, and, as
    // measured on 2026-09-26, not enforced on a plain publish.
    if (entity === "component" && verb === "update") {
      const row = componentFor(rest[0]);
      if (!row) return refuse(`component ${rest[0]} not found`);
      const allowed = repeated(flags["allowed-change-workflow"]);
      for (const ref of allowed) {
        if (!workflows.has(ref)) return refuse(`ChangeWorkflow ${ref} not found`);
      }
      row.ChangeWorkflowRequired = flags["change-workflow-required"] === true;
      row.AllowedChangeWorkflows = allowed;
      return ok("");
    }
    if (entity === "component" && verb === "create") {
      const slug = rest[0];
      if (!slug) return refuse("a component needs a name");
      if (components.has(slug)) return refuse(`component ${slug} already exists`);
      components.set(slug, {
        Slug: slug,
        ComponentID: `self-test-component-${slug}`,
        Labels: labelsFrom(flags.label),
      });
      return ok("");
    }
    if (entity === "component" && verb === "get") {
      const row = componentFor(rest[0]);
      if (!row) return refuse(`component ${rest[0]} not found`);
      return ok(JSON.stringify({ Component: structuredClone(row) }));
    }
    // The fake refuses to delete a component while a Space is still attached
    // to it, which is why the runner removes its Spaces first.
    if (entity === "component" && verb === "delete") {
      const row = componentFor(rest[0]);
      if (!row) return refuse(`component ${rest[0]} not found`);
      const attached = [...spaces.values()]
        .filter((space) => space.ComponentID === row.ComponentID)
        .map((space) => space.Slug);
      if (attached.length > 0) {
        return refuse(`the self-test fake hub keeps component ${row.Slug} while ${attached.join(", ")} is attached to it`);
      }
      components.delete(row.Slug);
      return ok("");
    }
    if (entity === "space" && verb === "create") {
      const slug = rest[0];
      if (flags["trigger-filter"] !== gateFilterRef) {
        return refuse(`unexpected trigger filter ${flags["trigger-filter"]}`);
      }
      const component = flags.component ? componentFor(flags.component) : null;
      if (flags.component && !component) {
        return refuse(`component ${flags.component} not found`);
      }
      spaces.set(slug, {
        Slug: slug,
        SpaceID: `self-test-space-${slug}`,
        TriggerIDs: [],
        ReleaseTargetID: null,
        TriggerFilterID: filterId,
        ComponentID: component?.ComponentID ?? null,
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
      if (flags.component === "-") {
        row.ComponentID = null;
      } else if (flags.component) {
        const component = componentFor(flags.component);
        if (!component) return refuse(`component ${flags.component} not found`);
        row.ComponentID = component.ComponentID;
      }
      if (flags["release-target"]) {
        const target = resolveTargetRef(flags["release-target"], rest[0]);
        if (!target) return refuse(`release target ${flags["release-target"]} not found`);
        row.ReleaseTargetID = state.releaseTargetOverride ?? target.TargetID;
      }
      if (flags["refresh-triggers"]) {
        row.TriggerIDs = state.triggerIdOverride
          ?? state.resolvedTriggerRefs.map(triggerIdFor).sort();
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
      releasedChangeOrders.delete(slug);
      for (const key of [...units.keys()]) {
        if (key.startsWith(`${slug}/`)) units.delete(key);
      }
      for (const map of [workflows, changeOrders]) {
        for (const key of [...map.keys()]) {
          if (key.startsWith(`${slug}/`)) map.delete(key);
        }
      }
      return ok("");
    }
    // One verb clones the Space and every unit in it, links each clone to its
    // upstream, stamps the Variant label, and copies the approval wiring from
    // the upstream Space. The release target is deliberately not copied, which
    // is why the runner sets it afterwards. The clone inherits the upstream
    // Space's component, and --stage sets its Stage label, which is what a
    // workflow stage selects on.
    if (entity === "variant" && verb === "create") {
      const [variantName, upstreamSlug] = rest;
      const upstream = spaces.get(upstreamSlug);
      if (!upstream) return refuse(`upstream space ${upstreamSlug} not found`);
      const pattern = String(flags["space-pattern"] ?? "");
      if (!pattern.startsWith("template:") || pattern.includes("{{")) {
        return refuse(`the self-test fake hub resolves only literal space patterns, not ${pattern || "a derived slug"}`);
      }
      const stages = repeated(flags.stage);
      if (stages.length > 1) return refuse("a variant carries one stage");
      const slug = pattern.slice("template:".length);
      if (spaces.has(slug)) return refuse(`space ${slug} already exists`);
      spaces.set(slug, {
        Slug: slug,
        SpaceID: `self-test-space-${slug}`,
        TriggerIDs: state.triggerIdOverride ?? [...upstream.TriggerIDs],
        ReleaseTargetID: null,
        TriggerFilterID: upstream.TriggerFilterID,
        ComponentID: upstream.ComponentID ?? null,
        Labels: {
          ...(upstream.Labels ?? {}),
          Variant: variantName,
          ...(stages.length === 1 ? { Stage: stages[0] } : {}),
        },
      });
      for (const [key, row] of [...units.entries()]) {
        if (row.SpaceSlug !== upstreamSlug) continue;
        const clone = {
          Slug: row.Slug,
          SpaceSlug: slug,
          UnitID: `self-test-unit-${slug}-${row.Slug}`,
          HeadRevisionNum: 1,
          ApplyGates: { "awaiting/triggers": true },
          Labels: { ...(row.Labels ?? {}) },
          TargetID: null,
          UpstreamUnitID: state.refuseUpstreamLink ? "" : row.UnitID,
          UpstreamUnitKey: key,
          UpstreamRevisionNum: row.HeadRevisionNum,
          history: new Map(),
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
        Labels: labelsFrom(flags.label),
        TargetID: flags.target ? resolveTargetRef(flags.target, flags.space)?.TargetID ?? null : null,
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
    // Chapter three no longer moves a wave with a set upgrade it issues
    // itself; ConfigHub promotes a change order stage by stage. The fake
    // refuses the old verb, so a runner that slid back to it fails here.
    if (entity === "unit" && verb === "update" && flags.patch) {
      return refuse("the self-test fake hub refuses a runner-issued set upgrade; chapter three promotes its change order through the workflow's stages");
    }
    // A workflow holds its stages in order. From flags, every stage gets the
    // one set of --prerequisites and selects Labels.Stage = '<name>'. From a
    // file, each stage carries its own entry Prerequisites and release
    // ReleasePrerequisites, and the file declares the attestation
    // requirements those name. A release gate may name only an attestation
    // requirement, since the built-in gates read a stage after a change has
    // moved through it.
    if (entity === "changeworkflow" && verb === "create") {
      const space = spaces.get(flags.space);
      if (!space) return refuse(`space ${flags.space} not found`);
      const slug = rest[0];
      const key = `${space.Slug}/${slug}`;
      if (!slug) return refuse("a ChangeWorkflow needs a slug");
      if (workflows.has(key)) return refuse(`ChangeWorkflow ${key} already exists`);
      const builtIn = ["Validated", "Released", "Healthy"];
      let stages;
      let attestationPrerequisites = [];
      if (flags.filename) {
        if (flags.stage || flags.prerequisites) {
          return refuse("--filename is mutually exclusive with --stage and --prerequisites");
        }
        const spec = readYaml(flags.filename);
        attestationPrerequisites = structuredClone(spec?.AttestationPrerequisites ?? []);
        const declared = attestationPrerequisites.map((row) => row.Name);
        for (const row of attestationPrerequisites) {
          if (!row.Name || !row.Type) return refuse("an attestation prerequisite needs a Name and a Type");
        }
        stages = [];
        for (const row of spec?.Stages ?? []) {
          const selector = /^Labels\.Stage = '([^']+)'$/.exec(String(row.WhereSpace ?? ""));
          if (!selector) {
            return refuse(`the self-test fake hub selects a stage's Spaces by Labels.Stage only, not ${row.WhereSpace}`);
          }
          for (const name of row.Prerequisites ?? []) {
            if (!builtIn.includes(name) && !declared.includes(name)) {
              return refuse(`stage '${row.Name}' names unknown prerequisite '${name}'`);
            }
          }
          for (const name of row.ReleasePrerequisites ?? []) {
            if (!declared.includes(name)) {
              return refuse(`stage '${row.Name}' release prerequisite '${name}' is not an attestation prerequisite; a release gate may name only attestation requirements`);
            }
          }
          stages.push({
            Name: row.Name,
            WhereSpace: row.WhereSpace,
            StageLabel: selector[1],
            Prerequisites: [...(row.Prerequisites ?? [])],
            ReleasePrerequisites: [...(row.ReleasePrerequisites ?? [])],
          });
        }
      } else {
        const prerequisites = repeated(flags.prerequisites);
        const unknown = prerequisites.find((name) => !builtIn.includes(name));
        if (unknown) return refuse(`unknown prerequisite ${unknown}; a custom prerequisite is written in a file`);
        stages = repeated(flags.stage).map((name) => ({
          Name: name,
          WhereSpace: `Labels.Stage = '${name}'`,
          StageLabel: name,
          Prerequisites: prerequisites,
          ReleasePrerequisites: [],
        }));
      }
      if (stages.length === 0) return refuse("a ChangeWorkflow needs at least one stage");
      workflows.set(key, {
        Key: key,
        Slug: slug,
        SpaceSlug: space.Slug,
        Stages: stages,
        AttestationPrerequisites: attestationPrerequisites,
      });
      return ok("");
    }
    if (entity === "changeworkflow" && verb === "get") {
      const row = workflows.get(`${flags.space}/${rest[0]}`);
      if (!row) return refuse(`ChangeWorkflow ${flags.space}/${rest[0]} not found`);
      const projected = {
        Slug: row.Slug,
        SpaceSlug: row.SpaceSlug,
        Stages: row.Stages.map(({ StageLabel, ...stage }) => stage),
        ...(state.dropAttestationPrerequisites
          ? {}
          : { AttestationPrerequisites: row.AttestationPrerequisites }),
      };
      return ok(JSON.stringify({ ChangeWorkflow: structuredClone(projected) }));
    }
    // A change order created after an edit captures it: for each unit of the
    // Space, the range runs from the revision its downstream clones already
    // took to the unit's head. Its scope is every Space attached to the
    // Space's component, whether or not a stage selects it.
    if (entity === "changeorder" && verb === "create") {
      const space = spaces.get(flags.space);
      if (!space) return refuse(`space ${flags.space} not found`);
      const slug = rest[0];
      const key = `${space.Slug}/${slug}`;
      if (!slug) return refuse("a change order needs a slug");
      if (changeOrders.has(key)) return refuse(`change order ${key} already exists`);
      if (state.refuseChangeOrderCreate) {
        return refuse("Failed: HTTP 409 for req self-test: the change order could not be created");
      }
      const workflowRef = String(flags["change-workflow"] ?? "");
      const workflow = workflows.get(workflowRef.includes("/")
        ? workflowRef
        : `${space.Slug}/${workflowRef}`);
      if (!workflow) return refuse(`ChangeWorkflow ${workflowRef} not found`);
      // The live server's words, recorded on 2026-09-26.
      if (!space.ComponentID) {
        return refuse(`Space '${space.Slug}' has no ComponentID, so there is no component for a ChangeWorkflow's stages to select within`);
      }
      const range = {};
      for (const [baseKey, unit] of units) {
        if (unit.SpaceSlug !== space.Slug) continue;
        const taken = [...units.values()]
          .filter((row) => row.UpstreamUnitKey === baseKey)
          .map((row) => row.UpstreamRevisionNum);
        range[baseKey] = {
          start: taken.length > 0 ? Math.min(...taken) : unit.HeadRevisionNum,
          end: unit.HeadRevisionNum,
        };
      }
      changeOrders.set(key, {
        Key: key,
        Slug: slug,
        SpaceSlug: space.Slug,
        ChangeOrderID: `self-test-changeorder-${space.Slug}-${slug}`,
        ComponentID: space.ComponentID,
        ChangeWorkflow: workflow.Key,
        Description: String(flags.description ?? ""),
        InScopeSpaceIDs: [...spaces.values()]
          .filter((row) => row.ComponentID === space.ComponentID)
          .map((row) => row.SpaceID)
          .sort(),
        range,
      });
      return ok("");
    }
    if (entity === "changeorder" && verb === "get") {
      const row = resolveChangeOrder(
        String(rest[0]).includes("/") ? rest[0] : `${flags.space}/${rest[0]}`,
      );
      if (!row) return refuse(`change order ${flags.space}/${rest[0]} not found`);
      const { range, Key, ...projected } = row;
      return ok(JSON.stringify({ ChangeOrder: structuredClone(projected) }));
    }
    // Promote exactly a change order's change into every variant one stage
    // of its workflow selects. The stage's entry gates are evaluated once,
    // over every Space of the stage ahead, before any variant moves.
    if (entity === "variant" && verb === "promote") {
      if (!flags["change-order"] || !flags["target-stage"]) {
        return refuse("the self-test fake hub promotes a change order into a named stage, nothing else");
      }
      if (state.refusePromotion) {
        return refuse("Failed: HTTP 409 for req self-test: the promotion could not be applied");
      }
      const order = resolveChangeOrder(flags["change-order"]);
      if (!order) return refuse(`change order ${flags["change-order"]} not found`);
      const workflow = workflows.get(order.ChangeWorkflow);
      const target = String(flags["target-stage"]);
      const index = workflow.Stages.findIndex((row) => row.Name === target);
      if (index < 0) {
        return refuse(`stage '${target}' is not a stage of ChangeWorkflow ${workflow.Key}`);
      }
      const covered = (space) => [...units.values()].filter((unit) =>
        unit.SpaceSlug === space.Slug && order.range[unit.UpstreamUnitKey ?? ""]);
      const entryGates = workflow.Stages[index].Prerequisites;
      if (index > 0 && !state.ignoreStageGates) {
        const ahead = workflow.Stages[index - 1];
        for (const space of stageSpacesOf(order, ahead)) {
          const variant = space.Labels?.Variant ?? space.Slug;
          const taken = covered(space).length > 0
            && covered(space).every((unit) => unit.tags?.[order.Key] !== undefined);
          if (entryGates.includes("Released")) {
            // Only the second wording below is the live server's, recorded
            // on 2026-09-26. This first one, for a variant that has not taken
            // the change at all, is the fake's own; the runner records
            // whatever the server says and depends on neither.
            if (!taken) {
              return refuse(`unable to promote to stage '${target}', Variant '${variant}' has not taken change order '${order.Slug}'`);
            }
            if (!(releasedChangeOrders.get(space.Slug) ?? new Set()).has(order.Key)) {
              return refuse(`unable to promote to stage '${target}', Variant '${variant}' has taken change order '${order.Slug}' but has not released it`);
            }
          }
          // Healthy reads a live-status annotation nothing writes for a
          // Sveltos-delivered Space, so in this fleet it never holds. The
          // wording is the fake's own.
          if (entryGates.includes("Healthy")) {
            return refuse(`unable to promote to stage '${target}', Variant '${variant}' does not report Healthy`);
          }
        }
      }
      for (const space of stageSpacesOf(order, workflow.Stages[index])) {
        for (const unit of covered(space)) {
          if (unit.tags?.[order.Key] !== undefined) continue;
          const bounds = order.range[unit.UpstreamUnitKey];
          if (unit.UpstreamRevisionNum !== bounds.start) {
            return refuse(`${space.Slug}/${unit.Slug} is not where change order ${order.Slug} starts`);
          }
          // The revision the change order starts from on this unit, which
          // bounds who counts as an author of the change here.
          unit.changeStarts = { ...(unit.changeStarts ?? {}), [order.Key]: unit.HeadRevisionNum };
          // A change order with no change marks the unit where it stands and
          // cuts no revision, which is what lets a release pinned to it bundle
          // every unit of the Space.
          if (bounds.start === bounds.end && !state.noChangePromotionCutsRevision) {
            unit.tags = { ...(unit.tags ?? {}), [order.Key]: unit.HeadRevisionNum };
            continue;
          }
          const upstream = units.get(unit.UpstreamUnitKey);
          const merged = state.mergeKeepsDepartureOnly
            ? parseDocs(dataOf(unit))
            : mergeUpstream(
              parseDocs(upstream.history.get(bounds.start)),
              parseDocs(upstream.history.get(bounds.end)),
              parseDocs(dataOf(unit)),
            );
          unit.snapshot = {
            HeadRevisionNum: unit.HeadRevisionNum,
            Data: unit.Data,
            ContentHash: unit.ContentHash,
            UpstreamRevisionNum: unit.UpstreamRevisionNum,
            tags: structuredClone(unit.tags ?? {}),
          };
          unit.HeadRevisionNum += 1;
          unit.UpstreamRevisionNum = bounds.end;
          unit.ApplyGates = { "awaiting/triggers": true };
          store(unit, documentsToText(merged));
          unit.tags = { ...(unit.tags ?? {}), [order.Key]: unit.HeadRevisionNum };
          pending.add(unitKey(unit.SpaceSlug, unit.Slug));
        }
      }
      return ok("");
    }
    if (entity === "unit" && verb === "update") {
      const [slug, path] = rest;
      const key = unitKey(flags.space, slug);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      unit.HeadRevisionNum += 1;
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
    // An approval is an Attestation of type Approval on exact revisions: with
    // --change-order and --stage, the revision the change order's end tag
    // marks on each unit it reached in every Space of the stage; with a Space
    // named, the head of each unit with a Target. It records a claim and
    // cuts no revision.
    if (entity === "variant" && verb === "approve") {
      if (state.refuseApprovals) {
        return refuse("Failed: HTTP 403 for req self-test: the caller lacks Approve on the Space");
      }
      const attest = (unit, revision) => {
        unit.attestations = [
          ...(unit.attestations ?? []),
          { revision, user: state.actingUser, type: "Approval", result: "Pass" },
        ];
      };
      if (flags["change-order"]) {
        const stageNames = repeated(flags.stage);
        if (stageNames.length !== 1) {
          return refuse("the self-test fake hub approves a change order in one stage, named with --stage");
        }
        const order = resolveChangeOrder(flags["change-order"]);
        if (!order) return refuse(`change order ${flags["change-order"]} not found`);
        const workflow = workflows.get(order.ChangeWorkflow);
        const stage = workflow.Stages.find((row) => row.Name === stageNames[0]);
        if (!stage) return refuse(`stage '${stageNames[0]}' is not a stage of ChangeWorkflow ${workflow.Key}`);
        let covered = 0;
        for (const space of stageSpacesOf(order, stage)) {
          for (const unit of units.values()) {
            if (unit.SpaceSlug !== space.Slug || unit.tags?.[order.Key] === undefined) continue;
            attest(unit, unit.tags[order.Key]);
            covered += 1;
          }
        }
        if (covered === 0) return refuse(`change order ${order.Slug} has reached no unit in stage '${stage.Name}'`);
        return ok("");
      }
      const spaceSlug = rest[0];
      if (!spaces.has(spaceSlug)) return refuse(`space ${spaceSlug} not found`);
      const targeted = [...units.values()]
        .filter((unit) => unit.SpaceSlug === spaceSlug && unit.TargetID);
      if (targeted.length === 0) return refuse(`${spaceSlug} has no unit with a Target to approve`);
      for (const unit of targeted) attest(unit, unit.HeadRevisionNum);
      return ok("");
    }
    // With no revision each unit is bundled at its head. With
    // --revision ChangeOrder:<slug> each unit is bundled where that change
    // order's end tag marks it, falling back to the head for a unit the change
    // never reached. A release that bundles every tagged unit at its tag
    // carries the change, which is what the Released gate reads.
    if (entity === "release" && verb === "publish") {
      const spaceSlug = rest[0];
      let order = null;
      if (flags.revision !== undefined) {
        const boundary = /^ChangeOrder:(.+)$/.exec(String(flags.revision));
        if (!boundary) {
          return refuse(`the self-test fake hub publishes at a change order's boundary only, not ${flags.revision}`);
        }
        order = resolveChangeOrder(boundary[1]);
        if (!order) return refuse(`change order ${boundary[1]} not found`);
      }
      const rows = [...units.values()]
        .filter((unit) => unit.SpaceSlug === spaceSlug && unit.TargetID)
        .sort((left, right) => left.Slug.localeCompare(right.Slug));
      if (rows.length === 0) return refuse(`${spaceSlug} has no unit to publish`);
      const bundled = rows.map((unit) => {
        const revision = order && unit.tags?.[order.Key] !== undefined
          ? unit.tags[order.Key]
          : unit.HeadRevisionNum;
        return { unit, revision, text: unit.history.get(revision) };
      });
      // Measured on 2026-09-26: a publish whose bundle is identical to what
      // the Space already serves is refused, whatever it is pinned to.
      const data = bundled.map((row) => row.text).join("\n---\n");
      if (releases.get(spaceSlug)?.data === data) {
        return refuse("Failed: HTTP 400 for req self-test: no changes were made since :latest bundle");
      }
      // The release gate: a release of a change order into a Space of a stage
      // with ReleasePrerequisites is evaluated over the revisions it bundles,
      // and refused, in the server's words, until each requirement holds.
      // A plain publish is not gated, and neither is a component's declared
      // workflow requirement enforced on it, as measured on 2026-09-26.
      if (order && !state.releaseGateDisabled) {
        const refusal = releaseGateRefusal(order, spaceSlug, bundled);
        if (refusal) return refuse(`Failed: HTTP 422 for req self-test: ${refusal}`);
      }
      const digestInput = bundled
        .map((row) => `${row.unit.Slug}:${sha256(row.text)}:${row.revision}`)
        .join("|");
      releaseSequence += 1;
      const manifestDigest = `sha256:${sha256(`manifest:${spaceSlug}:${releaseSequence}:${digestInput}`)}`;
      // The gateway serves what was published, so the fake keeps the published
      // bytes and the fake cluster reads them back through the tag.
      releases.set(spaceSlug, { manifestDigest, data });
      const carried = releasedChangeOrders.get(spaceSlug) ?? new Set();
      const tagged = new Set(bundled.flatMap((row) => Object.keys(row.unit.tags ?? {})));
      for (const key of tagged) {
        const reached = bundled.filter((row) => row.unit.tags?.[key] !== undefined);
        if (reached.every((row) => row.unit.tags[key] === row.revision)) carried.add(key);
      }
      releasedChangeOrders.set(spaceSlug, carried);
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
    const { history, UpstreamUnitKey, snapshot, tags, ...rest } = unit;
    return structuredClone(rest);
  };
  // The refused promotion left the variants a revision ahead, so the walk that
  // follows it starts from the departed baseline again.
  const restoreVariantBaselines = () => {
    for (const unit of units.values()) {
      if (!unit.snapshot) continue;
      unit.history.delete(unit.HeadRevisionNum);
      Object.assign(unit, unit.snapshot);
      unit.ApplyGates = {};
      delete unit.snapshot;
    }
  };
  // The whole hub, taken and put back, so a self-test can walk a path that
  // fails partway and start again from exactly where it stood.
  const tables = {
    spaces, units, releases, targets, components, workflows, changeOrders,
    releasedChangeOrders,
  };
  const snapshot = () => structuredClone({
    tables,
    pending: [...pending],
    releaseSequence,
    state: { ...state },
  });
  const restore = (saved) => {
    const copy = structuredClone(saved);
    for (const [name, table] of Object.entries(tables)) {
      table.clear();
      for (const [key, value] of copy.tables[name]) table.set(key, value);
    }
    pending.clear();
    for (const key of copy.pending) pending.add(key);
    releaseSequence = copy.releaseSequence;
    Object.assign(state, copy.state);
  };
  const componentRequires = (slug) => {
    const row = componentFor(slug);
    return row?.ChangeWorkflowRequired ? (row.AllowedChangeWorkflows ?? [])[0] : null;
  };
  const attestationsOn = (spaceSlug) => [...units.values()]
    .filter((unit) => unit.SpaceSlug === spaceSlug)
    .reduce((total, unit) => total + (unit.attestations ?? []).length, 0);
  const releaseFor = (space) => releases.get(space) ?? null;
  // A label moved by hand, so the self-test can show a stage that no longer
  // selects the wave being refused. Undefined removes the label.
  const setSpaceLabel = (slug, key, value) => {
    const row = spaces.get(slug);
    check(row, `the self-test fake hub has no Space ${slug}`);
    row.Labels = { ...(row.Labels ?? {}) };
    if (value === undefined) delete row.Labels[key];
    else row.Labels[key] = value;
  };
  return {
    state,
    handle,
    tick,
    releaseFor,
    restoreVariantBaselines,
    setSpaceLabel,
    snapshot,
    restore,
    componentRequires,
    attestationsOn,
    spaceLabels: (slug) => spaces.get(slug)?.Labels ?? null,
    releasedChangeOrders: (slug) => [...(releasedChangeOrders.get(slug) ?? [])],
    filterId,
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
    "--upgrade", "--change-workflow-required", "--help",
  ]);
  const repeatable = new Set(["label", "stage", "prerequisites"]);
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
