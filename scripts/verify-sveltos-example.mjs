#!/usr/bin/env node

// Chapter one's surface check. The example holds its fleet as one base record
// plus one variant per cluster, and this script verifies those reviewed files,
// the source lock, the chapter's committed receipts, and the READMEs. Both
// committed receipts predate the per-cluster shape; they are recognized as
// recorded and fill nothing, and the gateway re-record replaces the OCI
// delivery receipt. The hub lanes check the persistent demo Space against the
// reviewed base record and the committed README unit.

import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  check,
  parseDocs,
  readYaml,
  readYamlText,
  repoRoot,
  runCub,
  sha256File,
  toYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const cubContext = process.env.CUB_CONTEXT ?? "";
if (!["--verify", "--hub-record", "--hub-verify", "--self-test"].includes(mode)) {
  console.error(
    "Usage: node scripts/verify-sveltos-example.mjs [--verify|--hub-record|--hub-verify|--self-test]",
  );
  process.exit(1);
}

const surfaceFiles = {
  baseProfile: "examples/sveltos/kyverno-fleet/clusterprofile-base.yaml",
  variants: "examples/sveltos/kyverno-fleet/variants.yaml",
  sourceLock: "examples/sveltos/kyverno-fleet/source-lock.yaml",
  receipt: "examples/sveltos/kyverno-fleet/live-receipt.yaml",
  readme: "examples/sveltos/kyverno-fleet/README.md",
  ociReceipt: "runs/sveltos-oci-delivery-proof/receipt.yaml",
  readmeUnit:
    "data/helm-catalog-readmes/units/sveltos-kyverno-fleet-3-8-1-staging/readme.yaml",
  policy: "config-catalog/policies/catalog-standard.yaml",
};

const departurePaths = [
  "metadata.name",
  "spec.clusterSelector.matchLabels.cluster",
  "spec.stopMatchingBehavior",
];

// The recognition notes explain a recorded surface once per verification, not
// once per tamper case, so the self-test keeps them quiet.
function note(message) {
  if (mode !== "--self-test") console.log(message);
}

if (mode === "--self-test") {
  selfTest();
  console.log(
    "sveltos example self-test passed: fixture verification of the per-cluster base and variants, tamper refusals, the recorded receipts recognized as recorded, fake-hub verification, fake-hub refusals, and the record lane",
  );
} else {
  const paths = surfacePaths(repoRoot);
  let surfaces = loadSurfaces(paths);
  if (mode === "--hub-record") {
    recordHubPolicy(surfaces, liveHub);
    surfaces = loadSurfaces(paths);
  }
  verifyExample(surfaces);
  if (["--hub-record", "--hub-verify"].includes(mode)) {
    verifyHub(surfaces, liveHub);
  }
  console.log(
    ["--hub-record", "--hub-verify"].includes(mode)
      ? "verified live ConfigHub Sveltos Space, base record, README, and system-configuration approval policy"
      : "verified the Sveltos Kyverno fleet chapter: per-cluster base and variants, source lock, recorded receipts, and READMEs",
  );
}

function surfacePaths(root) {
  return Object.fromEntries(
    Object.entries(surfaceFiles).map(([name, file]) => [name, join(root, file)]),
  );
}

function loadSurfaces(paths) {
  return {
    paths,
    baseProfile: readYaml(paths.baseProfile),
    baseProfileText: readFileSync(paths.baseProfile, "utf8"),
    variants: readYaml(paths.variants),
    sourceLock: readYaml(paths.sourceLock),
    policy: readYaml(paths.policy),
    receipt: readYaml(paths.receipt),
    ociReceipt: readYaml(paths.ociReceipt),
    readmeUnit: readYaml(paths.readmeUnit),
    technicalReadmeText: readFileSync(paths.readme, "utf8").trimEnd(),
  };
}

