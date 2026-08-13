# Sveltos Kyverno fleet

This example opens the Sveltos fleet story: chapters one and two. ConfigHub
holds one reviewed record per Sveltos cluster, an approval gate holds every
record until its exact revision is approved, and Sveltos installs the
declared add-on and keeps it converged. Chapter one is the governed record
and the gate. Chapter two is the canary: the pilot cluster's variant approved
and delivered first, the second cluster's variant complete, addressed, and
gate-armed the whole time, and nothing reaching its cluster until its own
revision is approved.

## The shape

One variant per cluster, including the management cluster, held the way every
chapter in this repository holds a fleet:

- The [base record](clusterprofile-base.yaml) carries what every cluster
  shares: Kyverno chart 3.8.1, three admission-controller replicas, and
  `ContinuousWithDriftDetection`. Its selector matches no registered cluster,
  it is given no target, and its Space is never published, so nothing reaches
  a cluster from the base itself.
- The [variants declaration](variants.yaml) gives each workload cluster its
  own record, cloned from the base and departing in exactly three fields:
  its name, the selector line that addresses its own cluster and nothing
  else, and its removal behaviour. The rollout order is part of the reviewed
  declaration: the pilot cluster carries wave one, the second cluster wave
  two.
- The management record holds one bootstrap profile per workload Space. Its
  first revision is applied out of band with kubectl, because it is the
  record that opens the gateway path, and ConfigHub governs every revision
  after that.

## The canary, without a selector edit

Widening a rollout here means approving the next cluster's variant. Wave one
approves the pilot's record, ConfigHub publishes it as a release, and Sveltos
fetches it from the ConfigHub OCI gateway. Through all of wave one the second
cluster's variant already exists, already addresses its cluster, and already
carries an armed approval gate with no approval on file; the gateway serves
nothing for its Space, so its cluster stays untouched, and the run records
that held state as evidence rather than as an accident. Wave two's approval
is itself gated on evidence: the runner refuses to request it until the
checkpoint after wave one shows the pilot healthy. No selector is edited at
any point, so there is no moment where one approval covers a set.

## What the recorded receipts show

The [canary receipt](../../../runs/sveltos-oci-delivery-proof/receipt.yaml)
records this design live on the gateway: two records, two approvals, two
release digests. Wave one approved and delivered the pilot cluster's variant
alone. Through all of wave one the second cluster's variant was held with
its gate armed and zero approvals, the gateway served nothing for its Space,
and its cluster observed untouched — the receipt keeps that held state as
evidence. Wave two's approval was unlocked by the checkpoint that showed the
pilot healthy, the second variant converged at its own digest, and injected
drift was repaired on both clusters. The
[summary](../../../data/sveltos-oci-delivery-proof/summary.md) renders the
whole run.

One earlier receipt is kept as recorded: the
[first live receipt](live-receipt.yaml) from the v1.12.0 manual run, where
ConfigHub stored and gated the reviewed profile, Sveltos installed Kyverno
on one staging cluster, and a replica change was repaired. It remains a
partial, historical result, and the verifier recognizes it rather than
filling from it.

## Repeat and verify

The offline self-tests drive the same record machinery, approval brackets,
canary hold, and receipt checks against fake ConfigHub and cluster surfaces.
They need no account, cluster, or network access and finish in seconds.

```bash
npm run sveltos-example:self-test
npm run sveltos-oci-delivery:self-test
```

## How to run the live proof

The live run is fully self-contained: it creates a kind management cluster
and two workload clusters, stores the base and both variants, walks the two
waves, repairs injected drift on both clusters, records the receipt, and
cleans up. It needs one authenticated context in the organization that owns
the approval policy, and the addon controller build that decompresses the
gateway's gzipped layers.

```bash
CUB_CONTEXT=my-policy npm run sveltos-gate:probe

HELM_EXPT_ALLOW_LIVE_SVELTOS_OCI_PROOF=1 \
CUB_CONTEXT=my-policy \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-oci-delivery:run

npm run sveltos-oci-delivery:verify
```

The recorded runs used the maintainers' catalog organization, named
`helm-catalog`, because it owns the approval policy space and trigger filter
the runner checks for. To run this in your own organization, create that
wiring first from
[the committed policy](../../../config-catalog/policies/catalog-standard.yaml);
the runner verifies its preconditions and stops early with a named reason
instead of failing after the fleet build.

## Chapter three

The [environment rollout example](../env-rollout/README.md) continues the
story at fleet scale: one reviewed values change promoted from pilot to
staging to production across five clusters, with a per-cluster matrix that
shows exactly which cluster runs which revision at each checkpoint.
