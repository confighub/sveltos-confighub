# Check every change against your policies

Your clusters already enforce policies with Kyverno when something is
applied. ConfigHub can run the same policies on a change before it ships, so
a change that breaks one never reaches a cluster, and every stage of a rollout
records that the check passed.

There are two ways to gate a rollout on a check, and they fail differently:

| | A policy trigger (`--policy`) | A required check (`--require PolicyCheck`) |
| --- | --- | --- |
| What runs the check | ConfigHub, on every change, through a worker | You or CI, with `cub sveltos check`, once per stage |
| A failing change | Carries ValidationErrors: it is not promoted past its stage, nor released | Carries a rejection: its release is refused until it is revoked |
| A check that has not run | Is not an error: the change can be released (measured below) | Blocks the release: nothing ships without a recorded Pass |
| Best for | Fast feedback on every edit, in ConfigHub and to AI assistants | The gate you rely on for production |

Use both: the trigger tells authors at once, and the requirement is the gate.

## What you need

- **A Kyverno that holds your policies and checks for ConfigHub.** Run it
  apart from the clusters' own Kyverno, for example on the management cluster
  in its own namespace:

  ```bash
  helm install policy-checker kyverno --repo https://kyverno.github.io/kyverno/ --version 3.8.2 \
    -n policy-checker --create-namespace --set admissionController.replicas=1 \
    --set backgroundController.enabled=false --set cleanupController.enabled=false --set reportsController.enabled=false
  kubectl apply -f your-policies/
  ```

  A cluster's own Kyverno ignores everything in its own namespace
  (`resourceFilters: [*/*,kyverno,*]`). Checked with a workload cluster's
  Kyverno, a change to the Kyverno chart itself always passed.