function verifyExample(surfaces) {
  const {
    baseProfile,
    variants,
    sourceLock,
    policy,
    receipt,
    ociReceipt,
    readmeUnit,
    technicalReadmeText,
  } = surfaces;

  check(
    baseProfile.apiVersion === "config.projectsveltos.io/v1beta1",
    "Sveltos apiVersion changed",
  );
  check(baseProfile.kind === "ClusterProfile", "the base must be a ClusterProfile");
  check(
    baseProfile.metadata?.name === "kyverno-staging-base",
    "the base ClusterProfile name changed",
  );
  // The base reaches no cluster on its own: its selector carries exactly one
  // key, cluster, bound to a name no registration uses.
  const baseSelector = baseProfile.spec?.clusterSelector?.matchLabels ?? {};
  check(
    Object.keys(baseSelector).join(",") === "cluster"
      && baseSelector.cluster === "unassigned",
    "the base selector must match no registered cluster",
  );
  check(
    baseProfile.spec?.syncMode === "ContinuousWithDriftDetection",
    "Sveltos drift mode changed",
  );
  check(
    baseProfile.spec?.helmCharts?.length === 1,
    "the base must contain one Helm chart",
  );
  const chart = baseProfile.spec.helmCharts[0];
  check(chart.repositoryURL === "https://kyverno.github.io/kyverno/", "Kyverno repository changed");
  check(chart.chartName === "kyverno/kyverno", "Kyverno chart name changed");
  check(String(chart.chartVersion) === "3.8.1", "Kyverno chart version changed");
  check(chart.releaseName === "kyverno", "Kyverno release name changed");
  check(chart.releaseNamespace === "kyverno", "Kyverno namespace changed");
  const values = readYamlText(chart.values);
  check(values.admissionController?.replicas === 3, "Kyverno admission replica setting changed");
  check(values.replicaCount === undefined, "the base contains an unused generic replicaCount");

  // The variants declaration is the reviewed rollout: one record per cluster,
  // exactly three departures each, and the wave order carried on the records.
  check(
    variants.kind === "SveltosKyvernoFleetVariants",
    "the variants declaration kind changed",
  );
  const workloads = variants.spec?.workloads ?? [];
  check(workloads.length === 2, "the canary needs exactly two workload clusters");
  check(
    workloads.map((row) => row.wave).join(",") === "1,2",
    "the reviewed rollout order changed: the pilot carries wave one and the second cluster wave two",
  );
  const spaces = [variants.spec?.base?.space, ...workloads.map((row) => row.space)];
  check(
    new Set(spaces).size === spaces.length
      && spaces.every((space) => typeof space === "string"
        && space === space.toLowerCase()),
    "every record needs its own lowercase Space",
  );
  for (const row of workloads) {
    const departures = row.departures ?? {};
    check(
      Object.keys(departures).sort().join(",") === [...departurePaths].sort().join(","),
      `${row.cluster} must depart from the base in exactly its name, its selector line, and its removal behaviour`,
    );
    check(
      departures["spec.clusterSelector.matchLabels.cluster"] === row.cluster,
      `${row.cluster}'s selector departure must address its own cluster and nothing else`,
    );
    check(
      row.environment === "staging",
      `${row.cluster} left the staging environment this chapter tells`,
    );
  }
  check(
    variants.spec?.base?.reachesCluster === false
      && variants.spec?.management?.appliedOutOfBandWith === "kubectl",
    "the base and management boundary notes changed",
  );

  check(sourceLock.spec?.sveltos?.version === "v1.13.0", "Sveltos source version changed");
  check(
    /^[a-f0-9]{64}$/.test(String(sourceLock.spec?.sveltos?.manifestSha256 ?? "")),
    "Sveltos manifest checksum changed shape",
  );
  check(
    sourceLock.spec?.workload?.chart === "kyverno/kyverno"
      && String(sourceLock.spec.workload.chartVersion) === "3.8.1",
    "the workload chart pin changed",
  );

  // The first receipt records the v1.12.0 manual run on the earlier delivery
  // path. It is kept exactly as recorded: its hashes name files that predate
  // this shape, so they are held to their recorded form rather than
  // recomputed, and its honesty pins must never be rewritten into a claim the
  // run did not earn.
  check(receipt.kind === "SveltosFleetReceipt", "Sveltos receipt kind changed");
  check(
    /^[a-f0-9]{64}$/.test(String(receipt.spec?.source?.rawSha256 ?? ""))
      && /^[a-f0-9]{64}$/.test(String(receipt.spec?.source?.canonicalSha256 ?? "")),
    "the recorded source hashes changed shape",
  );
  check(
    receipt.spec?.configHub?.unit?.canonicalObjectMatchesSource === true,
    "ConfigHub source match changed",
  );
  check(receipt.spec?.configHub?.policy?.profile === "catalog-standard", "Sveltos policy profile changed");
  check(
    receipt.spec?.configHub?.space?.labels?.ResourceClass === "system-configuration",
    "Sveltos Space resource class changed",
  );
  check(
    receipt.spec?.configHub?.space?.labels?.SourceType === "sveltos",
    "Sveltos Space source type changed",
  );
  check(
    receipt.spec?.configHub?.policy?.reason === "system-configuration",
    "Sveltos approval reason changed",
  );
  const expectedPolicyChecks = policy.spec.approvalRequired.checks
    .map((item) => item.trigger)
    .sort();
  const recordedPolicyChecks = [...(receipt.spec?.configHub?.policy?.checks ?? [])].sort();
  check(
    JSON.stringify(recordedPolicyChecks) === JSON.stringify(expectedPolicyChecks),
    "Sveltos policy no longer matches the current approval-required checks",
  );
  check(
    receipt.spec.configHub.policy.checks.includes("platform/require-approval"),
    "Sveltos policy must require approval",
  );
  check(receipt.spec?.management?.helmFeatureStatus === "Provisioned", "Sveltos Helm result changed");
  check(receipt.spec?.workload?.helmRelease?.chart === "kyverno-3.8.1", "live Kyverno chart changed");
  check(receipt.spec?.driftTest?.result === "pass", "Sveltos drift test must stay recorded");
  check(
    receipt.status?.result === "partial",
    "the first Sveltos receipt must remain a historical partial result",
  );
  check(
    receipt.status?.automatedConfigHubDelivery === "not-run",
    "the first Sveltos receipt must not be rewritten as automated delivery",
  );
  check(receipt.status?.multiClusterPromotionWave === "not-run", "fleet promotion is overclaimed");
  note(
    "chapter one's first receipt records the v1.12.0 manual run on the earlier delivery path; it stays as recorded",
  );

  // Chapter two's receipt is superseded until the gateway re-record: the old
  // recording widened one profile with a selector change, which this example
  // no longer does anywhere. A new-shape receipt is held to the base it
  // claims to govern; its full verification lives in the chapter's runner.
  if (ociReceipt.spec?.variants === undefined) {
    check(
      ociReceipt.kind === "SveltosOciDeliveryProofReceipt"
        && ociReceipt.status?.result === "pass",
      "Sveltos OCI delivery receipt changed",
    );
    note(
      "chapter two's receipt was recorded on the earlier delivery path and predates the per-cluster design; it awaits a gateway re-record",
    );
  } else {
    check(
      ociReceipt.kind === "SveltosOciDeliveryProofReceipt"
        && ociReceipt.status?.result === "pass"
        && ociReceipt.spec?.source?.base?.rawSha256
        === sha256File(surfaces.paths.baseProfile),
      "Sveltos OCI delivery receipt no longer records the reviewed base",
    );
  }

  check(
    technicalReadmeText.includes("One record per cluster")
      && technicalReadmeText.includes("## The canary, without a selector edit")
      && technicalReadmeText.includes("gate-armed")
      && !technicalReadmeText.includes("removes only the rollout label"),
    "the chapter README must tell the per-cluster canary rather than the selector widening",
  );

  // The README unit is generated for the persistent demo Space and kept as
  // recorded. One recorded on the earlier path is recognized; a regenerated
  // one must tell the per-cluster shape.
  check(readmeUnit.kind === "HelmCatalogDemoReadme", "Sveltos README Unit kind changed");
  check(
    readmeUnit.spec?.space === receipt.spec.configHub.space.slug,
    "Sveltos README Unit points at the wrong Space",
  );
  const readmeText = readmeUnit.spec?.markdown?.trimEnd() ?? "";
  check(
    readmeText.includes("requires approval before apply"),
    "Sveltos Hub README must explain why approval is required",
  );
  if (readmeText.includes("Argo CD")) {
    note(
      "the demo Space README unit was recorded on the earlier delivery path; it awaits regeneration with the per-cluster story",
    );
  } else {
    check(
      readmeText.includes("one record per cluster")
        && readmeText.includes("OCI gateway"),
      "a regenerated Hub README must tell the per-cluster gateway story",
    );
  }
}

