# The Sveltos fleet chapters

This page ties the six Sveltos fleet chapters into one story. Config comes
from ConfigHub, which publishes changes as OCI images on its OCI gateway.
Sveltos fetches the configuration from that gateway and sends it to all
Sveltos-managed clusters. A platform team manages one fleet: a management
cluster running Sveltos, and four workload clusters grouped as pilot,
staging, and two production clusters. ConfigHub keeps every reviewed record
and its approval history; OCI carries exact digests; Sveltos delivers to
the one cluster each variant's clusterRefs entry names, and labels group
the fleet into waves. Each
chapter makes one operational claim and backs it with a machine-checked
matrix, a receipt contract, and deterministic self-tests.

## The six chapters

1. **[Kyverno across the fleet](../../../examples/sveltos/kyverno-fleet/README.md)**
   installs admission policy through one reviewed variant per cluster, each
   behind an approval gate, because policy is the clearest case for review
   before a change reaches any cluster. Recorded live on the gateway; the
   first, partial recording remains a historical result.
2. **The canary, in the same example**: the pilot cluster's variant approved
   and delivered first, the second cluster's variant complete, addressed, and
   gate-armed with no approval until wave two approves its own revision.
   Widening the rollout is approving the next cluster's variant, never editing
   a selector. Recorded live on the gateway in the
   [two-wave canary](../../../data/sveltos-oci-delivery-proof/summary.md):
   two records, two approvals, two release digests, and the held record's
   inert state kept as evidence.
3. **[Environment rollout](../../../examples/sveltos/env-rollout/README.md)**
   promotes one reviewed values change pilot to staging to production. Sveltos
   maps one to many by design, through a label query that fans a profile out
   to every matching cluster, and this chapter narrows that on purpose so a
   variant and a target cluster stand one to one. All five clusters including
   the management cluster have their own governed record over a shared base,
   no variant addresses two clusters, and every query, approval, release and
   check therefore names one cluster rather than resolving at delivery time.
   That is what lets the
   [per-cluster matrix](../../../data/sveltos-env-rollout/matrix.md) show
   which cluster runs which revision at every checkpoint, and what makes
   approval and rollback per cluster possible at all. Each wave is a stage
   of a ConfigHub ChangeWorkflow: one ChangeOrder captures the reviewed
   edit, `cub variant promote --change-order` moves it into one stage at a
   time, and ConfigHub enforces the `Released` gate on the server, refusing
   a stage until the stage ahead has released the change. Every stage's
   releases also require one Approval attestation, recorded with
   `cub variant approve --change-order … --stage …`, and ConfigHub refuses a
   release until it is recorded. Recorded live on the gateway on 2026-09-26
   with the released Sveltos v1.15.0; every observed cell of the matrix
   comes from that receipt.
4. **[CVE patching](../../../examples/sveltos/cve-patch/README.md)** is fleet
   patch day with evidence: one reviewed version bump with digest-bound
   provenance, promoted through the same groups, closed by a coverage audit
   that proves no cluster was missed. It does not scan for vulnerabilities
   and does not verify any advisory claim. The
   [matrix](../../../data/sveltos-cve-patch/matrix.md) tracks chart versions.
5. **[Bulk operations](../../../examples/sveltos/bulk-ops/README.md)** is the
   change-it-once claim: one reviewed edit fans out to every record in one
   pass, and a zero-drift audit closes the run with a set-aware query across
   the Spaces, out-of-band checks on every record, and drift repaired on
   every cluster. The [matrix](../../../data/sveltos-bulk-ops/matrix.md)
   shows all three checkpoints.

6. **[The held cluster](../../../examples/sveltos/held-cluster/README.md)**:
   the move the earlier chapters deliberately did not claim. One production
   cluster is restored to an exact earlier revision under the same approval
   gate, then held there on purpose through the next fleet advance while its
   twin moves forward. The fleet ends at three points, each one a recorded
   fact. Recorded live on the gateway.

The chapters share one fleet design and hand their state forward: chapter
four starts from chapter three's outcome and chapter five from chapter
four's, and the repository gate enforces that continuity mechanically.
Chapter six continues chapter three's recorded cohort directly, and its
runner refuses to run without one standing.

## What is proven today and what is not

Every chapter holds its fleet as one variant per cluster and is recorded
live on that design over the gateway — each cluster with its own named
Target and its own clusterRefs address — with every wave's approval
carrying the checkpoint evidence that unlocked it. The recordings that
predate a design — chapter one's first manual run, the selector-widening
two-wave proof, and chapter five's three-environment recording — are kept
as recorded, recognized by the verifiers, and filled from by nothing. The same governance logic also runs offline against
fake ConfigHub and cluster surfaces in the repository gate, in seconds, with
no account or cluster.

