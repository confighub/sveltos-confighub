# Run your own fleet on one variant per cluster

This guide takes the shape the chapters record on the five-cluster reference
fleet and states it for a fleet of any size. Everything here comes from a
committed receipt or a measured lesson in this repository; where something is
not built yet, the guide says so and links the issue.

## The shape

One ConfigHub variant per Sveltos cluster, including the management cluster,
and one base that reaches no cluster.

- **The base** holds what every cluster shares: one Space, one
  `clusterprofile` record, an empty clusterRefs list that names no cluster,
  no target, never published. A change to the fleet is made once, here.
- **One variant record per workload cluster.** Each is cloned from the base
  and departs from it in the fields that make it that cluster's own: its
  `metadata.name`, the clusterRefs entry that names exactly one cluster
  (`spec.clusterRefs`, one `SveltosCluster` reference), and its
  `spec.stopMatchingBehavior`. Keep departures out of fields the base
  rewrites: chart values live in one string field, and a values departure
  would be silently swallowed by the next inherited change (this repository's
  collision guard refuses that arrangement; copy it).
- **The management record** holds one bootstrap `ClusterProfile` per workload
  Space, each pointing at that Space on the ConfigHub OCI gateway. Its first
  revision is applied out of band with kubectl, because it is what enables
  gateway fetching. ConfigHub governs every revision after that under the
  same approval gate. The seam is honest and the receipts state it.

Labels carry the grouping, and the address is structural. Each record is
labeled with its cluster and its environment, so a wave is a query over
records; the record's clusterRefs entry names its cluster in Sveltos's own
API, so nothing is resolved by label at delivery time.

## What a change looks like, at any fleet size

1. Edit the base once. Review it there.
2. Move the change into the wave's records in one operation. Chapter three's
   runner does this with a ConfigHub ChangeWorkflow: one ChangeOrder,
   created after the edit, captures it, and each wave promotes it into one
   stage, `cub variant promote --change-order <base-space>/<change-order> --target-stage <stage>`.
   ConfigHub enforces the order on the server and refuses a stage until the
   stage ahead has released the change. That design awaits its live
   re-record. The recorded chapters four and five upgrade the wave's set
   instead, `cub unit update --patch --space "*" --where <query> --upgrade`,
   and leave the order to the runner.
3. Approve the set in one operation:
   `cub unit approve --space "*" --where <query> --revision HeadRevisionNum`.
   ConfigHub records one approval per record, each bound to the revision
   that record held.
4. Publish each record's release. The gateway tag moves, and each addressed
   cluster follows. Sveltos keeps it converged and repairs drift. Under a
   change order, publish where the change arrived,
   `cub release publish <space> --revision ChangeOrder:<change-order>`,
   because that release is what the next stage's gate reads.

Two disciplines make this safe at N clusters, and the runners here enforce
both. Assert that the matched set equals the wave you intended, and refuse
both an empty match and an over-broad one. And check the collision guard
after every promotion, so a departure never shares a field with the change
flowing down.

## Growing from five to fifty

What grows linearly is records and approvals, and that is the product, not
the overhead: every one of them is an answer to "what is running on that
cluster and who agreed to it". What stays constant is the work per change:
one base edit, one query, one promotion or upgrade command, and one approval
command per wave, whatever the wave's size.

**Adding a cluster** is four steps: register it with Sveltos and label it,
clone its variant record from the base with its three departures, add its
bootstrap profile to the management record (a governed revision like any
other), then approve and publish its baseline. Nothing else in the fleet
changes.

**Removing a cluster** is a decision you already recorded:
`stopMatchingBehavior` says whether its add-ons are withdrawn or left in
place when the record stops matching. The reference fleet keeps
`WithdrawPolicies` on pilot and staging and `LeavePolicies` on production,
so a production record can never take its cluster's add-ons down as a side
effect.

## Limits measured on the way here

These were each paid for once so you do not have to.

- **Check the Link quota before a fleet build, not just the Unit quota.**
  Every variant costs an upgrade Link. A fleet build on an organization at
  its Link cap fails mid-build with HTTP 403 after the clusters are already
  up.