function verifyHub(surfaces, hub) {
  const { receipt, readmeUnit, baseProfileText } = surfaces;
  const readmeText = readmeUnit.spec?.markdown?.trimEnd() ?? "";
  const spaceSlug = receipt.spec.configHub.space.slug;
  const space = JSON.parse(hub(["space", "get", spaceSlug, "-o", "json"])).Space;
  check(space.SpaceID === receipt.spec.configHub.space.id, "live Sveltos Space ID changed");
  check(
    space.TriggerFilterID === receipt.spec.configHub.policy.filterId,
    "live Sveltos policy filter changed",
  );
  check(space.Labels?.ApplyPolicyProfile === "catalog-standard", "live Sveltos policy label changed");
  check(
    space.Labels?.ResourceClass === "system-configuration",
    "live Sveltos Space resource class changed",
  );
  check(space.Labels?.SourceType === "sveltos", "live Sveltos source type changed");

  // The demo Space's record must hold the reviewed base, so the live check
  // recomputes from the committed file rather than trusting a recorded hash.
  const unit = JSON.parse(
    hub(["unit", "get", receipt.spec.configHub.unit.slug, "--space", spaceSlug, "-o", "json"]),
  ).Unit;
  check(unit.UnitID === receipt.spec.configHub.unit.id, "live Sveltos Unit ID changed");
  const unitText = Buffer.from(unit.Data, "base64").toString("utf8");
  check(
    canonicalHash(unitText) === canonicalHash(baseProfileText),
    "the live Sveltos Unit differs from the reviewed base record",
  );

  const readme = JSON.parse(hub(["unit", "get", "readme", "--space", spaceSlug, "-o", "json"])).Unit;
  check(readme.UnitID === receipt.spec.configHub.readme.id, "live Sveltos README Unit ID changed");
  const liveReadmeUnit = readYamlText(Buffer.from(readme.Data, "base64").toString("utf8"));
  check(
    liveReadmeUnit.spec?.markdown === readmeText,
    "live Sveltos README text differs from source",
  );

  const units = JSON.parse(hub(["unit", "list", "--space", spaceSlug, "--quiet", "-o", "json"]));
  const readmeSlugs = units
    .map((item) => item.Unit?.Slug)
    .filter((slug) => slug?.toLowerCase().includes("readme"));
  check(
    readmeSlugs.length === 1 && readmeSlugs[0] === "readme",
    `live Sveltos Space has README Units: ${readmeSlugs.join(", ") || "(none)"}`,
  );
}

