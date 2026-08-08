# ConfigHub rolls out a Sveltos profile in two waves

This run starts with two staging clusters. The reviewed Sveltos
`ClusterProfile` selects only the cluster labeled `rollout=pilot`. It installs
Kyverno 3.8.1 with three admission-controller replicas.

ConfigHub blocked that profile until its exact revision was approved. The approved
pilot profile was published as a private ConfigHub release and as a temporary
portable OCI. Argo CD reconciled the portable OCI digest on the management cluster.
Sveltos installed Kyverno on `hx-sveltos-pilot-20260727054324` and left
`hx-sveltos-next-20260727054324` unchanged.

The second revision removed one selector label:
`spec.clusterSelector.matchLabels.rollout`. No chart setting or other profile
field changed. ConfigHub blocked the new revision until it was approved, then
published it at a different OCI digest. Sveltos kept the pilot healthy and installed
Kyverno on the second staging cluster.

The test finally changed the admission-controller deployment from three replicas to
one on each cluster. Sveltos restored both deployments to three.

The temporary portable packages can be pulled without a ConfigHub account.
ConfigHub was used here because the two revisions needed stored history, policy,
approval, and named release records.

| Check | Result |
| --- | --- |
| Pilot blocked before approval | blocked |
| Pilot OCI | `sha256:0de702823d0d0cb41bfa667e29f40871f6d28e3122815ccd2f2931a9aacbc3bc` |
| Pilot selected | `hx-sveltos-pilot-20260727054324` |
| Second cluster before expansion | No Kyverno release, namespace, or ClusterSummary |
| Fleet revision blocked before approval | blocked |
| Fleet selector change | Removed `spec.clusterSelector.matchLabels.rollout` |
| Fleet OCI | `sha256:a9907fd5f277f4dff5a4ec78841562657b7fd706e2ddf1e14a347d6a66493911` |
| Argo CD after fleet revision | Synced and Healthy; digest matched |
| Healthy Sveltos targets after expansion | 2/2 |
| Replica drift repaired | 2/2 |
| Cleanup | Pass |

## What this proves

One reviewed platform record can start with a pilot, then add a second cluster by
changing one declared selector. Both revisions moved from ConfigHub through OCI and
Argo CD to the Sveltos management cluster. The receipt records the OCI digest and
the result for each workload cluster.

## Limits

Sveltos itself was installed directly as a pinned prerequisite on the management
cluster. The portable OCI used a temporary registry. This was a two-cluster local
wave, not a large production fleet or a failure-and-pause test. It proves this
Kyverno profile rather than every Sveltos feature.

- [Reviewed pilot ClusterProfile](../../examples/sveltos/kyverno-fleet/clusterprofile-pilot.yaml)
- [Pinned source versions](../../examples/sveltos/kyverno-fleet/source-lock.yaml)
- [Committed receipt](../../runs/sveltos-oci-delivery-proof/receipt.yaml)
