#!/usr/bin/env node

// Chapter six: the held cluster.
//
// The root README names the one thing the recorded chapters do not claim: a
// single action that halts and reverses a rollout across the fleet. This
// chapter records the thing the repository can claim instead, end to end:
// one production cluster restored to an exact earlier revision under the same
// approval gate that governed every advance, while its twin stays on the
// newer release; then a further fleet advance during which the restored
// cluster is deliberately held, where the hold is nothing more than the
// absence of one approval; and a closing audit that shows the fleet at three
// different points on purpose, every one of them a recorded fact.
//
// Deliberate design difference from every sibling runner: this chapter
// creates no clusters, no Spaces, and no records. It CONTINUES the newest
// chapter-three cohort. It reads runs/sveltos-env-rollout-proof/receipt.yaml
// to discover the cohort id, the five cluster names, the base and variant
// Space names, and the recorded revisions, and its live lane refuses to run
// unless that cohort's clusters are standing and its Spaces answer. The
// reviewed shape of the two advances, the restore, and the hold lives in
// examples/sveltos/held-cluster/, and the continuation note there states the
// creates-nothing boundary this runner enforces.
//
// The restore verb is the CLI's own: `cub unit update --restore <revision>`
// writes the exact content of an earlier revision as a new head revision.
// The approval gate arms on that new head like on any other revision, so the
// restore is governed by the same gate as every advance. Publish is refused
// while it is unapproved, and that refusal is captured as evidence.
//
// A merge honesty note a reviewer should hold on to: the restore is a local
// change to the same values field the next base advance also writes. The
// recorded ConfigHub finding says a local change to the same field wins a
// later merge silently. This chapter does not depend on which side wins: the
// held cluster's upgrade outcome is recorded as observed, and the hold
// evidence is the unapproved gate on the pending head plus the cluster's
// observed state, not the pending content.
//
// Deliberate first-increment deviation, also on purpose: --self-test is
// OFFLINE-ONLY pure logic with no fake ConfigHub and no fake cluster. It
// exercises the cohort loader against a fixture chapter-three receipt, the
// restore-revision selection, the receipt invariants against good and
// deliberately corrupted fixtures, and the summary generator, all in
// temporary directories. The fake-hub surface the siblings carry can be
// added when this chapter earns a live recording; note that the shared
// fake-hub flag table in scripts/lib/per-cluster-fleet.mjs does not yet know
// `unit update --restore` and will need that entry first.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  canonicalDocs,
  canonicalValue,
  fieldsCollide,
  governedRecords,
  normalizeDigest,
  pendingApplyGate,
  readPath,
  sameSet,
  storedData,
  waveUnlockEvidence,
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
  node scripts/run-sveltos-held-cluster-proof.mjs --run
  node scripts/run-sveltos-held-cluster-proof.mjs --generate
  node scripts/run-sveltos-held-cluster-proof.mjs --verify
  node scripts/run-sveltos-held-cluster-proof.mjs --self-test`);
  process.exit(2);
}

const expectedPolicyOrg = "helm-catalog";
const approvalFilterRef = "platform/helm-catalog-prod-gates";
const approvalGate = "platform/require-approval/vet-approvedby";
const pendingReason = "the held-cluster chapter has not been recorded live yet";
const policyPath = join(
  repoRoot,
  "config-catalog",
  "policies",
  "catalog-standard.yaml",
);
const expectedTriggers = readYaml(policyPath).spec.approvalRequired.checks
  .map((item) => item.trigger)
  .sort();
// The gateway answers on the bare host, exactly as the probe recorded it.
const configHubOciHost = "oci.hub.confighub.com";
const probeRecord = "docs/planning/remote-url-oci-probe.md";
const cohortReceiptRepoPath = "runs/sveltos-env-rollout-proof/receipt.yaml";
const cohortChangeRepoPath = "examples/sveltos/env-rollout/change-candidate.yaml";
const heldExampleDir = "examples/sveltos/held-cluster";
const changeCandidateRepoPath = `${heldExampleDir}/change-candidate.yaml`;
const restoreCandidateRepoPath = `${heldExampleDir}/restore-candidate.yaml`;
const continuationRepoPath = `${heldExampleDir}/continuation.yaml`;
const receiptPath = join(
  repoRoot,
  "runs",
  "sveltos-held-cluster-proof",
  "receipt.yaml",
);
const summaryPath = join(repoRoot, "data", "sveltos-held-cluster", "summary.md");
const policyUnit = "clusterprofile";
const proofLabel = "sveltos-held-cluster";
const setScope = 'cub unit list --space "*"';
const baseRecordLabel = "base";
const variantRecordLabel = "variant";
const componentLabel = "sveltos-kyverno-held-cluster";
const ownerLabel = "platform-team";
const releaseTag = "latest";
const remoteFetchInterval = "1m0s";
const registrationNamespace = "projectsveltos";
const gatewaySecretName = "confighub-gateway";
// The cohort's management cluster already runs the addon controller build
// with the gzip fix. This chapter installs nothing; it checks the cohort
// receipt recorded that build and rides the running fleet.
const expectedAddonControllerImage = "docker.io/projectsveltos/addon-controller:v1.13.0-ch";
// A Target needs a BridgeWorker with announced support for its ConfigType, so
// the cohort's Targets live in the catalog's infrastructure Space. This
// chapter mints none, but the wiring names the same host the cohort used.
const targetHost = {
  space: "bitnami-redis-27-0-0-default-pilot-live-20260705",
  worker: "server-worker",
};
const publishGateAttempts = 30;
const publishGatePollMs = 2_000;
const convergenceWaitAttempts = 150;
const holdingCheckAttempts = 3;
const backgroundDeployment = "kyverno-background-controller";
// The chart values ride in one string field of the profile, so a change to
// any value rewrites that whole field. That is the field a departure must
// stay clear of, and the field the restore and the base advance both write.
const valuesField = "spec.helmCharts.0.values";

// The record machinery is the shared one, wired the way the CVE patch chapter
// wires it, with this chapter's own labels and its own reviewed-change shape.
// Only the reviewing and publishing helpers run live here; the establish*
// factories are returned by the same call and deliberately go unused, because
// this chapter continues a cohort rather than building one.
const {
  allowedDryRun,
  approvalCount,
  approvalObservation,
  assertMergeKeptDepartures,
  blockedDryRun,
  gatewayReference,
  publishRelease,
  reviewSet,
  selectSet,
  waitForPolicy,
} = governedRecords({
  cub: (...args) => cub(...args),
  cubJson: (...args) => cubJson(...args),
  cubTry: (...args) => cubTry(...args),
  sleep: (...args) => sleep(...args),
  now: (...args) => now(...args),
  // What this chapter's reviewed change looks like once merged: the replica
  // count carried inside the chart values blob, at the reviewed path.
  changedDocOf: (cluster) => cluster.expectedDoc,
  changeInherited: (merged, plan) =>
    readPath(valuesOf(merged) ?? {}, plan.valuesPath) === plan.after,
  appLabel: componentLabel,
  // The bootstrap profiles this chapter watches are chapter three's own, so
  // the prefix is chapter three's. A held-cluster prefix here would make the
  // delivery watcher look for profiles that do not exist.
  bootstrapPrefix: "sveltos-env-rollout",
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

// The self-test swaps nothing here yet: it is offline-only pure logic. The
// seams stay, so a fake hub can be added the way the siblings carry one.
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
    assertReceiptInvariants(receipt, repoRoot),
    "the cohort was re-recorded since this receipt; record a live run on the new cohort before regenerating its summary",
  );
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos held-cluster proof has no live receipt yet; no live run has been recorded yet, because ${pendingReason}`,
  );
} else {
  const receipt = readYaml(receiptPath);
  // A receipt recorded against a cohort that has since been re-recorded is
  // kept as recorded, so its committed summary is kept as recorded too.
  if (assertReceiptInvariants(receipt, repoRoot)) {
    check(
      existsSync(summaryPath),
      `${relativeRepo(summaryPath)} is missing; run the generator`,
    );
    check(
      readFileSync(summaryPath, "utf8") === renderSummary(receipt),
      `${relativeRepo(summaryPath)} is stale`,
    );
  }
  console.log("verified the Sveltos held-cluster proof");
}

// ---------------------------------------------------------------------------
// The reviewed plan and the cohort this chapter continues.
// ---------------------------------------------------------------------------

// One reviewed plan drives the runner, the verifier, and the self-test: the
// two advances around the hold, the restore target, and the closing-audit
// expectations all come from the committed example records.
function loadPlan(root = repoRoot) {
  const change = readYaml(join(root, changeCandidateRepoPath));
  const restore = readYaml(join(root, restoreCandidateRepoPath));
  const continuation = readYaml(join(root, continuationRepoPath));
  check(
    continuation.kind === "SveltosHeldClusterContinuation"
      && continuation.spec?.continues === "env-rollout"
      && continuation.spec.createsClusters === false
      && continuation.spec.createsRecords === false,
    "the continuation note lost its creates-nothing boundary",
  );
  const advances = change.spec?.advances ?? [];
  check(
    change.kind === "SveltosHeldClusterChange"
      && change.spec?.editedRecord === "base"
      && typeof change.spec.valuesPath === "string"
      && advances.length === 2
      && advances[0].name === "advance"
      && advances[1].name === "held-advance"
      && Number(advances[0].to) === Number(advances[1].from)
      && Number(advances[0].from) !== Number(advances[0].to)
      && Number(advances[1].from) !== Number(advances[1].to),
    "the held-cluster change candidate lost its two-advances shape",
  );
  for (const advance of advances) {
    check(
      (advance.waves ?? []).map((row) => `${row.wave}:${row.environment}`).join(",")
        === "1:pilot,2:staging,3:prod",
      `the ${advance.name} waves are not pilot, staging, prod`,
    );
  }
  const heldWave = advances[1].waves.find((row) => row.environment === "prod");
  check(
    Array.isArray(heldWave.held) && heldWave.held.length === 1
      && Array.isArray(heldWave.approved) && heldWave.approved.length === 1
      && restore.kind === "SveltosHeldClusterRestore"
      && restore.spec?.cluster === heldWave.held[0]
      && restore.spec?.twin === heldWave.approved[0]
      && String(restore.spec?.restore?.mechanism ?? "")
        .includes("cub unit update --restore")
      && String(restore.spec?.hold?.mechanism ?? "") === "absence of approval",
    "the restore candidate and the held wave no longer agree on which cluster is held",
  );
  const heldCluster = restore.spec.cluster;
  const twin = restore.spec.twin;
  const expect = change.spec?.closingAudit?.expect ?? {};
  check(
    Number(expect[heldCluster]) === Number(advances[0].from)
      && [twin, "hx-sveltos-env-pilot", "hx-sveltos-env-staging"].every(
        (name) => Number(expect[name]) === Number(advances[1].to),
      ),
    "the closing-audit expectations no longer match the two advances around the hold",
  );
  return {
    valuesPath: change.spec.valuesPath,
    startingReplicas: Number(advances[0].from),
    advanceReplicas: Number(advances[0].to),
    heldReplicas: Number(advances[1].to),
    heldCluster,
    twin,
    expect,
    claimBoundary: String(restore.spec.claimBoundary ?? ""),
    source: Object.fromEntries([
      ["change", changeCandidateRepoPath],
      ["restore", restoreCandidateRepoPath],
      ["continuation", continuationRepoPath],
    ].map(([key, path]) => [key, {
      path,
      rawSha256: sha256(readFileSync(join(root, path), "utf8")),
    }])),
  };
}

