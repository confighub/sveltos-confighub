#!/usr/bin/env node
// One rule keeps the model honest for future users: a committed
// ClusterProfile addresses exactly one cluster, meaning its
// spec.clusterSelector.matchLabels is the single key "cluster". Anything
// else can fan out and is refused.
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

function addressesOneCluster(doc) {
  const ml = doc?.spec?.clusterSelector?.matchLabels;
  if (!ml || typeof ml !== "object") return false;
  const keys = Object.keys(ml);
  return keys.length === 1 && keys[0] === "cluster";
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
    const violating = profiles.filter((d) => !addressesOneCluster(d));
    if (violating.length > 0 && !legacySet.has(path)) {
      for (const doc of violating) {
        findings.push(
          `${path}: ${doc.kind} ${doc?.metadata?.name ?? "(unnamed)"} does not address exactly one cluster; ` +
            `use matchLabels with the single key "cluster"`,
        );
      }
    }
    if (violating.length === 0 && legacySet.has(path)) {
      findings.push(`${path} now addresses one cluster; remove it from the legacy list in this change`);
    }
  }

  return findings;
}

function profile(name, matchLabels) {
  return { kind: "ClusterProfile", metadata: { name }, spec: { clusterSelector: { matchLabels } } };
}

function selfTest() {
  const clean = assess(new Map([["a.yaml", [profile("a", { cluster: "hx-a" })]]]), []);
  if (clean.length !== 0) throw new Error(`self-test: addressed profile should pass:\n${clean.join("\n")}`);

  const fanOut = assess(new Map([["a.yaml", [profile("a", { environment: "prod" })]]]), []);
  if (!fanOut.some((f) => f.includes("does not address exactly one cluster"))) {
    throw new Error("self-test: fan-out selector should refuse");
  }

  const listed = assess(new Map([["a.yaml", [profile("a", { environment: "prod" })]]]), ["a.yaml"]);
  if (listed.length !== 0) throw new Error(`self-test: listed legacy file should stand:\n${listed.join("\n")}`);

  const fixed = assess(new Map([["a.yaml", [profile("a", { cluster: "hx-a" })]]]), ["a.yaml"]);
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

  console.log("per-cluster model self-test passed: the pass, the fan-out refusal, the listed file, the two shrink-the-list refusals, and the committed tree");
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
    `verified the per-cluster model: ${addressed} profiles each address one cluster; ` +
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
