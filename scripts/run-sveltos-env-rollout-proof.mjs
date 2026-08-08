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
const blockerRef = "confighubai/confighub#4975";
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
const exampleRoot = join(repoRoot, "examples", "sveltos", "env-rollout");
const fleetPath = join(exampleRoot, "fleet.yaml");
const changePath = join(exampleRoot, "change-candidate.yaml");
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
  "sveltos-env-rollout-proof",
  "receipt.yaml",
);
const summaryPath = join(repoRoot, "data", "sveltos-env-rollout", "summary.md");
const environments = ["pilot", "staging", "prod"];
const policyUnit = "clusterprofile";
const portableRepository = "sveltos-kyverno-env-rollout";
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
} else if (mode === "--probe-gate") {
  probeGate();
} else if (mode === "--self-test") {
  selfTest();
} else if (mode === "--generate") {
  check(
    existsSync(receiptPath),
    `${relativeRepo(receiptPath)} is missing; the live lane is blocked by ${blockerRef}`,
  );
  const receipt = readYaml(receiptPath);
  verifyReceipt(receipt);
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos environment rollout has no live receipt yet; the live lane stays blocked by ${blockerRef} and the drafted runner refuses at its gate preflight until the server fix lands`,
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
  console.log("verified the Sveltos environment rollout proof");
}

function run() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  const clusterContext = process.env.SVELTOS_CLUSTER_CONTEXT?.trim() ?? "";
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_SVELTOS_ENV_ROLLOUT === "1",
    "set HELM_EXPT_ALLOW_LIVE_SVELTOS_ENV_ROLLOUT=1 to confirm this live proof",
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

  const plan = loadRolloutPlan();
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
  const managementName = `hx-sveltos-envmgmt-${runId}`;
  const managementSpace = `${managementName}-cluster`;
  const registryName = `hx-sveltos-env-registry-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-rollout-"));
  const fleetClusters = plan.fleet.spec.workloads.map((workload) => ({
    cluster: `${workload.cluster}-${runId}`,
    logicalCluster: workload.cluster,
    environment: workload.environment,
    kubeconfig: join(workRoot, `${workload.cluster}.kubeconfig`),
  }));
  const spaceFor = Object.fromEntries(
    environments.map((environment) => [
      environment,
      `hx-sveltos-env-${environment}-${runId}`,
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
  // blocked server (confighubai/confighub#4975) costs seconds, not the
  // seven-minute fleet build the two-wave runner paid per attempt.
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
        completedWaves: 0,
        plan,
        fleetClusters,
        managementName,
      }),
    ];
    phase("baseline checkpoint observed on all four clusters");

    for (const wave of plan.change.spec.waves) {
      const environment = wave.environment;
      environmentRecords[environment].changed = promoteEnvironment({
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
      checkpoints.push(recordCheckpoint({
        id: `after-wave-${wave.wave}`,
        completedWaves: wave.wave,
        plan,
        fleetClusters,
        managementName,
      }));
      phase(`wave ${wave.wave} (${environment}) promoted and observed`);
    }

    const convergenceAudit = auditConvergence({
      plan,
      fleetClusters,
      managementName,
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
      clusterOrganization: clusterContextInfo.metadata.organizationName,
      managementName,
      sveltosInstall,
      registrations,
      environmentRecords,
      checkpoints,
      convergenceAudit,
      cleanup,
    });
  } finally {
    phase("cleaning up temporary resources");
    if (managementStarted || clusterPresent(managementName)) {
      for (const environment of environments) {
        managementTry(managementName, [
          "delete", "application",
          `sveltos-env-${environment}-${runId}`,
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

  check(receipt, "the Sveltos environment rollout proof did not complete");
  check(
    Object.values(cleanup).every((value) => value === "pass"),
    `Sveltos environment rollout cleanup failed: ${JSON.stringify(cleanup)}`,
  );
  writeYaml(receiptPath, receipt);
  write(summaryPath, renderSummary(receipt));
  verifyReceipt(receipt);
  console.log(
    `wrote ${relativeRepo(receiptPath)} and ${relativeRepo(summaryPath)}`,
  );
}

// The two-minute answer to "is confighubai/confighub#4975 fixed yet?":
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
    "the approval gate is observable on this server; confighubai/confighub#4975 is fixed and the drafted fleet lanes are unblocked (run them serially: the two-wave re-record, then the rollout, patch, and bulk lanes)",
  );
}

// One reviewed plan drives the runner, the matrix generator, and the
// self-test: the revision identities computed here must match
// scripts/generate-sveltos-env-rollout.mjs exactly.
function loadRolloutPlan(root = repoRoot) {
  const planRoot = join(root, "examples", "sveltos", "env-rollout");
  const fleet = readYaml(join(planRoot, "fleet.yaml"));
  const change = readYaml(join(planRoot, "change-candidate.yaml"));
  const workloads = fleet.spec?.workloads ?? [];
  check(
    fleet.kind === "SveltosEnvRolloutFleet"
      && workloads.length === 4
      && new Set(workloads.map((row) => row.cluster)).size === 4,
    "the fleet record lost its four uniquely named workload clusters",
  );
  for (const environment of environments) {
    const expected = environment === "prod" ? 2 : 1;
    check(
      workloads.filter((row) => row.environment === environment).length
        === expected,
      `the fleet must place ${expected} cluster(s) in ${environment}`,
    );
  }
  const waves = change.spec?.waves ?? [];
  check(
    change.kind === "SveltosEnvRolloutChange"
      && change.spec.before !== change.spec.after
      && waves.map((row) => row.environment).join(",") === environments.join(",")
      && waves.map((row) => row.wave).join(",") === "1,2,3",
    "the change waves must cover pilot, staging, and prod in order",
  );

  const profiles = {};
  for (const wave of waves) {
    const profilePath = join(planRoot, wave.profile);
    const text = readFileSync(profilePath, "utf8");
    const docs = parseDocs(text);
    check(docs.length === 1, `${wave.profile} must contain one object`);
    const doc = docs[0];
    check(
      doc.kind === "ClusterProfile"
        && doc.metadata?.name === `kyverno-env-${wave.environment}`
        && doc.spec?.clusterSelector?.matchLabels?.environment
        === wave.environment
        && Object.keys(doc.spec.clusterSelector.matchLabels).length === 1,
      `${wave.profile} identity or selector changed`,
    );
    check(
      doc.spec?.helmCharts?.length === 1
        && doc.spec.helmCharts[0].chartName === change.spec.chart
        && String(doc.spec.helmCharts[0].chartVersion)
        === String(change.spec.chartVersion),
      `${wave.profile} chart pin changed`,
    );
    profiles[wave.environment] = {
      doc,
      text,
      path: profilePath,
      repoPath: `examples/sveltos/env-rollout/${wave.profile}`,
    };
  }
  const baselineValues = profiles.pilot.doc.spec.helmCharts[0].values;
  check(
    environments.every(
      (environment) =>
        profiles[environment].doc.spec.helmCharts[0].values === baselineValues,
    ),
    "the three environment profiles no longer share one baseline values document",
  );
  const parsedValues = parseDocs(baselineValues)[0];
  check(
    readPath(parsedValues, change.spec.valuesPath) === change.spec.before,
    "the change candidate before-value does not match the baseline values",
  );
  const changedValuesObject = structuredClone(parsedValues);
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
      "the reviewed change produced no new revision identity",
    );
  }
  return { fleet, change, waves, profiles, changedValues, changedDocs, revisions };
}

function assertApprovalGateObservable(context, runId, topology, catalogTarget) {
  const probeSpace = `hx-sveltos-env-probe-${runId}`;
  check(
    !spacePresent(context, probeSpace),
    `refusing to reuse ${probeSpace}`,
  );
  createPolicySpace(context, probeSpace);
  try {
    assertPolicySpace(context, probeSpace, topology.triggerIds, catalogTarget.TargetID);
    cub(context, [
      "unit", "create", "--space", probeSpace, policyUnit,
      join(exampleRoot, "clusterprofile-pilot.yaml"),
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
      `the approval gate never appeared on the probe Unit ${probeSpace}/${policyUnit}; the live lane stays blocked by ${blockerRef}`,
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
    "--label", "App=sveltos-kyverno-env-rollout",
    "--label", `Environment=${environment}`,
    "--label", "Proof=sveltos-env-rollout",
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
    applicationName: `sveltos-env-${environment}-${runId}`,
    applicationUnit: `sveltos-env-${environment}-application`,
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

function promoteEnvironment({
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
  const changedPath = join(workRoot, `clusterprofile-${environment}-changed.yaml`);
  writeDocuments(changedPath, [plan.changedDocs[environment]]);
  const update = cubTry(policyContext, [
    "unit", "update", "--space", space, policyUnit, changedPath,
    "--change-desc",
    `Promote ${plan.change.spec.valuesPath} from ${plan.change.spec.before} to ${plan.change.spec.after} in ${environment}`,
    "-o", "json",
  ]);
  if (!update.ok) {
    const current = cubJson(policyContext, [
      "unit", "get", "--space", space, policyUnit, "-o", "json",
    ]).Unit;
    check(
      canonicalDocs(parseDocs(storedData(current)))
        === canonicalDocs([plan.changedDocs[environment]]),
      `ConfigHub rejected the ${environment} update before storing it: ${update.error}`,
    );
  }
  const changed = reviewHeadRevision({
    policyContext,
    space,
    environment,
    stageName: `${environment} change`,
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
    `the ${environment} change did not produce a new OCI digest`,
  );
  const application = updateApplication({
    context: clusterContext,
    managementName,
    managementSpace,
    applicationName: record.application.name,
    applicationUnit: `sveltos-env-${environment}-application`,
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
    `${application.name} did not reconcile the ${environment} change: ${argo.reason ?? "unknown"}`,
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
      "get", "clusterprofile", `kyverno-env-${environment}`, "-o", "json",
    ]).output,
  );
  check(
    sourceFieldsMatchLive(expectedDoc, live),
    `a field from the approved ${environment} ClusterProfile changed in the live object`,
  );
}

function recordCheckpoint({
  id,
  completedWaves,
  plan,
  fleetClusters,
  managementName,
}) {
  const waveByEnvironment = Object.fromEntries(
    plan.waves.map((row) => [row.environment, row.wave]),
  );
  const observations = fleetClusters.map((row) => {
    const changed = waveByEnvironment[row.environment] <= completedWaves;
    const expectedBackgroundReplicas = changed
      ? plan.change.spec.after
      : plan.change.spec.before;
    const observation = observeWorkload({
      managementName,
      workloadName: row.cluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: `kyverno-env-${row.environment}`,
      expectedBackgroundReplicas,
      // The environment this checkpoint just changed earns a bounded
      // convergence wait; unchanged environments must already be stable.
      attempts: waveByEnvironment[row.environment] === completedWaves ? 150 : 3,
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
  return { id, completedWaves, observations };
}

function auditConvergence({ plan, fleetClusters, managementName }) {
  const clusters = fleetClusters.map((row) => {
    const observation = observeWorkload({
      managementName,
      workloadName: row.cluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: `kyverno-env-${row.environment}`,
      expectedBackgroundReplicas: plan.change.spec.after,
      attempts: 30,
    });
    return { cluster: row.cluster, environment: row.environment, observation };
  });
  return {
    result: clusters.every((row) => row.observation.result === "pass")
      ? "pass"
      : "fail",
    expectedBackgroundReplicas: plan.change.spec.after,
    clusters,
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
  checkpoints,
  convergenceAudit,
  cleanup,
}) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosEnvRolloutProofReceipt",
    metadata: { name: "kyverno-environment-rollout" },
    spec: {
      recordedAt,
      flow: {
        path: "source -> ConfigHub review per environment -> local work -> OCI -> Argo CD -> Sveltos -> Kubernetes",
        promotion: "one reviewed values change promoted pilot, then staging, then production",
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
          path: "examples/sveltos/env-rollout/change-candidate.yaml",
          rawSha256: sha256(readFileSync(changePath, "utf8")),
          valuesPath: plan.change.spec.valuesPath,
          before: plan.change.spec.before,
          after: plan.change.spec.after,
        },
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
      environments: Object.fromEntries(environments.map((environment) => [
        environment,
        {
          wave: plan.waves.find((row) => row.environment === environment).wave,
          space: environmentRecords[environment].space,
          unit: policyUnit,
          baseline: environmentRecords[environment].baseline,
          changed: environmentRecords[environment].changed,
        },
      ])),
      checkpoints,
      convergenceAudit,
      cleanup,
      limits: [
        "The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.",
        "The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub, OCI, and Argo CD.",
        "The portable OCI used a temporary anonymous registry; this is not a permanent public package.",
        "The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.",
        "The proof covers one reviewed values change to this Kyverno profile, not a chart version bump.",
      ],
    },
    status: {
      result: "pass",
      claim: "ConfigHub stored and approved one reviewed values change per environment record, published each revision at its own OCI digest, and Argo CD with Sveltos converged pilot first, then staging, then both production clusters, with the unchanged environments verified stable at every checkpoint.",
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
  for (const environment of environments) {
    check(
      receipt.spec?.source?.profiles?.[environment]?.path
        === plan.profiles[environment].repoPath
        && receipt.spec.source.profiles[environment].rawSha256
        === sha256(plan.profiles[environment].text),
      `Sveltos env rollout ${environment} source record changed`,
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
    "Sveltos env rollout change record changed",
  );
  const recordedTriggers = receipt.spec?.policy?.filter?.triggerRefs ?? [];
  check(
    receipt.spec?.policy?.organization === expectedPolicyOrg
      && receipt.spec.policy.profile === "catalog-standard"
      && receipt.spec.policy.approvalGate === approvalGate
      && sameSet(recordedTriggers, expectedTriggers),
    "Sveltos env rollout policy record changed",
  );
  const sourceLock = readYaml(sourceLockPath);
  check(
    receipt.spec?.prerequisite?.version === "v1.12.0"
      && receipt.spec.prerequisite.manifestSha256
      === sourceLock.spec.sveltos.manifestSha256
      && receipt.spec.prerequisite.deployments?.length > 0,
    "Sveltos env rollout prerequisite record changed",
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
    "Sveltos env rollout registration record changed",
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
        `Sveltos env rollout ${environment} ${stage} approval record changed`,
      );
      check(
        normalizeDigest(review.privateRelease?.manifestDigest)
          === review.privateRelease.manifestDigest
          && review.portableRelease?.objectsMatchApprovedData === true
          && review.portableRelease.anonymousPull === true
          && review.portableRelease.registryLifetime === "temporary"
          && review.portableRelease.targetRevision
          === `${environment}-${stage === "baseline" ? "r1" : "r2"}`,
        `Sveltos env rollout ${environment} ${stage} OCI record changed`,
      );
      check(
        review.argo?.result === "pass"
          && review.argo.sync === "Synced"
          && review.argo.health === "Healthy"
          && review.argo.revision === review.portableRelease.manifestDigest,
        `Sveltos env rollout ${environment} ${stage} Argo record changed`,
      );
    }
    check(
      record.baseline.revisionId === plan.revisions[environment].baseline
        && record.changed.revisionId === plan.revisions[environment].changed
        && record.baseline.portableRelease.manifestDigest
        !== record.changed.portableRelease.manifestDigest
        && Number(record.changed.approval.revision)
        > Number(record.baseline.approval.revision),
      `Sveltos env rollout ${environment} revision record changed`,
    );
  }
  const checkpoints = receipt.spec?.checkpoints ?? [];
  check(
    checkpoints.map((checkpoint) => checkpoint.id).join(",")
      === "baseline,after-wave-1,after-wave-2,after-wave-3",
    "Sveltos env rollout checkpoint set changed",
  );
  const waveByEnvironment = Object.fromEntries(
    plan.waves.map((row) => [row.environment, row.wave]),
  );
  for (const checkpoint of checkpoints) {
    check(
      checkpoint.observations?.length === 4
        && new Set(checkpoint.observations.map((row) => row.cluster)).size === 4,
      `Sveltos env rollout ${checkpoint.id} observation set changed`,
    );
    for (const row of checkpoint.observations) {
      const changed =
        waveByEnvironment[row.environment] <= checkpoint.completedWaves;
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
        `Sveltos env rollout ${checkpoint.id} observation for ${row.cluster} changed`,
      );
    }
  }
  check(
    receipt.spec?.convergenceAudit?.result === "pass"
      && receipt.spec.convergenceAudit.clusters?.length === 4
      && receipt.spec.convergenceAudit.clusters.every(
        (row) => row.observation?.result === "pass",
      ),
    "Sveltos env rollout convergence audit changed",
  );
  check(
    Object.values(receipt.spec?.cleanup ?? {}).every(
      (result) => result === "pass",
    ),
    "Sveltos env rollout cleanup did not pass",
  );
  const serialized = JSON.stringify(receipt);
  check(
    !serialized.includes("@confighub.com"),
    "Sveltos env rollout receipt contains a user identity",
  );
  check(
    !serialized.includes("ch_"),
    "Sveltos env rollout receipt contains a credential",
  );
}

function renderSummary(receipt) {
  const change = receipt.spec.source.change;
  const rows = environments.map((environment) => {
    const record = receipt.spec.environments[environment];
    return `| ${record.wave} | ${environment} | ${record.baseline.beforeApproval.result} and ${record.changed.beforeApproval.result} | \`${record.changed.portableRelease.manifestDigest}\` | ${record.changed.argo.sync} and ${record.changed.argo.health} |`;
  });
  const finalCheckpoint = receipt.spec.checkpoints.at(-1);
  return `# ConfigHub promotes one change through an environment fleet

This run starts with four workload clusters in three environment groups. Each
environment keeps its own governed \`ClusterProfile\` record built from one
shared baseline, so the only reviewed difference between environments is the
selector.

One reviewed change raises \`${change.valuesPath}\` from ${change.before} to
${change.after}. ConfigHub blocked every revision until its exact head was
approved, published each approved revision at its own OCI digest, and Argo CD
with Sveltos converged the pilot cluster first, then staging, then both
production clusters. At every checkpoint the unchanged environments were
verified stable, and the run closed with a convergence audit across all four
clusters.

| Wave | Environment | Blocked before approval | Changed OCI digest | Argo CD |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

| Check | Result |
| --- | --- |
| Checkpoints observed | ${receipt.spec.checkpoints.length}/4 |
| Clusters at the changed revision after wave 3 | ${finalCheckpoint.observations.filter((row) => row.observation.result === "pass").length}/4 |
| Convergence audit | ${receipt.spec.convergenceAudit.result} |
| Cleanup | ${Object.values(receipt.spec.cleanup).every((value) => value === "pass") ? "Pass" : "Fail"} |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows which cluster ran which revision at each
checkpoint.

## Limits

${receipt.spec.limits.map((limit) => `- ${limit}`).join("\n")}

- [Committed receipt](../../runs/sveltos-env-rollout-proof/receipt.yaml)
- [Reviewed change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
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
    "--label", "App=sveltos-kyverno-env-rollout",
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
  const info = cubJson(context, [
    "unit", "get", "--space", space, unit,
    "--select", "ApplyGates,ApprovedBy",
    "-o", "json",
  ]);
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
  console.log(`[sveltos-env-rollout] ${message}`);
}

function selfTest() {
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-self-test-"));
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

    const plan = loadRolloutPlan();
    for (const environment of environments) {
      check(
        plan.revisions[environment].baseline.startsWith("r1-")
          && plan.revisions[environment].changed.startsWith("r2-"),
        "the plan revisions lost their identities",
      );
    }

    const topology = readApprovalTopology(policyContext);
    const catalogTarget = { TargetID: hub.catalogTargetId, ProviderType: "OCI" };

    // The gate preflight is the drafted #4975 blocker: it must pass when the
    // gate materializes and refuse fast, naming the issue, when it never does.
    assertApprovalGateObservable(policyContext, "20260807000000", topology, catalogTarget);
    check(
      !spacePresent(policyContext, "hx-sveltos-env-probe-20260807000000"),
      "the gate preflight did not delete its probe Space",
    );
    hub.state.neverPopulateGates = true;
    expectFailure(
      () => assertApprovalGateObservable(policyContext, "20260807000001", topology, catalogTarget),
      /the approval gate never appeared on the probe Unit .*; the live lane stays blocked by confighubai\/confighub#4975/,
      "gate preflight refusal",
    );
    check(
      !spacePresent(policyContext, "hx-sveltos-env-probe-20260807000001"),
      "the refused gate preflight did not delete its probe Space",
    );
    hub.state.neverPopulateGates = false;

    // The full three-environment governance walk against the fake surfaces.
    const fakeRegistry = {
      host: "registry.self-test.invalid:5000",
      clusterHost: "cluster.self-test.invalid:5000",
    };
    const environmentRecords = {};
    for (const environment of environments) {
      const space = `self-test-env-${environment}`;
      createPolicySpace(policyContext, space);
      assertPolicySpace(policyContext, space, topology.triggerIds, hub.catalogTargetId);
      cub(policyContext, [
        "unit", "create", "--space", space, policyUnit,
        plan.profiles[environment].path,
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
    for (const wave of plan.waves) {
      const environment = wave.environment;
      const space = environmentRecords[environment].space;
      const changedPath = join(workRoot, `clusterprofile-${environment}-changed.yaml`);
      writeDocuments(changedPath, [plan.changedDocs[environment]]);
      cub(policyContext, [
        "unit", "update", "--space", space, policyUnit, changedPath,
        "--change-desc", `Promote the ${environment} change`,
        "-o", "json",
      ]);
      const changed = reviewHeadRevision({
        policyContext,
        space,
        environment,
        stageName: `${environment} change`,
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
        `the ${environment} change did not produce a new OCI digest in the fake walk`,
      );
      environmentRecords[environment].changed = {
        ...changed,
        application: {
          name: `sveltos-env-${environment}-self-test`,
          unit: `self-test-management/sveltos-env-${environment}-application`,
          source: changed.portableRelease.clusterReference,
          sourceRevision: changed.portableRelease.targetRevision,
          approvedConfigHubSpace: space,
          destinationCluster: "management",
          clusterRootReleaseDigest: changed.privateRelease.manifestDigest,
        },
        argo: fakeArgoResult(changed.portableRelease.manifestDigest),
      };
    }

    // Synthesized observations feed the receipt shape only; they are the
    // self-test stand-in for the live cluster reads the run lane performs.
    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      topology,
      catalogTarget,
      clusterOrganization: "self-test-scratch",
      managementName: "hx-sveltos-envmgmt-selftest",
      sveltosInstall: fakeSveltosInstall(),
      registrations: plan.fleet.spec.workloads.map((workload) =>
        fakeRegistration(workload)),
      environmentRecords,
      checkpoints: synthesizeCheckpoints(plan),
      convergenceAudit: synthesizeAudit(plan),
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
      ) && summary.includes("Convergence audit"),
      "the rendered summary lost its evidence",
    );

    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /proof is not pass/],
      ["source hash", (c) => { c.spec.source.profiles.pilot.rawSha256 = "0".repeat(64); }, /pilot source record changed/],
      ["revision drift", (c) => { c.spec.revisions.staging.changed = "r2-000000000000"; }, /revisions no longer match the reviewed example files/],
      ["change record", (c) => { c.spec.source.change.after = 9; }, /change record changed/],
      ["policy triggers", (c) => { c.spec.policy.filter.triggerRefs = ["platform/bogus"]; }, /policy record changed/],
      ["registration shape", (c) => { c.spec.fleet.registrations[3].labels.environment = "staging"; }, /registration record changed/],
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
      ["checkpoint math", (c) => { c.spec.checkpoints[1].observations.find((row) => row.environment === "staging").expectedBackgroundReplicas = 2; }, /observation for .* changed/],
      ["observation result", (c) => { c.spec.checkpoints[2].observations[0].observation.result = "fail"; }, /observation for .* changed/],
      ["audit", (c) => { c.spec.convergenceAudit.result = "fail"; }, /convergence audit changed/],
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
      "sveltos env rollout runner self-test passed: gate preflight pass and #4975 refusal, six approval brackets across three environments, portable OCI digests per revision, receipt binding to the reviewed files, and the tamper battery",
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
  const waveByEnvironment = Object.fromEntries(
    plan.waves.map((row) => [row.environment, row.wave]),
  );
  return [0, 1, 2, 3].map((completedWaves) => ({
    id: completedWaves === 0 ? "baseline" : `after-wave-${completedWaves}`,
    completedWaves,
    observations: plan.fleet.spec.workloads.map((workload) => {
      const changed = waveByEnvironment[workload.environment] <= completedWaves;
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
        observation: fakeObservation(expectedBackgroundReplicas),
      };
    }),
  }));
}

function synthesizeAudit(plan) {
  return {
    result: "pass",
    expectedBackgroundReplicas: plan.change.spec.after,
    clusters: plan.fleet.spec.workloads.map((workload) => ({
      cluster: `${workload.cluster}-selftest`,
      environment: workload.environment,
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
      chart: "kyverno-3.8.1",
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
    const { positionals, flags } = parseCubCommand(args);
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
      units.set(key, {
        Slug: slug,
        SpaceSlug: flags.space,
        UnitID: `self-test-unit-${flags.space}-${slug}`,
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
    flags[name] = args[index + 1];
    index += 1;
  }
  return { positionals, flags };
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