// Everything this chapter knows about the fleet comes from the chapter-three
// receipt: the cohort id, the five clusters, the Spaces, the per-cluster
// departures, and the last recorded release per Space. The committed receipt
// is the reviewed source; whether the cohort is still standing is a live
// question the run answers against the clusters and Spaces themselves.
function loadCohort(root = repoRoot) {
  const path = join(root, cohortReceiptRepoPath);
  check(
    existsSync(path),
    `${cohortReceiptRepoPath} is missing; this chapter continues that cohort and cannot run without it`,
  );
  const receipt = readYaml(path);
  check(
    receipt.kind === "SveltosEnvRolloutProofReceipt"
      && receipt.status?.result === "pass",
    "the chapter-three receipt is not a passing SveltosEnvRolloutProofReceipt",
  );
  const baseSpace = String(receipt.spec?.base?.space ?? "");
  const idMatch = /^hx-sveltos-env-base-(\d{8,14})$/.exec(baseSpace);
  check(idMatch, `the chapter-three base Space ${baseSpace || "(missing)"} carries no cohort id`);
  const runId = idMatch[1];
  const managementCluster = String(receipt.spec?.fleet?.managementCluster ?? "");
  check(
    managementCluster === `hx-sveltos-envmgmt-${runId}`,
    "the chapter-three management cluster does not carry the cohort id",
  );
  const registrations = receipt.spec?.fleet?.registrations ?? [];
  check(registrations.length === 4, "the chapter-three cohort must register four workload clusters");
  const variants = (receipt.spec?.variants ?? []).filter(
    (row) => row.role === "workload",
  );
  const management = (receipt.spec?.variants ?? []).find(
    (row) => row.role === "management",
  );
  check(variants.length === 4 && management, "the chapter-three receipt lost its five variants");
  const workloads = registrations.map((registration) => {
    const cluster = String(registration.cluster);
    const variant = variants.find((row) => row.cluster === cluster);
    check(variant, `the chapter-three receipt has no variant for ${cluster}`);
    check(
      registration.kindCluster === `${cluster}-${runId}`
        && variant.space === `${cluster}-${runId}`,
      `${cluster} does not follow the cohort naming pattern`,
    );
    const lastRecord = (variant.records ?? []).at(-1);
    check(
      normalizeDigest(lastRecord?.release?.manifestDigest)
        === lastRecord?.release?.manifestDigest,
      `${cluster} has no recorded last release digest`,
    );
    return {
      cluster,
      kindCluster: registration.kindCluster,
      environment: String(registration.labels?.environment ?? variant.environment),
      wave: Number(variant.wave),
      space: variant.space,
      profile: String(variant.profile),
      departures: variant.departures ?? {},
      departurePaths: [...(variant.departedFields ?? [])].sort(),
      gatewayReference: String(variant.gatewayReference),
      cohortReleaseDigest: lastRecord.release.manifestDigest,
    };
  });
  check(
    sameSet(workloads.map((row) => row.environment), ["pilot", "staging", "prod", "prod"]),
    "the cohort must hold one pilot, one staging, and two prod clusters",
  );
  check(
    Number(receipt.spec?.convergenceAudit?.expectedBackgroundReplicas) > 0,
    "the chapter-three receipt records no convergence outcome to start from",
  );
  check(
    receipt.spec?.prerequisite?.addonControllerImage === expectedAddonControllerImage,
    `the cohort runs a different addon controller than ${expectedAddonControllerImage}`,
  );
  // The set queries reuse chapter three's committed selection template, because
  // the records carry chapter three's labels and this chapter relabels nothing.
  const change = readYaml(join(root, cohortChangeRepoPath));
  const whereTemplate = String(change.spec?.selection?.whereTemplate ?? "");
  check(
    whereTemplate.includes("{run}") && whereTemplate.includes("{environment}"),
    "the chapter-three change candidate lost its selection template",
  );
  const waves = [
    { wave: 1, environment: "pilot" },
    { wave: 2, environment: "staging" },
    { wave: 3, environment: "prod" },
  ].map((row) => ({
    ...row,
    clusters: workloads
      .filter((item) => item.environment === row.environment)
      .map((item) => item.cluster),
  }));
  return {
    receiptRepoPath: cohortReceiptRepoPath,
    receiptSha256: sha256(readFileSync(path, "utf8")),
    runId,
    recordedOutcomeReplicas:
      Number(receipt.spec.convergenceAudit.expectedBackgroundReplicas),
    cohortCleanupMode: String(receipt.spec?.cleanup?.mode ?? "unknown"),
    managementCluster,
    managementSpace: String(management.space),
    baseSpace,
    workloads,
    waves,
    whereTemplate,
    clusters: [managementCluster, ...workloads.map((row) => row.kindCluster)],
    spaces: [baseSpace, String(management.space), ...workloads.map((row) => row.space)],
  };
}

function waveQuery(cohort, environment) {
  return cohort.whereTemplate
    .replaceAll("{run}", cohort.runId)
    .replaceAll("{environment}", environment);
}

function clusterQuery(cohort, environment, cluster) {
  return `${waveQuery(cohort, environment)} AND Labels.Cluster = '${cluster}'`;
}

// The restore target is the head revision the starting point recorded, which
// is the cohort's last approved revision before this chapter changed anything.
function restoreTargetRevision(startingPoint, cluster) {
  const record = startingPoint?.[cluster];
  check(record, `the starting point recorded no head revision for ${cluster}`);
  const revision = Number(record.headRevision);
  check(
    Number.isInteger(revision) && revision > 0,
    `the starting point head revision for ${cluster} is not a positive revision number`,
  );
  return revision;
}

function valuesOf(doc) {
  const text = doc?.spec?.helmCharts?.[0]?.values;
  if (typeof text !== "string") return undefined;
  return parseDocs(text)[0];
}

// A change to any value rewrites the whole values field, which is the
// granularity ConfigHub merges at. The changed base string is written into
// every expected variant doc verbatim, because that is exactly the string the
// merge writes.
function withChangedValue(doc, path, next) {
  const changed = structuredClone(doc);
  const values = valuesOf(doc);
  check(values, "the profile carries no chart values to change");
  writePath(values, path, next);
  changed.spec.helmCharts[0].values = `${toYaml(values)}\n`;
  return changed;
}

function withValuesText(doc, valuesText) {
  const changed = structuredClone(doc);
  changed.spec.helmCharts[0].values = valuesText;
  return changed;
}

function revisionIdentity(prefix, doc) {
  return `${prefix}-${sha256(stableJson(doc)).slice(0, 12)}`;
}

function canonicalEqual(left, right) {
  return stableJson(canonicalValue(left)) === stableJson(canonicalValue(right));
}

// ---------------------------------------------------------------------------
// The live run.
// ---------------------------------------------------------------------------

function run() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_SVELTOS_HELD_CLUSTER === "1",
    "set HELM_EXPT_ALLOW_LIVE_SVELTOS_HELD_CLUSTER=1 to confirm this live proof",
  );
  check(policyContext, "set CUB_CONTEXT to an authenticated helm-catalog context");
  for (const [tool, args] of [
    ["cub", ["version"]],
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
    `refusing to write policy evidence outside ${expectedPolicyOrg}`,
  );

  const recordedAt = new Date().toISOString();
  const runStamp = safeRunId(process.env.HELM_EXPT_PROOF_RUN_ID || recordedAt);
  const plan = loadPlan();
  const cohort = loadCohort();
  check(
    cohort.recordedOutcomeReplicas === plan.startingReplicas,
    `the chapter-three outcome is ${cohort.recordedOutcomeReplicas} replicas, not the ${plan.startingReplicas} the reviewed change starts from`,
  );
  const topology = readApprovalTopology(policyContext);

  // The cohort must be standing before anything is written: every kind
  // cluster present, every Space answering. A cohort whose receipt records a
  // removed cleanup fails here with the remedy named.
  const standing = tryCommand("kind", ["get", "clusters"]);
  check(standing.ok, "kind cannot list clusters");
  const present = standing.output.split(/\r?\n/);
  for (const name of cohort.clusters) {
    check(
      present.includes(name),
      `the cohort cluster ${name} is gone; this chapter continues a standing chapter-three cohort, so re-record chapter three with HELM_EXPT_KEEP_SVELTOS_ARTIFACTS=1 first`,
    );
  }
  for (const space of cohort.spaces) {
    check(
      spacePresent(policyContext, space),
      `the cohort Space ${space} does not answer; this chapter continues a standing chapter-three cohort, so re-record chapter three with HELM_EXPT_KEEP_SVELTOS_ARTIFACTS=1 first`,
    );
  }
  phase(`continuing cohort ${cohort.runId}: five clusters standing, six Spaces answering`);

  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-held-cluster-"));
  const cleanup = {
    mode: "kept",
    keptDeliberately: true,
    note: "This chapter created no clusters and no Spaces. It continued the chapter-three cohort and leaves it standing, exactly as it found it.",
    results: {
      cohortClusters: "kept",
      cohortSpaces: "kept",
      localFiles: "pending",
    },
    kept: [
      ...cohort.clusters.map((name) => ({
        kind: "kind cluster",
        name,
        removeWith: `kind delete cluster --name ${name}`,
      })),
      ...cohort.spaces.map((space) => ({
        kind: "ConfigHub Space",
        name: space,
        removeWith: `cub space delete ${space} --recursive-force`,
      })),
    ],
  };
  let receipt;

  try {
    const kubeconfigs = exportKubeconfigs(cohort, workRoot);
    phase("kubeconfigs exported for the management cluster and all four workload clusters");

    // Step one: the starting point. Every record's head revision and stored
    // content, the base's values, and every cluster's observed state, all
    // captured before anything changes, because the restore target and the
    // audit both key off this snapshot.
    const liveBase = readUnit(policyContext, cohort.baseSpace);
    const baseDoc = parseDocs(storedData(liveBase))[0];
    check(
      readPath(valuesOf(baseDoc) ?? {}, plan.valuesPath) === plan.startingReplicas,
      `the live base record does not hold the chapter-three outcome of ${plan.startingReplicas} replicas`,
    );
    const startingPoint = {};
    for (const row of cohort.workloads) {
      const unit = readUnit(policyContext, row.space);
      const docs = parseDocs(storedData(unit));
      check(
        readPath(valuesOf(docs[0]) ?? {}, plan.valuesPath) === plan.startingReplicas,
        `${row.cluster} does not start at ${plan.startingReplicas} replicas`,
      );
      for (const path of row.departurePaths) {
        check(
          canonicalEqual(readPath(docs[0], path), row.departures[path]),
          `${row.cluster} lost its recorded departure on ${path} before this chapter began`,
        );
        check(
          !fieldsCollide(path, valuesField, baseDoc),
          `${row.cluster} departs on ${path}, which this chapter's reviewed change also writes; a departure wins that merge silently, so this run is refused`,
        );
      }
      startingPoint[row.cluster] = {
        space: row.space,
        headRevision: Number(unit.HeadRevisionNum),
        contentHash: unit.ContentHash,
        revisionId: revisionIdentity("s1", docs[0]),
        docs,
        gatewayReference: gatewayReference(row.space),
        cohortReleaseDigest: row.cohortReleaseDigest,
      };
    }
    const advanceCheckpoints = [
      recordCheckpoint({
        id: "baseline",
        phase: "advance",
        cohort,
        kubeconfigs,
        expected: expectationMap(cohort, () => plan.startingReplicas),
        converging: new Set(cohort.workloads.map((row) => row.cluster)),
      }),
    ];
    phase("starting point recorded: every record and every cluster at the chapter-three outcome");

    // Step two: the advance. One reviewed change on the base, inherited wave
    // by wave, every approval bound to one cluster's own exact revision.
    const advance = promoteChange({
      policyContext,
      plan,
      cohort,
      kubeconfigs,
      baseDoc,
      startingRevisions: Object.fromEntries(
        cohort.workloads.map((row) => [
          row.cluster,
          startingPoint[row.cluster].headRevision,
        ]),
      ),
      startingDocs: Object.fromEntries(
        cohort.workloads.map((row) => [row.cluster, startingPoint[row.cluster].docs[0]]),
      ),
      before: plan.startingReplicas,
      after: plan.advanceReplicas,
      stagePrefix: "advance",
      revisionPrefix: "a2",
      heldClusters: [],
      checkpoints: advanceCheckpoints,
      runStamp,
    });
    phase(`the advance landed: every cluster converged on ${plan.advanceReplicas} replicas`);

    // Step three: the governed restore. One production cluster back to its
    // exact pre-advance revision, gated, refused while unapproved, approved,
    // published, and observed, while its twin stays on the advance.
    const restore = restoreHeldCluster({
      policyContext,
      plan,
      cohort,
      kubeconfigs,
      startingPoint,
      advance,
      runStamp,
    });
    phase(`${plan.heldCluster} restored to revision ${restore.revisionRestoredTo} and observed at ${plan.startingReplicas} replicas while ${plan.twin} stays at ${plan.advanceReplicas}`);

    const heldCheckpoints = [
      recordCheckpoint({
        id: "baseline",
        phase: "held-advance",
        cohort,
        kubeconfigs,
        expected: expectationMap(cohort, (row) =>
          row.cluster === plan.heldCluster
            ? plan.startingReplicas
            : plan.advanceReplicas),
        converging: new Set(),
      }),
    ];

    // Step four: the held advance. A second reviewed change moves the fleet
    // on; the restored cluster's variant is upgraded with the same set
    // operation and then simply not approved. The hold IS that absence.
    const heldAdvance = promoteChange({
      policyContext,
      plan,
      cohort,
      kubeconfigs,
      baseDoc: advance.base.doc,
      startingRevisions: {
        ...advance.headAfter,
        [plan.heldCluster]: restore.approval.revision,
      },
      startingDocs: {
        ...advance.docsAfter,
        [plan.heldCluster]: restore.restoredDoc,
      },
      before: plan.advanceReplicas,
      after: plan.heldReplicas,
      stagePrefix: "held advance",
      revisionPrefix: "h3",
      heldClusters: [plan.heldCluster],
      heldExpectedReplicas: plan.startingReplicas,
      checkpoints: heldCheckpoints,
      runStamp,
    });
    const heldRecord = recordHold({
      policyContext,
      plan,
      cohort,
      kubeconfigs,
      restore,
      heldAdvance,
    });
    phase(`the held advance landed on pilot, staging, and ${plan.twin}; ${plan.heldCluster} holds at the restored revision with its approval deliberately absent`);

    // Step five: the closing audit. The fleet at three points on purpose,
    // every one of them read back from ConfigHub and from the clusters.
    const fleetAudit = auditFleet({
      policyContext,
      plan,
      cohort,
      kubeconfigs,
      restore,
      heldAdvance,
      heldRecord,
    });
    check(fleetAudit.result === "pass", "the fleet audit did not pass");
    phase("fleet audit passed: three revisions across four clusters, every one deliberate and recorded");

    receipt = buildReceipt({
      recordedAt,
      plan,
      cohort,
      topology,
      startingPoint,
      advance,
      restore,
      heldAdvance,
      heldRecord,
      fleetAudit,
      checkpoints: [...advanceCheckpoints, ...heldCheckpoints],
      cleanup,
    });
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
    cleanup.results.localFiles = existsSync(workRoot) ? "fail" : "pass";
  }

  check(receipt, "the Sveltos held-cluster proof did not complete");
  check(
    cleanupSucceeded(cleanup),
    `Sveltos held-cluster cleanup record is inconsistent: ${JSON.stringify(cleanup)}`,
  );
  writeYaml(receiptPath, receipt);
  write(summaryPath, renderSummary(receipt));
  check(
    assertReceiptInvariants(receipt, repoRoot) === true,
    "the fresh receipt does not satisfy its own invariants",
  );
  console.log(
    `wrote ${relativeRepo(receiptPath)} and ${relativeRepo(summaryPath)}`,
  );
}

