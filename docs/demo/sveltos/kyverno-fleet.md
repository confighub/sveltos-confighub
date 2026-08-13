# Sveltos Kyverno fleet

This example is for a platform team that needs to install the same system component
on a group of clusters. The team should review the configuration once, keep its
history in ConfigHub, and let a fleet controller handle cluster selection and
reconciliation.

ConfigHub stores the reviewed configuration and runs the catalog's checks against it.
ConfigHub publishes changes as OCI images on its OCI gateway. Sveltos runs on a
management cluster, fetches the configuration from that gateway, and sends it to the
clusters it selects by label. ConfigHub keeps the reviewed record; Sveltos handles
cluster selection and reconciliation.

## The reviewed configuration

The example holds its fleet the way every chapter in this repository does: one
ConfigHub record per Sveltos cluster over a shared base.

The [base record](../../../examples/sveltos/kyverno-fleet/clusterprofile-base.yaml)
contains the decisions a reviewer needs to see:

- install `kyverno/kyverno` chart version `3.8.1`;
- run three admission-controller replicas;
- use `ContinuousWithDriftDetection` so Sveltos restores the reviewed settings;
- carry a selector that matches no registered cluster, so the base itself
  reaches nothing.

The [variants declaration](../../../examples/sveltos/kyverno-fleet/variants.yaml)
gives each workload cluster its own record, departing from the base in exactly
three fields: its name, the selector line that addresses its own cluster and
nothing else, and its removal behaviour. The rollout order is part of the
reviewed declaration: the pilot cluster carries wave one and the second cluster
wave two, so the canary is two records and two approvals, and widening the
rollout means approving the second cluster's variant. No selector is edited
anywhere.

The [source lock](../../../examples/sveltos/kyverno-fleet/source-lock.yaml) pins
Sveltos v1.13.0, its manifest checksum, and the workload chart version the
proof installs.

## What the first live run proved

This run predates the per-cluster shape and stays exactly as recorded.

The test created separate kind management and workload clusters. It installed
Sveltos v1.12.0 on the management cluster and registered the workload cluster with
the `environment=staging` label.

The `ClusterProfile` was uploaded to the live `helm-catalog` ConfigHub organization
as the `clusterprofile` Unit in Space
`sveltos-kyverno-fleet-3-8-1-staging`. The standard catalog policy was attached to
that Space. It requires approval even in staging because the profile changes
cluster-wide admission policy. A human README in the same Space explains the
example before someone opens the YAML.

The exact object read back from ConfigHub was applied to the management cluster with
`kubectl`. Sveltos then:

1. selected the staging workload cluster;
2. installed Kyverno 3.8.1;
3. reported the Helm feature as `Provisioned`;
4. brought all four Kyverno deployments to their requested replica counts.

The test changed the admission-controller deployment from three replicas to one.
Sveltos restored it to three. The
[live receipt](../../../examples/sveltos/kyverno-fleet/live-receipt.yaml) records
the ConfigHub IDs and hashes, cluster result, deployment counts, and drift test.

## What the recorded canary proved

The [canary receipt](../../../runs/sveltos-oci-delivery-proof/receipt.yaml)
records the per-cluster canary live on the ConfigHub OCI gateway:

1. ConfigHub held one base record and one variant per cluster, each variant
   behind its own approval gate.
2. Wave one approved the pilot cluster's variant at its exact head revision,
   published it as a release, and Sveltos fetched it from the gateway.
3. Through all of wave one the second cluster's variant was complete,
   addressed by its bootstrap profile, and gate-armed with zero approvals;
   the gateway served nothing for its Space and its cluster observed
   untouched. The receipt records that held state as evidence.
4. Wave two's approval was requested only after the checkpoint following
   wave one showed the pilot healthy, and the second variant converged at
   its own release digest.
5. Sveltos repaired a deliberate replica change on both clusters.

Two records, two approvals, two distinct release digests, and no selector
edited anywhere. An earlier recording of this chapter widened a selector and
carried its OCI through a GitOps controller and a temporary registry; it is
superseded, and its governance claim stands as recorded in the repository
history.

## What remains

A rollout that pauses after a failed target is built into every wave — the
next approval is not requested until the previous wave's clusters report
healthy — and a larger fleet is chapter three's story. What this chapter
still waits on is an upstream release: the recording used the gzip-capable
addon controller build, and it re-records when that fix ships in a Sveltos
release.

## Check the evidence

Check the committed files without a live cluster:

```bash
npm run sveltos-example:verify
npm run sveltos-oci-delivery:verify
```

While logged into the `helm-catalog` ConfigHub organization, also check that the
live Space still contains the reviewed base record and README under the recorded
policy:

```bash
CUB_CONTEXT=<your-helm-catalog-context> npm run sveltos-example:hub-verify
```

The [fleet chapters page](./fleet-chapters.md) places this example in the
five-chapter fleet story and lists every offline proof.
