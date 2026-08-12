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
// runner carries the gateway path the probe proved, and no live run has been
// recorded on it yet.
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
const exampleRoot = join(repoRoot, "examples", "sveltos", "env-rollout");
const changePath = join(exampleRoot, "change-candidate.yaml");
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
// Declared with the other constants because the mode dispatch runs before
// anything further down the file is initialized.
const convergenceWaitAttempts = 150;
const holdingCheckAttempts = 3;
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
  verifyReceipt(receipt);
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos environment rollout has no live receipt yet; no live run has been recorded yet, because ${pendingReason}`,
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
  const managementName = `hx-sveltos-envmgmt-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-rollout-"));
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const fleetClusters = plan.fleet.spec.workloads.map((workload) => ({
    cluster: `${workload.cluster}-${runId}`,
    logicalCluster: workload.cluster,
    environment: workload.environment,
    kubeconfig: join(workRoot, `${workload.cluster}.kubeconfig`),
  }));
  const spaceFor = Object.fromEntries(
    environments.map((environment) => [
      environment,
      spaceName(`hx-sveltos-env-${environment}-${runId}`),
    ]),
  );
  const cleanup = {
    probeSpace: "pending",
    managementCluster: "not-created",
    workloadClusters: "not-created",
    policySpaces: "not-created",
    localFiles: "pending",
  };
  let managementStarted = false;
  const workloadsStarted = new Set();
  const policySpacesCreated = new Set();
  let receipt;

  // The approval gate is probed before any cluster work, so a Space whose
  // gate never attaches costs seconds, not the seven-minute fleet build the
  // two-wave runner paid per attempt.
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
    for (const row of [managementName, ...fleetClusters.map((item) => item.cluster)]) {
      check(!clusterPresent(row), `refusing to reuse the kind cluster ${row}`);
    }

    createCluster(managementName, managementKubeconfig);
    managementStarted = true;
    cleanup.managementCluster = "pending";
    phase("management cluster ready");

    for (const row of fleetClusters) {
      createCluster(row.cluster, row.kubeconfig);
      workloadsStarted.add(row.cluster);
    }
    cleanup.workloadClusters = "pending";
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
        environment: row.environment,
      }));
    phase("four workload clusters registered by environment label");

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

    const environmentRecords = {};
    cleanup.policySpaces = "pending";
    for (const environment of environments) {
      environmentRecords[environment] = establishEnvironment({
        policyContext,
        managementKubeconfig,
        managementName,
        environment,
        space: spaceFor[environment],
        plan,
        topology,
        catalogTarget,
        workRoot,
        policySpacesCreated,
      });
      phase(`${environment} baseline approved, published, and fetched from the gateway`);
    }

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

    for (const wave of plan.change.spec.waves) {
      const environment = wave.environment;
      environmentRecords[environment].changed = promoteEnvironment({
        policyContext,
        managementKubeconfig,
        managementName,
        environment,
        space: spaceFor[environment],
        record: environmentRecords[environment],
        plan,
        workRoot,
      });
      checkpoints.push(recordCheckpoint({
        id: `after-wave-${wave.wave}`,
        completedWaves: wave.wave,
        plan,
        fleetClusters,
        managementKubeconfig,
      }));
      phase(`wave ${wave.wave} (${environment}) promoted and observed`);
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
      environmentRecords,
      checkpoints,
      convergenceAudit,
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

function establishEnvironment({
  policyContext,
  managementKubeconfig,
  managementName,
  environment,
  space,
  plan,
  topology,
  catalogTarget,
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
    stageName: `${environment} baseline`,
    expectedDocs: [plan.profiles[environment].doc],
    revisionId: plan.revisions[environment].baseline,
  });
  // The release is published before the bootstrap profile exists, so the first
  // fetch already finds the tag the gateway serves.
  const bootstrap = applyBootstrapProfile({
    managementKubeconfig,
    workRoot,
    environment,
    space,
  });
  const delivery = waitForRemoteDeploy({
    managementKubeconfig,
    managementName,
    environment,
    expectedDoc: plan.profiles[environment].doc,
    release: baseline.release,
  });
  check(
    delivery.result === "pass",
    `Sveltos did not fetch the ${environment} baseline from the gateway: ${delivery.reason ?? "unknown"}`,
  );
  assertLiveProfileMatches({
    managementKubeconfig,
    environment,
    expectedDoc: plan.profiles[environment].doc,
  });
  return { space, bootstrap, baseline: { ...baseline, delivery } };
}