## What the chapters still wait on

The claim these chapters sell is not that configuration can be pushed to
clusters. Anyone can push. The claim is that nothing reaches any cluster
except an exactly approved revision, and the only evidence for that is
watching the approval boundary from both sides. Before approval, the record
must visibly show that it is held with no approval on file. After someone
approves that exact revision, the block lifts and the approval is on record,
which proves the bytes that shipped are the bytes that were approved.

The recorded chapters watched that boundary through a trigger-based approval
gate that attached to a record about a second after it was created. An
earlier report here said the gate never appeared; that was a misreading in
this repository's own observation code, which asked the server for a
projection it does not return, and it has been withdrawn. ConfigHub removed
that gate on 2026-09-25 (confighubai/confighub#5495). An approval is now an
attestation on exact revisions, and a ChangeWorkflow requires it before a
release of a change is published. Chapter three is recorded watching the
boundary that way: each wave attempted its release before approval, and the
receipt carries ConfigHub's HTTP 422 refusal in the server's own words
before the approval and the publish that followed it. The other chapters' live
lanes are still written against the removed gate, so each stops before
building anything until it moves
([#34](https://github.com/confighub/sveltos-confighub/issues/34)).

Every chapter's runner fetches each approved release from the gateway,
holds its fleet per-cluster, gives each cluster's Space a Target named for
it, names each cluster through clusterRefs, and refuses a wave's approval
until the preceding checkpoint shows the clusters it depends on reporting
healthy — and every chapter is recorded live on exactly that design.
Chapter three also hands the order of its waves and the approval of each
stage's releases to ConfigHub, and is recorded live that way. Its
single-operator run relaxes separation of duties, because ConfigHub does
not by default count an approval from whoever promoted the change, and its
receipt says so. Its `Healthy` gate waits longer, on a Sveltos status
reporter ([#33](https://github.com/confighub/sveltos-confighub/issues/33))
and on ConfigHub recognising the provider (confighubai/confighub#5049), so
the runner's checkpoint evidence stays the observed-health layer until then.
The gateway serves gzipped layers, so every recording needs an addon
controller that decompresses them, and each receipt names the image it
used. That fix shipped in Sveltos v1.14.0, and chapter three is recorded on
the released v1.15.0 as published; the other chapters still pin v1.13.0 and
name the v1.13.0-ch build until they re-record.

Chapter three's runner starts with a gate preflight: it wires a throwaway
Space to the platform filter, refuses if the filter still resolves the
removed approval trigger, creates the reviewed workflow there and reads its
approval requirement back, and refuses in seconds if anything is missing,
instead of failing after the seven-minute fleet build.


## Run the offline proofs yourself

Every chapter's checks run without any account, cluster, or network access:

```bash
npm run sveltos-example:self-test
npm run sveltos-oci-delivery:self-test
npm run sveltos-env-rollout:self-test
npm run sveltos-env-rollout-proof:self-test
npm run sveltos-cve-patch:self-test
npm run sveltos-cve-patch-proof:self-test
npm run sveltos-bulk-ops:self-test
npm run sveltos-bulk-ops-proof:self-test
npm run sveltos-held-cluster:self-test
npm run sveltos-held-cluster-proof:self-test
```

The delivery machinery the chapters share can be rehearsed today with no
account at all: the [fleet rehearsal](../../../examples/sveltos/fleet-rehearsal/README.md)
builds the five-cluster kind fleet, converges Kyverno everywhere from OCI
digests fetched by Sveltos itself, delivers a demo application to all four
clusters with per-environment replica counts, lands a values change and a
version bump on the pilot alone, and repairs injected drift, under a
receipt that explicitly claims no governance. An earlier recording used a
GitOps controller as the OCI carrier; the
[live remoteURL probe](../../planning/remote-url-oci-probe.md) verified the
direct fetch path this design now uses.

One probe answers whether your own organization carries what chapter three
gates on: `CUB_CONTEXT=my-policy npm run sveltos-gate:probe` wires a
throwaway Space to the platform filter, checks its triggers, creates the
reviewed workflow and reads its approval requirement back, cleans up, and
reports what it saw.
The patched
chart's digest and values fit can be checked any day with
`npm run sveltos-cve-patch-proof:verify-chart`, with no account or cluster.

Fleet proofs run serially against the organization, never in parallel. The
planning brief behind the chapters is
[sveltos-fleet-brief.md](../../planning/sveltos-fleet-brief.md).