function expectationMap(cohort, expectedFor) {
  return Object.fromEntries(
    cohort.workloads.map((row) => [row.cluster, expectedFor(row)]),
  );
}

// One reviewed change on the base record, inherited wave by wave. Held
// clusters ride the wave's set upgrade and are then left unapproved; their
// merge outcome is recorded as observed rather than asserted, because the
// restore is a local change to the same field the base change writes.
function promoteChange({
  policyContext,
  plan,
  cohort,
  kubeconfigs,
  baseDoc,
  startingRevisions,
  startingDocs,
  before,
  after,
  stagePrefix,
  revisionPrefix,
  heldClusters,
  heldExpectedReplicas,
  checkpoints,
  runStamp,
}) {
  check(
    readPath(valuesOf(baseDoc) ?? {}, plan.valuesPath) === before,
    `the base record is not at ${before} replicas before the ${stagePrefix}`,
  );
  const changedBaseDoc = withChangedValue(baseDoc, plan.valuesPath, after);
  const newValuesText = changedBaseDoc.spec.helmCharts[0].values;
  const changedPath = join(
    mkdtempSync(join(tmpdir(), "helm-expt-held-base-")),
    "clusterprofile-base.yaml",
  );
  writeStoredDocuments(changedPath, [changedBaseDoc]);
  cub(policyContext, [
    "unit", "update", "--space", cohort.baseSpace, policyUnit, changedPath,
    "--change-desc",
    `Raise ${plan.valuesPath} from ${before} to ${after} on the base record (held-cluster run ${runStamp})`,
    "--quiet",
  ]);
  const storedBase = readUnit(policyContext, cohort.baseSpace);
  check(
    canonicalDocs(parseDocs(storedData(storedBase)))
      === canonicalDocs([changedBaseDoc]),
    `ConfigHub stored a different ${stagePrefix} base ClusterProfile`,
  );
  const base = {
    space: cohort.baseSpace,
    unit: policyUnit,
    revision: Number(storedBase.HeadRevisionNum),
    revisionId: revisionIdentity(`${revisionPrefix}b`, changedBaseDoc),
    fromReplicas: before,
    toReplicas: after,
    approved: false,
    publishedAsRelease: false,
    doc: changedBaseDoc,
  };

  const expectedDocFor = Object.fromEntries(
    cohort.workloads.map((row) => [
      row.cluster,
      withValuesText(startingDocs[row.cluster], newValuesText),
    ]),
  );
  const waveRecords = [];
  const headAfter = {};
  const docsAfter = {};
  for (const wave of cohort.waves) {
    const previous = wave.wave === 1
      ? null
      : cohort.waves.find((row) => row.wave === wave.wave - 1);
    const unlockedBy = waveUnlockEvidence({
      wave: wave.wave,
      previousEnvironment: previous?.environment ?? null,
      expectedClusters: previous
        ? previous.clusters.filter((name) => !heldClusters.includes(name))
        : cohort.workloads.map((row) => row.cluster),
      checkpoints,
    });
    const query = waveQuery(cohort, wave.environment);
    const members = wave.clusters.map((name) =>
      cohort.workloads.find((row) => row.cluster === name));
    const approvedMembers = members.filter(
      (row) => !heldClusters.includes(row.cluster),
    );
    check(approvedMembers.length > 0, `wave ${wave.wave} would approve nothing`);
    // The upgrade is one set operation over the whole wave, held members
    // included. The approval that follows deliberately selects a smaller set.
    const preflight = selectSet({
      policyContext,
      stageName: `${stagePrefix} wave ${wave.wave}`,
      query,
      expectedUnits: members.map((row) => `${row.space}/${policyUnit}`),
    });
    const upgrade = cubTry(policyContext, [
      "unit", "update", "--patch", "--space", "*", "--where", query, "--upgrade",
      "--change-desc",
      `Inherit ${plan.valuesPath}=${after} from the base into the ${wave.environment} variants (held-cluster run ${runStamp})`,
      "--quiet",
    ]);
    check(upgrade.ok, `the ${stagePrefix} wave ${wave.wave} upgrade did not run: ${upgrade.error}`);
    for (const row of approvedMembers) {
      assertMergeKeptDepartures({
        policyContext,
        space: row.space,
        cluster: {
          ...row,
          expectedDoc: expectedDocFor[row.cluster],
        },
        plan: { valuesPath: plan.valuesPath, after },
      });
    }
    const approvalQuery = approvedMembers.length === members.length
      ? query
      : clusterQuery(cohort, wave.environment, approvedMembers[0].cluster);
    const reviewed = reviewSet({
      policyContext,
      stageName: `${stagePrefix} wave ${wave.wave}`,
      query: approvalQuery,
      members: approvedMembers.map((row) => ({
        cluster: row.cluster,
        space: row.space,
        expectedDocs: [expectedDocFor[row.cluster]],
        revisionId: revisionIdentity(revisionPrefix, expectedDocFor[row.cluster]),
        minimumRevision: Number(startingRevisions[row.cluster]) + 1,
      })),
    });
    const promoted = [];
    for (const row of approvedMembers) {
      const record = reviewed.records[row.cluster];
      const delivery = waitForProfile({
        managementKubeconfig: kubeconfigs.management,
        profileName: row.profile,
        expectedDoc: expectedDocFor[row.cluster],
      });
      check(
        delivery.result === "pass",
        `Sveltos did not deliver the ${stagePrefix} to ${row.cluster}: ${delivery.reason ?? "unknown"}`,
      );
      headAfter[row.cluster] = Number(record.approval.revision);
      docsAfter[row.cluster] = expectedDocFor[row.cluster];
      promoted.push({
        cluster: row.cluster,
        space: row.space,
        revision: record.approval.revision,
        revisionId: record.revisionId,
        recordedApprovals: record.approval.recordedApprovals,
        releaseManifestDigest: record.release.manifestDigest,
        inheritedFields: [valuesField],
        departedFields: row.departurePaths,
        beforeApproval: record.beforeApproval,
        afterApproval: record.afterApproval,
        release: record.release,
        delivery,
      });
    }
    checkpoints.push(recordCheckpoint({
      id: `after-wave-${wave.wave}`,
      phase: stagePrefix === "advance" ? "advance" : "held-advance",
      cohort,
      kubeconfigs,
      expected: expectationMap(cohort, (row) => {
        if (heldClusters.includes(row.cluster)) return heldExpectedReplicas;
        return row.wave <= wave.wave ? after : before;
      }),
      converging: new Set(approvedMembers.map((row) => row.cluster)),
    }));
    waveRecords.push({
      wave: wave.wave,
      environment: wave.environment,
      unlockedBy,
      selection: { ...preflight },
      upgrade: {
        command: 'cub unit update --patch --space "*" --where <query> --upgrade',
        appliedAsOneOperation: true,
        members: members.length,
        heldMembers: members.length - approvedMembers.length,
      },
      approval: reviewed.approval,
      approvalSelection: reviewed.selection,
      clusters: promoted,
    });
  }
  return { base, waves: waveRecords, headAfter, docsAfter, fromReplicas: before, toReplicas: after };
}

