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
import { homedir, tmpdir } from "node:os";
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
  node scripts/run-sveltos-bulk-ops-proof.mjs --run
  node scripts/run-sveltos-bulk-ops-proof.mjs --generate
  node scripts/run-sveltos-bulk-ops-proof.mjs --verify
  node scripts/run-sveltos-bulk-ops-proof.mjs --self-test`);
  process.exit(2);
}

const expectedPolicyOrg = "helm-catalog";
const approvalFilterRef = "platform/helm-catalog-prod-gates";
const approvalGate = "platform/require-approval/vet-approvedby";
const catalogOciTargetRef =
  "bitnami-redis-27-0-0-default-pilot-live-20260705/oci-target";
// The live lanes wait on this runner moving to the delivery path the
// rehearsal recorded, where Sveltos fetches each published wave itself.
// The approval gate attaches about a second after a Unit is created; the
// report that said otherwise was our own misreading, now withdrawn.
const pendingReason = "the runner still carries the superseded delivery path";
const policyPath = join(
  repoRoot,
  "config-catalog",
  "policies",
  "catalog-standard.yaml",
);
const expectedTriggers = readYaml(policyPath).spec.approvalRequired.checks
  .map((item) => item.trigger)
  .sort();
const configHubOciHost = "oci.hub.confighub.com:443";
const artifactType = "application/vnd.confighub.kubernetes.config.v1";
const deployableLayerType = "application/vnd.oci.image.layer.v1.tar+gzip";
const bulkRoot = join(repoRoot, "examples", "sveltos", "bulk-ops");
const changePath = join(bulkRoot, "bulk-change.yaml");
const sourceLockPath = join(
  repoRoot,
  "examples",
  "sveltos",
  "kyverno-fleet",
  "source-lock.yaml",
);
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
const portableRepository = "sveltos-kyverno-bulk-ops";
const registrationNamespace = "projectsveltos";
const backgroundDeployment = "kyverno-background-controller";
const sveltosManifestUrl =
  "https://raw.githubusercontent.com/projectsveltos/sveltos/v1.12.0/manifest/manifest.yaml";

// The self-test swaps these three seams for fake ConfigHub and OCI surfaces
// and a fake clock; every live lane uses the real defaults.
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
  verifyReceipt(receipt);
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos bulk operations proof has no live receipt yet; no live run has been recorded yet, because ${pendingReason}`,
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
  console.log("verified the Sveltos bulk operations proof");
}

