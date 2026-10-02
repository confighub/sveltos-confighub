# Run your own fleet on one variant per cluster

This guide takes the shape the chapters record on the five-cluster reference
fleet and states it for a fleet of any size. Everything here comes from a
committed receipt or a measured lesson in this repository; where something is
not built yet, the guide says so and links the issue.

Already running Sveltos? You do not have to build this shape by hand:
[Onboard your Sveltos fleet](onboard-your-sveltos-fleet.md) reads your
ClusterProfiles and SveltosClusters and writes it for you.

**Which design this describes.** The chapters record the first design:
- each variant holds a Sveltos ClusterProfile, with a chart's settings as a
  Helm values string;
- Sveltos installs the chart with Helm.

`cub sveltos` from v0.5 builds the same shape one level down:
- each variant holds the objects the charts render to;
- one delivery profile per variant delivers them.

What follows about the shape, stages, approvals, cost at scale and joining
holds for both. Where it names a ClusterProfile as the unit, read the
rendered objects for a fleet onboarded today. [What's new in
0.5](../whats-new.md) says what changed.

If you keep one Git repository per cluster, you already have the variants;
what they lack is inheritance. A fix to shared configuration then means an
edit in every repository. Here the fix is made once, on the base, and every
variant takes it while keeping its own departures, and each cluster's copy
still ships only when it is approved for that cluster.

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
  `spec.stopMatchingBehavior`. Keep departures out of settings the base
  changes: when the base changes a setting a variant overrides, the base's
  value replaces the override and the promotion reports nothing, even inside
  the chart's values string (measured 2026-09-27). This repository's
  collision guard refuses that arrangement before a run; copy it.
- **The management record** holds one bootstrap `ClusterProfile` per workload
  Space, each pointing at that Space on the ConfigHub OCI gateway. Its first
  revision is applied out of band with kubectl, because it is what enables
  gateway fetching. Its approval is recorded as an attestation like any
  other, but since no release of it is published, no release gate reads that
  approval. The seam is honest and the receipts state it.

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
   stage ahead has released the change; chapter three's receipt records
   that refusal live. The recorded chapters four and five upgraded the
   wave's set instead,
   `cub unit update --patch --space "*" --where <query> --upgrade`, and left
   the order to the runner.
3. Approve the change as it stands in the stage, in one operation:
   `cub variant approve --change-order <base-space>/<change-order> --stage <stage>`.
   ConfigHub records an Approval attestation on each record's exact
   revision. It changes nothing it approves, and a later revision with
   different content is not covered by it. The workflow's
   `ReleasePrerequisites` are what make the approval required: until it is
   recorded, a release of the change into the stage is refused with
   HTTP 422.
4. Publish each record's release where the change arrived,
   `cub release publish <space> --revision ChangeOrder:<change-order>`. The
   gateway tag moves, and each addressed cluster follows. Sveltos keeps it
   converged and repairs drift. That release is also what the next stage's
   `Released` gate reads.

Mind separation of duties. ConfigHub counts whoever promoted a change into a
Space as one of its authors there, and by default an author's approval does
not count, so the approver has to be someone other than the promoter. That
is what a production workflow should keep. This repository's runs are
single-operator, so its reviewed workflow sets `AllowAuthors: true` on the
approval requirement, and every receipt says plainly that the demo relaxes
separation of duties.

Two disciplines make this safe at N clusters, and the runners here enforce
both. Assert that the matched set equals the wave you intended, and refuse
both an empty match and an over-broad one. And check the collision guard
after every promotion, so a departure never shares a field with the change
flowing down.

## Growing from five to fifty

What grows linearly is records and approvals, and that is the product, not
the overhead: every one of them is an answer to "what is running on that
cluster and who agreed to it". What stays constant is the work per change:
one base edit, one query, one promotion command, and one approval command per
wave, whatever the wave's size.

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
  same profile, which is why the gateway recordings before the fix shipped
  ran the `projectsveltos/addon-controller:v1.13.0-ch` build. The fix
  shipped in Sveltos v1.14.0, and chapter three is recorded on the released
  v1.15.0 with its stock controller and no override. Every receipt records
  the image its run used.
