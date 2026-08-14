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
  applyDepartures,
  readPath,
  writePath,
} from "./lib/per-cluster-fleet.mjs";

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
  node scripts/generate-sveltos-bulk-ops.mjs --generate
  node scripts/generate-sveltos-bulk-ops.mjs --verify
  node scripts/generate-sveltos-bulk-ops.mjs --self-test`);
  process.exit(2);
}

const exampleFiles = [
  "examples/sveltos/bulk-ops/clusterprofile-base.yaml",
  "examples/sveltos/bulk-ops/variants.yaml",
  "examples/sveltos/bulk-ops/bulk-change.yaml",
  "examples/sveltos/env-rollout/fleet.yaml",
  "examples/sveltos/cve-patch/clusterprofile-base.yaml",
  "examples/sveltos/cve-patch/patch-candidate.yaml",
];
// The committed live receipt fills the observed columns, so the fixture
// compile has to see it too or a recorded matrix is compared against an
// unrecorded one.
const liveReceiptFile = "runs/sveltos-bulk-ops-proof/receipt.yaml";
const outputFiles = [
  "data/sveltos-bulk-ops/matrix.csv",
  "data/sveltos-bulk-ops/matrix.md",
  "data/sveltos-bulk-ops/matrix.html",
];
const environments = ["pilot", "staging", "prod"];
// The runner now delivers through the ConfigHub OCI gateway, and nothing
// external stands in the way. What every observed cell waits for is a live run
// recorded on that path.
const blocker = "awaiting-gateway-recording";
const proofStatus = "awaiting-live-run";

if (mode === "--generate") {
  const outputs = buildOutputs(compileBulk(repoRoot));
  for (const [file, text] of Object.entries(outputs)) {
    write(join(repoRoot, file), text);
    console.log(`wrote ${file}`);
  }
} else if (mode === "--verify") {
  const outputs = buildOutputs(compileBulk(repoRoot));
  for (const [file, text] of Object.entries(outputs)) {
    check(
      readFileSync(join(repoRoot, file), "utf8") === text,
      `${file} is stale; run node scripts/generate-sveltos-bulk-ops.mjs --generate`,
    );
  }
  console.log("verified the Sveltos bulk operations matrix surfaces");
} else {
  selfTest();
  console.log(
    "sveltos bulk ops self-test passed: deterministic surfaces, continuity and fan-out refusals, self-contained HTML, the receipt compiled against in full or recognized as superseded, and the receipt-fill path with its refusals",
  );
}

function compileBulk(root) {
  const bulkRoot = join(root, "examples", "sveltos", "bulk-ops");
  const rolloutRoot = join(root, "examples", "sveltos", "env-rollout");
  const patchRoot = join(root, "examples", "sveltos", "cve-patch");
  const fleet = readYaml(join(rolloutRoot, "fleet.yaml"));
  const change = readYaml(join(bulkRoot, "bulk-change.yaml"));

  check(
    fleet.kind === "SveltosEnvRolloutFleet" && fleet.spec?.management?.cluster,
    "the shared fleet record lost its management cluster",
  );
  const workloads = fleet.spec?.workloads ?? [];
  check(
    workloads.length === 4
      && new Set(workloads.map((row) => row.cluster)).size === 4,
    "the shared fleet must declare four uniquely named workload clusters",
  );
  for (const environment of environments) {
    const expected = environment === "prod" ? 2 : 1;
    check(
      workloads.filter((row) => row.environment === environment).length
        === expected,
      `the shared fleet must place ${expected} cluster(s) in ${environment}`,
    );
  }

  check(
    change.kind === "SveltosBulkChangeCandidate"
      && typeof change.spec?.valuesPath === "string"
      && change.spec.valuesPath.length > 0,
    "the bulk change candidate lost its values path",
  );
  check(
    change.spec.before !== change.spec.after,
    "the bulk change candidate does not change anything",
  );
  check(
    change.spec?.editedRecord === "base",
    "the bulk change candidate must edit the base record",
  );
  check(
    String(change.spec?.fanOut?.approvals ?? "").includes("its own approval gate"),
    "the fan-out must state that each record keeps its own approval gate",
  );
  check(
    String(change.spec?.fanOut?.selection?.whereTemplate ?? "").includes("{run}"),
    "the fan-out lost the reviewed set query it selects with",
  );
  check(
    String(change.spec?.audit?.gateQuery ?? "").includes("LEN(ApplyGates) > 0"),
    "the audit lost its set-aware gate query",
  );

  // One base record and one variant per cluster, exactly as the earlier
  // chapters hold the same fleet. The base carries what every cluster shares
  // and reaches no cluster; each variant departs only where its own cluster
  // does.
  const variants = readYaml(join(bulkRoot, "variants.yaml"));
  const basePath = join(bulkRoot, variants.spec?.base?.profile ?? "");
  const baseDocs = parseDocs(readFileSync(basePath, "utf8"));
  check(
    variants.kind === "SveltosBulkOpsVariants"
      && variants.spec?.base?.reachesCluster === false
      && baseDocs.length === 1,
    "the variants record lost its base declaration",
  );
  const baseDoc = baseDocs[0];
  check(
    baseDoc.kind === "ClusterProfile"
      && baseDoc.spec?.clusterSelector === undefined
      && Array.isArray(baseDoc.spec?.clusterRefs)
      && baseDoc.spec.clusterRefs.length === 0,
    "the base profile must name no cluster: empty clusterRefs and no clusterSelector",
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

  // Chapter continuity: this baseline must equal chapter four's outcome, the
  // patched chart version carrying the values the earlier chapters promoted.
  const patchProfile = readYaml(join(patchRoot, "clusterprofile-base.yaml"));
  const patchCandidate = readYaml(join(patchRoot, "patch-candidate.yaml"));
  check(
    String(change.spec.chartVersion)
      === String(patchCandidate.spec.to.chartVersion),
    "the bulk baseline chart version no longer matches the chapter-four outcome",
  );
  const patchValues = parseDocs(patchProfile.spec.helmCharts[0].values)[0];
  const bulkValues = parseDocs(baseDoc.spec.helmCharts[0].values)[0];
  check(
    stableJson(bulkValues) === stableJson(patchValues),
    "the bulk baseline values no longer match the chapter-four outcome",
  );
  check(
    readPath(bulkValues, change.spec.valuesPath) === change.spec.before,
    "the bulk change before-value does not match the baseline values",
  );

  const changedValuesObject = structuredClone(bulkValues);
  writePath(changedValuesObject, change.spec.valuesPath, change.spec.after);
  const changedValues = `${toYaml(changedValuesObject)}\n`;

  // Every cluster has its own record, so every cluster has its own revision
  // identity. The edit is made once on the base and inherited by every
  // variant in one operation.
  const declaredVariants = variants.spec?.workloads ?? [];
  check(
    declaredVariants.length === workloads.length
      && declaredVariants.every((row, index) =>
        row.cluster === workloads[index].cluster
        && row.environment === workloads[index].environment),
    "the variants record must declare one variant per fleet cluster, in fleet order",
  );
  const variantByCluster = {};
  const revisions = {};
  for (const row of declaredVariants) {
    const departures = row.departures ?? {};
    const baselineDoc = applyDepartures(baseDoc, departures);
    const changedDoc = structuredClone(baselineDoc);
    changedDoc.spec.helmCharts[0].values = changedValues;
    variantByCluster[row.cluster] = { ...row, departures, baselineDoc, changedDoc };
    revisions[row.cluster] = {
      baseline: `r1-${sha256(stableJson(baselineDoc)).slice(0, 12)}`,
      changed: `r2-${sha256(stableJson(changedDoc)).slice(0, 12)}`,
    };
  }

  const checkpoints = [
    {
      id: "baseline",
      title: "Baseline, before the fan-out",
      changed: false,
      driftCheck: "none",
    },
    {
      id: "after-fanout",
      title: "After the fan-out, one edit inherited by every variant in one operation",
      changed: true,
      driftCheck: "none",
    },
    {
      id: "zero-drift-audit",
      title: "Zero-drift audit; injected drift repaired on every cluster",
      changed: true,
      driftCheck: "injected-and-restored",
    },
  ];
  const rows = [];
  for (const checkpoint of checkpoints) {
    for (const workload of workloads) {
      rows.push({
        checkpoint: checkpoint.id,
        cluster: workload.cluster,
        environment: workload.environment,
        space: variantByCluster[workload.cluster].space,
        upstream: variants.spec.base.space,
        expectedRevision: checkpoint.changed
          ? revisions[workload.cluster].changed
          : revisions[workload.cluster].baseline,
        expectedBackgroundReplicas: checkpoint.changed
          ? change.spec.after
          : change.spec.before,
        expectedDriftCheck: checkpoint.driftCheck,
        observedRelease: "",
        observedBackgroundReplicas: "",
        observedDriftCheck: "",
        proofStatus,
        blocker,
        evidence: [
          "examples/sveltos/bulk-ops/clusterprofile-base.yaml",
          "examples/sveltos/bulk-ops/variants.yaml",
          "examples/sveltos/bulk-ops/bulk-change.yaml",
        ].join(";"),
      });
    }
  }
  const compiled = {
    fleet,
    change,
    variants,
    variantByCluster,
    baseDoc,
    revisions,
    checkpoints,
    rows,
    live: null,
    superseded: false,
  };
  fillObservedColumns(compiled, root);
  return compiled;
}

// When the live runner has committed its receipt, the observed columns come
// from it; until then every observed cell stays honestly empty. The live lane
// is scripts/run-sveltos-bulk-ops-proof.mjs.
function fillObservedColumns(compiled, root) {
  const liveReceiptPath = join(
    root, "runs", "sveltos-bulk-ops-proof", "receipt.yaml",
  );
  if (!existsSync(liveReceiptPath)) return;
  const receipt = readYaml(liveReceiptPath);
  // The committed receipt records three environment records and predates the
  // per-cluster variant design this chapter now uses. It is recognised as
  // superseded and fills nothing, rather than being read half way and filling
  // cells the rest of the matrix does not describe. A per-cluster receipt
  // recorded before the Target and clusterRefs model is recognised the same
  // way: its revisions were hashed from the files as reviewed then.
  if (!Array.isArray(receipt?.spec?.variants)
    || !receipt.spec.variants.some((row) => row.target)) {
    compiled.superseded = true;
    return;
  }
  const recordedRevisions = receipt.spec?.revisions?.clusters ?? {};
  for (const cluster of Object.keys(compiled.revisions)) {
    check(
      recordedRevisions[cluster]?.baseline
        === compiled.revisions[cluster].baseline
        && recordedRevisions[cluster].changed
        === compiled.revisions[cluster].changed,
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
    row.observedDriftCheck = observation.drift
      ? (observation.drift.result === "pass" ? "injected-and-restored" : "not-restored")
      : "none";
    row.proofStatus = observation.observation?.result === "pass"
      && (!observation.drift || observation.drift.result === "pass")
      ? "observed-pass"
      : "observed-fail";
    row.blocker = "";
  }
  compiled.live = { recordedAt: receipt.spec?.recordedAt ?? "" };
}

function buildOutputs(compiled) {
  return {
    "data/sveltos-bulk-ops/matrix.csv": renderCsv(compiled),
    "data/sveltos-bulk-ops/matrix.md": renderMarkdown(compiled),
    "data/sveltos-bulk-ops/matrix.html": renderHtml(compiled),
  };
}

function renderCsv(compiled) {
  const header = [
    "checkpoint", "cluster", "environment", "space", "upstream",
    "expected_revision", "expected_background_replicas",
    "expected_drift_check",
    "observed_release", "observed_background_replicas",
    "observed_drift_check",
    "proof_status", "blocker", "evidence",
  ];
  const lines = [header.join(",")];
  for (const row of compiled.rows) {
    lines.push([
      row.checkpoint, row.cluster, row.environment, row.space, row.upstream,
      row.expectedRevision, row.expectedBackgroundReplicas,
      row.expectedDriftCheck,
      row.observedRelease, row.observedBackgroundReplicas,
      row.observedDriftCheck,
      row.proofStatus, row.blocker, row.evidence,
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(compiled) {
  const { change } = compiled;
  const lines = [
    "# Sveltos bulk operations, the per-cluster matrix",
    "",
    "Chapter five of the Sveltos fleet example is the change-it-once claim:",
    `one reviewed edit raises \`${change.spec.valuesPath}\` from ${change.spec.before}`,
    `to ${change.spec.after} once on the base record, and one set operation`,
    "inherits it into every per-cluster variant. Each record still enforces its",
    "own approval gate. The chapter closes with a zero-drift audit: a set-aware",
    "query across the Spaces must find no armed gates, no record may have",
    "changed out of band, and drift injected on every cluster must be repaired.",
    "",
    ...(compiled.live
      ? [
        "The observed columns come from the committed live receipt in",
        "`runs/sveltos-bulk-ops-proof/receipt.yaml`. The expected columns",
        "come from the reviewed example files.",
      ]
      : [
        "No live run of this design has been recorded yet, so every observed",
        "cell below stays empty until a live run earns it. The expected columns",
        "come from the reviewed example files.",
      ]),
    "",
  ];
  for (const checkpoint of compiled.checkpoints) {
    lines.push(`## ${checkpoint.title}`);
    lines.push("");
    lines.push("| Cluster | Environment | Space | Expected revision | Background replicas | Drift check | Observed | Status |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of compiled.rows.filter((item) => item.checkpoint === checkpoint.id)) {
      const observedCell = row.observedBackgroundReplicas === ""
        ? ""
        : `${row.observedRelease} with ${row.observedBackgroundReplicas} background replicas, drift ${row.observedDriftCheck}`;
      const statusCell = row.blocker
        ? `${row.proofStatus} (${row.blocker})`
        : row.proofStatus;
      lines.push(
        `| ${row.cluster} | ${row.environment} | ${row.space} | \`${row.expectedRevision}\` | ${row.expectedBackgroundReplicas} | ${row.expectedDriftCheck} | ${observedCell} | ${statusCell} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Sources");
  lines.push("");
  lines.push("- [Base profile](../../examples/sveltos/bulk-ops/clusterprofile-base.yaml)");
  lines.push("- [Per-cluster variants](../../examples/sveltos/bulk-ops/variants.yaml)");
  lines.push("- [Bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)");
  lines.push("- [Shared fleet design](../../examples/sveltos/env-rollout/fleet.yaml)");
  return `${lines.join("\n")}\n`;
}

function renderHtml(compiled) {
  const { change } = compiled;
  const head = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sveltos bulk operations matrix</title>',
    "<style>:root{color-scheme:light dark}body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#fff;color:#17212b}h1{font-size:1.7rem;margin-bottom:.25rem}.lede{max-width:95ch;color:#3f4d5a}.legend{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.key{border-radius:.25rem;padding:.3rem .5rem;font-weight:700}.baseline{background:#dce9ff;color:#173b75}.changed{background:#d7f2df;color:#14532d}.awaiting{background:#fff0bd;color:#634b00}.observed{background:#d7f2df;color:#14532d}.failed{background:#fadbd8;color:#7b241c}table{border-collapse:collapse;width:100%;margin:1.25rem 0;font-size:.84rem}caption{text-align:left;font-size:1rem;font-weight:700;padding:.5rem 0}th,td{border:1px solid #aeb8c2;padding:.5rem;text-align:left;vertical-align:top}thead th{background:#edf1f5;color:#17212b}code{white-space:normal;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#10161d;color:#eef4fa}.lede{color:#c6d1dc}thead th{background:#25313d;color:#fff}.baseline{background:#173b75;color:#fff}.changed{background:#14532d;color:#fff}.awaiting{background:#634b00;color:#fff}.observed{background:#14532d;color:#fff}.failed{background:#7b241c;color:#fff}}</style></head>",
    "<body><main><h1>Sveltos bulk operations, the per-cluster matrix</h1>",
    `<p class="lede">The change-it-once claim: one reviewed edit raises <code>${change.spec.valuesPath}</code> from ${change.spec.before} to ${change.spec.after} once on the base record, and one set operation inherits it into every per-cluster variant, each record still enforcing its own approval gate. The chapter closes with a zero-drift audit: a set-aware query across the Spaces must find no armed gates, no record may have changed out of band, and drift injected on every cluster must be repaired. ${compiled.live ? "The observed columns come from the committed live receipt in <code>runs/sveltos-bulk-ops-proof/receipt.yaml</code>." : "No live run of this design has been recorded yet, so every observed cell stays empty until a live run earns it."}</p>`,
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
          : `<span class="key ${row.proofStatus === "observed-pass" ? "observed" : "failed"}">${row.observedRelease} with ${row.observedBackgroundReplicas} background replicas, drift ${row.observedDriftCheck}</span>`;
        return `<tr><td>${row.cluster}</td><td>${row.environment}</td><td>${row.space}</td><td><span class="key ${revisionClass}"><code>${row.expectedRevision}</code></span></td><td>${row.expectedBackgroundReplicas}</td><td>${row.expectedDriftCheck}</td><td>${observedCell}</td></tr>`;
      });
    tables.push(
      `<table><caption>${checkpoint.title}</caption><thead><tr><th>Cluster</th><th>Environment</th><th>Space</th><th>Expected revision</th><th>Background replicas</th><th>Drift check</th><th>Observed</th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
    );
  }
  const tail = [
    `<p class="lede">Sources: the base profile, the per-cluster variants and the bulk change candidate live in <code>examples/sveltos/bulk-ops/</code>; the shared fleet design lives in <code>examples/sveltos/env-rollout/</code>. The matrix is generated by <code>scripts/generate-sveltos-bulk-ops.mjs</code>.</p>`,
    "</main></body></html>",
  ];
  return `${[...head, ...tables, ...tail].join("\n")}\n`;
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
  const fixtureRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-bulk-ops-self-test-"));
  try {
    for (const file of [...exampleFiles, liveReceiptFile]) {
      const source = join(repoRoot, file);
      if (!existsSync(source)) continue;
      const destination = join(fixtureRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
    }
    const compiledFirst = compileBulk(fixtureRoot);
    const first = buildOutputs(compiledFirst);
    const second = buildOutputs(compileBulk(fixtureRoot));
    check(
      JSON.stringify(first) === JSON.stringify(second),
      "the bulk surfaces are not deterministic",
    );
    for (const file of outputFiles) {
      check(
        first[file] === readFileSync(join(repoRoot, file), "utf8"),
        `${file} differs from the fixture compile; run --generate`,
      );
    }

    const csv = first["data/sveltos-bulk-ops/matrix.csv"];
    check(
      csv.trim().split("\n").length === 13,
      "the matrix must hold twelve cluster rows across three checkpoints",
    );
    // Before the live run every row must stay honestly empty. After it, every
    // row must carry an observation, because a recorded run that leaves cells
    // blank is the same dishonesty pointing the other way.
    if (existsSync(join(repoRoot, liveReceiptFile)) && !compiledFirst.superseded) {
      check(
        csv.split("observed-pass").length === 13 && !csv.includes(proofStatus),
        "every matrix row must carry its observation once the live run is recorded",
      );
    } else {
      check(
        csv.split(proofStatus).length === 13,
        "every matrix row must stay honestly awaiting the live run",
      );
    }
    // Four clusters expect drift repair. Once the run is recorded each of them
    // also reports it, so the token appears in the observed column too.
    check(
      csv.split("injected-and-restored").length
        === (existsSync(join(repoRoot, liveReceiptFile)) && !compiledFirst.superseded ? 9 : 5),
      "the audit checkpoint must expect drift repair on all four clusters, and report it once recorded",
    );
    const html = first["data/sveltos-bulk-ops/matrix.html"];
    check(
      !/<script[^>]*src=|<link[^>]+rel="stylesheet"|url\(http/.test(html),
      "the matrix HTML must stay self-contained",
    );

    const tampers = [
      [
        "a cluster left without a variant",
        (root) => editFile(root, "bulk-ops/variants.yaml", (text) =>
          text.replace(/    - cluster: hx-sveltos-env-prod-b\n(?:      [^\n]*\n|        [^\n]*\n)+/, "")),
        /one variant per fleet cluster/,
      ],
      [
        "chapter-four values drift",
        (root) => editFile(root, "bulk-ops/clusterprofile-base.yaml", (text) =>
          text.replace("replicas: 2", "replicas: 4")),
        /(no longer match the chapter-four outcome|before-value does not match)/,
      ],
      [
        "chapter-four version drift",
        (root) => {
          editFile(root, "bulk-ops/clusterprofile-base.yaml", (text) =>
            text.replace("chartVersion: 3.8.2", "chartVersion: 3.8.1"));
          editFile(root, "bulk-ops/bulk-change.yaml", (text) =>
            text.replace('chartVersion: "3.8.2"', 'chartVersion: "3.8.1"'));
        },
        /chart version no longer matches the chapter-four outcome/,
      ],
      [
        "empty change",
        (root) => editFile(root, "bulk-ops/bulk-change.yaml", (text) =>
          text.replace("after: 3", "after: 2")),
        /does not change anything/,
      ],
      [
        "edited record",
        (root) => editFile(root, "bulk-ops/bulk-change.yaml", (text) =>
          text.replace("editedRecord: base", "editedRecord: variants")),
        /must edit the base record/,
      ],
      [
        "per-record approvals statement",
        (root) => editFile(root, "bulk-ops/bulk-change.yaml", (text) =>
          text.replace("each per-cluster record still enforces its own approval gate", "one approval covers everything")),
        /must state that each record keeps its own approval gate/,
      ],
      [
        "set query",
        (root) => editFile(root, "bulk-ops/bulk-change.yaml", (text) =>
          text.replace("AND Labels.Run = '{run}' AND Labels.Wave = '1'", "AND Labels.Wave = '1'")),
        /lost the reviewed set query/,
      ],
      [
        "gate query",
        (root) => editFile(root, "bulk-ops/bulk-change.yaml", (text) =>
          text.replace("LEN(ApplyGates) > 0", "LEN(Labels) > 0")),
        /audit lost its set-aware gate query/,
      ],
      [
        "base selector scope",
        (root) => editFile(root, "bulk-ops/clusterprofile-base.yaml", (text) =>
          text.replace("  clusterRefs: []", "  clusterRefs:\n    - apiVersion: lib.projectsveltos.io/v1beta1\n      kind: SveltosCluster\n      name: hx-sveltos-env-pilot\n      namespace: projectsveltos")),
        /must name no cluster/,
      ],
      [
        "fleet prod group",
        (root) => editFile(root, "env-rollout/fleet.yaml", (text) =>
          text.replace("environment: prod\n    - cluster: hx-sveltos-env-prod-b", "environment: staging\n    - cluster: hx-sveltos-env-prod-b")),
        /must place/,
      ],
    ];
    for (const [label, tamper, pattern] of tampers) {
      const tamperedRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-bulk-ops-tamper-"));
      try {
        for (const file of exampleFiles) {
          const destination = join(tamperedRoot, file);
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(join(repoRoot, file), destination);
        }
        tamper(tamperedRoot);
        expectFailure(() => compileBulk(tamperedRoot), pattern, label);
      } finally {
        rmSync(tamperedRoot, { recursive: true, force: true });
      }
    }

    selfTestReceiptFill();
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// The live runner writes runs/sveltos-bulk-ops-proof/receipt.yaml; this
// proves the matrix flips its observed columns from a matching receipt and
// refuses one that disagrees with the reviewed files.
function selfTestReceiptFill() {
  const receiptRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-bulk-ops-receipt-"));
  const receiptFile = join(
    receiptRoot, "runs", "sveltos-bulk-ops-proof", "receipt.yaml",
  );
  try {
    for (const file of exampleFiles) {
      const destination = join(receiptRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repoRoot, file), destination);
    }
    const planned = compileBulk(receiptRoot);
    const fakeReceipt = {
      apiVersion: "catalog.confighub.com/v1alpha1",
      kind: "SveltosBulkOpsProofReceipt",
      spec: {
        recordedAt: "self-test",
        variants: Object.values(planned.variantByCluster).map((row) => ({
          cluster: row.cluster,
          space: row.space,
          target: { name: row.cluster, provider: "OCI" },
        })),
        revisions: {
          clusters: planned.revisions,
        },
        checkpoints: planned.checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          observations: planned.rows
            .filter((row) => row.checkpoint === checkpoint.id)
            .map((row) => ({
              logicalCluster: row.cluster,
              environment: row.environment,
              expectedRevisionId: row.expectedRevision,
              ...(checkpoint.id === "zero-drift-audit"
                ? {
                  drift: {
                    result: "pass",
                    changedReplicas: 1,
                    restoredReplicas: row.expectedBackgroundReplicas,
                  },
                }
                : {}),
              observation: {
                result: "pass",
                helmRelease: { chart: "kyverno-3.8.2" },
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
    const filled = buildOutputs(compileBulk(receiptRoot));
    const filledCsv = filled["data/sveltos-bulk-ops/matrix.csv"];
    check(
      filledCsv.split("observed-pass").length === 13
        && !filledCsv.includes(proofStatus)
        && !filledCsv.includes(blocker),
      "the matrix did not fill every observed cell from the receipt",
    );
    check(
      filledCsv.split(",injected-and-restored,").length >= 4
        && filled["data/sveltos-bulk-ops/matrix.md"].includes(
          "committed live receipt",
        ),
      "the matrix views did not carry the observed drift repair",
    );

    const superseded = structuredClone(fakeReceipt);
    delete superseded.spec.variants;
    write(receiptFile, `${toYaml(superseded)}\n`);
    const untouched = compileBulk(receiptRoot);
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
      () => compileBulk(receiptRoot),
      /disagrees with the reviewed expected revisions/,
      "receipt revision drift",
    );

    const missingObservation = structuredClone(fakeReceipt);
    missingObservation.spec.checkpoints[2].observations.pop();
    write(receiptFile, `${toYaml(missingObservation)}\n`);
    expectFailure(
      () => compileBulk(receiptRoot),
      /records no observation for/,
      "receipt missing observation",
    );

    const joinDrift = structuredClone(fakeReceipt);
    joinDrift.spec.checkpoints[0].observations[0].expectedRevisionId =
      "r1-000000000000";
    write(receiptFile, `${toYaml(joinDrift)}\n`);
    expectFailure(
      () => compileBulk(receiptRoot),
      /expected a different revision/,
      "receipt join drift",
    );
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
}

function editFile(root, name, edit) {
  const path = join(root, "examples", "sveltos", name);
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
