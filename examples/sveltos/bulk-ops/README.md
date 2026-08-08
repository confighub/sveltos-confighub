# Sveltos bulk operations

This is chapter five of the Sveltos fleet example, and the last one in the
brief: the change-it-once claim. One reviewed edit fans out to every
environment record in one pass, every cluster converges, and a zero-drift
audit proves it everywhere.

## The design

The chapter reuses the reference fleet from chapters three and four: one
management cluster and four workload clusters grouped as pilot, staging, and
two production clusters, defined in the
[shared fleet design](../env-rollout/fleet.yaml).

The baseline continues chapter four's outcome. Each environment keeps its own
governed `ClusterProfile` at Kyverno chart 3.8.2 carrying the values the
earlier chapters promoted, and the repository gate enforces that continuity.

The [bulk change candidate](bulk-change.yaml) raises
`backgroundController.replicas` from 2 to 3 on every fleet cluster. Unlike
chapter three there are no waves: the fan-out writes the same reviewed
content into all three records in one pass with one change description. Each
record still enforces its own approval gate; the bulk part is authoring the
change once and fanning it out once, not skipping review.

## The zero-drift audit

The chapter closes with the prove-it-everywhere audit, in four parts.

1. A set-aware query across the Spaces
   (`cub unit list --space "*" --where "Labels.Proof = 'sveltos-bulk-ops' AND LEN(ApplyGates) > 0"`)
   must find no record still blocked behind an armed gate.
2. Every record is re-read: its revision and content hash must be exactly
   what was approved, so nothing changed out of band.
3. The stored change must be byte-identical across the three records.
4. Drift is injected on every cluster (the background controller is scaled
   down by hand) and Sveltos must repair all four.

## The matrix

The per-cluster matrix shows every cluster at three checkpoints: the
baseline, the state after the fan-out, and the zero-drift audit with its
repair results.

- [matrix.csv](../../../data/sveltos-bulk-ops/matrix.csv)
- [matrix.md](../../../data/sveltos-bulk-ops/matrix.md)
- [matrix.html](../../../data/sveltos-bulk-ops/matrix.html)

## Current status

No live run has been recorded. On the current server the approval gate never
appears in a Unit's `ApplyGates` from the Space trigger-filter wiring, so the
approval boundary cannot be observed live. That defect is tracked in
confighubai/confighub#4975. Every observed cell in the matrix stays honestly
empty until the live proof runs.

The live runner is drafted in `scripts/run-sveltos-bulk-ops-proof.mjs` and
stays behind that blocker on purpose. Before it builds anything it probes the
approval gate on a throwaway Space and Unit; while the defect stands, the
probe refuses in seconds and names the issue. Its self-test proves the whole
governance walk offline, including the set-aware gate query with a rogue
armed gate detected and the change-once byte identity across records. Once
the receipt is recorded, the matrix generator fills the observed columns
from it.

## Repeat and verify

```bash
# Deterministic self-test of the matrix generator: fixture compile,
# continuity and fan-out refusals, and the receipt-fill path.
npm run sveltos-bulk-ops:self-test

# Deterministic self-test of the drafted live runner: the gate preflight,
# one fan-out pass with six approval brackets, the set-aware gate query,
# and the tamper battery, against fake ConfigHub and OCI surfaces.
npm run sveltos-bulk-ops-proof:self-test
```

Once confighubai/confighub#4975 is resolved, the run is one command:

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_BULK_OPS=1 \
HELM_EXPT_ALLOW_SCRATCH_ORG=1 \
CUB_CONTEXT=my-policy \
SVELTOS_CLUSTER_CONTEXT=my-scratch \
npm run sveltos-bulk-ops-proof:run

# Then refresh the summary and the observed matrix columns.
npm run sveltos-bulk-ops-proof:generate
npm run sveltos-bulk-ops:generate
```

Fleet proofs run serially against the organization, never in parallel.