function promoteEnvironment({
  policyContext,
  managementKubeconfig,
  managementName,
  environment,
  space,
  record,
  plan,
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
    stageName: `${environment} change`,
    expectedDocs: [plan.changedDocs[environment]],
    revisionId: plan.revisions[environment].changed,
    minimumRevision: Number(record.baseline.approval.revision) + 1,
  });
  check(
    changed.release.manifestDigest !== record.baseline.release.manifestDigest,
    `the ${environment} change did not produce a new release manifest digest`,
  );
  // Promotion leaves the bootstrap profile alone. Publishing the release moved
  // the tag the gateway serves, and Sveltos follows it on its own interval.
  const delivery = waitForRemoteDeploy({
    managementKubeconfig,
    managementName,
    environment,
    expectedDoc: plan.changedDocs[environment],
    release: changed.release,
  });
  check(
    delivery.result === "pass",
    `Sveltos did not fetch the ${environment} change from the gateway: ${delivery.reason ?? "unknown"}`,
  );
  assertLiveProfileMatches({
    managementKubeconfig,
    environment,
    expectedDoc: plan.changedDocs[environment],
  });
  return { ...changed, delivery };
}

// One approval bracket: gate armed with no approval, exact-head approval, gate
// cleared with the approval recorded, and the private release the gateway then
// serves at the Space's tag.
function reviewHeadRevision({
  policyContext,
  space,
  stageName,
  expectedDocs,
  revisionId,
  minimumRevision,
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
  // The published release is not read back here. What the gateway served is
  // proved downstream, where the object that arrived on the management cluster
  // is compared field by field against the approved revision.
  const release = publishRelease(policyContext, space);
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
    release,
  };
}

