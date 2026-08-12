// The shape every governed chapter in this repository shares.
//
// A fleet is held as one base record plus one variant per cluster. The base
// carries what every cluster shares and reaches no cluster on its own. Each
// variant is a clone of the base, linked to it, carrying only the fields that
// genuinely differ for its own cluster, one of which is a selector that
// matches that cluster and nothing else.
//
// This lived inside the environment rollout runner first. It lives here now
// because a fleet design that only one chapter implements is a design that
// silently stops being true, which is exactly what happened: chapter three was
// reworked to one record per cluster and chapters four and five kept governing
// one record per environment for weeks without anything noticing.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { check } from "./proof-common.mjs";

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