// The governed restore: `cub unit update --restore` writes the exact content
// of the pre-advance revision as a new head, the approval gate arms on that
// head, publish is refused while it is unapproved, and only the recorded
// approval lets the older digest ship again.
function restoreHeldCluster({
  policyContext,
  plan,
  cohort,
  kubeconfigs,
  startingPoint,
  advance,
  runStamp,
}) {
  const row = cohort.workloads.find((item) => item.cluster === plan.heldCluster);
  const revision = restoreTargetRevision(startingPoint, plan.heldCluster);
  const restoredDoc = startingPoint[plan.heldCluster].docs[0];
  cub(policyContext, [
    "unit", "update", "--space", row.space, policyUnit,
    "--restore", String(revision),
    "--change-desc",
    `Restore ${plan.heldCluster} to revision ${revision}, the last revision before the ${advance.toReplicas}-replica advance (held-cluster run ${runStamp})`,
    "--quiet",
  ]);
  const stored = waitForPolicy(policyContext, row.space, policyUnit, true);
  check(
    canonicalDocs(parseDocs(storedData(stored))) === canonicalDocs([restoredDoc]),
    `the restore did not reproduce the exact content of revision ${revision}`,
  );
  check(
    Number(stored.HeadRevisionNum) > Number(advance.headAfter[plan.heldCluster]),
    "the restore created no new head revision",
  );
  const beforeApproval = blockedDryRun(policyContext, row.space, policyUnit);
  const publishRefusal = probePublishRefusal(policyContext, row.space);
  approveHeadRevision(
    policyContext,
    row.space,
    policyUnit,
    "restore",
    stored.HeadRevisionNum,
  );
  const approved = waitForPolicy(policyContext, row.space, policyUnit, false);
  check(
    approved.ContentHash === stored.ContentHash,
    "approval changed the restored content",
  );
  const recordedApprovals = approvalCount(approved.ApprovedBy);
  check(recordedApprovals >= 1, "the restore has no recorded approval");
  const afterApproval = allowedDryRun(policyContext, row.space, policyUnit);
  const release = publishRelease(policyContext, row.space);
  check(
    release.manifestDigest
      !== advance.waves.flatMap((wave) => wave.clusters)
        .find((member) => member.cluster === plan.heldCluster)
        .releaseManifestDigest,
    "the restore published the advance's own release digest, so nothing moved",
  );
  const delivery = waitForProfile({
    managementKubeconfig: kubeconfigs.management,
    profileName: row.profile,
    expectedDoc: restoredDoc,
  });
  check(
    delivery.result === "pass",
    `Sveltos did not deliver the restored revision to ${plan.heldCluster}: ${delivery.reason ?? "unknown"}`,
  );
  const restoredObservation = waitForReplicas({
    kubeconfig: kubeconfigs[plan.heldCluster],
    expected: plan.startingReplicas,
    attempts: convergenceWaitAttempts,
  });
  check(
    restoredObservation.result === "pass",
    `${plan.heldCluster} did not return to ${plan.startingReplicas} replicas: ${restoredObservation.reason ?? "unknown"}`,
  );
  // The twin's short budget is the point: it must already be at the advance,
  // holding it, not converging toward anything.
  const twinObservation = waitForReplicas({
    kubeconfig: kubeconfigs[plan.twin],
    expected: plan.advanceReplicas,
    attempts: holdingCheckAttempts,
  });
  check(
    twinObservation.result === "pass",
    `${plan.twin} did not stay at ${plan.advanceReplicas} replicas while its twin was restored`,
  );
  return {
    cluster: plan.heldCluster,
    twin: plan.twin,
    space: row.space,
    unit: policyUnit,
    command: `cub unit update --space ${row.space} ${policyUnit} --restore ${revision}`,
    revisionRestoredTo: revision,
    restoredRevisionId: startingPoint[plan.heldCluster].revisionId,
    headRevisionAfterRestore: Number(approved.HeadRevisionNum),
    restoredContentMatchesStartingPoint: true,
    restoredDoc,
    gateEvidence: {
      beforeApproval,
      publishRefusal,
      afterApproval,
    },
    approval: {
      revision: Number(approved.HeadRevisionNum),
      recordedApprovals,
      approverIdentityRecordedInReceipt: false,
      contentHashUnchanged: true,
    },
    release,
    delivery,
    perCluster: {
      [plan.heldCluster]: {
        observedReplicas: restoredObservation.desired,
        observation: restoredObservation,
        state: "restored",
      },
      [plan.twin]: {
        observedReplicas: twinObservation.desired,
        observation: twinObservation,
        headRevision: Number(advance.headAfter[plan.twin]),
        state: "stayed-on-advance",
      },
    },
  };
}

// The hold, recorded as what it is: a pending head revision with the gate
// armed and no approval on it, a released tag that still names the restored
// revision, and a cluster still observed at the restored state.
function recordHold({ policyContext, plan, cohort, kubeconfigs, restore, heldAdvance }) {
  const row = cohort.workloads.find((item) => item.cluster === plan.heldCluster);
  const unit = readUnit(policyContext, row.space);
  const headRevision = Number(unit.HeadRevisionNum);
  check(
    headRevision > restore.approval.revision,
    `the held advance created no pending revision on ${plan.heldCluster}, so there is nothing to hold`,
  );
  const pendingDocs = parseDocs(storedData(unit));
  const pendingValues = readPath(valuesOf(pendingDocs[0]) ?? {}, plan.valuesPath);
  for (const path of row.departurePaths) {
    check(
      canonicalEqual(readPath(pendingDocs[0], path), row.departures[path]),
      `${plan.heldCluster} lost its departure on ${path} in the pending upgrade`,
    );
  }
  const gateState = blockedDryRun(policyContext, row.space, policyUnit);
  // The cluster must still be observed at the restored state after the rest
  // of the fleet moved, with only the holding budget to prove it is holding.
  const observation = waitForReplicas({
    kubeconfig: kubeconfigs[plan.heldCluster],
    expected: plan.startingReplicas,
    attempts: holdingCheckAttempts,
  });
  check(
    observation.result === "pass",
    `${plan.heldCluster} did not hold at ${plan.startingReplicas} replicas: ${observation.reason ?? "unknown"}`,
  );
  const profileStillRestored = waitForProfile({
    managementKubeconfig: kubeconfigs.management,
    profileName: row.profile,
    expectedDoc: restore.restoredDoc,
    attempts: holdingCheckAttempts,
  });
  check(
    profileStillRestored.result === "pass",
    `the live ${plan.heldCluster} profile moved past the restored revision while unapproved`,
  );
  return {
    cluster: plan.heldCluster,
    space: row.space,
    headRevision,
    pendingRevisionCreated: true,
    pendingValues,
    // The recorded merge finding says a local change to the same field wins
    // silently, so whether the pending head carries the fleet's new value or
    // the restored one is recorded as observed, never asserted.
    upstreamChangeApplied: pendingValues === heldAdvance.toReplicas,
    approvedRevision: restore.approval.revision,
    releasedManifestDigest: restore.release.manifestDigest,
    gateState: {
      gate: approvalGate,
      result: gateState.result,
      observation: gateState.observation,
      approvalAbsent: true,
      pendingHeadRevision: headRevision,
    },
    observation,
    profileStillRestored,
  };
}

// The closing audit reads everything back: head revision and gate state from
// ConfigHub, released digest from this run's own publishes, replicas from the
// clusters. Three numbers across four clusters, all deliberate.
function auditFleet({
  policyContext,
  plan,
  cohort,
  kubeconfigs,
  restore,
  heldAdvance,
  heldRecord,
}) {
  const releasedDigestFor = (cluster) => {
    if (cluster === plan.heldCluster) return restore.release.manifestDigest;
    return heldAdvance.waves.flatMap((wave) => wave.clusters)
      .find((member) => member.cluster === cluster).releaseManifestDigest;
  };
  const clusters = cohort.workloads.map((row) => {
    const unit = readUnit(policyContext, row.space);
    const docs = parseDocs(storedData(unit));
    const seen = approvalObservation(policyContext, row.space, policyUnit);
    const held = row.cluster === plan.heldCluster;
    const expectedReplicas = Number(plan.expect[row.cluster]);
    const observation = waitForReplicas({
      kubeconfig: kubeconfigs[row.cluster],
      expected: expectedReplicas,
      attempts: holdingCheckAttempts,
    });
    for (const path of row.departurePaths) {
      check(
        canonicalEqual(readPath(docs[0], path), row.departures[path]),
        `${row.cluster} lost its departure on ${path} by the closing audit`,
      );
    }
    return {
      cluster: row.cluster,
      environment: row.environment,
      space: row.space,
      headRevision: Number(unit.HeadRevisionNum),
      approvedRevision: held
        ? restore.approval.revision
        : Number(heldAdvance.headAfter[row.cluster]),
      approvalsOnHead: seen.approvalCount,
      gateKeysOnHead: seen.gateKeys.filter((key) => key.includes("require-approval")),
      releasedDigest: releasedDigestFor(row.cluster),
      expectedReplicas,
      observedReplicas: observation.desired,
      observation,
      departuresKept: true,
      pendingUpgrade: held,
      state: held ? "held-at-restored-revision" : "advanced",
    };
  });
  const failures = clusters.filter((row) => row.observation.result !== "pass");
  const heldRow = clusters.find((row) => row.cluster === plan.heldCluster);
  const result =
    failures.length === 0
      && clusters
        .filter((row) => row.cluster !== plan.heldCluster)
        .every((row) => row.observedReplicas === plan.heldReplicas)
      && heldRow.observedReplicas === plan.startingReplicas
      && heldRow.headRevision === heldRecord.headRevision
      && heldRow.headRevision > restore.approval.revision
      && heldRow.approvalsOnHead === 0
      ? "pass"
      : "fail";
  return {
    result,
    expected: { ...plan.expect },
    revisionsInPlay: {
      startingPoint: plan.startingReplicas,
      advance: plan.advanceReplicas,
      heldAdvance: plan.heldReplicas,
    },
    heldCluster: plan.heldCluster,
    clusters,
  };
}

// ---------------------------------------------------------------------------
// Live plumbing this chapter needs and the siblings carry.
// ---------------------------------------------------------------------------

function readUnit(context, space) {
  return cubJson(context, [
    "unit", "get", "--space", space, policyUnit, "-o", "json",
  ]).Unit;
}

// The cohort's kubeconfigs died with the chapter-three scratch tree, so this
// chapter mints fresh ones from the standing kind clusters.
function exportKubeconfigs(cohort, workRoot) {
  const kubeconfigs = {};
  const entries = [
    ["management", cohort.managementCluster],
    ...cohort.workloads.map((row) => [row.cluster, row.kindCluster]),
  ];
  for (const [key, kindCluster] of entries) {
    const path = join(workRoot, `${kindCluster}.kubeconfig`);
    command("kind", [
      "export", "kubeconfig", "--name", kindCluster, "--kubeconfig", path,
    ], { timeout: 120_000 });
    kubeconfigs[key] = path;
  }
  return kubeconfigs;
}

// An unapproved head must refuse to publish. The queued-trigger race retries
// like the publisher does; a standing refusal is the evidence. Any publish
// that succeeds here is a hard failure of the chapter's whole premise.
function probePublishRefusal(policyContext, space) {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = cubTry(policyContext, [
      "release", "publish", space, "-o", "json",
    ], { timeout: 120_000 });
    check(
      !result.ok,
      `${space} published a release while its head revision was unapproved; the approval gate did not hold`,
    );
    lastError = result.error;
    if (!pendingApplyGate(lastError)) break;
    sleep(5_000);
  }
  check(
    /applygates|apply.?gates|approval|approve|422/i.test(lastError),
    `${space} publish was refused for something other than the approval gate: ${lastError}`,
  );
  return {
    command: `cub release publish ${space}`,
    attempted: true,
    result: "refused",
    gate: approvalGate,
    error: lastError,
  };
}

