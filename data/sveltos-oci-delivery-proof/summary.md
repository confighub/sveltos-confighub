# ConfigHub delivers a canary the fleet can audit: one record per cluster, one approval per wave

This run starts with a pilot cluster and a second cluster, both in staging, and
a management cluster. ConfigHub holds one reviewed base record and one variant
per cluster, so the answer to which cluster runs which revision comes from
ConfigHub rather than from a selector on a cluster.

Wave one approved and delivered the pilot cluster's record alone. Through all
of wave one the second cluster's record already existed, already addressed its
own cluster, and stayed **armed**: its approval gate present, zero approvals
recorded, and the gateway serving nothing for its Space, so its cluster stayed
untouched. Sveltos fetched each approved release itself from
`oci://oci.hub.confighub.com/space/<space>:latest` on a
1m0s interval. Wave two's approval was itself evidence-gated:
it was refused until the checkpoint after wave one showed the pilot healthy.
No selector was edited at any point; widening the rollout meant approving the
second cluster's own record.

After both waves converged, injected drift was repaired on both clusters:
Sveltos restored `kyverno-admission-controller` from a dropped replica
back to its reviewed count of 3.

| Wave | Cluster | Space | Release digest | Sveltos |
| --- | --- | --- | --- | --- |
| 1 | hx-sveltos-fleet-pilot | hx-sveltos-fleet-pilot-20260813160921 | `sha256:23e16e671711f17c7783a79f741cd88e1f43cbe5c723c3dde8ae8ab630f8c659` | Provisioned |
| 2 | hx-sveltos-fleet-second | hx-sveltos-fleet-second-20260813160921 | `sha256:6ef9379492150529b1c55669448e4d130d5313425e7fc8808d75d67648c1cfd7` | Provisioned |

No wave's approval was requested on a schedule. Each one was unlocked by the
preceding checkpoint showing every cluster it depends on reporting healthy,
and each wave records that evidence:

| Wave | Unlocked by checkpoint | Clusters observed healthy there |
| --- | --- | --- |
| 1 | `baseline` (baseline) | hx-sveltos-fleet-pilot, hx-sveltos-fleet-second |
| 2 | `after-wave-1` (staging) | hx-sveltos-fleet-pilot |

| Check | Result |
| --- | --- |
| Checkpoints observed | 3/3 |
| Second record inert through wave one | held, gate-armed, zero approvals |
| Release digests distinct | yes |
| Drift repaired | 2/2 |
| Addon controller image | `docker.io/projectsveltos/addon-controller:v1.13.0-ch` |
| Cleanup | Artifacts kept deliberately |

- [Committed receipt](../../runs/sveltos-oci-delivery-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/kyverno-fleet/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/kyverno-fleet/variants.yaml)
- [Reviewed source lock](../../examples/sveltos/kyverno-fleet/source-lock.yaml)
