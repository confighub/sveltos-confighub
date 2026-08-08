#!/usr/bin/env node

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
  profile: "examples/sveltos/kyverno-fleet/clusterprofile.yaml",
  pilotProfile: "examples/sveltos/kyverno-fleet/clusterprofile-pilot.yaml",
  sourceLock: "examples/sveltos/kyverno-fleet/source-lock.yaml",
  receipt: "examples/sveltos/kyverno-fleet/live-receipt.yaml",
  readme: "examples/sveltos/kyverno-fleet/README.md",
  ociReceipt: "runs/sveltos-oci-delivery-proof/receipt.yaml",
  readmeUnit:
    "data/helm-catalog-readmes/units/sveltos-kyverno-fleet-3-8-1-staging/readme.yaml",
  policy: "config-catalog/policies/catalog-standard.yaml",
};

if (mode === "--self-test") {
  selfTest();
  console.log(
    "sveltos example self-test passed: fixture verification, tamper refusals, fake-hub verification, fake-hub refusals, and the record lane",
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
      ? "verified live ConfigHub Sveltos Space, source object, README, and system-configuration approval policy"
      : "verified Sveltos v1.12.0 Kyverno fleet receipt and source lock",
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
    profile: readYaml(paths.profile),
    profileText: readFileSync(paths.profile, "utf8"),
    pilotProfile: readYaml(paths.pilotProfile),
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
    paths,
    profile,
    pilotProfile,
    sourceLock,
    policy,
    receipt,
    ociReceipt,
    readmeUnit,
    technicalReadmeText,
  } = surfaces;
  const readmeText = readmeUnit.spec?.markdown?.trimEnd() ?? "";

  check(profile.apiVersion === "config.projectsveltos.io/v1beta1", "Sveltos apiVersion changed");
  check(profile.kind === "ClusterProfile", "Sveltos example must be a ClusterProfile");
  check(profile.metadata?.name === "kyverno-staging", "Sveltos ClusterProfile name changed");
  check(
    profile.spec?.clusterSelector?.matchLabels?.environment === "staging",
    "Sveltos cluster selector changed",
  );
  check(
    pilotProfile.spec?.clusterSelector?.matchLabels?.environment === "staging"
      && pilotProfile.spec.clusterSelector.matchLabels.rollout === "pilot",
    "Sveltos pilot selector changed",
  );
  check(
    profile.spec?.syncMode === "ContinuousWithDriftDetection",
    "Sveltos drift mode changed",
  );
  check(profile.spec?.helmCharts?.length === 1, "Sveltos example must contain one Helm chart");
  const chart = profile.spec.helmCharts[0];
  check(chart.repositoryURL === "https://kyverno.github.io/kyverno/", "Kyverno repository changed");
  check(chart.chartName === "kyverno/kyverno", "Kyverno chart name changed");
  check(String(chart.chartVersion) === "3.8.1", "Kyverno chart version changed");
  check(chart.releaseName === "kyverno", "Kyverno release name changed");
  check(chart.releaseNamespace === "kyverno", "Kyverno namespace changed");
  const values = readYamlText(chart.values);
  check(values.admissionController?.replicas === 3, "Kyverno admission replica setting changed");
  check(values.replicaCount === undefined, "Sveltos example contains an unused generic replicaCount");

  check(sourceLock.spec?.sveltos?.version === "v1.12.0", "Sveltos source version changed");
  check(
    sourceLock.spec?.sveltos?.addonControllerCommit ===
      "b528b72dedf369566470709796d23d93fa1827b1",
    "Sveltos addon-controller commit changed",
  );
  check(
    sourceLock.spec?.sveltos?.manifestSha256 ===
      "7ce065d86662c9cc431c07021d5b1cbe812b00f7ddde57dc465a44b03f5a7280",
    "Sveltos manifest checksum changed",
  );
  check(
    sourceLock.spec?.sveltosctl?.darwinArm64Sha256 ===
      "7a33043ceb0043f6f0e9b52bd9a6b79de8a4dc555d9f6e023a5a0ad5e3ac21f9",
    "sveltosctl checksum changed",
  );

  check(receipt.kind === "SveltosFleetReceipt", "Sveltos receipt kind changed");
  check(receipt.spec?.source?.rawSha256 === sha256File(paths.profile), "Sveltos source hash changed");
  const canonicalSource = canonicalHash(surfaces.profileText);
  check(
    receipt.spec?.source?.canonicalSha256 === canonicalSource,
    "Sveltos canonical source hash changed",
  );
  check(receipt.spec?.source?.serverSideDryRun === "pass", "Sveltos API validation must stay recorded");
  check(receipt.spec?.configHub?.unit?.canonicalObjectMatchesSource === true, "ConfigHub source match changed");
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
  check(receipt.spec?.workload?.deployments?.length === 4, "live Kyverno deployment count changed");
  check(
    receipt.spec.workload.deployments.every((item) => item.desired === item.available),
    "a recorded Kyverno deployment is not available",
  );
  check(receipt.spec?.driftTest?.result === "pass", "Sveltos drift test must stay recorded");
  check(receipt.spec?.driftTest?.changedReplicas === 1, "Sveltos drift fixture changed");
  check(receipt.spec?.driftTest?.restoredReplicas === 3, "Sveltos drift recovery changed");
  check(
    receipt.status?.result === "partial",
    "the first Sveltos receipt must remain a historical partial result",
  );
  check(
    receipt.status?.automatedConfigHubDelivery === "not-run",
    "the first Sveltos receipt must not be rewritten as automated delivery",
  );
  check(receipt.status?.multiClusterPromotionWave === "not-run", "fleet promotion is overclaimed");
  check(
    technicalReadmeText.includes(
      "The current OCI delivery run used two workload clusters.",
    )
      && technicalReadmeText.includes("## What remains"),
    "Sveltos README must explain the newer delivery proof and its limits",
  );
  check(
    ociReceipt.kind === "SveltosOciDeliveryProofReceipt"
      && ociReceipt.status?.result === "pass"
      && ociReceipt.spec?.source?.rawSha256 === sha256File(paths.pilotProfile),
    "Sveltos OCI delivery receipt or source record changed",
  );
  check(
    ociReceipt.spec?.configHubReview?.pilot?.beforeApproval?.result === "blocked"
      && ociReceipt.spec.configHubReview.pilot.afterApproval?.result === "allowed"
      && ociReceipt.spec.configHubReview.pilot.approvedDataMatchesSource === true
      && ociReceipt.spec.configHubReview.pilot.portableRelease
        ?.objectsMatchApprovedData === true
      && ociReceipt.spec.configHubReview.pilot.portableRelease.anonymousPull === true
      && ociReceipt.spec.configHubReview.fleet?.beforeApproval?.result === "blocked"
      && ociReceipt.spec.configHubReview.fleet.afterApproval?.result === "allowed"
      && ociReceipt.spec.configHubReview.fleet.change?.path
        === "spec.clusterSelector.matchLabels.rollout"
      && ociReceipt.spec.configHubReview.fleet.portableRelease
        ?.objectsMatchApprovedData === true,
    "Sveltos OCI review or portable package evidence changed",
  );
  check(
    ociReceipt.spec?.management?.waves?.pilot?.argo?.result === "pass"
      && ociReceipt.spec.management.waves.pilot.targets?.length === 2
      && ociReceipt.spec.management.waves.pilot.targets
        .filter((target) => target.selected).length === 1
      && ociReceipt.spec.management.waves.fleet?.argo?.result === "pass"
      && ociReceipt.spec.management.waves.fleet.targets?.length === 2
      && ociReceipt.spec.management.waves.fleet.targets.every(
        (target) =>
          target.selected === true
          && target.reconciliation?.helmFeatureStatus === "Provisioned",
      )
      && ociReceipt.spec.workloads?.length === 2
      && ociReceipt.spec.workloads.every(
        (workload) => workload.drift?.result === "pass",
      ),
    "Sveltos OCI delivery, reconciliation, or drift evidence changed",
  );
  check(
    Object.values(ociReceipt.spec?.cleanup ?? {}).every(
      (result) => result === "pass",
    ),
    "Sveltos OCI delivery cleanup did not pass",
  );
  check(readmeUnit.kind === "HelmCatalogDemoReadme", "Sveltos README Unit kind changed");
  check(
    readmeUnit.spec?.space === receipt.spec.configHub.space.slug,
    "Sveltos README Unit points at the wrong Space",
  );
  check(
    receipt.spec?.configHub?.readme?.source
      === "data/helm-catalog-readmes/units/sveltos-kyverno-fleet-3-8-1-staging/readme.yaml",
    "Sveltos README receipt source changed",
  );
  check(
    readmeText.includes("requires approval before apply"),
    "Sveltos Hub README must explain why approval is required",
  );
  check(
    readmeText.includes("portable OCI")
      && readmeText.includes("Argo CD")
      && !readmeText.includes("delivery was manual"),
    "Sveltos Hub README must explain the current OCI delivery proof",
  );
}

