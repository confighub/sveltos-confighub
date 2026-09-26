// The shape every governed chapter in this repository shares.
//
// A fleet is held as one base record plus one variant per cluster. The base
// carries what every cluster shares and reaches no cluster on its own. Each
// variant is a clone of the base, linked to it, carrying only the fields that
// genuinely differ for its own cluster, one of which is a clusterRefs entry
// naming that cluster's SveltosCluster and nothing else.
//
// This lived inside the environment rollout runner first. It lives here now
// because a fleet design that only one chapter implements is a design that
// silently stops being true, which is exactly what happened: chapter three was
// reworked to one record per cluster and chapters four and five kept governing
// one record per environment for weeks without anything noticing.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { check, parseDocs, sha256 } from "./proof-common.mjs";

// A ConfigHub release is served over the OCI distribution API, and OCI
// repository names are lowercase, so any Space that will be published has to be
// lowercase too.
export function spaceName(candidate) {
  return String(candidate).toLowerCase();
}

export function assertPublishableSpaceName(space, probeRecord) {
  check(
    space === space.toLowerCase(),
    `refusing to create ${space}: OCI repository names are lowercase, so a Space carrying uppercase cannot be addressed through the gateway; see ${probeRecord}`,
  );
}

export function parentPath(path) {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(0, index);
}

export function isScalarMap(node) {
  return Boolean(node)
    && typeof node === "object"
    && !Array.isArray(node)
    && Object.values(node).every(
      (value) => value === null || typeof value !== "object",
    );
}

