# The Sveltos fleet chapters

This page ties the five Sveltos fleet chapters into one story. Config comes
from ConfigHub, which publishes changes as OCI images on its OCI gateway.
Sveltos fetches the configuration from that gateway and sends it to all
Sveltos-managed clusters. A platform team manages one fleet: a management
cluster running Sveltos, and four workload clusters grouped as pilot,
staging, and two production clusters. ConfigHub keeps every reviewed record
and its approval history; OCI carries exact digests; Sveltos selects
clusters by label and reconciles them. Each
chapter makes one operational claim and backs it with a machine-checked
matrix, a receipt contract, and deterministic self-tests.

## The five chapters

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
   approval and rollback per cluster possible at all. Recorded live on the
   gateway.
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

The chapters share one fleet design and hand their state forward: chapter
four starts from chapter three's outcome and chapter five from chapter
four's, and the repository gate enforces that continuity mechanically.

## What is proven today and what is not

Every chapter holds its fleet as one variant per cluster and is recorded
live on that design over the gateway, with every wave's approval carrying
the checkpoint evidence that unlocked it. The two recordings that predate
the design — chapter one's first manual run and the selector-widening
two-wave proof — are kept as recorded, recognized by the verifiers, and
filled from by nothing. The same governance logic also runs offline against
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

That boundary works. The approval gate attaches to a record about a second
after it is created. An earlier report here said the gate never appeared;
that was a misreading in this repository's own observation code, which asked
the server for a projection it does not return, and it has been withdrawn.

Every chapter's runner fetches each approved release from the gateway and
holds its fleet per-cluster, and no wave's approval is requested until the
preceding checkpoint shows the clusters it depends on reporting healthy.
Chapters one through four are recorded live on exactly that design; chapter
five's committed recording is the earlier three-environment design, and its
per-cluster re-record is in flight
([#17](https://github.com/confighub/sveltos-confighub/issues/17),
[#18](https://github.com/confighub/sveltos-confighub/issues/18)). What remains is not a
run but a release: the gateway serves gzipped layers, so these recordings
used an addon controller build that decompresses them, and each receipt
names the image it used. When that fix ships in a Sveltos release, the
chapters re-record against it.

Every drafted runner starts with a gate preflight: it creates a throwaway
record, waits for the approval gate to attach, and refuses in seconds if it
never does, instead of failing after the seven-minute fleet build.


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

One probe answers for every lane whether approval gates attach in your own
organization: `CUB_CONTEXT=my-policy npm run sveltos-gate:probe` wires a
throwaway record, watches for the gate, cleans up, and reports what it saw.
The patched
chart's digest and values fit can be checked any day with
`npm run sveltos-cve-patch-proof:verify-chart`, with no account or cluster.

Fleet proofs run serially against the organization, never in parallel. The
planning brief behind the chapters is
[sveltos-fleet-brief.md](../../planning/sveltos-fleet-brief.md).
