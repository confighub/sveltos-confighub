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
  readYaml,
  repoRoot,
  writeYaml,
  write,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
if (!["--generate", "--verify", "--self-test"].includes(mode)) {
  console.error(`Usage:
  node scripts/generate-sveltos-held-cluster.mjs --generate
  node scripts/generate-sveltos-held-cluster.mjs --verify
  node scripts/generate-sveltos-held-cluster.mjs --self-test`);
  process.exit(2);
}

const exampleFiles = [
  "examples/sveltos/held-cluster/change-candidate.yaml",
  "examples/sveltos/held-cluster/restore-candidate.yaml",
  "examples/sveltos/held-cluster/continuation.yaml",
  "examples/sveltos/env-rollout/fleet.yaml",
];
// The committed live receipt fills the observed columns, so the fixture
// compile has to see it too or a recorded matrix is compared against an
// unrecorded one.
const liveReceiptFile = "runs/sveltos-held-cluster-proof/receipt.yaml";
const outputFiles = [
  "data/sveltos-held-cluster/matrix.csv",
  "data/sveltos-held-cluster/matrix.md",
  "data/sveltos-held-cluster/matrix.html",
];
const environments = ["pilot", "staging", "prod"];
const proofStatus = "awaiting-live-run";
// The two states the closing audit records. Which cluster carries which state
// is read from the reviewed example files; the names themselves are the
// chapter's recorded vocabulary, asserted by the live runner as well.
const heldState = "held-at-restored-revision";
const advancedState = "advanced";

if (mode === "--generate") {
  const outputs = buildOutputs(compileHeld(repoRoot));
  for (const [file, text] of Object.entries(outputs)) {
    write(join(repoRoot, file), text);
    console.log(`wrote ${file}`);
  }
} else if (mode === "--verify") {
  const compiled = compileHeld(repoRoot);
  const outputs = buildOutputs(compiled);
  for (const [file, text] of Object.entries(outputs)) {
    check(
      readFileSync(join(repoRoot, file), "utf8") === text,
      `${file} is stale; run node scripts/generate-sveltos-held-cluster.mjs --generate`,
    );
  }
  if (compiled.superseded) {
    console.log(
      "the committed receipt predates this matrix design and fills nothing; it awaits a live re-record",
    );
  }
  console.log("verified the Sveltos held-cluster matrix surfaces");
} else {
  selfTest();
  console.log(
    "sveltos held cluster self-test passed: deterministic surfaces, the continuation, hold, and closing-audit refusals, self-contained HTML, the three views agreeing cell for cell, and the receipt-fill path with its refusals",
  );
}