- **The gateway auth secret must be typed** `addons.projectsveltos.io/cluster-profile`;
  an Opaque secret is rejected. The ORAS client is HTTPS-only. For a fleet
  that runs longer than a day, put the Targets' server worker in it, its ID
  under `username` and its secret under `password`: the gateway lets a
  Target's own worker pull that Target's releases, and the credential does
  not expire (measured on 2026-09-26 with Sveltos v1.15.0). A `cub auth
  get-token` login token under `token` also works, which is what the chapter
  runs use, but it expires within a day. Give each worker its own Secret:
  the gateway refuses a worker that is not the Target's own with 403.
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

1. **Create the base**: one Space wired to your trigger filter for its
   validating checks (schema, placeholders, and the rest of the catalog's),
   holding one `clusterprofile` record with the shared content. The filter
   carries no approval trigger: ConfigHub removed the `vet-approvedby`
   function on 2026-09-25, and approval is required by the workflow instead
   (step 3). The base
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
   its upstream, and copies the trigger wiring. The variant name is the
   cluster, which reads exactly like the model. Pin the new Space's slug with
   `--space-pattern` (the gateway serves lowercase names only), then write
   the clone's three departures (name, address line, removal behaviour).
   Add `--stage <environment>` to label the variant's Space with the
   workflow stage that selects it; the clone inherits the base's component.
3. **Declare the stages and the approval they require**: one workflow per
   run, held in the base Space, written in a file because the flags cannot
   carry a stage's release gate,
   `cub changeworkflow create --space <base-space> <workflow> --filename change-workflow.yaml`.
   Chapter three's reviewed
   [file](../../examples/sveltos/env-rollout/change-workflow.yaml) declares
   one requirement, `approval`: one `Approval` attestation. Every stage
   names it in `ReleasePrerequisites`, which ConfigHub evaluates over the
   revisions a release bundles when a release of a change order is
   published into the stage. Staging and prod also name `Released` in
   `Prerequisites`, their entry gate, evaluated over every Space of the stage
   ahead. A stage selects the Spaces of the change order's component
   labelled `Stage=<stage>`. The requirement's `AllowAuthors` decides
   whether whoever promoted the change may approve it: keep it `false` in
   production, with a second approver; chapter three sets it `true` because
   its runs are single-operator, and says so. Chapter three declares
   `Released` and not `Healthy`: the `Healthy` gate reads a live-status
   annotation nothing writes for a Sveltos-delivered Space yet
   ([#33](https://github.com/confighub/sveltos-confighub/issues/33),
   confighubai/confighub#5049). You can then declare the workflow required
   on the component,
   `cub component update --patch <component> --change-workflow-required --allowed-change-workflow <base-space>/<workflow>`;
   measured on 2026-09-26, ConfigHub records that but does not yet refuse a
   plain publish outside a change order, so send every release through one
   yourself.
4. **Name the cluster's destination**: mint each cluster's named Target in
   your infrastructure Space, and grant the identity Sveltos pulls with View
   and ViewChildren on it:
   `cub target create <cluster> --space <infra-space> --permission View:<bot user> --permission ViewChildren:<bot user> --allow-exists`.
   That is the form since `cub` v0.7.0. The recorded chapters were made
   before it, when a Target was created against a worker
   (`cub target create <cluster> '{}' <worker> --provider OCI --toolchain Any`),
   and their live runners still use that form. Then set it as the variant Space's release target and the record's
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
   nothing else. A fleet's first release goes the same way: chapter three
   creates a change order with no edit before it, whose promotion marks each
   variant where it stands, so the baseline passes the approval gate too.
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
   chapters four and five upgraded the set instead,
   `cub unit update --patch --space "*" --where <query> --upgrade`. With a
   level between the base and the variants, such as class bases, add
   `--squash`, so a change a class protects against does not reach its
   clusters by replay; [Onboard your Sveltos fleet](onboard-your-sveltos-fleet.md#making-a-change-afterwards)
   says why.
8. **Approve the change in the stage, in one operation**:
   `cub variant approve --change-order <base-space>/<change-order> --stage <stage>`
   records an Approval attestation on the revision the change order's end
   tag marks in every Space of the stage. It cuts no revision, and it covers
   only that exact content. Chapter three first attempts the release and
   records ConfigHub's refusal (HTTP 422, `requires approval: 1 Approval
   attestation(s) from eligible attesters; <unit> revision <n> has 0 of 1`)
   as the stage's gate observation, then approves. A record no release gate
   reads, such as the management record, is approved with
   `cub variant approve <space>`, which covers the head of each unit with a
   Target. The per-unit `cub unit approve` no longer exists.
9. **Publish each record's release** where the change arrived:
   `cub release publish <space> --revision ChangeOrder:<change-order>`
   bundles each unit where the change arrived, passes the stage's release
   gate once the approval is recorded, and is what the next stage's
   `Released` gate reads. A plain `cub release publish <space>` bundles each
   unit at its head and is not gated by the workflow. The gateway serves the
   release at `oci://oci.hub.confighub.com/space/<space>:latest`, and
   publishing is what moves the tag the fleet follows.
10. **Let Sveltos fetch**: the management cluster carries a Secret of type
    `addons.projectsveltos.io/cluster-profile` holding the Targets' server
    worker as `username` and `password` (a credential that does not expire),
    and one bootstrap ClusterProfile per workload Space pointing at that
    Space's gateway address. [Onboard your Sveltos fleet](onboard-your-sveltos-fleet.md)
    writes both for you.
11. **Restore and hold when you need to**:
    `cub unit update --space <space> <unit> --restore <revision>` writes an
    exact earlier revision as a new head. Holding a cluster back is the
    absence of one approval, so Sveltos keeps serving the last approved
    release. [The held cluster](../../examples/sveltos/held-cluster/README.md)
    recorded both moves under the trigger-based gate ConfigHub has since
    removed, where the gate armed on the restored head and publish was
    refused until the restore was approved; its lane moves to attestations
    next.

## What keeps this true

One check, part of `npm run verify` and CI, reads every committed
`ClusterProfile` and refuses one that could address more than one cluster:
no clusterSelector at all, and at most one clusterRefs entry naming a
SveltosCluster. The only files listed as exempt inside the check are the
rehearsal's, which have no ConfigHub records behind them, and shrinking or
growing that list is refused unless the files change in the same change.
That is the whole mechanism.

Before a live run, update cub; the runners were measured against v0.2.15
and newer, chapter three's ChangeWorkflow and attestation verbs were probed
live against v0.6.2, and each runner still checks its own preconditions and
stops with a named reason.

## What still waits

Every chapter is recorded live on the design this guide describes: one
variant per cluster over the gateway, waves unlocked by checkpoint evidence.
Chapter three is recorded on ConfigHub ChangeWorkflows, with approvals as
attestations, on the released Sveltos v1.15.0 (2026-09-26). The other
chapters' recordings approved through the trigger-based gate ConfigHub
removed on 2026-09-25, and their live lanes are still written against it, so
each stops before building anything until it moves too
([#34](https://github.com/confighub/sveltos-confighub/issues/34)). Chapter
three's `Healthy` gate waits on a Sveltos status reporter
([#33](https://github.com/confighub/sveltos-confighub/issues/33)) and on
ConfigHub recognising the provider (confighubai/confighub#5049).
The gzip fix the earlier recordings needed has shipped in a Sveltos release
([#2](https://github.com/confighub/sveltos-confighub/issues/2)), and chapter
three runs it. The other chapters still pin v1.13.0, and their recordings
name the gzip-capable v1.13.0-ch build until they re-record on a release.
