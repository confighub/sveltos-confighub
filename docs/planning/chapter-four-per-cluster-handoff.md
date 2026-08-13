# Chapters four and five: reworked, verified, awaiting their live recordings

Chapters four and five both hold their fleet the way chapter three does: one
base record plus one variant per cluster, five records including the
management cluster. The branch `chapter-four-per-cluster` carries both
reworks and `npm run verify` is green on it at eighteen lanes. Neither
chapter has been recorded live on this design yet, and that is the only work
left.

## What was finished offline

Chapter four's fake ConfigHub gained the bulk patch handler, and everything
that still spoke the three-environment shape was moved to base plus
variants: the run flow, the wave promotion, the checkpoints and coverage
audit, the receipt, its verifier, the summary, and the tamper battery. The
registrations now carry each cluster's own `cluster` label, because a
variant's selector addresses one cluster by name and would otherwise match
nothing live.

Chapter five got the whole treatment in one pass: base and variants example
files replace the three per-environment profiles, the reviewed edit lands
once on the base and is approved there, and one set upgrade inherits it into
every variant in one operation. The zero-drift audit now also demands that
no record anywhere under the proof label carries an armed gate, which is why
the base's edited revision is approved rather than left pending.

Both committed receipts predate this design. They are recognised as
superseded, kept as recorded, and fill nothing; the verify lanes say so and
pass. The matrices compile per cluster with observed cells honestly awaiting
a live run.

## The one blocker

The `river-bear` context (the helm-catalog organization, which owns the
approval policy) has an expired token. `cub space list` under it fails with
"token is expired". Re-authenticate with `cub auth login` on river-bear,
then record chapter four, then chapter five:

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_CVE_PATCH=1 HELM_EXPT_KEEP_SVELTOS_ARTIFACTS=1 \
CUB_CONTEXT=river-bear \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-cve-patch-proof:run
```

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_BULK_OPS=1 HELM_EXPT_KEEP_SVELTOS_ARTIFACTS=1 \
CUB_CONTEXT=river-bear \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-bulk-ops-proof:run
```

Each run builds five kind clusters and takes about twelve minutes. Both
chapters now honor `HELM_EXPT_KEEP_SVELTOS_ARTIFACTS=1` the way chapter
three does, recording what was kept and how to remove it. After each run,
refresh the observed matrix columns:

```bash
npm run sveltos-cve-patch-proof:generate && npm run sveltos-cve-patch:generate
```

```bash
npm run sveltos-bulk-ops-proof:generate && npm run sveltos-bulk-ops:generate
```

## Traps already paid for

Everything in the previous version of this note still holds: stored
documents are written as YAML because a serialisation change severs a
variant's upstream lineage; the lineage is checked the moment departures
land (`cub unit get --space <variant-space> clusterprofile -o mutations` —
one resource with field-level updates is healthy, a delete-and-add pair is
severed); the management record publishes no release; a publish arriving
while an apply gate is still queued is a race to wait out, any other gate
message is a refusal; every Space needs `Component` and `Owner` labels to be
visible in the component view; and the shared fleet example files must not
move, because committed receipts record the paths they read.

New since then: chapter five's fan-out query selects `Labels.Wave = '1'` —
the whole fleet is one wave — and the base record's edit is approved on the
base so the audit's gate query finds nothing armed. Delete the clusters and
Spaces from a failed run before retrying, because stale kind clusters starve
the next one. Chapter three's five kept clusters and six Spaces
(`*-20260812195312`) are still up for screenshots and were left alone.

## One open question worth raising separately

The ConfigHub component view shows "Not reported yet" against every card in
this example. That is not a missing connection. Live status is published by
a recognised reporter, and `ui/src/pages/x/apps/liveStatus.ts` defines
exactly two:

```ts
export type LiveStatusProvider = 'argocd' | 'flux' | 'unknown';
```

Sveltos is not one of them, so its status has nowhere to go even though
Sveltos knows the answer and publishes it as a `ClusterSummary` per cluster
per profile. Adding Sveltos as a third provider is the native fix and would
light up this example without changing who delivers. Raise it with the
ConfigHub team on its own, not bundled into the Sveltos work.
