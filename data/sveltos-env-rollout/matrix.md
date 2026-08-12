# Sveltos environment rollout, the per-cluster matrix

Chapter three of the Sveltos fleet example promotes one reviewed change
through the environment groups. The change raises `backgroundController.replicas`
from 1 to 2 in the kyverno/kyverno chart, version 3.8.1.
It is made once, on the base record. ConfigHub holds one variant per
cluster over that base, so the matrix shows exactly which cluster runs
which revision at every checkpoint, and which departure each cluster keeps
through the change.

The observed columns come from the committed live receipt in
`runs/sveltos-env-rollout-proof/receipt.yaml`. The expected columns
come from the reviewed example files.

## Baseline, before the change

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r1-584811b8a981` | `spec.stopMatchingBehavior=WithdrawPolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |
| hx-sveltos-env-staging | staging | 2 | `r1-558f1f5b7f18` | `spec.stopMatchingBehavior=WithdrawPolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |
| hx-sveltos-env-prod-a | prod | 3 | `r1-5d3f50a38643` | `spec.stopMatchingBehavior=LeavePolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |
| hx-sveltos-env-prod-b | prod | 3 | `r1-f32c12212414` | `spec.stopMatchingBehavior=LeavePolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |

## After wave 1, pilot

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-2c6a2fcb7349` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 | kyverno-3.8.1 with 2 background replicas | observed-pass |
| hx-sveltos-env-staging | staging | 2 | `r1-558f1f5b7f18` | `spec.stopMatchingBehavior=WithdrawPolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |
| hx-sveltos-env-prod-a | prod | 3 | `r1-5d3f50a38643` | `spec.stopMatchingBehavior=LeavePolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |
| hx-sveltos-env-prod-b | prod | 3 | `r1-f32c12212414` | `spec.stopMatchingBehavior=LeavePolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |

## After wave 2, staging

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-2c6a2fcb7349` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 | kyverno-3.8.1 with 2 background replicas | observed-pass |
| hx-sveltos-env-staging | staging | 2 | `r2-ae67b227bea8` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 | kyverno-3.8.1 with 2 background replicas | observed-pass |
| hx-sveltos-env-prod-a | prod | 3 | `r1-5d3f50a38643` | `spec.stopMatchingBehavior=LeavePolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |
| hx-sveltos-env-prod-b | prod | 3 | `r1-f32c12212414` | `spec.stopMatchingBehavior=LeavePolicies` | 1 | kyverno-3.8.1 with 1 background replicas | observed-pass |

## After wave 3, production

| Cluster | Environment | Wave | Expected revision | Departure kept | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-2c6a2fcb7349` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 | kyverno-3.8.1 with 2 background replicas | observed-pass |
| hx-sveltos-env-staging | staging | 2 | `r2-ae67b227bea8` | `spec.stopMatchingBehavior=WithdrawPolicies` | 2 | kyverno-3.8.1 with 2 background replicas | observed-pass |
| hx-sveltos-env-prod-a | prod | 3 | `r2-3547312fad1c` | `spec.stopMatchingBehavior=LeavePolicies` | 2 | kyverno-3.8.1 with 2 background replicas | observed-pass |
| hx-sveltos-env-prod-b | prod | 3 | `r2-c59295d6be06` | `spec.stopMatchingBehavior=LeavePolicies` | 2 | kyverno-3.8.1 with 2 background replicas | observed-pass |

## Sources

- [Base profile](../../examples/sveltos/env-rollout/clusterprofile-base.yaml)
- [Per-cluster variants](../../examples/sveltos/env-rollout/variants.yaml)
- [Fleet design](../../examples/sveltos/env-rollout/fleet.yaml)
- [Change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