// The expected side of the matrix compiles from the reviewed example files
// alone: the shared fleet design names the four workload clusters, the change
// candidate carries the two advances and the closing-audit expectations, and
// the restore candidate names the held cluster and its twin. The checks mirror
// the plan checks in scripts/run-sveltos-held-cluster-proof.mjs.
function compileHeld(root) {
  const heldRoot = join(root, "examples", "sveltos", "held-cluster");
  const rolloutRoot = join(root, "examples", "sveltos", "env-rollout");
  const fleet = readYaml(join(rolloutRoot, "fleet.yaml"));
  const change = readYaml(join(heldRoot, "change-candidate.yaml"));
  const restore = readYaml(join(heldRoot, "restore-candidate.yaml"));
  const continuation = readYaml(join(heldRoot, "continuation.yaml"));

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
    continuation.kind === "SveltosHeldClusterContinuation"
      && continuation.spec?.continues === "env-rollout"
      && continuation.spec.createsClusters === false
      && continuation.spec.createsRecords === false,
    "the continuation note lost its creates-nothing boundary",
  );

  const advances = change.spec?.advances ?? [];
  check(
    change.kind === "SveltosHeldClusterChange"
      && change.spec?.editedRecord === "base"
      && typeof change.spec.valuesPath === "string"
      && change.spec.valuesPath.length > 0
      && advances.length === 2
      && advances[0].name === "advance"
      && advances[1].name === "held-advance"
      && Number(advances[0].to) === Number(advances[1].from)
      && Number(advances[0].from) !== Number(advances[0].to)
      && Number(advances[1].from) !== Number(advances[1].to),
    "the held-cluster change candidate lost its two-advances shape",
  );
  for (const advance of advances) {
    check(
      (advance.waves ?? []).map((row) => `${row.wave}:${row.environment}`).join(",")
        === "1:pilot,2:staging,3:prod",
      `the ${advance.name} waves are not pilot, staging, prod`,
    );
  }
  const heldWave = advances[1].waves.find((row) => row.environment === "prod");
  check(
    Array.isArray(heldWave?.held) && heldWave.held.length === 1
      && Array.isArray(heldWave.approved) && heldWave.approved.length === 1
      && restore.kind === "SveltosHeldClusterRestore"
      && restore.spec?.cluster === heldWave.held[0]
      && restore.spec?.twin === heldWave.approved[0],
    "the restore candidate and the held wave no longer agree on which cluster is held",
  );
  const heldCluster = restore.spec.cluster;
  const twin = restore.spec.twin;
  check(
    heldCluster !== twin,
    "the held cluster and its twin must be two different clusters",
  );
  check(
    workloads.find((row) => row.cluster === heldCluster)?.environment === "prod"
      && workloads.find((row) => row.cluster === twin)?.environment === "prod",
    "the held cluster and its twin must both stand in prod",
  );
  check(
    String(restore.spec?.restore?.mechanism ?? "")
      .includes("cub unit update --restore"),
    "the restore candidate lost its cub unit update --restore mechanism",
  );
  check(
    String(restore.spec?.hold?.mechanism ?? "") === "absence of approval",
    "the hold must be the absence of one approval; the restore candidate records a different mechanism",
  );
  const claimBoundary = String(restore.spec?.claimBoundary ?? "");
  check(
    claimBoundary.includes("does not claim a fleet-wide undo"),
    "the restore candidate must keep its claim boundary",
  );

  const expect = change.spec?.closingAudit?.expect ?? {};
  check(
    sameSet(Object.keys(expect), workloads.map((row) => row.cluster)),
    "the closing audit must expect a replica count for every fleet cluster and no other",
  );
  check(
    Number(expect[heldCluster]) === Number(advances[0].from)
      && workloads
        .map((row) => row.cluster)
        .filter((name) => name !== heldCluster)
        .every((name) => Number(expect[name]) === Number(advances[1].to)),
    "the closing-audit expectations no longer match the two advances around the hold",
  );

  const rows = workloads.map((workload) => ({
    cluster: workload.cluster,
    environment: workload.environment,
    expectedReplicas: Number(expect[workload.cluster]),
    expectedState: workload.cluster === heldCluster ? heldState : advancedState,
    observedReplicas: "",
    observedHeadRevision: "",
    observedApprovedRevision: "",
    observedApprovalsOnHead: "",
    observedArmedGates: "",
    observedPendingUpgrade: "",
    observedState: "",
    proofStatus,
    evidence: [
      "examples/sveltos/held-cluster/change-candidate.yaml",
      "examples/sveltos/held-cluster/restore-candidate.yaml",
      "examples/sveltos/held-cluster/continuation.yaml",
    ].join(";"),
  }));

  const compiled = {
    fleet,
    change,
    restore,
    advances,
    heldCluster,
    twin,
    claimBoundary,
    rows,
    live: null,
    superseded: false,
  };
  fillObservedColumns(compiled, root);
  return compiled;
}

