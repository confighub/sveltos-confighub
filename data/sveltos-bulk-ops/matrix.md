# Sveltos bulk operations, the per-cluster matrix

Chapter five of the Sveltos fleet example is the change-it-once claim:
one reviewed edit raises `backgroundController.replicas` from 2
to 3 and fans out to every environment record in one pass.
Each record still enforces its own approval gate. The chapter closes with a
zero-drift audit: a set-aware query across the Spaces must find no armed
gates, no record may have changed out of band, and drift injected on every
cluster must be repaired.

The observed columns come from the committed live receipt in
`runs/sveltos-bulk-ops-proof/receipt.yaml`. The expected columns
come from the reviewed example files.

## Baseline, before the fan-out

| Cluster | Environment | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | `r1-e199257804ae` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |
| hx-sveltos-env-staging | staging | `r1-fb24308c6fab` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-a | prod | `r1-703f3399eaf7` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-b | prod | `r1-703f3399eaf7` | 2 | none | kyverno-3.8.2 with 2 background replicas, drift none | observed-pass |

## After the fan-out, one pass over every record

| Cluster | Environment | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | `r2-d6c85e486a84` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |
| hx-sveltos-env-staging | staging | `r2-aeb22cf0c2eb` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-a | prod | `r2-246a9ab834a5` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |
| hx-sveltos-env-prod-b | prod | `r2-246a9ab834a5` | 3 | none | kyverno-3.8.2 with 3 background replicas, drift none | observed-pass |

## Zero-drift audit; injected drift repaired on every cluster

| Cluster | Environment | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | `r2-d6c85e486a84` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |
| hx-sveltos-env-staging | staging | `r2-aeb22cf0c2eb` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |
| hx-sveltos-env-prod-a | prod | `r2-246a9ab834a5` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |
| hx-sveltos-env-prod-b | prod | `r2-246a9ab834a5` | 3 | injected-and-restored | kyverno-3.8.2 with 3 background replicas, drift injected-and-restored | observed-pass |

## Sources

- [Pilot profile](../../examples/sveltos/bulk-ops/clusterprofile-pilot.yaml)
- [Staging profile](../../examples/sveltos/bulk-ops/clusterprofile-staging.yaml)
- [Production profile](../../examples/sveltos/bulk-ops/clusterprofile-prod.yaml)
- [Bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)
- [Shared fleet design](../../examples/sveltos/env-rollout/fleet.yaml)
