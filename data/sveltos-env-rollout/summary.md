# ConfigHub promotes one change through an environment fleet

This run starts with four workload clusters in three environment groups. Each
environment keeps its own governed `ClusterProfile` record built from one
shared baseline, so the only reviewed difference between environments is the
selector.

One reviewed change raises `backgroundController.replicas` from 1 to
2. ConfigHub blocked every revision until its exact head was
approved and published each approved revision as a release its OCI gateway
serves. Sveltos fetched each release itself from
`oci://oci.hub.confighub.com/space/<space>:latest` on a
1m0s interval and converged the pilot cluster first, then
staging, then both production clusters. At every checkpoint the unchanged
environments were verified stable, and the run closed with a convergence audit
across all four clusters.

Promotion never touched the bootstrap profile on the management cluster.
Publishing a new release moved the tag, and Sveltos followed it.

| Wave | Environment | Blocked before approval | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- |
| 1 | pilot | blocked and blocked | `sha256:894b8fa9df040e6b709a6c487c7730c96b2bf6496909393c57c45a0410331ff8` | Provisioned |
| 2 | staging | blocked and blocked | `sha256:afd26309e53fa794ec135fa65a099b791e11f84b93269e1ec4d174ac85d54499` | Provisioned |
| 3 | prod | blocked and blocked | `sha256:20ef4d3787e52508708685745fddb6009e8412574b2b03ea8397492eed4bd879` | Provisioned |

| Check | Result |
| --- | --- |
| Checkpoints observed | 4/4 |
| Clusters at the changed revision after wave 3 | 4/4 |
| Convergence audit | pass |
| Addon controller image | `docker.io/projectsveltos/addon-controller:v1.13.0-ch` |
| Cleanup | Pass |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows which cluster ran which revision at each
checkpoint.

## Limits

- The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.
- The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.
- The gateway serves each release as a gzipped tar layer, so the run needs an addon controller that gunzips. The image it ran is recorded above.
- The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.
- The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.
- The proof covers one reviewed values change to this Kyverno profile, not a chart version bump.

- [Committed receipt](../../runs/sveltos-env-rollout-proof/receipt.yaml)
- [Reviewed change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