// When the live runner has committed its receipt and that receipt records a
// pass, every observed cell comes from its closing fleet audit and must agree
// with the reviewed expectations, or the disagreement is named and the
// generator refuses. Without a receipt every observed cell stays honestly
// empty. A receipt of an earlier design fills nothing and says so, rather
// than being read half way. Whether the receipt's cohort has since been
// re-recorded is the runner's question; run-sveltos-held-cluster-proof.mjs
// recognizes a superseded cohort on its own, and this matrix does not repeat
// that judgement.
function fillObservedColumns(compiled, root) {
  const liveReceiptPath = join(
    root, "runs", "sveltos-held-cluster-proof", "receipt.yaml",
  );
  if (!existsSync(liveReceiptPath)) return;
  const receipt = readYaml(liveReceiptPath);
  const audit = receipt?.spec?.fleetAudit;
  if (!Array.isArray(audit?.clusters)) {
    compiled.superseded = true;
    return;
  }
  const recordedPass = receipt?.status?.result === "pass";
  const byCluster = new Map(audit.clusters.map((row) => [row.cluster, row]));
  if (recordedPass) {
    check(
      audit.result === "pass",
      "the receipt claims a pass overall but its fleet audit does not; record a consistent live run",
    );
    check(
      audit.heldCluster === compiled.heldCluster,
      `the live receipt holds ${audit.heldCluster} where the reviewed files hold ${compiled.heldCluster}`,
    );
    for (const row of compiled.rows) {
      check(
        Number(audit.expected?.[row.cluster]) === row.expectedReplicas,
        `the live receipt recorded an expectation of ${audit.expected?.[row.cluster]} replicas for ${row.cluster} where the reviewed closing audit expects ${row.expectedReplicas}`,
      );
    }
  }
  for (const row of compiled.rows) {
    const recorded = byCluster.get(row.cluster);
    check(
      recorded,
      `the live receipt records no fleet-audit row for ${row.cluster}`,
    );
    if (recordedPass) {
      check(
        recorded.observation?.result === "pass",
        `the receipt claims a pass overall but records a failing observation on ${row.cluster}`,
      );
      check(
        Number(recorded.observedReplicas) === row.expectedReplicas,
        `the live receipt observed ${recorded.observedReplicas} replicas on ${row.cluster} where the reviewed closing audit expects ${row.expectedReplicas}`,
      );
      check(
        recorded.state === row.expectedState,
        `the live receipt records ${row.cluster} in state ${recorded.state} where the reviewed files expect ${row.expectedState}`,
      );
      if (row.cluster === compiled.heldCluster) {
        check(
          recorded.pendingUpgrade === true
            && Number(recorded.approvalsOnHead) === 0
            && (recorded.gateKeysOnHead ?? []).length > 0
            && Number(recorded.headRevision) > Number(recorded.approvedRevision),
          `the held cluster's audit row must show a pending unapproved head behind an armed gate; the receipt records approvalsOnHead ${recorded.approvalsOnHead}, pendingUpgrade ${recorded.pendingUpgrade}, ${(recorded.gateKeysOnHead ?? []).length} armed gate(s), and head ${recorded.headRevision} over approved ${recorded.approvedRevision}`,
        );
      } else {
        check(
          recorded.pendingUpgrade === false
            && Number(recorded.approvalsOnHead) >= 1
            && (recorded.gateKeysOnHead ?? []).length === 0
            && Number(recorded.headRevision) === Number(recorded.approvedRevision),
          `${row.cluster} must stand fully approved with no armed gate once advanced; the receipt records approvalsOnHead ${recorded.approvalsOnHead}, pendingUpgrade ${recorded.pendingUpgrade}, ${(recorded.gateKeysOnHead ?? []).length} armed gate(s), and head ${recorded.headRevision} over approved ${recorded.approvedRevision}`,
        );
      }
    }
    row.observedReplicas = String(recorded.observedReplicas ?? "");
    row.observedHeadRevision = String(recorded.headRevision ?? "");
    row.observedApprovedRevision = String(recorded.approvedRevision ?? "");
    row.observedApprovalsOnHead = String(recorded.approvalsOnHead ?? "");
    row.observedArmedGates = (recorded.gateKeysOnHead ?? []).length > 0
      ? recorded.gateKeysOnHead.join(";")
      : "none";
    row.observedPendingUpgrade = String(recorded.pendingUpgrade === true);
    row.observedState = String(recorded.state ?? "");
    row.proofStatus = recordedPass && recorded.observation?.result === "pass"
      ? "observed-pass"
      : "observed-fail";
  }
  compiled.live = { recordedAt: receipt.spec?.recordedAt ?? "" };
}

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function buildOutputs(compiled) {
  return {
    "data/sveltos-held-cluster/matrix.csv": renderCsv(compiled),
    "data/sveltos-held-cluster/matrix.md": renderMarkdown(compiled),
    "data/sveltos-held-cluster/matrix.html": renderHtml(compiled),
  };
}