function verifyHub(surfaces, hub) {
  const { receipt, readmeUnit } = surfaces;
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

  const unit = JSON.parse(
    hub(["unit", "get", receipt.spec.configHub.unit.slug, "--space", spaceSlug, "-o", "json"]),
  ).Unit;
  check(unit.UnitID === receipt.spec.configHub.unit.id, "live Sveltos Unit ID changed");
  check(unit.DataHash === receipt.spec.configHub.unit.dataHash, "live Sveltos Unit data hash changed");
  const unitText = Buffer.from(unit.Data, "base64").toString("utf8");
  check(canonicalHash(unitText) === receipt.spec.source.canonicalSha256, "live Sveltos Unit differs from source");

  const readme = JSON.parse(hub(["unit", "get", "readme", "--space", spaceSlug, "-o", "json"])).Unit;
  check(readme.UnitID === receipt.spec.configHub.readme.id, "live Sveltos README Unit ID changed");
  check(
    readme.DataHash === receipt.spec.configHub.readme.dataHash,
    "live Sveltos README Unit data hash changed",
  );
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
      ["profile identity", (s) => { s.profile.kind = "Profile"; }, /must be a ClusterProfile/],
      ["profile selector", (s) => { s.profile.spec.clusterSelector.matchLabels.environment = "production"; }, /cluster selector changed/],
      ["pilot selector", (s) => { s.pilotProfile.spec.clusterSelector.matchLabels.rollout = "everything"; }, /pilot selector changed/],
      ["drift mode", (s) => { s.profile.spec.syncMode = "OneTime"; }, /drift mode changed/],
      ["chart version", (s) => { s.profile.spec.helmCharts[0].chartVersion = "9.9.9"; }, /chart version changed/],
      ["replica values", (s) => { s.profile.spec.helmCharts[0].values = "admissionController:\n  replicas: 1\n"; }, /admission replica setting changed/],
      ["generic replicaCount", (s) => { s.profile.spec.helmCharts[0].values = "admissionController:\n  replicas: 3\nreplicaCount: 3\n"; }, /unused generic replicaCount/],
      ["source-lock version", (s) => { s.sourceLock.spec.sveltos.version = "v9.9.9"; }, /source version changed/],
      ["manifest checksum", (s) => { s.sourceLock.spec.sveltos.manifestSha256 = "0".repeat(64); }, /manifest checksum changed/],
      ["source hash", (s) => { s.receipt.spec.source.rawSha256 = "0".repeat(64); }, /source hash changed/],
      ["canonical hash", (s) => { s.receipt.spec.source.canonicalSha256 = "0".repeat(64); }, /canonical source hash changed/],
      ["policy checks", (s) => { s.receipt.spec.configHub.policy.checks.pop(); }, /no longer matches the current approval-required checks/],
      ["resource class", (s) => { s.receipt.spec.configHub.space.labels.ResourceClass = "application"; }, /Space resource class changed/],
      ["historical result", (s) => { s.receipt.status.result = "pass"; }, /must remain a historical partial result/],
      ["promotion overclaim", (s) => { s.receipt.status.multiClusterPromotionWave = "pass"; }, /fleet promotion is overclaimed/],
      ["drift result", (s) => { s.receipt.spec.driftTest.result = "fail"; }, /drift test must stay recorded/],
      ["technical README", (s) => { s.technicalReadmeText = s.technicalReadmeText.replace("## What remains", "## Done"); }, /must explain the newer delivery proof and its limits/],
      ["OCI receipt result", (s) => { s.ociReceipt.status.result = "fail"; }, /OCI delivery receipt or source record changed/],
      ["OCI review evidence", (s) => { s.ociReceipt.spec.configHubReview.pilot.beforeApproval.result = "allowed"; }, /OCI review or portable package evidence changed/],
      ["OCI wave evidence", (s) => { s.ociReceipt.spec.management.waves.fleet.targets[0].selected = false; }, /OCI delivery, reconciliation, or drift evidence changed/],
      ["OCI cleanup", (s) => { s.ociReceipt.spec.cleanup = { registry: "fail" }; }, /OCI delivery cleanup did not pass/],
      ["README Unit space", (s) => { s.readmeUnit.spec.space = "some-other-space"; }, /points at the wrong Space/],
      ["README approval text", (s) => { s.readmeUnit.spec.markdown = s.readmeUnit.spec.markdown.replace("requires approval before apply", "applies immediately"); }, /must explain why approval is required/],
      ["README delivery text", (s) => { s.readmeUnit.spec.markdown = s.readmeUnit.spec.markdown.replaceAll("portable OCI", "manual export"); }, /must explain the current OCI delivery proof/],
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
      ["unit data hash", "unitDataHashMismatch", /live Sveltos Unit data hash changed/],
      ["unit data", "unitDataDiffers", /live Sveltos Unit differs from source/],
      ["readme data hash", "readmeDataHashMismatch", /live Sveltos README Unit data hash changed/],
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
  const profileBytes = readFileSync(paths.profile);
  const readmeUnitBytes = readFileSync(paths.readmeUnit);
  const tamperedProfile = readFileSync(paths.profile, "utf8")
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
    unitDataHashMismatch: false,
    unitDataDiffers: false,
    readmeDataHashMismatch: false,
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
          DataHash: state.unitDataHashMismatch
            ? flip(configHub.unit.dataHash)
            : configHub.unit.dataHash,
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
          DataHash: state.readmeDataHashMismatch
            ? flip(configHub.readme.dataHash)
            : configHub.readme.dataHash,
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