function recordHubPolicy(surfaces, hub) {
  const { paths, policy, receipt } = surfaces;
  const spaceSlug = receipt.spec.configHub.space.slug;
  const space = JSON.parse(hub(["space", "get", spaceSlug, "-o", "json"])).Space;
  check(space.SpaceID === receipt.spec.configHub.space.id, "live Sveltos Space ID changed");
  check(
    space.Labels?.ResourceClass === "system-configuration",
    "refusing to record Sveltos without ResourceClass=system-configuration",
  );
  check(
    space.Labels?.SourceType === "sveltos",
    "refusing to record Sveltos without SourceType=sveltos",
  );
  const readme = JSON.parse(
    hub(["unit", "get", "readme", "--space", spaceSlug, "-o", "json"]),
  ).Unit;
  const next = structuredClone(receipt);
  next.spec.verifiedAt = new Date().toISOString();
  next.spec.configHub.space.labels = space.Labels;
  next.spec.configHub.readme = {
    slug: "readme",
    id: readme.UnitID,
    dataHash: readme.DataHash,
    headRevision: readme.HeadRevisionNum,
    source: "data/helm-catalog-readmes/units/sveltos-kyverno-fleet-3-8-1-staging/readme.yaml",
  };
  next.spec.configHub.policy = {
    profile: policy.metadata.name,
    filter: policy.spec.approvalRequired.filter,
    filterId: space.TriggerFilterID,
    reason: "system-configuration",
    checks: policy.spec.approvalRequired.checks.map((item) => item.trigger),
  };
  delete next.status.baselinePolicyAssigned;
  next.status.approvalRequiredPolicyAssigned = "pass";
  writeFileSync(paths.receipt, `${toYaml(next)}\n`);
  return next;
}

