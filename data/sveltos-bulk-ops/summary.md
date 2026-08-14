# ConfigHub changes a fleet once and proves it everywhere

This run starts with four workload clusters and a management cluster.
ConfigHub holds one reviewed base record and one variant per cluster, so the
answer to which cluster runs which revision comes from ConfigHub rather than
from a selector on a cluster. One reviewed edit raises `backgroundController.replicas`
from 2 to 3 once on the base record, and one set
operation inherits it into every variant. Each record still enforces its own
approval gate, and each approved revision was published as a release the
ConfigHub OCI gateway serves.

Sveltos fetched each release itself from
`oci://oci.hub.confighub.com/space/<space>:latest` on a
1m0s interval, so no other controller took part. The fan-out
is one reviewed edit and one set upgrade across the Spaces, and it is
4 recorded approvals and
4 publishes, because every approval binds one
cluster's record to its own exact revision and each Space publishes its own
release.

The zero-drift audit closed the run. A set-aware query across the Spaces
found no armed gates, no record changed out of band after its approval, the
inherited values were byte-identical across the variant records, and drift
injected on every cluster was repaired.

| Cluster | Space | Blocked before approval | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | hx-sveltos-env-pilot-bulk-20260814225056 | blocked and blocked | `sha256:e6be2b6ba8a830c54321bf8460d36f9578cd85c2cf352be1d3c3dca379f868d2` | Provisioned |
| hx-sveltos-env-staging | hx-sveltos-env-staging-bulk-20260814225056 | blocked and blocked | `sha256:2967bfc2e23501de76b58a5b78177280d3c4634d2a572d5f6935a9ca0e594710` | Provisioned |
| hx-sveltos-env-prod-a | hx-sveltos-env-prod-a-bulk-20260814225056 | blocked and blocked | `sha256:c310fcfb5cb2bcc1cf25392595b48137e5219d770928f3469b666a8d3c6a26cc` | Provisioned |
| hx-sveltos-env-prod-b | hx-sveltos-env-prod-b-bulk-20260814225056 | blocked and blocked | `sha256:10f0c46dccec2bcfb5c2aef8ee919b4244762ffe432bf7d89695e33b67229417` | Provisioned |

| Check | Result |
| --- | --- |
| Variants selected by the fan-out | 4/4 in one operation |
| Approvals and release publishes | 4 and 4 |
| Set-aware gate query matches | 1, the management record's schema-vet boundary alone |
| Records unchanged after approval | 4/4 |
| Inherited values identical across records | yes |
| Drift repaired | 4/4 clusters |
| Addon controller image | `docker.io/projectsveltos/addon-controller:v1.13.0-ch` |
| Cleanup | Artifacts kept deliberately |
| Release targets | one Target per cluster, named for it |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows every cluster at every checkpoint.

## Limits

- The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.
- The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.
- The management record was applied out of band with kubectl, because it is the record that opens the gateway path.
- The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.
- The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.
- The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.
- The fan-out was one reviewed edit and one set upgrade; each record still recorded its own approval and each Space still published its own release, so delivery was four publishes and four fetches rather than one.

- [Committed receipt](../../runs/sveltos-bulk-ops-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/bulk-ops/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/bulk-ops/variants.yaml)
- [Reviewed bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)
