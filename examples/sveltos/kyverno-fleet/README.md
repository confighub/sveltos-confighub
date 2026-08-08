# Sveltos Kyverno fleet

This example shows how ConfigHub and Sveltos can divide the work of managing a
platform component across a cluster fleet.

ConfigHub stores the reviewed configuration, its variants, policy checks, and
promotion history. Sveltos runs on a management cluster, selects workload
clusters by label, and installs the declared add-on. Teams can change the
configuration once in ConfigHub instead of running an upgrade command against
each cluster.

This Space requires approval before apply because it changes cluster-wide
admission policy, even though this example targets staging.

## What to inspect

Open the `clusterprofile` Unit first. It contains the Sveltos
`ClusterProfile` used by the live demo Space:

- select clusters labeled `environment=staging`;
- install Kyverno chart version `3.8.1`;
- run three admission-controller replicas;
- keep the cluster aligned with `ContinuousWithDriftDetection`.

The chart version and values are fixed in the reviewed object. The separate
[`clusterprofile-pilot.yaml`](clusterprofile-pilot.yaml) file adds
`rollout=pilot`. The two-wave proof starts with that narrower selector, then
removes only the rollout label after review.

## What the live tests showed

The test used Sveltos v1.12.0 with separate kind management and workload
clusters. ConfigHub stored the `ClusterProfile` under the catalog's standard
checks. The exact object exported from ConfigHub was applied to the management
cluster.

In the first run, Sveltos selected the staging workload cluster, installed Kyverno 3.8.1, and
reported the Helm feature as `Provisioned`. All four Kyverno deployments became
available. The test then changed the admission-controller replica count from
three to one on the workload cluster. Sveltos restored it to three.

The current OCI delivery run used two workload clusters. ConfigHub blocked the
pilot profile until its exact revision was approved. It published the approved
profile as a private release and as a temporary portable OCI. Argo CD reconciled
that OCI digest on the management cluster. Sveltos installed Kyverno on the pilot
and left the second cluster unchanged.

The next ConfigHub revision removed only
`spec.clusterSelector.matchLabels.rollout`. That revision was also blocked until
approval and published at a different OCI digest. Sveltos then kept the pilot
healthy and installed Kyverno on the second staging cluster. The test changed the
replica count on both clusters, and Sveltos restored both.

## What remains

The current run installed Sveltos directly from a pinned upstream manifest and used
a temporary registry for the portable OCI. It used two local kind clusters. A
permanent package, a larger fleet, and a rollout that pauses after a failed target
still need their own tests.

## Chapter three

The [environment rollout example](../env-rollout/README.md) starts the next
chapter: one reviewed values change promoted from pilot to staging to
production, with a per-cluster matrix that shows exactly which cluster runs
which revision at each checkpoint.

## Repeat and verify

The [website guide](https://confighub.github.io/helm-expt/site/d/docs/demo/sveltos/kyverno-fleet.html)
explains the commands and results. The
[source profile](https://github.com/confighub/helm-expt/blob/main/examples/sveltos/kyverno-fleet/clusterprofile.yaml),
[pilot profile](https://github.com/confighub/helm-expt/blob/main/examples/sveltos/kyverno-fleet/clusterprofile-pilot.yaml),
[source lock](https://github.com/confighub/helm-expt/blob/main/examples/sveltos/kyverno-fleet/source-lock.yaml),
and
[live receipt](https://github.com/confighub/helm-expt/blob/main/examples/sveltos/kyverno-fleet/live-receipt.yaml)
record the first result. The
[OCI delivery summary](https://confighub.github.io/helm-expt/site/d/data/sveltos-oci-delivery-proof/summary.html)
and
[OCI delivery receipt](https://github.com/confighub/helm-expt/blob/main/runs/sveltos-oci-delivery-proof/receipt.yaml)
record the automated handoff.

## How to run the live proof

Run the offline self-tests first. They drive the same approval bracket,
portable OCI round trip, and receipt checks against fake ConfigHub and OCI
surfaces. They need no account, cluster, or network access and finish in
seconds.

```bash
npm run sveltos-example:self-test
npm run sveltos-oci-delivery:self-test
```

The two-wave delivery proof is fully self-contained: it creates its own kind
management cluster, two workload clusters, and a local OCI registry, records
the receipt, and cleans up. The fleet build takes five to seven minutes.

```bash
# 1. Two authenticated contexts, deliberately separate: the maintained
#    policy organization that owns the reviewed profile, and a scratch
#    organization for the throwaway cluster Spaces. A browser round trip
#    each, well under a minute.
cub --context my-policy auth login     # choose the helm-catalog organization
cub --context my-scratch auth login    # choose a scratch organization

# 2. Explicit consent plus both contexts, then one command. The fleet
#    builds in five to seven minutes (registry, management cluster, two
#    workload clusters, Sveltos converged); the two delivery waves add a
#    few minutes more.
HELM_EXPT_ALLOW_LIVE_SVELTOS_OCI_PROOF=1 \
HELM_EXPT_ALLOW_SCRATCH_ORG=1 \
CUB_CONTEXT=my-policy \
SVELTOS_CLUSTER_CONTEXT=my-scratch \
npm run sveltos-oci-delivery:run

# 3. Verify the recorded receipt offline, no live access needed.
#    A few seconds.
npm run sveltos-oci-delivery:verify
```

Known limit: on current hub.confighub.com the approval gate does not appear in
the Unit's `ApplyGates` from the Space trigger-filter wiring, so the run stops
at the approval-boundary observation. That behavior is tracked in
confighubai/confighub#4975; the run is expected to pass once it is resolved.
When cleaning up scratch Spaces by hand, delete each management Space before
its `-argo-apps` sibling, or the Target is stranded by a dangling reference
(confighubai/confighub#4980).
