#!/usr/bin/env node
// One rule keeps the model honest for future users: a committed
// ClusterProfile addresses at most one cluster, structurally. It carries no
// clusterSelector at all — a label query can fan out — and its
// spec.clusterRefs holds either one reference naming a SveltosCluster (a
// variant's own cluster) or none (the base, which reaches nothing). The
// address is Sveltos's own API naming one cluster, not a convention a label
// edit could widen.
//
// The files below were recorded before the model and leave the list as the
// issues that rework them land. Fixing one of them means removing it from
// this list in the same change; the check refuses a listed file that no
// longer needs listing. Shrink the list, never grow it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseDocs } from "./lib/proof-common.mjs";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..");
const EXAMPLES_DIR = "examples/sveltos";
const PROFILE_KINDS = new Set(["ClusterProfile", "Profile"]);

const LEGACY = [
  // The rehearsal has no ConfigHub records behind its profiles, so the
  // per-cluster variant rule has nothing to bind to there.
  "examples/sveltos/fleet-rehearsal/clusterprofile-pilot.yaml",
  "examples/sveltos/fleet-rehearsal/clusterprofile-staging.yaml",
  "examples/sveltos/fleet-rehearsal/clusterprofile-prod.yaml",
  "examples/sveltos/fleet-rehearsal/app-profile-pilot.yaml",
  "examples/sveltos/fleet-rehearsal/app-profile-staging.yaml",
  "examples/sveltos/fleet-rehearsal/app-profile-prod.yaml",
];

function walkYamlFiles(root, dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walkYamlFiles(root, rel));
    else if (name.endsWith(".yaml") || name.endsWith(".yml")) out.push(rel);
  }
  return out;
}

export function loadSurfaces(root) {
  const files = new Map();
  for (const rel of walkYamlFiles(root, EXAMPLES_DIR)) {
    files.set(rel, parseDocs(readFileSync(join(root, rel), "utf8")));
  }
  return files;
}

function addressedStructurally(doc) {
  if (doc?.spec?.clusterSelector !== undefined) return false;
  const refs = doc?.spec?.clusterRefs;
  if (!Array.isArray(refs) || refs.length > 1) return false;
  if (refs.length === 0) return true;
  const ref = refs[0];
  return ref?.kind === "SveltosCluster"
    && typeof ref.name === "string" && ref.name.length > 0
    && typeof ref.namespace === "string" && ref.namespace.length > 0;
}

export function assess(files, legacy) {
  const findings = [];
  const legacySet = new Set(legacy);

  for (const path of legacySet) {
    if (!files.has(path)) {
      findings.push(`${path} is listed as legacy but no longer exists; remove it from the list in this change`);
    }
  }

  for (const [path, docs] of files) {
    const profiles = docs.filter((d) => PROFILE_KINDS.has(d?.kind));
    if (profiles.length === 0) continue;
    const violating = profiles.filter((d) => !addressedStructurally(d));
    if (violating.length > 0 && !legacySet.has(path)) {
      for (const doc of violating) {
        findings.push(
          `${path}: ${doc.kind} ${doc?.metadata?.name ?? "(unnamed)"} does not address at most one cluster structurally; ` +
            `carry no clusterSelector and at most one clusterRefs entry naming a SveltosCluster`,
        );
      }
    }
    if (violating.length === 0 && legacySet.has(path)) {
      findings.push(`${path} now addresses at most one cluster; remove it from the legacy list in this change`);
    }
  }

  return findings;
}

function profile(name, spec) {
  return { kind: "ClusterProfile", metadata: { name }, spec };
}

function refTo(cluster) {
  return {
    apiVersion: "lib.projectsveltos.io/v1beta1",
    kind: "SveltosCluster",
    name: cluster,
    namespace: "projectsveltos",
  };
}

function selfTest() {
  const clean = assess(new Map([["a.yaml", [profile("a", { clusterRefs: [refTo("hx-a")] })]]]), []);
  if (clean.length !== 0) throw new Error(`self-test: addressed profile should pass:\n${clean.join("\n")}`);

  const base = assess(new Map([["b.yaml", [profile("b", { clusterRefs: [] })]]]), []);
  if (base.length !== 0) throw new Error(`self-test: an empty-refs base should pass:\n${base.join("\n")}`);

  const selector = assess(new Map([["a.yaml", [profile("a", { clusterSelector: { matchLabels: { cluster: "hx-a" } }, clusterRefs: [refTo("hx-a")] })]]]), []);
  if (!selector.some((f) => f.includes("does not address at most one cluster structurally"))) {
    throw new Error("self-test: a selector should refuse even when narrowed by convention");
  }

  const fanOut = assess(new Map([["a.yaml", [profile("a", { clusterRefs: [refTo("hx-a"), refTo("hx-b")] })]]]), []);
  if (!fanOut.some((f) => f.includes("does not address at most one cluster structurally"))) {
    throw new Error("self-test: two clusterRefs should refuse");
  }

  const listed = assess(new Map([["a.yaml", [profile("a", { clusterSelector: { matchLabels: { environment: "prod" } } })]]]), ["a.yaml"]);
  if (listed.length !== 0) throw new Error(`self-test: listed legacy file should stand:\n${listed.join("\n")}`);

  const fixed = assess(new Map([["a.yaml", [profile("a", { clusterRefs: [refTo("hx-a")] })]]]), ["a.yaml"]);
  if (!fixed.some((f) => f.includes("remove it from the legacy list"))) {
    throw new Error("self-test: fixed listed file should ask to shrink the list");
  }

  const gone = assess(new Map(), ["a.yaml"]);
  if (!gone.some((f) => f.includes("no longer exists"))) {
    throw new Error("self-test: missing listed file should ask to shrink the list");
  }

  const committed = assess(loadSurfaces(repoRoot), LEGACY);
  if (committed.length !== 0) {
    throw new Error(`self-test expects the committed tree to pass:\n${committed.join("\n")}`);
  }

  console.log("per-cluster model self-test passed: the structural pass, the empty-refs base, the selector and fan-out refusals, the listed file, the two shrink-the-list refusals, and the committed tree");
}

function verify() {
  const files = loadSurfaces(repoRoot);
  const findings = assess(files, LEGACY);
  if (findings.length > 0) {
    for (const f of findings) console.error(`refused: ${f}`);
    process.exit(1);
  }
  let addressed = 0;
  for (const [path, docs] of files) {
    if (LEGACY.includes(path)) continue;
    addressed += docs.filter((d) => PROFILE_KINDS.has(d?.kind)).length;
  }
  console.log(
    `verified the per-cluster model: ${addressed} profiles each address at most one cluster structurally; ` +
      `${LEGACY.length} files without ConfigHub records behind them are expected and listed (the rehearsal exemption), nothing is wrong`,
  );
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--verify" || mode === undefined) verify();
else {
  console.error(`unknown mode ${mode}; use --verify or --self-test`);
  process.exit(1);
}
