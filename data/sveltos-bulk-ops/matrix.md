# Sveltos bulk operations, the per-cluster matrix

Chapter five of the Sveltos fleet example is the change-it-once claim:
one reviewed edit raises `backgroundController.replicas` from 2
to 3 once on the base record, and one set operation
inherits it into every per-cluster variant. Each record still enforces its
own approval gate. The chapter closes with a zero-drift audit: a set-aware
query across the Spaces must find no armed gates, no record may have
changed out of band, and drift injected on every cluster must be repaired.

The observed columns come from the committed live receipt in
`runs/sveltos-bulk-ops-proof/receipt.yaml`. The expected columns
come from the reviewed example files.

## Baseline, before the fan-out

| Cluster | Environment | Space | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | sveltos-kyverno-bulk-pilot | `r1-8a4e405bd347` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |
| hx-sveltos-env-staging | staging | sveltos-kyverno-bulk-staging | `r1-93901308d341` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-a | prod | sveltos-kyverno-bulk-prod-a | `r1-b62778181d41` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-b | prod | sveltos-kyverno-bulk-prod-b | `r1-e6a73d239e82` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |

## After the fan-out, one edit inherited by every variant in one operation

| Cluster | Environment | Space | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | sveltos-kyverno-bulk-pilot | `r2-d840465209d6` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |
| hx-sveltos-env-staging | staging | sveltos-kyverno-bulk-staging | `r2-33378fa6e32b` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-a | prod | sveltos-kyverno-bulk-prod-a | `r2-5f09dd1e8f52` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-b | prod | sveltos-kyverno-bulk-prod-b | `r2-9f351f97f3ef` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |

## Zero-drift audit; injected drift repaired on every cluster

| Cluster | Environment | Space | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | sveltos-kyverno-bulk-pilot | `r2-d840465209d6` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |
| hx-sveltos-env-staging | staging | sveltos-kyverno-bulk-staging | `r2-33378fa6e32b` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |
| hx-sveltos-env-prod-a | prod | sveltos-kyverno-bulk-prod-a | `r2-5f09dd1e8f52` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |
| hx-sveltos-env-prod-b | prod | sveltos-kyverno-bulk-prod-b | `r2-9f351f97f3ef` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |

## Sources

- [Base profile](../../examples/sveltos/bulk-ops/clusterprofile-base.yaml)
- [Per-cluster variants](../../examples/sveltos/bulk-ops/variants.yaml)
- [Bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)
- [Shared fleet design](../../examples/sveltos/env-rollout/fleet.yaml)