- **A worker that runs `vet-kyverno-server` against it.** In the cluster,
  follow ConfigHub's [admission webhook
  guide](https://docs.confighub.com/guide/admission-webhook-functions/). To
  try it from your laptop:

  ```bash
  cub worker create --space platform-policies kyverno-checker
  kubectl -n policy-checker port-forward svc/policy-checker-kyverno-svc 18443:443 &
  cub worker run --space platform-policies -f vet-kyverno-server \
    -e KYVERNO_URL=https://localhost:18443 -e KYVERNO_SKIP_TLS_VERIFY=true kyverno-checker
  ```

  The worker must be as new as your ConfigHub server. A worker two months
  older could not read the server's requests ("illegal base64 data").

## A policy trigger: every change is checked

Create the trigger in a Space of its own, in warn mode first, and a Filter
that selects it:

```bash
cub trigger create --space platform-policies --worker platform-policies/kyverno-checker --warn \
  kyverno Mutation Kubernetes/YAML vet-kyverno-server
cub filter create --space platform-policies policy-triggers Trigger --from-space platform-policies
```

Then plan with `--policy`:

```bash
cub sveltos apply onboard/profiles.yaml clusters.yaml <your options> --policy platform-policies/policy-triggers --out onboard
bash onboard/apply.sh
```

`apply.sh` gives every base, class base and variant the filter, and adds
`Validated` to each stage that has a stage ahead of it. On a fleet you
onboarded before, running it again adds the gates to the workflow. Gates and
stage settings you made in ConfigHub since are kept.

In warn mode a failing change gets a warning and nothing is held. That shows
you what the policy would stop. When nothing you mean to ship fails, enforce
it:

```bash
cub trigger update --space platform-policies --worker platform-policies/kyverno-checker --unwarn \
  kyverno Mutation Kubernetes/YAML vet-kyverno-server
```

A Space that uses a trigger from another Space does not see it change until
you refresh it: `cub space update --patch --refresh-triggers <space>`.

Each change is followed by the check. In the root unit's activity, every
change made by a person ("ConfigHub Invoke") is followed by an automated
function invocation, the Kyverno check (author names hidden):

![A unit's activity in ConfigHub: each change a person made, with its reason, followed by an automated function invocation that ran the Kyverno check](../images/sveltos/sveltos-unit-activity.png)

**Measured on the Meridian kind fleet.** A change at the root set the Kyverno
cleanup controller's image to `:latest`, which `disallow-latest-tag` forbids:

- The root carried the ValidationError at once, naming the rule and the
  object: `disallow-latest-tag/autogen-validate-image-tag` on
  `kyverno/kyverno-cleanup-controller`.
- Promotion into test was refused while the class bases held it:
  `unable to promote to stage 'test', Variant 'class-test' has ValidationErrors
  on the Revisions change order 'probe-latest-tag' marks: kyverno
  (mer-policies/kyverno/vet-kyverno-server)`.
- With no entry gate on test, the change reached test1 and was approved, but
  its release was refused: `HTTP 422: outstanding ValidationErrors; triggers
  re-queued for evaluation`. The cluster kept its image.

In ConfigHub, a rollout waiting on its gates. `check/validated` is the policy
gate on uat, which ConfigHub checks when you promote:

![A rollout in ConfigHub part-way through: test is promoted and released, uat is gated, and its gates list check/promoted and check/released as satisfied and check/validated, the policy gate](../images/sveltos/sveltos-rollout-gated.png)

The root unit's history keeps each change with the change order that carried
it, and marks the two that failed the policy (author names hidden):

![A unit's revisions in ConfigHub: thirteen revisions with their change-order tags, descriptions, author and validation errors; two probe revisions show one validation error each](../images/sveltos/sveltos-unit-revisions.png)

The Rollouts page lists the orders the policy stopped as closed, not promoted:

![ConfigHub's Rollouts page: one rollout needs a release, finished rollouts are complete, and aborted probe rollouts read closed, not promoted, blocked by the Kyverno policy](../images/sveltos/sveltos-rollouts-policy.png)

**Three things to know:**
- **An order keeps the gates it started with.** A change order copies its
  workflow when it is made, so loosening a gate does not free an order already
  under way.
- **An order carries only the changes made before it.** Make the change, then
  create the order. A fix made after the order's first promotion does not
  travel with it.
- **A held order is undone, not fixed.** Give it up with
  `cub changeorder update --patch --aborted-reason "..." <order>`, take it back
  out with `cub variant demote <space> --change-order <base>/<order>` where it
  reached, then fix the change and roll the fix out in a new order.

## When the checker is away

ConfigHub's documentation says a trigger whose worker is disconnected holds
changes with ValidationErrors. After its fail-open time, 6 hours unless set
with `--fail-open-after`, it disables the trigger, and changes go out
unchecked. This was measured on ConfigHub v0.6.5, with the trigger's fail-open
time set to 2 minutes and the worker stopped:

- **ConfigHub did not notice.** Twenty-five minutes later the worker still read
  `Ready`, its last-seen time frozen at the moment it stopped, and the trigger
  was never disabled. So the six-hour clock never started.
- **A change made in that window was never checked**, carried no error, and
  was released to test1. uat's `Validated` gate let it through as well. Both
  gates read a missing result as a pass.
- **When the worker came back, nothing re-checked it.** Revisions made while
  it was away stay unchecked until they change again, or until you run
  `cub space update --patch --refresh-triggers <space>`.

So a policy trigger alone can let changes through, sooner than six hours.
Treat it as feedback, and gate releases on a required check. This is reported
to ConfigHub as confighubai/confighub#5530.

## A required check: nothing ships without a Pass

This uses ConfigHub's attestation requirements (confighubai/confighub#5476).
Plan with `--require`:

```bash
cub sveltos apply onboard/profiles.yaml clusters.yaml <your options> --require PolicyCheck --out onboard
```

Each stage's release now waits for a PolicyCheck attestation as well as the
approval. Record one with `cub sveltos check`, after promoting into a stage:

```bash
cub sveltos check --change-order sveltos-kyverno-base/cost-center --stage test \
  --worker platform-policies/kyverno-checker vet-kyverno-server
```

```
mer-kyverno-eu-central-test1: passed kyverno/10; recorded a Pass (dae879e6-f5bf-453a-ad41-bc5678096878)
```

For each variant the order has reached in the stage, it checks exactly the
revisions the order marks there. Then it records a Pass, or a rejection that
holds the release until someone revokes it. It exits non-zero on a failure,
so CI can run it.

**Measured.** Approved but not checked, a release was refused: `requires
policycheck: 1 PolicyCheck attestation(s) from eligible attesters; kyverno
revision 9 has 0 of 1`. The Meridian rollout that followed recorded an
approval and a PolicyCheck Pass in each of test, uat and prod. The order ended
`Completed`, `Released`, with 6 approvals and 6 PolicyCheck attestations, one
of each per variant.

`cub sveltos watch` keeps working with a requirement: a joining cluster waits
for its check as well as its approval, and the watcher prints the
`cub attestation create` it needs.