function run() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  const clusterContext = process.env.SVELTOS_CLUSTER_CONTEXT?.trim() ?? "";
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_SVELTOS_BULK_OPS === "1",
    "set HELM_EXPT_ALLOW_LIVE_SVELTOS_BULK_OPS=1 to confirm this live proof",
  );
  check(
    process.env.HELM_EXPT_ALLOW_SCRATCH_ORG === "1",
    "set HELM_EXPT_ALLOW_SCRATCH_ORG=1 to confirm the temporary cluster org",
  );
  check(policyContext, "set CUB_CONTEXT to an authenticated helm-catalog context");
  check(
    clusterContext,
    "set SVELTOS_CLUSTER_CONTEXT to an authenticated scratch context",
  );
  check(
    policyContext !== clusterContext,
    "use separate maintained-policy and scratch-cluster contexts",
  );
  for (const [tool, args] of [
    ["cub", ["version"]],
    ["curl", ["--version"]],
    ["docker", ["version"]],
    ["helm", ["version"]],
    ["kind", ["version"]],
    ["kubectl", ["version", "--client"]],
    ["oras", ["version"]],
    ["tar", ["--version"]],
  ]) {
    check(tryCommand(tool, args).ok, `${tool} is required for this proof`);
  }

  const policyContextInfo = cubJson(policyContext, [
    "context", "get", policyContext, "-o", "json",
  ]);
  const clusterContextInfo = cubJson(clusterContext, [
    "context", "get", clusterContext, "-o", "json",
  ]);
  check(
    policyContextInfo.metadata?.organizationName === expectedPolicyOrg,
    `refusing to create policy evidence outside ${expectedPolicyOrg}`,
  );
  check(
    clusterContextInfo.metadata?.organizationName
      && clusterContextInfo.metadata.organizationName !== expectedPolicyOrg,
    "the temporary clusters must use a scratch organization",
  );

  const plan = loadBulkPlan();
  const sourceLock = readYaml(sourceLockPath);
  const expectedManifestSha = sourceLock.spec?.sveltos?.manifestSha256;
  check(expectedManifestSha, "the Sveltos manifest lock is missing");

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
  const managementName = `hx-sveltos-bulkmgmt-${runId}`;
  const managementSpace = `${managementName}-cluster`;
  const registryName = `hx-sveltos-bulk-registry-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-bulk-ops-"));
  const fleetClusters = plan.fleet.spec.workloads.map((workload) => ({
    cluster: `${workload.cluster}-${runId}`,
    logicalCluster: workload.cluster,
    environment: workload.environment,
    kubeconfig: join(workRoot, `${workload.cluster}.kubeconfig`),
  }));
  const spaceFor = Object.fromEntries(
    environments.map((environment) => [
      environment,
      `hx-sveltos-bulk-${environment}-${runId}`,
    ]),
  );
  const cleanup = {
    probeSpace: "pending",
    managementCluster: "not-created",
    managementSpace: "not-created",
    workloadClusters: "not-created",
    policySpaces: "not-created",
    registry: "not-created",
    localFiles: "pending",
  };
  let managementStarted = false;
  const workloadsStarted = new Set();
  const policySpacesCreated = new Set();
  let registryStarted = false;
  let receipt;

  // The approval gate is probed before any cluster or registry work, so the
  // Space whose gate never attaches costs seconds, not the
  // seven-minute fleet build.
  assertApprovalGateObservable(policyContext, runId, topology, catalogTarget);
  cleanup.probeSpace = "pass";
  phase("gate preflight passed; the approval gate is observable");

  try {
    for (const environment of environments) {
      check(
        !spacePresent(policyContext, spaceFor[environment]),
        `refusing to reuse ${spaceFor[environment]}`,
      );
    }
    check(
      !spacePresent(clusterContext, managementSpace),
      `refusing to reuse ${managementSpace}`,
    );
    for (const row of [managementName, ...fleetClusters.map((item) => item.cluster)]) {
      check(!clusterPresent(row), `refusing to reuse the kind cluster ${row}`);
    }
    check(
      !dockerContainerPresent(registryName),
      `refusing to reuse ${registryName}`,
    );

    const registry = startRegistry(registryName);
    registryStarted = true;
    cleanup.registry = "pending";
    phase("temporary OCI registry ready");

    clusterUp(clusterContext, managementName);
    managementStarted = true;
    cleanup.managementCluster = "pending";
    cleanup.managementSpace = "pending";
    phase("management cluster ready");

    for (const row of fleetClusters) {
      createWorkloadCluster(row.cluster, row.kubeconfig);
      workloadsStarted.add(row.cluster);
    }
    cleanup.workloadClusters = "pending";
    phase("four workload clusters ready");

    const sveltosInstall = installSveltos({
      managementName,
      workRoot,
      expectedManifestSha,
    });
    phase("Sveltos controllers converged");

    const registrations = fleetClusters.map((row) =>
      registerWorkload({
        managementName,
        workloadName: row.cluster,
        workloadKubeconfig: row.kubeconfig,
        workRoot,
        environment: row.environment,
      }));
    phase("four workload clusters registered by environment label");

    const environmentRecords = {};
    cleanup.policySpaces = "pending";
    for (const environment of environments) {
      environmentRecords[environment] = establishEnvironment({
        policyContext,
        clusterContext,
        managementName,
        managementSpace,
        environment,
        space: spaceFor[environment],
        plan,
        topology,
        catalogTarget,
        registry,
        workRoot,
        runId,
        policySpacesCreated,
      });
      phase(`${environment} baseline approved, published, and reconciled`);
    }

    const checkpoints = [
      recordCheckpoint({
        id: "baseline",
        changed: false,
        plan,
        fleetClusters,
        managementName,
        settled: true,
      }),
    ];
    phase("baseline checkpoint observed on all four clusters");

    // The fan-out: one pass writes the same reviewed change into every
    // environment record. Each record still enforces its own approval gate.
    const fanOut = {
      method: plan.change.spec.fanOut.method,
      approvals: plan.change.spec.fanOut.approvals,
      changeDescription:
        `Raise ${plan.change.spec.valuesPath} from ${plan.change.spec.before} to ${plan.change.spec.after} on every fleet record in one reviewed fan-out`,
      records: [],
    };
    for (const environment of environments) {
      const changedFile = join(workRoot, `clusterprofile-${environment}-changed.yaml`);
      writeDocuments(changedFile, [plan.changedDocs[environment]]);
      const update = cubTry(policyContext, [
        "unit", "update", "--space", spaceFor[environment], policyUnit,
        changedFile,
        "--change-desc", fanOut.changeDescription,
        "-o", "json",
      ]);
      if (!update.ok) {
        const current = cubJson(policyContext, [
          "unit", "get", "--space", spaceFor[environment], policyUnit, "-o", "json",
        ]).Unit;
        check(
          canonicalDocs(parseDocs(storedData(current)))
            === canonicalDocs([plan.changedDocs[environment]]),
          `ConfigHub rejected the ${environment} fan-out before storing it: ${update.error}`,
        );
      }
      fanOut.records.push({
        environment,
        space: spaceFor[environment],
        unit: policyUnit,
      });
    }
    phase("fan-out stored the same reviewed change in all three records");

    for (const environment of environments) {
      environmentRecords[environment].changed = reviewAndDeliverChange({
        policyContext,
        clusterContext,
        managementName,
        managementSpace,
        environment,
        space: spaceFor[environment],
        record: environmentRecords[environment],
        plan,
        registry,
        workRoot,
      });
      phase(`${environment} fan-out revision approved, published, and reconciled`);
    }

    checkpoints.push(recordCheckpoint({
      id: "after-fanout",
      changed: true,
      plan,
      fleetClusters,
      managementName,
      settled: false,
    }));
    phase("after-fanout checkpoint observed on all four clusters");

    const zeroDriftAudit = auditZeroDrift({
      policyContext,
      plan,
      spaceFor,
      environmentRecords,
      fleetClusters,
      managementName,
    });
    check(
      zeroDriftAudit.result === "pass",
      `the zero-drift audit did not pass: ${JSON.stringify(zeroDriftAudit.gateQuery.matches)}`,
    );
    checkpoints.push({
      id: "zero-drift-audit",
      observations: zeroDriftAudit.clusters.map((row) => ({
        cluster: row.cluster,
        logicalCluster: row.logicalCluster,
        environment: row.environment,
        expectedRevisionId: plan.revisions[row.environment].changed,
        expectedBackgroundReplicas: plan.change.spec.after,
        drift: row.drift,
        observation: row.observation,
      })),
    });
    phase("zero-drift audit passed on every record and every cluster");

    receipt = buildReceipt({
      recordedAt,
      plan,
      topology,
      catalogTarget,
      clusterOrganization: clusterContextInfo.metadata.organizationName,
      managementName,
      sveltosInstall,
      registrations,
      environmentRecords,
      fanOut,
      checkpoints,
      zeroDriftAudit,
      cleanup,
    });
  } finally {
    phase("cleaning up temporary resources");
    if (managementStarted || clusterPresent(managementName)) {
      for (const environment of environments) {
        managementTry(managementName, [
          "delete", "application",
          `sveltos-bulk-${environment}-${runId}`,
          "-n", "argocd", "--wait=false",
        ]);
      }
      clusterDown(clusterContext, managementName);
    }
    cleanup.managementCluster = clusterPresent(managementName) ? "fail" : "pass";
    cleanup.managementSpace = spacePresent(clusterContext, managementSpace)
      ? "fail"
      : "pass";

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

    for (const environment of environments) {
      const space = spaceFor[environment];
      if (policySpacesCreated.has(space) || spacePresent(policyContext, space)) {
        cubTry(policyContext, [
          "space", "delete", space, "--recursive-force", "--quiet",
        ], { timeout: 240_000 });
      }
    }
    cleanup.policySpaces = environments.some((environment) =>
      spacePresent(policyContext, spaceFor[environment]))
      ? "fail"
      : "pass";

    if (registryStarted || dockerContainerPresent(registryName)) {
      tryCommand("docker", ["rm", "-f", registryName], { timeout: 120_000 });
    }
    cleanup.registry = dockerContainerPresent(registryName) ? "fail" : "pass";

    rmSync(workRoot, { recursive: true, force: true });
    cleanup.localFiles = existsSync(workRoot) ? "fail" : "pass";
  }

  check(receipt, "the Sveltos bulk operations proof did not complete");
  check(
    Object.values(cleanup).every((value) => value === "pass"),
    `Sveltos bulk operations cleanup failed: ${JSON.stringify(cleanup)}`,
  );
  writeYaml(receiptPath, receipt);
  write(summaryPath, renderSummary(receipt));
  verifyReceipt(receipt);
  console.log(
    `wrote ${relativeRepo(receiptPath)} and ${relativeRepo(summaryPath)}`,
  );
}

// One reviewed plan drives the runner, the matrix generator, and the
// self-test: the revision identities computed here must match
// scripts/generate-sveltos-bulk-ops.mjs exactly.
function loadBulkPlan(root = repoRoot) {
  const planBulkRoot = join(root, "examples", "sveltos", "bulk-ops");
  const planRolloutRoot = join(root, "examples", "sveltos", "env-rollout");
  const planPatchRoot = join(root, "examples", "sveltos", "cve-patch");
  const fleet = readYaml(join(planRolloutRoot, "fleet.yaml"));
  const change = readYaml(join(planBulkRoot, "bulk-change.yaml"));
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
  const records = change.spec?.fanOut?.records ?? [];
  check(
    change.kind === "SveltosBulkChangeCandidate"
      && change.spec.before !== change.spec.after
      && records.map((row) => row.environment).join(",")
      === environments.join(",")
      && String(change.spec?.fanOut?.approvals ?? "")
        .includes("its own approval gate")
      && String(change.spec?.audit?.gateQuery ?? "")
        .includes("LEN(ApplyGates) > 0"),
    "the bulk change candidate lost its reviewed shape",
  );

  const profiles = {};
  for (const record of records) {
    const profilePath = join(planBulkRoot, record.profile);
    const text = readFileSync(profilePath, "utf8");
    const docs = parseDocs(text);
    check(docs.length === 1, `${record.profile} must contain one object`);
    const doc = docs[0];
    check(
      doc.kind === "ClusterProfile"
        && doc.metadata?.name === `kyverno-bulk-${record.environment}`
        && doc.spec?.clusterSelector?.matchLabels?.environment
        === record.environment
        && Object.keys(doc.spec.clusterSelector.matchLabels).length === 1,
      `${record.profile} identity or selector changed`,
    );
    check(
      doc.spec?.helmCharts?.length === 1
        && doc.spec.helmCharts[0].chartName === change.spec.chart
        && String(doc.spec.helmCharts[0].chartVersion)
        === String(change.spec.chartVersion),
      `${record.profile} chart pin changed`,
    );
    profiles[record.environment] = {
      doc,
      text,
      path: profilePath,
      repoPath: `examples/sveltos/bulk-ops/${record.profile}`,
    };
  }
  const baselineValues = profiles.pilot.doc.spec.helmCharts[0].values;
  check(
    environments.every(
      (environment) =>
        profiles[environment].doc.spec.helmCharts[0].values === baselineValues,
    ),
    "the three bulk profiles no longer share one baseline values document",
  );
  const patchProfile = readYaml(join(planPatchRoot, "clusterprofile-pilot.yaml"));
  const patchCandidate = readYaml(join(planPatchRoot, "patch-candidate.yaml"));
  check(
    String(change.spec.chartVersion)
      === String(patchCandidate.spec.to.chartVersion),
    "the bulk baseline chart version no longer matches the chapter-four outcome",
  );
  const patchValues = parseDocs(patchProfile.spec.helmCharts[0].values)[0];
  const bulkValues = parseDocs(baselineValues)[0];
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

  const revisions = {};
  const changedDocs = {};
  for (const environment of environments) {
    const baselineDoc = profiles[environment].doc;
    const changedDoc = structuredClone(baselineDoc);
    changedDoc.spec.helmCharts[0].values = changedValues;
    changedDocs[environment] = changedDoc;
    revisions[environment] = {
      baseline: `r1-${sha256(stableJson(baselineDoc)).slice(0, 12)}`,
      changed: `r2-${sha256(stableJson(changedDoc)).slice(0, 12)}`,
    };
    check(
      revisions[environment].baseline !== revisions[environment].changed,
      "the reviewed bulk change produced no new revision identity",
    );
  }
  return { fleet, change, records, profiles, changedDocs, changedValues, revisions };
}

function assertApprovalGateObservable(context, runId, topology, catalogTarget) {
  const probeSpace = `hx-sveltos-bulk-probe-${runId}`;
  check(!spacePresent(context, probeSpace), `refusing to reuse ${probeSpace}`);
  createPolicySpace(context, probeSpace);
  try {
    assertPolicySpace(context, probeSpace, topology.triggerIds, catalogTarget.TargetID);
    cub(context, [
      "unit", "create", "--space", probeSpace, policyUnit,
      join(bulkRoot, "clusterprofile-pilot.yaml"),
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
    // The probe Space has no argo-apps sibling, so a direct recursive delete
    // is safe under the ordering constraint in confighubai/confighub#4980.
    cubTry(context, [
      "space", "delete", probeSpace, "--recursive-force", "--quiet",
    ], { timeout: 240_000 });
  }
}

function establishEnvironment({
  policyContext,
  clusterContext,
  managementName,
  managementSpace,
  environment,
  space,
  plan,
  topology,
  catalogTarget,
  registry,
  workRoot,
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
    "unit", "create", "--space", space, policyUnit,
    plan.profiles[environment].path,
    "--target", catalogOciTargetRef,
    "--label", "App=sveltos-kyverno-bulk-ops",
    "--label", `Environment=${environment}`,
    "--label", `Proof=${proofLabel}`,
    "--change-desc", `Store the reviewed ${environment} ClusterProfile`,
    "--quiet",
  ]);
  const baseline = reviewHeadRevision({
    policyContext,
    space,
    environment,
    stageName: `${environment} baseline`,
    expectedDocs: [plan.profiles[environment].doc],
    revisionId: plan.revisions[environment].baseline,
    registry,
    workRoot,
    tag: `${environment}-r1`,
  });
  const application = addApplication({
    context: clusterContext,
    managementName,
    managementSpace,
    applicationName: `sveltos-bulk-${environment}-${runId}`,
    applicationUnit: `sveltos-bulk-${environment}-application`,
    policySpace: space,
    sourceReference: baseline.portableRelease.clusterReference,
    sourceRevision: baseline.portableRelease.targetRevision,
    anonymousOciHost: registry.clusterHost,
    workRoot,
  });
  const argo = waitForApplication({
    managementName,
    applicationName: application.name,
    expectedRevision: baseline.portableRelease.manifestDigest,
  });
  check(
    argo.result === "pass",
    `${application.name} did not reconcile the ${environment} baseline: ${argo.reason ?? "unknown"}`,
  );
  assertLiveProfileMatches({
    managementName,
    environment,
    expectedDoc: plan.profiles[environment].doc,
  });
  return { space, application, baseline: { ...baseline, argo } };
}

function reviewAndDeliverChange({
  policyContext,
  clusterContext,
  managementName,
  managementSpace,
  environment,
  space,
  record,
  plan,
  registry,
  workRoot,
}) {
  const changed = reviewHeadRevision({
    policyContext,
    space,
    environment,
    stageName: `${environment} fan-out`,
    expectedDocs: [plan.changedDocs[environment]],
    revisionId: plan.revisions[environment].changed,
    minimumRevision: Number(record.baseline.approval.revision) + 1,
    registry,
    workRoot,
    tag: `${environment}-r2`,
  });
  check(
    changed.portableRelease.manifestDigest
      !== record.baseline.portableRelease.manifestDigest,
    `the ${environment} fan-out did not produce a new OCI digest`,
  );
  const application = updateApplication({
    context: clusterContext,
    managementName,
    managementSpace,
    applicationName: record.application.name,
    applicationUnit: `sveltos-bulk-${environment}-application`,
    policySpace: space,
    sourceReference: changed.portableRelease.clusterReference,
    sourceRevision: changed.portableRelease.targetRevision,
    workRoot,
  });
  const argo = waitForApplication({
    managementName,
    applicationName: application.name,
    expectedRevision: changed.portableRelease.manifestDigest,
  });
  check(
    argo.result === "pass",
    `${application.name} did not reconcile the ${environment} fan-out: ${argo.reason ?? "unknown"}`,
  );
  assertLiveProfileMatches({
    managementName,
    environment,
    expectedDoc: plan.changedDocs[environment],
  });
  return { ...changed, application, argo };
}

// One approval bracket: gate armed with no approval, exact-head approval,
// gate cleared with the approval recorded, private release, portable OCI.
function reviewHeadRevision({
  policyContext,
  space,
  environment,
  stageName,
  expectedDocs,
  revisionId,
  minimumRevision,
  registry,
  workRoot,
  tag,
}) {
  const stored = waitForPolicy(policyContext, space, policyUnit, true);
  check(
    canonicalDocs(parseDocs(storedData(stored))) === canonicalDocs(expectedDocs),
    `ConfigHub stored a different ${stageName} ClusterProfile`,
  );
  if (minimumRevision !== undefined) {
    check(
      Number(stored.HeadRevisionNum) >= minimumRevision,
      `the ${stageName} did not create a new revision`,
    );
  }
  const beforeApproval = blockedDryRun(policyContext, space, policyUnit);
  approveHeadRevision(
    policyContext,
    space,
    policyUnit,
    stageName,
    stored.HeadRevisionNum,
  );
  const approved = waitForPolicy(policyContext, space, policyUnit, false);
  check(
    approved.ContentHash === stored.ContentHash,
    `approval changed the ${stageName} content`,
  );
  const recordedApprovals = approvalCount(approved.ApprovedBy);
  check(recordedApprovals >= 1, `the ${stageName} has no approval`);
  const afterApproval = allowedDryRun(policyContext, space, policyUnit);
  const privateRelease = publishRelease(policyContext, space);
  const portableRelease = publishPortableOci({
    workRoot,
    approvedText: storedData(approved),
    registryHost: registry.host,
    clusterRegistryHost: registry.clusterHost,
    tag,
  });
  return {
    revisionId,
    contentHash: stored.ContentHash,
    beforeApproval,
    approval: {
      revision: approved.HeadRevisionNum,
      recordedApprovals,
      approverIdentityRecordedInReceipt: false,
      contentHashUnchanged: true,
    },
    afterApproval,
    privateRelease,
    portableRelease,
  };
}

function assertLiveProfileMatches({ managementName, environment, expectedDoc }) {
  const live = JSON.parse(
    managementCommand(managementName, [
      "get", "clusterprofile", `kyverno-bulk-${environment}`, "-o", "json",
    ]).output,
  );
  check(
    sourceFieldsMatchLive(expectedDoc, live),
    `a field from the approved ${environment} ClusterProfile changed in the live object`,
  );
}

function recordCheckpoint({
  id,
  changed,
  plan,
  fleetClusters,
  managementName,
  settled,
}) {
  const observations = fleetClusters.map((row) => {
    const expectedBackgroundReplicas = changed
      ? plan.change.spec.after
      : plan.change.spec.before;
    const observation = observeWorkload({
      managementName,
      workloadName: row.cluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: `kyverno-bulk-${row.environment}`,
      expectedBackgroundReplicas,
      // A checkpoint right after a change earns a bounded convergence wait
      // on every cluster; a settled checkpoint must already be stable.
      attempts: settled ? 3 : 150,
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
        ? plan.revisions[row.environment].changed
        : plan.revisions[row.environment].baseline,
      expectedBackgroundReplicas,
      observation,
    };
  });
  return { id, observations };
}

// The chapter's distinctive close: a set-aware query across the Spaces must
// find no armed gates, no record may have changed since its approval, the
// stored change must be byte-identical across records, and drift injected on
// every cluster must be repaired.
function auditZeroDrift({
  policyContext,
  plan,
  spaceFor,
  environmentRecords,
  fleetClusters,
  managementName,
}) {
  const gateRows = JSON.parse(cub(policyContext, [
    "unit", "list",
    "--space", "*",
    "--where", gateQueryWhere,
    "--quiet", "-o", "json",
  ]));
  const matches = (Array.isArray(gateRows) ? gateRows : [])
    .map((row) => `${row.Unit?.SpaceSlug ?? ""}/${row.Unit?.Slug ?? ""}`);
  check(
    matches.length === 0,
    `the set-aware gate query found armed gates: ${matches.join(", ")}`,
  );

  const records = [];
  const storedValues = [];
  for (const environment of environments) {
    const current = cubJson(policyContext, [
      "unit", "get", "--space", spaceFor[environment], policyUnit, "-o", "json",
    ]).Unit;
    const approvedRecord = environmentRecords[environment].changed;
    check(
      Number(current.HeadRevisionNum)
        === Number(approvedRecord.approval.revision)
        && current.ContentHash === approvedRecord.contentHash,
      `the ${environment} record changed out of band after its approval`,
    );
    const storedDoc = parseDocs(storedData(current))[0];
    storedValues.push(storedDoc.spec.helmCharts[0].values);
    records.push({
      environment,
      space: spaceFor[environment],
      revisionUnchanged: true,
      contentUnchanged: true,
    });
  }
  check(
    storedValues.every((values) => values === storedValues[0]),
    "the stored values are not identical across the fan-out records",
  );

  const clusters = fleetClusters.map((row) => {
    const drift = runDriftRepair({
      workloadKubeconfig: row.kubeconfig,
      expectedReplicas: plan.change.spec.after,
    });
    check(
      drift.result === "pass",
      `Sveltos did not repair injected drift on ${row.cluster}: ${drift.reason ?? "unknown"}`,
    );
    const observation = observeWorkload({
      managementName,
      workloadName: row.cluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: `kyverno-bulk-${row.environment}`,
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
      scope: 'cub unit list --space "*"',
      where: gateQueryWhere,
      matches,
    },
    records,
    valuesIdenticalAcrossRecords: true,
    clusters,
  };
}

function runDriftRepair({ workloadKubeconfig, expectedReplicas }) {
  workloadCommand(workloadKubeconfig, [
    "-n", "kyverno",
    "scale", "deployment", backgroundDeployment, "--replicas=1",
  ]);
  let changed = false;
  let attempts = 0;
  for (; attempts < 180; attempts += 1) {
    const current = JSON.parse(
      workloadCommand(workloadKubeconfig, [
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
  managementName,
  workloadName,
  workloadKubeconfig,
  profileName,
  expectedBackgroundReplicas,
  attempts,
}) {
  let last = { summary: "missing", helmStatus: "missing", deployments: [] };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const summaries = managementTry(managementName, [
      "get", "clustersummaries", "-A", "-o", "json",
    ]);
    const deployments = workloadTry(workloadKubeconfig, [
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
  catalogTarget,
  clusterOrganization,
  managementName,
  sveltosInstall,
  registrations,
  environmentRecords,
  fanOut,
  checkpoints,
  zeroDriftAudit,
  cleanup,
}) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosBulkOpsProofReceipt",
    metadata: { name: "kyverno-bulk-operations" },
    spec: {
      recordedAt,
      flow: {
        path: "bulk candidate -> one fan-out over every record -> ConfigHub review per record -> local work -> OCI -> Argo CD -> Sveltos -> Kubernetes",
        promotion: "one reviewed change fanned out to every environment record in one pass, closed by a zero-drift audit",
      },
      source: {
        profiles: Object.fromEntries(environments.map((environment) => [
          environment,
          {
            path: plan.profiles[environment].repoPath,
            rawSha256: sha256(plan.profiles[environment].text),
          },
        ])),
        change: {
          path: "examples/sveltos/bulk-ops/bulk-change.yaml",
          rawSha256: sha256(readFileSync(changePath, "utf8")),
          valuesPath: plan.change.spec.valuesPath,
          before: plan.change.spec.before,
          after: plan.change.spec.after,
        },
        continuity: { baselineMatchesChapterFourOutcome: true },
        sourceLock: relativeRepo(sourceLockPath),
      },
      revisions: plan.revisions,
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
      fleet: {
        organization: clusterOrganization,
        managementCluster: managementName,
        creationCommand: "cub cluster up",
        registrations,
      },
      fanOut,
      environments: Object.fromEntries(environments.map((environment) => [
        environment,
        {
          space: environmentRecords[environment].space,
          unit: policyUnit,
          baseline: environmentRecords[environment].baseline,
          changed: environmentRecords[environment].changed,
        },
      ])),
      checkpoints,
      zeroDriftAudit,
      cleanup,
      limits: [
        "The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.",
        "The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub, OCI, and Argo CD.",
        "The portable OCI used a temporary anonymous registry; this is not a permanent public package.",
        "The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.",
        "The fan-out applied one reviewed candidate per record in one pass; each record kept its own approval gate. Approvals were not batched.",
      ],
    },
    status: {
      result: "pass",
      claim: "One reviewed change was fanned out to every environment record in one pass, each record enforced its own approval gate, every cluster converged on the changed revision, and the zero-drift audit closed the run: the set-aware gate query across the Spaces found no armed gates, no record changed out of band, the stored change was byte-identical across records, and injected drift was repaired on every cluster.",
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
  for (const environment of environments) {
    check(
      receipt.spec?.source?.profiles?.[environment]?.path
        === plan.profiles[environment].repoPath
        && receipt.spec.source.profiles[environment].rawSha256
        === sha256(plan.profiles[environment].text),
      `Sveltos bulk ops ${environment} source record changed`,
    );
    check(
      receipt.spec?.revisions?.[environment]?.baseline
        === plan.revisions[environment].baseline
        && receipt.spec.revisions[environment].changed
        === plan.revisions[environment].changed,
      "the receipt revisions no longer match the reviewed example files",
    );
  }
  check(
    receipt.spec?.source?.change?.rawSha256
      === sha256(readFileSync(changePath, "utf8"))
      && receipt.spec.source.change.valuesPath === plan.change.spec.valuesPath
      && receipt.spec.source.change.before === plan.change.spec.before
      && receipt.spec.source.change.after === plan.change.spec.after,
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
  const sourceLock = readYaml(sourceLockPath);
  check(
    receipt.spec?.prerequisite?.version === "v1.12.0"
      && receipt.spec.prerequisite.manifestSha256
      === sourceLock.spec.sveltos.manifestSha256,
    "Sveltos bulk ops prerequisite record changed",
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
        registration.labels?.environment === "prod").length === 2
      && ["pilot", "staging"].every((environment) =>
        registrations.filter((registration) =>
          registration.labels?.environment === environment).length === 1),
    "Sveltos bulk ops registration record changed",
  );
  const fanOut = receipt.spec?.fanOut;
  check(
    String(fanOut?.method ?? "").includes("one pass")
      && String(fanOut?.approvals ?? "").includes("its own approval gate")
      && (fanOut?.records ?? []).map((row) => row.environment).join(",")
      === environments.join(","),
    "Sveltos bulk ops fan-out record changed",
  );
  for (const environment of environments) {
    const record = receipt.spec?.environments?.[environment];
    for (const [stage, review] of [
      ["baseline", record?.baseline],
      ["changed", record?.changed],
    ]) {
      check(
        review?.beforeApproval?.result === "blocked"
          && review.beforeApproval.gate === approvalGate
          && review.afterApproval?.result === "allowed"
          && review.approval?.recordedApprovals >= 1
          && review.approval.approverIdentityRecordedInReceipt === false
          && review.approval.contentHashUnchanged === true,
        `Sveltos bulk ops ${environment} ${stage} approval record changed`,
      );
      check(
        normalizeDigest(review.privateRelease?.manifestDigest)
          === review.privateRelease.manifestDigest
          && review.portableRelease?.objectsMatchApprovedData === true
          && review.portableRelease.anonymousPull === true
          && review.portableRelease.registryLifetime === "temporary"
          && review.portableRelease.targetRevision
          === `${environment}-${stage === "baseline" ? "r1" : "r2"}`,
        `Sveltos bulk ops ${environment} ${stage} OCI record changed`,
      );
      check(
        review.argo?.result === "pass"
          && review.argo.sync === "Synced"
          && review.argo.health === "Healthy"
          && review.argo.revision === review.portableRelease.manifestDigest,
        `Sveltos bulk ops ${environment} ${stage} Argo record changed`,
      );
    }
    check(
      record.baseline.revisionId === plan.revisions[environment].baseline
        && record.changed.revisionId === plan.revisions[environment].changed
        && record.baseline.portableRelease.manifestDigest
        !== record.changed.portableRelease.manifestDigest
        && Number(record.changed.approval.revision)
        > Number(record.baseline.approval.revision),
      `Sveltos bulk ops ${environment} revision record changed`,
    );
  }
  const checkpoints = receipt.spec?.checkpoints ?? [];
  check(
    checkpoints.map((checkpoint) => checkpoint.id).join(",")
      === "baseline,after-fanout,zero-drift-audit",
    "Sveltos bulk ops checkpoint set changed",
  );
  for (const checkpoint of checkpoints) {
    check(
      checkpoint.observations?.length === 4
        && new Set(checkpoint.observations.map((row) => row.cluster)).size === 4,
      `Sveltos bulk ops ${checkpoint.id} observation set changed`,
    );
    const changed = checkpoint.id !== "baseline";
    for (const row of checkpoint.observations) {
      const expectedRevision = changed
        ? plan.revisions[row.environment].changed
        : plan.revisions[row.environment].baseline;
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
      && audit.gateQuery.matches.length === 0
      && (audit.records ?? []).length === 3
      && audit.records.every(
        (row) => row.revisionUnchanged === true && row.contentUnchanged === true,
      )
      && audit.valuesIdenticalAcrossRecords === true
      && audit.clusters?.length === 4
      && audit.clusters.every(
        (row) => row.drift?.result === "pass" && row.observation?.result === "pass",
      ),
    "Sveltos bulk ops zero-drift audit changed",
  );
  check(
    Object.values(receipt.spec?.cleanup ?? {}).every(
      (result) => result === "pass",
    ),
    "Sveltos bulk ops cleanup did not pass",
  );
  const serialized = JSON.stringify(receipt);
  check(
    !serialized.includes("@confighub.com"),
    "Sveltos bulk ops receipt contains a user identity",
  );
  check(
    !serialized.includes("ch_"),
    "Sveltos bulk ops receipt contains a credential",
  );
}

function renderSummary(receipt) {
  const change = receipt.spec.source.change;
  const rows = environments.map((environment) => {
    const record = receipt.spec.environments[environment];
    return `| ${environment} | ${record.baseline.beforeApproval.result} and ${record.changed.beforeApproval.result} | \`${record.changed.portableRelease.manifestDigest}\` | ${record.changed.argo.sync} and ${record.changed.argo.health} |`;
  });
  const audit = receipt.spec.zeroDriftAudit;
  return `# ConfigHub changes a fleet once and proves it everywhere

This run starts with four workload clusters in three environment groups. One
reviewed edit raises \`${change.valuesPath}\` from ${change.before} to
${change.after} and fans out to every environment record in one pass. Each
record still enforces its own approval gate, and each approved revision was
published at its own OCI digest and reconciled by Argo CD and Sveltos.

The zero-drift audit closed the run. A set-aware query across the Spaces
found no armed gates, no record changed out of band after its approval, the
stored change was byte-identical across the records, and drift injected on
every cluster was repaired.

| Record | Blocked before approval | Changed OCI digest | Argo CD |
| --- | --- | --- | --- |
${rows.join("\n")}

| Check | Result |
| --- | --- |
| Fan-out records | ${receipt.spec.fanOut.records.length}/3 in one pass |
| Set-aware gate query matches | ${audit.gateQuery.matches.length} |
| Records unchanged after approval | ${audit.records.filter((row) => row.revisionUnchanged && row.contentUnchanged).length}/3 |
| Stored change identical across records | ${audit.valuesIdenticalAcrossRecords ? "yes" : "no"} |
| Drift repaired | ${audit.clusters.filter((row) => row.drift.result === "pass").length}/4 clusters |
| Cleanup | ${Object.values(receipt.spec.cleanup).every((value) => value === "pass") ? "Pass" : "Fail"} |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows every cluster at every checkpoint.

## Limits

${receipt.spec.limits.map((limit) => `- ${limit}`).join("\n")}

- [Committed receipt](../../runs/sveltos-bulk-ops-proof/receipt.yaml)
- [Reviewed bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)
`;
}

