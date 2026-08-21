# Sveltos held cluster, the closing-audit matrix

Chapter six of the Sveltos fleet example holds one cluster back on
purpose. Two reviewed advances raise `backgroundController.replicas` from
2 to 3 and then from 3 to 4 on the shared base, each promoted
pilot to staging to production exactly as chapter three promotes a
change. Between the two advances one production cluster, hx-sveltos-env-prod-a,
is restored to its exact pre-advance revision through the same approval
gate every forward change passes. The second advance upgrades that
cluster's variant like every other, and then nobody approves it. The
hold is the absence of that one approval. The closing audit reads the
fleet at three points on purpose, and this matrix is that audit. Three
clusters advance, one holds at the restored revision, and its twin
hx-sveltos-env-prod-b proves the fleet moved on around it.

Boundary: This chapter does not claim a fleet-wide undo, a failure budget, or an automated verification step between waves. It restores one target to an exact revision and keeps it there on purpose, with the fleet's mixed state recorded as facts rather than drift.

The observed columns come from the committed live receipt in
`runs/sveltos-held-cluster-proof/receipt.yaml`. The expected columns
come from the reviewed example files.

## The closing fleet audit

| Cluster | Environment | Expected replicas | Expected state | Observed replicas | Head revision | Approved revision | Approvals on head | Armed gates | Pending upgrade | Observed state | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 4 | advanced | 4 | 6 | 6 | 1 | `none` | false | advanced | observed-pass |
| hx-sveltos-env-staging | staging | 4 | advanced | 4 | 6 | 6 | 1 | `none` | false | advanced | observed-pass |
| hx-sveltos-env-prod-a | prod | 2 | held-at-restored-revision | 2 | 7 | 6 | 0 | `platform/require-approval/vet-approvedby` | true | held-at-restored-revision | observed-pass |
| hx-sveltos-env-prod-b | prod | 4 | advanced | 4 | 6 | 6 | 1 | `none` | false | advanced | observed-pass |

## Sources

- [Change candidate](../../examples/sveltos/held-cluster/change-candidate.yaml)
- [Restore candidate](../../examples/sveltos/held-cluster/restore-candidate.yaml)
- [Continuation note](../../examples/sveltos/held-cluster/continuation.yaml)
- [Shared fleet design](../../examples/sveltos/env-rollout/fleet.yaml)
