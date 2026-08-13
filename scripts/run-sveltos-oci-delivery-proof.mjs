#!/usr/bin/env node

// Chapter two's verification boundary, held while its runner is rebuilt.
//
// The committed receipt records the canary as it was first run: one profile
// widened by an approved selector change, delivered through a GitOps
// controller and a temporary registry. The example now holds one record per
// cluster and delivers through the ConfigHub OCI gateway, so that recording
// predates the design the same way chapters four and five's did. This script
// recognizes the receipt and its summary as recorded, fills nothing from
// them, and refuses the lanes that would need the reworked runner. The
// rebuilt per-cluster runner replaces this file, walks the canary against
// fake ConfigHub and cluster surfaces offline, and records the live run.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, readYaml, relativeRepo, repoRoot } from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const allowedModes = new Set(["--run", "--generate", "--verify", "--self-test"]);
if (!allowedModes.has(mode)) {
  console.error(`Usage:
  node scripts/run-sveltos-oci-delivery-proof.mjs --run
  node scripts/run-sveltos-oci-delivery-proof.mjs --generate
  node scripts/run-sveltos-oci-delivery-proof.mjs --verify
  node scripts/run-sveltos-oci-delivery-proof.mjs --self-test`);
  process.exit(1);
}

const receiptPath = join(repoRoot, "runs", "sveltos-oci-delivery-proof", "receipt.yaml");
const summaryPath = join(repoRoot, "data", "sveltos-oci-delivery-proof", "summary.md");
const supersededNote =
  "the recorded receipt was recorded on the earlier delivery path and predates the per-cluster design; its governance claim stands as recorded and it awaits a gateway re-record";
const rebuildReason =
  "the per-cluster runner for this chapter is landing separately; this transitional check only recognizes the recorded receipt";

// The recorded receipt is the old shape exactly when it carries the old
// review block and no per-cluster variants. Anything else is neither the
// recording this chapter made nor the shape the rebuilt runner writes, and
// is refused rather than recognized.
function verifyRecordedReceipt(receipt) {
  check(
    receipt.kind === "SveltosOciDeliveryProofReceipt",
    "Sveltos OCI delivery receipt kind changed",
  );
  check(
    receipt.status?.result === "pass",
    "Sveltos OCI delivery proof is not pass",
  );
  check(
    receipt.spec?.variants === undefined
      && receipt.spec?.configHubReview !== undefined,
    "the receipt is not the recorded earlier-path shape; the rebuilt runner owns any other",
  );
  return false;
}

if (mode === "--run" || mode === "--generate") {
  console.error(`refused: ${rebuildReason}`);
  process.exit(1);
} else if (mode === "--self-test") {
  selfTest();
  console.log(
    "sveltos OCI delivery transitional self-test passed: the recorded receipt recognized as recorded on the earlier path, the committed summary present, and the wrong-shape, wrong-kind, and overclaim refusals",
  );
} else {
  const receipt = readYaml(receiptPath);
  verifyRecordedReceipt(receipt);
  console.log(supersededNote);
  check(
    existsSync(summaryPath),
    `${relativeRepo(summaryPath)} is missing; the recorded summary is kept as recorded`,
  );
  console.log("verified the Sveltos OCI delivery proof surfaces as recorded");
}

function selfTest() {
  const receipt = readYaml(receiptPath);
  check(
    verifyRecordedReceipt(structuredClone(receipt)) === false,
    "the recorded receipt must be recognized, not verified as current",
  );
  check(
    readFileSync(summaryPath, "utf8").includes("rollout=pilot"),
    "the committed summary must stay the recorded one until the re-record replaces it",
  );
  const cases = [
    ["kind", (clone) => { clone.kind = "OtherReceipt"; }, /receipt kind changed/],
    ["result", (clone) => { clone.status.result = "fail"; }, /proof is not pass/],
    // A receipt that grows per-cluster variants while keeping the old review
    // block, or that drops the old review block, is neither recording.
    ["mixed shape", (clone) => { clone.spec.variants = []; }, /not the recorded earlier-path shape/],
    ["review block dropped", (clone) => { delete clone.spec.configHubReview; }, /not the recorded earlier-path shape/],
  ];
  for (const [label, tamper, pattern] of cases) {
    const clone = structuredClone(receipt);
    tamper(clone);
    let error = null;
    try {
      verifyRecordedReceipt(clone);
    } catch (caught) {
      error = caught;
    }
    check(
      error && pattern.test(String(error.message)),
      `receipt ${label}: expected ${pattern}, got ${error?.message ?? "success"}`,
    );
  }
}