function assertLiveProfileMatches({ managementKubeconfig, environment, expectedDoc }) {
  const live = JSON.parse(
    clusterCommand(managementKubeconfig, [
      "get", "clusterprofile", `kyverno-env-${environment}`, "-o", "json",
    ]).output,
  );
  check(
    sourceFieldsMatchLive(expectedDoc, live),
    `a field from the approved ${environment} ClusterProfile changed in the live object`,
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
  const waveByEnvironment = Object.fromEntries(
    plan.waves.map((row) => [row.environment, row.wave]),
  );
  const observations = fleetClusters.map((row) => {
    const changed = waveByEnvironment[row.environment] <= completedWaves;
    const expectedBackgroundReplicas = changed
      ? plan.change.spec.after
      : plan.change.spec.before;
    const observation = observeWorkload({
      managementKubeconfig,
      workloadName: row.cluster,
      workloadKubeconfig: row.kubeconfig,
      profileName: `kyverno-env-${row.environment}`,
      expectedBackgroundReplicas,
      attempts: convergenceAttempts(
        waveByEnvironment[row.environment],
        completedWaves,
      ),
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

function auditConvergence({ plan, fleetClusters, managementKubeconfig }) {
  const clusters = fleetClusters.map((row) => {
    const observation = observeWorkload({
      managementKubeconfig,
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
  managementKubeconfig,
  workloadName,
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
  managementName,
  managementRegistration,
  sveltosInstall,
  gatewayCredential,
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
        path: "source -> ConfigHub review and approval per environment -> ConfigHub release -> the ConfigHub OCI gateway -> Sveltos -> Kubernetes",
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
        gatewayRecord: probeRecord,
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
      gatewayDelivery: {
        host: configHubOciHost,
        tag: releaseTag,
        interval: remoteFetchInterval,
        deploymentType: "Remote",
        fetchedBy: "the Sveltos addon controller on the management cluster",
        addonControllerImage: sveltosInstall.addonControllerImage,
        secret: gatewayCredential.secret,
        environments: Object.fromEntries(environments.map((environment) => [
          environment,
          {
            space: environmentRecords[environment].space,
            reference: gatewayReference(environmentRecords[environment].space),
            bootstrapProfile: environmentRecords[environment].bootstrap.profile,
            baselineReleaseManifestDigest:
              environmentRecords[environment].baseline.release.manifestDigest,
            changedReleaseManifestDigest:
              environmentRecords[environment].changed.release.manifestDigest,
          },
        ])),
        waves: plan.waves.map((row) => ({
          wave: row.wave,
          environment: row.environment,
          releaseManifestDigest:
            environmentRecords[row.environment].changed.release.manifestDigest,
        })),
      },
      fleet: {
        managementCluster: managementName,
        creationCommand: "kind create cluster",
        managementRegistration,
        registrations,
      },
      environments: Object.fromEntries(environments.map((environment) => [
        environment,
        {
          wave: plan.waves.find((row) => row.environment === environment).wave,
          space: environmentRecords[environment].space,
          unit: policyUnit,
          bootstrap: environmentRecords[environment].bootstrap,
          baseline: environmentRecords[environment].baseline,
          changed: environmentRecords[environment].changed,
        },
      ])),
      checkpoints,
      convergenceAudit,
      cleanup,
      limits: [
        "The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.",
        "The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.",
        "The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.",
        "The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.",
        "The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.",
        "The proof covers one reviewed values change to this Kyverno profile, not a chart version bump.",
      ],
    },
    status: {
      result: "pass",
      claim: "ConfigHub stored and approved one reviewed values change per environment record, published each approved revision as a release its OCI gateway serves, and Sveltos fetched each release itself and converged pilot first, then staging, then both production clusters, with the unchanged environments verified stable at every checkpoint.",
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
  const sveltos = loadSveltosPin();
  check(
    receipt.spec?.prerequisite?.version === sveltos.version
      && receipt.spec.prerequisite.manifestSha256 === sveltos.manifestSha256
      && receipt.spec.prerequisite.deployments?.length > 0,
    "Sveltos env rollout prerequisite record changed",
  );
  verifyGatewayDelivery(receipt, plan);
  check(
    receipt.spec?.fleet?.managementRegistration?.labels?.role === "management"
      && receipt.spec.fleet.managementRegistration.ready === true,
    "the management cluster must be registered so it can fetch each release",
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
        normalizeDigest(review.release?.manifestDigest)
          === review.release.manifestDigest
          && review.release.space === record.space
          && review.release.reference === gatewayReference(record.space)
          && review.release.tag === releaseTag,
        `Sveltos env rollout ${environment} ${stage} release record changed`,
      );
      check(
        review.delivery?.result === "pass"
          && review.delivery.status === "Provisioned"
          && review.delivery.releaseManifestDigest
          === review.release.manifestDigest
          && review.delivery.profileMatchesApprovedRevision === true
          && review.delivery.profile === record.bootstrap?.profile,
        `Sveltos env rollout ${environment} ${stage} gateway delivery record changed`,
      );
    }
    check(
      record.bootstrap?.reference === gatewayReference(record.space)
        && record.bootstrap.interval === remoteFetchInterval
        && record.bootstrap.deploymentType === "Remote"
        && record.bootstrap.clusterSelector?.role === "management"
        && record.bootstrap.secret?.name === gatewaySecretName
        && record.bootstrap.secret.namespace === registrationNamespace,
      `Sveltos env rollout ${environment} bootstrap profile record changed`,
    );
    check(
      record.baseline.revisionId === plan.revisions[environment].baseline
        && record.changed.revisionId === plan.revisions[environment].changed
        && record.baseline.release.manifestDigest
        !== record.changed.release.manifestDigest
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

// The delivery record carries this chapter's whole claim, so it is checked as
// one block: the gateway reference per environment, the release manifest
// digest per wave, the fetch interval, the Secret type the fetcher requires,
// and the controller image the run actually ran.
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
  for (const environment of environments) {
    const row = delivery.environments?.[environment] ?? {};
    check(
      row.reference === gatewayReference(String(row.space ?? ""))
        && row.reference.startsWith(`oci://${configHubOciHost}/space/`)
        && row.bootstrapProfile === bootstrapProfileName(environment),
      `the ${environment} gateway reference changed`,
    );
    for (const digest of [
      row.baselineReleaseManifestDigest,
      row.changedReleaseManifestDigest,
    ]) {
      check(
        normalizeDigest(digest) === digest,
        `the ${environment} gateway delivery lost a release manifest digest`,
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
      === plan.waves.map((row) => `${row.wave}:${row.environment}`).join(",")
      && waves.every((row) =>
        row.releaseManifestDigest
        === delivery.environments?.[row.environment]?.changedReleaseManifestDigest)
      && new Set(waves.map((row) => row.releaseManifestDigest)).size
      === waves.length,
    "every wave must publish its own release manifest digest",
  );
}

function renderSummary(receipt) {
  const change = receipt.spec.source.change;
  const rows = environments.map((environment) => {
    const record = receipt.spec.environments[environment];
    return `| ${record.wave} | ${environment} | ${record.baseline.beforeApproval.result} and ${record.changed.beforeApproval.result} | \`${record.changed.release.manifestDigest}\` | ${record.changed.delivery.status} |`;
  });
  const finalCheckpoint = receipt.spec.checkpoints.at(-1);
  const delivery = receipt.spec.gatewayDelivery;
  return `# ConfigHub promotes one change through an environment fleet

This run starts with four workload clusters in three environment groups. Each
environment keeps its own governed \`ClusterProfile\` record built from one
shared baseline, so the only reviewed difference between environments is the
selector.

One reviewed change raises \`${change.valuesPath}\` from ${change.before} to
${change.after}. ConfigHub blocked every revision until its exact head was
approved and published each approved revision as a release its OCI gateway
serves. Sveltos fetched each release itself from
\`oci://${delivery.host}/space/<space>:${delivery.tag}\` on a
${delivery.interval} interval and converged the pilot cluster first, then
staging, then both production clusters. At every checkpoint the unchanged
environments were verified stable, and the run closed with a convergence audit
across all four clusters.

Promotion never touched the bootstrap profile on the management cluster.
Publishing a new release moved the tag, and Sveltos followed it.

| Wave | Environment | Blocked before approval | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

| Check | Result |
| --- | --- |
| Checkpoints observed | ${receipt.spec.checkpoints.length}/4 |
| Clusters at the changed revision after wave 3 | ${finalCheckpoint.observations.filter((row) => row.observation.result === "pass").length}/4 |
| Convergence audit | ${receipt.spec.convergenceAudit.result} |
| Addon controller image | \`${delivery.addonControllerImage}\` |
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
  assertPublishableSpaceName(space);
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

function bootstrapProfileName(environment) {
  return `sveltos-env-rollout-${environment}-bootstrap`;
}

// One bootstrap profile per environment, applied once as cluster setup. It
// selects the management cluster and points at that environment's Space on the
// gateway. Promotion never touches it: publishing a release moves the tag, and
// Sveltos follows on its interval.
function bootstrapProfileManifest(environment, space) {
  return `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: ${bootstrapProfileName(environment)}
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

function applyBootstrapProfile({
  managementKubeconfig,
  workRoot,
  environment,
  space,
}) {
  const profilePath = join(
    workRoot,
    `bootstrap-clusterprofile-${environment}.yaml`,
  );
  writeFileSync(
    profilePath,
    bootstrapProfileManifest(environment, space),
    { mode: 0o600 },
  );
  clusterCommand(managementKubeconfig, ["apply", "-f", profilePath]);
  return {
    profile: bootstrapProfileName(environment),
    reference: gatewayReference(space),
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
  environment,
  expectedDoc,
  release,
  attempts = 90,
}) {
  const profileName = bootstrapProfileName(environment);
  const reviewedProfile = `kyverno-env-${environment}`;
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
          `the addon controller could not read the ${environment} release: it decoded gzipped bytes as YAML. The gateway serves each release as a gzipped tar layer, so this run needs an addon controller that gunzips. Set SVELTOS_ADDON_CONTROLLER_IMAGE to that build and see ${probeRecord}.`,
        );
        check(
          feature.status !== "Failed",
          `the ${environment} bootstrap profile failed to apply the fetched release: ${last.reason}`,
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
    // environment matching completedWaves gives all of them the holding
    // budget and can never pass. The waves are numbered from one, so nothing
    // ever equals zero.
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
      "after a wave, only the promoted environment converges and the others must hold",
    );
    check(
      convergenceWaitAttempts * 4 >= 150,
      "the convergence budget must cover a first Kyverno install, which takes over a minute",
    );
    for (const environment of environments) {
      check(
        plan.revisions[environment].baseline.startsWith("r1-")
          && plan.revisions[environment].changed.startsWith("r2-"),
        "the plan revisions lost their identities",
      );
    }

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
    // its environment label, and the management cluster by its role.
    const workloadRegistration = registerWorkload({
      managementKubeconfig,
      workloadName: "hx-sveltos-env-pilot-selftest",
      workloadKubeconfig: join(workRoot, "pilot.kubeconfig"),
      workRoot,
      environment: "pilot",
    });
    check(
      workloadRegistration.labels.environment === "pilot"
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
    const bootstrap = bootstrapProfileManifest("pilot", "self-test-env-pilot");
    check(
      bootstrap.includes("deploymentType: Remote")
        && bootstrap.includes(`url: ${gatewayReference("self-test-env-pilot")}`)
        && bootstrap.includes(`interval: ${remoteFetchInterval}`)
        && bootstrap.includes("role: management")
        && bootstrap.includes(`name: ${gatewaySecretName}`)
        && bootstrap.includes(`namespace: ${registrationNamespace}`),
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

    // The whole path, environment by environment: review, approve, publish,
    // and watch the management cluster fetch the release from the gateway.
    const policySpacesCreated = new Set();
    const environmentRecords = {};
    for (const environment of environments) {
      environmentRecords[environment] = establishEnvironment({
        policyContext,
        managementKubeconfig,
        managementName,
        environment,
        space: spaceName(`self-test-env-${environment}`),
        plan,
        topology,
        catalogTarget,
        workRoot,
        policySpacesCreated,
      });
    }
    for (const wave of plan.waves) {
      const environment = wave.environment;
      environmentRecords[environment].changed = promoteEnvironment({
        policyContext,
        managementKubeconfig,
        managementName,
        environment,
        space: environmentRecords[environment].space,
        record: environmentRecords[environment],
        plan,
        workRoot,
      });
    }
    const walkDigests = [];
    for (const environment of environments) {
      const record = environmentRecords[environment];
      walkDigests.push(
        record.baseline.release.manifestDigest,
        record.changed.release.manifestDigest,
      );
      check(
        record.baseline.delivery.result === "pass"
          && record.changed.delivery.result === "pass"
          && record.baseline.delivery.status === "Provisioned"
          && record.changed.delivery.profileMatchesApprovedRevision === true
          && record.bootstrap.reference === gatewayReference(record.space)
          && record.bootstrap.changedByPromotion === false,
        `the ${environment} walk did not deliver both revisions through the gateway`,
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
        environment: "pilot",
        expectedDoc: plan.changedDocs.pilot,
        release: environmentRecords.pilot.changed.release,
        attempts: 2,
      }),
      /addon controller that gunzips/,
      "gzip fetch refusal",
    );
    cluster.state.failureMode = null;
    cluster.tick();

    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      topology,
      catalogTarget,
      managementName,
      managementRegistration,
      sveltosInstall: fakeSveltosInstall(sveltos, overrideImage),
      gatewayCredential,
      registrations: plan.fleet.spec.workloads.map((workload) =>
        fakeRegistration(workload)),
      environmentRecords,
      checkpoints: synthesizeCheckpoints(plan),
      convergenceAudit: synthesizeAudit(plan),
      cleanup: {
        probeSpace: "pass",
        managementCluster: "pass",
        workloadClusters: "pass",
        policySpaces: "pass",
        localFiles: "pass",
      },
    });
    verifyReceipt(receipt);
    const summary = renderSummary(receipt);
    check(
      summary.includes(
        receipt.spec.environments.prod.changed.release.manifestDigest,
      )
        && summary.includes(`oci://${configHubOciHost}/space/`)
        && summary.includes(overrideImage)
        && summary.includes("Convergence audit"),
      "the rendered summary lost its evidence",
    );

    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /proof is not pass/],
      ["source hash", (c) => { c.spec.source.profiles.pilot.rawSha256 = "0".repeat(64); }, /pilot source record changed/],
      ["revision drift", (c) => { c.spec.revisions.staging.changed = "r2-000000000000"; }, /revisions no longer match the reviewed example files/],
      ["change record", (c) => { c.spec.source.change.after = 9; }, /change record changed/],
      ["policy triggers", (c) => { c.spec.policy.filter.triggerRefs = ["platform/bogus"]; }, /policy record changed/],
      ["sveltos pin", (c) => { c.spec.prerequisite.manifestSha256 = "0".repeat(64); }, /prerequisite record changed/],
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
        c.spec.gatewayDelivery.environments.pilot.reference =
          "oci://registry.example.com/space/hx-sveltos-env-pilot:latest";
      }, /pilot gateway reference changed/],
      ["wave digest reuse", (c) => {
        c.spec.gatewayDelivery.waves[2].releaseManifestDigest =
          c.spec.gatewayDelivery.waves[1].releaseManifestDigest;
      }, /every wave must publish its own release manifest digest/],
      ["release digest reuse", (c) => {
        c.spec.gatewayDelivery.environments.prod.changedReleaseManifestDigest =
          c.spec.gatewayDelivery.environments.prod.baselineReleaseManifestDigest;
      }, /own manifest digest/],
      ["management unregistered", (c) => { c.spec.fleet.managementRegistration.ready = false; }, /management cluster must be registered/],
      ["registration shape", (c) => { c.spec.fleet.registrations[3].labels.environment = "staging"; }, /registration record changed/],
      ["approval bracket", (c) => { c.spec.environments.pilot.changed.beforeApproval.result = "allowed"; }, /pilot changed approval record changed/],
      ["approval count", (c) => { c.spec.environments.prod.baseline.approval.recordedApprovals = 0; }, /prod baseline approval record changed/],
      ["release reference", (c) => {
        c.spec.environments.staging.changed.release.reference =
          "oci://oci.hub.confighub.com/space/somewhere-else:latest";
      }, /staging changed release record changed/],
      ["delivery status", (c) => { c.spec.environments.pilot.baseline.delivery.status = "Failed"; }, /pilot baseline gateway delivery record changed/],
      ["delivery digest", (c) => {
        c.spec.environments.pilot.baseline.delivery.releaseManifestDigest = `sha256:${"0".repeat(64)}`;
      }, /pilot baseline gateway delivery record changed/],
      ["bootstrap rewired", (c) => { c.spec.environments.prod.bootstrap.interval = "24h0m0s"; }, /prod bootstrap profile record changed/],
      ["environment digest reuse", (c) => {
        c.spec.environments.prod.changed.release.manifestDigest =
          c.spec.environments.prod.baseline.release.manifestDigest;
        c.spec.environments.prod.changed.delivery.releaseManifestDigest =
          c.spec.environments.prod.baseline.release.manifestDigest;
      }, /prod revision record changed/],
      ["checkpoint set", (c) => { c.spec.checkpoints.pop(); }, /checkpoint set changed/],
      ["checkpoint math", (c) => { c.spec.checkpoints[1].observations.find((row) => row.environment === "staging").expectedBackgroundReplicas = 2; }, /observation for .* changed/],
      ["observation result", (c) => { c.spec.checkpoints[2].observations[0].observation.result = "fail"; }, /observation for .* changed/],
      ["audit", (c) => { c.spec.convergenceAudit.result = "fail"; }, /convergence audit changed/],
      ["cleanup", (c) => { c.spec.cleanup.policySpaces = "fail"; }, /cleanup did not pass/],
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
      "sveltos env rollout runner self-test passed: the Sveltos pin and its refusal, the addon controller image override, the workload and management registrations, the lowercase Space and Secret type refusals the gateway imposes, the gate preflight pass and its refusal, six approval brackets delivered through the gateway to a fake management cluster, the gzip fetch refusal, and the receipt tamper battery",
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
  const releases = new Map();
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
  const releaseFor = (space) => releases.get(space) ?? null;
  return { state, handle, tick, releaseFor, filterId, catalogTargetId };
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
      const bootstrapName = text.match(/^ {2}name: (\S+)$/m)?.[1];
      const space = text.match(/url: oci:\/\/[^/]+\/space\/([^:\s]+):/)?.[1];
      if (bootstrapName && space && text.includes("deploymentType: Remote")) {
        bootstraps.set(bootstrapName, space);
        deliver();
      }
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