- **Space slugs must be lowercase** to be addressable on the gateway. OCI
  repository names do not admit uppercase, so an uppercase run stamp makes a
  Space unpublishable.
- **The gateway serves gzipped layers**, so the addon controller needs the
  gzip fix. Stock v1.13.0 fails with "failed to decode k8s resource" on the
  same profile, which is why every gateway recording so far ran the
  `projectsveltos/addon-controller:v1.13.0-ch` build. The fix shipped in
  Sveltos v1.14.0, and chapter three now pins the released v1.15.0 and runs
  its stock controller; its re-record will be the first on a released
  controller. Every receipt records the image its run used.
- **The gateway auth secret must be typed** `addons.projectsveltos.io/cluster-profile`
  with the token under the `token` key; an Opaque secret is rejected. The
  ORAS client is HTTPS-only.
- **A Space serves from the gateway only with a release target set and a
  release published.** Until both exist the gateway answers with an error,
  which is the correct inert state for an unapproved record.
- **Run fleet proofs serially.** Concurrent live lanes starve shared
  clusters and quotas and produce false blocks.
- **Delete cleanup Spaces in dependency order.** A Space whose Target other
  Spaces reference must outlive them, or the survivors are stuck with
  dangling references.

## The exact commands, mapped

The runners are the reference implementation, and every recorded run's
receipt records the commands it used, so nothing here can silently drift:
when in doubt, read `governedRecords` in `scripts/lib/per-cluster-fleet.mjs`
(the record machinery every chapter shares) and any
`runs/*/receipt.yaml`. The moves, in the order a fleet uses them:

1. **Create the base**: one Space wired to your approval trigger filter,
   holding one `clusterprofile` record with the shared content. The base
   gets no target and is never published. To promote through a
   ChangeWorkflow, first create a Component entity,
   `cub component create <component>`, and attach the base to it with
   `cub space create <base-space> --component <component>` (or
   `cub space update <base-space> --component <component>`). A `Component`
   label alone is not enough: a change order under a workflow is refused
   while its Space has no component. Chapter three names the component for
   its run, because a change order is headed for every Space attached to the
   component, and a component shared across runs would put an earlier run's
   kept variants in its scope. It gives the management Space a run-scoped
   component of its own, so that Space never sits in a change order's scope.
2. **Clone a cluster's variant**: `cub variant create <cluster> <base-space>`
   clones the base Space and its record in one operation, links the clone to
   its upstream, and copies the approval wiring. The variant name is the
   cluster, which reads exactly like the model. Pin the new Space's slug with
   `--space-pattern` (the gateway serves lowercase names only), then write
   the clone's three departures (name, address line, removal behaviour).
   Add `--stage <environment>` to label the variant's Space with the
   workflow stage that selects it; the clone inherits the base's component.
