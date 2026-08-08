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
  "examples/sveltos/env-rollout/clusterprofile-pilot.yaml",
  "examples/sveltos/env-rollout/clusterprofile-staging.yaml",
  "examples/sveltos/env-rollout/clusterprofile-prod.yaml",
  "examples/sveltos/env-rollout/fleet.yaml",
  "examples/sveltos/env-rollout/change-candidate.yaml",
];
const outputFiles = [
  "data/sveltos-env-rollout/matrix.csv",
  "data/sveltos-env-rollout/matrix.md",
  "data/sveltos-env-rollout/matrix.html",
];
const environments = ["pilot", "staging", "prod"];
const blocker = "confighubai/confighub#4975";
const proofStatus = "awaiting-live-run";

if (mode === "--generate") {
  const outputs = buildOutputs(compileRollout(repoRoot));
  for (const [file, text] of Object.entries(outputs)) {
    write(join(repoRoot, file), text);
    console.log(`wrote ${file}`);
  }
} else if (mode === "--verify") {
  const outputs = buildOutputs(compileRollout(repoRoot));
  for (const [file, text] of Object.entries(outputs)) {
    check(
      readFileSync(join(repoRoot, file), "utf8") === text,
      `${file} is stale; run node scripts/generate-sveltos-env-rollout.mjs --generate`,
    );
  }
  console.log("verified the Sveltos environment rollout matrix surfaces");
} else {
  selfTest();
  console.log(
    "sveltos env rollout self-test passed: deterministic surfaces, fleet and change refusals, self-contained HTML, and the receipt-fill path with its refusals",
  );
}

function compileRollout(root) {
  const exampleRoot = join(root, "examples", "sveltos", "env-rollout");
  const fleet = readYaml(join(exampleRoot, "fleet.yaml"));
  const change = readYaml(join(exampleRoot, "change-candidate.yaml"));

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
      && change.spec.valuesPath.length > 0,
    "the change candidate lost its values path",
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

  const profiles = {};
  for (const wave of waves) {
    const profilePath = join(exampleRoot, wave.profile);
    const text = readFileSync(profilePath, "utf8");
    const docs = parseDocs(text);
    check(docs.length === 1, `${wave.profile} must contain one object`);
    const doc = docs[0];
    check(
      doc.kind === "ClusterProfile"
        && doc.metadata?.name === `kyverno-env-${wave.environment}`,
      `${wave.profile} identity changed`,
    );
    check(
      doc.spec?.clusterSelector?.matchLabels?.environment === wave.environment
        && Object.keys(doc.spec.clusterSelector.matchLabels).length === 1,
      `${wave.profile} must select exactly environment=${wave.environment}`,
    );
    check(
      doc.spec?.syncMode === "ContinuousWithDriftDetection",
      `${wave.profile} drift mode changed`,
    );
    check(
      doc.spec?.helmCharts?.length === 1
        && doc.spec.helmCharts[0].chartName === change.spec.chart
        && String(doc.spec.helmCharts[0].chartVersion)
        === String(change.spec.chartVersion),
      `${wave.profile} chart pin changed`,
    );
    profiles[wave.environment] = {
      doc,
      path: `examples/sveltos/env-rollout/${wave.profile}`,
    };
  }
  const baselineValues = profiles.pilot.doc.spec.helmCharts[0].values;
  check(
    environments.every(
      (environment) =>
        profiles[environment].doc.spec.helmCharts[0].values === baselineValues,
    ),
    "the three environment profiles no longer share one baseline values document",
  );
  const parsedValues = parseDocs(baselineValues)[0];
  check(
    readPath(parsedValues, change.spec.valuesPath) === change.spec.before,
    "the change candidate before-value does not match the baseline values",
  );

  const changedValuesObject = structuredClone(parsedValues);
  writePath(changedValuesObject, change.spec.valuesPath, change.spec.after);
  const changedValues = `${toYaml(changedValuesObject)}\n`;

  const revisions = {};
  for (const environment of environments) {
    const baselineDoc = profiles[environment].doc;
    const changedDoc = structuredClone(baselineDoc);
    changedDoc.spec.helmCharts[0].values = changedValues;
    revisions[environment] = {
      baseline: `r1-${sha256(stableJson(baselineDoc)).slice(0, 12)}`,
      changed: `r2-${sha256(stableJson(changedDoc)).slice(0, 12)}`,
    };
  }

  const waveByEnvironment = Object.fromEntries(
    waves.map((row) => [row.environment, row]),
  );
  const checkpoints = [
    { id: "baseline", title: "Baseline, before the change", completedWave: 0 },
    { id: "after-wave-1", title: "After wave 1, pilot", completedWave: 1 },
    { id: "after-wave-2", title: "After wave 2, staging", completedWave: 2 },
    { id: "after-wave-3", title: "After wave 3, production", completedWave: 3 },
  ];
  const rows = [];
  for (const checkpoint of checkpoints) {
    for (const workload of workloads) {
      const wave = waveByEnvironment[workload.environment];
      const changed = wave.wave <= checkpoint.completedWave;
      rows.push({
        checkpoint: checkpoint.id,
        cluster: workload.cluster,
        environment: workload.environment,
        wave: wave.wave,
        space: wave.space,
        expectedRevision: changed
          ? revisions[workload.environment].changed
          : revisions[workload.environment].baseline,
        expectedBackgroundReplicas: changed
          ? change.spec.after
          : change.spec.before,
        observedRelease: "",
        observedBackgroundReplicas: "",
        proofStatus,
        blocker,
        evidence: [
          profiles[workload.environment].path,
          "examples/sveltos/env-rollout/change-candidate.yaml",
        ].join(";"),
      });
    }
  }
  const compiled = { fleet, change, profiles, revisions, checkpoints, rows, live: null };
  fillObservedColumns(compiled, root);
  return compiled;
}