function approveHeadRevision(context, space, unit, stageName, expectedRevision) {
  const result = cubTry(context, [
    "unit", "approve", "--space", space, unit,
    "--revision", "HeadRevisionNum", "--wait", "--quiet",
  ]);
  if (result.ok) return;
  const current = readUnit(context, space);
  check(
    Number(current.HeadRevisionNum) === Number(expectedRevision)
      && approvalCount(current.ApprovedBy) >= 1,
    `ConfigHub rejected the ${stageName} approval before recording it: ${result.error}`,
  );
  phase(`${stageName} approval recorded; waiting for delayed trigger completion`);
}

// The delivery watch is the essential half of the sibling's: the reviewed
// profile must arrive on the management cluster field for field. Convergence
// on the workload cluster is proved separately by the replica observations.
function waitForProfile({
  managementKubeconfig,
  profileName,
  expectedDoc,
  attempts = 90,
}) {
  let reason = "the profile was not observed";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const live = clusterTry(managementKubeconfig, [
      "get", "clusterprofile", profileName, "-o", "json",
    ]);
    if (live.ok) {
      if (sourceFieldsMatchLive(expectedDoc, JSON.parse(live.output))) {
        return {
          result: "pass",
          profile: profileName,
          interval: remoteFetchInterval,
          profileMatchesApprovedRevision: true,
        };
      }
      reason = `${profileName} has not matched the expected revision yet`;
    } else {
      reason = sanitizeError(live.error);
    }
    if (attempt + 1 < attempts) sleep(5_000);
  }
  return { result: "fail", profile: profileName, reason };
}

function waitForReplicas({ kubeconfig, expected, attempts }) {
  let last = { desired: null, available: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = clusterTry(kubeconfig, [
      "-n", "kyverno", "get", "deployment", backgroundDeployment, "-o", "json",
    ]);
    if (result.ok) {
      const deployment = JSON.parse(result.output);
      last = {
        desired: Number(deployment.spec?.replicas ?? 0),
        available: Number(deployment.status?.availableReplicas ?? 0),
        observedGenerationMatches:
          deployment.status?.observedGeneration === deployment.metadata?.generation,
      };
      if (
        last.desired === expected
        && last.available === expected
        && last.observedGenerationMatches
      ) {
        return { result: "pass", deployment: backgroundDeployment, ...last };
      }
    }
    if (attempt + 1 < attempts) sleep(4_000);
  }
  return {
    result: "fail",
    deployment: backgroundDeployment,
    ...last,
    reason: `expected ${expected} replicas, observed desired=${last.desired} available=${last.available}`,
  };
}

