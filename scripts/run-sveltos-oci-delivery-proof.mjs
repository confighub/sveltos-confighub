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
  applyDepartures,
  canonicalValue,
  governedRecords,
  isScalarMap,
  normalizeDigest,
  sameSet,
  spaceName,
  waveUnlockEvidence,
  writeDocuments,
  preloadSveltosImages,
  unknownCubFlag,
} from "./lib/per-cluster-fleet.mjs";
import {
  check,
  parseDocs,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256,
  write,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const allowedModes = new Set(["--run", "--generate", "--verify", "--self-test"]);
if (!allowedModes.has(mode)) {
  console.error(`Usage:
  node scripts/run-sveltos-oci-delivery-proof.mjs --run
  node scripts/run-sveltos-oci-delivery-proof.mjs --generate
  node scripts/run-sveltos-oci-delivery-proof.mjs --verify
  node scripts/run-sveltos-oci-delivery-proof.mjs --self-test`);
  process.exit(2);
}

const expectedPolicyOrg = "helm-catalog";
const approvalFilterRef = "platform/helm-catalog-prod-gates";
const approvalGate = "platform/require-approval/vet-approvedby";
// The approval gate attaches about a second after a Unit is created; the
// report that said otherwise was our own misreading, now withdrawn. The
// runner carries the per-cluster design chapters three, four, and five
// already govern with, and no live run has been recorded on the gateway path
// yet.
const pendingReason = "the per-cluster canary has not been recorded live yet";
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
const exampleRoot = join(repoRoot, "examples", "sveltos", "kyverno-fleet");
const basePathConst = join(exampleRoot, "clusterprofile-base.yaml");
const variantsPath = join(exampleRoot, "variants.yaml");
const sourceLockPath = join(exampleRoot, "source-lock.yaml");
const receiptPath = join(
  repoRoot,
  "runs",
  "sveltos-oci-delivery-proof",
  "receipt.yaml",
);
const summaryPath = join(repoRoot, "data", "sveltos-oci-delivery-proof", "summary.md");
const policyUnit = "clusterprofile";
// Every record in a run carries these labels, and each wave selects its one
// member with a query over them. The set scope is the one the other governed
// chapters already use.
const setScope = 'cub unit list --space "*"';
const proofLabel = "sveltos-oci-delivery";
const baseRecordLabel = "base";
const variantRecordLabel = "variant";
const appLabel = "sveltos-kyverno-fleet";
const componentLabel = "sveltos-kyverno-fleet";
const ownerLabel = "platform-team";
// An operator who wants to look at the clusters and the Spaces after a run
// sets this. The default still removes everything the run created.
const keepArtifactsVariable = "HELM_EXPT_KEEP_SVELTOS_ARTIFACTS";
// Declared with the other constants because the mode dispatch runs before
// anything further down the file is initialized.
const convergenceWaitAttempts = 150;
const holdingCheckAttempts = 3;
const untouchedAttempts = 5;
const publishGateAttempts = 30;
const publishGatePollMs = 2_000;
const registrationNamespace = "projectsveltos";
// A Target needs a BridgeWorker with announced support for its ConfigType,
// workers are space-scoped and live, and this design runs no worker per
// Space, so every cluster's named Target is hosted in the catalog's
// infrastructure Space against its long-registered OCI-capable worker.
const targetHost = {
  space: "bitnami-redis-27-0-0-default-pilot-live-20260705",
  worker: "server-worker",
};
const admissionControllerDeployment = "kyverno-admission-controller";
const managementClusterRecord = "management";
const releaseTag = "latest";
const remoteFetchInterval = "1m0s";
const gatewaySecretName = "confighub-gateway";
const gatewaySecretType = "addons.projectsveltos.io/cluster-profile";
const gatewaySecretKey = "token";
const addonControllerRepository = "docker.io/projectsveltos/addon-controller";

// The chapters differ in what they prove, not in how a governed record works,
// so the record machinery comes from one place and is told this chapter's own
// labels and hub access. This chapter never changes a stored record after it
// is reviewed, so the merge-inheritance seam is wired to inert closures:
// assertMergeKeptDepartures is never called here.
const {
  approvalObservation,
  assertPolicySpace,
  blockedDryRun,
  createPolicySpace,
  establishBase,
  establishClusterTarget,
  establishVariant,
  gatewayReference,
  reviewSet,
  selectSet,
  applyBootstrapProfiles,
  bootstrapProfileManifest,
  bootstrapProfileName,
  establishManagement,
} = governedRecords({
  stableJson: (...args) => stableJson(...args),
  changedDocOf: (cluster) => cluster.baselineDoc,
  changeInherited: () => true,
  cub: (...args) => cub(...args),
  cubJson: (...args) => cubJson(...args),
  cubTry: (...args) => cubTry(...args),
  sleep: (...args) => sleep(...args),
  appLabel,
  bootstrapPrefix: "sveltos-oci-delivery",
  clusterCommand: (...args) => clusterCommand(...args),
  gatewaySecretName,
  managementRecordLabel: "management",
  registrationNamespace,
  remoteFetchInterval,
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
  now: (...args) => now(...args),
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
    "the recorded receipt predates the per-cluster design; record a live run before regenerating its summary",
  );
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else if (!existsSync(receiptPath)) {
  console.log(
    `the Sveltos OCI delivery proof has no live receipt yet; no live run has been recorded yet, because ${pendingReason}`,
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
  console.log("verified the Sveltos OCI delivery proof");
}

// One reviewed plan drives the runner and the self-test. It reads the base
// profile, the variants declaration, and derives every per-cluster document
// from the declared departures, so a departure is a declared departure rather
// than a hand-written copy. The plan refuses any shape the canary cannot be
// built from: a clusterRefs entry naming another cluster, two records sharing
// a Space, a wave list that is not exactly one then two, or an uppercase
// Space.
function loadPlan(root = repoRoot) {
  const planRoot = join(root, "examples", "sveltos", "kyverno-fleet");
  const basePath = join(planRoot, "clusterprofile-base.yaml");
  const baseText = readFileSync(basePath, "utf8");
  const baseDocs = parseDocs(baseText);
  check(baseDocs.length === 1, "the base profile must hold exactly one document");
  const baseDoc = baseDocs[0];

  const variants = readYaml(join(planRoot, "variants.yaml"));
  check(
    variants.kind === "SveltosKyvernoFleetVariants"
      && variants.spec?.base?.profile === "clusterprofile-base.yaml"
      && variants.spec.base.unit === policyUnit
      && variants.spec.base.reachesCluster === false,
    "the variants record lost its base declaration",
  );

  const workloads = variants.spec?.workloads ?? [];
  check(
    workloads.length === 2,
    "the variants record must declare exactly two workload clusters",
  );

  const waveNumbers = workloads.map((row) => row.wave);
  check(
    sameSet(waveNumbers, [1, 2]) && new Set(waveNumbers).size === 2,
    "the workloads must carry exactly the waves 1 and 2, one cluster each",
  );

  const management = variants.spec?.management ?? {};
  check(
    typeof management.cluster === "string" && management.cluster.length > 0
      && typeof management.space === "string" && management.space.length > 0
      && management.appliedOutOfBandWith === "kubectl"
      && String(management.reason ?? "").length > 0,
    "the variants record lost the management bootstrap boundary",
  );

  const declaredSpaces = [
    variants.spec.base.space,
    ...workloads.map((row) => row.space),
    management.space,
  ];
  check(
    declaredSpaces.every((space) => typeof space === "string" && space === space.toLowerCase())
      && new Set(declaredSpaces).size === declaredSpaces.length,
    "every declared Space must be lowercase and belong to one record",
  );

  // A variant departs from the base in exactly three fields: the name that
  // makes it a distinct object, the clusterRefs entry that names its own
  // cluster's SveltosCluster and nothing else, and the removal behavior the
  // canary's note calls out. Anything else departing would be an edit this
  // chapter never makes; anything short would leave two clusters unaddressed
  // or indistinct.
  const requiredDeparturePaths = [
    "metadata.name",
    "spec.clusterRefs",
    "spec.stopMatchingBehavior",
  ];
  const clusters = workloads
    .slice()
    .sort((left, right) => left.wave - right.wave)
    .map((row) => {
      const departures = row.departures ?? {};
      const departurePaths = Object.keys(departures).sort();
      check(
        sameSet(departurePaths, requiredDeparturePaths),
        `${row.cluster} must depart on exactly its name, its own clusterRefs entry, and its removal behavior`,
      );
      const refs = departures["spec.clusterRefs"];
      check(
        Array.isArray(refs) && refs.length === 1
          && refs[0]?.kind === "SveltosCluster"
          && refs[0]?.apiVersion === "lib.projectsveltos.io/v1beta1"
          && refs[0]?.name === row.cluster
          && refs[0]?.namespace === registrationNamespace,
        `${row.cluster} must depart on a clusterRefs list naming its own SveltosCluster and nothing else`,
      );
      const baselineDoc = applyDepartures(baseDoc, departures);
      const revisions = {
        baseline: `r1-${sha256(stableJson([baselineDoc])).slice(0, 12)}`,
      };
      return {
        cluster: row.cluster,
        environment: row.environment,
        wave: row.wave,
        space: row.space,
        profileName: departures["metadata.name"],
        departures,
        departurePaths,
        clusterRef: refs[0],
        baselineDoc,
        revisions,
        expectedReplicas: expectedDeploymentReplicas(valuesOf(baselineDoc)),
      };
    });
  check(
    new Set(clusters.map((row) => row.profileName)).size === clusters.length,
    "every per-cluster profile must carry its own name",
  );

  const waves = clusters
    .map((row) => ({ wave: row.wave, environment: row.environment, clusters: [row.cluster] }))
    .sort((left, right) => left.wave - right.wave);

  return {
    variants,
    waves,
    clusters,
    management: {
      cluster: management.cluster,
      space: management.space,
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
      revisions: { baseline: `b1-${sha256(stableJson([baseDoc])).slice(0, 12)}` },
    },
  };
}

function valuesOf(doc) {
  return parseDocs(doc.spec.helmCharts[0].values)[0];
}

// The chart names one deployment per controller, so the reviewed replica
// count is checkable on the cluster without reading the chart.
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

// Each wave selects its one member with a query over the labels every
// governed record carries, rather than naming a Space directly, so promotion
// is one operation over a named set even when that set holds one record.
function waveQuery(runId, wave) {
  return `Labels.Proof = '${proofLabel}' AND Labels.Run = '${runId}' AND Labels.Record = '${variantRecordLabel}' AND Labels.Wave = '${wave}'`;
}

function managementQuery(runId, managementCluster) {
  return `Labels.Proof = '${proofLabel}' AND Labels.Run = '${runId}' AND Labels.Cluster = '${managementCluster}' AND Labels.Record = '${variantRecordLabel}'`;
}

// Chapter three pins its own Sveltos release, because it runs the gateway
// fetch path the earlier chapters were recorded without; this chapter reads
// the same shape from its own source lock.
function loadSveltosPin(path = sourceLockPath) {
  const lock = readYaml(path);
  const sveltos = lock.spec?.sveltos ?? {};
  check(
    lock.kind === "SveltosKyvernoFleetLock"
      && /^[0-9a-f]{64}$/.test(String(sveltos.manifestSha256))
      && String(sveltos.manifestUrl ?? "").includes(String(sveltos.version ?? " ")),
    "the kyverno-fleet lock lost its Sveltos pin",
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

function assertApprovalGateObservable(context, runId, topology) {
  const probeSpace = spaceName(`hx-sveltos-oci-probe-${runId}`);
  check(!spacePresent(context, probeSpace), `refusing to reuse ${probeSpace}`);
  createPolicySpace(context, probeSpace);
  try {
    assertPolicySpace(context, probeSpace, topology.triggerIds, null);
    cub(context, [
      "unit", "create", "--space", probeSpace, policyUnit,
      basePathConst,
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
    cubTry(context, [
      "space", "delete", probeSpace, "--recursive-force", "--quiet",
    ], { timeout: 240_000 });
  }
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

function applyGatewayTokenSecret({ policyContext, managementKubeconfig, workRoot }) {
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

// An addon controller without the gzip fix reads the gateway's gzipped layer
// as YAML and stops on the binary noise. The runner names that failure,
// because the decoder error on its own says nothing about which build to run.
function looksLikeGzipDecodeFailure(message) {
  const text = String(message ?? "");
  return /failed to decode k8s resource/i.test(text)
    && (/control characters are not allowed/i.test(text)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text));
}

// Convergence on the workload clusters is proved by the per-checkpoint
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
        // This chapter applies the bootstrap profiles before anything is
        // approved, so until a Space's first release is published the gateway
        // answers not found and Sveltos records the pull as failed. That is
        // the inert state the canary deliberately walks through, and a stale
        // not-found status right after publish is the same wait: Sveltos
        // requeues on its interval and the loop outlasts it. Any other
        // failure still stops the run.
        const pullNotFound = /failed to pull OCI artifact/i.test(failureMessage)
          && /not found/i.test(failureMessage);
        check(
          feature.status !== "Failed" || pullNotFound,
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

// The management cluster is itself registered with Sveltos, so a bootstrap
// profile can hand it each release the gateway serves. The registration
// mirrors the workload pattern: a service account on the target, a
// short-lived token, and a kubeconfig Secret the controller reads.
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

// Each workload cluster is registered under its own logical name, so a
// clusterRefs entry can address one cluster by name and nothing else. The
// environment label stays as a grouping label.
function registerWorkload({
  managementKubeconfig,
  workloadName,
  workloadKubeconfig,
  workRoot,
  logicalCluster,
  environment,
}) {
  check(environment === "staging", `unsupported environment label ${environment}`);
  check(
    typeof logicalCluster === "string" && logicalCluster.length > 0,
    "a workload registration needs the stable logical cluster name",
  );
  const serviceAccountPath = join(workRoot, `${workloadName}-sveltos-workload-access.yaml`);
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
  const registrationPath = join(workRoot, `${workloadName}-sveltos-registration.yaml`);
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

function installSveltos({ managementKubeconfig, workRoot, sveltos, addonControllerImage }) {
  const manifestPath = join(workRoot, "sveltos-manifest.yaml");
  command("curl", ["-fsSL", sveltos.manifestUrl, "-o", manifestPath], {
    timeout: 180_000,
  });
  const downloaded = readFileSync(manifestPath, "utf8");
  check(
    sha256(downloaded) === sveltos.manifestSha256,
    "the downloaded Sveltos manifest differs from the source lock",
  );
  const pinnedImage = `${addonControllerRepository}:${sveltos.version}`;
  const overridden = addonControllerImage !== pinnedImage;
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
  clusterCommand(managementKubeconfig, ["apply", "-f", crdPath], { timeout: 300_000 });
  for (const crd of crds) {
    clusterCommand(managementKubeconfig, [
      "wait", "--for=condition=Established",
      `crd/${crd.metadata.name}`, "--timeout=180s",
    ], { timeout: 240_000 });
  }
  clusterCommand(managementKubeconfig, ["apply", "-f", resourcePath], { timeout: 900_000 });
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

function imageLinePattern(image) {
  const literal = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^([ \\t]*)image:[ \\t]*${literal}[ \\t]*$`, "gm");
}

function waitForExactDeployments({ managementKubeconfig, namespace, timeoutAttempts, pollSeconds }) {
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

function run() {
  const policyContext = process.env.CUB_CONTEXT?.trim() ?? "";
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_SVELTOS_OCI_PROOF === "1",
    "set HELM_EXPT_ALLOW_LIVE_SVELTOS_OCI_PROOF=1 to confirm this live proof",
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

  const plan = loadPlan();
  const sveltos = loadSveltosPin();
  const addonControllerImage = resolveAddonControllerImage(sveltos);

  const topology = readApprovalTopology(policyContext);

  const recordedAt = new Date().toISOString();
  const runId = safeRunId(process.env.HELM_EXPT_PROOF_RUN_ID || recordedAt);
  const keepArtifacts = keepArtifactsRequested();
  const managementName = `${plan.management.cluster}-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-oci-delivery-"));
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const fleetClusters = plan.clusters.map((row) => ({
    cluster: `${row.cluster}-${runId}`,
    logicalCluster: row.cluster,
    environment: row.environment,
    wave: row.wave,
    kubeconfig: join(workRoot, `${row.cluster}.kubeconfig`),
  }));
  const baseSpace = spaceName(`hx-sveltos-oci-base-${runId}`);
  // One Space per cluster, the management cluster included, so the record
  // that says what a cluster runs is addressable on its own.
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
  // gate never attaches costs seconds, not the minutes a two-cluster fleet
  // build would cost per attempt.
  assertApprovalGateObservable(policyContext, runId, topology);
  // Creating the management cluster's Target up front is the target-host
  // preflight: it is idempotent, the record establishment needs it anyway,
  // and a host worker that cannot mint OCI targets refuses here in seconds
  // rather than after the fleet build.
  establishClusterTarget(policyContext, "hx-sveltos-fleet-mgmt");
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
    phase("two workload clusters ready");

    preloadSveltosImages({
      clusters: [managementName, ...fleetClusters.map((row) => row.cluster)],
      version: sveltos.version,
      addonControllerImage,
    });
    phase("the Sveltos images loaded into every cluster from the local daemon");

    const sveltosInstall = installSveltos({
      managementKubeconfig, workRoot, sveltos, addonControllerImage,
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
    phase("two workload clusters registered, each with its own addressing label");

    const gatewayCredential = applyGatewayTokenSecret({
      policyContext, managementKubeconfig, workRoot,
    });
    const managementRegistration = registerManagementCluster({
      managementKubeconfig, managementName, workRoot,
    });
    phase("the management cluster can fetch its own profiles from the gateway");

    cleanup.results.policySpaces = "pending";
    const baseRecord = establishBase({
      policyContext, space: baseSpace, plan, topology, runId, policySpacesCreated,
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
    phase("two per-cluster variants cloned from the base, each carrying its own departures");

    const managementVariant = establishManagement({
      policyContext,
      space: spaceFor[plan.management.cluster],
      plan,
      topology,
      runId,
      workRoot,
      policySpacesCreated,
      workloadSpaces: plan.clusters.map((row) => ({ cluster: row.cluster, space: spaceFor[row.cluster] })),
    });
    phase("the management record holds one bootstrap profile per workload Space");

    // The management record is reviewed and approved on its own: it is what
    // opens the gateway path, and neither workload record is touched here.
    // Each workload record is approved later, in its own wave.
    const managementReview = reviewSet({
      policyContext,
      stageName: "management",
      query: managementQuery(runId, plan.management.cluster),
      members: [{
        cluster: plan.management.cluster,
        space: spaceFor[plan.management.cluster],
        expectedDocs: managementVariant.documents,
        revisionId: managementVariant.revisionId,
        publishesRelease: false,
      }],
    });
    managementVariant.baseline = managementReview.records[plan.management.cluster];
    phase("the management record was reviewed and approved on its own");

    const bootstrap = applyBootstrapProfiles({
      managementKubeconfig,
      workRoot,
      profiles: managementVariant.bootstrapProfiles,
    });
    phase("the management record was applied out of band, which is what opens the gateway path");

    const checkpoints = [
      recordCheckpoint({ id: "baseline", deliveredWaves: 0, plan, fleetClusters, managementKubeconfig }),
    ];
    phase("baseline checkpoint observed: both clusters complete, addressed, and untouched");

    const waveRecords = [];
    for (const wave of plan.waves) {
      waveRecords.push(promoteCanaryWave({
        policyContext,
        managementKubeconfig,
        managementName,
        wave,
        plan,
        spaceFor,
        runId,
        variantRecords,
        checkpoints,
      }));
      checkpoints.push(recordCheckpoint({
        id: `after-wave-${wave.wave}`,
        deliveredWaves: wave.wave,
        plan,
        fleetClusters,
        managementKubeconfig,
      }));
      phase(`wave ${wave.wave} (${wave.environment}) approved and delivered ${wave.clusters[0]}`);
    }

    const driftRepair = {
      clusters: fleetClusters.map((row) => {
        const result = runDriftRepair({ workloadKubeconfig: row.kubeconfig });
        check(
          result.result === "pass",
          `Sveltos did not repair injected drift on ${row.cluster}: ${result.reason ?? "unknown"}`,
        );
        return {
          cluster: row.cluster,
          logicalCluster: row.logicalCluster,
          deployment: admissionControllerDeployment,
          from: 3,
          droppedTo: 1,
          restoredTo: 3,
          result: result.result,
        };
      }),
    };
    phase("drift repaired on both clusters");

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
      variantRecords,
      managementVariant,
      bootstrap,
      waveRecords,
      checkpoints,
      driftRepair,
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
      cleanup.results.managementCluster = clusterPresent(managementName) ? "fail" : "pass";

      for (const row of fleetClusters) {
        if (workloadsStarted.has(row.cluster) || clusterPresent(row.cluster)) {
          tryCommand("kind", ["delete", "cluster", "--name", row.cluster], {
            timeout: 180_000,
          });
        }
      }
      cleanup.results.workloadClusters = fleetClusters.some((row) => clusterPresent(row.cluster))
        ? "fail"
        : "pass";

      for (const space of policySpaces) {
        if (policySpacesCreated.has(space) || spacePresent(policyContext, space)) {
          cubTry(policyContext, [
            "space", "delete", space, "--recursive-force", "--quiet",
          ], { timeout: 240_000 });
        }
      }
      cleanup.results.policySpaces = policySpaces.some((space) => spacePresent(policyContext, space))
        ? "fail"
        : "pass";
    }

    // The scratch tree holds kubeconfigs and a token, so it goes either way.
    rmSync(workRoot, { recursive: true, force: true });
    cleanup.results.localFiles = existsSync(workRoot) ? "fail" : "pass";
  }

  check(receipt, "the Sveltos OCI delivery proof did not complete");
  check(
    cleanupSucceeded(cleanup),
    `Sveltos OCI delivery cleanup failed: ${JSON.stringify(cleanup)}`,
  );
  writeYaml(receiptPath, receipt);
  write(summaryPath, renderSummary(receipt));
  verifyReceipt(receipt);
  if (keepArtifacts) reportKeptArtifacts(cleanup);
  console.log(`wrote ${relativeRepo(receiptPath)} and ${relativeRepo(summaryPath)}`);
}

function keepArtifactsRequested() {
  return process.env[keepArtifactsVariable]?.trim() === "1";
}

// Cleanup passes when everything was removed, and it also passes when the
// operator asked to keep the clusters and the Spaces. What it never accepts
// is a removal that was attempted and failed.
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
    `[sveltos-oci-delivery] ${keepArtifactsVariable}=1 was set, so these were left behind:`,
  );
  for (const row of cleanup.kept) {
    console.log(`[sveltos-oci-delivery]   ${row.kind} ${row.name}`);
  }
  console.log("[sveltos-oci-delivery] remove them with:");
  for (const row of cleanup.kept) {
    console.log(`[sveltos-oci-delivery]   ${row.removeWith}`);
  }
}

// One wave, one record, one approval. Wave one's evidence is the whole fleet
// at the baseline; wave two's is the pilot cluster alone, at the checkpoint
// wave one just delivered. The guard runs before the wave's set is even
// listed, so an unhealthy or incomplete checkpoint refuses the wave before
// anything is touched.
function promoteCanaryWave({
  policyContext,
  managementKubeconfig,
  managementName,
  wave,
  plan,
  spaceFor,
  runId,
  variantRecords,
  checkpoints,
}) {
  const previous = wave.wave === 1
    ? null
    : plan.waves.find((row) => row.wave === wave.wave - 1);
  const unlockedBy = waveUnlockEvidence({
    wave: wave.wave,
    previousEnvironment: previous?.environment ?? null,
    expectedClusters: previous ? previous.clusters : plan.clusters.map((row) => row.cluster),
    checkpoints,
  });

  const query = waveQuery(runId, wave.wave);
  const clusterRow = plan.clusters.find((row) => row.cluster === wave.clusters[0]);
  const expectedUnit = `${spaceFor[clusterRow.cluster]}/${policyUnit}`;
  const preflight = selectSet({
    policyContext,
    stageName: `wave ${wave.wave}`,
    query,
    expectedUnits: [expectedUnit],
  });
  const reviewed = reviewSet({
    policyContext,
    stageName: `wave ${wave.wave}`,
    query,
    members: [{
      cluster: clusterRow.cluster,
      space: spaceFor[clusterRow.cluster],
      expectedDocs: [clusterRow.baselineDoc],
      revisionId: clusterRow.revisions.baseline,
    }],
  });
  const record = reviewed.records[clusterRow.cluster];
  const delivery = waitForRemoteDeploy({
    managementKubeconfig,
    managementName,
    cluster: clusterRow.cluster,
    profileName: clusterRow.profileName,
    expectedDoc: clusterRow.baselineDoc,
    release: record.release,
  });
  check(
    delivery.result === "pass",
    `Sveltos did not fetch the ${clusterRow.cluster} record from the gateway: ${delivery.reason ?? "unknown"}`,
  );
  assertLiveProfileMatches({
    managementKubeconfig,
    profileName: clusterRow.profileName,
    expectedDoc: clusterRow.baselineDoc,
  });
  variantRecords[clusterRow.cluster].baseline = { ...record, delivery };

  // Wave one, and only wave one, leaves a cluster held back: the second
  // cluster's record is complete, addressed, and gate-armed, with zero
  // approvals on file. blockedDryRun is the same check every other approval
  // bracket in this repository waits on; here it is read without ever
  // approving, which is exactly the inert state the canary claims.
  let held = null;
  if (wave.wave === 1) {
    const secondRow = plan.clusters.find((row) => row.cluster !== clusterRow.cluster);
    blockedDryRun(policyContext, spaceFor[secondRow.cluster], policyUnit);
    held = {
      cluster: secondRow.cluster,
      space: spaceFor[secondRow.cluster],
      gate: approvalGate,
      observation: { gateArmed: true, recordedApprovals: 0 },
      releasePublished: false,
      addressedBy: bootstrapProfileName(secondRow.cluster),
      note: "complete, addressed, and inert until its own approval",
    };
  }

  return {
    wave: wave.wave,
    environment: wave.environment,
    unlockedBy,
    selection: { ...preflight, ...reviewed.selection },
    approval: reviewed.approval,
    held,
    clusters: [{
      cluster: clusterRow.cluster,
      space: record.space,
      revision: record.approval.revision,
      revisionId: record.revisionId,
      recordedApprovals: record.approval.recordedApprovals,
      releaseManifestDigest: record.release.manifestDigest,
    }],
  };
}

// How long a cluster gets to reach the state a checkpoint expects. The wave
// just delivered gets the generous budget, because Kyverno takes over a
// minute to become available on a first install. A cluster already converged
// in an earlier wave gets a short holding budget, which is what proves it
// held rather than drifting to a state nobody approved.
function convergenceAttempts(wave, deliveredWaves) {
  return wave === deliveredWaves ? convergenceWaitAttempts : holdingCheckAttempts;
}

function recordCheckpoint({ id, deliveredWaves, plan, fleetClusters, managementKubeconfig }) {
  const observations = fleetClusters.map((row) => {
    const planned = plan.clusters.find((item) => item.cluster === row.logicalCluster);
    const delivered = planned.wave <= deliveredWaves;
    const observation = delivered
      ? observeWorkload({
        managementKubeconfig,
        workloadName: row.cluster,
        logicalCluster: row.logicalCluster,
        workloadKubeconfig: row.kubeconfig,
        profileName: planned.profileName,
        expectedReplicas: planned.expectedReplicas,
        attempts: convergenceAttempts(planned.wave, deliveredWaves),
      })
      : observeUntouched({ workloadKubeconfig: row.kubeconfig });
    check(
      observation.result === "pass",
      `${row.cluster} did not hold the expected state at ${id}: ${observation.reason ?? "unknown"}`,
    );
    return {
      cluster: row.cluster,
      logicalCluster: row.logicalCluster,
      environment: row.environment,
      wave: planned.wave,
      expected: delivered ? "converged-at-approved-revision" : "untouched",
      expectedRevisionId: delivered ? planned.revisions.baseline : null,
      observation,
    };
  });
  return { id, deliveredWaves, observations };
}

// Every cluster is checked against the reviewed replica count on the cluster
// itself, not only in the record: the management ClusterSummary must report
// its Helm feature Provisioned, all four Kyverno deployments must be stable,
// and the admission controller must sit at its reviewed replica count.
function observeWorkload({
  managementKubeconfig,
  workloadName,
  logicalCluster,
  workloadKubeconfig,
  profileName,
  expectedReplicas,
  attempts,
}) {
  const expectedAdmissionReplicas = expectedReplicas[admissionControllerDeployment];
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
        const profileLabel = item.metadata?.labels?.["projectsveltos.io/cluster-profile-name"];
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
            deployment.status?.observedGeneration === deployment.metadata?.generation,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    const admission = last.deployments.find((deployment) => deployment.name === admissionControllerDeployment);
    const stable = last.deployments.length === 4
      && last.deployments.every(
        (deployment) => deployment.desired === deployment.available && deployment.observedGenerationMatches,
      )
      && admission?.desired === expectedAdmissionReplicas;
    if (last.helmStatus === "Provisioned" && stable) {
      const releases = JSON.parse(
        helmCommand(workloadKubeconfig, ["list", "-n", "kyverno", "-o", "json"]).output,
      );
      const release = releases.find((item) => item.name === "kyverno");
      check(release, `the Kyverno Helm release is missing on ${workloadName}`);
      check(
        release.chart === "kyverno-3.8.1",
        `the Kyverno Helm release chart changed on ${workloadName}: ${release.chart}`,
      );
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
        admissionReplicas: { desired: admission.desired, available: admission.available },
        deployments: last.deployments,
      };
    }
    if (attempt + 1 < attempts) sleep(4000);
  }
  return {
    result: "fail",
    reason: `summary=${last.summary}; helm=${last.helmStatus}; deployments=${
      JSON.stringify(last.deployments)
    }; expectedAdmissionReplicas=${expectedAdmissionReplicas}`,
  };
}

// The cluster this wave has not reached yet must show no trace of the
// workload: no Kyverno namespace, or a namespace with nothing running in it,
// and no Helm release. This is what turns "held" from an assertion made about
// a ConfigHub record into a fact observed on the cluster itself.
function observeUntouched({ workloadKubeconfig, attempts = untouchedAttempts }) {
  let last = { namespacePresent: true, deploymentCount: -1, helmReleaseCount: -1 };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const namespace = clusterTry(workloadKubeconfig, ["get", "namespace", "kyverno", "-o", "json"]);
    const namespacePresent = namespace.ok;
    const deployments = namespacePresent
      ? clusterTry(workloadKubeconfig, ["-n", "kyverno", "get", "deployments", "-o", "json"])
      : null;
    const deploymentCount = deployments?.ok
      ? (JSON.parse(deployments.output).items ?? []).length
      : 0;
    const releasesResult = helmTry(workloadKubeconfig, ["list", "-n", "kyverno", "-o", "json"]);
    const helmReleaseCount = releasesResult.ok
      ? (JSON.parse(releasesResult.output || "[]").length)
      : 0;
    last = { namespacePresent, deploymentCount, helmReleaseCount };
    if ((!namespacePresent || deploymentCount === 0) && helmReleaseCount === 0) {
      return {
        result: "pass",
        state: "untouched",
        namespacePresent,
        deploymentCount,
        helmReleaseCount,
      };
    }
    if (attempt + 1 < attempts) sleep(2000);
  }
  return {
    result: "fail",
    reason: `namespacePresent=${last.namespacePresent}; deploymentCount=${last.deploymentCount}; helmReleaseCount=${last.helmReleaseCount}`,
  };
}

// Drift repair closes the run on both clusters: the admission controller is
// scaled down from its reviewed count, and Sveltos restores it on its own.
function runDriftRepair({ workloadKubeconfig, attempts = 180 }) {
  clusterCommand(workloadKubeconfig, [
    "-n", "kyverno", "scale", "deployment", admissionControllerDeployment, "--replicas=1",
  ]);
  let changed = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = JSON.parse(
      clusterCommand(workloadKubeconfig, [
        "-n", "kyverno", "get", "deployment", admissionControllerDeployment, "-o", "json",
      ]).output,
    );
    const replicas = Number(current.spec?.replicas ?? 0);
    const available = Number(current.status?.availableReplicas ?? 0);
    if (replicas === 1) changed = true;
    if (
      changed
      && replicas === 3
      && available === 3
      && current.status?.observedGeneration === current.metadata?.generation
    ) {
      return { result: "pass" };
    }
    if (attempt + 1 < attempts) sleep(3000);
  }
  return { result: "fail", reason: `replica drift was not restored after ${attempts} attempts` };
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
  variantRecords,
  managementVariant,
  bootstrap,
  waveRecords,
  checkpoints,
  driftRepair,
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
        target: record.target,
        records: [{ stage: "baseline", wave: row.wave, ...record.baseline }],
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
      profile: managementVariant.bootstrapProfiles.map((row) => row.profile).join(","),
      selector: { role: "management" },
      upstream: null,
      departures: {},
      departedFields: [],
      bootstrapProfiles: managementVariant.bootstrapProfiles,
      boundary: managementVariant.boundary,
      target: managementVariant.target,
      records: [{ stage: "baseline", wave: 0, ...managementVariant.baseline }],
    },
  ];
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosOciDeliveryProofReceipt",
    metadata: { name: "kyverno-fleet-canary" },
    spec: {
      recordedAt,
      flow: {
        path: "source -> one reviewed base record in ConfigHub -> one variant per cluster -> approval per variant -> ConfigHub release -> the ConfigHub OCI gateway -> Sveltos -> Kubernetes",
        canary: "wave one approved and delivered the pilot cluster's record alone; the second cluster's record stayed complete, addressed, and gate-armed with no approval until wave two approved its own revision",
        mapping: "ConfigHub holds one record per cluster, so this receipt answers which cluster runs which revision without reading a Sveltos selector or a cluster",
      },
      source: {
        base: { path: plan.base.repoPath, rawSha256: sha256(plan.base.text) },
        variants: {
          path: relativeRepo(variantsPath),
          rawSha256: sha256(readFileSync(variantsPath, "utf8")),
        },
        sourceLock: relativeRepo(sourceLockPath),
        gatewayRecord: probeRecord,
      },
      revisions: {
        base: { baseline: plan.base.revisions.baseline },
        clusters: Object.fromEntries(
          plan.clusters.map((row) => [row.cluster, { baseline: row.revisions.baseline }]),
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
      base: baseRecord,
      variants,
      advance: {
        evidenceGated: true,
        rule: "No wave's approval is requested until the preceding checkpoint shows every cluster the wave depends on reporting healthy: the whole fleet at the baseline for wave one, the environment the previous wave promoted after that. Each wave records the evidence that unlocked it.",
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
            releaseManifestDigest: variantRecords[row.cluster].baseline.release.manifestDigest,
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
      driftRepair,
      cleanup,
      limits: [
        "The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.",
        "The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.",
        "The management record was applied out of band with kubectl, because it is the record that opens the gateway path.",
        "The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.",
        "The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.",
        "The proof used two local kind workload clusters, a pilot and a second cluster in the same staging environment. It does not prove a large production fleet.",
        "No selector was edited anywhere in this run: widening the rollout meant approving the second cluster's own record.",
      ],
    },
    status: {
      result: "pass",
      claim: "ConfigHub held one record per cluster over a shared base: the pilot cluster's record was approved and delivered first, published as its own release and fetched by Sveltos from the ConfigHub OCI gateway at its own manifest digest. The second cluster's record stayed complete, addressed, and gate-armed with zero approvals and no release served for its Space until wave two approved its own revision, converging at a distinct digest. Each wave's approval was gated on the preceding checkpoint reporting the clusters it depends on healthy, and injected drift was repaired back to the reviewed replica count on both clusters once the canary completed.",
    },
  };
}

// The recorded receipt held one profile widened by an approved selector
// change, delivered through a GitOps controller and a temporary registry. It
// predates the per-cluster design and is recognized, not verified, so the
// re-record does not silently rewrite it or check it against a contract it
// was never built to satisfy.
function verifyReceipt(receipt) {
  if (receipt.spec?.variants === undefined) {
    console.log(
      "the recorded receipt was recorded on the earlier delivery path and predates the per-cluster design; its governance claim stands as recorded and it awaits a gateway re-record",
    );
    return false;
  }

  check(receipt.kind === "SveltosOciDeliveryProofReceipt", "Sveltos OCI delivery receipt kind changed");
  check(receipt.status?.result === "pass", "Sveltos OCI delivery proof is not pass");

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

  const plan = loadPlan();
  check(
    receipt.spec?.source?.base?.path === plan.base.repoPath
      && receipt.spec.source.base.rawSha256 === sha256(plan.base.text)
      && receipt.spec.source?.variants?.path === relativeRepo(variantsPath)
      && receipt.spec.source.variants.rawSha256 === sha256(readFileSync(variantsPath, "utf8")),
    "Sveltos OCI delivery source record changed",
  );
  for (const row of plan.clusters) {
    check(
      receipt.spec?.revisions?.clusters?.[row.cluster]?.baseline === row.revisions.baseline,
      "the receipt revisions no longer match the reviewed example files",
    );
  }
  check(
    receipt.spec?.revisions?.base?.baseline === plan.base.revisions.baseline,
    "the receipt revisions no longer match the reviewed example files",
  );

  const recordedTriggers = receipt.spec?.policy?.filter?.triggerRefs ?? [];
  check(
    receipt.spec?.policy?.organization === expectedPolicyOrg
      && receipt.spec.policy.profile === "catalog-standard"
      && receipt.spec.policy.approvalGate === approvalGate
      && sameSet(recordedTriggers, expectedTriggers),
    "Sveltos OCI delivery policy record changed",
  );

  const sveltos = loadSveltosPin();
  check(
    receipt.spec?.prerequisite?.version === sveltos.version
      && receipt.spec.prerequisite.manifestSha256 === sveltos.manifestSha256
      && receipt.spec.prerequisite.deployments?.length > 0,
    "Sveltos OCI delivery prerequisite record changed",
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
        (registration) => registration.ready === true && registration.credential?.storedInRepository === false,
      )
      && plan.clusters.every((row) =>
        registrations.some(
          (registration) => registration.cluster === row.cluster && registration.labels?.environment === "staging",
        ))
      && new Set(registrations.map((row) => row.cluster)).size === registrations.length,
    "every workload cluster must be registered under its own SveltosCluster name",
  );

  const checkpoints = receipt.spec?.checkpoints ?? [];
  check(
    checkpoints.map((checkpoint) => checkpoint.id).join(",") === "baseline,after-wave-1,after-wave-2",
    "Sveltos OCI delivery checkpoint set changed",
  );
  for (const checkpoint of checkpoints) {
    check(
      checkpoint.observations?.length === plan.clusters.length
        && new Set(checkpoint.observations.map((row) => row.cluster)).size === plan.clusters.length,
      `Sveltos OCI delivery ${checkpoint.id} observation set changed`,
    );
    for (const row of checkpoint.observations) {
      const planned = plan.clusters.find((item) => item.cluster === row.logicalCluster);
      check(planned, `${checkpoint.id} observed an unplanned cluster`);
      const delivered = planned.wave <= checkpoint.deliveredWaves;
      const expected = delivered ? "converged-at-approved-revision" : "untouched";
      check(
        row.expected === expected
          && row.observation?.result === "pass"
          && (!delivered || row.expectedRevisionId === planned.revisions.baseline),
        `Sveltos OCI delivery ${checkpoint.id} observation for ${row.cluster} changed`,
      );
    }
  }

  const driftRepair = receipt.spec?.driftRepair ?? {};
  const driftClusters = driftRepair.clusters ?? [];
  check(
    driftClusters.length === plan.clusters.length
      && sameSet(driftClusters.map((row) => row.logicalCluster), plan.clusters.map((row) => row.cluster))
      && new Set(driftClusters.map((row) => row.cluster)).size === driftClusters.length
      && driftClusters.every(
        (row) =>
          row.deployment === admissionControllerDeployment
          && row.from === 3
          && row.droppedTo === 1
          && row.restoredTo === 3
          && row.result === "pass",
      ),
    "Sveltos OCI delivery drift repair changed",
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
    !/temporary registry|anonymous registry|registry:2|host\.docker\.internal|127\.0\.0\.1:\d+/i.test(serialized),
    "this proof reads each release from the ConfigHub OCI gateway; a receipt naming a temporary registry predates that design",
  );
  check(!serialized.includes("@confighub.com"), "Sveltos OCI delivery receipt contains a user identity");
  check(
    !serialized.includes("ch_") && !serialized.includes("eyJ"),
    "Sveltos OCI delivery receipt contains a credential",
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
}

// The whole point of the design: one record per cluster, each addressing its
// own cluster and nothing else, each holding its own departures.
function verifyVariants(receipt, plan) {
  const variants = receipt.spec?.variants ?? [];
  const expected = [...plan.clusters.map((row) => row.cluster), plan.management.cluster];
  check(
    variants.length === expected.length && sameSet(variants.map((row) => row.cluster), expected),
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
  // before anything else was checked, so every receipt here carries targets.
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
      variant.gatewayReference === gatewayReference(String(variant.space ?? "")) && variant.unit === policyUnit,
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
      if (variant.role === "management") {
        check(
          record.release === null,
          `the ${variant.cluster} ${record.stage} record must not publish a release`,
        );
      } else {
        check(record.release, `the ${variant.cluster} ${record.stage} record published no release`);
        check(
          normalizeDigest(record.release?.manifestDigest) === record.release.manifestDigest
            && record.release.space === variant.space
            && record.release.reference === variant.gatewayReference
            && record.release.tag === releaseTag,
          `the ${variant.cluster} ${record.stage} release record changed`,
        );
        check(
          record.delivery?.result === "pass"
            && record.delivery.status === "Provisioned"
            && record.delivery.releaseManifestDigest === record.release.manifestDigest
            && record.delivery.profileMatchesApprovedRevision === true
            && record.delivery.reviewedProfile === variant.profile,
          `the ${variant.cluster} ${record.stage} gateway delivery record changed`,
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
        && stableJson(variant.departures) === stableJson(row.departures),
      `the ${row.cluster} departures no longer match the reviewed variants record`,
    );
    const stages = (variant.records ?? []).map((record) => record.stage).join(",");
    check(
      stages === "baseline"
        && variant.records[0].revisionId === row.revisions.baseline
        && variant.records[0].wave === row.wave,
      `the ${row.cluster} revision record changed`,
    );
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
        profiles.some((profile) => profile.cluster === row.cluster && profile.profile === bootstrapProfileName(row.cluster)))
      && new Set(profiles.map((profile) => profile.reference)).size === profiles.length,
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

// A wave is one operation over a named set of exactly one record. The receipt
// keeps the query, the unit it matched, one approval bound to that record's
// own revision, the evidence that unlocked it, and, on wave one alone, the
// second cluster's held state.
function verifyWaves(receipt, plan) {
  const waves = receipt.spec?.waves ?? [];
  check(
    waves.map((row) => `${row.wave}:${row.environment}`).join(",")
      === plan.waves.map((row) => `${row.wave}:${row.environment}`).join(","),
    "Sveltos OCI delivery wave set changed",
  );
  // A receipt that declares evidence-gated advance must record, on every
  // wave, the checkpoint evidence that unlocked its approval, and that
  // evidence must agree with the checkpoints the receipt itself carries. A
  // receipt recorded before the guard existed declares nothing and carries
  // nothing; one that carries unlock evidence without declaring it, or
  // declares it without carrying it, is refused.
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
      const expectedId = wave.wave === 1 ? "baseline" : `after-wave-${wave.wave - 1}`;
      const previous = wave.wave === 1 ? null : plan.waves.find((row) => row.wave === wave.wave - 1);
      const checkpoint = (receipt.spec?.checkpoints ?? []).find((row) => row.id === unlocked.precedingCheckpointId);
      const dependedOn = previous ? previous.clusters : plan.clusters.map((row) => row.cluster);
      const scope = (checkpoint?.observations ?? []).filter((row) => dependedOn.includes(row.logicalCluster));
      check(
        unlocked.approvalFollowedEvidence === true
          && unlocked.precedingCheckpointId === expectedId
          && unlocked.environment === (previous ? previous.environment : "baseline")
          && Boolean(checkpoint)
          && sameSet((unlocked.clusters ?? []).map((row) => row.logicalCluster), dependedOn)
          && scope.length === dependedOn.length
          && (unlocked.clusters ?? []).every((row) => row.result === "pass")
          && scope.every((row) => row.observation?.result === "pass"),
        `wave ${wave.wave} must record the evidence that unlocked its approval: every cluster it depends on healthy at ${expectedId}`,
      );
    }
    check(
      sameSet(members.map((row) => row.cluster), planned.clusters),
      `wave ${wave.wave} approved ${members.map((row) => row.cluster).join(", ")} rather than ${planned.clusters.join(", ")}`,
    );
    check(
      wave.selection?.scope === setScope
        && String(wave.selection.query ?? "").includes(`Labels.Wave = '${wave.wave}'`)
        && sameSet(wave.selection.matched ?? [], members.map((row) => `${row.space}/${policyUnit}`)),
      `wave ${wave.wave} must record the query that selected its set and the unit it matched`,
    );
    check(
      wave.approval?.appliedAsOneOperation === true && wave.approval.recordedApprovals === 1,
      `wave ${wave.wave} must approve its one record in one operation`,
    );
    for (const member of members) {
      const planCluster = plan.clusters.find((row) => row.cluster === member.cluster);
      check(
        member.revisionId === planCluster.revisions.baseline
          && member.recordedApprovals >= 1
          && normalizeDigest(member.releaseManifestDigest) === member.releaseManifestDigest,
        `wave ${wave.wave} recorded a different approval for ${member.cluster}`,
      );
    }
    if (wave.wave === 1) {
      const second = plan.clusters.find((row) => row.wave !== 1);
      const held = wave.held ?? {};
      const secondVariant = (receipt.spec?.variants ?? []).find(
        (row) => row.cluster === second.cluster,
      );
      check(
        held.cluster === second.cluster
          && held.space === secondVariant?.space
          && held.gate === approvalGate
          && held.observation?.gateArmed === true
          && held.observation.recordedApprovals === 0
          && held.releasePublished === false
          && held.addressedBy === bootstrapProfileName(second.cluster),
        "wave one must record the second cluster's held state",
      );
    } else {
      check(wave.held === null, "wave two must not hold any cluster back");
    }
  }
  const approved = waves.flatMap((wave) => (wave.clusters ?? []).map((row) => row.cluster));
  check(
    sameSet(approved, plan.clusters.map((row) => row.cluster)),
    "every cluster must be approved in exactly one wave",
  );
}

// The delivery record carries this chapter's whole claim, so it is checked as
// one block: the gateway reference per cluster, the release manifest digest
// per cluster, the fetch interval, the Secret type the fetcher requires, and
// the controller image the run actually ran.
function verifyGatewayDelivery(receipt, plan) {
  const delivery = receipt.spec?.gatewayDelivery ?? {};
  check(
    delivery.host === configHubOciHost
      && delivery.tag === releaseTag
      && delivery.interval === remoteFetchInterval
      && delivery.deploymentType === "Remote",
    "Sveltos OCI delivery gateway delivery contract changed",
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
      && delivery.addonControllerImage === receipt.spec?.prerequisite?.addonControllerImage,
    "the receipt must record the addon controller image the run used",
  );
  const digests = [];
  for (const row of plan.clusters) {
    const record = delivery.clusters?.[row.cluster] ?? {};
    check(
      record.reference === gatewayReference(String(record.space ?? ""))
        && record.reference.startsWith(`oci://${configHubOciHost}/space/`)
        && record.bootstrapProfile === bootstrapProfileName(row.cluster)
        && normalizeDigest(record.releaseManifestDigest) === record.releaseManifestDigest,
      `the ${row.cluster} gateway reference changed`,
    );
    digests.push(record.releaseManifestDigest);
  }
  check(new Set(digests).size === digests.length, "every published release must carry its own manifest digest");
  const waves = delivery.waves ?? [];
  check(
    waves.map((row) => `${row.wave}:${row.environment}`).join(",")
      === plan.waves.map((row) => `${row.wave}:${row.environment}`).join(","),
    "the gateway delivery waves changed",
  );
  for (const wave of waves) {
    check(wave.clusters?.length === 1, `wave ${wave.wave} gateway delivery must record exactly one cluster`);
    const member = wave.clusters[0];
    check(
      member.releaseManifestDigest === delivery.clusters?.[member.cluster]?.releaseManifestDigest,
      `wave ${wave.wave} published a different release for ${member.cluster}`,
    );
  }
}

// Cleanup is a pass when everything was removed and also when the operator
// asked to keep the artifacts. Kept artifacts must say what was left and how
// to remove it, so a kept run never reads as a failed cleanup.
function verifyCleanup(receipt) {
  const cleanup = receipt.spec?.cleanup ?? {};
  check(cleanupSucceeded(cleanup), "Sveltos OCI delivery cleanup did not pass");
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
  const workloadVariants = receipt.spec.variants.filter((variant) => variant.role === "workload");
  const rows = workloadVariants
    .slice()
    .sort((left, right) => left.wave - right.wave)
    .map((variant) => {
      const record = variant.records[0];
      return `| ${variant.wave} | ${variant.cluster} | ${variant.space} | \`${record.release.manifestDigest}\` | ${record.delivery.status} |`;
    });
  const delivery = receipt.spec.gatewayDelivery;
  const held = receipt.spec.waves[0]?.held;
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
  const digests = workloadVariants.map((variant) => variant.records[0].release.manifestDigest);
  const driftPassed = receipt.spec.driftRepair.clusters.filter((row) => row.result === "pass").length;
  return `# ConfigHub delivers a canary the fleet can audit: one record per cluster, one approval per wave

This run starts with a pilot cluster and a second cluster, both in staging, and
a management cluster. ConfigHub holds one reviewed base record and one variant
per cluster, so the answer to which cluster runs which revision comes from
ConfigHub rather than from a selector on a cluster.

Wave one approved and delivered the pilot cluster's record alone. Through all
of wave one the second cluster's record already existed, already addressed its
own cluster, and stayed **armed**: its approval gate present, zero approvals
recorded, and the gateway serving nothing for its Space, so its cluster stayed
untouched. Sveltos fetched each approved release itself from
\`oci://${delivery.host}/space/<space>:${delivery.tag}\` on a
${delivery.interval} interval. Wave two's approval was itself evidence-gated:
it was refused until the checkpoint after wave one showed the pilot healthy.
No selector was edited at any point; widening the rollout meant approving the
second cluster's own record.

After both waves converged, injected drift was repaired on both clusters:
Sveltos restored \`${admissionControllerDeployment}\` from a dropped replica
back to its reviewed count of 3.

| Wave | Cluster | Space | Release digest | Sveltos |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
${advance}
| Check | Result |
| --- | --- |
| Checkpoints observed | ${receipt.spec.checkpoints.length}/3 |
| Second record inert through wave one | ${held ? "held, gate-armed, zero approvals" : "not recorded"} |
| Release digests distinct | ${new Set(digests).size === digests.length ? "yes" : "no"} |
| Drift repaired | ${driftPassed}/${receipt.spec.driftRepair.clusters.length} |
| Addon controller image | \`${delivery.addonControllerImage}\` |
| Cleanup | ${receipt.spec.cleanup.mode === "kept" ? "Artifacts kept deliberately" : "Pass"} |${receipt.spec.variants.some((row) => row.target) ? `\n| Release targets | one Target per cluster, named for it |` : ""}

- [Committed receipt](../../runs/sveltos-oci-delivery-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/kyverno-fleet/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/kyverno-fleet/variants.yaml)
- [Reviewed source lock](../../examples/sveltos/kyverno-fleet/source-lock.yaml)
`;
}

function readApprovalTopology(context) {
  const filter = getByRef(context, "filter", approvalFilterRef).Filter;
  const triggers = expectedTriggers.map((ref) => getByRef(context, "trigger", ref).Trigger);
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

function clusterPresent(name) {
  const result = tryCommand("kind", ["get", "clusters"]);
  return result.ok && result.output.split(/\r?\n/).includes(name);
}

function spacePresent(context, space) {
  return cubTry(context, ["space", "get", space, "-o", "json"]).ok;
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

// Every cluster this run touches is addressed by its own kubeconfig, so the
// same helpers serve the management cluster and the workload clusters.
function clusterCommand(kubeconfig, args, options = {}) {
  return command("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function clusterTry(kubeconfig, args, options = {}) {
  return tryCommand("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function helmCommand(kubeconfig, args, options = {}) {
  return command("helm", ["--kubeconfig", kubeconfig, ...args], options);
}

function helmTry(kubeconfig, args, options = {}) {
  return tryCommand("helm", ["--kubeconfig", kubeconfig, ...args], options);
}

function cub(context, args, options = {}) {
  return command("cub", args, { ...options, env: cubEnvironment(context) }).output;
}

function cubTry(context, args, options = {}) {
  return tryCommand("cub", args, { ...options, env: cubEnvironment(context) });
}

function cubJson(context, args, options = {}) {
  return JSON.parse(cub(context, args, options));
}

function cubEnvironment(context) {
  return { ...process.env, CONFIGHUB_AGENT: "1", CUB_CONTEXT: context };
}

function command(file, args, options = {}) {
  const result = tryCommand(file, args, options);
  if (!result.ok) {
    throw new Error(`${file} ${args.slice(0, 6).join(" ")} failed: ${result.error}`);
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
      result.error?.message ?? result.stderr ?? result.stdout ?? `exit ${result.status}`,
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
  check(compact.length >= 8, "HELM_EXPT_PROOF_RUN_ID must contain at least eight digits");
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
  console.log(`[sveltos-oci-delivery] ${message}`);
}

function selfTest() {
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-oci-delivery-self-test-"));
  const realRunner = commandRunner;
  const realSleeper = sleeper;
  const realTime = timeSource;
  const policyContext = "self-test-policy";
  const managementKubeconfig = join(workRoot, "management.kubeconfig");
  const runId = "20260813091500";
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
    commandRunner = (file, args, options = {}) => {
      if (file === "cub") return hub.handle(args, options);
      if (file === "kubectl") return cluster.handle(args, options);
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

    const plan = loadPlan();

    // One single-cluster variant per workload cluster, over exactly two
    // waves, each departing from the base on exactly its addressing and its
    // removal behavior.
    check(
      plan.clusters.length === 2
        && plan.waves.map((row) => row.wave).join(",") === "1,2"
        && plan.clusters.every((row) =>
          row.baselineDoc.spec.clusterRefs.length === 1
          && row.baselineDoc.spec.clusterRefs[0].kind === "SveltosCluster"
          && row.baselineDoc.spec.clusterRefs[0].name === row.cluster)
        && new Set(plan.clusters.map((row) => row.space)).size === 2
        && new Set(plan.clusters.map((row) => row.profileName)).size === 2,
      "the plan must hold one single-cluster variant per workload cluster over two waves",
    );
    for (const row of plan.clusters) {
      check(
        row.revisions.baseline.startsWith("r1-")
          && sameSet(row.departurePaths, [
            "metadata.name",
            "spec.clusterRefs",
            "spec.stopMatchingBehavior",
          ]),
        `${row.cluster} lost its exactly-three departures`,
      );
    }

    // Refusals proved against tampered copies of the reviewed example files.
    expectFailure(
      () => loadPlan(tamperedExampleRoot(workRoot, "clusterref-wrong-cluster", (text) =>
        text.replace(
          "          name: hx-sveltos-fleet-second",
          "          name: hx-sveltos-fleet-pilot",
        ))),
      /must depart on a clusterRefs list naming its own SveltosCluster/,
      "clusterRefs naming another cluster refusal",
    );
    expectFailure(
      () => loadPlan(tamperedExampleRoot(workRoot, "shared-space", (text) =>
        text.replace(
          "      space: sveltos-kyverno-fleet-second",
          "      space: sveltos-kyverno-fleet-pilot",
        ))),
      /belong to one record/,
      "shared Space refusal",
    );
    expectFailure(
      () => loadPlan(tamperedExampleRoot(workRoot, "wave-order", (text) =>
        text.replace("      wave: 2", "      wave: 3"))),
      /exactly the waves 1 and 2/,
      "wave list refusal",
    );
    expectFailure(
      () => loadPlan(tamperedExampleRoot(workRoot, "uppercase-space", (text) =>
        text.replace(
          "      space: sveltos-kyverno-fleet-pilot",
          "      space: Sveltos-Kyverno-Fleet-Pilot",
        ))),
      /lowercase/,
      "uppercase Space refusal",
    );

    // The Sveltos pin this chapter reads, and the default image it follows.
    const sveltos = loadSveltosPin();
    const pinnedImage = `${addonControllerRepository}:${sveltos.version}`;
    check(
      sveltos.version === "v1.13.0"
        && sveltos.manifestUrl.includes(sveltos.version)
        && /^[0-9a-f]{64}$/.test(sveltos.manifestSha256),
      "the kyverno-fleet Sveltos pin lost its shape",
    );
    check(
      resolveAddonControllerImage(sveltos) === pinnedImage,
      "the default addon controller image no longer follows the pin",
    );
    const overrideImage = `${addonControllerRepository}:v1.13.0-ch`;

    // The two constraints the gateway imposes: lowercase Spaces, and the
    // Secret type Sveltos requires.
    check(
      gatewayReference("hx-sveltos-fleet-pilot-20260813091500")
        === "oci://oci.hub.confighub.com/space/hx-sveltos-fleet-pilot-20260813091500:latest",
      "the gateway reference changed shape",
    );
    expectFailure(
      () => gatewayReference("HX-Sveltos-Fleet-Pilot"),
      /OCI repository names are lowercase/,
      "uppercase gateway reference refusal",
    );
    const selfTestToken = `self-test-gateway-token-${"a".repeat(48)}`;
    const secretManifest = gatewayTokenSecretManifest(selfTestToken);
    check(
      secretManifest.includes(`type: ${gatewaySecretType}`)
        && !secretManifest.includes("type: Opaque")
        && !secretManifest.includes(selfTestToken),
      "the gateway token Secret lost its required type or carried the token in the clear",
    );
    expectFailure(
      () => gatewayTokenSecretManifest(selfTestToken, "Opaque"),
      /cluster-profile type/,
      "Opaque gateway Secret refusal",
    );
    check(
      sanitizeError(`token: ${selfTestToken}`).includes("<redacted")
        && !sanitizeError(`token: ${selfTestToken}`).includes(selfTestToken),
      "the error redaction no longer covers the gateway token",
    );
    const gatewayCredential = applyGatewayTokenSecret({ policyContext, managementKubeconfig, workRoot });
    check(
      gatewayCredential.secret.type === gatewaySecretType
        && gatewayCredential.secret.key === gatewaySecretKey
        && gatewayCredential.secret.tokenRecordedInReceipt === false,
      "the gateway credential record changed",
    );

    const topology = readApprovalTopology(policyContext);

    // The whole path: one base record, two variants cloned from it, the
    // management record reviewed and approved on its own, delivery through
    // the fake gateway, and two waves of single-record promotion.
    const policySpacesCreated = new Set();
    const baseSpace = spaceName(`hx-sveltos-oci-base-${runId}`);
    const spaceFor = Object.fromEntries([
      ...plan.clusters.map((row) => [row.cluster, spaceName(`${row.cluster}-${runId}`)]),
      [plan.management.cluster, spaceName(`${plan.management.cluster}-${runId}`)],
    ]);
    const managementName = `${plan.management.cluster}-${runId}`;

    const baseRecord = establishBase({
      policyContext, space: baseSpace, plan, topology, runId, policySpacesCreated,
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
        runId,
        workRoot,
        policySpacesCreated,
      });
    }
    check(
      plan.clusters.every((row) =>
        variantRecords[row.cluster].upstream.space === baseSpace
          && variantRecords[row.cluster].upstream.unitLinked === true
          && variantRecords[row.cluster].clusterRef.name === row.cluster),
      "every variant must be linked to the base and address its own cluster",
    );

    const managementVariant = establishManagement({
      policyContext,
      space: spaceFor[plan.management.cluster],
      plan,
      topology,
      runId,
      workRoot,
      policySpacesCreated,
      workloadSpaces: plan.clusters.map((row) => ({ cluster: row.cluster, space: spaceFor[row.cluster] })),
    });
    check(
      [baseSpace, ...Object.values(spaceFor)].every((space) => {
        const labels = hub.spaceLabels(space) ?? {};
        return labels.Component === componentLabel && labels.Owner === ownerLabel;
      }),
      "every Space the run creates must carry its Component and Owner labels",
    );
    check(
      managementVariant.bootstrapProfiles.length === 2
        && new Set(managementVariant.bootstrapProfiles.map((row) => row.reference)).size === 2
        && managementVariant.boundary.firstRevisionDeliveredThroughGateway === false,
      "the management record must hold one bootstrap profile per workload Space",
    );

    const managementReview = reviewSet({
      policyContext,
      stageName: "management",
      query: managementQuery(runId, plan.management.cluster),
      members: [{
        cluster: plan.management.cluster,
        space: spaceFor[plan.management.cluster],
        expectedDocs: managementVariant.documents,
        revisionId: managementVariant.revisionId,
        publishesRelease: false,
      }],
    });
    check(
      managementReview.records[plan.management.cluster].release === null
        && managementReview.approval.recordedApprovals === 1,
      "the management record must be reviewed and approved on its own, without a release",
    );
    managementVariant.baseline = managementReview.records[plan.management.cluster];

    const bootstrap = applyBootstrapProfiles({
      managementKubeconfig,
      workRoot,
      profiles: managementVariant.bootstrapProfiles,
    });

    // Guard refusals, proved before either wave promotes for real.
    const walkCheckpoints = synthesizeCheckpoints(plan);
    const sickCheckpoints = structuredClone(walkCheckpoints.slice(0, 2));
    sickCheckpoints[1].observations
      .find((row) => row.logicalCluster === plan.clusters[0].cluster).observation.result = "fail";

    // Wave one: the pilot's record alone.
    const wave1 = promoteCanaryWave({
      policyContext,
      managementKubeconfig,
      managementName,
      wave: plan.waves[0],
      plan,
      spaceFor,
      runId,
      variantRecords,
      checkpoints: walkCheckpoints.slice(0, 1),
    });
    const secondRow = plan.clusters.find((row) => row.wave === 2);
    check(
      hub.releaseFor(spaceFor[secondRow.cluster]) === null,
      "the second cluster's Space must serve no release through wave one",
    );
    check(
      wave1.held?.cluster === secondRow.cluster
        && wave1.held.space === spaceFor[secondRow.cluster]
        && wave1.held.observation.gateArmed === true
        && wave1.held.observation.recordedApprovals === 0
        && wave1.held.releasePublished === false
        && wave1.held.addressedBy === bootstrapProfileName(secondRow.cluster),
      "wave one must record the second cluster's held state",
    );
    check(
      wave1.clusters[0].recordedApprovals === 1
        && normalizeDigest(wave1.clusters[0].releaseManifestDigest) === wave1.clusters[0].releaseManifestDigest,
      "wave one must approve and publish the pilot record",
    );

    expectFailure(
      () => promoteCanaryWave({
        policyContext,
        managementKubeconfig,
        managementName,
        wave: plan.waves[1],
        plan,
        spaceFor,
        runId,
        variantRecords,
        checkpoints: sickCheckpoints,
      }),
      /wave 2 approval refused/,
      "unhealthy pilot refuses wave two's approval",
    );
    const incompleteCheckpoints = structuredClone(walkCheckpoints.slice(0, 1));
    incompleteCheckpoints[0].observations.pop();
    expectFailure(
      () => promoteCanaryWave({
        policyContext,
        managementKubeconfig,
        managementName,
        wave: plan.waves[0],
        plan,
        spaceFor,
        runId,
        variantRecords,
        checkpoints: incompleteCheckpoints,
      }),
      /the evidence is incomplete/,
      "a checkpoint missing a cluster is not unlock evidence",
    );

    // Wave two: the second cluster's record, unlocked by the pilot's health.
    const wave2 = promoteCanaryWave({
      policyContext,
      managementKubeconfig,
      managementName,
      wave: plan.waves[1],
      plan,
      spaceFor,
      runId,
      variantRecords,
      checkpoints: walkCheckpoints.slice(0, 2),
    });
    check(wave2.held === null, "wave two must not hold anything back; both records are approved by then");
    check(
      wave1.clusters[0].releaseManifestDigest !== wave2.clusters[0].releaseManifestDigest,
      "the pilot and the second cluster must converge at distinct release digests",
    );
    check(
      variantRecords[plan.clusters[0].cluster].baseline.delivery.result === "pass"
        && variantRecords[plan.clusters[1].cluster].baseline.delivery.result === "pass",
      "both clusters must have received their record from the gateway",
    );

    const receipt = buildReceipt({
      recordedAt: "self-test",
      plan,
      topology,
      managementName,
      managementRegistration: fakeManagementRegistration(),
      sveltosInstall: fakeSveltosInstall(sveltos, overrideImage),
      gatewayCredential,
      registrations: plan.clusters.map((row) => fakeRegistration(row)),
      baseRecord,
      variantRecords,
      managementVariant,
      bootstrap,
      waveRecords: [wave1, wave2],
      checkpoints: synthesizeCheckpoints(plan),
      driftRepair: synthesizeDriftRepair(plan),
      cleanup: removedCleanup(),
    });
    check(verifyReceipt(receipt) === true, "the self-test receipt was not recognized as a per-cluster record");

    const summary = renderSummary(receipt);
    check(
      summary.includes(receipt.spec.variants[1].records[0].release.manifestDigest)
        && summary.includes(`oci://${configHubOciHost}/space/`)
        && summary.includes(overrideImage)
        && summary.includes("armed"),
      "the rendered summary lost its evidence",
    );

    // The keep-alive record, and its two refusals.
    const kept = structuredClone(receipt);
    kept.spec.cleanup = keptCleanup();
    check(verifyReceipt(kept) === true, "a kept run must still verify");
    check(renderSummary(kept).includes("Artifacts kept deliberately"), "a kept run must say so in its summary");
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

    // A receipt still on the earlier delivery path is recognized, not
    // verified, and does not throw.
    const superseded = structuredClone(receipt);
    delete superseded.spec.variants;
    superseded.spec.configHubReview = {};
    check(
      verifyReceipt(superseded) === false,
      "an earlier-path receipt must be recognized as recorded, not verified as current",
    );

    const pilotCluster = plan.clusters[0].cluster;
    const secondCluster = plan.clusters[1].cluster;
    const tampers = [
      ["kind", (c) => { c.kind = "OtherReceipt"; }, /receipt kind changed/],
      ["result", (c) => { c.status.result = "fail"; }, /proof is not pass/],
      ["source hash base", (c) => { c.spec.source.base.rawSha256 = "0".repeat(64); }, /source record changed/],
      ["source hash variants", (c) => { c.spec.source.variants.rawSha256 = "0".repeat(64); }, /source record changed/],
      ["revision drift", (c) => { c.spec.revisions.clusters[secondCluster].baseline = "r1-000000000000"; }, /revisions no longer match/],
      ["policy triggers", (c) => { c.spec.policy.filter.triggerRefs = ["platform/bogus"]; }, /policy record changed/],
      ["sveltos pin", (c) => { c.spec.prerequisite.manifestSha256 = "0".repeat(64); }, /prerequisite record changed/],
      ["base published", (c) => { c.spec.base.published = true; }, /base record must carry no target and reach no cluster/],
      ["variant dropped", (c) => { c.spec.variants.pop(); }, /must record one variant per cluster/],
      ["shared Space", (c) => { c.spec.variants[1].space = c.spec.variants[0].space; }, /two variants share a Space/],
      ["clusterRef renamed", (c) => { c.spec.variants[0].clusterRef.name = secondCluster; }, /must name its own SveltosCluster/],
      ["clusterRef wrong kind", (c) => { c.spec.variants[0].clusterRef.kind = "Cluster"; }, /must name its own SveltosCluster/],
      ["clusterRef dropped", (c) => { delete c.spec.variants[0].clusterRef; }, /must name its own SveltosCluster/],
      ["selector reintroduced", (c) => { c.spec.variants[0].selector = { cluster: pilotCluster }; }, /must name its own SveltosCluster/],
      ["target dropped", (c) => { delete c.spec.variants[0].target; }, /must release to its own cluster's Target/],
      ["target renamed", (c) => { c.spec.variants[0].target.name = "somewhere-else"; }, /must release to its own cluster's Target/],
      ["target provider", (c) => { c.spec.variants[0].target.provider = "Kubernetes"; }, /must release to its own cluster's Target/],
      ["targets shared", (c) => { c.spec.variants[1].target = { ...c.spec.variants[0].target }; c.spec.variants[1].target.name = c.spec.variants[1].cluster; c.spec.variants[1].target.ref = `${targetHost.space}/${c.spec.variants[1].cluster}`; }, /two variants share a Target/],
      ["shared catalog target reintroduced", (c) => { c.spec.policy.target = { ref: "catalog/oci-target" }; }, /shared catalog target is retired/],
      ["upstream link dropped", (c) => { c.spec.variants[0].upstream = null; }, /is not linked to the base record/],
      ["departures dropped", (c) => {
        c.spec.variants[0].departures = {};
        c.spec.variants[0].departedFields = [];
      }, /departures no longer match/],
      ["management boundary", (c) => { c.spec.variants[2].boundary.firstRevisionDeliveredThroughGateway = true; }, /management bootstrap boundary changed/],
      ["bootstrap changedByPromotion", (c) => { c.spec.gatewayDelivery.bootstrap.changedByPromotion = true; }, /applied once as cluster setup/],
      ["controller image dropped", (c) => {
        delete c.spec.prerequisite.addonControllerImage;
        delete c.spec.gatewayDelivery.addonControllerImage;
      }, /must record the addon controller image/],
      ["controller image disagreement", (c) => { c.spec.gatewayDelivery.addonControllerImage = `${addonControllerRepository}:v0.0.0`; }, /must record the addon controller image/],
      ["fetch interval", (c) => { c.spec.gatewayDelivery.interval = "24h0m0s"; }, /gateway delivery contract changed/],
      ["gateway host", (c) => { c.spec.gatewayDelivery.host = "registry.example.com"; }, /gateway delivery contract changed/],
      ["secret type", (c) => { c.spec.gatewayDelivery.secret.type = "Opaque"; }, /requires a Secret of type/],
      ["token in the receipt", (c) => { c.spec.gatewayDelivery.secret.tokenRecordedInReceipt = true; }, /requires a Secret of type/],
      ["gateway reference", (c) => {
        c.spec.gatewayDelivery.clusters[pilotCluster].reference = "oci://registry.example.com/space/somewhere:latest";
      }, /gateway reference changed/],
      ["release digest reuse", (c) => {
        c.spec.gatewayDelivery.clusters[secondCluster].releaseManifestDigest =
          c.spec.gatewayDelivery.clusters[pilotCluster].releaseManifestDigest;
      }, /own manifest digest/],
      ["registration renamed", (c) => { c.spec.fleet.registrations[1].cluster = c.spec.fleet.registrations[0].cluster; }, /registered under its own SveltosCluster name/],
      ["registration not ready", (c) => { c.spec.fleet.registrations[1].ready = false; }, /registered under its own SveltosCluster name/],
      ["approval bracket", (c) => { c.spec.variants[0].records[0].beforeApproval.result = "allowed"; }, /approval record changed/],
      ["approval count 0", (c) => { c.spec.variants[0].records[0].approval.recordedApprovals = 0; }, /approval record changed/],
      ["wave member swapped", (c) => { c.spec.waves[0].clusters[0].cluster = secondCluster; }, /rather than/],
      ["wave query dropped", (c) => { c.spec.waves[0].selection.query = ""; }, /must record the query that selected its set/],
      ["held dropped", (c) => { delete c.spec.waves[0].held; }, /wave one must record the second cluster's held state/],
      ["held space rewired", (c) => { c.spec.waves[0].held.space = "sveltos-somewhere-else"; }, /wave one must record the second cluster's held state/],
      ["held approved", (c) => { c.spec.waves[0].held.observation.recordedApprovals = 1; }, /wave one must record the second cluster's held state/],
      ["held gate disarmed", (c) => { c.spec.waves[0].held.observation.gateArmed = false; }, /wave one must record the second cluster's held state/],
      ["held release published", (c) => { c.spec.waves[0].held.releasePublished = true; }, /wave one must record the second cluster's held state/],
      ["wave unlock dropped", (c) => { delete c.spec.waves[0].unlockedBy; }, /must record the evidence that unlocked its approval/],
      ["wave unlock unmarked", (c) => { c.spec.waves[1].unlockedBy.approvalFollowedEvidence = false; }, /must record the evidence that unlocked its approval/],
      ["wave unlock wrong checkpoint", (c) => { c.spec.waves[1].unlockedBy.precedingCheckpointId = "baseline"; }, /must record the evidence that unlocked its approval/],
      ["wave unlock unhealthy", (c) => { c.spec.waves[0].unlockedBy.clusters[0].result = "fail"; }, /must record the evidence that unlocked its approval/],
      ["wave unlock cluster dropped", (c) => { c.spec.waves[0].unlockedBy.clusters.pop(); }, /must record the evidence that unlocked its approval/],
      ["advance undeclared", (c) => { delete c.spec.advance; }, /unlock evidence the receipt does not declare/],
      ["checkpoint set popped", (c) => { c.spec.checkpoints.pop(); }, /checkpoint set changed/],
      ["checkpoint expectation flipped", (c) => { c.spec.checkpoints[0].observations[0].expected = "converged-at-approved-revision"; }, /observation for .* changed/],
      ["observation result fail", (c) => { c.spec.checkpoints[2].observations[0].observation.result = "fail"; }, /observation for .* changed/],
      ["drift repair fail", (c) => { c.spec.driftRepair.clusters[0].result = "fail"; }, /drift repair changed/],
      ["drift deployment renamed", (c) => { c.spec.driftRepair.clusters[0].deployment = "kyverno-background-controller"; }, /drift repair changed/],
      ["cleanup fail", (c) => { c.spec.cleanup.results.policySpaces = "fail"; }, /cleanup did not pass/],
      ["carrier reintroduced", (c) => { c.spec.notes = "Argo CD reconciled the management cluster"; }, /naming Argo CD predates that design/],
      ["other carrier", (c) => { c.spec.notes = "Flux pulled the bundle"; }, /naming Flux predates that design/],
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
      "sveltos OCI delivery canary self-test passed: the plan's exactly-three departures with the clusterRefs, shared-Space, wave-order, and uppercase-Space refusals, the base and two per-cluster variants linked to it, the management record reviewed and approved on its own without a release, wave one approving and delivering the pilot's record alone while blockedDryRun reads the second cluster's record as gate-armed with zero approvals, the evidence-gated guard refusing an unhealthy checkpoint and an incomplete one, wave two unlocked by the pilot's own health and converging at a distinct release digest, the rendered summary carrying the second Space's digest and the word armed, the keep-alive cleanup record, the superseded-receipt recognition that returns false without throwing, and the receipt tamper battery",
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
  const planRoot = join(root, "examples", "sveltos", "kyverno-fleet");
  mkdirSync(planRoot, { recursive: true });
  for (const name of ["clusterprofile-base.yaml", "variants.yaml", "source-lock.yaml"]) {
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
        name: "hx-sveltos-fleet-pilot-20260813091500",
        removeWith: "kind delete cluster --name hx-sveltos-fleet-pilot-20260813091500",
      },
      {
        kind: "ConfigHub Space",
        name: "hx-sveltos-fleet-pilot-20260813091500",
        removeWith: "cub space delete hx-sveltos-fleet-pilot-20260813091500 --recursive-force",
      },
    ],
  };
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

function fakeRegistration(row) {
  return {
    method: "programmatic SveltosCluster registration",
    namespace: registrationNamespace,
    cluster: row.cluster,
    kindCluster: `${row.cluster}-selftest`,
    labels: { environment: "staging", "sveltos-agent": "present" },
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

function fakeManagementRegistration() {
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
    kubernetesVersion: "v1.35.0",
  };
}

// Synthesized checkpoints in chapter three's style: names carry a
// `-selftest` suffix so they read distinctly from the plan's logical cluster
// names, and the observation shape matches exactly what observeWorkload and
// observeUntouched return on a pass, so buildReceipt and verifyReceipt are
// exercised against the same shape a live run would produce.
function synthesizeCheckpoints(plan) {
  return [0, 1, 2].map((deliveredWaves) => ({
    id: deliveredWaves === 0 ? "baseline" : `after-wave-${deliveredWaves}`,
    deliveredWaves,
    observations: plan.clusters.map((row) => {
      const delivered = row.wave <= deliveredWaves;
      return {
        cluster: `${row.cluster}-selftest`,
        logicalCluster: row.cluster,
        environment: row.environment,
        wave: row.wave,
        expected: delivered ? "converged-at-approved-revision" : "untouched",
        expectedRevisionId: delivered ? row.revisions.baseline : null,
        observation: delivered ? fakeConvergedObservation() : fakeUntouchedObservation(),
      };
    }),
  }));
}

function fakeConvergedObservation() {
  return {
    result: "pass",
    clusterSummary: "projectsveltos/self-test-summary",
    helmFeatureStatus: "Provisioned",
    helmRelease: { name: "kyverno", namespace: "kyverno", chart: "kyverno-3.8.1", status: "deployed" },
    admissionReplicas: { desired: 3, available: 3 },
    deployments: [],
  };
}

function fakeUntouchedObservation() {
  return {
    result: "pass",
    state: "untouched",
    namespacePresent: false,
    deploymentCount: 0,
    helmReleaseCount: 0,
  };
}

function synthesizeDriftRepair(plan) {
  return {
    clusters: plan.clusters.map((row) => ({
      cluster: `${row.cluster}-selftest`,
      logicalCluster: row.cluster,
      deployment: admissionControllerDeployment,
      from: 3,
      droppedTo: 1,
      restoredTo: 3,
      result: "pass",
    })),
  };
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
    const strayFlag = unknownCubFlag(positionals, flags);
    if (strayFlag) return refuse(strayFlag);
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
          HeadRevisionNum: 1,
          ApplyGates: { "awaiting/triggers": true },
          ApprovedBy: [],
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
        ApprovedBy: [],
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
// Never exercised in this chapter's own walk, since this chapter never
// changes a stored record after it is reviewed; kept because it is part of
// the fake hub's verbatim shape.
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
    "--upgrade", "--allow-exists",
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
        // The live gateway answers not found for a Space with no release,
        // and Sveltos records the pull as failed. The fake says the same
        // thing so the runner's wait is proved to outlast that inert state
        // rather than refusing on it.
        summaries.set(profileName, {
          status: "Failed",
          failureMessage: `failed to pull OCI artifact oci://${configHubOciHost}/space/${space}:${releaseTag}: ${configHubOciHost}/space/${space}:${releaseTag}: not found`,
        });
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
