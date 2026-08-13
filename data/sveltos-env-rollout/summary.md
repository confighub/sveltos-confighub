# ConfigHub promotes one change through a fleet it maps cluster by cluster

This run starts with four workload clusters and a management cluster. ConfigHub
holds one reviewed base record and one variant per cluster, so the answer to
which cluster runs which revision comes from ConfigHub rather than from a
selector on a cluster. Each variant carries its own departures from the base,
and its selector addresses its own cluster and nothing else.

One reviewed change raises `backgroundController.replicas` from 1 to
2 on the base record. Each wave selected its variants with one
query over the labels they carry and approved that set in one operation, so the
operator acted once per wave and ConfigHub still recorded one approval per
cluster against that cluster's own exact revision. Every approved revision was
published as a release the OCI gateway serves, and Sveltos fetched each release
itself from `oci://oci.hub.confighub.com/space/<space>:latest` on a
1m0s interval.

The management record holds one bootstrap profile per workload Space. It was
applied out of band with kubectl, because it is the record that opens the
gateway path. Promotion never touched it. Publishing a new release moved the
tag, and Sveltos followed it.

| Wave | Cluster | Space | Departure kept through the change | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- | --- |
| 1 | hx-sveltos-env-pilot | hx-sveltos-env-pilot-20260813154117 |  | `sha256:676ddf4ae90dbb54fb338c970bc0936d02fc2e4fed6806bd092fadcb12fb51fe` | Provisioned |
| 2 | hx-sveltos-env-staging | hx-sveltos-env-staging-20260813154117 |  | `sha256:8380eafdb285fa34e985b3b62b3c1ecfd5b8875a7554b98cde6848c6e9d55bcf` | Provisioned |
| 3 | hx-sveltos-env-prod-a | hx-sveltos-env-prod-a-20260813154117 |  | `sha256:2d787c1482931c25d6b5d34fc820e5901649151a024f84ea2bb6ea2dab81aba2` | Provisioned |
| 3 | hx-sveltos-env-prod-b | hx-sveltos-env-prod-b-20260813154117 |  | `sha256:ca03ea2cc66eecc95739e0e9f029d83b4317918c3fc5c7940234ddb3dcd1354a` | Provisioned |

| Wave | Group | Variants selected | Approvals recorded |
| --- | --- | --- | --- |
| 1 | pilot | 1 | 1 |
| 2 | staging | 1 | 1 |
| 3 | prod | 2 | 2 |

No wave's approval was requested on a schedule. Each one was unlocked by the
preceding checkpoint showing every cluster it depends on reporting healthy,
and each wave records that evidence:

| Wave | Unlocked by checkpoint | Clusters observed healthy there |
| --- | --- | --- |
| 1 | `baseline` (baseline) | hx-sveltos-env-pilot, hx-sveltos-env-staging, hx-sveltos-env-prod-a, hx-sveltos-env-prod-b |
| 2 | `after-wave-1` (pilot) | hx-sveltos-env-pilot |
| 3 | `after-wave-2` (staging) | hx-sveltos-env-staging |

| Check | Result |
| --- | --- |
| Checkpoints observed | 4/4 |
| Clusters at their own changed revision after wave 3 | 4/4 |
| Convergence audit | pass |
| Addon controller image | `docker.io/projectsveltos/addon-controller:v1.13.0-ch` |
| Cleanup | Artifacts kept deliberately |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows which cluster ran which revision at each
checkpoint.

## Limits

- The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.
- The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.
- The management record was applied out of band with kubectl, because it is the record that opens the gateway path.
- The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.
- The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.
- The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.
- The proof covers one reviewed values change to this Kyverno base, not a chart version bump.

- [Committed receipt](../../runs/sveltos-env-rollout-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/env-rollout/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/env-rollout/variants.yaml)
- [Reviewed change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
