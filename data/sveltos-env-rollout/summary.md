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
| 1 | hx-sveltos-env-pilot | hx-sveltos-env-pilot-20260812195312 |  | `sha256:98b6c270b16b0f6c142c88d06e3d2d3969215ecb5b05ba87bdca6910123527dd` | Provisioned |
| 2 | hx-sveltos-env-staging | hx-sveltos-env-staging-20260812195312 |  | `sha256:07fa92f9d91da8c479f860b274ae7ba1794d5a89bc1411c36a8f66002b6df03e` | Provisioned |
| 3 | hx-sveltos-env-prod-a | hx-sveltos-env-prod-a-20260812195312 |  | `sha256:927014dd9baabd516ff418423a110cc80cf7b34e28226c4bae678e72cd94e302` | Provisioned |
| 3 | hx-sveltos-env-prod-b | hx-sveltos-env-prod-b-20260812195312 |  | `sha256:8a818618236f98afb11f0b30a6763c6baa54dbd91c367dbb5418cf6d80dd167e` | Provisioned |

| Wave | Group | Variants selected | Approvals recorded |
| --- | --- | --- | --- |
| 1 | pilot | 1 | 1 |
| 2 | staging | 1 | 1 |
| 3 | prod | 2 | 2 |

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
