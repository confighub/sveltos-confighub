# Sveltos environment rollout, the per-cluster matrix

Chapter three of the Sveltos fleet example promotes one reviewed change
through the environment groups. The change raises `backgroundController.replicas`
from 1 to 2 in the kyverno/kyverno chart, version 3.8.1.
It is made once, on the base record. ConfigHub holds one variant per
cluster over that base, so the matrix shows exactly which cluster runs
which revision at every checkpoint, and which departure each cluster keeps
through the change.

New to this table? The per-cluster variant model and its terms, including
what a departure is and how a revision id names exact bytes, are
explained in [Run your own fleet](../../docs/user/run-your-own-fleet.md).

No live run of this design has been recorded yet, so every observed
cell below stays empty until the live proof earns it. The committed receipt governs three environment records and predates the per-cluster variant design.
The expected columns come from the reviewed example files.

## Baseline, before the change

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r1-b93243ea8e14` | `spec.stopMatchingBehavior=WithdrawPolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-staging | staging | 2 | `r1-072923eeaa54` | `spec.stopMatchingBehavior=WithdrawPolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-a | prod | 3 | `r1-a3686db9f046` | `spec.stopMatchingBehavior=LeavePolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-b | prod | 3 | `r1-5eafaf9b10e5` | `spec.stopMatchingBehavior=LeavePolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |

## After wave 1, pilot

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-ed215f0c9741` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-staging | staging | 2 | `r1-072923eeaa54` | `spec.stopMatchingBehavior=WithdrawPolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-a | prod | 3 | `r1-a3686db9f046` | `spec.stopMatchingBehavior=LeavePolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-b | prod | 3 | `r1-5eafaf9b10e5` | `spec.stopMatchingBehavior=LeavePolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |

## After wave 2, staging

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-ed215f0c9741` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-staging | staging | 2 | `r2-c6651525c7f3` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-a | prod | 3 | `r1-a3686db9f046` | `spec.stopMatchingBehavior=LeavePolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-b | prod | 3 | `r1-5eafaf9b10e5` | `spec.stopMatchingBehavior=LeavePolicies` | 1 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |

## After wave 3, production

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-ed215f0c9741` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-staging | staging | 2 | `r2-c6651525c7f3` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-a | prod | 3 | `r2-d00434703da3` | `spec.stopMatchingBehavior=LeavePolicies` | 2 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |
| hx-sveltos-env-prod-b | prod | 3 | `r2-126b6338a471` | `spec.stopMatchingBehavior=LeavePolicies` | 2 |  | awaiting-live-run (awaiting-per-cluster-rerecord) |

## Sources

- [Base profile](../../examples/sveltos/env-rollout/clusterprofile-base.yaml)
- [Per-cluster variants](../../examples/sveltos/env-rollout/variants.yaml)
- [Fleet design](../../examples/sveltos/env-rollout/fleet.yaml)
- [Change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
