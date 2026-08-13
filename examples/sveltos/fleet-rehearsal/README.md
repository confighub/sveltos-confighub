# Sveltos fleet rehearsal

The governed fleet chapters should not meet their cluster machinery for the
first time on patch day. This rehearsal runs the delivery path they share,
today, with no ConfigHub account, so when the chapters record the only
untested piece is the approval boundary itself.

## What it runs

One command builds a five-cluster kind fleet (one management cluster, four
workload clusters registered by environment label) and installs Sveltos from
the [pinned manifest](source-lock.yaml). The management cluster registers
itself as a Sveltos-managed cluster, so one bootstrap profile can hand it
every wave of fleet profiles from the registry.

Each wave publishes the complete current set of fleet profiles as one
raw-YAML OCI image. Sveltos fetches that image itself and sends the profiles
to every managed cluster. Nothing else carries the configuration.

1. Kyverno converges on all four clusters from the fetched profile set.
2. A demo application (podinfo, pinned in the source lock) rides the same
   rails to all four clusters with a different replica count per
   environment, so the per-environment fan-out is visible in the app
   itself.
3. A values change lands on the pilot cluster alone; the other three hold
   their state.
4. A chart version bump lands on the pilot alone with the values intact.
5. Drift injected on the pilot is repaired by Sveltos.

The receipt records phase timings, so it also measures what this machine can
carry before a real recording day.

## The layer contract

The [live remote fetch probe](../../../docs/planning/remote-url-oci-probe.md)
recorded what the fetcher accepts, and this lane holds to it. Profiles ship
as a single raw-YAML layer, and the runner refuses to publish a gzipped or
tar layer because the fetcher would misread it. The registry serves TLS,
because the fetcher speaks HTTPS only, and the certificate authority reaches
the controller in a Secret of type
`addons.projectsveltos.io/cluster-profile`, which is the type it requires.

## The boundary

No review, approval, or promotion is claimed and no ConfigHub organization
is touched. The registry stands in for the ConfigHub OCI gateway, the
profiles come straight from the reviewed example files instead of an
approved ConfigHub revision, and the bootstrap profile is applied with
kubectl as cluster setup. The rehearsal keeps its own three environment
profiles here, because it exercises fan-out by environment label, while
chapter three governs one variant per cluster and addresses each cluster by
name. The receipt states these differences, its verifier
refuses a receipt that claims governance, and no chapter matrix cell is ever
filled by a rehearsal.

## The recorded run

The [committed receipt](../../../runs/sveltos-fleet-rehearsal/receipt.yaml)
and the [summary with phase timings](../../../data/sveltos-fleet-rehearsal/summary.md)
record the first rehearsal on the reference machine. That run delivered the
artifacts through a GitOps controller, which this design replaced with the
direct fetch path above. The verifier recognizes the older receipt and waits
for the re-record instead of checking it against the new contract.

## Run it

```bash
# Deterministic self-test first: the revision ladder, the raw-YAML
# publication contract with its gzip and tar refusals, the Secret type and
# bootstrap profile the fetcher requires, and the receipt contract. Seconds.
npm run sveltos-fleet-rehearsal:self-test

# The live rehearsal. It creates its own clusters and TLS registry, records
# the receipt with timings, and cleans up. Expect twenty to forty minutes.
HELM_EXPT_ALLOW_LIVE_SVELTOS_REHEARSAL=1 npm run sveltos-fleet-rehearsal:run

# Verify the recorded receipt offline.
npm run sveltos-fleet-rehearsal:verify
```
