#!/usr/bin/env node
// The gate that keeps "one ConfigHub record per Sveltos cluster" true for
// future users, not just for the recorded chapters.
//
// Rules:
//   R1  Every committed ClusterProfile/Profile selector must address exactly
//       one cluster: its matchLabels must be exactly the single key
//       "cluster". Any other selector can fan out and is refused unless the
//       file is declared in tests/per-cluster-model-legacy.yaml.
//   R2  The legacy register is a ratchet, not a licence: an entry whose file
//       is gone, or whose file no longer violates R1, is itself a refusal,
//       so retiring the debt must retire the entry in the same change. Every
//       entry needs a reason, and this register only shrinks.
//   R3  Every variants declaration must give each workload cluster a
//       departure for metadata.name and a departure that addresses that
//       cluster by name (spec.clusterSelector.matchLabels.cluster equal to
//       the entry's cluster), and must declare the management record.
//
// --verify walks the committed examples; --self-test runs the same pure
// assessment against synthetic surfaces, including every refusal.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseDocs, readYamlText } from "./lib/proof-common.mjs";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..");
const EXAMPLES_DIR = "examples/sveltos";
const LEGACY_PATH = "tests/per-cluster-model-legacy.yaml";
const PROFILE_KINDS = new Set(["ClusterProfile", "Profile"]);

function walkYamlFiles(root, dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = `${dir}/${name}`;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) out.push(...walkYamlFiles(root, rel));
    else if (name.endsWith(".yaml") || name.endsWith(".yml")) out.push(rel);
  }
  return out;
}

export function loadSurfaces(root) {
  const files = new Map();
  for (const rel of walkYamlFiles(root, EXAMPLES_DIR)) {
    const docs = parseDocs(readFileSync(join(root, rel), "utf8"));
    files.set(rel, docs);
  }
  const legacy = readYamlText(readFileSync(join(root, LEGACY_PATH), "utf8"));
  return { files, legacy };
}

function selectorKeys(doc) {
  const ml = doc?.spec?.clusterSelector?.matchLabels;
  if (!ml || typeof ml !== "object") return null;
  return Object.keys(ml).sort();
}

function addressesOneCluster(doc) {
  const keys = selectorKeys(doc);
  return keys !== null && keys.length === 1 && keys[0] === "cluster";
}

export function assessModel({ files, legacy }) {
  const findings = [];
  const entries = Array.isArray(legacy?.entries) ? legacy.entries : null;
  if (!entries) {
    return [`${LEGACY_PATH}: no entries list; the register must exist even when empty`];
  }

  const entryByPath = new Map();
  for (const entry of entries) {
    if (!entry?.path) {
      findings.push(`${LEGACY_PATH}: entry without a path`);
      continue;
    }
    if (!entry.reason || !String(entry.reason).trim()) {
      findings.push(`${LEGACY_PATH}: ${entry.path} has no reason; declared debt must say why it stands`);
    }
    if (entryByPath.has(entry.path)) {
      findings.push(`${LEGACY_PATH}: ${entry.path} is listed twice`);
    }
    entryByPath.set(entry.path, entry);
    if (!files.has(entry.path)) {
      findings.push(`${LEGACY_PATH}: ${entry.path} no longer exists; retire the entry in this change`);
    }
  }

  for (const [path, docs] of files) {
    const profiles = docs.filter((d) => PROFILE_KINDS.has(d?.kind));
    if (profiles.length === 0) continue;
    const violating = profiles.filter((d) => !addressesOneCluster(d));
    const entry = entryByPath.get(path);
    if (violating.length > 0 && !entry) {
      for (const doc of violating) {
        const keys = selectorKeys(doc);
        findings.push(
          `${path}: ${doc.kind} ${doc?.metadata?.name ?? "(unnamed)"} selects ` +
            `{${keys ? keys.join(", ") : "no matchLabels"}}, which can match more than one cluster. ` +
            `One record addresses one cluster (matchLabels with exactly the key "cluster"). ` +
            `Fix the selector; do not add a new entry to ${LEGACY_PATH}, which only shrinks.`,
        );
      }
    }
    if (violating.length === 0 && entry) {
      findings.push(
        `${LEGACY_PATH}: ${path} no longer violates the model; retire the entry in this change`,
      );
    }
  }

  for (const [path, docs] of files) {
    for (const doc of docs) {
      const workloads = doc?.spec?.workloads;
      // Only a variants declaration (it declares a base) is held to the
      // departure rules; a fleet registry also lists workloads but declares
      // clusters, not records.
      if (!doc?.spec?.base || !Array.isArray(workloads)) continue;
      for (const w of workloads) {
        const departures = w?.departures ?? {};
        const address = departures["spec.clusterSelector.matchLabels.cluster"];
        if (!departures["metadata.name"]) {
          findings.push(`${path}: workload ${w?.cluster ?? "(unnamed)"} declares no metadata.name departure`);
        }
        if (!address) {
          findings.push(`${path}: workload ${w?.cluster ?? "(unnamed)"} declares no cluster-address departure`);
        } else if (address !== w?.cluster) {
          findings.push(
            `${path}: workload ${w?.cluster} addresses "${address}"; a record's address departure must name its own cluster`,
          );
        }
      }
      if (!doc?.spec?.management) {
        findings.push(`${path}: variants declaration has no management record; the management cluster is part of the model`);
      }
    }
  }

  return findings;
}

function profileDoc(kind, name, matchLabels) {
  return { kind, metadata: { name }, spec: { clusterSelector: { matchLabels } } };
}

