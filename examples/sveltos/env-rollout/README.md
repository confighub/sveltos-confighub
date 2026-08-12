# Sveltos environment rollout

One reviewed values change moves from pilot to staging to production, and
every wave is approved before any cluster in it sees the change. ConfigHub
holds one record per cluster, so it can answer which cluster runs which
revision from its own records.

[Sveltos](https://projectsveltos.io) delivers the change and keeps each
cluster reconciled; ConfigHub holds the reviewed records, gates them, and
publishes each approved revision as an OCI image that Sveltos fetches. The
runner pins Sveltos v1.13.0 and expects the addon controller build that
decompresses gzipped layers, which the ConfigHub gateway serves.

## Why this chapter exists

Promoting a change through environments is the operation every platform team
does and few can evidence. The claim here is not that configuration reached
the clusters. It is that nothing reached any cluster except a revision
someone approved for that cluster, and that the clusters outside the wave
held their state while one group moved.

Both tools can select clusters. Sveltos treats a label query as the way you
choose which clusters get a change, and ConfigHub treats the record-to-target
mapping as the way you know what is where. Left as it was, the same decision
was expressed twice and only one of them was queryable: one record selected
`environment: prod` and Sveltos decided at delivery time that this meant two
clusters, so a ConfigHub query could not say which cluster had received what.

This chapter puts the mapping in ConfigHub. Each variant carries a selector
that matches exactly one cluster, so the selector stops being a fan-out
mechanism and becomes an addressing detail. Sveltos remains the delivery
mechanism and the reconciler, and stops deciding scope.

## See the result

The [matrix](../../../data/sveltos-env-rollout/matrix.md) shows which cluster
runs which revision at four checkpoints, the baseline and then after each
wave, and which departure each cluster keeps through the change. The
[receipt](../../../runs/sveltos-env-rollout-proof/receipt.yaml) records, per
cluster, its Space, its gateway reference, its approved revision, and the
release digest it published in each wave.

## How it works

The [base record](clusterprofile-base.yaml) holds the reviewed content every
cluster shares: the chart, the pinned version, the drift mode and the shared
values. It carries a selector that matches no registered cluster, it is given
no target, and its Space is never published, so nothing reaches a cluster
from the base itself.

The [variants record](variants.yaml) declares one variant per cluster and the
departures each one carries. Each variant is created as a clone of the base
unit, linked to it, so a later change to the base flows down while the
departures stay. The departures are declared, not hand-written into five
copies of the same file:

- `metadata.name`, so each cluster's profile is its own object.
- `spec.clusterSelector.matchLabels.cluster`, which addresses that cluster
  and nothing else.
- `spec.stopMatchingBehavior`, which is the behaviour that genuinely differs.
  The two production clusters leave their policies in place if the record
  stops matching them; pilot and staging withdraw them.

The [change candidate](change-candidate.yaml) is one values edit that raises
`backgroundController.replicas` from 1 to 2 in the Kyverno 3.8.1 chart. It is
made once, on the base. Each wave then selects its variants with one query
over the labels the records carry, upgrades that set from the base in one
operation, and approves that set in one operation. ConfigHub records one
approval per cluster, each bound to that cluster's own exact revision.

Every approved revision is published as a release the ConfigHub OCI gateway
serves. The management cluster fetches each release itself and applies the
reviewed profile, and Sveltos sends the chart to the one cluster the profile
addresses.

## What a departure may not touch

A change to the base and a departure that write the same field, or different
keys of the same map, merge with the departure winning and nothing said about
it. A recorded ConfigHub run showed exactly that: a variant whose departure
sat on a map the base also wrote received none of the base's changes while
its upstream pointer advanced to the base head.

So the runner refuses a departure that collides with the field the change
writes, before it builds anything, and it checks after every upgrade that the
variant came out carrying both the inherited change and its own departures.
This is why the per-cluster departure is a profile field rather than a chart
value: the chart values ride in one string field of the profile, so any
values departure would collide with any values change.

## The bootstrap boundary

The management cluster has a record too, and it holds one bootstrap profile
per workload Space, each pointing at that Space on the gateway. That record
is what lets the management cluster fetch from the gateway at all, so its
first revision cannot arrive through the gateway. It is applied once with
kubectl as cluster setup, and ConfigHub governs every revision after that
under the same approval gate. The receipt records that boundary rather than
implying the management cluster governed itself from the beginning.

## What this costs

A fleet-wide change is now N approvals and N publishes rather than one label
edit. The wave is one operation for the operator, because the query selects
the set and one approve command covers it, but ConfigHub still records one
approval and one release per cluster, and the receipt counts them that way.
That is the trade taken deliberately: the mapping is worth more than the
saved keystrokes, because it is what makes per-cluster approval and
per-cluster rollback possible at all.

## The matrix

The per-cluster matrix shows which cluster runs which revision at the
baseline and after each wave. It follows the Kubara matrix discipline:
expected evidence comes from the reviewed files, observed evidence only ever
comes from a live run, and empty cells stay empty until a run earns them.

- [matrix.csv](../../../data/sveltos-env-rollout/matrix.csv)
- [matrix.md](../../../data/sveltos-env-rollout/matrix.md)
- [matrix.html](../../../data/sveltos-env-rollout/matrix.html)

## Current status

The per-cluster design awaits a live re-record. The committed receipt at
[runs/sveltos-env-rollout-proof/receipt.yaml](../../../runs/sveltos-env-rollout-proof/receipt.yaml)
records the earlier run, which governed three environment records, so the
verify lanes name it as superseded and the matrix keeps its observed columns
empty. The receipt and its summary are kept as recorded rather than rewritten.

Before it builds anything the runner probes the approval gate on a throwaway
Space and Unit, so a wiring problem refuses in seconds instead of failing
after the fleet build. Its self-test proves the same governance walk offline
against fake ConfigHub and cluster surfaces, with no account or cluster.

## Chapter four

The [CVE patching example](../cve-patch/README.md) continues from this
chapter's outcome: one reviewed chart version bump with digest-bound
provenance, promoted through the same environment groups, closed by a
coverage audit that proves no cluster was missed.

## Repeat and verify

```bash
# Rebuild the matrix surfaces from the reviewed example files. A few seconds.
node scripts/generate-sveltos-env-rollout.mjs --generate

# Verify the committed surfaces and the example invariants.
npm run sveltos-env-rollout:verify

# Deterministic self-test: fixture compile, tamper refusals, and the
# self-contained HTML contract. No account, cluster, or network access.
npm run sveltos-env-rollout:self-test

# Deterministic self-test of the live runner: the gate preflight, the base
# and its five variants, the set queries with their refusals, all nine
# approval brackets, and the receipt tamper battery, against fake ConfigHub
# and OCI surfaces. A few seconds.
npm run sveltos-env-rollout-proof:self-test
```

The live proof builds a self-contained kind fleet, creates one base record and
five per-cluster variants, approves each wave as one set operation, publishes
each approved revision as an OCI image that Sveltos fetches itself, and closes
with a convergence audit. Fleet proofs run serially against the organization,
never in parallel.

Confirm the approval wiring first. The probe wires one throwaway Space,
creates one probe Unit, watches for the approval gate, and cleans up after
itself:

```bash
CUB_CONTEXT=my-policy npm run sveltos-gate:probe
```

Then record the run. One authenticated context is enough, because no cluster
Spaces are created:

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_ENV_ROLLOUT=1 \
CUB_CONTEXT=my-policy \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-env-rollout-proof:run

# Then refresh the summary and the observed matrix columns.
npm run sveltos-env-rollout-proof:generate
npm run sveltos-env-rollout:generate
```

The run removes its clusters and its Spaces when it finishes. To look at them
afterwards, set `HELM_EXPT_KEEP_SVELTOS_ARTIFACTS=1`. The run then prints
exactly what it left behind and the command that removes each one, and its
receipt records that the artifacts were kept deliberately rather than reading
as a failed cleanup.
