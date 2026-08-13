# Sveltos bulk operations, the per-cluster matrix

Chapter five of the Sveltos fleet example is the change-it-once claim:
one reviewed edit raises `backgroundController.replicas` from 2
to 3 once on the base record, and one set operation
inherits it into every per-cluster variant. Each record still enforces its
own approval gate. The chapter closes with a zero-drift audit: a set-aware
query across the Spaces must find no armed gates, no record may have
changed out of band, and drift injected on every cluster must be repaired.

No live run of this design has been recorded yet, so every observed
cell below stays empty until a live run earns it. The expected columns
come from the reviewed example files.

## Baseline, before the fan-out

| Cluster | Environment | Space | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | sveltos-kyverno-bulk-pilot | `r1-ae04b5826c68` | 2 | none |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-staging | staging | sveltos-kyverno-bulk-staging | `r1-60d746e185f7` | 2 | none |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-prod-a | prod | sveltos-kyverno-bulk-prod-a | `r1-9a3ac4029a82` | 2 | none |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-prod-b | prod | sveltos-kyverno-bulk-prod-b | `r1-854562469b6a` | 2 | none |  | awaiting-live-run (awaiting-gateway-recording) |

## After the fan-out, one edit inherited by every variant in one operation

| Cluster | Environment | Space | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | sveltos-kyverno-bulk-pilot | `r2-10622f83fa6b` | 3 | none |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-staging | staging | sveltos-kyverno-bulk-staging | `r2-d50dd725c7c3` | 3 | none |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-prod-a | prod | sveltos-kyverno-bulk-prod-a | `r2-561ba47d3d63` | 3 | none |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-prod-b | prod | sveltos-kyverno-bulk-prod-b | `r2-e206ab854d5d` | 3 | none |  | awaiting-live-run (awaiting-gateway-recording) |

## Zero-drift audit; injected drift repaired on every cluster

| Cluster | Environment | Space | Expected revision | Background replicas | Drift check | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | sveltos-kyverno-bulk-pilot | `r2-10622f83fa6b` | 3 | injected-and-restored |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-staging | staging | sveltos-kyverno-bulk-staging | `r2-d50dd725c7c3` | 3 | injected-and-restored |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-prod-a | prod | sveltos-kyverno-bulk-prod-a | `r2-561ba47d3d63` | 3 | injected-and-restored |  | awaiting-live-run (awaiting-gateway-recording) |
| hx-sveltos-env-prod-b | prod | sveltos-kyverno-bulk-prod-b | `r2-e206ab854d5d` | 3 | injected-and-restored |  | awaiting-live-run (awaiting-gateway-recording) |

## Sources

- [Base profile](../../examples/sveltos/bulk-ops/clusterprofile-base.yaml)
- [Per-cluster variants](../../examples/sveltos/bulk-ops/variants.yaml)
- [Bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)
- [Shared fleet design](../../examples/sveltos/env-rollout/fleet.yaml)
