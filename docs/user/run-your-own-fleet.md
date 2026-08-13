# Run your own fleet on one record per cluster

This guide takes the shape the chapters record on the five-cluster reference
fleet and states it for a fleet of any size. Everything here comes from a
committed receipt or a measured lesson in this repository; where something is
not built yet, the guide says so and links the issue.

## The shape

One ConfigHub record per Sveltos cluster, including the management cluster,
and one base that reaches no cluster.

- **The base** holds what every cluster shares: one Space, one
  `clusterprofile` record, a selector that matches no registered cluster, no
  target, never published. A change to the fleet is made once, here.
- **One variant record per workload cluster.** Each is cloned from the base
  and departs from it in the fields that make it that cluster's record: its
  `metadata.name`, the selector line that addresses exactly one cluster
  (`spec.clusterSelector.matchLabels.cluster`), and its
  `spec.stopMatchingBehavior`. Keep departures out of fields the base
  rewrites: chart values live in one string field, and a values departure
  would be silently swallowed by the next inherited change (this repository's
  collision guard refuses that arrangement; copy it).
- **The management record** holds one bootstrap `ClusterProfile` per workload
  Space, each pointing at that Space on the ConfigHub OCI gateway. Its first
  revision is applied out of band with kubectl, because it is what enables
  gateway fetching. ConfigHub governs every revision after that under the
  same approval gate. The seam is honest and the receipts state it.

Labels carry the grouping that selectors used to carry. Each record is
labeled with its cluster and its environment, so a wave is a query over
records, not a delivery-time match over clusters.

## What a change looks like, at any fleet size

1. Edit the base once. Review it there.
2. For each wave, select the records with a label query and upgrade the set
   in one operation:
   `cub unit update --patch --space "*" --where <query> --upgrade`.
3. Approve the set in one operation:
   `cub unit approve --space "*" --where <query> --revision HeadRevisionNum`.
   ConfigHub records one approval per record, each bound to the revision
   that record held.
4. Publish each record's release. The gateway tag moves, and each addressed
   cluster follows. Sveltos keeps it converged and repairs drift.

Two disciplines make this safe at N clusters, and the runners here enforce
both. Assert that the matched set equals the wave you intended, and refuse
both an empty match and an over-broad one. And check the collision guard
after every upgrade, so a departure never shares a field with the change
flowing down.

## Growing from five to fifty

What grows linearly is records and approvals, and that is the product, not
the overhead: every one of them is an answer to "what is running on that
cluster and who agreed to it". What stays constant is the work per change:
one base edit, one query, one upgrade command, and one approval command per
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
  gzip fix: `projectsveltos/addon-controller:v1.13.0-ch` until it ships in a
  release. Stock v1.13.0 fails with "failed to decode k8s resource" on the
  same profile. Every receipt records the image its run used.
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

## What keeps this true

One check, part of `npm run verify` and CI, reads every committed
`ClusterProfile` and refuses a selector that could match more than one
cluster. The files recorded before the model are listed inside the check,
next to the issues that rework them, and fixing one means removing it from
the list in the same change. That is the whole mechanism.

Before a live run, update cub; the runners were measured against v0.2.15
and newer, and each one still checks its own preconditions and stops with a
named reason.

## What is not built yet

- Chapters one and two still record the older one-profile shape; their
  per-cluster re-record is
  [#4](https://github.com/confighub/sveltos-confighub/issues/4).
- Evidence-gated advance (the next wave refusing to start until the
  previous one is observed healthy) is designed, not built:
  [#2](https://github.com/confighub/sveltos-confighub/issues/2).
- The record machinery clones by hand what `cub variant create` and
  `cub variant promote` now do natively; adopting them is
  [#5](https://github.com/confighub/sveltos-confighub/issues/5).

Nothing in this guide depends on those landing, and the receipts say which
shape each chapter recorded.
