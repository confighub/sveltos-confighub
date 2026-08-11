# Sveltos environment rollout, the per-cluster matrix

Chapter three of the Sveltos fleet example promotes one reviewed change
through the environment groups. The change raises `backgroundController.replicas`
from 1 to 2 in the kyverno/kyverno chart, version 3.8.1.
Each environment keeps its own governed record, so the matrix shows exactly
which cluster runs which revision at every checkpoint.

No live run has been recorded yet. The approval boundary is blocked by
no live run is recorded yet, so every observed cell below stays empty until the live proof
earns it. The expected columns come from the reviewed example files.

## Baseline, before the change

| Cluster | Environment | Wave | Expected revision | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r1-5ef2cd8aef8e` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-staging | staging | 2 | `r1-445596dc846a` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-a | prod | 3 | `r1-25f80d487bba` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-b | prod | 3 | `r1-25f80d487bba` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |

## After wave 1, pilot

| Cluster | Environment | Wave | Expected revision | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-4a7541e862f9` | 2 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-staging | staging | 2 | `r1-445596dc846a` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-a | prod | 3 | `r1-25f80d487bba` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-b | prod | 3 | `r1-25f80d487bba` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |

## After wave 2, staging

| Cluster | Environment | Wave | Expected revision | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-4a7541e862f9` | 2 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-staging | staging | 2 | `r2-5471d24ca614` | 2 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-a | prod | 3 | `r1-25f80d487bba` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-b | prod | 3 | `r1-25f80d487bba` | 1 |  | awaiting-live-run (awaiting-oci-native-rerun) |

## After wave 3, production

| Cluster | Environment | Wave | Expected revision | Expected background replicas | Observed | Status |
| --- | --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 1 | `r2-4a7541e862f9` | 2 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-staging | staging | 2 | `r2-5471d24ca614` | 2 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-a | prod | 3 | `r2-6d3daa60f562` | 2 |  | awaiting-live-run (awaiting-oci-native-rerun) |
| hx-sveltos-env-prod-b | prod | 3 | `r2-6d3daa60f562` | 2 |  | awaiting-live-run (awaiting-oci-native-rerun) |

## Sources

- [Pilot profile](../../examples/sveltos/env-rollout/clusterprofile-pilot.yaml)
- [Staging profile](../../examples/sveltos/env-rollout/clusterprofile-staging.yaml)
- [Production profile](../../examples/sveltos/env-rollout/clusterprofile-prod.yaml)
- [Fleet design](../../examples/sveltos/env-rollout/fleet.yaml)
- [Change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