// One checkpoint observes every cluster against an explicit expectation map.
// Clusters in the converging set get the long budget; every other cluster
// gets the holding budget, and holding is exactly what that budget proves.
function recordCheckpoint({ id, phase: phaseName, cohort, kubeconfigs, expected, converging }) {
  const observations = cohort.workloads.map((row) => {
    const observation = waitForReplicas({
      kubeconfig: kubeconfigs[row.cluster],
      expected: expected[row.cluster],
      attempts: converging.has(row.cluster)
        ? convergenceWaitAttempts
        : holdingCheckAttempts,
    });
    check(
      observation.result === "pass",
      `${row.cluster} did not hold the expected state at ${phaseName}/${id}: ${observation.reason ?? "unknown"}`,
    );
    return {
      cluster: row.kindCluster,
      logicalCluster: row.cluster,
      environment: row.environment,
      expectedBackgroundReplicas: expected[row.cluster],
      observation,
    };
  });
  return { id, phase: phaseName, observations };
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

// ---------------------------------------------------------------------------
// The receipt.
// ---------------------------------------------------------------------------

function buildReceipt({
  recordedAt,
  plan,
  cohort,
  topology,
  startingPoint,
  advance,
  restore,
  heldAdvance,
  heldRecord,
  fleetAudit,
  checkpoints,
  cleanup,
}) {
  const waveRecord = (wave) => ({
    wave: wave.wave,
    environment: wave.environment,
    unlockedBy: wave.unlockedBy,
    selection: wave.selection,
    upgrade: wave.upgrade,
    approval: wave.approval,
    approvalSelection: wave.approvalSelection,
    clusters: wave.clusters,
  });
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosHeldClusterProofReceipt",
    metadata: { name: "kyverno-held-cluster" },
    spec: {
      recordedAt,
      flow: {
        path: "chapter-three cohort -> one reviewed advance on the base -> governed restore of one production cluster to its exact earlier revision -> a further reviewed advance with that cluster deliberately unapproved -> closing fleet audit",
        promotion: `two reviewed changes on the shared base, ${plan.startingReplicas} to ${plan.advanceReplicas} and then ${plan.advanceReplicas} to ${plan.heldReplicas}, each inherited wave by wave; one governed restore of ${plan.heldCluster} between them`,
        boundary: "the hold is the absence of one approval on one variant, not a new mechanism; the restore is one cluster to one exact revision, not a fleet-wide reversal",
        mapping: "ConfigHub holds one record per cluster, so which cluster stands at which of the three points is a model-level answer, read from the records rather than from a cluster",
      },
      source: {
        change: plan.source.change,
        restore: plan.source.restore,
        continuation: plan.source.continuation,
        cohortReceipt: {
          path: cohort.receiptRepoPath,
          rawSha256: cohort.receiptSha256,
        },
        selectionTemplate: {
          path: cohortChangeRepoPath,
          scope: setScope,
          whereTemplate: cohort.whereTemplate,
        },
        valuesPath: plan.valuesPath,
        advance: { before: plan.startingReplicas, after: plan.advanceReplicas },
        heldAdvance: { before: plan.advanceReplicas, after: plan.heldReplicas },
        gatewayRecord: probeRecord,
      },
      continuesCohort: {
        receipt: cohort.receiptRepoPath,
        runId: cohort.runId,
        clusters: cohort.clusters,
        spaces: {
          base: cohort.baseSpace,
          management: cohort.managementSpace,
          workloads: Object.fromEntries(
            cohort.workloads.map((row) => [row.cluster, row.space]),
          ),
        },
        createdNothing: true,
      },
      revisions: {
        base: {
          startingPointHead: Number(advance.base.revision) - 1,
          advanced: { revision: advance.base.revision, revisionId: advance.base.revisionId },
          held: { revision: heldAdvance.base.revision, revisionId: heldAdvance.base.revisionId },
        },
        clusters: Object.fromEntries(cohort.workloads.map((row) => {
          const start = startingPoint[row.cluster];
          const advanced = advance.waves.flatMap((wave) => wave.clusters)
            .find((member) => member.cluster === row.cluster);
          const held = heldAdvance.waves.flatMap((wave) => wave.clusters)
            .find((member) => member.cluster === row.cluster);
          return [row.cluster, {
            startingPoint: {
              headRevision: start.headRevision,
              revisionId: start.revisionId,
              cohortReleaseDigest: start.cohortReleaseDigest,
            },
            advanced: {
              revision: advanced.revision,
              revisionId: advanced.revisionId,
            },
            ...(row.cluster === plan.heldCluster
              ? {
                restored: {
                  revision: restore.approval.revision,
                  revisionId: restore.restoredRevisionId,
                  contentOfRevision: restore.revisionRestoredTo,
                },
                pending: {
                  revision: heldRecord.headRevision,
                  approved: false,
                },
              }
              : {
                held: {
                  revision: held.revision,
                  revisionId: held.revisionId,
                },
              }),
          }];
        })),
      },
      policy: {
        organization: expectedPolicyOrg,
        profile: "catalog-standard",
        resourceClass: "system-configuration",
        filter: topology,
        approvalGate,
        targetHost: { space: targetHost.space, worker: targetHost.worker },
      },
      advance: {
        evidenceGated: true,
        rule: "No wave's approval is requested until the preceding checkpoint shows every cluster the wave depends on reporting healthy. Each wave records the evidence that unlocked it.",
        base: {
          space: advance.base.space,
          unit: advance.base.unit,
          revision: advance.base.revision,
          revisionId: advance.base.revisionId,
          fromReplicas: advance.base.fromReplicas,
          toReplicas: advance.base.toReplicas,
          approved: false,
          publishedAsRelease: false,
        },
        waves: advance.waves.map(waveRecord),
      },
      restore: {
        cluster: restore.cluster,
        twin: restore.twin,
        space: restore.space,
        unit: restore.unit,
        command: restore.command,
        revisionRestoredTo: restore.revisionRestoredTo,
        restoredRevisionId: restore.restoredRevisionId,
        headRevisionAfterRestore: restore.headRevisionAfterRestore,
        restoredContentMatchesStartingPoint: restore.restoredContentMatchesStartingPoint,
        gateEvidence: restore.gateEvidence,
        approval: restore.approval,
        release: restore.release,
        delivery: restore.delivery,
        perCluster: restore.perCluster,
      },
      heldAdvance: {
        base: {
          space: heldAdvance.base.space,
          unit: heldAdvance.base.unit,
          revision: heldAdvance.base.revision,
          revisionId: heldAdvance.base.revisionId,
          fromReplicas: heldAdvance.base.fromReplicas,
          toReplicas: heldAdvance.base.toReplicas,
          approved: false,
          publishedAsRelease: false,
        },
        waves: heldAdvance.waves.map(waveRecord),
        approvedClusters: heldAdvance.waves
          .flatMap((wave) => wave.clusters)
          .map((member) => member.cluster),
        heldCluster: plan.heldCluster,
        heldRecord: {
          cluster: heldRecord.cluster,
          space: heldRecord.space,
          headRevision: heldRecord.headRevision,
          pendingRevisionCreated: heldRecord.pendingRevisionCreated,
          pendingValues: heldRecord.pendingValues,
          upstreamChangeApplied: heldRecord.upstreamChangeApplied,
          approvedRevision: heldRecord.approvedRevision,
          releasedManifestDigest: heldRecord.releasedManifestDigest,
          observation: heldRecord.observation,
          profileStillRestored: heldRecord.profileStillRestored,
        },
        gateState: heldRecord.gateState,
      },
      fleetAudit,
      checkpoints,
      cleanup,
      limits: [
        "This chapter created no clusters and no Spaces. It continued the chapter-three cohort and left it standing.",
        "The restore moved one cluster to one exact earlier revision through the same approval gate as every advance. It is not a single action that halts and reverses a rollout across the fleet.",
        "The hold is the absence of one approval on one variant's pending head revision. No new mechanism was added to hold it.",
        "The pending head's merged content is recorded as observed, not asserted, because a local change to the same field a base change writes wins the merge silently in the recorded ConfigHub finding.",
        "The held cluster's released tag was not re-read from the registry; the evidence is the recorded publish, the unapproved gate on the pending head, the live profile still matching the restored revision, and the cluster's observed state.",
        "The reviewed ClusterProfiles were delivered through ConfigHub and its OCI gateway by the cohort's standing wiring. This chapter installed nothing on any cluster.",
        "The proof used the cohort's four local kind workload clusters. It does not prove a large production fleet.",
      ],
    },
    status: {
      result: "pass",
      claim: `ConfigHub restored one production cluster, ${plan.heldCluster}, to its exact pre-advance revision through the same approval gate that governed every advance, with the publish refused while the restored head was unapproved, while its twin ${plan.twin} stayed on the newer release. A further reviewed advance then moved pilot, staging, and ${plan.twin} to ${plan.heldReplicas} replicas while ${plan.heldCluster} was deliberately held by not approving its pending revision. The closing audit shows the fleet at three different points on purpose, every one of them a recorded fact: three clusters advanced, one held at the restored revision with its approval deliberately absent.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Receipt invariants, shared by --verify, --generate, and the self-test.
// ---------------------------------------------------------------------------

// Returns true when the receipt holds, false when the receipt is recognized
// as recorded against a cohort that has since been re-recorded, and throws
// on anything genuinely inconsistent.
function assertReceiptInvariants(receipt, root) {
  check(
    receipt.kind === "SveltosHeldClusterProofReceipt",
    "Sveltos held-cluster receipt kind changed",
  );
  check(receipt.status?.result === "pass", "Sveltos held-cluster proof is not pass");
  const plan = loadPlan(root);
  const cohort = loadCohort(root);
  const continues = receipt.spec?.continuesCohort ?? {};
  // Chapter three re-records into a fresh cohort. A held-cluster receipt
  // recorded against an earlier cohort is kept as recorded, not failed
  // against a fleet it never ran on.
  if (continues.runId !== cohort.runId) {
    console.log(
      `the recorded receipt continues cohort ${continues.runId ?? "(missing)"} and chapter three has since recorded cohort ${cohort.runId}; the receipt is kept as recorded and awaits a live re-record`,
    );
    return false;
  }
  check(
    continues.receipt === cohort.receiptRepoPath
      && continues.createdNothing === true,
    "the receipt does not continue the committed chapter-three cohort",
  );
  check(
    sameSet(continues.clusters ?? [], cohort.clusters),
    "the receipt cohort clusters no longer match the chapter-three receipt",
  );
  check(
    continues.spaces?.base === cohort.baseSpace
      && cohort.workloads.every(
        (row) => continues.spaces?.workloads?.[row.cluster] === row.space,
      ),
    "the receipt cohort Spaces no longer match the chapter-three receipt",
  );
  const source = receipt.spec?.source ?? {};
  check(
    source.change?.path === plan.source.change.path
      && source.change.rawSha256 === plan.source.change.rawSha256
      && source.restore?.rawSha256 === plan.source.restore.rawSha256
      && source.continuation?.rawSha256 === plan.source.continuation.rawSha256,
    "the reviewed held-cluster source records changed; record a live run before regenerating",
  );
  check(
    source.valuesPath === plan.valuesPath
      && source.advance?.before === plan.startingReplicas
      && source.advance?.after === plan.advanceReplicas
      && source.heldAdvance?.before === plan.advanceReplicas
      && source.heldAdvance?.after === plan.heldReplicas,
    "the receipt's reviewed change record changed",
  );
  check(
    receipt.spec?.policy?.organization === expectedPolicyOrg
      && receipt.spec.policy.approvalGate === approvalGate
      && sameSet(receipt.spec.policy.filter?.triggerRefs ?? [], expectedTriggers),
    "the receipt policy record changed",
  );
  const restore = receipt.spec?.restore ?? {};
  const startingHead = receipt.spec?.revisions?.clusters?.[plan.heldCluster]
    ?.startingPoint?.headRevision;
  check(
    restore.cluster === plan.heldCluster
      && restore.twin === plan.twin
      && Number(restore.revisionRestoredTo) === Number(startingHead)
      && restore.restoredContentMatchesStartingPoint === true
      && String(restore.command ?? "").includes(`--restore ${restore.revisionRestoredTo}`),
    "the restore must target the exact pre-advance revision the starting point recorded",
  );
  check(
    restore.gateEvidence?.beforeApproval?.result === "blocked"
      && restore.gateEvidence.beforeApproval.gate === approvalGate
      && restore.gateEvidence.publishRefusal?.result === "refused"
      && restore.gateEvidence.publishRefusal.attempted === true
      && restore.gateEvidence.afterApproval?.result === "allowed"
      && restore.approval?.recordedApprovals >= 1
      && restore.approval.approverIdentityRecordedInReceipt === false,
    "the restore gate evidence changed: it must show blocked, publish refused, approved, allowed, in that order",
  );
  check(
    normalizeDigest(restore.release?.manifestDigest)
      === restore.release?.manifestDigest,
    "the restore release lost its manifest digest",
  );
  check(
    restore.perCluster?.[plan.heldCluster]?.observedReplicas === plan.startingReplicas
      && restore.perCluster?.[plan.twin]?.observedReplicas === plan.advanceReplicas
      && restore.perCluster[plan.twin].state === "stayed-on-advance",
    "the restore must show the restored cluster back at the starting replicas while its twin stays on the advance",
  );
  const held = receipt.spec?.heldAdvance ?? {};
  check(
    held.heldCluster === plan.heldCluster
      && sameSet(
        held.approvedClusters ?? [],
        cohort.workloads
          .map((row) => row.cluster)
          .filter((name) => name !== plan.heldCluster),
      ),
    "the held advance must approve every cluster except the held one",
  );
  const gateState = held.gateState;
  check(
    gateState
      && gateState.gate === approvalGate
      && gateState.result === "blocked"
      && gateState.approvalAbsent === true
      && Number(gateState.pendingHeadRevision) > Number(restore.approval?.revision),
    "the held cluster's gate state must show an armed gate and no approval on a pending head revision past the restored one",
  );
  check(
    held.heldRecord?.pendingRevisionCreated === true
      && Number(held.heldRecord.headRevision)
      === Number(gateState.pendingHeadRevision)
      && held.heldRecord.releasedManifestDigest === restore.release?.manifestDigest,
    "the held record must carry the pending revision and the still-released restore digest",
  );
  const audit = receipt.spec?.fleetAudit ?? {};
  check(audit.result === "pass", "the fleet audit did not pass");
  const rows = audit.clusters ?? [];
  check(
    rows.length === 4
      && sameSet(rows.map((row) => row.cluster), cohort.workloads.map((row) => row.cluster)),
    "the fleet audit must enumerate every workload cluster exactly once",
  );
  for (const row of rows) {
    check(
      row.observation?.result === "pass"
        && row.departuresKept === true
        && normalizeDigest(row.releasedDigest) === row.releasedDigest,
      `the ${row.cluster} audit row changed`,
    );
    if (row.cluster === plan.heldCluster) {
      check(
        row.observedReplicas === plan.startingReplicas
          && row.state === "held-at-restored-revision"
          && row.pendingUpgrade === true
          && row.approvalsOnHead === 0
          && Number(row.headRevision) === Number(gateState.pendingHeadRevision)
          && row.releasedDigest === restore.release?.manifestDigest,
        "the held cluster's audit row must show it held at the restored revision with a pending unapproved upgrade",
      );
    } else {
      check(
        row.observedReplicas === plan.heldReplicas
          && row.state === "advanced"
          && row.pendingUpgrade === false,
        `${row.cluster} must be audited in the advanced state at the held-advance replicas`,
      );
    }
  }
  const checkpoints = receipt.spec?.checkpoints ?? [];
  check(
    checkpoints.filter((row) => row.phase === "advance").length >= 2
      && checkpoints.filter((row) => row.phase === "held-advance").length >= 2
      && checkpoints.every((row) => (row.observations ?? []).length === 4),
    "the checkpoint record changed",
  );
  check(
    cleanupSucceeded(receipt.spec?.cleanup),
    "Sveltos held-cluster cleanup record did not pass",
  );
  check(
    (receipt.spec?.limits ?? []).some((limit) =>
      limit.includes("absence of one approval")),
    "the limits lost the hold-is-absence-of-approval boundary",
  );
  const serialized = JSON.stringify(receipt);
  check(
    !serialized.includes("@confighub.com"),
    "Sveltos held-cluster receipt contains a user identity",
  );
  check(
    !serialized.includes("ch_") && !serialized.includes("eyJ"),
    "Sveltos held-cluster receipt contains a credential",
  );
  check(
    !/\bargo\b|\bflux\b/i.test(serialized),
    "this proof delivers through the ConfigHub OCI gateway; a receipt naming another deliverer predates that design",
  );
  return true;
}

// This chapter never removes anything, so its cleanup passes only as a kept
// record that names every inherited artifact and how to remove it.
function cleanupSucceeded(cleanup) {
  const results = Object.values(cleanup?.results ?? {});
  return cleanup?.mode === "kept"
    && cleanup.keptDeliberately === true
    && results.length > 0
    && results.every((value) => value === "pass" || value === "kept")
    && (cleanup.kept ?? []).length > 0
    && cleanup.kept.every((row) =>
      typeof row.kind === "string"
      && typeof row.name === "string"
      && /^(kind delete cluster|cub space delete) /.test(String(row.removeWith ?? "")));
}

// ---------------------------------------------------------------------------
// The summary.
// ---------------------------------------------------------------------------

function renderSummary(receipt) {
  const spec = receipt.spec;
  const audit = spec.fleetAudit;
  const restore = spec.restore;
  const held = spec.heldAdvance;
  const rows = audit.clusters.map((row) =>
    `| ${row.cluster} | ${row.environment} | ${row.headRevision} | \`${row.releasedDigest}\` | ${row.observedReplicas} | ${row.state} |`);
  return `# ConfigHub holds one cluster back on purpose

This run continues the recorded chapter-three fleet: the same five clusters,
the same Spaces, the same records. It creates nothing. One reviewed change
advances every cluster from ${spec.source.advance.before} to
${spec.source.advance.after} background replicas. Then one production
cluster, ${restore.cluster}, is restored to its exact pre-advance revision
with \`${restore.command}\`. The approval gate arms on the restored head like
on any other revision, the publish is refused while it is unapproved, and
only the recorded approval lets the older digest ship again. Its twin,
${restore.twin}, stays on the newer release the whole time.

A second reviewed change then moves the fleet to
${spec.source.heldAdvance.after} replicas. The restored cluster's variant
rides the same set upgrade and is then simply not approved. The hold is the
absence of that one approval, nothing more. Sveltos keeps serving the
restored release, the gate stays armed on the pending head, and the cluster
stays where the operator put it.

The closing audit shows the fleet at three different points on purpose,
every one a recorded fact:

| Cluster | Environment | Head revision | Released digest | Background replicas | State |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

Gate evidence on the restore:

- Before approval the restored head carried the armed \`${restore.gateEvidence.beforeApproval.gate}\` gate with no approval.
- \`${restore.gateEvidence.publishRefusal.command}\` was refused while unapproved.
- After one recorded approval the publish went through, and Sveltos pulled the older digest.

Gate evidence on the hold:

- ${held.heldCluster} carries pending head revision ${held.gateState.pendingHeadRevision} with the \`${held.gateState.gate}\` gate armed and no approval on it.
- The released tag still names the restored revision's digest \`${held.heldRecord.releasedManifestDigest}\`.
- The cluster was observed holding at ${audit.expected[held.heldCluster]} replicas after the rest of the fleet moved to ${spec.source.heldAdvance.after}.

## Limits

${spec.limits.map((limit) => `- ${limit}`).join("\n")}

- [Committed receipt](../../runs/sveltos-held-cluster-proof/receipt.yaml)
- [Reviewed change candidate](../../${spec.source.change.path})
- [Reviewed restore candidate](../../${spec.source.restore.path})
- [The cohort this run continues](../../${spec.continuesCohort.receipt})
`;
}

// ---------------------------------------------------------------------------
// The offline self-test.
// ---------------------------------------------------------------------------

function selfTest() {
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-held-self-test-"));
  try {
    const fixtureRoot = join(workRoot, "repo");
    writeCohortFixture(fixtureRoot);
    const plan = loadPlan(fixtureRoot);
    check(
      plan.valuesPath === "backgroundController.replicas"
        && plan.startingReplicas + 1 === plan.advanceReplicas
        && plan.advanceReplicas + 1 === plan.heldReplicas
        && plan.heldCluster === "hx-sveltos-env-prod-a"
        && plan.twin === "hx-sveltos-env-prod-b"
        && Number(plan.expect[plan.heldCluster]) === plan.startingReplicas
        && Number(plan.expect[plan.twin]) === plan.heldReplicas,
      "the reviewed plan lost its two-advances-around-a-hold shape",
    );
    const cohort = loadCohort(fixtureRoot);
    check(
      cohort.runId === "20260101010101"
        && cohort.baseSpace === "hx-sveltos-env-base-20260101010101"
        && cohort.workloads.length === 4
        && cohort.workloads.map((row) => row.cluster).join(",")
        === "hx-sveltos-env-pilot,hx-sveltos-env-staging,hx-sveltos-env-prod-a,hx-sveltos-env-prod-b"
        && cohort.spaces.length === 6
        && cohort.recordedOutcomeReplicas === plan.startingReplicas
        && cohort.waves.map((row) => `${row.wave}:${row.clusters.length}`).join(",")
        === "1:1,2:1,3:2",
      "the cohort loader lost the chapter-three shape",
    );
    check(
      waveQuery(cohort, "pilot").includes("'sveltos-env-rollout'")
        && waveQuery(cohort, "pilot").includes(cohort.runId)
        && clusterQuery(cohort, "prod", plan.twin)
          .endsWith(`Labels.Cluster = '${plan.twin}'`),
      "the set queries no longer select on the cohort's own labels",
    );

    // Restore-revision selection is exact or refused.
    const startingPoint = {
      [plan.heldCluster]: { headRevision: 4 },
      [plan.twin]: { headRevision: 4 },
    };
    check(
      restoreTargetRevision(startingPoint, plan.heldCluster) === 4,
      "the restore target must be the recorded pre-advance head revision",
    );
    expectFailure(
      () => restoreTargetRevision(startingPoint, "hx-sveltos-env-missing"),
      /recorded no head revision/,
      "missing starting-point refusal",
    );
    expectFailure(
      () => restoreTargetRevision(
        { [plan.heldCluster]: { headRevision: 0 } },
        plan.heldCluster,
      ),
      /not a positive revision number/,
      "zero-revision refusal",
    );

    // The values round trip and the collision guard.
    const baseDoc = fixtureProfileDoc("base", plan.startingReplicas);
    const changed = withChangedValue(baseDoc, plan.valuesPath, plan.advanceReplicas);
    check(
      readPath(valuesOf(changed), plan.valuesPath) === plan.advanceReplicas
        && readPath(valuesOf(changed), "admissionController.replicas") === 3
        && readPath(valuesOf(baseDoc), plan.valuesPath) === plan.startingReplicas,
      "withChangedValue must change one value and keep the rest",
    );
    check(
      fieldsCollide(valuesField, valuesField, baseDoc)
        && !fieldsCollide("metadata.name", valuesField, baseDoc),
      "the collision guard lost its shape",
    );

    // The receipt invariants against a good fixture and corrupted ones.
    const receipt = fixtureReceipt(plan, cohort);
    check(
      assertReceiptInvariants(receipt, fixtureRoot) === true,
      "the fixture receipt must satisfy its own invariants",
    );
    // A receipt recorded against a superseded cohort is recognized, not failed.
    const superseded = structuredClone(receipt);
    superseded.spec.continuesCohort.runId = "20250101010101";
    check(
      assertReceiptInvariants(superseded, fixtureRoot) === false,
      "a receipt continuing a superseded cohort must be recognized rather than failed",
    );
    const corruptions = [
      [/held at the restored revision/, (clone) => {
        clone.spec.fleetAudit.clusters
          .find((row) => row.cluster === plan.heldCluster)
          .observedReplicas = plan.advanceReplicas;
      }],
      [/gate state must show an armed gate/, (clone) => {
        delete clone.spec.heldAdvance.gateState;
      }],
      [/exact pre-advance revision/, (clone) => {
        clone.spec.restore.revisionRestoredTo = 99;
        clone.spec.restore.command = clone.spec.restore.command
          .replace(/--restore \d+/, "--restore 99");
      }],
      [/advanced state at the held-advance replicas/, (clone) => {
        clone.spec.fleetAudit.clusters
          .find((row) => row.cluster === plan.twin)
          .observedReplicas = plan.advanceReplicas;
      }],
      [/publish refused/, (clone) => {
        clone.spec.restore.gateEvidence.publishRefusal.result = "allowed";
      }],
      [/approve every cluster except the held one/, (clone) => {
        clone.spec.heldAdvance.approvedClusters.push(plan.heldCluster);
      }],
    ];
    for (const [pattern, corrupt] of corruptions) {
      const clone = structuredClone(receipt);
      corrupt(clone);
      expectFailure(
        () => assertReceiptInvariants(clone, fixtureRoot),
        pattern,
        `receipt corruption ${pattern}`,
      );
    }

    // The summary renders deterministically from the receipt alone.
    const summary = renderSummary(receipt);
    check(
      summary === renderSummary(structuredClone(receipt))
        && summary.includes(plan.heldCluster)
        && summary.includes("held-at-restored-revision")
        && summary.includes(receipt.spec.restore.release.manifestDigest)
        && summary.includes("absence of that one approval"),
      "the summary generator lost the held-cluster story",
    );
    const summaryFile = join(workRoot, "summary.md");
    writeFileSync(summaryFile, summary);
    check(
      readFileSync(summaryFile, "utf8") === renderSummary(receipt),
      "the summary staleness comparison must hold for a fresh render",
    );

    // The cleanup record accepts only the kept shape this chapter writes.
    check(
      cleanupSucceeded(receipt.spec.cleanup)
        && !cleanupSucceeded({ ...receipt.spec.cleanup, mode: "removed" })
        && !cleanupSucceeded({ ...receipt.spec.cleanup, kept: [] }),
      "the cleanup record acceptance lost its shape",
    );

    console.log("Sveltos held-cluster self-test passed (offline pure logic; the live lane and its fake hub are the next increment)");
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function fixtureValuesText(replicas) {
  return `admissionController:\n  replicas: 3\nbackgroundController:\n  replicas: ${replicas}\n`;
}

function fixtureProfileDoc(cluster, replicas) {
  return {
    apiVersion: "config.projectsveltos.io/v1beta1",
    kind: "ClusterProfile",
    metadata: { name: `kyverno-${cluster}` },
    spec: {
      clusterRefs: cluster === "base" ? [] : [{
        apiVersion: "lib.projectsveltos.io/v1beta1",
        kind: "SveltosCluster",
        name: cluster,
        namespace: registrationNamespace,
      }],
      syncMode: "ContinuousWithDriftDetection",
      helmCharts: [{
        chartName: "kyverno/kyverno",
        chartVersion: "3.8.1",
        values: fixtureValuesText(replicas),
      }],
    },
  };
}

function fixtureDigest(seed) {
  return `sha256:${sha256(seed).slice(0, 64)}`;
}

// A minimal chapter-three receipt carrying exactly the fields the cohort
// loader reads, written into a fixture repo layout alongside copies of the
// committed reviewed records this chapter runs from.
function writeCohortFixture(root) {
  const runId = "20260101010101";
  const clusters = [
    ["hx-sveltos-env-pilot", "pilot", 1],
    ["hx-sveltos-env-staging", "staging", 2],
    ["hx-sveltos-env-prod-a", "prod", 3],
    ["hx-sveltos-env-prod-b", "prod", 3],
  ];
  const variants = clusters.map(([cluster, environment, wave]) => ({
    cluster,
    role: "workload",
    environment,
    wave,
    space: `${cluster}-${runId}`,
    gatewayReference: `oci://${configHubOciHost}/space/${cluster}-${runId}:${releaseTag}`,
    unit: policyUnit,
    profile: `kyverno-${cluster}`,
    departures: {
      "metadata.name": `kyverno-${cluster}`,
      "spec.clusterRefs": [{
        apiVersion: "lib.projectsveltos.io/v1beta1",
        kind: "SveltosCluster",
        name: cluster,
        namespace: registrationNamespace,
      }],
      "spec.stopMatchingBehavior": "WithdrawPolicies",
    },
    departedFields: ["metadata.name", "spec.clusterRefs", "spec.stopMatchingBehavior"],
    records: [{
      stage: "changed",
      release: { manifestDigest: fixtureDigest(`cohort-${cluster}`) },
    }],
  }));
  const receipt = {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosEnvRolloutProofReceipt",
    metadata: { name: "kyverno-environment-rollout" },
    spec: {
      base: { space: `hx-sveltos-env-base-${runId}` },
      prerequisite: { addonControllerImage: expectedAddonControllerImage },
      variants: [
        ...variants,
        { cluster: "hx-sveltos-envmgmt", role: "management", space: `hx-sveltos-env-mgmt-${runId}` },
      ],
      fleet: {
        managementCluster: `hx-sveltos-envmgmt-${runId}`,
        registrations: clusters.map(([cluster, environment]) => ({
          cluster,
          kindCluster: `${cluster}-${runId}`,
          labels: { environment },
        })),
      },
      convergenceAudit: { expectedBackgroundReplicas: 2 },
      cleanup: { mode: "kept", keptDeliberately: true },
    },
    status: { result: "pass" },
  };
  const receiptFile = join(root, cohortReceiptRepoPath);
  mkdirSync(dirname(receiptFile), { recursive: true });
  writeYaml(receiptFile, receipt);
  const changeFile = join(root, cohortChangeRepoPath);
  mkdirSync(dirname(changeFile), { recursive: true });
  writeYaml(changeFile, {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosEnvRolloutChange",
    metadata: { name: "kyverno-background-controller-replicas" },
    spec: {
      selection: {
        scope: setScope,
        whereTemplate:
          "Labels.Proof = 'sveltos-env-rollout' AND Labels.Run = '{run}' AND Labels.Environment = '{environment}'",
      },
    },
  });
  // The reviewed held-cluster records are the committed ones, copied so the
  // fixture plan is exactly the plan the live lane runs from.
  for (const path of [
    changeCandidateRepoPath,
    restoreCandidateRepoPath,
    continuationRepoPath,
  ]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(repoRoot, path), "utf8"));
  }
}

// A consistent chapter-six receipt built from the fixture cohort, so the
// invariants and the summary are tested against the shape the live run emits.
function fixtureReceipt(plan, cohort) {
  const startingHead = 4;
  const gateBlocked = {
    result: "blocked",
    gate: approvalGate,
    observation: "apply-gate-present-approval-absent",
    dryRun: false,
    exitCode: 0,
  };
  const gateAllowed = {
    result: "allowed",
    observation: "approval-recorded",
    dryRun: false,
    exitCode: 0,
  };
  const observationPass = (replicas) => ({
    result: "pass",
    deployment: backgroundDeployment,
    desired: replicas,
    available: replicas,
    observedGenerationMatches: true,
  });
  const memberRecord = (row, revision, seed) => ({
    cluster: row.cluster,
    space: row.space,
    revision,
    revisionId: `${seed}-${sha256(row.cluster + seed).slice(0, 12)}`,
    recordedApprovals: 1,
    releaseManifestDigest: fixtureDigest(`${seed}-${row.cluster}`),
    inheritedFields: [valuesField],
    departedFields: row.departurePaths,
    beforeApproval: gateBlocked,
    afterApproval: gateAllowed,
    release: {
      space: row.space,
      reference: row.gatewayReference,
      tag: releaseTag,
      manifestDigest: fixtureDigest(`${seed}-${row.cluster}`),
      bundleDigest: fixtureDigest(`${seed}-bundle-${row.cluster}`),
      releaseId: "00000000-0000-0000-0000-000000000000",
    },
    delivery: {
      result: "pass",
      profile: row.profile,
      interval: remoteFetchInterval,
      profileMatchesApprovedRevision: true,
    },
  });
  const waveRecords = (seed, revision, heldClusters) => cohort.waves.map((wave) => {
    const members = wave.clusters
      .map((name) => cohort.workloads.find((row) => row.cluster === name))
      .filter((row) => !heldClusters.includes(row.cluster));
    return {
      wave: wave.wave,
      environment: wave.environment,
      unlockedBy: {
        precedingCheckpointId: wave.wave === 1 ? "baseline" : `after-wave-${wave.wave - 1}`,
        environment: wave.wave === 1 ? "baseline" : cohort.waves[wave.wave - 2].environment,
        clusters: [],
        approvalFollowedEvidence: true,
      },
      selection: {
        scope: setScope,
        query: waveQuery(cohort, wave.environment),
        matched: wave.clusters.map((name) =>
          `${cohort.workloads.find((row) => row.cluster === name).space}/${policyUnit}`),
      },
      upgrade: {
        command: 'cub unit update --patch --space "*" --where <query> --upgrade',
        appliedAsOneOperation: true,
        members: wave.clusters.length,
        heldMembers: wave.clusters.length - members.length,
      },
      approval: {
        command: 'cub unit approve --space "*" --where <query> --revision HeadRevisionNum',
        appliedAsOneOperation: true,
        members: members.length,
        recordedApprovals: members.length,
      },
      approvalSelection: {
        scope: setScope,
        query: waveQuery(cohort, wave.environment),
        matched: members.map((row) => `${row.space}/${policyUnit}`),
      },
      clusters: members.map((row) => memberRecord(row, revision, seed)),
    };
  });
  const checkpoint = (id, phaseName, expected) => ({
    id,
    phase: phaseName,
    observations: cohort.workloads.map((row) => ({
      cluster: row.kindCluster,
      logicalCluster: row.cluster,
      environment: row.environment,
      expectedBackgroundReplicas: expected[row.cluster],
      observation: observationPass(expected[row.cluster]),
    })),
  });
  const restoreDigest = fixtureDigest("restore-held");
  const heldSpace = `${plan.heldCluster}-${cohort.runId}`;
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosHeldClusterProofReceipt",
    metadata: { name: "kyverno-held-cluster" },
    spec: {
      recordedAt: "2026-01-02T00:00:00.000Z",
      flow: { path: "fixture", promotion: "fixture", boundary: "fixture", mapping: "fixture" },
      source: {
        change: plan.source.change,
        restore: plan.source.restore,
        continuation: plan.source.continuation,
        cohortReceipt: { path: cohort.receiptRepoPath, rawSha256: cohort.receiptSha256 },
        selectionTemplate: {
          path: cohortChangeRepoPath,
          scope: setScope,
          whereTemplate: cohort.whereTemplate,
        },
        valuesPath: plan.valuesPath,
        advance: { before: plan.startingReplicas, after: plan.advanceReplicas },
        heldAdvance: { before: plan.advanceReplicas, after: plan.heldReplicas },
        gatewayRecord: probeRecord,
      },
      continuesCohort: {
        receipt: cohort.receiptRepoPath,
        runId: cohort.runId,
        clusters: cohort.clusters,
        spaces: {
          base: cohort.baseSpace,
          management: cohort.managementSpace,
          workloads: Object.fromEntries(
            cohort.workloads.map((row) => [row.cluster, row.space]),
          ),
        },
        createdNothing: true,
      },
      revisions: {
        base: {
          startingPointHead: 3,
          advanced: { revision: 4, revisionId: "a2b-fixture" },
          held: { revision: 5, revisionId: "h3b-fixture" },
        },
        clusters: Object.fromEntries(cohort.workloads.map((row) => [row.cluster, {
          startingPoint: {
            headRevision: startingHead,
            revisionId: "s1-fixture",
            cohortReleaseDigest: row.cohortReleaseDigest,
          },
          advanced: { revision: startingHead + 1, revisionId: "a2-fixture" },
          ...(row.cluster === plan.heldCluster
            ? {
              restored: {
                revision: startingHead + 2,
                revisionId: "s1-fixture",
                contentOfRevision: startingHead,
              },
              pending: { revision: startingHead + 3, approved: false },
            }
            : { held: { revision: startingHead + 2, revisionId: "h3-fixture" } }),
        }])),
      },
      policy: {
        organization: expectedPolicyOrg,
        profile: "catalog-standard",
        resourceClass: "system-configuration",
        filter: {
          ref: approvalFilterRef,
          id: "fixture",
          hash: "fixture",
          triggerRefs: expectedTriggers,
          triggerIds: [],
        },
        approvalGate,
        targetHost: { space: targetHost.space, worker: targetHost.worker },
      },
      advance: {
        evidenceGated: true,
        rule: "fixture",
        base: {
          space: cohort.baseSpace,
          unit: policyUnit,
          revision: 4,
          revisionId: "a2b-fixture",
          fromReplicas: plan.startingReplicas,
          toReplicas: plan.advanceReplicas,
          approved: false,
          publishedAsRelease: false,
        },
        waves: waveRecords("a2", startingHead + 1, []),
      },
      restore: {
        cluster: plan.heldCluster,
        twin: plan.twin,
        space: heldSpace,
        unit: policyUnit,
        command: `cub unit update --space ${heldSpace} ${policyUnit} --restore ${startingHead}`,
        revisionRestoredTo: startingHead,
        restoredRevisionId: "s1-fixture",
        headRevisionAfterRestore: startingHead + 2,
        restoredContentMatchesStartingPoint: true,
        gateEvidence: {
          beforeApproval: gateBlocked,
          publishRefusal: {
            command: `cub release publish ${heldSpace}`,
            attempted: true,
            result: "refused",
            gate: approvalGate,
            error: "publish refused: outstanding ApplyGates on the head revision",
          },
          afterApproval: gateAllowed,
        },
        approval: {
          revision: startingHead + 2,
          recordedApprovals: 1,
          approverIdentityRecordedInReceipt: false,
          contentHashUnchanged: true,
        },
        release: {
          space: heldSpace,
          reference: `oci://${configHubOciHost}/space/${heldSpace}:${releaseTag}`,
          tag: releaseTag,
          manifestDigest: restoreDigest,
          bundleDigest: fixtureDigest("restore-bundle"),
          releaseId: "00000000-0000-0000-0000-000000000001",
        },
        delivery: {
          result: "pass",
          profile: `kyverno-${plan.heldCluster}`,
          interval: remoteFetchInterval,
          profileMatchesApprovedRevision: true,
        },
        perCluster: {
          [plan.heldCluster]: {
            observedReplicas: plan.startingReplicas,
            observation: observationPass(plan.startingReplicas),
            state: "restored",
          },
          [plan.twin]: {
            observedReplicas: plan.advanceReplicas,
            observation: observationPass(plan.advanceReplicas),
            headRevision: startingHead + 1,
            state: "stayed-on-advance",
          },
        },
      },
      heldAdvance: {
        base: {
          space: cohort.baseSpace,
          unit: policyUnit,
          revision: 5,
          revisionId: "h3b-fixture",
          fromReplicas: plan.advanceReplicas,
          toReplicas: plan.heldReplicas,
          approved: false,
          publishedAsRelease: false,
        },
        waves: waveRecords("h3", startingHead + 2, [plan.heldCluster]),
        approvedClusters: cohort.workloads
          .map((row) => row.cluster)
          .filter((name) => name !== plan.heldCluster),
        heldCluster: plan.heldCluster,
        heldRecord: {
          cluster: plan.heldCluster,
          space: heldSpace,
          headRevision: startingHead + 3,
          pendingRevisionCreated: true,
          pendingValues: plan.startingReplicas,
          upstreamChangeApplied: false,
          approvedRevision: startingHead + 2,
          releasedManifestDigest: restoreDigest,
          observation: observationPass(plan.startingReplicas),
          profileStillRestored: {
            result: "pass",
            profile: `kyverno-${plan.heldCluster}`,
            interval: remoteFetchInterval,
            profileMatchesApprovedRevision: true,
          },
        },
        gateState: {
          gate: approvalGate,
          result: "blocked",
          observation: "apply-gate-present-approval-absent",
          approvalAbsent: true,
          pendingHeadRevision: startingHead + 3,
        },
      },
      fleetAudit: {
        result: "pass",
        expected: { ...plan.expect },
        revisionsInPlay: {
          startingPoint: plan.startingReplicas,
          advance: plan.advanceReplicas,
          heldAdvance: plan.heldReplicas,
        },
        heldCluster: plan.heldCluster,
        clusters: cohort.workloads.map((row) => {
          const held = row.cluster === plan.heldCluster;
          return {
            cluster: row.cluster,
            environment: row.environment,
            space: row.space,
            headRevision: held ? startingHead + 3 : startingHead + 2,
            approvedRevision: startingHead + 2,
            approvalsOnHead: held ? 0 : 1,
            gateKeysOnHead: [approvalGate],
            releasedDigest: held ? restoreDigest : fixtureDigest(`h3-${row.cluster}`),
            expectedReplicas: held ? plan.startingReplicas : plan.heldReplicas,
            observedReplicas: held ? plan.startingReplicas : plan.heldReplicas,
            observation: observationPass(held ? plan.startingReplicas : plan.heldReplicas),
            departuresKept: true,
            pendingUpgrade: held,
            state: held ? "held-at-restored-revision" : "advanced",
          };
        }),
      },
      checkpoints: [
        checkpoint("baseline", "advance",
          expectationMap(cohort, () => plan.startingReplicas)),
        checkpoint("after-wave-3", "advance",
          expectationMap(cohort, () => plan.advanceReplicas)),
        checkpoint("baseline", "held-advance",
          expectationMap(cohort, (row) =>
            row.cluster === plan.heldCluster
              ? plan.startingReplicas
              : plan.advanceReplicas)),
        checkpoint("after-wave-3", "held-advance",
          expectationMap(cohort, (row) =>
            row.cluster === plan.heldCluster
              ? plan.startingReplicas
              : plan.heldReplicas)),
      ],
      cleanup: {
        mode: "kept",
        keptDeliberately: true,
        note: "fixture",
        results: { cohortClusters: "kept", cohortSpaces: "kept", localFiles: "pass" },
        kept: [
          ...cohort.clusters.map((name) => ({
            kind: "kind cluster",
            name,
            removeWith: `kind delete cluster --name ${name}`,
          })),
          ...cohort.spaces.map((space) => ({
            kind: "ConfigHub Space",
            name: space,
            removeWith: `cub space delete ${space} --recursive-force`,
          })),
        ],
      },
      limits: [
        "This chapter created no clusters and no Spaces. It continued the chapter-three cohort and left it standing.",
        "The hold is the absence of one approval on one variant's pending head revision. No new mechanism was added to hold it.",
      ],
    },
    status: {
      result: "pass",
      claim: "fixture claim: one cluster restored and held while the fleet advanced, the absence of that one approval doing the holding.",
    },
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

// ---------------------------------------------------------------------------
// Command plumbing, the same seams the siblings carry.
// ---------------------------------------------------------------------------

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

function clusterCommand(kubeconfig, args, options = {}) {
  return command("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function clusterTry(kubeconfig, args, options = {}) {
  return tryCommand("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function spacePresent(context, space) {
  return cubTry(context, ["space", "get", space, "-o", "json"]).ok;
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
  console.log(`[sveltos-held-cluster] ${message}`);
}