3. **Declare the stages**: one workflow per run, held in the base Space,
   `cub changeworkflow create --space <base-space> <workflow> --stage pilot --stage staging --stage prod --prerequisites Released`.
   A stage selects the Spaces of the change order's component labelled
   `Stage=<stage>`, and a stage's gates are checked over every Space of the
   stage ahead. Chapter three declares `Released` and not `Healthy`: the
   `Healthy` gate reads a live-status annotation nothing writes for a
   Sveltos-delivered Space yet
   ([#33](https://github.com/confighub/sveltos-confighub/issues/33),
   confighubai/confighub#5049).
4. **Name the cluster's destination**: a Target needs a BridgeWorker that
   has run and announced support for its ConfigType, and workers are
   space-scoped, so mint each cluster's named Target in your
   infrastructure Space against its registered OCI-capable worker:
   `cub target create <cluster> '{}' <worker> --space <infra-space> --provider OCI --toolchain Any --allow-exists`,
   then set it as the variant Space's release target and the record's
   target (the reference crosses Spaces, which is the long-standing
   pattern). `--allow-exists` keeps each cluster's Target stable across
   runs: one cluster, one destination identity. One Target per cluster,
   named for it, is what lets ConfigHub's own model answer which cluster a
   variant ships to, rather than a selector line inside the stored YAML.
   The base Space gets no Target and no release target, because the base
   ships nowhere. Check the Target quota before a fleet build, the same
   lesson as Links.
5. **Capture the change**: edit the base, then create the change order under
   the workflow,
   `cub changeorder create --space <base-space> <change-order> --change-workflow <base-space>/<workflow> --description "<what changed>"`.
   Created after the edit, it captures exactly that edit as the change. Read
   it back and check that its scope is the base and its variants and
   nothing else.
6. **Select a wave as a set**: `cub unit list --space "*" --where "<query
   over your record labels>"`, and assert the match equals exactly the wave
   you intended before acting on it. Under a workflow, also check that the
   stage selects exactly those variants.
7. **Promote the wave in one operation**:
   `cub variant promote --change-order <base-space>/<change-order> --target-stage <stage>`
   moves exactly the change into every variant the stage selects, and
   ConfigHub refuses it while any variant of the stage ahead has taken the
   change without releasing it. Chapter three asks for a skipped stage once,
   before its first wave, and records the refusal as evidence. The recorded
   chapters four and five upgrade the set instead,
   `cub unit update --patch --space "*" --where <query> --upgrade`.
8. **Approve the set in one operation**:
   `cub unit approve --space "*" --where <query> --revision HeadRevisionNum`.
   ConfigHub records one approval per record, each bound to that record's
   revision. `cub variant approve` records approvals of a change order in a
   stage, but chapter three keeps the set approval, because
   `cub variant approve` is not yet shown to clear the approval gate.
9. **Publish each record's release**: `cub release publish <space>`, or,
   under a change order,
   `cub release publish <space> --revision ChangeOrder:<change-order>`,
   which bundles each unit where the change arrived and is what the next
   stage's `Released` gate reads. The gateway serves it at
   `oci://oci.hub.confighub.com/space/<space>:latest`, and publishing is what
   moves the tag the fleet follows.
10. **Let Sveltos fetch**: the management cluster carries a Secret of type
    `addons.projectsveltos.io/cluster-profile` holding a `cub auth get-token`
    token, and one bootstrap ClusterProfile per workload Space pointing at
    that Space's gateway address.
11. **Restore and hold when you need to**:
    `cub unit update --space <space> <unit> --restore <revision>` writes an
    exact earlier revision as a new head, the approval gate arms on it like
    on any other revision, and publish is refused until the restore itself
    is approved. Holding a cluster back is the absence of one approval: its
    variant rides the same set upgrade as the rest of the fleet and is
    simply not approved, so Sveltos keeps serving the last approved
    release. [The held cluster](../../examples/sveltos/held-cluster/README.md)
    records both moves.

## What keeps this true

One check, part of `npm run verify` and CI, reads every committed
`ClusterProfile` and refuses one that could address more than one cluster:
no clusterSelector at all, and at most one clusterRefs entry naming a
SveltosCluster. The only files listed as exempt inside the check are the
rehearsal's, which have no ConfigHub records behind them, and shrinking or
growing that list is refused unless the files change in the same change.
That is the whole mechanism.

Before a live run, update cub; the runners were measured against v0.2.15
and newer, chapter three's ChangeWorkflow verbs were probed live against
v0.6.2, and each runner still checks its own preconditions and stops with a
named reason.

## What still waits

Every chapter is recorded live on the design this guide describes: one
variant per cluster over the gateway, waves unlocked by checkpoint evidence.
Chapter three's runner has since moved its waves onto ConfigHub
ChangeWorkflows, and that design awaits its live re-record. Its `Healthy`
gate waits on a Sveltos status reporter
([#33](https://github.com/confighub/sveltos-confighub/issues/33)) and on
ConfigHub recognising the provider (confighubai/confighub#5049).
The gzip fix the recordings needed has shipped in a Sveltos release
([#2](https://github.com/confighub/sveltos-confighub/issues/2)): chapter
three now pins the released v1.15.0 and re-records on it together with its
ChangeWorkflows. The other chapters still pin v1.13.0, and their recordings
name the gzip-capable v1.13.0-ch build until they re-record on a release.
