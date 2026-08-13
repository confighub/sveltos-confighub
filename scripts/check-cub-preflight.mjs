#!/usr/bin/env node
// Preflight for the governed live lanes: confirm the cub CLI a run is about
// to use is present, current enough, and carries the surfaces the record
// machinery depends on, BEFORE any cluster is built. Refusals name the
// missing piece, in the same stop-early spirit as the runners' own
// precondition checks.
//
// Checked:
//   1. cub is on PATH and reports a client version.
//   2. The version is at least MINIMUM_CUB, the oldest version these
//      runners were measured against.
//   3. `cub variant` exposes `create` and `promote` (the official space
//      variant surface; see issue #5 for adopting it in the machinery).
//   4. `cub unit approve` accepts `--where` (set approval, which the waves
//      record as one operation over a named set).
//
// `npm run fleet:preflight` runs against the real CLI. --self-test runs the
// same logic against injected fake runners, so CI keeps the checker honest
// without needing cub installed.

import { spawnSync } from "node:child_process";
import process from "node:process";

export const MINIMUM_CUB = "0.2.15";

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function parseClientVersion(versionOutput) {
  const match = /Version:\s*v?(\d+\.\d+\.\d+)/.exec(versionOutput ?? "");
  return match ? match[1] : null;
}

// run(args) -> { status, stdout } for `cub <args...>`; injectable for the
// self-test.
export function preflight(run) {
  const lines = [];
  const refuse = (reason) => ({ ok: false, lines, reason });

  const version = run(["version"]);
  if (version.status !== 0 || !version.stdout) {
    return refuse("cub is not on PATH; install it with: curl -fsSL https://hub.confighub.com/cub/install.sh | bash");
  }
  const client = parseClientVersion(version.stdout);
  if (!client) {
    return refuse("cub version output carried no client version; the CLI on PATH does not look like cub");
  }
  if (compareVersions(client, MINIMUM_CUB) < 0) {
    return refuse(
      `cub v${client} is older than v${MINIMUM_CUB}, the oldest version these runners were measured against; update cub before a live run`,
    );
  }
  lines.push(`cub v${client} (minimum v${MINIMUM_CUB})`);

  const variant = run(["variant", "--help"]);
  const variantHelp = variant.stdout ?? "";
  if (variant.status !== 0 || !variantHelp.includes("create") || !variantHelp.includes("promote")) {
    return refuse("cub variant create/promote is missing; this cub predates the variant surface, update it");
  }
  lines.push("cub variant create/promote present");

  const approve = run(["unit", "approve", "--help"]);
  if (approve.status !== 0 || !(approve.stdout ?? "").includes("--where")) {
    return refuse("cub unit approve does not accept --where; set approval is required to record a wave as one operation");
  }
  lines.push("cub unit approve --where present");

  return { ok: true, lines, reason: null };
}

function realRun(args) {
  const result = spawnSync("cub", args, { encoding: "utf8" });
  return { status: result.error ? 127 : (result.status ?? 127), stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function fakeRunner(overrides) {
  const good = {
    version: { status: 0, stdout: "Client Version:\n  Version:    v0.2.19\n" },
    "variant --help": { status: 0, stdout: "Available Commands:\n  create\n  promote\n" },
    "unit approve --help": { status: 0, stdout: "Flags:\n  --where string\n" },
  };
  return (args) => {
    const key = args.join(" ");
    if (overrides && key in overrides) return overrides[key];
    return good[key] ?? { status: 1, stdout: "" };
  };
}

function selfTest() {
  const pass = preflight(fakeRunner());
  if (!pass.ok || pass.lines.length !== 3) throw new Error("self-test expected the good CLI to pass all three checks");

  const battery = [
    ["missing binary", { version: { status: 127, stdout: "" } }, "not on PATH"],
    ["unparseable version", { version: { status: 0, stdout: "something else" } }, "no client version"],
    ["old version", { version: { status: 0, stdout: "Version: v0.2.11" } }, "older than"],
    ["variant verbs absent", { "variant --help": { status: 1, stdout: "unknown command" } }, "variant create/promote is missing"],
    ["approve without --where", { "unit approve --help": { status: 0, stdout: "Flags:\n  --quiet\n" } }, "does not accept --where"],
  ];
  for (const [label, overrides, needle] of battery) {
    const result = preflight(fakeRunner(overrides));
    if (result.ok) throw new Error(`self-test "${label}" expected a refusal`);
    if (!result.reason.includes(needle)) {
      throw new Error(`self-test "${label}" expected the reason to contain "${needle}", got: ${result.reason}`);
    }
  }

  if (compareVersions("0.2.9", "0.2.15") >= 0 || compareVersions("0.10.0", "0.9.9") <= 0) {
    throw new Error("self-test version comparison is not numeric");
  }

  console.log(
    "cub preflight self-test passed: the passing CLI, the missing binary, the unparseable and old versions, " +
      "the absent variant verbs, the approve without set support, and numeric version ordering",
  );
}

function live() {
  const result = preflight(realRun);
  for (const line of result.lines) console.log(`preflight: ${line}`);
  if (!result.ok) {
    console.error(`refused: ${result.reason}`);
    process.exit(1);
  }
  console.log("cub preflight passed");
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--live" || mode === undefined) live();
else {
  console.error(`unknown mode ${mode}; use --live or --self-test`);
  process.exit(1);
}