function liveHub(args) {
  return runCub(cubContext ? ["--context", cubContext, ...args] : args);
}

function canonicalHash(text) {
  return createHash("sha256").update(JSON.stringify(parseDocs(text))).digest("hex");
}

function selfTest() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-example-self-test-"));
  try {
    for (const file of Object.values(surfaceFiles)) {
      const destination = join(fixtureRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repoRoot, file), destination);
    }
    const paths = surfacePaths(fixtureRoot);
    const pristine = loadSurfaces(paths);
    verifyExample(pristine);

    const tampers = [
      ["profile identity", (s) => { s.baseProfile.kind = "Profile"; }, /must be a ClusterProfile/],
      ["base selector fans out", (s) => { s.baseProfile.spec.clusterSelector.matchLabels = { environment: "staging" }; }, /must match no registered cluster/],
      ["base selector assigned", (s) => { s.baseProfile.spec.clusterSelector.matchLabels.cluster = "hx-sveltos-fleet-pilot"; }, /must match no registered cluster/],
      ["drift mode", (s) => { s.baseProfile.spec.syncMode = "OneTime"; }, /drift mode changed/],
      ["chart version", (s) => { s.baseProfile.spec.helmCharts[0].chartVersion = "9.9.9"; }, /chart version changed/],
      ["replica values", (s) => { s.baseProfile.spec.helmCharts[0].values = "admissionController:\n  replicas: 1\n"; }, /admission replica setting changed/],
      ["generic replicaCount", (s) => { s.baseProfile.spec.helmCharts[0].values = "admissionController:\n  replicas: 3\nreplicaCount: 3\n"; }, /unused generic replicaCount/],
      ["third workload", (s) => { s.variants.spec.workloads.push(structuredClone(s.variants.spec.workloads[1])); }, /exactly two workload clusters/],
      ["wave order", (s) => { s.variants.spec.workloads[1].wave = 1; }, /reviewed rollout order changed/],
      ["selector departure", (s) => { s.variants.spec.workloads[0].departures["spec.clusterSelector.matchLabels.cluster"] = "some-other-cluster"; }, /must address its own cluster and nothing else/],
      ["departure set", (s) => { delete s.variants.spec.workloads[1].departures["spec.stopMatchingBehavior"]; }, /exactly its name, its selector line, and its removal behaviour/],
      ["shared space", (s) => { s.variants.spec.workloads[1].space = s.variants.spec.workloads[0].space; }, /its own lowercase Space/],
      ["uppercase space", (s) => { s.variants.spec.workloads[1].space = "Sveltos-Kyverno-Fleet-Second"; }, /its own lowercase Space/],
      ["management boundary", (s) => { s.variants.spec.management.appliedOutOfBandWith = "the gateway"; }, /boundary notes changed/],
      ["source-lock version", (s) => { s.sourceLock.spec.sveltos.version = "v9.9.9"; }, /source version changed/],
      ["manifest checksum", (s) => { s.sourceLock.spec.sveltos.manifestSha256 = "not-a-hash"; }, /manifest checksum changed shape/],
      ["workload pin", (s) => { s.sourceLock.spec.workload.chartVersion = "9.9.9"; }, /workload chart pin changed/],
      ["source hash shape", (s) => { s.receipt.spec.source.rawSha256 = "not-a-hash"; }, /recorded source hashes changed shape/],
      ["policy checks", (s) => { s.receipt.spec.configHub.policy.checks.pop(); }, /no longer matches the current approval-required checks/],
      ["resource class", (s) => { s.receipt.spec.configHub.space.labels.ResourceClass = "application"; }, /Space resource class changed/],
      ["historical result", (s) => { s.receipt.status.result = "pass"; }, /must remain a historical partial result/],
      ["promotion overclaim", (s) => { s.receipt.status.multiClusterPromotionWave = "pass"; }, /fleet promotion is overclaimed/],
      ["drift result", (s) => { s.receipt.spec.driftTest.result = "fail"; }, /drift test must stay recorded/],
      ["technical README", (s) => { s.technicalReadmeText = s.technicalReadmeText.replace("## The canary, without a selector edit", "## The canary"); }, /must tell the per-cluster canary/],
      ["OCI receipt result", (s) => { s.ociReceipt.status.result = "fail"; }, /OCI delivery receipt changed/],
      ["new-shape OCI receipt source", (s) => {
        s.ociReceipt.spec.variants = [];
        s.ociReceipt.spec.source = { base: { rawSha256: "0".repeat(64) } };
      }, /no longer records the reviewed base/],
      ["README Unit space", (s) => { s.readmeUnit.spec.space = "some-other-space"; }, /points at the wrong Space/],
      ["README approval text", (s) => { s.readmeUnit.spec.markdown = s.readmeUnit.spec.markdown.replace("requires approval before apply", "applies immediately"); }, /must explain why approval is required/],
      ["regenerated README underclaims", (s) => { s.readmeUnit.spec.markdown = "This Space requires approval before apply. Nothing else."; }, /must tell the per-cluster gateway story/],
    ];
    for (const [label, tamper, pattern] of tampers) {
      const tampered = cloneSurfaces(pristine);
      tamper(tampered);
      expectFailure(() => verifyExample(tampered), pattern, label);
    }

    const fakeHub = createFakeExampleHub(pristine);
    verifyHub(pristine, fakeHub.handle);

    const hubTampers = [
      ["space identity", "spaceIdMismatch", /live Sveltos Space ID changed/],
      ["policy filter", "filterIdMismatch", /live Sveltos policy filter changed/],
      ["policy label", "dropPolicyLabel", /live Sveltos policy label changed/],
      ["unit identity", "unitIdMismatch", /live Sveltos Unit ID changed/],
      ["unit data", "unitDataDiffers", /differs from the reviewed base record/],
      ["readme text", "readmeTextDiffers", /live Sveltos README text differs from source/],
      ["duplicate readme", "extraReadmeUnit", /live Sveltos Space has README Units/],
    ];
    for (const [label, knob, pattern] of hubTampers) {
      fakeHub.state[knob] = true;
      expectFailure(() => verifyHub(pristine, fakeHub.handle), pattern, `hub ${label}`);
      fakeHub.state[knob] = false;
    }

    fakeHub.state.dropResourceClass = true;
    expectFailure(
      () => recordHubPolicy(pristine, fakeHub.handle),
      /refusing to record Sveltos without ResourceClass=system-configuration/,
      "record without resource class",
    );
    fakeHub.state.dropResourceClass = false;
    fakeHub.state.dropSourceType = true;
    expectFailure(
      () => recordHubPolicy(pristine, fakeHub.handle),
      /refusing to record Sveltos without SourceType=sveltos/,
      "record without source type",
    );
    fakeHub.state.dropSourceType = false;

    const recorded = recordHubPolicy(pristine, fakeHub.handle);
    check(
      recorded.status.approvalRequiredPolicyAssigned === "pass"
        && !("baselinePolicyAssigned" in recorded.status)
        && recorded.spec.configHub.policy.filterId
          === pristine.receipt.spec.configHub.policy.filterId,
      "the record lane did not rewrite the policy block from the hub observation",
    );
    const reloaded = loadSurfaces(paths);
    verifyExample(reloaded);
    verifyHub(reloaded, fakeHub.handle);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function cloneSurfaces(surfaces) {
  return {
    ...structuredClone({ ...surfaces, paths: undefined }),
    paths: surfaces.paths,
  };
}