function selfTest() {
  const okLegacy = { entries: [] };
  const cases = [];
  const expectClean = (label, surfaces) => cases.push({ label, surfaces, want: 0 });
  const expectRefusal = (label, surfaces, needle) => cases.push({ label, surfaces, want: 1, needle });

  expectClean("addressed profile passes", {
    files: new Map([["examples/sveltos/x/a.yaml", [profileDoc("ClusterProfile", "a", { cluster: "hx-a" })]]]),
    legacy: okLegacy,
  });
  expectClean("base addressing no registered cluster passes the same rule", {
    files: new Map([["examples/sveltos/x/base.yaml", [profileDoc("ClusterProfile", "base", { cluster: "unassigned" })]]]),
    legacy: okLegacy,
  });
  expectRefusal(
    "fan-out selector refuses",
    {
      files: new Map([["examples/sveltos/x/a.yaml", [profileDoc("ClusterProfile", "a", { environment: "prod" })]]]),
      legacy: okLegacy,
    },
    "can match more than one cluster",
  );
  expectClean("declared legacy fan-out stands while it still violates", {
    files: new Map([["examples/sveltos/x/a.yaml", [profileDoc("ClusterProfile", "a", { environment: "prod" })]]]),
    legacy: { entries: [{ path: "examples/sveltos/x/a.yaml", issue: null, reason: "recorded shape" }] },
  });
  expectRefusal(
    "legacy entry for a missing file refuses",
    { files: new Map(), legacy: { entries: [{ path: "examples/sveltos/x/gone.yaml", issue: null, reason: "old" }] } },
    "no longer exists; retire the entry",
  );
  expectRefusal(
    "legacy entry for a fixed file refuses",
    {
      files: new Map([["examples/sveltos/x/a.yaml", [profileDoc("ClusterProfile", "a", { cluster: "hx-a" })]]]),
      legacy: { entries: [{ path: "examples/sveltos/x/a.yaml", issue: null, reason: "old" }] },
    },
    "no longer violates the model; retire the entry",
  );
  expectRefusal(
    "legacy entry without a reason refuses",
    {
      files: new Map([["examples/sveltos/x/a.yaml", [profileDoc("ClusterProfile", "a", { environment: "prod" })]]]),
      legacy: { entries: [{ path: "examples/sveltos/x/a.yaml", issue: null, reason: "" }] },
    },
    "has no reason",
  );
  expectClean("a fleet registry lists clusters, not records, and is not held to departures", {
    files: new Map([
      ["examples/sveltos/x/fleet.yaml", [{ kind: "SveltosEnvRolloutFleet", spec: { management: { cluster: "hx-mgmt" }, workloads: [{ cluster: "hx-a", environment: "pilot" }] } }]],
    ]),
    legacy: okLegacy,
  });
  expectRefusal(
    "variants entry without a cluster address refuses",
    {
      files: new Map([
        ["examples/sveltos/x/variants.yaml", [{ kind: "SveltosEnvRolloutVariants", spec: { base: { unit: "clusterprofile" }, workloads: [{ cluster: "hx-a", departures: { "metadata.name": "a" } }], management: {} } }]],
      ]),
      legacy: okLegacy,
    },
    "no cluster-address departure",
  );
  expectRefusal(
    "variants entry addressing another cluster refuses",
    {
      files: new Map([
        ["examples/sveltos/x/variants.yaml", [{ kind: "SveltosEnvRolloutVariants", spec: { base: { unit: "clusterprofile" }, workloads: [{ cluster: "hx-a", departures: { "metadata.name": "a", "spec.clusterSelector.matchLabels.cluster": "hx-b" } }], management: {} } }]],
      ]),
      legacy: okLegacy,
    },
    "must name its own cluster",
  );
  expectRefusal(
    "variants declaration without a management record refuses",
    {
      files: new Map([
        ["examples/sveltos/x/variants.yaml", [{ kind: "SveltosEnvRolloutVariants", spec: { base: { unit: "clusterprofile" }, workloads: [{ cluster: "hx-a", departures: { "metadata.name": "a", "spec.clusterSelector.matchLabels.cluster": "hx-a" } }] } }]],
      ]),
      legacy: okLegacy,
    },
    "no management record",
  );

  for (const c of cases) {
    const findings = assessModel(c.surfaces);
    if (c.want === 0 && findings.length !== 0) {
      throw new Error(`self-test "${c.label}" expected no findings, got:\n${findings.join("\n")}`);
    }
    if (c.want === 1) {
      if (findings.length === 0) throw new Error(`self-test "${c.label}" expected a refusal, got none`);
      if (!findings.some((f) => f.includes(c.needle))) {
        throw new Error(`self-test "${c.label}" expected a finding containing "${c.needle}", got:\n${findings.join("\n")}`);
      }
    }
  }

  const committed = assessModel(loadSurfaces(repoRoot));
  if (committed.length !== 0) {
    throw new Error(`self-test expects the committed tree to pass, got:\n${committed.join("\n")}`);
  }

  console.log(
    `per-cluster model self-test passed: the addressed pass, the base pass, the fan-out refusal, ` +
      `the three register ratchet refusals, the fleet-registry pass, the three variants refusals, and the committed tree`,
  );
}

function verify() {
  const findings = assessModel(loadSurfaces(repoRoot));
  if (findings.length > 0) {
    for (const f of findings) console.error(`refused: ${f}`);
    process.exit(1);
  }
  console.log("verified the per-cluster model: every committed profile addresses one cluster or stands in the shrinking legacy register");
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--verify" || mode === undefined) verify();
else {
  console.error(`unknown mode ${mode}; use --verify or --self-test`);
  process.exit(1);
}
