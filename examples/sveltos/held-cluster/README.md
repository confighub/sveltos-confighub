# Sveltos held cluster

This chapter records the claim the previous five deliberately did not make:
one production cluster brought back to an exact earlier revision, under the
same approval gate every forward change passes, and then held at that revision
on purpose while the rest of the fleet advances. The fleet ends at three
different points, and every one of them is a recorded fact rather than drift.

[Sveltos](https://projectsveltos.io) still does every piece of cluster work:
the management cluster fetches each approved release from the ConfigHub OCI
gateway and reconciles the workload clusters. ConfigHub still holds the
records, the approvals, and the releases. Nothing else takes part. The fleet,
the Sveltos pin, and the addon-controller requirement are the environment
rollout chapter's, unchanged.

## Why this chapter exists

The root of this repository says plainly that rollback here "restores one
target to an exact revision, which is a different thing" from a fleet-wide
undo, and until now no chapter had demonstrated it. The claim here is not
that a change can be rolled out. Chapter three records that. The claim is
that going back is governed exactly like going forward: the restore is a
revision, the gate attaches to it, a person approves those exact bytes, and
the twin cluster that was not having a problem does not move. And that
holding a cluster afterwards needs no feature at all.

## What this continues

This chapter creates no clusters and no records. It operates on the
environment rollout chapter's live cohort, discovered from its
[committed receipt](../../../runs/sveltos-env-rollout-proof/receipt.yaml),
because restoring to an earlier revision only means something when that
revision exists in a record with history. The
[continuation note](continuation.yaml) states this; the runner refuses to run
against anything else.

## See the result

Read the [summary](../../../data/sveltos-held-cluster/summary.md) and the
[receipt](../../../runs/sveltos-held-cluster-proof/receipt.yaml). The receipt
records the advance, the refused-then-approved restore, the held advance, and
a closing audit naming each cluster's revision, released digest, and observed
state.

## How it works

The [change candidate](change-candidate.yaml) makes two reviewed edits to the
shared base, both promoted with the environment rollout chapter's own wave
mechanics: `backgroundController.replicas` from 2 to 3, and later from 3
to 4. The first advance carries all four clusters and exists so the restore
has something real to come back from.

The [restore candidate](restore-candidate.yaml) then brings `prod-a` back.
The mechanism is `cub unit update --restore <revision>` against the variant's
own Space, naming the exact revision recorded before the advance. That
restore is a revision like any other: the approval gate attaches, `cub
release publish` is refused while it stands, and the receipt records the
refusal before it records the approval. After approval and publish, Sveltos
fetches the older digest from the gateway and `prod-a` returns to the
restored configuration while `prod-b` stays on the newer release.

## The hold is not a feature

The second advance upgrades every variant, including the held cluster's.
Then pilot, staging, and `prod-b` are approved and published, and `prod-a`
is not. That is the whole mechanism. The gate that refuses an unapproved
release is the hold, the variant's gate state is the evidence, and releasing
the hold later is one approval and one publish. Nothing was added to the
model to make this possible.

## What this costs

The restore and the hold are each one more approval a person must give, and
the audit is one more pass over the fleet. That is the trade taken
deliberately: a cluster that differs from its fleet differs as a set of
recorded, attributable decisions, not as archaeology.

## Current status

Recorded live on the gateway on 2026-08-21, continuing the
environment-rollout cohort recorded the same day. The
[committed receipt](../../../runs/sveltos-held-cluster-proof/receipt.yaml)
carries the restore command, the refused publish, the recorded approval, and
the closing audit with the fleet at three points on purpose. The runner's
offline checks remain fixture-based (`--self-test` exercises the
restore-selection and audit logic against fixtures rather than a fake hub, a
deliberate first increment).

## Repeat and verify

Offline, a few seconds each:

```bash
npm run sveltos-held-cluster-proof:self-test
npm run sveltos-held-cluster-proof:verify
```

The live run continues the newest environment-rollout cohort and runs
serially against the organization, never in parallel:

```bash
# Requires the environment-rollout fleet standing (its receipt names it).
CUB_CONTEXT=my-policy \
HELM_EXPT_ALLOW_LIVE_SVELTOS_HELD_CLUSTER=1 \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-held-cluster-proof:run

# Refresh the generated surfaces from the committed receipt.
npm run sveltos-held-cluster-proof:generate
```
