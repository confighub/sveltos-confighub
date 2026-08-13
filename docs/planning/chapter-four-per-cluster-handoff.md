# Finishing chapter four

Chapter three holds its fleet as one base record plus one variant per cluster,
five clusters and five records including the management cluster, and it is
recorded live. Chapter four is most of the way to the same shape on the branch
`chapter-four-per-cluster`. Chapter five has not been started.

Work in `~/code/sveltos-confighub-work`. The `main` branch is green at eighteen
lanes and must stay that way, so keep this work on its branch until it passes.

## What is already done

The per-cluster machinery lives in `scripts/lib/per-cluster-fleet.mjs` and both
chapters call it. It creates a governed Space, stores a base, clones a variant
and writes its departures, checks the upstream lineage survived, selects a wave
as a set, approves that set in one operation, publishes each release, builds the
management record, and refuses a promotion that did not inherit the change.

For chapter four specifically:

- `examples/sveltos/cve-patch/clusterprofile-base.yaml` and `variants.yaml`
  replace the three per-environment profiles, which are deleted.
- `patch-candidate.yaml` declares waves by cluster and carries the set query.
- `loadPatchPlan` builds a base and four variants, refusing a departure that
  collides with the version field.
- The matrix generator compiles per cluster and passes its own self-test,
  including the retargeted tamper tests.
- `--verify` recognises the committed receipt as superseded, because it records
  three environment records and predates this design.
- The run flow and the self-test walk are written against base and variants.

## The one thing left before it runs

Chapter four's fake ConfigHub still has the simple `unit update` handler. It
needs the branch chapter three uses, which understands
`unit update --patch --space "*" --where <query> --upgrade`. That is how a wave
inherits the version bump from the base, so without it the self-test stops at
wave one with `unit */undefined not found`.

Take the handler from `scripts/run-sveltos-env-rollout-proof.mjs`. Everything it
depends on is already ported into chapter four's fake: cloning from an upstream
unit, the label-conjunction query evaluator, set-aware approval, revision
history, `projectUnit`, `store` and `dataOf`.

After that, run `node scripts/run-sveltos-cve-patch-proof.mjs --self-test` and
fix what it names, then `npm run verify`, then record live.

## Recording it live

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_CVE_PATCH=1 HELM_EXPT_KEEP_SVELTOS_ARTIFACTS=1 \
CUB_CONTEXT=<your-context> \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-cve-patch-proof:run
```

Check the context lands in the organization that owns the approval policy, and
that its token has not expired. A run builds five kind clusters and takes about
twelve minutes. Delete the clusters and Spaces from a failed run before
retrying, because stale kind clusters starve the next one.

## Traps already paid for

A variant stored in a different serialisation from its base loses its upstream
lineage. ConfigHub records the base resource as deleted and a different one
added, the variant then inherits nothing, and every later promotion is a no-op
that still reports success. Stored documents are written as YAML for this
reason, and the lineage is checked as soon as the departures land. Ask ConfigHub
which case you are in:

```bash
cub unit get --space <variant-space> clusterprofile -o mutations
```

A healthy variant lists one resource with field-level updates. A severed one
lists the base resource deleted and a different one added.

The management record publishes no release, because it holds the bootstrap
profiles that let the management cluster reach the gateway at all.

A release publish can arrive while an apply gate is still queued. The server
says the triggers were re-queued, which is a race worth waiting out. Any other
gate message is a refusal and must stop the run.

Every Space needs `Component` and `Owner` labels or it is invisible in the
ConfigHub component view, which is the one view that shows a base and its
variants together.

Do not move the shared fleet example files into their own directory. It was
tried and reverted, because the committed receipts record the paths they read,
so moving those files makes a receipt of a real run fail its own source check.

## After chapter four

Chapter five needs the same treatment, and it is the same shape of work. Its
change-it-once claim and its zero-drift audit both get stronger over five
records than three.

## One open question worth raising separately

The ConfigHub component view shows "Not reported yet" against every card in this
example. That is not a missing connection. Live status is published by a
recognised reporter, and `ui/src/pages/x/apps/liveStatus.ts` defines exactly
two:

```ts
export type LiveStatusProvider = 'argocd' | 'flux' | 'unknown';
```

Sveltos is not one of them, so its status has nowhere to go even though Sveltos
knows the answer and publishes it as a `ClusterSummary` per cluster per profile.
Adding Sveltos as a third provider is the native fix and would light up this
example without changing who delivers.