function renderCsv(compiled) {
  const header = [
    "cluster", "environment",
    "expected_replicas", "expected_state",
    "observed_replicas", "observed_head_revision",
    "observed_approved_revision", "observed_approvals_on_head",
    "observed_armed_gates", "observed_pending_upgrade", "observed_state",
    "proof_status", "evidence",
  ];
  const lines = [header.join(",")];
  for (const row of compiled.rows) {
    lines.push([
      row.cluster, row.environment,
      row.expectedReplicas, row.expectedState,
      row.observedReplicas, row.observedHeadRevision,
      row.observedApprovedRevision, row.observedApprovalsOnHead,
      row.observedArmedGates, row.observedPendingUpgrade, row.observedState,
      row.proofStatus, row.evidence,
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(compiled) {
  const { change, advances, heldCluster, twin } = compiled;
  const lines = [
    "# Sveltos held cluster, the closing-audit matrix",
    "",
    "Chapter six of the Sveltos fleet example holds one cluster back on",
    `purpose. Two reviewed advances raise \`${change.spec.valuesPath}\` from`,
    `${advances[0].from} to ${advances[0].to} and then from ${advances[1].from} to ${advances[1].to} on the shared base, each promoted`,
    "pilot to staging to production exactly as chapter three promotes a",
    `change. Between the two advances one production cluster, ${heldCluster},`,
    "is restored to its exact pre-advance revision through the same approval",
    "gate every forward change passes. The second advance upgrades that",
    "cluster's variant like every other, and then nobody approves it. The",
    "hold is the absence of that one approval. The closing audit reads the",
    "fleet at three points on purpose, and this matrix is that audit. Three",
    "clusters advance, one holds at the restored revision, and its twin",
    `${twin} proves the fleet moved on around it.`,
    "",
    `Boundary: ${compiled.claimBoundary}`,
    "",
    ...(compiled.live
      ? [
        "The observed columns come from the committed live receipt in",
        "`runs/sveltos-held-cluster-proof/receipt.yaml`. The expected columns",
        "come from the reviewed example files.",
      ]
      : [
        "No live run of this chapter is recorded, so every observed cell",
        `below stays honestly empty until a live run earns it.${compiled.superseded ? " The committed receipt predates this matrix design and fills nothing." : ""} The expected`,
        "columns come from the reviewed example files.",
      ]),
    "",
    "## The closing fleet audit",
    "",
    "| Cluster | Environment | Expected replicas | Expected state | Observed replicas | Head revision | Approved revision | Approvals on head | Armed gates | Pending upgrade | Observed state | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of compiled.rows) {
    const gatesCell = row.observedArmedGates === ""
      ? ""
      : `\`${row.observedArmedGates}\``;
    lines.push(
      `| ${row.cluster} | ${row.environment} | ${row.expectedReplicas} | ${row.expectedState} | ${row.observedReplicas} | ${row.observedHeadRevision} | ${row.observedApprovedRevision} | ${row.observedApprovalsOnHead} | ${gatesCell} | ${row.observedPendingUpgrade} | ${row.observedState} | ${row.proofStatus} |`,
    );
  }
  lines.push("");
  lines.push("## Sources");
  lines.push("");
  lines.push("- [Change candidate](../../examples/sveltos/held-cluster/change-candidate.yaml)");
  lines.push("- [Restore candidate](../../examples/sveltos/held-cluster/restore-candidate.yaml)");
  lines.push("- [Continuation note](../../examples/sveltos/held-cluster/continuation.yaml)");
  lines.push("- [Shared fleet design](../../examples/sveltos/env-rollout/fleet.yaml)");
  return `${lines.join("\n")}\n`;
}

function renderHtml(compiled) {
  const { change, advances, heldCluster, twin } = compiled;
  const head = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sveltos held cluster matrix</title>',
    "<style>:root{color-scheme:light dark}body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#fff;color:#17212b}h1{font-size:1.7rem;margin-bottom:.25rem}.lede,.boundary{max-width:95ch;color:#3f4d5a}.legend{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.key{border-radius:.25rem;padding:.3rem .5rem;font-weight:700}.advanced{background:#d7f2df;color:#14532d}.held{background:#dce9ff;color:#173b75}.awaiting{background:#fff0bd;color:#634b00}.observed{background:#d7f2df;color:#14532d}.failed{background:#fadbd8;color:#7b241c}tr.held-row td{background:#f3f7ff}table{border-collapse:collapse;width:100%;margin:1.25rem 0;font-size:.84rem}caption{text-align:left;font-size:1rem;font-weight:700;padding:.5rem 0}th,td{border:1px solid #aeb8c2;padding:.5rem;text-align:left;vertical-align:top}thead th{background:#edf1f5;color:#17212b}code{white-space:normal;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#10161d;color:#eef4fa}.lede,.boundary{color:#c6d1dc}thead th{background:#25313d;color:#fff}.advanced{background:#14532d;color:#fff}.held{background:#173b75;color:#fff}.awaiting{background:#634b00;color:#fff}.observed{background:#14532d;color:#fff}.failed{background:#7b241c;color:#fff}tr.held-row td{background:#141d2b}}</style></head>",
    "<body><main><h1>Sveltos held cluster, the closing-audit matrix</h1>",
    `<p class="lede">Chapter six holds one cluster back on purpose. Two reviewed advances raise <code>${change.spec.valuesPath}</code> from ${advances[0].from} to ${advances[0].to} and then from ${advances[1].from} to ${advances[1].to} on the shared base. Between them one production cluster, ${heldCluster}, is restored to its exact pre-advance revision through the same approval gate every forward change passes. The second advance upgrades that cluster's variant like every other, and then nobody approves it. The hold is the absence of that one approval. The closing audit reads the fleet at three points on purpose, and this matrix is that audit; its twin ${twin} proves the fleet moved on around the held cluster. ${compiled.live ? "The observed columns come from the committed live receipt in <code>runs/sveltos-held-cluster-proof/receipt.yaml</code>." : `No live run of this chapter is recorded, so every observed cell stays honestly empty until a live run earns it.${compiled.superseded ? " The committed receipt predates this matrix design and fills nothing." : ""}`}</p>`,
    `<p class="boundary">Boundary: ${compiled.claimBoundary}</p>`,
    `<div class="legend"><span class="key advanced">advanced to ${advances[1].to} replicas</span><span class="key held">held at the restored revision</span>${compiled.live ? '<span class="key observed">observed live</span>' : '<span class="key awaiting">awaiting live run</span>'}</div>`,
  ];
  const bodyRows = compiled.rows.map((row) => {
    const stateClass = row.expectedState === advancedState ? "advanced" : "held";
    const observedStateCell = row.observedState === ""
      ? ""
      : `<span class="key ${stateClass}">${row.observedState}</span>`;
    const statusCell = row.proofStatus === proofStatus
      ? '<span class="key awaiting">awaiting live run</span>'
      : `<span class="key ${row.proofStatus === "observed-pass" ? "observed" : "failed"}">${row.proofStatus}</span>`;
    const gatesCell = row.observedArmedGates === ""
      ? ""
      : `<code>${row.observedArmedGates}</code>`;
    return `<tr${row.cluster === heldCluster ? ' class="held-row"' : ""}><td>${row.cluster}</td><td>${row.environment}</td><td>${row.expectedReplicas}</td><td><span class="key ${stateClass}">${row.expectedState}</span></td><td>${row.observedReplicas}</td><td>${row.observedHeadRevision}</td><td>${row.observedApprovedRevision}</td><td>${row.observedApprovalsOnHead}</td><td>${gatesCell}</td><td>${row.observedPendingUpgrade}</td><td>${observedStateCell}</td><td>${statusCell}</td></tr>`;
  });
  const table = `<table><caption>The closing fleet audit</caption><thead><tr><th>Cluster</th><th>Environment</th><th>Expected replicas</th><th>Expected state</th><th>Observed replicas</th><th>Head revision</th><th>Approved revision</th><th>Approvals on head</th><th>Armed gates</th><th>Pending upgrade</th><th>Observed state</th><th>Status</th></tr></thead><tbody>${bodyRows.join("")}</tbody></table>`;
  const tail = [
    `<p class="lede">Sources: the change candidate, the restore candidate, and the continuation note live in <code>examples/sveltos/held-cluster/</code>; the shared fleet design lives in <code>examples/sveltos/env-rollout/</code>. The matrix is generated by <code>scripts/generate-sveltos-held-cluster.mjs</code>.</p>`,
    "</main></body></html>",
  ];
  return `${[...head, table, ...tail].join("\n")}\n`;
}

function selfTest() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-held-cluster-self-test-"));
  try {
    // The fixture must carry the committed receipt alongside the examples.
    // A fixture without it once made a recorded matrix compare against an
    // unrecorded one.
    for (const file of [...exampleFiles, liveReceiptFile]) {
      const source = join(repoRoot, file);
      if (!existsSync(source)) continue;
      const destination = join(fixtureRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
    }
    const compiledFirst = compileHeld(fixtureRoot);
    const first = buildOutputs(compiledFirst);
    const second = buildOutputs(compileHeld(fixtureRoot));
    check(
      JSON.stringify(first) === JSON.stringify(second),
      "the held-cluster surfaces are not deterministic",
    );
    for (const file of outputFiles) {
      check(
        first[file] === readFileSync(join(repoRoot, file), "utf8"),
        `${file} differs from the fixture compile; run --generate`,
      );
    }

    const csv = first["data/sveltos-held-cluster/matrix.csv"];
    check(
      csv.trim().split("\n").length === 5,
      "the matrix must hold one row per workload cluster, four in all",
    );
    // Before the live run every row must stay honestly empty. After it, every
    // row must carry an observation, because a recorded run that leaves cells
    // blank is the same dishonesty pointing the other way.
    const recorded = existsSync(join(repoRoot, liveReceiptFile))
      && !compiledFirst.superseded;
    if (recorded) {
      check(
        csv.split("observed-pass").length === 5 && !csv.includes(proofStatus),
        "every matrix row must carry its observation once the live run is recorded",
      );
    } else {
      check(
        csv.split(proofStatus).length === 5 && !csv.includes("observed-pass"),
        "every matrix row must stay honestly awaiting the live run",
      );
    }
    // The held state token sits in the expected column once and, once the run
    // is recorded, in the observed column too, so its count doubles.
    check(
      csv.split(heldState).length === (recorded ? 3 : 2),
      "exactly one cluster may expect the held state, observed once recorded",
    );
    const html = first["data/sveltos-held-cluster/matrix.html"];
    check(
      !/<script[^>]*src=|<link[^>]+rel="stylesheet"|url\(http/.test(html),
      "the matrix HTML must stay self-contained",
    );
    check(
      html.includes('class="held-row"')
        && html.split('class="held-row"').length === 2,
      "the held cluster's row must be the one visibly distinct row in the HTML",
    );
    const markdown = first["data/sveltos-held-cluster/matrix.md"];
    check(
      html.includes("does not claim a fleet-wide undo")
        && markdown.includes("does not claim a fleet-wide undo"),
      "the matrix views lost the claim boundary",
    );
    // The three views must agree cell for cell; every distinctive cell value
    // has to appear in each of them.
    for (const row of compiledFirst.rows) {
      for (const [name, text] of [["CSV", csv], ["markdown", markdown], ["HTML", html]]) {
        check(
          text.includes(row.cluster) && text.includes(row.expectedState),
          `the ${name} view lost ${row.cluster} or its expected state`,
        );
        if (row.observedState !== "") {
          check(
            text.includes(row.observedState)
              && text.includes(row.observedArmedGates),
            `the ${name} view lost the observed state or armed gates of ${row.cluster}`,
          );
        }
      }
    }

    const tampers = [
      [
        "continuation creates something",
        (root) => editFile(root, "held-cluster/continuation.yaml", (text) =>
          text.replace("createsClusters: false", "createsClusters: true")),
        /creates-nothing boundary/,
      ],
      [
        "advances no longer chain",
        (root) => editFile(root, "held-cluster/change-candidate.yaml", (text) =>
          text.replace("from: 3", "from: 2")),
        /two-advances shape/,
      ],
      [
        "wave order",
        (root) => editFile(root, "held-cluster/change-candidate.yaml", (text) =>
          text.replace("environment: staging", "environment: prod")),
        /waves are not pilot, staging, prod/,
      ],
      [
        "restore names the wrong cluster",
        (root) => editFile(root, "held-cluster/restore-candidate.yaml", (text) =>
          text.replace("cluster: hx-sveltos-env-prod-a", "cluster: hx-sveltos-env-prod-b")),
        /no longer agree on which cluster is held/,
      ],
      [
        "hold mechanism",
        (root) => editFile(root, "held-cluster/restore-candidate.yaml", (text) =>
          text.replace("mechanism: absence of approval", "mechanism: a freeze flag")),
        /must be the absence of one approval/,
      ],
      [
        "claim boundary dropped",
        (root) => editFile(root, "held-cluster/restore-candidate.yaml", (text) =>
          text.replace("does not claim a fleet-wide undo", "undoes the fleet")),
        /must keep its claim boundary/,
      ],
      [
        "closing audit expects the wrong held value",
        (root) => editFile(root, "held-cluster/change-candidate.yaml", (text) =>
          text.replace("hx-sveltos-env-prod-a: 2", "hx-sveltos-env-prod-a: 3")),
        /closing-audit expectations no longer match/,
      ],
      [
        "closing audit drops a cluster",
        (root) => editFile(root, "held-cluster/change-candidate.yaml", (text) =>
          text.replace("      hx-sveltos-env-pilot: 4\n", "")),
        /must expect a replica count for every fleet cluster/,
      ],
      [
        "fleet prod group",
        (root) => editFile(root, "env-rollout/fleet.yaml", (text) =>
          text.replace("environment: prod\n    - cluster: hx-sveltos-env-prod-b", "environment: staging\n    - cluster: hx-sveltos-env-prod-b")),
        /must place/,
      ],
    ];
    for (const [label, tamper, pattern] of tampers) {
      const tamperedRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-held-cluster-tamper-"));
      try {
        for (const file of exampleFiles) {
          const destination = join(tamperedRoot, file);
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(join(repoRoot, file), destination);
        }
        tamper(tamperedRoot);
        expectFailure(() => compileHeld(tamperedRoot), pattern, label);
      } finally {
        rmSync(tamperedRoot, { recursive: true, force: true });
      }
    }

    selfTestReceiptFill();
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// The live runner writes runs/sveltos-held-cluster-proof/receipt.yaml; this
// proves the matrix keeps its observed cells honestly empty without one,
// fills every cell from a recorded pass, and refuses a recorded pass whose
// cells disagree with the reviewed files. The committed receipt drives these
// scenarios when it exists; a synthesized receipt of the same shape stands in
// when it does not, so the fill path stays proven in every checkout.
function selfTestReceiptFill() {
  const receiptRoot = mkdtempSync(join(tmpdir(), "helm-expt-sveltos-held-cluster-receipt-"));
  const receiptFile = join(
    receiptRoot, "runs", "sveltos-held-cluster-proof", "receipt.yaml",
  );
  try {
    for (const file of exampleFiles) {
      const destination = join(receiptRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repoRoot, file), destination);
    }

    // Receipt deleted: every observed cell must empty out again.
    const bare = compileHeld(receiptRoot);
    check(
      bare.live === null
        && bare.superseded === false
        && bare.rows.every((row) =>
          row.proofStatus === proofStatus
          && row.observedReplicas === ""
          && row.observedState === ""
          && row.observedArmedGates === ""),
      "without a committed receipt every observed cell must stay honestly empty",
    );
    const bareCsv = buildOutputs(bare)["data/sveltos-held-cluster/matrix.csv"];
    check(
      bareCsv.split(proofStatus).length === 5 && !bareCsv.includes("observed-pass"),
      "the unrecorded matrix must mark every row as awaiting the live run",
    );

    // The committed receipt, or its stand-in, fills every cell.
    const committed = existsSync(join(repoRoot, liveReceiptFile))
      ? readYaml(join(repoRoot, liveReceiptFile))
      : fakeReceiptFor(bare);
    writeYaml(receiptFile, committed);
    const filled = compileHeld(receiptRoot);
    check(
      filled.live !== null
        && filled.rows.every((row) => row.proofStatus === "observed-pass")
        && filled.rows.every((row) => row.observedState === row.expectedState)
        && filled.rows.every((row) =>
          String(row.expectedReplicas) === row.observedReplicas),
      "the matrix did not fill every observed cell from the committed receipt",
    );

    const auditRow = (receipt, cluster) =>
      receipt.spec.fleetAudit.clusters.find((row) => row.cluster === cluster);
    const withReceipt = (mutate) => {
      const clone = structuredClone(committed);
      mutate(clone);
      writeYaml(receiptFile, clone);
    };

    withReceipt((clone) => {
      auditRow(clone, "hx-sveltos-env-pilot").observedReplicas = 5;
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /observed 5 replicas on hx-sveltos-env-pilot where the reviewed closing audit expects 4/,
      "observed replicas tamper",
    );

    withReceipt((clone) => {
      auditRow(clone, "hx-sveltos-env-prod-a").state = "advanced";
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /records hx-sveltos-env-prod-a in state advanced where the reviewed files expect held-at-restored-revision/,
      "held state flipped",
    );

    withReceipt((clone) => {
      clone.spec.fleetAudit.clusters = clone.spec.fleetAudit.clusters
        .filter((row) => row.cluster !== "hx-sveltos-env-staging");
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /records no fleet-audit row for hx-sveltos-env-staging/,
      "audit row removed",
    );

    withReceipt((clone) => {
      clone.spec.fleetAudit.expected["hx-sveltos-env-pilot"] = 9;
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /recorded an expectation of 9 replicas for hx-sveltos-env-pilot/,
      "recorded expectation drift",
    );

    withReceipt((clone) => {
      clone.spec.fleetAudit.heldCluster = "hx-sveltos-env-prod-b";
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /holds hx-sveltos-env-prod-b where the reviewed files hold hx-sveltos-env-prod-a/,
      "held cluster drift",
    );

    withReceipt((clone) => {
      auditRow(clone, "hx-sveltos-env-prod-a").approvalsOnHead = 1;
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /pending unapproved head behind an armed gate/,
      "approval sneaks onto the held head",
    );

    withReceipt((clone) => {
      auditRow(clone, "hx-sveltos-env-prod-a").gateKeysOnHead = [];
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /pending unapproved head behind an armed gate/,
      "held gate disarmed",
    );

    withReceipt((clone) => {
      auditRow(clone, "hx-sveltos-env-pilot").gateKeysOnHead = [
        "platform/require-approval/vet-approvedby",
      ];
    });
    expectFailure(
      () => compileHeld(receiptRoot),
      /must stand fully approved with no armed gate once advanced/,
      "armed gate on an advanced cluster",
    );

    // A receipt that records a failure renders as failed rather than passing
    // or refusing; the disagreement it records is the honest surface.
    withReceipt((clone) => {
      clone.status.result = "fail";
    });
    const failed = compileHeld(receiptRoot);
    check(
      failed.live !== null
        && failed.rows.every((row) => row.proofStatus === "observed-fail"),
      "a receipt recording a failure must render every row as observed-fail",
    );

    // A receipt of an earlier design fills nothing and says so.
    withReceipt((clone) => {
      delete clone.spec.fleetAudit;
    });
    const untouched = compileHeld(receiptRoot);
    check(
      untouched.superseded === true
        && untouched.live === null
        && untouched.rows.every((row) => row.proofStatus === proofStatus),
      "a receipt that predates this matrix design must fill nothing and say so",
    );

    // Cohort supersede is the runner's judgement, not this matrix's. A
    // receipt continuing an older cohort still fills its cells here;
    // run-sveltos-held-cluster-proof.mjs --verify recognizes the supersede.
    withReceipt((clone) => {
      clone.spec.continuesCohort.runId = "20250101010101";
    });
    const olderCohort = compileHeld(receiptRoot);
    check(
      olderCohort.live !== null
        && olderCohort.rows.every((row) => row.proofStatus === "observed-pass"),
      "cohort staleness belongs to the runner; the matrix must not refuse it",
    );

    // Reviewed files that move on past a recorded receipt are the same drift
    // seen from the other side, and the disagreement is named the same way.
    writeYaml(receiptFile, committed);
    editFile(receiptRoot, "held-cluster/change-candidate.yaml", (text) =>
      text
        .replace("to: 4", "to: 5")
        .replace("hx-sveltos-env-pilot: 4", "hx-sveltos-env-pilot: 5")
        .replace("hx-sveltos-env-staging: 4", "hx-sveltos-env-staging: 5")
        .replace("hx-sveltos-env-prod-b: 4", "hx-sveltos-env-prod-b: 5"));
    expectFailure(
      () => compileHeld(receiptRoot),
      /recorded an expectation of 4 replicas for hx-sveltos-env-pilot where the reviewed closing audit expects 5/,
      "reviewed outcome drifts past the recorded receipt",
    );
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
}

// A receipt of exactly the shape the live runner records, filled with the
// reviewed expectations, for checkouts that carry no committed receipt yet.
function fakeReceiptFor(compiled) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "SveltosHeldClusterProofReceipt",
    spec: {
      recordedAt: "self-test",
      continuesCohort: { runId: "self-test" },
      fleetAudit: {
        result: "pass",
        heldCluster: compiled.heldCluster,
        expected: Object.fromEntries(
          compiled.rows.map((row) => [row.cluster, row.expectedReplicas]),
        ),
        clusters: compiled.rows.map((row) => {
          const held = row.cluster === compiled.heldCluster;
          return {
            cluster: row.cluster,
            environment: row.environment,
            headRevision: held ? 7 : 6,
            approvedRevision: 6,
            approvalsOnHead: held ? 0 : 1,
            gateKeysOnHead: held
              ? ["platform/require-approval/vet-approvedby"]
              : [],
            expectedReplicas: row.expectedReplicas,
            observedReplicas: row.expectedReplicas,
            observation: { result: "pass" },
            pendingUpgrade: held,
            state: row.expectedState,
          };
        }),
      },
    },
    status: { result: "pass" },
  };
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
