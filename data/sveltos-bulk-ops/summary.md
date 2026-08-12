# ConfigHub changes a fleet once and proves it everywhere

This run starts with four workload clusters in three environment groups. One
reviewed edit raises `backgroundController.replicas` from 2 to
3 and fans out to every environment record in one pass. Each
record still enforces its own approval gate, and each approved revision was
published as a release the ConfigHub OCI gateway serves.

Sveltos fetched each release itself from
`oci://oci.hub.confighub.com/space/<space>:latest` on a
1m0s interval, so no other controller took part. The fan-out is
one authored edit written to every record in one pass, and it is
3 approvals and 3 publishes,
because each Space publishes its own release and each bootstrap profile reads
its own Space.

The zero-drift audit closed the run. A set-aware query across the Spaces
found no armed gates, no record changed out of band after its approval, the
stored change was byte-identical across the records, and drift injected on
every cluster was repaired.

| Record | Blocked before approval | Changed release digest | Sveltos |
| --- | --- | --- | --- |
| pilot | blocked and blocked | `sha256:4ae402c229b593ac51bd5f4e424316685e4865321af69d69906639933d736ba0` | Provisioned |
| staging | blocked and blocked | `sha256:ecba2997a790f9027ce1099af781b350221e94dc03b948bab6853c3629029cc2` | Provisioned |
| prod | blocked and blocked | `sha256:e73adabe14f3753db681872b597082a078890ad486d42e22f5927f4e74e9e538` | Provisioned |

| Check | Result |
| --- | --- |
| Fan-out records | 3/3 in one pass |
| Approvals and release publishes | 3 and 3 |
| Set-aware gate query matches | 0 |
| Records unchanged after approval | 3/3 |
| Stored change identical across records | yes |
| Drift repaired | 4/4 clusters |
| Addon controller image | `docker.io/projectsveltos/addon-controller:v1.13.0-ch` |
| Cleanup | Pass |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows every cluster at every checkpoint.

## Limits

- The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.
- The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.
- The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.
- The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.
- The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.
- The fan-out applied one reviewed candidate per record in one pass; each record kept its own approval gate. Approvals were not batched.
- One pass wrote every record, but each Space publishes its own release, so delivery was three publishes and three fetches rather than one.

- [Committed receipt](../../runs/sveltos-bulk-ops-proof/receipt.yaml)
- [Reviewed bulk change candidate](../../examples/sveltos/bulk-ops/bulk-change.yaml)
