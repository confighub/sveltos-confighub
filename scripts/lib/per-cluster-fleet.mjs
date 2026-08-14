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
import { readFileSync, writeFileSync } from "node:fs";

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

// Docker Hub throttles anonymous pulls, and a fleet lane multiplies every
// image by every node: five clusters pulling ten images cold is how a
// converge that takes seconds on a quiet day dies at its timeout on a busy
// one. Each image is pulled into the local docker daemon at most once and
// loaded into every kind cluster from there, so a lane costs one pull per
// image however many clusters it builds. Kyverno's images come from ghcr.io
// and are not throttled, so they are left alone. The agent image is pinned
// by digest because Sveltos deploys it into workload clusters by digest.
const sveltosAgentDigests = {
  "v1.13.0": "docker.io/projectsveltos/sveltos-agent@sha256:3f1fb4a8159b5acc6d77d117b8623bbacce0213e32d92ebdc7938d3fd97a3dca",
};

export function preloadSveltosImages({ clusters, version, addonControllerImage }) {
  const images = [
    ...[
      "access-manager", "classifier", "event-manager", "healthcheck-manager",
      "mcp-server", "shard-controller", "sveltoscluster-manager", "techsupport",
    ].map((name) => `docker.io/projectsveltos/${name}:${version}`),
    addonControllerImage,
    ...(sveltosAgentDigests[version] ? [sveltosAgentDigests[version]] : []),
  ];
  const host = (tool, args, timeout) =>
    spawnSync(tool, args, { encoding: "utf8", timeout });
  for (const image of [...new Set(images)]) {
    const present = host("docker", ["image", "inspect", image], 30_000);
    if (present.status !== 0) {
      const pulled = host("docker", ["pull", image], 600_000);
      check(
        pulled.status === 0,
        `could not pull ${image} into the local docker daemon: ${(pulled.stderr ?? "").trim() || "docker pull failed"}`,
      );
    }
    for (const cluster of clusters) {
      const loaded = host(
        "kind",
        ["load", "docker-image", image, "--name", cluster],
        300_000,
      );
      check(
        loaded.status === 0,
        `could not load ${image} into ${cluster}: ${(loaded.stderr ?? "").trim() || "kind load failed"}`,
      );
    }
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

  function createPolicySpace(context, space) {
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
      "--quiet",
    ]);
    cub(context, [
      "space", "update", "--patch", space, "--refresh-triggers", "--quiet",
    ]);
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

  function publishRelease(context, space) {
    let lastPending = "";
    let response;
    for (let attempt = 0; attempt < publishGateAttempts; attempt += 1) {
      try {
        response = cubJson(
          context,
          ["release", "publish", space, "-o", "json"],
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
    phase(`${stageName} approvals recorded; waiting for delayed trigger completion`);
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
        : publishRelease(policyContext, member.space);
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
  }) {
    createPolicySpace(policyContext, space);
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
  }) {
    // The server derives the new Space's slug from labels, so the declared
    // slug is pinned explicitly: the gateway only serves lowercase slugs, and
    // the committed variants declaration is the reviewed source of the name.
    assertPublishableSpaceName(space, probeRecord);
    cub(policyContext, [
      "variant", "create", cluster.cluster, baseSpace,
      "--space-pattern", `template:${space}`,
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
  }) {
    createPolicySpace(policyContext, space);
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
    createPolicySpace,
    establishBase,
    establishClusterTarget,
    establishVariant,
    gatewayReference,
    publishRelease,
    reviewSet,
    selectSet,
    waitForPolicy,
  };
}