export function readPath(value, path) {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

export function writePath(value, path, next, createMissing = false) {
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

export function applyDepartures(baseDoc, departures) {
  const doc = structuredClone(baseDoc);
  for (const [path, value] of Object.entries(departures)) {
    writePath(doc, path, value, true);
  }
  return doc;
}

// Two fields collide when a change to the base and a departure would both write
// them. They also collide when they are different keys of the same map of
// scalars, because that map merges as a whole and the departure wins with
// nothing said about it.
export function fieldsCollide(left, right, doc) {
  if (left === right) return true;
  if (left.startsWith(`${right}.`) || right.startsWith(`${left}.`)) return true;
  const leftParent = parentPath(left);
  const rightParent = parentPath(right);
  if (!leftParent || leftParent !== rightParent) return false;
  return isScalarMap(readPath(doc, leftParent));
}

export function identity(document) {
  return [
    document.apiVersion ?? "",
    document.kind ?? "",
    document.metadata?.namespace ?? "",
    document.metadata?.name ?? "",
  ].join("|");
}

export function canonicalValue(value) {
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

export function canonicalDocs(documents) {
  return JSON.stringify(
    documents
      .map((document) => ({
        identity: identity(document),
        document: canonicalValue(document),
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
  );
}

export function storedData(unit) {
  check(unit.Data, `${unit.SpaceSlug}/${unit.Slug} has no stored data`);
  return Buffer.from(unit.Data, "base64").toString("utf8");
}

export function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function normalizeDigest(value) {
  const match = String(value ?? "").match(/sha256:[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : "";
}

// The fakes parse flags permissively, which is how a flag belonging to one
// verb leaked into another and every self-test stayed green while the live
// CLI refused. The surface the runners use is small and known, so a fake
// hub refuses any flag outside it, in the CLI's own words.
//
// The ChangeWorkflow verbs are listed with exactly the flags chapter three
// uses, each one present in cub v0.6.2's own help: a component, a Space
// attached to it, a variant labelled with its stage, one workflow, one change
// order, a promotion into a named stage, and a release pinned to where the
// change arrived.
const knownCubFlags = new Map([
  ["auth get-token", []],
  ["context get", ["o"]],
  ["filter get", ["space", "o"]],
  ["trigger get", ["space", "o"]],
  ["component create", ["label", "quiet"]],
  ["component update", ["patch", "change-workflow-required", "allowed-change-workflow", "quiet"]],
  ["component get", ["o"]],
  ["component delete", ["quiet"]],
  ["space create", ["label", "trigger-filter", "where-trigger", "component", "quiet"]],
  ["space update", ["release-target", "refresh-triggers", "patch", "component", "quiet"]],
  ["space get", ["o"]],
  ["space delete", ["recursive-force", "quiet"]],
  ["variant create", ["space-pattern", "stage", "quiet"]],
  ["variant promote", ["change-order", "target-stage", "change-desc", "quiet"]],
  // Approval is an attestation now: of a change order's change in one stage,
  // or of what a release of one Space would bundle.
  ["variant approve", ["change-order", "stage", "quiet"]],
  ["changeworkflow create", ["space", "stage", "prerequisites", "filename", "quiet"]],
  ["changeworkflow get", ["space", "o"]],
  ["changeorder create", ["space", "change-workflow", "description", "quiet"]],
  ["changeorder get", ["space", "o"]],
  ["target create", ["space", "provider", "toolchain", "label", "allow-exists", "quiet"]],
  ["target get", ["space", "o"]],
  ["unit create", ["space", "target", "upstream-space", "upstream-unit", "label", "change-desc", "quiet"]],
  ["unit update", ["space", "patch", "upgrade", "where", "label", "change-desc", "quiet", "o"]],
  ["unit get", ["space", "o"]],
  ["unit list", ["space", "where", "quiet", "o"]],
  // Removed from ConfigHub with the rest of the old approval API
  // (confighubai/confighub#5495). It stays in this table only because the
  // offline fakes of the chapters that have not moved to attestations still
  // walk their old approval path; their live lanes refuse to start.
  ["unit approve", ["space", "where", "revision", "wait", "quiet"]],
  ["unit set-target", ["space", "quiet"]],
  ["release publish", ["revision", "o"]],
]);

export function unknownCubFlag(positionals, flags) {
  const command = positionals.slice(0, 2).join(" ");
  const known = knownCubFlags.get(command);
  if (!known) return null;
  const set = new Set(known);
  for (const name of Object.keys(flags)) {
    if (!set.has(name)) return `unknown flag: --${name}`;
  }
  return null;
}

// unknownCubFlag lets a command outside the table through, which is how a
// fake that grows a new verb ends up parsing its flags permissively again. A
// fake that wants the whole surface closed asks this first and refuses a
// command the table does not name, so a verb joins the fake only by joining
// the table with its flags.
export function knownCubCommand(positionals) {
  return knownCubFlags.has(positionals.slice(0, 2).join(" "));
}

// A component is per run, never shared across runs. Recorded Spaces from
// earlier runs are kept on purpose, and a change order's scope is every Space
// attached to its base's component, so a component shared across runs would
// put an old run's variants in a new change order's scope, where a promotion
// into a stage would reach them. The management Space gets a component of its
// own for the same reason: it is not a variant of the base, and attached to
// the base's component it would sit in every change order's scope.
export function runScopedComponents(componentLabel, runId) {
  return {
    base: spaceName(`${componentLabel}-${runId}`),
    management: spaceName(`${componentLabel}-management-${runId}`),
  };
}

// ConfigHub removed its old approval mechanism on 2026-09-25
// (confighubai/confighub#5495, API_MINOR 6): the per-unit approve verb, the
// vet-approvedby and is-approved functions, the ApprovedBy fields, the Approve
// endpoints, and with them the platform/require-approval trigger this
// repository's helm-catalog organization ran. Approval is an attestation now,
// recorded with `cub variant approve` and required by a ChangeWorkflow. A live
// lane still written against the old mechanism cannot record an approval, so
// it would build a fleet and then fail at its first approval. It stops here,
// before anything is built, and says why. Its offline self-test keeps walking
// the old path against its own fake, which is a record of what it did, not a
// claim about what ConfigHub does today.
export const retiredApprovalLaneMarker = "stops before building anything: the old ConfigHub approval API is removed";

export function refuseRetiredApprovalLane(
  lane,
  how = "It approves with the per-unit approve verb and the platform/require-approval trigger",
) {
  throw new Error(
    `${lane} ${retiredApprovalLaneMarker}. ${how}, which ConfigHub removed on 2026-09-25 (confighubai/confighub#5495, API_MINOR 6). Approvals are attestations now, recorded with cub variant approve and required by a ChangeWorkflow. Chapter three has moved to them; this lane moves next, see confighub/sveltos-confighub#34.`,
  );
}

// Docker Hub throttles anonymous pulls, and a fleet lane multiplies every
// image by every node: five clusters pulling ten images cold is how a
// converge that takes seconds on a quiet day dies at its timeout on a busy
// one. Each image is pulled into the local docker daemon at most once and
// loaded into every kind cluster from there, so a lane costs one pull per
// image however many clusters it builds. Kyverno's images come from ghcr.io
// and are not throttled, so they are left alone. The agent image is pinned
// by digest because Sveltos deploys it into workload clusters by digest.
// Only v1.13.0's agent digest is known here. For a version without one the
// agent is not preloaded: Sveltos deploys it into each workload cluster by
// digest, digest pins stay out of the archive anyway (see below), and the
// workload nodes pull it directly, which is what a receipt records rather
// than a digest nobody measured.
const sveltosAgentDigests = {
  "v1.13.0": "docker.io/projectsveltos/sveltos-agent@sha256:3f1fb4a8159b5acc6d77d117b8623bbacce0213e32d92ebdc7938d3fd97a3dca",
};

export function sveltosAgentPreloaded(version) {
  return Boolean(sveltosAgentDigests[version]);
}

// The image lines of a manifest, each image once, in the order they appear.
export function manifestImages(text) {
  const images = [
    ...String(text).matchAll(/^[ \t]*image:[ \t]*["']?([^\s"']+)["']?[ \t]*$/gm),
  ].map((match) => match[1]);
  return [...new Set(images)];
}

// Which images a lane preloads. Given the pinned manifest's own image lines,
// the list is exactly those, with the pinned addon controller replaced by the
// image the lane runs, so a release that adds a controller cannot slip past
// the preload and be pulled from Docker Hub mid-lane. Without them, the list
// is the one every chapter pinned to v1.13.0 has always preloaded.
export function sveltosPreloadList({ version, addonControllerImage, images }) {
  const agent = sveltosAgentDigests[version] ? [sveltosAgentDigests[version]] : [];
  if (!Array.isArray(images)) {
    return [
      ...[
        "access-manager", "classifier", "event-manager", "healthcheck-manager",
        "mcp-server", "shard-controller", "sveltoscluster-manager", "techsupport",
      ].map((name) => `docker.io/projectsveltos/${name}:${version}`),
      addonControllerImage,
      ...agent,
    ];
  }
  const pinnedAddonController = `docker.io/projectsveltos/addon-controller:${version}`;
  return [...new Set([
    ...images.map((image) =>
      (image === pinnedAddonController ? addonControllerImage : image)),
    ...agent,
  ])];
}

export function preloadSveltosImages({
  clusters,
  version,
  addonControllerImage,
  images: pinnedManifestImages,
}) {
  const images = sveltosPreloadList({
    version,
    addonControllerImage,
    images: pinnedManifestImages,
  });
  const host = (tool, args, timeout) =>
    spawnSync(tool, args, { encoding: "utf8", timeout });
  const unique = [...new Set(images)];
  for (const image of unique) {
    const present = host("docker", ["image", "inspect", image], 30_000);
    if (present.status !== 0) {
      const pulled = host("docker", ["pull", image], 600_000);
      check(
        pulled.status === 0,
        `could not pull ${image} into the local docker daemon: ${(pulled.stderr ?? "").trim() || "docker pull failed"}`,
      );
    }
  }
  // `kind load docker-image` imports with --all-platforms --digests, which
  // demands multi-arch manifest blobs a single-platform pull never fetched;
  // on a containerd-image-store docker (measured live) it refuses with
  // "content digest ... not found". A platform-scoped `docker save` writes
  // an archive containing exactly the blobs this machine holds, and one
  // archive loads every image into a cluster in one import.
  // A digest-pinned reference must NOT go into the archive: docker save of
  // an @sha256 ref has no repo:tag, so the import lands as a broken unnamed
  // import-<date> record sharing the real image's content ID, and kubelet's
  // resolution collides with it even after a clean pull ("failed to check if
  // this is a checkpoint image", measured live). Nodes pull digest pins
  // directly instead — measured at two seconds — and the archive carries
  // only the tag-named images.
  const archivable = unique.filter((image) => !image.includes("@sha256:"));
  const arch = host("docker", ["version", "--format", "{{.Server.Arch}}"], 30_000);
  const platform = `linux/${(arch.stdout ?? "").trim() || "arm64"}`;
  const archive = join(tmpdir(), `sveltos-preload-${process.pid}.tar`);
  const saved = host(
    "docker",
    ["save", "--platform", platform, "-o", archive, ...archivable],
    900_000,
  );
  check(
    saved.status === 0,
    `could not save the Sveltos images as a ${platform} archive: ${(saved.stderr ?? "").trim() || "docker save failed (a docker without save --platform predates the containerd-store fix this needs)"}`,
  );
  try {
    for (const cluster of clusters) {
      const loaded = host(
        "kind",
        ["load", "image-archive", archive, "--name", cluster],
        // Loading into a node on a machine still settling five fresh
        // clusters is I/O-bound and slow; give it the converge waits' room.
        900_000,
      );
      check(
        loaded.status === 0,
        `could not load the Sveltos image archive into ${cluster}: ${(loaded.stderr ?? "").trim() || "kind load failed"}`,
      );
    }
  } finally {
    rmSync(archive, { force: true });
  }
  return images;
}

// Evidence-gated advance: a wave may request its approval only after the
// preceding checkpoint shows the clusters it depends on reporting healthy.
// Wave one depends on the whole fleet at the baseline; every later wave
// depends on the environment the previous wave just promoted. The returned
// record is written into the receipt per wave, so a reader can verify from
// the receipt alone that every approval followed evidence rather than a
// schedule. Clusters are matched on their fleet names, because the live kind
// clusters carry a run stamp the plan does not.
export function waveUnlockEvidence({
  wave,
  previousEnvironment,
  expectedClusters,
  checkpoints,
}) {
  const checkpoint = checkpoints.at(-1);
  const expectedId = wave === 1 ? "baseline" : `after-wave-${wave - 1}`;
  check(
    checkpoint?.id === expectedId,
    `wave ${wave} cannot request its approval: the preceding checkpoint is ${checkpoint?.id ?? "missing"} rather than ${expectedId}`,
  );
  // The scope is the named cluster set the wave depends on, not a label
  // filter: chapters whose waves share one environment still gate on exactly
  // the clusters the previous wave promoted.
  const scope = checkpoint.observations.filter(
    (row) => expectedClusters.includes(row.logicalCluster),
  );
  const seen = scope.map((row) => row.logicalCluster);
  check(
    sameSet(seen, expectedClusters),
    `wave ${wave} cannot request its approval: ${checkpoint.id} observed ${seen.sort().join(", ") || "no cluster"} rather than ${[...expectedClusters].sort().join(", ")}, so the evidence is incomplete`,
  );
  const unhealthy = scope.filter((row) => row.observation?.result !== "pass");
  check(
    unhealthy.length === 0,
    `wave ${wave} approval refused: ${unhealthy.map((row) => row.logicalCluster).sort().join(", ")} did not report healthy at ${checkpoint.id}`,
  );
  return {
    precedingCheckpointId: checkpoint.id,
    environment: wave === 1 ? "baseline" : previousEnvironment,
    clusters: scope.map((row) => ({
      cluster: row.cluster,
      logicalCluster: row.logicalCluster,
      environment: row.environment,
      result: row.observation.result,
    })),
    approvalFollowedEvidence: true,
  };
}

// The server evaluates apply gates after the write returns, so a publish can
// arrive while a gate trigger is still queued. The server says so in those
// words and re-queues the trigger. That is a race and not a refusal. A gate
// that genuinely refuses reports something else and must still stop the run.
export function pendingApplyGate(message) {
  return message.includes("outstanding ApplyGates")
    && message.includes("re-queued for evaluation");
}

// Documents applied to a cluster with kubectl are written as JSON, which is
// valid YAML and quotes every scalar, so a check for a pinned image cannot be
// satisfied by a longer tag that merely starts the same way.
export function writeDocuments(path, documents) {
  writeFileSync(
    path,
    `${documents.map((document) =>
      JSON.stringify(document, null, 2)).join("\n---\n")}\n`,
  );
}

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

// Documents ConfigHub stores are a different matter. ConfigHub tracks a variant
// against its base by aligning the resources in the two stored documents. A
// unit stored as YAML that is later written as JSON does not align: ConfigHub
// records the base resource as deleted and a different resource as added, which
// severs the upstream lineage. The variant then keeps its departures forever,
// inherits nothing, and every later promotion is a no-op that still reports
// success. That cost a live run before it was understood.
export function writeStoredDocuments(path, documents) {
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

// ConfigHub reports what it can still merge from the base as a mutation list.
// A variant that kept its lineage shows one resource carrying field-level
// updates. A variant that lost it shows the base resource deleted and a
// different resource added, and from then on no change to the base can reach
// it. The failure is silent where it happens and only surfaces waves later as a
// promotion that reported success without landing, so the lineage is checked
// the moment the departures are stored.
export function assertUpstreamLineage(mutationsOutput, cluster) {
  const mutations = String(mutationsOutput).replace(/\[[0-9;]*m/g, "");
  const resources = [...mutations.matchAll(/^Resource: /gm)].length;
  const deleted = /\[Delete\]/.test(mutations);
  check(
    resources === 1 && !deleted,
    `${cluster} lost its upstream lineage when its departures were stored: ConfigHub tracks ${resources} resources${deleted ? " and records the base resource as deleted" : ""}, so no later change to the base can merge into it`,
  );
}


// Everything a chapter needs to hold its fleet as one base and one variant per
// cluster, and to move a reviewed change through it. The caller supplies its
// own hub access and its own labels, because the chapters differ in what they
// are proving, not in how a governed record works.
export function governedRecords(deps) {
  const {
    appLabel,
    stableJson,
    bootstrapPrefix,
    clusterCommand,
    gatewaySecretName,
    managementRecordLabel,
    registrationNamespace,
    remoteFetchInterval,
    workRootFor,
    changedDocOf,
    changeInherited,
    now,
    approvalFilterRef,
    approvalGate,
    baseRecordLabel,
    componentLabel,
    configHubOciHost,
    cub,
    cubJson,
    cubTry,
    ownerLabel,
    policyUnit,
    probeRecord,
    proofLabel,
    targetHost,
    publishGateAttempts,
    publishGatePollMs,
    releaseTag,
    setScope,
    sleep,
    variantRecordLabel,
  } = deps;

  // A chapter that promotes through a ChangeWorkflow passes the component the
  // Space belongs to. A component label is not enough for that: a change
  // order's stages select within the component ENTITY the Space is attached
  // to, and a Space without one is refused. Chapters that pass nothing get
  // exactly the Space they always did.
  function createPolicySpace(context, space, { component } = {}) {
    assertPublishableSpaceName(space, probeRecord);
    cub(context, [
      "space", "create", space,
      "--label", `App=${appLabel}`,
      // The ConfigHub component view groups Spaces by their Component label and
      // files them under their Owner. Without these two the base and its
      // variants are invisible there, which is the one view where a reader
      // would look to see that a variant and a cluster stand one to one.
      "--label", `Component=${componentLabel}`,
      "--label", `Owner=${ownerLabel}`,
      "--label", "ApplyPolicyProfile=catalog-standard",
      "--label", `Proof=${proofLabel}`,
      "--label", "ResourceClass=system-configuration",
      "--label", "SourceType=sveltos",
      "--trigger-filter", approvalFilterRef,
      "--where-trigger", "-",
      ...(component ? ["--component", component] : []),
      "--quiet",
    ]);
    cub(context, [
      "space", "update", "--patch", space, "--refresh-triggers", "--quiet",
    ]);
  }

  // The component entity a ChangeWorkflow's stages select within. It carries
  // the run's labels so an operator can find what a run left behind.
  function createComponent(context, slug, runId) {
    cub(context, [
      "component", "create", slug,
      "--label", `App=${appLabel}`,
      "--label", `Proof=${proofLabel}`,
      "--label", `Run=${runId}`,
      "--quiet",
    ]);
    return slug;
  }

  // One workflow per run, held in the base Space. Each stage selects the
  // variants of the change order's component whose Space carries that Stage
  // label, which is what `cub variant create --stage` sets. The prerequisites
  // are gates the server evaluates over every Space of the stage ahead.
  function createChangeWorkflow(context, { space, slug, stages, prerequisites }) {
    cub(context, [
      "changeworkflow", "create", "--space", space, slug,
      ...stages.flatMap((stage) => ["--stage", stage]),
      "--prerequisites", prerequisites.join(","),
      "--quiet",
    ]);
    return { space, slug, ref: `${space}/${slug}`, stages, prerequisites };
  }

  // A change order created after the reviewed edit lands on the base captures
  // that edit as the change. Its scope is every Space attached to the base's
  // component, which the server records as InScopeSpaceIDs, so it is read
  // back rather than assumed.
  function createChangeOrder(context, { space, slug, workflowRef, description }) {
    cub(context, [
      "changeorder", "create", "--space", space, slug,
      "--change-workflow", workflowRef,
      "--description", description,
      "--quiet",
    ]);
    const answer = cubJson(context, [
      "changeorder", "get", "--space", space, slug, "-o", "json",
    ]);
    const changeOrder = answer?.ChangeOrder ?? answer;
    check(
      Array.isArray(changeOrder?.InScopeSpaceIDs),
      `${space}/${slug} answered without InScopeSpaceIDs (keys: ${Object.keys(changeOrder ?? {}).join(", ") || "none"}), so its scope cannot be checked`,
    );
    return {
      space,
      slug,
      ref: `${space}/${slug}`,
      workflowRef,
      description,
      inScopeSpaceIds: [...changeOrder.InScopeSpaceIDs].map(String).sort(),
    };
  }

  // Promote exactly the change order's change into every variant one stage of
  // its workflow selects. The server checks the gates of the stage ahead once
  // for the whole stage, so a refusal comes back from here unchanged.
  function promoteStage(context, { changeOrderRef, stage, changeDesc }) {
    return cubTry(context, [
      "variant", "promote",
      "--change-order", changeOrderRef,
      "--target-stage", stage,
      "--change-desc", changeDesc,
      "--quiet",
    ]);
  }

  // ---------------------------------------------------------------------
  // The attestation path. ConfigHub records an approval as an Attestation
  // on exact Revisions, and a ChangeWorkflow requires it: a stage's
  // ReleasePrerequisites are evaluated when a Release of a change order is
  // published into one of its Spaces, and a publish they do not allow is
  // refused with HTTP 422 and nothing left behind. Chapters that have moved
  // to it use these; the ones that have not keep the functions above.
  // ---------------------------------------------------------------------

  // A workflow with attestation requirements is written in a file, because
  // the flags cannot carry per-stage release prerequisites. It is read back,
  // so a server that does not know attestation requirements is found out
  // before anything depends on them.
  function createChangeWorkflowFromFile(context, { space, slug, path }) {
    cub(context, [
      "changeworkflow", "create", "--space", space, slug,
      "--filename", path,
      "--quiet",
    ]);
    const answer = cubJson(context, [
      "changeworkflow", "get", "--space", space, slug, "-o", "json",
    ]);
    const workflow = answer?.ChangeWorkflow ?? answer;
    check(
      Array.isArray(workflow?.Stages) && Array.isArray(workflow?.AttestationPrerequisites),
      `${space}/${slug} answered without Stages and AttestationPrerequisites (keys: ${Object.keys(workflow ?? {}).join(", ") || "none"}), so ConfigHub did not keep the approval requirement`,
    );
    return {
      space,
      slug,
      ref: `${space}/${slug}`,
      stages: workflow.Stages,
      attestationPrerequisites: workflow.AttestationPrerequisites,
    };
  }

  // Declares that the component's promotions and releases go through this
  // workflow. Measured on 2026-09-26, ConfigHub records the declaration but
  // does not yet refuse a plain publish outside a change order, so a caller
  // records it as intent, not as a gate.
  function requireChangeWorkflow(context, { component, workflowRef }) {
    cub(context, [
      "component", "update", "--patch", component,
      "--change-workflow-required",
      "--allowed-change-workflow", workflowRef,
      "--quiet",
    ]);
  }

  // A new revision runs the Space's validating triggers. A publish that
  // arrives while they are queued is refused for that reason rather than for
  // a missing approval, so the gate is observed only once they have run.
  function waitForTriggers(context, space, unit) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const current = cubJson(
        context,
        ["unit", "get", unit, "--space", space, "-o", "json"],
      ).Unit;
      if (current.ApplyGates?.["awaiting/triggers"] !== true) return current;
      sleep(1000);
    }
    throw new Error(`${space}/${unit} still had queued triggers after 90s`);
  }

  // Publishing a change order's release before anyone approved it must be
  // refused by its release gate. A trigger still queued is waited out; any
  // other answer is returned for the caller to judge.
  function attemptGatedRelease(context, space, revision) {
    for (let attempt = 0; attempt < publishGateAttempts; attempt += 1) {
      const result = cubTry(context, [
        "release", "publish", space, "--revision", revision, "-o", "json",
      ], { timeout: 300_000 });
      if (result.ok) return { published: true, output: result.output };
      const message = String(result.error ?? "");
      if (!pendingApplyGate(message)) return { published: false, message };
      sleep(publishGatePollMs);
    }
    return {
      published: false,
      message: `${space} still had outstanding apply gates after ${Math.round((publishGateAttempts * publishGatePollMs) / 1000)}s`,
    };
  }

  function releaseGateRefused(message) {
    return /unable to publish a release of change order/.test(message)
      && /requires approval: /.test(message);
  }

  // One operation approves the change as it stands in every Space of a stage.
  function approveChangeInStage(context, { changeOrderRef, stage }) {
    return cubTry(context, [
      "variant", "approve",
      "--change-order", changeOrderRef,
      "--stage", stage,
      "--quiet",
    ]);
  }

  // Approves what a release of one Space would bundle: each unit with a
  // Target, at its head. Used for a record no release gate reads.
  function approveSpaceRelease(context, space) {
    return cubTry(context, ["variant", "approve", space, "--quiet"]);
  }

  // One stage of a change order, from promotion to release: the stored
  // content checked against the reviewed documents, the label query checked
  // against the stage's variants, a release attempted before any approval
  // and refused by the release gate, one approval of the change as it
  // stands in the stage, the head unchanged by approving, and the release
  // then published where the change order arrived. The refusal is recorded
  // as the gate observation; an approval never stands without one before it.
  function attestedReleaseSet({
    policyContext,
    stageName,
    query,
    members,
    changeOrder,
    stage,
  }) {
    const revision = `ChangeOrder:${changeOrder.slug}`;
    const stored = {};
    for (const member of members) {
      const unit = waitForTriggers(policyContext, member.space, policyUnit);
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
    }
    const selection = selectSet({
      policyContext,
      stageName,
      query,
      expectedUnits: members.map((member) => `${member.space}/${policyUnit}`),
    });
    const refusals = {};
    for (const member of members) {
      const attempt = attemptGatedRelease(policyContext, member.space, revision);
      check(
        !attempt.published,
        `ConfigHub published ${member.space} at ${revision} before anyone approved it; the ${stage} stage's release gate did not hold`,
      );
      check(
        releaseGateRefused(attempt.message),
        `the ${stageName} release of ${member.cluster} was refused for a reason other than its missing approval: ${attempt.message}`,
      );
      refusals[member.cluster] = attempt.message;
    }
    const approved = approveChangeInStage(policyContext, {
      changeOrderRef: changeOrder.ref,
      stage,
    });
    check(
      approved.ok,
      `ConfigHub did not record the approval of ${changeOrder.ref} in the ${stage} stage: ${approved.error}`,
    );
    const records = {};
    for (const member of members) {
      const current = cubJson(policyContext, [
        "unit", "get", "--space", member.space, policyUnit, "-o", "json",
      ]).Unit;
      check(
        Number(current.HeadRevisionNum) === Number(stored[member.cluster].HeadRevisionNum)
          && current.ContentHash === stored[member.cluster].ContentHash,
        `approving changed the ${stageName} record for ${member.cluster}; an attestation records a claim and must not cut a revision`,
      );
      const release = publishRelease(policyContext, member.space, revision);
      records[member.cluster] = {
        cluster: member.cluster,
        space: member.space,
        revisionId: member.revisionId,
        contentHash: stored[member.cluster].ContentHash,
        releaseGate: {
          result: "refused",
          httpStatus: 422,
          requirement: "approval",
          observation: "release-refused-before-approval",
          message: refusals[member.cluster],
        },
        approval: {
          kind: "attestation",
          type: "Approval",
          command: `cub variant approve --change-order <base-space>/<change-order> --stage ${stage}`,
          revision: Number(current.HeadRevisionNum),
          headUnchanged: true,
          contentHashUnchanged: true,
          approverIdentityRecordedInReceipt: false,
        },
        afterApproval: { result: "published", revision },
        release,
      };
    }
    return {
      stage: stageName,
      selection,
      approval: {
        kind: "attestation",
        command: `cub variant approve --change-order <base-space>/<change-order> --stage ${stage}`,
        appliedAsOneOperation: true,
        members: members.length,
        recordedApprovals: members.length,
      },
      records,
    };
  }

  // A record that no release gate reads, such as the management record that
  // is applied with kubectl, is still stored as reviewed and approved as an
  // attestation, and the record says plainly that nothing server-side gates
  // it.
  function attestUnpublishedRecord({ policyContext, member, reason }) {
    const unit = waitForTriggers(policyContext, member.space, policyUnit);
    check(
      canonicalDocs(parseDocs(storedData(unit)))
        === canonicalDocs(member.expectedDocs),
      `ConfigHub stored a different record for ${member.cluster}`,
    );
    const approved = approveSpaceRelease(policyContext, member.space);
    check(
      approved.ok,
      `ConfigHub did not record the approval of ${member.space}: ${approved.error}`,
    );
    const current = cubJson(policyContext, [
      "unit", "get", "--space", member.space, policyUnit, "-o", "json",
    ]).Unit;
    check(
      Number(current.HeadRevisionNum) === Number(unit.HeadRevisionNum)
        && current.ContentHash === unit.ContentHash,
      `approving changed the record for ${member.cluster}`,
    );
    return {
      cluster: member.cluster,
      space: member.space,
      revisionId: member.revisionId,
      contentHash: unit.ContentHash,
      releaseGate: {
        result: "not-applicable",
        reason,
      },
      approval: {
        kind: "attestation",
        type: "Approval",
        command: "cub variant approve <management-space>",
        revision: Number(current.HeadRevisionNum),
        gatedServerSide: false,
        headUnchanged: true,
        contentHashUnchanged: true,
        approverIdentityRecordedInReceipt: false,
      },
      release: null,
    };
  }

  // ConfigHub's destination model is the Target, so each cluster gets a
  // Target named for it and its variant's Space releases to it. Delivery is
  // unchanged — the gateway already serves one address per Space — but what
  // ConfigHub knows changes: which cluster a variant ships to becomes a
  // model-level answer rather than a selector line inside the stored YAML.
  // A Target needs a BridgeWorker that has announced support for its
  // ConfigType, workers are space-scoped and live, and this design is
  // pull-based with no worker per Space, so each cluster's named Target is
  // minted in the catalog's infrastructure Space against its long-registered
  // OCI-capable worker. --allow-exists keeps the Target stable across runs:
  // one cluster, one destination identity. The variant's Space references it
  // across Spaces the way the shared catalog target always was referenced.
  // The base Space deliberately gets no Target and no release target, which
  // is the model saying what the receipts already say: the base reaches no
  // cluster.
  function establishClusterTarget(context, cluster) {
    cub(context, [
      "target", "create", cluster, "{}", targetHost.worker,
      "--space", targetHost.space,
      "--provider", "OCI",
      "--toolchain", "Any",
      "--label", `Cluster=${cluster}`,
      "--allow-exists",
      "--quiet",
    ]);
    const created = cubJson(context, [
      "target", "get", "--space", targetHost.space, cluster, "-o", "json",
    ]).Target;
    check(
      Boolean(created?.TargetID),
      `${targetHost.space} did not host the ${cluster} Target`,
    );
    check(
      created.ProviderType === "OCI",
      `the ${cluster} Target must be an OCI target, not ${created.ProviderType}`,
    );
    return {
      name: cluster,
      host: targetHost.space,
      ref: `${targetHost.space}/${cluster}`,
      id: created.TargetID,
      provider: created.ProviderType,
      toolchain: created.ToolchainType,
    };
  }

  function assertPolicySpace(context, space, expectedTriggerIds, expectedReleaseTargetId) {
    const actual = cubJson(context, ["space", "get", space, "-o", "json"]).Space;
    check(
      sameSet(actual.TriggerIDs ?? [], expectedTriggerIds),
      `${space} received the wrong Trigger set`,
    );
    // The base Space expects no release target at all, which is passed as
    // null and must match a server answer of null, empty, or absent.
    check(
      (actual.ReleaseTargetID ?? null) === (expectedReleaseTargetId ?? null)
        || (!actual.ReleaseTargetID && !expectedReleaseTargetId),
      `${space} received the wrong release target`,
    );
  }

  function gatewayReference(space) {
    assertPublishableSpaceName(space);
    return `oci://${configHubOciHost}/space/${space}:${releaseTag}`;
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

  function approvalCount(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    return value ? 1 : 0;
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

  // With no revision a release bundles each unit at its head, which is what
  // every chapter recorded so far publishes. A chapter promoting a change
  // order passes `ChangeOrder:<slug>`, so the release bundles each unit where
  // that change arrived; that is also what the Released gate reads when the
  // next stage asks whether this one has released the change.
  function publishRelease(context, space, revision) {
    let lastPending = "";
    let response;
    for (let attempt = 0; attempt < publishGateAttempts; attempt += 1) {
      try {
        response = cubJson(
          context,
          [
            "release", "publish", space,
            ...(revision ? ["--revision", revision] : []),
            "-o", "json",
          ],
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
      ...(revision ? { revision } : {}),
      manifestDigest,
      bundleDigest: normalizeDigest(release.Digest ?? release.digest),
      releaseId: String(release.ReleaseID ?? release.releaseId ?? ""),
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
    // The lib has no phase printer of its own. This line used to call the
    // runners' one, which is out of scope here, so the one path that reaches
    // it, a bulk approve that reports a delayed trigger after recording every
    // approval, would have stopped a live run with a ReferenceError.
    console.log(`[${proofLabel}] ${stageName} approvals recorded; waiting for delayed trigger completion`);
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
        : publishRelease(policyContext, member.space, member.releaseRevision);
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

  // The base record holds what every cluster shares. It is given no target and
  // its Space is never published, so nothing reaches a cluster from it: every
  // revision that reaches a cluster is approved on the variant that owns it.
  function establishBase({
    policyContext,
    space,
    plan,
    topology,
    runId,
    policySpacesCreated,
    component,
  }) {
    createPolicySpace(policyContext, space, { component });
    policySpacesCreated.add(space);
    assertPolicySpace(
      policyContext,
      space,
      topology.triggerIds,
      null,
    );
    cub(policyContext, [
      "unit", "create", "--space", space, policyUnit, plan.base.path,
      "--label", `App=${appLabel}`,
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
      ...(component ? { component } : {}),
      revisionId: plan.base.revisions.baseline,
      revision: Number(stored.HeadRevisionNum),
      contentHash: stored.ContentHash,
      target: "none",
      published: false,
      reachesCluster: false,
      note: "The base carries no target and its Space is never published, so it reaches no cluster on its own.",
    };
  }

  // A variant is a clone of the base Space and its unit, made with the CLI's
  // own verb for exactly this shape: `cub variant create` clones the Space and
  // every unit in one operation, links each clone to its upstream, stamps the
  // Variant label with the cluster's name, and copies the approval wiring
  // (WhereTrigger, TriggerFilterID, Permissions, DeleteGates) from the base
  // Space. The upstream link is what lets a later base change flow down while
  // the departures stay.
  function establishVariant({
    policyContext,
    space,
    baseSpace,
    cluster,
    topology,
    runId,
    workRoot,
    policySpacesCreated,
    stage,
  }) {
    // The server derives the new Space's slug from labels, so the declared
    // slug is pinned explicitly: the gateway only serves lowercase slugs, and
    // the committed variants declaration is the reviewed source of the name.
    // A chapter promoting through a ChangeWorkflow names the stage too: the
    // Space's Stage label is what a workflow stage selects, and the clone
    // inherits the base Space's component, so the stage selects it there.
    assertPublishableSpaceName(space, probeRecord);
    cub(policyContext, [
      "variant", "create", cluster.cluster, baseSpace,
      "--space-pattern", `template:${space}`,
      ...(stage ? ["--stage", stage] : []),
      "--quiet",
    ]);
    policySpacesCreated.add(space);
    // variant create copies a TargetID annotation from the upstream Space,
    // and the base deliberately has none, so this cluster's own destination
    // is established and bound here, next to the departures that make the
    // record this cluster's own.
    const target = establishClusterTarget(policyContext, cluster.cluster);
    cub(policyContext, [
      "space", "update", space,
      "--release-target", target.ref,
      "--quiet",
    ]);
    assertPolicySpace(
      policyContext,
      space,
      topology.triggerIds,
      target.id,
    );
    // Every label the wave and audit queries select on is set explicitly on
    // the clone, rather than trusting the clone to inherit the base unit's,
    // because a record a query cannot find is a cluster a wave cannot reach.
    cub(policyContext, [
      "unit", "update", "--patch", "--space", space, policyUnit,
      "--label", `App=${appLabel}`,
      "--label", `Cluster=${cluster.cluster}`,
      "--label", `Environment=${cluster.environment}`,
      "--label", `Wave=${cluster.wave}`,
      "--label", `Proof=${proofLabel}`,
      "--label", `Run=${runId}`,
      "--label", `Record=${variantRecordLabel}`,
      "--change-desc", `Label ${cluster.cluster}'s clone of the base record`,
      "--quiet",
    ]);
    cub(policyContext, [
      "unit", "set-target", policyUnit, target.ref,
      "--space", space, "--quiet",
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
      ...(stage ? { stage } : {}),
      space,
      unit: policyUnit,
      profile: cluster.profileName,
      clusterRef: cluster.clusterRef,
      upstream: {
        space: baseSpace,
        unit: policyUnit,
        unitLinked: true,
        revisionAtClone: Number(cloned.UpstreamRevisionNum ?? 0),
      },
      departures: cluster.departures,
      departedFields: cluster.departurePaths,
      target: {
        name: target.name,
        host: target.host,
        ref: target.ref,
        id: target.id,
        provider: target.provider,
      },
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
    if (canonicalDocs(documents) === canonicalDocs([changedDocOf(cluster)])) return;
    const merged = documents[0] ?? {};
    const inherited = changeInherited(merged, plan);
    const kept = cluster.departurePaths.filter(
      (path) => readPath(merged, path) === cluster.departures[path],
    );
    check(
      false,
      `${cluster.cluster} did not come out of the upgrade as the reviewed merge: inheritedTheChange=${inherited}, departuresKept=${kept.length}/${cluster.departurePaths.length}. A change and a departure that write the same field, or different keys of the same map, merge with the departure winning and nothing said about it, so this promotion is refused rather than recorded as a success.`,
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

  // The management record holds one bootstrap profile per workload Space. It is
  // the record that opens the gateway path, so its first revision is applied out
  // of band with kubectl, and ConfigHub governs every revision after that.
  function establishManagement({
    policyContext,
    space,
    plan,
    topology,
    runId,
    workRoot,
    policySpacesCreated,
    workloadSpaces,
    component,
  }) {
    createPolicySpace(policyContext, space, { component });
    policySpacesCreated.add(space);
    const target = establishClusterTarget(
      policyContext,
      plan.management.cluster,
    );
    cub(policyContext, [
      "space", "update", space,
      "--release-target", target.ref,
      "--quiet",
    ]);
    assertPolicySpace(
      policyContext,
      space,
      topology.triggerIds,
      target.id,
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
      "--target", target.ref,
      "--label", `App=${appLabel}`,
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
      ...(component ? { component } : {}),
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
      target: {
        name: target.name,
        host: target.host,
        ref: target.ref,
        id: target.id,
        provider: target.provider,
      },
    };
  }

  function bootstrapProfileName(cluster) {
    return `${bootstrapPrefix}-${cluster}-bootstrap`;
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

  return {
    applyBootstrapProfiles,
    bootstrapProfileManifest,
    bootstrapProfileName,
    establishManagement,
    allowedDryRun,
    approvalCount,
    approvalObservation,
    approveSet,
    assertMergeKeptDepartures,
    assertPolicySpace,
    assertUpstreamLineage,
    blockedDryRun,
    approveChangeInStage,
    approveSpaceRelease,
    attemptGatedRelease,
    attestUnpublishedRecord,
    attestedReleaseSet,
    createChangeOrder,
    createChangeWorkflow,
    createChangeWorkflowFromFile,
    createComponent,
    releaseGateRefused,
    requireChangeWorkflow,
    waitForTriggers,
    createPolicySpace,
    establishBase,
    establishClusterTarget,
    establishVariant,
    gatewayReference,
    promoteStage,
    publishRelease,
    reviewSet,
    selectSet,
    waitForPolicy,
  };
}