function writeDocuments(path, documents) {
  writeFileSync(
    path,
    `${documents.map((document) =>
      JSON.stringify(document, null, 2)).join("\n---\n")}\n`,
  );
}

function createPolicySpace(context, space) {
  cub(context, [
    "space", "create", space,
    "--label", "App=sveltos-kyverno-bulk-ops",
    "--label", "ApplyPolicyProfile=catalog-standard",
    "--label", `Proof=${proofLabel}`,
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

function approveHeadRevision(context, space, unit, stageName, expectedRevision) {
  const result = cubTry(context, [
    "unit", "approve", "--space", space, unit,
    "--revision", "HeadRevisionNum", "--wait", "--quiet",
  ]);
  if (result.ok) return;
  const current = cubJson(
    context,
    ["unit", "get", unit, "--space", space, "-o", "json"],
  ).Unit;
  check(
    Number(current.HeadRevisionNum) === Number(expectedRevision)
      && approvalCount(current.ApprovedBy) >= 1,
    `ConfigHub rejected the ${stageName} approval before recording it: ${result.error}`,
  );
  phase(`${stageName} approval recorded; waiting for delayed trigger completion`);
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

function publishRelease(context, space) {
  const response = cubJson(
    context,
    ["release", "publish", space, "-o", "json"],
    { timeout: 300_000 },
  );
  const release = response.Release ?? response.release ?? response;
  const manifestDigest = normalizeDigest(
    release.ManifestDigest ?? release.manifestDigest,
  );
  check(manifestDigest, `${space} release publish returned no manifest digest`);
  return {
    space,
    reference: `oci://${configHubOciHost}/space/${space}:latest`,
    manifestDigest,
    bundleDigest: normalizeDigest(release.Digest ?? release.digest),
    releaseId: String(release.ReleaseID ?? release.releaseId ?? ""),
  };
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
    /^(pilot|staging|prod)-r[12]$/.test(tag),
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
  check(manifestDigest, "portable Sveltos OCI has no manifest digest");
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
    "pulled portable OCI differs from the approved ConfigHub data",
  );
  return {
    reference: `oci://${localReference}`,
    clusterReference: `oci://${clusterRegistryHost}/${portableRepository}`,
    targetRevision: tag,
    manifestDigest,
    objectCount: 1,
    approvedDataSha256: sha256(approvedText),
    pulledDataSha256: sha256(pulledText),
    objectsMatchApprovedData: true,
    anonymousPull: true,
    registryLifetime: "temporary",
  };
}

function installSveltos({ managementName, workRoot, expectedManifestSha }) {
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
  managementCommand(managementName, ["apply", "-f", crdPath], {
    timeout: 300_000,
  });
  for (const crd of crds) {
    managementCommand(managementName, [
      "wait", "--for=condition=Established",
      `crd/${crd.metadata.name}`, "--timeout=180s",
    ], { timeout: 240_000 });
  }
  managementCommand(managementName, ["apply", "-f", resourcePath], {
    timeout: 420_000,
  });
  managementCommand(managementName, [
    "-n", registrationNamespace,
    "wait", "--for=condition=Available", "deployment", "--all",
    "--timeout=420s",
  ], { timeout: 480_000 });
  const deployments = waitForExactDeployments({
    managementName,
    namespace: registrationNamespace,
    timeoutAttempts: 120,
    pollSeconds: 3,
  });
  check(
    deployments.length > 0,
    "the Sveltos management namespace contains no deployments",
  );
  return {
    source: sveltosManifestUrl,
    version: "v1.12.0",
    manifestSha256: expectedManifestSha,
    objectCount: documents.length,
    crdCount: crds.length,
    appliedObjectCount: crds.length + resources.length,
    omittedOptionalServiceMonitorCount: serviceMonitors.length,
    deployments,
    installationMethod: "pinned manifest applied as a management-cluster prerequisite",
  };
}

function waitForExactDeployments({
  managementName,
  namespace,
  timeoutAttempts,
  pollSeconds,
}) {
  let deployments = [];
  for (let attempt = 0; attempt < timeoutAttempts; attempt += 1) {
    deployments = JSON.parse(
      managementCommand(managementName, [
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

function createWorkloadCluster(name, kubeconfigPath) {
  command("kind", [
    "create", "cluster",
    "--name", name,
    "--kubeconfig", kubeconfigPath,
    "--wait", "180s",
  ], { timeout: 420_000 });
}

function registerWorkload({
  managementName,
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
  workloadCommand(workloadKubeconfig, ["apply", "-f", serviceAccountPath]);
  const token = workloadCommand(workloadKubeconfig, [
    "-n", registrationNamespace,
    "create", "token", "sveltos-manager", "--duration=2h",
  ]).output.trim();
  check(token.length > 40, "Kubernetes returned no registration token");
  const workloadConfig = JSON.parse(
    workloadCommand(workloadKubeconfig, [
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
  managementCommand(managementName, ["apply", "-f", registrationPath]);
  const observed = waitForRegistration(managementName, workloadName);
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
      duration: "2h",
      storedInRepository: false,
      removedWithClusters: true,
    },
    ready: true,
    kubernetesVersion: observed.kubernetesVersion,
  };
}

function waitForRegistration(managementName, workloadName) {
  let reason = "SveltosCluster status is missing";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = managementTry(managementName, [
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

function addApplication({
  context,
  managementName,
  managementSpace,
  applicationName,
  applicationUnit,
  policySpace,
  sourceReference,
  sourceRevision,
  anonymousOciHost,
  workRoot,
}) {
  const targetRef = `${managementSpace}/oci`;
  const target = cubJson(context, [
    "target", "get", "--space", managementSpace, "oci", "-o", "json",
  ]).Target;
  check(target?.ProviderType === "OCI", `${targetRef} is not an OCI target`);
  const applicationPath = join(workRoot, `${applicationName}.yaml`);
  writeApplication(applicationPath, applicationName, sourceReference, sourceRevision);
  configureAnonymousOci(managementName, anonymousOciHost, workRoot);
  cub(context, [
    "unit", "create", "--space", managementSpace, applicationUnit,
    applicationPath,
    "--target", targetRef,
    "--change-desc", `Deliver the approved ClusterProfile from ${policySpace}`,
    "--quiet",
  ], { timeout: 180_000 });
  const rootRelease = publishRelease(context, managementSpace);
  managementCommand(managementName, [
    "annotate", "application", managementSpace, "-n", "argocd",
    "argocd.argoproj.io/refresh=hard", "--overwrite",
  ]);
  return {
    name: applicationName,
    unit: `${managementSpace}/${applicationUnit}`,
    source: sourceReference,
    sourceRevision,
    approvedConfigHubSpace: policySpace,
    destinationCluster: "management",
    clusterRootReleaseDigest: rootRelease.manifestDigest,
  };
}

function updateApplication({
  context,
  managementName,
  managementSpace,
  applicationName,
  applicationUnit,
  policySpace,
  sourceReference,
  sourceRevision,
  workRoot,
}) {
  const applicationPath = join(
    workRoot,
    `${applicationName}-${sourceRevision}.yaml`,
  );
  writeApplication(applicationPath, applicationName, sourceReference, sourceRevision);
  cub(context, [
    "unit", "update", "--space", managementSpace, applicationUnit,
    applicationPath,
    "--change-desc",
    `Deliver the approved ${sourceRevision} ClusterProfile from ${policySpace}`,
    "--quiet",
  ], { timeout: 180_000 });
  const rootRelease = publishRelease(context, managementSpace);
  managementCommand(managementName, [
    "annotate", "application", managementSpace, "-n", "argocd",
    "argocd.argoproj.io/refresh=hard", "--overwrite",
  ]);
  return {
    name: applicationName,
    unit: `${managementSpace}/${applicationUnit}`,
    source: sourceReference,
    sourceRevision,
    approvedConfigHubSpace: policySpace,
    destinationCluster: "management",
    clusterRootReleaseDigest: rootRelease.manifestDigest,
  };
}

function writeApplication(path, applicationName, sourceReference, sourceRevision) {
  check(
    /^(pilot|staging|prod)-r[12]$/.test(sourceRevision),
    `unsupported application source revision ${sourceRevision}`,
  );
  writeFileSync(path, `apiVersion: argoproj.io/v1alpha1
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
}

function configureAnonymousOci(managementName, registryHost, workRoot) {
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
  managementCommand(managementName, ["apply", "-f", secretPath]);
}

function waitForApplication({ managementName, applicationName, expectedRevision }) {
  let last = { sync: "", health: "", revision: "", comparisonError: "" };
  for (let attempt = 0; attempt < 72; attempt += 1) {
    const result = managementTry(managementName, [
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

function clusterUp(context, name) {
  const result = cubTry(
    context,
    ["cluster", "up", "--name", name, "--no-ports"],
    { timeout: 900_000 },
  );
  check(
    result.ok || clusterPresent(name),
    `cub cluster up failed for ${name}: ${result.error}`,
  );
}

function clusterDown(context, name) {
  const result = cubTry(
    context,
    ["cluster", "down", "--name", name, "--force"],
    { timeout: 600_000 },
  );
  if (!result.ok && clusterPresent(name)) {
    tryCommand("kind", ["delete", "cluster", "--name", name], {
      timeout: 180_000,
    });
  }
  const space = `${name}-cluster`;
  for (
    let attempt = 0;
    attempt < 3 && spacePresent(context, space);
    attempt += 1
  ) {
    cubTry(context, [
      "space", "delete", space, "--recursive-force", "--quiet",
    ], { timeout: 240_000 });
    sleep(1000);
  }
}

function managementCommand(name, args, options = {}) {
  return command("kubectl", [
    "--kubeconfig", managementKubeconfig(name),
    "--context", `kind-${name}`,
    ...args,
  ], options);
}

function managementTry(name, args, options = {}) {
  return tryCommand("kubectl", [
    "--kubeconfig", managementKubeconfig(name),
    "--context", `kind-${name}`,
    ...args,
  ], options);
}

function workloadCommand(kubeconfig, args, options = {}) {
  return command("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function workloadTry(kubeconfig, args, options = {}) {
  return tryCommand("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function helmCommand(kubeconfig, args, options = {}) {
  return command("helm", ["--kubeconfig", kubeconfig, ...args], options);
}

function managementKubeconfig(name) {
  return join(homedir(), ".confighub", "clusters", `${name}.kubeconfig`);
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
  try {
    let clockMs = 0;
    const hub = createFakeConfigHub();
    const registry = createFakeOciRegistry();
    commandRunner = (file, args, options = {}) => {
      if (file === "cub") return hub.handle(args, options);
      if (file === "oras") return registry.handle(args, options);
      if (file === "tar") return realRunner(file, args, options);
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
    };
    timeSource = () => clockMs;

    const plan = loadBulkPlan();
    check(
      environments.every((environment) =>
        plan.revisions[environment].baseline.startsWith("r1-")
        && plan.revisions[environment].changed.startsWith("r2-")),
      "the bulk plan lost its revision identities",
    );

    const topology = readApprovalTopology(policyContext);
    const catalogTarget = { TargetID: hub.catalogTargetId, ProviderType: "OCI" };

    // The gate preflight is the gate preflight: it must pass when the
    // gate materializes and refuse fast, naming the issue, when it never does.
    assertApprovalGateObservable(policyContext, "20260807000000", topology, catalogTarget);
    check(
      !spacePresent(policyContext, "hx-sveltos-bulk-probe-20260807000000"),
      "the gate preflight did not delete its probe Space",
    );
    hub.state.neverPopulateGates = true;
    expectFailure(
      () => assertApprovalGateObservable(policyContext, "20260807000001", topology, catalogTarget),
      /the approval gate never appeared on the probe Unit .*; check the Space wiring before building the fleet/,
      "gate preflight refusal",
    );
    hub.state.neverPopulateGates = false;

    // The full fan-out governance walk against the fake surfaces.
    const fakeRegistry = {
      host: "registry.self-test.invalid:5000",
      clusterHost: "cluster.self-test.invalid:5000",
    };
    const spaceFor = Object.fromEntries(
      environments.map((environment) => [
        environment,
        `self-test-bulk-${environment}`,
      ]),
    );
    const environmentRecords = {};
    for (const environment of environments) {
      const space = spaceFor[environment];
      createPolicySpace(policyContext, space);
      assertPolicySpace(policyContext, space, topology.triggerIds, hub.catalogTargetId);
      cub(policyContext, [
        "unit", "create", "--space", space, policyUnit,
        plan.profiles[environment].path,
        "--label", `Proof=${proofLabel}`,
        "--change-desc", `Store the reviewed ${environment} ClusterProfile`,
        "--quiet",
      ]);
      const baseline = reviewHeadRevision({
        policyContext,
        space,
        environment,
        stageName: `${environment} baseline`,
        expectedDocs: [plan.profiles[environment].doc],
        revisionId: plan.revisions[environment].baseline,
        registry: fakeRegistry,
        workRoot,
        tag: `${environment}-r1`,
      });
      environmentRecords[environment] = {
        space,
        baseline: {
          ...baseline,
          argo: fakeArgoResult(baseline.portableRelease.manifestDigest),
        },
      };
    }

    // One pass writes the same reviewed change into every record, then each
    // record clears its own approval bracket.
    for (const environment of environments) {
      const changedFile = join(workRoot, `clusterprofile-${environment}-changed.yaml`);
      writeDocuments(changedFile, [plan.changedDocs[environment]]);
      cub(policyContext, [
        "unit", "update", "--space", spaceFor[environment], policyUnit,
        changedFile,
        "--change-desc", "Raise the background controller fleet-wide in one reviewed fan-out",
        "-o", "json",
      ]);
    }
    for (const environment of environments) {
      const changed = reviewHeadRevision({
        policyContext,
        space: spaceFor[environment],
        environment,
        stageName: `${environment} fan-out`,
        expectedDocs: [plan.changedDocs[environment]],
        revisionId: plan.revisions[environment].changed,
        minimumRevision:
          Number(environmentRecords[environment].baseline.approval.revision) + 1,
        registry: fakeRegistry,
        workRoot,
        tag: `${environment}-r2`,
      });
      check(
        changed.portableRelease.manifestDigest
          !== environmentRecords[environment].baseline.portableRelease.manifestDigest,
        `the ${environment} fan-out did not produce a new OCI digest in the fake walk`,
      );
      environmentRecords[environment].changed = {
        ...changed,
        application: {
          name: `sveltos-bulk-${environment}-self-test`,
          unit: `self-test-management/sveltos-bulk-${environment}-application`,
          source: changed.portableRelease.clusterReference,
          sourceRevision: changed.portableRelease.targetRevision,
          approvedConfigHubSpace: spaceFor[environment],
          destinationCluster: "management",
          clusterRootReleaseDigest: changed.privateRelease.manifestDigest,
        },
        argo: fakeArgoResult(changed.portableRelease.manifestDigest),
      };
    }

    // The record half of the zero-drift audit runs against the fake hub for
    // real: the set-aware gate query, the out-of-band re-reads, and the
    // change-once byte identity across records.
    const gateRows = JSON.parse(cub(policyContext, [
      "unit", "list", "--space", "*", "--where", gateQueryWhere,
      "--quiet", "-o", "json",
    ]));
    check(
      Array.isArray(gateRows) && gateRows.length === 0,
      "the set-aware gate query found armed gates after all approvals",
    );
    const storedValues = environments.map((environment) => {
      const current = cubJson(policyContext, [
        "unit", "get", "--space", spaceFor[environment], policyUnit, "-o", "json",
      ]).Unit;
      check(
        current.ContentHash
          === environmentRecords[environment].changed.contentHash,
        `the ${environment} record changed out of band in the fake walk`,
      );
      return parseDocs(storedData(current))[0].spec.helmCharts[0].values;
    });
    check(
      storedValues.every((values) => values === storedValues[0]),
      "the stored values are not identical across the fan-out records",
    );
    // A rogue unapproved unit under the proof label must surface in the query.
    createPolicySpace(policyContext, "self-test-bulk-rogue");
    cub(policyContext, [
      "unit", "create", "--space", "self-test-bulk-rogue", policyUnit,
      plan.profiles.pilot.path,
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
      rogueRows.length === 1
        && rogueRows[0].Unit?.SpaceSlug === "self-test-bulk-rogue",
      "the set-aware gate query did not surface the rogue armed gate",
    );

    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      topology,
      catalogTarget,
      clusterOrganization: "self-test-scratch",
      managementName: "hx-sveltos-bulkmgmt-selftest",
      sveltosInstall: fakeSveltosInstall(),
      registrations: plan.fleet.spec.workloads.map((workload) =>
        fakeRegistration(workload)),
      environmentRecords,
      fanOut: {
        method: plan.change.spec.fanOut.method,
        approvals: plan.change.spec.fanOut.approvals,
        changeDescription: "Raise the background controller fleet-wide in one reviewed fan-out",
        records: environments.map((environment) => ({
          environment,
          space: spaceFor[environment],
          unit: policyUnit,
        })),
      },
      checkpoints: synthesizeCheckpoints(plan),
      zeroDriftAudit: synthesizeAudit(plan),
      cleanup: {
        probeSpace: "pass",
        managementCluster: "pass",
        managementSpace: "pass",
        workloadClusters: "pass",
        policySpaces: "pass",
        registry: "pass",
        localFiles: "pass",
      },
    });
    verifyReceipt(receipt);
    const summary = renderSummary(receipt);
    check(
      summary.includes(
        receipt.spec.environments.prod.changed.portableRelease.manifestDigest,
      )
        && summary.includes("Set-aware gate query matches | 0")
        && summary.includes("Drift repaired | 4/4"),
      "the rendered summary lost its evidence",
    );

    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /proof is not pass/],
      ["source hash", (c) => { c.spec.source.profiles.pilot.rawSha256 = "0".repeat(64); }, /pilot source record changed/],
      ["revision drift", (c) => { c.spec.revisions.staging.changed = "r2-000000000000"; }, /revisions no longer match the reviewed example files/],
      ["change record", (c) => { c.spec.source.change.after = 9; }, /change record changed/],
      ["continuity", (c) => { c.spec.source.continuity.baselineMatchesChapterFourOutcome = false; }, /continuity record changed/],
      ["policy triggers", (c) => { c.spec.policy.filter.triggerRefs = ["platform/bogus"]; }, /policy record changed/],
      ["registration shape", (c) => { c.spec.fleet.registrations[3].labels.environment = "staging"; }, /registration record changed/],
      ["fan-out coverage", (c) => { c.spec.fanOut.records.pop(); }, /fan-out record changed/],
      ["fan-out approvals", (c) => { c.spec.fanOut.approvals = "one approval covered everything"; }, /fan-out record changed/],
      ["approval bracket", (c) => { c.spec.environments.pilot.changed.beforeApproval.result = "allowed"; }, /pilot changed approval record changed/],
      ["approval count", (c) => { c.spec.environments.prod.baseline.approval.recordedApprovals = 0; }, /prod baseline approval record changed/],
      ["portable tag", (c) => { c.spec.environments.staging.changed.portableRelease.targetRevision = "staging-r1"; }, /staging changed OCI record changed/],
      ["argo digest", (c) => { c.spec.environments.pilot.baseline.argo.revision = `sha256:${"0".repeat(64)}`; }, /pilot baseline Argo record changed/],
      ["digest reuse", (c) => {
        c.spec.environments.prod.changed.portableRelease.manifestDigest =
          c.spec.environments.prod.baseline.portableRelease.manifestDigest;
        c.spec.environments.prod.changed.argo.revision =
          c.spec.environments.prod.baseline.portableRelease.manifestDigest;
      }, /prod revision record changed/],
      ["checkpoint set", (c) => { c.spec.checkpoints.pop(); }, /checkpoint set changed/],
      ["checkpoint math", (c) => { c.spec.checkpoints[1].observations[0].expectedBackgroundReplicas = 2; }, /observation for .* changed/],
      ["observation result", (c) => { c.spec.checkpoints[2].observations[0].observation.result = "fail"; }, /observation for .* changed/],
      ["drift repair", (c) => { c.spec.checkpoints[2].observations[1].drift.result = "fail"; }, /drift repair for .* changed/],
      ["armed gate", (c) => { c.spec.zeroDriftAudit.gateQuery.matches = ["rogue-space/clusterprofile"]; }, /zero-drift audit changed/],
      ["out-of-band record", (c) => { c.spec.zeroDriftAudit.records[1].contentUnchanged = false; }, /zero-drift audit changed/],
      ["values identity", (c) => { c.spec.zeroDriftAudit.valuesIdenticalAcrossRecords = false; }, /zero-drift audit changed/],
      ["cleanup", (c) => { c.spec.cleanup.registry = "fail"; }, /cleanup did not pass/],
      ["identity leak", (c) => { c.spec.notes = "approved by someone@confighub.com"; }, /contains a user identity/],
      ["credential leak", (c) => { c.spec.notes = "ch_selftesttoken"; }, /contains a credential/],
    ];
    for (const [label, tamper, pattern] of tampers) {
      const clone = structuredClone(receipt);
      tamper(clone);
      expectFailure(() => verifyReceipt(clone), pattern, `receipt ${label}`);
    }

    console.log(
      "sveltos bulk ops runner self-test passed: gate preflight pass and its refusal, one fan-out pass with six approval brackets, the set-aware gate query with a rogue-gate detection, change-once byte identity across records, and the tamper battery",
    );
  } finally {
    commandRunner = realRunner;
    sleeper = realSleeper;
    timeSource = realTime;
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function fakeArgoResult(manifestDigest) {
  return {
    result: "pass",
    sync: "Synced",
    health: "Healthy",
    revision: manifestDigest,
    expectedRevision: manifestDigest,
    digestMatchesPortableOci: true,
  };
}

function fakeSveltosInstall() {
  const sourceLock = readYaml(sourceLockPath);
  return {
    source: sveltosManifestUrl,
    version: "v1.12.0",
    manifestSha256: sourceLock.spec.sveltos.manifestSha256,
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
    cluster: `${workload.cluster}-selftest`,
    labels: { environment: workload.environment, "sveltos-agent": "present" },
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
    observations: plan.fleet.spec.workloads.map((workload) => {
      const changed = id !== "baseline";
      const expectedBackgroundReplicas = changed
        ? plan.change.spec.after
        : plan.change.spec.before;
      return {
        cluster: `${workload.cluster}-selftest`,
        logicalCluster: workload.cluster,
        environment: workload.environment,
        expectedRevisionId: changed
          ? plan.revisions[workload.environment].changed
          : plan.revisions[workload.environment].baseline,
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

function synthesizeAudit(plan) {
  return {
    result: "pass",
    gateQuery: {
      scope: 'cub unit list --space "*"',
      where: gateQueryWhere,
      matches: [],
    },
    records: environments.map((environment) => ({
      environment,
      space: `self-test-bulk-${environment}`,
      revisionUnchanged: true,
      contentUnchanged: true,
    })),
    valuesIdenticalAcrossRecords: true,
    clusters: plan.fleet.spec.workloads.map((workload) => ({
      cluster: `${workload.cluster}-selftest`,
      logicalCluster: workload.cluster,
      environment: workload.environment,
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
  const catalogTargetId = "self-test-oci-target-0001";
  const triggerIdFor = (ref) => `self-test-trigger-${ref.split("/")[1]}`;
  const spaces = new Map();
  const units = new Map();
  const pending = new Set();
  let releaseSequence = 0;
  const state = {
    neverPopulateGates: false,
    approveFails: false,
    stripReleaseManifestDigest: false,
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
  const handle = (args) => {
    const { positionals, flags, labels } = parseCubCommand(args);
    const [entity, verb, ...rest] = positionals;
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
      for (const key of [...units.keys()]) {
        if (key.startsWith(`${slug}/`)) units.delete(key);
      }
      return ok("");
    }
    if (entity === "unit" && verb === "create") {
      const [slug, path] = rest;
      const data = readFileSync(path, "utf8");
      const key = unitKey(flags.space, slug);
      const unitLabels = {};
      for (const label of labels) {
        const [labelKey, labelValue] = label.split("=");
        unitLabels[labelKey] = labelValue;
      }
      units.set(key, {
        Slug: slug,
        SpaceSlug: flags.space,
        UnitID: `self-test-unit-${flags.space}-${slug}`,
        Labels: unitLabels,
        Data: Buffer.from(data).toString("base64"),
        ContentHash: sha256(data),
        HeadRevisionNum: 1,
        ApplyGates: { "awaiting/triggers": true },
        ApprovedBy: [],
      });
      pending.add(key);
      return ok("");
    }
    if (entity === "unit" && verb === "update") {
      const [slug, path] = rest;
      const key = unitKey(flags.space, slug);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      const data = readFileSync(path, "utf8");
      unit.Data = Buffer.from(data).toString("base64");
      unit.ContentHash = sha256(data);
      unit.HeadRevisionNum += 1;
      unit.ApprovedBy = [];
      unit.ApplyGates = { "awaiting/triggers": true };
      pending.add(key);
      return ok(JSON.stringify({ Unit: structuredClone(unit) }));
    }
    if (entity === "unit" && verb === "list") {
      if (flags.space !== "*" || !String(flags.where ?? "").includes("LEN(ApplyGates) > 0")) {
        return refuse(`the self-test fake hub refuses: cub ${args.join(" ")}`);
      }
      const rows = [...units.values()]
        .filter((unit) =>
          unit.Labels?.Proof === proofLabel
          && Object.keys(unit.ApplyGates ?? {}).length > 0)
        .map((unit) => ({ Unit: structuredClone(unit) }));
      return ok(JSON.stringify(rows));
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
      if (state.approveFails) return refuse("self-test simulated approval rejection");
      const key = unitKey(flags.space, rest[0]);
      const unit = units.get(key);
      if (!unit) return refuse(`unit ${key} not found`);
      unit.ApprovedBy = ["self-test-reviewer"];
      pending.add(key);
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
      return ok(JSON.stringify({
        Release: {
          ReleaseID: `self-test-release-${releaseSequence}`,
          Digest: `sha256:${sha256(`bundle:${spaceSlug}:${digestInput}`)}`,
          ManifestDigest: state.stripReleaseManifestDigest
            ? ""
            : `sha256:${sha256(`manifest:${spaceSlug}:${releaseSequence}:${digestInput}`)}`,
        },
      }));
    }
    return refuse(`the self-test fake hub refuses: cub ${args.join(" ")}`);
  };
  return { state, handle, tick, filterId, catalogTargetId };
}

function parseCubCommand(args) {
  const booleans = new Set(["--quiet", "--wait", "--patch", "--refresh-triggers", "--recursive-force"]);
  const positionals = [];
  const flags = {};
  const labels = [];
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
    if (name === "label") labels.push(args[index + 1]);
    else flags[name] = args[index + 1];
    index += 1;
  }
  return { positionals, flags, labels };
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
