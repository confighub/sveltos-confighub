#!/usr/bin/env node

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
import { dirname, join } from "node:path";

import {
  check,
  parseDocs,
  readYaml,
  repoRoot,
  sha256,
  toYaml,
  write,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
if (!["--generate", "--verify", "--self-test"].includes(mode)) {
  console.error(`Usage:
  node scripts/generate-sveltos-env-rollout.mjs --generate
  node scripts/generate-sveltos-env-rollout.mjs --verify
  node scripts/generate-sveltos-env-rollout.mjs --self-test`);
  process.exit(2);
}

const exampleFiles = [
  "examples/sveltos/env-rollout/clusterprofile-base.yaml",
  "examples/sveltos/env-rollout/variants.yaml",
  "examples/sveltos/env-rollout/fleet.yaml",
  "examples/sveltos/env-rollout/change-candidate.yaml",
];
// The committed live receipt fills the observed columns, so the fixture
// compile has to see it too or the determinism check compares a recorded
// matrix against an unrecorded one.
const liveReceiptFile = "runs/sveltos-env-rollout-proof/receipt.yaml";
const outputFiles = [
  "data/sveltos-env-rollout/matrix.csv",
  "data/sveltos-env-rollout/matrix.md",
  "data/sveltos-env-rollout/matrix.html",
];
const environments = ["pilot", "staging", "prod"];
const changeField = "spec.helmCharts.0.values";
const addressingDepartures = [
  "metadata.name",
  "spec.clusterSelector.matchLabels.cluster",
];
// The committed receipt governs three environment records, which this chapter
// no longer builds, so it fills nothing until the per-cluster run is recorded.
const blocker = "awaiting-per-cluster-rerecord";
const proofStatus = "awaiting-live-run";
const supersededNote = "the recorded receipt governs three environment records and predates the per-cluster variant design; it awaits a live re-record";

if (mode === "--generate") {
  const outputs = buildOutputs(compileRollout(repoRoot));
  for (const [file, text] of Object.entries(outputs)) {
    write(join(repoRoot, file), text);
    console.log(`wrote ${file}`);
  }
} else if (mode === "--verify") {
  const compiled = compileRollout(repoRoot);
  const outputs = buildOutputs(compiled);
  for (const [file, text] of Object.entries(outputs)) {
    check(
      readFileSync(join(repoRoot, file), "utf8") === text,
      `${file} is stale; run node scripts/generate-sveltos-env-rollout.mjs --generate`,
    );
  }
  if (compiled.superseded) console.log(supersededNote);
  console.log("verified the Sveltos environment rollout matrix surfaces");
} else {
  selfTest();
  console.log(
    "sveltos env rollout self-test passed: deterministic surfaces, one base with per-cluster variants, the departure and fan-out refusals, self-contained HTML, the receipt compiled against in full or recognized as superseded, and the receipt-fill path with its refusals",
  );
}

// The matrix compiles from one base profile and one variants record, so the
// departures it shows are the declared departures rather than differences
// spotted between hand-written files.
function compileRollout(root) {
  const exampleRoot = join(root, "examples", "sveltos", "env-rollout");
  const fleet = readYaml(join(exampleRoot, "fleet.yaml"));
  const change = readYaml(join(exampleRoot, "change-candidate.yaml"));
  const variants = readYaml(join(exampleRoot, "variants.yaml"));

  check(
    fleet.kind === "SveltosEnvRolloutFleet" && fleet.spec?.management?.cluster,
    "the fleet record lost its management cluster",
  );
  const workloads = fleet.spec?.workloads ?? [];
  check(
    workloads.length === 4
      && new Set(workloads.map((row) => row.cluster)).size === 4,
    "the fleet must declare four uniquely named workload clusters",
  );
  for (const environment of environments) {
    const members = workloads.filter((row) => row.environment === environment);
    const expected = environment === "prod" ? 2 : 1;
    check(
      members.length === expected,
      `the fleet must place ${expected} cluster(s) in ${environment}`,
    );
  }
  check(
    workloads.every((row) => environments.includes(row.environment)),
    "a fleet cluster uses an unknown environment label",
  );

  check(
    change.kind === "SveltosEnvRolloutChange"
      && typeof change.spec?.valuesPath === "string"
      && change.spec.valuesPath.length > 0
      && change.spec.editedRecord === "base",
    "the change candidate lost its values path or the record it edits",
  );
  check(
    change.spec.before !== change.spec.after,
    "the change candidate does not change anything",
  );
  const waves = change.spec?.waves ?? [];
  check(
    waves.length === 3
      && waves.map((row) => row.environment).join(",") === environments.join(",")
      && waves.map((row) => row.wave).join(",") === "1,2,3",
    "the change waves must cover pilot, staging, and prod in order",
  );
  const selection = change.spec?.selection ?? {};
  check(
    String(selection.whereTemplate ?? "").includes("{environment}")
      && String(selection.whereTemplate).includes("{run}"),
    "the change candidate lost the reviewed set query each wave selects with",
  );

  const basePath = join(exampleRoot, variants.spec?.base?.profile ?? "");
  const baseDocs = parseDocs(readFileSync(basePath, "utf8"));
  check(
    variants.kind === "SveltosEnvRolloutVariants"
      && variants.spec?.base?.reachesCluster === false
      && baseDocs.length === 1,
    "the variants record lost its base declaration",
  );
  const baseDoc = baseDocs[0];
  const baseSelector = baseDoc.spec?.clusterSelector?.matchLabels ?? {};
  check(
    baseDoc.kind === "ClusterProfile"
      && Object.keys(baseSelector).join(",") === "cluster"
      && !workloads.some((row) => row.cluster === baseSelector.cluster),
    "the base profile must carry a cluster selector that addresses no registered cluster",
  );
  check(
    baseDoc.spec?.syncMode === "ContinuousWithDriftDetection",
    "the base profile drift mode changed",
  );
  check(
    baseDoc.spec?.helmCharts?.length === 1
      && baseDoc.spec.helmCharts[0].chartName === change.spec.chart
      && String(baseDoc.spec.helmCharts[0].chartVersion)
      === String(change.spec.chartVersion),
    "the base profile chart pin changed",
  );
  const baseValues = parseDocs(baseDoc.spec.helmCharts[0].values)[0];
  check(
    readPath(baseValues, change.spec.valuesPath) === change.spec.before,
    "the change candidate before-value does not match the base values",
  );

  const declaredVariants = variants.spec?.workloads ?? [];
  check(
    declaredVariants.length === workloads.length
      && declaredVariants.every((row, index) =>
        row.cluster === workloads[index].cluster
        && row.environment === workloads[index].environment),
    "the variants record must declare one variant per fleet cluster, in fleet order",
  );
  const declaredSpaces = [
    variants.spec.base.space,
    ...declaredVariants.map((row) => row.space),
    variants.spec?.management?.space,
  ];
  check(
    declaredSpaces.every((space) =>
      typeof space === "string" && space === space.toLowerCase())
      && new Set(declaredSpaces).size === declaredSpaces.length,
    "every declared Space must be lowercase and belong to one record",
  );

  const waveOf = Object.fromEntries(waves.map((row) => [row.environment, row]));
  const clusters = declaredVariants.map((row) => {
    const departures = row.departures ?? {};
    const departurePaths = Object.keys(departures).sort();
    check(
      departures["spec.clusterSelector.matchLabels.cluster"] === row.cluster
        && typeof departures["metadata.name"] === "string"
        && departurePaths.some((path) => !addressingDepartures.includes(path)),
      `${row.cluster} must depart on its own selector, its own name, and at least one field beyond addressing`,
    );
    for (const path of departurePaths) {
      check(
        !fieldsCollide(path, changeField, baseDoc),
        `${row.cluster} departs on ${path}, which the reviewed change also writes; a departure wins that merge silently, so this promotion is refused`,
      );
    }
    const baselineDoc = applyDepartures(baseDoc, departures);
    const changedDoc = withChangedValue(
      baselineDoc,
      change.spec.valuesPath,
      change.spec.after,
    );
    return {
      cluster: row.cluster,
      environment: row.environment,
      wave: waveOf[row.environment].wave,
      space: row.space,
      departures,
      departurePaths,
      revisions: {
        baseline: `r1-${sha256(stableJson(baselineDoc)).slice(0, 12)}`,
        changed: `r2-${sha256(stableJson(changedDoc)).slice(0, 12)}`,
      },
    };
  });
  check(
    new Set(clusters.map((row) => row.departures["metadata.name"])).size
      === clusters.length,
    "every per-cluster profile must carry its own name",
  );
  for (const wave of waves) {
    check(
      sameSet(
        wave.clusters ?? [],
        clusters.filter((row) => row.environment === wave.environment)
          .map((row) => row.cluster),
      ),
      `wave ${wave.wave} must name exactly the ${wave.environment} clusters`,
    );
  }

  const checkpoints = [
    { id: "baseline", title: "Baseline, before the change", completedWave: 0 },
    { id: "after-wave-1", title: "After wave 1, pilot", completedWave: 1 },
    { id: "after-wave-2", title: "After wave 2, staging", completedWave: 2 },
    { id: "after-wave-3", title: "After wave 3, production", completedWave: 3 },
  ];
  const rows = [];
  for (const checkpoint of checkpoints) {
    for (const row of clusters) {
      const changed = row.wave <= checkpoint.completedWave;
      rows.push({
        checkpoint: checkpoint.id,
        cluster: row.cluster,
        environment: row.environment,
        wave: row.wave,
        space: row.space,
        upstream: variants.spec.base.space,
        departures: row.departurePaths
          .filter((path) => !addressingDepartures.includes(path))
          .map((path) => `${path}=${row.departures[path]}`)
          .join(";"),
        expectedRevision: changed ? row.revisions.changed : row.revisions.baseline,
        expectedBackgroundReplicas: changed
          ? change.spec.after
          : change.spec.before,
        observedRelease: "",
        observedBackgroundReplicas: "",
        proofStatus,
        blocker,
        evidence: [
          "examples/sveltos/env-rollout/clusterprofile-base.yaml",
          "examples/sveltos/env-rollout/variants.yaml",
          "examples/sveltos/env-rollout/change-candidate.yaml",
        ].join(";"),
      });
    }
  }
  const compiled = {
    fleet,
    change,
    variants,
    clusters,
    checkpoints,
    rows,
    live: null,
    superseded: false,
  };
  fillObservedColumns(compiled, root);
  return compiled;
}

// When the live runner has committed a receipt of this design, the observed
// columns come from it. The committed receipt governs three environment
// records, so it fills nothing and says so instead.
function fillObservedColumns(compiled, root) {
  const liveReceiptPath = join(
    root, "runs", "sveltos-env-rollout-proof", "receipt.yaml",
  );
  if (!existsSync(liveReceiptPath)) return;
  const receipt = readYaml(liveReceiptPath);
  if (!Array.isArray(receipt?.spec?.variants)) {
    compiled.superseded = true;
    return;
  }
  for (const row of compiled.clusters) {
    check(
      receipt.spec?.revisions?.clusters?.[row.cluster]?.baseline
        === row.revisions.baseline
        && receipt.spec.revisions.clusters[row.cluster].changed
        === row.revisions.changed,
      "the live receipt disagrees with the reviewed expected revisions",
    );
  }
  const observed = new Map();
  for (const checkpoint of receipt.spec?.checkpoints ?? []) {
    for (const observation of checkpoint.observations ?? []) {
      observed.set(`${checkpoint.id}|${observation.logicalCluster}`, observation);
    }
  }
  for (const row of compiled.rows) {
    const observation = observed.get(`${row.checkpoint}|${row.cluster}`);
    check(
      observation,
      `the live receipt records no observation for ${row.cluster} at ${row.checkpoint}`,
    );
    check(
      observation.expectedRevisionId === row.expectedRevision,
      `the live receipt expected a different revision for ${row.cluster} at ${row.checkpoint}`,
    );
    row.observedRelease = observation.observation?.helmRelease?.chart ?? "";
    row.observedBackgroundReplicas =
      observation.observation?.backgroundReplicas?.available ?? "";
    row.proofStatus = observation.observation?.result === "pass"
      ? "observed-pass"
      : "observed-fail";
    row.blocker = "";
  }
  compiled.live = { recordedAt: receipt.spec?.recordedAt ?? "" };
}

function applyDepartures(baseDoc, departures) {
  const doc = structuredClone(baseDoc);
  for (const [path, value] of Object.entries(departures)) {
    writePath(doc, path, value, true);
  }
  return doc;
}

function withChangedValue(doc, valuesPath, next) {
  const changed = structuredClone(doc);
  const values = parseDocs(doc.spec.helmCharts[0].values)[0];
  writePath(values, valuesPath, next);
  changed.spec.helmCharts[0].values = `${toYaml(values)}\n`;
  return changed;
}

// Two writes collide when they name the same field or when one contains the
// other, and also when they write different keys of the same map of scalars.
// The rule matches scripts/run-sveltos-env-rollout-proof.mjs exactly.
function fieldsCollide(left, right, doc) {
  if (left === right) return true;
  if (left.startsWith(`${right}.`) || right.startsWith(`${left}.`)) return true;
  const leftParent = parentPath(left);
  const rightParent = parentPath(right);
  if (!leftParent || leftParent !== rightParent) return false;
  const node = readPath(doc, leftParent);
  return Boolean(node)
    && typeof node === "object"
    && !Array.isArray(node)
    && Object.values(node).every(
      (value) => value === null || typeof value !== "object",
    );
}

function parentPath(path) {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(0, index);
}

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function buildOutputs(compiled) {
  return {
    "data/sveltos-env-rollout/matrix.csv": renderCsv(compiled),
    "data/sveltos-env-rollout/matrix.md": renderMarkdown(compiled),
    "data/sveltos-env-rollout/matrix.html": renderHtml(compiled),
  };
}

function renderCsv(compiled) {
  const header = [
    "checkpoint", "cluster", "environment", "wave", "space", "upstream",
    "departures", "expected_revision", "expected_background_replicas",
    "observed_release", "observed_background_replicas",
    "proof_status", "blocker", "evidence",
  ];
  const lines = [header.join(",")];
  for (const row of compiled.rows) {
    lines.push([
      row.checkpoint, row.cluster, row.environment, row.wave, row.space,
      row.upstream, row.departures,
      row.expectedRevision, row.expectedBackgroundReplicas,
      row.observedRelease, row.observedBackgroundReplicas,
      row.proofStatus, row.blocker, row.evidence,
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(compiled) {
  const { change } = compiled;
  const lines = [
    "# Sveltos environment rollout, the per-cluster matrix",
    "",
    "Chapter three of the Sveltos fleet example promotes one reviewed change",
    `through the environment groups. The change raises \`${change.spec.valuesPath}\``,
    `from ${change.spec.before} to ${change.spec.after} in the ${change.spec.chart} chart, version ${change.spec.chartVersion}.`,
    "It is made once, on the base record. ConfigHub holds one variant per",
    "cluster over that base, so the matrix shows exactly which cluster runs",
    "which revision at every checkpoint, and which departure each cluster keeps",
    "through the change.",
    "",
    ...(compiled.live
      ? [
        "The observed columns come from the committed live receipt in",
        "`runs/sveltos-env-rollout-proof/receipt.yaml`. The expected columns",
        "come from the reviewed example files.",
      ]
      : [
        "No live run of this design has been recorded yet, so every observed",
        `cell below stays empty until the live proof earns it. ${compiled.superseded ? "The committed receipt governs three environment records and predates the per-cluster variant design." : ""}`,
        "The expected columns come from the reviewed example files.",
      ]),
    "",
  ];
  for (const checkpoint of compiled.checkpoints) {
    lines.push(`## ${checkpoint.title}`);
    lines.push("");
    lines.push("| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of compiled.rows.filter((item) => item.checkpoint === checkpoint.id)) {
      const observedCell = row.observedBackgroundReplicas === ""
        ? ""
        : `${row.observedRelease} with ${row.observedBackgroundReplicas} background replicas`;
      const statusCell = row.blocker
        ? `${row.proofStatus} (${row.blocker})`
        : row.proofStatus;
      lines.push(
        `| ${row.cluster} | ${row.environment} | ${row.wave} | \`${row.expectedRevision}\` | \`${row.departures}\` | ${row.expectedBackgroundReplicas} | ${observedCell} | ${statusCell} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Sources");
  lines.push("");
  lines.push("- [Base profile](../../examples/sveltos/env-rollout/clusterprofile-base.yaml)");
  lines.push("- [Per-cluster variants](../../examples/sveltos/env-rollout/variants.yaml)");
  lines.push("- [Fleet design](../../examples/sveltos/env-rollout/fleet.yaml)");
  lines.push("- [Change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)");
  return `${lines.join("\n")}\n`;
}

function renderHtml(compiled) {
  const { change } = compiled;
  const head = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sveltos environment rollout matrix</title>',
    "<style>:root{color-scheme:light dark}body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#fff;color:#17212b}h1{font-size:1.7rem;margin-bottom:.25rem}.lede{max-width:95ch;color:#3f4d5a}.legend{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.key{border-radius:.25rem;padding:.3rem .5rem;font-weight:700}.baseline{background:#dce9ff;color:#173b75}.changed{background:#d7f2df;color:#14532d}.awaiting{background:#fff0bd;color:#634b00}.observed{background:#d7f2df;color:#14532d}.failed{background:#fadbd8;color:#7b241c}table{border-collapse:collapse;width:100%;margin:1.25rem 0;font-size:.84rem}caption{text-align:left;font-size:1rem;font-weight:700;padding:.5rem 0}th,td{border:1px solid #aeb8c2;padding:.5rem;text-align:left;vertical-align:top}thead th{background:#edf1f5;color:#17212b}code{white-space:normal;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#10161d;color:#eef4fa}.lede{color:#c6d1dc}thead th{background:#25313d;color:#fff}.baseline{background:#173b75;color:#fff}.changed{background:#14532d;color:#fff}.awaiting{background:#634b00;color:#fff}.observed{background:#14532d;color:#fff}.failed{background:#7b241c;color:#fff}}</style></head>",
    "<body><main><h1>Sveltos environment rollout, the per-cluster matrix</h1>",
    `<p class="lede">One reviewed change moves through the environment groups: <code>${change.spec.valuesPath}</code> goes from ${change.spec.before} to ${change.spec.after} in ${change.spec.chart} ${change.spec.chartVersion}. It is made once on the base record, and ConfigHub holds one variant per cluster over that base. ${compiled.live ? "The observed columns come from the committed live receipt in <code>runs/sveltos-env-rollout-proof/receipt.yaml</code>." : `No live run of this design has been recorded yet, so every observed cell stays empty until the live proof earns it.${compiled.superseded ? " The committed receipt governs three environment records and predates the per-cluster variant design." : ""}`}</p>`,
    `<div class="legend"><span class="key baseline">baseline revision</span><span class="key changed">changed revision</span>${compiled.live ? '<span class="key observed">observed live</span>' : '<span class="key awaiting">awaiting live run</span>'}</div>`,
  ];
  const tables = [];
  for (const checkpoint of compiled.checkpoints) {
    const rows = compiled.rows
      .filter((item) => item.checkpoint === checkpoint.id)
      .map((row) => {
        const revisionClass = row.expectedRevision.startsWith("r2-") ? "changed" : "baseline";
        const observedCell = row.observedBackgroundReplicas === ""
          ? '<span class="key awaiting">awaiting live run</span>'
          : `<span class="key ${row.proofStatus === "observed-pass" ? "observed" : "failed"}">${row.observedRelease} with ${row.observedBackgroundReplicas} background replicas</span>`;
        return `<tr><td>${row.cluster}</td><td>${row.environment}</td><td>${row.wave}</td><td><span class="key ${revisionClass}"><code>${row.expectedRevision}</code></span></td><td><code>${row.departures}</code></td><td>${row.expectedBackgroundReplicas}</td><td>${observedCell}</td></tr>`;
      });
    tables.push(
      `<table><caption>${checkpoint.title}</caption><thead><tr><th>Cluster</th><th>Environment</th><th>Wave</th><th>Expected revision</th><th>Departure kept</th><th>Expected background replicas</th><th>Observed</th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
    );
  }
  const tail = [
    `<p class="lede">Sources: the base profile, the per-cluster variants, the fleet design, and the change candidate live in <code>examples/sveltos/env-rollout/</code>. The matrix is generated by <code>scripts/generate-sveltos-env-rollout.mjs</code>.</p>`,
    "</main></body></html>",
  ];
  return `${[...head, ...tables, ...tail].join("\n")}\n`;
}

function readPath(value, path) {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

// A departure may add a field the base never carried, so the writer can create
// the map on the way down when the caller asks for it.
function writePath(value, path, next, createMissing = false) {
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

function selfTest() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-rollout-self-test-"));
  try {
    for (const file of [...exampleFiles, liveReceiptFile]) {
      const source = join(repoRoot, file);
      if (!existsSync(source)) continue;
      const destination = join(fixtureRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
    }
    const first = buildOutputs(compileRollout(fixtureRoot));
    const second = buildOutputs(compileRollout(fixtureRoot));
    check(
      JSON.stringify(first) === JSON.stringify(second),
      "the rollout surfaces are not deterministic",
    );
    for (const file of outputFiles) {
      check(
        first[file] === readFileSync(join(repoRoot, file), "utf8"),
        `${file} differs from the fixture compile; run --generate`,
      );
    }

    const csv = first["data/sveltos-env-rollout/matrix.csv"];
    check(
      csv.trim().split("\n").length === 17,
      "the matrix must hold sixteen cluster rows across four checkpoints",
    );
    const compiled = compileRollout(fixtureRoot);
    check(
      compiled.clusters.length === 4
        && new Set(compiled.clusters.map((row) => row.space)).size === 4
        && compiled.clusters.every((row) =>
          row.departures["spec.clusterSelector.matchLabels.cluster"] === row.cluster
          && row.departurePaths.some((path) =>
            !addressingDepartures.includes(path))),
      "the matrix must compile one single-cluster variant per workload cluster",
    );
    // Before the live run every row must stay honestly empty. After it, every
    // row must carry an observation, because a recorded run that leaves cells
    // blank is the same dishonesty pointing the other way.
    if (compiled.live) {
      check(
        csv.split("observed-pass").length === 17 && !csv.includes(proofStatus),
        "every matrix row must carry its observation once the live run is recorded",
      );
    } else {
      check(
        !csv.includes("observed-pass") && csv.split(proofStatus).length === 17,
        "every matrix row must stay honestly awaiting the live run",
      );
    }
    // A committed receipt is either this design's own recording, in which case
    // the matrix compiles against it, or a receipt of the earlier three-record
    // shape, in which case it is recognized as superseded and fills nothing.
    // What it may never be is half-read, filling some cells from a receipt the
    // rest of the matrix does not describe.
    check(
      !existsSync(join(fixtureRoot, liveReceiptFile))
        || (compiled.live !== null && compiled.superseded === false)
        || (compiled.live === null && compiled.superseded === true),
      "a committed receipt must be compiled against in full or recognized as superseded",
    );
    const html = first["data/sveltos-env-rollout/matrix.html"];
    check(
      !/<script[^>]*src=|<link[^>]+rel="stylesheet"|url\(http/.test(html),
      "the matrix HTML must stay self-contained",
    );
    const markdown = first["data/sveltos-env-rollout/matrix.md"];
    for (const row of compiled.rows) {
      check(
        markdown.includes(row.expectedRevision) && csv.includes(row.expectedRevision),
        "the markdown and CSV views disagree on a revision identity",
      );
      check(
        markdown.includes(row.departures) && csv.includes(row.departures),
        "the markdown and CSV views disagree on a departure",
      );
    }

    const tampers = [
      [
        "before-value drift",
        (root) => editFile(root, "change-candidate.yaml", (text) =>
          text.replace("before: 1", "before: 2")),
        /(before-value does not match the base|does not change anything)/,
      ],
      [
        "empty change",
        (root) => editFile(root, "change-candidate.yaml", (text) =>
          text.replace("after: 2", "after: 1")),
        /does not change anything/,
      ],
      [
        "wave order",
        (root) => editFile(root, "change-candidate.yaml", (text) =>
          text.replace("      environment: staging", "      environment: prod")),
        /waves must cover pilot, staging, and prod in order/,
      ],
      [
        "wave membership",
        (root) => editFile(root, "change-candidate.yaml", (text) =>
          text.replace("        - hx-sveltos-env-prod-b\n", "")),
        /must name exactly the prod clusters/,
      ],
      [
        "prod group size",
        (root) => editFile(root, "fleet.yaml", (text) =>
          text.replace("environment: prod\n    - cluster: hx-sveltos-env-prod-b", "environment: staging\n    - cluster: hx-sveltos-env-prod-b")),
        /must place/,
      ],
      [
        "base selector addresses a cluster",
        (root) => editFile(root, "clusterprofile-base.yaml", (text) =>
          text.replace("cluster: unassigned", "cluster: hx-sveltos-env-pilot")),
        /addresses no registered cluster/,
      ],
      [
        "variant fans out",
        (root) => editFile(root, "variants.yaml", (text) =>
          text.replace(
            "        spec.clusterSelector.matchLabels.cluster: hx-sveltos-env-pilot",
            "        spec.clusterSelector.matchLabels.environment: pilot",
          )),
        /must depart on its own selector/,
      ],
      [
        "departure on the changed field",
        (root) => editFile(root, "variants.yaml", (text) =>
          text.replace(
            "        spec.stopMatchingBehavior: LeavePolicies\n    - cluster: hx-sveltos-env-prod-b",
            "        spec.helmCharts.0.values: the whole values document\n    - cluster: hx-sveltos-env-prod-b",
          )),
        /which the reviewed change also writes/,
      ],
      [
        "shared Space",
        (root) => editFile(root, "variants.yaml", (text) =>
          text.replace(
            "      space: sveltos-kyverno-env-prod-b",
            "      space: sveltos-kyverno-env-prod-a",
          )),
        /belong to one record/,
      ],
      [
        "chart pin",
        (root) => editFile(root, "clusterprofile-base.yaml", (text) =>
          text.replace("chartVersion: 3.8.1", "chartVersion: 3.9.0")),
        /chart pin changed/,
      ],
      [
        "missing values path",
        (root) => editFile(root, "change-candidate.yaml", (text) =>
          text.replace("valuesPath: backgroundController.replicas", "valuesPath: cleanupController.replicas")),
        /(does not exist in the baseline values|before-value does not match the base)/,
      ],
    ];
    for (const [label, tamper, pattern] of tampers) {
      const tamperedRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-rollout-tamper-"));
      try {
        for (const file of exampleFiles) {
          const destination = join(tamperedRoot, file);
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(join(repoRoot, file), destination);
        }
        tamper(tamperedRoot);
        expectFailure(() => compileRollout(tamperedRoot), pattern, label);
      } finally {
        rmSync(tamperedRoot, { recursive: true, force: true });
      }
    }

    selfTestReceiptFill();
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// The live runner writes runs/sveltos-env-rollout-proof/receipt.yaml; this
// proves the matrix flips its observed columns from a matching receipt of this
// design, refuses one that disagrees with the reviewed files, and leaves the
// columns empty for a receipt that predates the design.
function selfTestReceiptFill() {
  const receiptRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-env-rollout-receipt-"));
  const receiptFile = join(
    receiptRoot, "runs", "sveltos-env-rollout-proof", "receipt.yaml",
  );
  try {
    for (const file of exampleFiles) {
      const destination = join(receiptRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repoRoot, file), destination);
    }
    const planned = compileRollout(receiptRoot);
    const fakeReceipt = {
      apiVersion: "catalog.confighub.com/v1alpha1",
      kind: "SveltosEnvRolloutProofReceipt",
      spec: {
        recordedAt: "self-test",
        variants: planned.clusters.map((row) => ({
          cluster: row.cluster,
          space: row.space,
        })),
        revisions: {
          clusters: Object.fromEntries(
            planned.clusters.map((row) => [row.cluster, row.revisions]),
          ),
        },
        checkpoints: planned.checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          observations: planned.rows
            .filter((row) => row.checkpoint === checkpoint.id)
            .map((row) => ({
              logicalCluster: row.cluster,
              environment: row.environment,
              expectedRevisionId: row.expectedRevision,
              observation: {
                result: "pass",
                helmRelease: { chart: "kyverno-3.8.1" },
                backgroundReplicas: {
                  desired: row.expectedBackgroundReplicas,
                  available: row.expectedBackgroundReplicas,
                },
              },
            })),
        })),
      },
    };
    write(receiptFile, `${toYaml(fakeReceipt)}\n`);
    const filled = buildOutputs(compileRollout(receiptRoot));
    const filledCsv = filled["data/sveltos-env-rollout/matrix.csv"];
    check(
      filledCsv.split("observed-pass").length === 17
        && !filledCsv.includes(proofStatus)
        && !filledCsv.includes(blocker),
      "the matrix did not fill every observed cell from the receipt",
    );
    check(
      filled["data/sveltos-env-rollout/matrix.html"].includes("observed live")
        && filled["data/sveltos-env-rollout/matrix.md"].includes(
          "committed live receipt",
        ),
      "the matrix views did not disclose the live receipt source",
    );

    const superseded = structuredClone(fakeReceipt);
    delete superseded.spec.variants;
    write(receiptFile, `${toYaml(superseded)}\n`);
    const untouched = compileRollout(receiptRoot);
    check(
      untouched.superseded === true
        && untouched.live === null
        && untouched.rows.every((row) => row.proofStatus === proofStatus),
      "a receipt that predates the per-cluster design must fill nothing and say so",
    );

    const revisionDrift = structuredClone(fakeReceipt);
    revisionDrift.spec.revisions.clusters["hx-sveltos-env-pilot"].changed =
      "r2-000000000000";
    write(receiptFile, `${toYaml(revisionDrift)}\n`);
    expectFailure(
      () => compileRollout(receiptRoot),
      /disagrees with the reviewed expected revisions/,
      "receipt revision drift",
    );

    const missingObservation = structuredClone(fakeReceipt);
    missingObservation.spec.checkpoints[1].observations.pop();
    write(receiptFile, `${toYaml(missingObservation)}\n`);
    expectFailure(
      () => compileRollout(receiptRoot),
      /records no observation for/,
      "receipt missing observation",
    );

    const joinDrift = structuredClone(fakeReceipt);
    joinDrift.spec.checkpoints[0].observations[0].expectedRevisionId =
      "r1-000000000000";
    write(receiptFile, `${toYaml(joinDrift)}\n`);
    expectFailure(
      () => compileRollout(receiptRoot),
      /expected a different revision/,
      "receipt join drift",
    );
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
}

function editFile(root, name, edit) {
  const path = join(root, "examples", "sveltos", "env-rollout", name);
  const text = readFileSync(path, "utf8");
  const next = edit(text);
  check(next !== text, `the ${name} tamper did not change the fixture`);
  writeFileSync(path, next);
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