function createFakeExampleHub(surfaces) {
  const { paths, receipt } = surfaces;
  const configHub = receipt.spec.configHub;
  const profileBytes = readFileSync(paths.baseProfile);
  const readmeUnitBytes = readFileSync(paths.readmeUnit);
  const tamperedProfile = readFileSync(paths.baseProfile, "utf8")
    .replace("replicas: 3", "replicas: 1");
  const tamperedReadmeUnit = `${toYaml({
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "HelmCatalogDemoReadme",
    spec: { space: configHub.space.slug, markdown: "A different README." },
  })}\n`;
  const state = {
    spaceIdMismatch: false,
    filterIdMismatch: false,
    dropPolicyLabel: false,
    dropResourceClass: false,
    dropSourceType: false,
    unitIdMismatch: false,
    unitDataDiffers: false,
    readmeTextDiffers: false,
    extraReadmeUnit: false,
  };
  const flip = (value) => `${value}`.endsWith("0") ? `${value.slice(0, -1)}1` : `${value.slice(0, -1)}0`;
  const handle = (args) => {
    const [entity, verb] = args;
    if (entity === "space" && verb === "get") {
      const labels = { ...configHub.space.labels };
      if (state.dropPolicyLabel) delete labels.ApplyPolicyProfile;
      if (state.dropResourceClass) delete labels.ResourceClass;
      if (state.dropSourceType) delete labels.SourceType;
      return JSON.stringify({
        Space: {
          Slug: configHub.space.slug,
          SpaceID: state.spaceIdMismatch ? flip(configHub.space.id) : configHub.space.id,
          TriggerFilterID: state.filterIdMismatch
            ? flip(configHub.policy.filterId)
            : configHub.policy.filterId,
          Labels: labels,
        },
      });
    }
    if (entity === "unit" && verb === "get" && args[2] === configHub.unit.slug) {
      return JSON.stringify({
        Unit: {
          Slug: configHub.unit.slug,
          UnitID: state.unitIdMismatch ? flip(configHub.unit.id) : configHub.unit.id,
          DataHash: configHub.unit.dataHash,
          Data: Buffer.from(state.unitDataDiffers ? tamperedProfile : profileBytes)
            .toString("base64"),
        },
      });
    }
    if (entity === "unit" && verb === "get" && args[2] === "readme") {
      return JSON.stringify({
        Unit: {
          Slug: "readme",
          UnitID: configHub.readme.id,
          DataHash: configHub.readme.dataHash,
          HeadRevisionNum: configHub.readme.headRevision,
          Data: Buffer.from(state.readmeTextDiffers ? tamperedReadmeUnit : readmeUnitBytes)
            .toString("base64"),
        },
      });
    }
    if (entity === "unit" && verb === "list") {
      const rows = [
        { Unit: { Slug: configHub.unit.slug } },
        { Unit: { Slug: "readme" } },
      ];
      if (state.extraReadmeUnit) rows.push({ Unit: { Slug: "readme-old" } });
      return JSON.stringify(rows);
    }
    throw new Error(`the self-test fake hub refuses: cub ${args.join(" ")}`);
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
