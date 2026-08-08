# The Sveltos fleet chapters

This page ties the five Sveltos fleet chapters into one story. A platform team
manages one fleet: a management cluster running Sveltos and Argo CD, and four
workload clusters grouped as pilot, staging, and two production clusters.
ConfigHub keeps every reviewed record and its approval history; OCI carries
exact digests; Sveltos selects clusters by label and reconciles them. Each
chapter makes one operational claim and backs it with a machine-checked
matrix, a receipt contract, and deterministic self-tests.

## The five chapters

1. **[Kyverno across the fleet](../../../examples/sveltos/kyverno-fleet/README.md)**
   installs admission policy through a reviewed record with an approval gate,
   because policy is the clearest case for review before a change reaches
   every cluster. Recorded live.
2. **The canary, in the same example**: the reviewed profile selected only the
   pilot cluster, and one approved selector change added the second cluster at
   a new OCI digest. Recorded live in the
   [two-wave proof](../../../data/sveltos-oci-delivery-proof/summary.md).
3. **[Environment rollout](../../../examples/sveltos/env-rollout/README.md)**
   promotes one reviewed values change pilot to staging to production, with a
   [per-cluster matrix](../../../data/sveltos-env-rollout/matrix.md) showing
   which cluster runs which revision at every checkpoint.
4. **[CVE patching](../../../examples/sveltos/cve-patch/README.md)** is fleet
   patch day with evidence: one reviewed version bump with digest-bound
   provenance, promoted through the same groups, closed by a coverage audit
   that proves no cluster was missed. It does not scan for vulnerabilities
   and does not verify any advisory claim. The
   [matrix](../../../data/sveltos-cve-patch/matrix.md) tracks chart versions.
5. **[Bulk operations](../../../examples/sveltos/bulk-ops/README.md)** is the
   change-it-once claim: one reviewed edit fans out to every record in one
   pass, and a zero-drift audit closes the run with a set-aware query across
   the Spaces, out-of-band checks on every record, and drift repaired on
   every cluster. The [matrix](../../../data/sveltos-bulk-ops/matrix.md)
   shows all three checkpoints.

The chapters share one fleet design and hand their state forward: chapter
four starts from chapter three's outcome and chapter five from chapter
four's, and the repository gate enforces that continuity mechanically.

## What is proven today and what is not

Chapters one and two are recorded live. Chapters three, four, and five are
fully drafted and proven offline: their governance logic, their receipts, and
their refusal behavior all run against fake ConfigHub and OCI surfaces in the
repository gate, in seconds, with no account or cluster. Their live runs have
not happened, every observed matrix cell is honestly empty, and each drafted
runner refuses to start while the server defect below stands.

## Why one server issue blocks every live run

The claim these chapters sell is not that configuration can be pushed to
clusters. Anyone can push. The claim is that nothing reaches any cluster
except an exactly approved revision, and the only evidence for that is
watching the approval boundary from both sides. Before approval, the record
must visibly show "blocked, waiting for approval" with no approval on file:
that observation proves the change was actually held. After someone approves
that exact revision, the block lifts and the approval is on record: that
proves the bytes that shipped are the bytes that were approved.

On the current server the first half is broken. A freshly created record in a
Space wired with the standard approval policy never shows the block marker at
all, even though the policy is attached correctly. The pipeline can never
witness the "held for review" state, so it refuses to record a proof that
skips it, because that state is the whole point. There is no side door
either: the older CLI had a command that provoked a rejection we could record
as evidence, but it was removed, so reading the markers is the only way left
to observe the boundary. The defect is tracked in confighubai/confighub#4975.

Every drafted runner therefore starts with a gate preflight: it creates a
throwaway record, waits briefly for the block marker, and refuses with the
issue number if the marker never appears. The refusal costs seconds instead
of the seven-minute fleet build. The day the server fix lands, each chapter
records with one command, listed in its README.

## Run the offline proofs yourself

Every chapter's checks run without any account, cluster, or network access:

```bash
npm run sveltos-example:self-test
npm run sveltos-oci-delivery:self-test
npm run sveltos-env-rollout:self-test
npm run sveltos-env-rollout-proof:self-test
npm run sveltos-cve-patch:self-test
npm run sveltos-cve-patch-proof:self-test
npm run sveltos-bulk-ops:self-test
npm run sveltos-bulk-ops-proof:self-test
```

The delivery machinery the chapters share can be rehearsed today with no
account at all: the [fleet rehearsal](../../../examples/sveltos/fleet-rehearsal/README.md)
builds the five-cluster kind fleet, converges Kyverno everywhere through
portable OCI and Argo CD, delivers a demo application to all four clusters
with per-environment replica counts, lands a values change and a version
bump on the pilot alone, and repairs injected drift, under a receipt that
explicitly claims no governance.

To find out whether the server fix has landed, one probe answers for every
lane: `CUB_CONTEXT=my-policy npm run sveltos-gate:probe` wires a throwaway
record, watches for the block marker, cleans up, and reports either the
refusal with the issue number or that the lanes are unblocked. The patched
chart's digest and values fit can be checked any day with
`npm run sveltos-cve-patch-proof:verify-chart`, with no account or cluster.

Fleet proofs run serially against the organization, never in parallel. The
planning brief behind the chapters is
[sveltos-fleet-brief.md](../../planning/sveltos-fleet-brief.md).