// When the live runner has committed its receipt, the observed columns come
// from it; until then every observed cell stays honestly empty. The live lane
// is drafted in scripts/run-sveltos-env-rollout-proof.mjs behind the blocker.
function fillObservedColumns(compiled, root) {
  const liveReceiptPath = join(
    root, "runs", "sveltos-env-rollout-proof", "receipt.yaml",
  );
  if (!existsSync(liveReceiptPath)) return;
  const receipt = readYaml(liveReceiptPath);
  for (const environment of environments) {
    check(
      receipt.spec?.revisions?.[environment]?.baseline
        === compiled.revisions[environment].baseline
        && receipt.spec.revisions[environment].changed
        === compiled.revisions[environment].changed,
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

function buildOutputs(compiled) {
  return {
    "data/sveltos-env-rollout/matrix.csv": renderCsv(compiled),
    "data/sveltos-env-rollout/matrix.md": renderMarkdown(compiled),
    "data/sveltos-env-rollout/matrix.html": renderHtml(compiled),
  };
}

function renderCsv(compiled) {
  const header = [
    "checkpoint", "cluster", "environment", "wave", "space",
    "expected_revision", "expected_background_replicas",
    "observed_release", "observed_background_replicas",
    "proof_status", "blocker", "evidence",
  ];
  const lines = [header.join(",")];
  for (const row of compiled.rows) {
    lines.push([
      row.checkpoint, row.cluster, row.environment, row.wave, row.space,
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
    "Each environment keeps its own governed record, so the matrix shows exactly",
    "which cluster runs which revision at every checkpoint.",
    "",
    ...(compiled.live
      ? [
        "The observed columns come from the committed live receipt in",
        "`runs/sveltos-env-rollout-proof/receipt.yaml`. The expected columns",
        "come from the reviewed example files.",
      ]
      : [
        "No live run has been recorded yet. The approval boundary is blocked by",
        `${blocker}, so every observed cell below stays empty until the live proof`,
        "earns it. The expected columns come from the reviewed example files.",
      ]),
    "",
  ];
  for (const checkpoint of compiled.checkpoints) {
    lines.push(`## ${checkpoint.title}`);
    lines.push("");
    lines.push("| Cluster | Environment | Wave | Expected revision | Expected background replicas | Observed | Status |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of compiled.rows.filter((item) => item.checkpoint === checkpoint.id)) {
      const observedCell = row.observedBackgroundReplicas === ""
        ? ""
        : `${row.observedRelease} with ${row.observedBackgroundReplicas} background replicas`;
      const statusCell = row.blocker
        ? `${row.proofStatus} (${row.blocker})`
        : row.proofStatus;
      lines.push(
        `| ${row.cluster} | ${row.environment} | ${row.wave} | \`${row.expectedRevision}\` | ${row.expectedBackgroundReplicas} | ${observedCell} | ${statusCell} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Sources");
  lines.push("");
  lines.push("- [Pilot profile](../../examples/sveltos/env-rollout/clusterprofile-pilot.yaml)");
  lines.push("- [Staging profile](../../examples/sveltos/env-rollout/clusterprofile-staging.yaml)");
  lines.push("- [Production profile](../../examples/sveltos/env-rollout/clusterprofile-prod.yaml)");
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
    `<p class="lede">One reviewed change moves through the environment groups: <code>${change.spec.valuesPath}</code> goes from ${change.spec.before} to ${change.spec.after} in ${change.spec.chart} ${change.spec.chartVersion}. Each environment keeps its own governed record. ${compiled.live ? "The observed columns come from the committed live receipt in <code>runs/sveltos-env-rollout-proof/receipt.yaml</code>." : `No live run has been recorded yet; the approval boundary is blocked by ${blocker}, so every observed cell stays empty until the live proof earns it.`}</p>`,
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
        return `<tr><td>${row.cluster}</td><td>${row.environment}</td><td>${row.wave}</td><td><span class="key ${revisionClass}"><code>${row.expectedRevision}</code></span></td><td>${row.expectedBackgroundReplicas}</td><td>${observedCell}</td></tr>`;
      });
    tables.push(
      `<table><caption>${checkpoint.title}</caption><thead><tr><th>Cluster</th><th>Environment</th><th>Wave</th><th>Expected revision</th><th>Expected background replicas</th><th>Observed</th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
    );
  }
  const tail = [
    `<p class="lede">Sources: the three environment profiles, the fleet design, and the change candidate live in <code>examples/sveltos/env-rollout/</code>. The matrix is generated by <code>scripts/generate-sveltos-env-rollout.mjs</code>.</p>`,
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

function writePath(value, path, next) {
  const keys = path.split(".");
  let current = value;
  for (const key of keys.slice(0, -1)) {
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
    for (const file of exampleFiles) {
      const destination = join(fixtureRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repoRoot, file), destination);
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
    check(
      !csv.includes("observed-pass") && csv.split(proofStatus).length === 17,
      "every matrix row must stay honestly awaiting the live run",
    );
    const html = first["data/sveltos-env-rollout/matrix.html"];
    check(
      !/<script[^>]*src=|<link[^>]+rel="stylesheet"|url\(http/.test(html),
      "the matrix HTML must stay self-contained",
    );
    const markdown = first["data/sveltos-env-rollout/matrix.md"];
    for (const row of compileRollout(fixtureRoot).rows) {
      check(
        markdown.includes(row.expectedRevision) && csv.includes(row.expectedRevision),
        "the markdown and CSV views disagree on a revision identity",
      );
    }

    const tampers = [
      [
        "shared baseline",
        (root) => editFile(root, "clusterprofile-staging.yaml", (text) =>
          text.replace("replicas: 3", "replicas: 4")),
        /no longer share one baseline values document/,
      ],
      [
        "before-value drift",
        (root) => editFile(root, "change-candidate.yaml", (text) =>
          text.replace("before: 1", "before: 2")),
        /(before-value does not match the baseline|does not change anything)/,
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
          text.replace("environment: staging", "environment: prod")),
        /waves must cover pilot, staging, and prod in order/,
      ],
      [
        "prod group size",
        (root) => editFile(root, "fleet.yaml", (text) =>
          text.replace("environment: prod\n    - cluster: hx-sveltos-env-prod-b", "environment: staging\n    - cluster: hx-sveltos-env-prod-b")),
        /must place/,
      ],
      [
        "selector scope",
        (root) => editFile(root, "clusterprofile-pilot.yaml", (text) =>
          text.replace("      environment: pilot", "      environment: pilot\n      region: east")),
        /must select exactly environment=pilot/,
      ],
      [
        "chart pin",
        (root) => editFile(root, "clusterprofile-prod.yaml", (text) =>
          text.replace("chartVersion: 3.8.1", "chartVersion: 3.9.0")),
        /chart pin changed/,
      ],
      [
        "missing values path",
        (root) => editFile(root, "change-candidate.yaml", (text) =>
          text.replace("valuesPath: backgroundController.replicas", "valuesPath: cleanupController.replicas")),
        /(does not exist in the baseline values|before-value does not match the baseline)/,
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
// proves the matrix flips its observed columns from a matching receipt and
// refuses one that disagrees with the reviewed files.
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
        revisions: planned.revisions,
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

    const revisionDrift = structuredClone(fakeReceipt);
    revisionDrift.spec.revisions.pilot.changed = "r2-000000000000";
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
