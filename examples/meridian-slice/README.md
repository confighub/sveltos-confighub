# A slice of Meridian, delivered by Sveltos

Meridian is the fleet ConfigHub's demo tool builds: a synthetic Meridian
Group with 99 clusters across 8 regions, 4 classes (dev, test, uat, prod) and
3 departments. It lives in [confighub/cub-demo](https://github.com/confighub/cub-demo)
(`scenarios/meridian.yaml`). Every component there is a tree of three levels:

- a root base;
- a class base per class, holding what that class differs in (Meridian's
  class knobs: replicas 1 for test, 2 for uat, 3 for prod);
- one deployment per cluster, cloned from its class base.

Meridian's units are the Kubernetes objects themselves, and each class knob
is a real field. Its clusters are Targets on a server-hosted worker, and its
live status is generated.

This slice makes part of it real with Sveltos. It takes the shared
eu-central clusters that Meridian places Kyverno on, `eu-central-test1`,
`-uat1`, `-prod1` and `-prod2`, named and labelled the Meridian way, and
starts where a Sveltos user carrying Meridian's class knobs would be today:
one Kyverno profile per class, each selecting its class and setting its
replicas ([meridian-slice.yaml](meridian-slice.yaml)).

```bash
cub sveltos plan examples/meridian-slice/meridian-slice.yaml \
  --class-label class --stage-label class --stages test,uat,prod
```

`--class-label class` makes the three profiles one component in Meridian's
shape. Each profile's chart is rendered with its class's values, and the
plan compares the renderings:

```text
kyverno  (selects one profile per class: prod, test, uat)
  base     sveltos-kyverno-base  holds what its charts and policies render to, and delivers to no cluster:
    unit   kyverno  chart kyverno 3.8.1 from https://kyverno.github.io/kyverno: 70 objects (22 CRDs)
  class    prod         sveltos-kyverno-class-prod  from profile kyverno-prod; differs from the base in Deployment kyverno/kyverno-admission-controller spec.replicas, adds PodDisruptionBudget kyverno/kyverno-admission-controller
  class    test         sveltos-kyverno-class-test  from profile kyverno-test; the same as the base
  class    uat          sveltos-kyverno-class-uat  from profile kyverno-uat; differs from the base in Deployment kyverno/kyverno-admission-controller spec.replicas, adds PodDisruptionBudget kyverno/kyverno-admission-controller
```

Kyverno renders a PodDisruptionBudget only above one replica, so the root
base is test's rendering, the one whose objects every other class also has.
uat and prod each depart from it in two ways: the admission controller's
`spec.replicas`, protected, and the PodDisruptionBudget they add. The Spaces
carry Meridian's `Role` and `Cluster` labels, so Meridian's queries
(`Labels.Role = 'base'`, `Labels.Role = 'deployment'`) find them.

After the recorded change, Kyverno 3.8.2 and 4 replicas made once on the
root, the tree held this, and each cluster ran what its variant held:

![One change at the root reaches three class bases; test takes 4 replicas, uat and prod keep their protected 2 and 3, and each cluster takes what its class holds. Promote with --squash](../../docs/images/sveltos/sveltos-meridian-three-levels.svg)

In ConfigHub, after two more clusters joined:

![The Meridian slice in ConfigHub's component map: mer-kyverno-base, three class bases (prod, test, uat), and six cluster variants, each marked Live and Synced, some one release behind a rollout in progress](../../docs/images/sveltos/sveltos-meridian-tree.png)

## What was recorded

Recorded on kind on 2026-09-28 with stock Sveltos v1.15.0, Kyverno, and
`cub sveltos` v0.5.1 as released, by running [run.sh](run.sh) against a
fleet from [kind-fleet.mjs](kind-fleet.mjs). The full output is
[rehearsal-2026-09-28.log](rehearsal-2026-09-28.log).

| Step | Measured |
| --- | --- |
| Before | Kyverno 3.8.1 on all four clusters from three profiles, one per class: test at 1 replica, uat at 2 and prod at 3, uat and prod with a PodDisruptionBudget. |
| Onboard: plan, apply, handover | One component: a root base (test's rendering, 70 objects, 22 of them CRDs), three class bases and a deployment per cluster, in 10 Spaces with 7 Links. Before it changed anything, the handover found each profile as exported, reaching the clusters planned, and each cluster's Kyverno the same as what Helm had installed there, object for object (69 objects on test, 70 on uat and prod, their PodDisruptionBudget among them). Then it stepped the three profiles aside, and four delivery profiles took over with every pod the same: nothing was reinstalled. Meridian's queries (`Labels.Role = 'base'`, `'deployment'`) find the four bases and the four deployments. |
| One change for every class | Kyverno 3.8.2 and 4 replicas, both made on the root, in one change order. After its first stage, `bases`, every class base held 3.8.2; test's took 4 replicas, and uat's and prod's kept 2 and 3. uat was refused while test had not taken the change. Test, uat and prod then took it in order, and the clusters ended at 3.8.2 with 4, 2, 3 and 3 replicas. The change order ended `Completed`, `Released`. |
| Policies gate every change | Recorded the same day in [policy-2026-09-28.log](policy-2026-09-28.log), with a Kyverno checker on the management cluster. A change that put the cleanup controller on `:latest` was refused entry to test, and its release was refused once it reached test1. With the checker's worker stopped, a change went out unchecked. Two rollouts then passed an approval and a recorded PolicyCheck in every stage. See [Check every change against your policies](../../docs/user/policy-checks.md). |
| A change's impact, previewed before it ships | Recorded the same day in [impact-2026-09-28.log](impact-2026-09-28.log), with `cub sveltos impact` and the policies in [policies/](policies). Lowering prod's replica ceiling to 2 was newly denied on the four prod clusters. A proposal of 6 replicas at the root was newly denied on test alone, since uat and prod protect their replicas. Exempting Kyverno from `disallow-latest-tag` newly allowed the two revisions ConfigHub had recorded as failing. A policy that reads the requesting user came out unknown. |
| Policies held in ConfigHub, and a fix through the gates | Recorded on 29 September in [demo-2026-09-29.log](demo-2026-09-29.log). The policies are units in `mer-policies`, the revisions in force tagged `in-force`, with six known cases ([policies/tests.yaml](policies/tests.yaml)). Lowering prod's ceiling to 2, as a new revision, was newly denied on the four prod clusters and refused a known-good case; it was taken back out. Exempting Kyverno from `disallow-latest-tag` newly allowed the two failing root revisions and a known-bad case. 6 admission controller replicas in test were newly denied by `replica-limits@2`. An assistant explained why ([explain/](explain)); the person chose to raise test's ceiling to 6, which was previewed, approved and tagged. `cub sveltos check` then recorded a Pass judged by `replica-limits@5`, the release was approved and published, and eu-central-test1 ran 6 of 6 replicas under three minutes after that step began. A policy that reads the requesting user came out unknown. |
| Health watched after every release | Recorded on 30 September in [health-2026-09-30.log](health-2026-09-30.log). `apply` wrote a HealthCheck and a ClusterHealthCheck for Kyverno, selecting `class In (prod, test, uat)`; the six delivery profiles were unchanged. A controller stopped on eu-central-test1 was reported Degraded in 37 seconds, naming it, while Sveltos still said `Provisioned`, and Healthy 46 seconds after it recovered. With the laptop overloaded later, the check found Kyverno restarting on all six clusters, and `status` wrote each one to ConfigHub as Degraded. |
| A cluster joins, and ships once approved | Recorded later the same day with `cub sveltos watch` (v0.6.0), in [join-2026-09-28.log](join-2026-09-28.log). eu-central-prod4 registered with `class: prod` at 13:06. The watcher proposed its variant at 13:10, cloned from prod's class base, so it held 3.8.2 and prod's 3 replicas. The release order passed test and uat with no approval, since nothing was new there, and waited in prod. Nothing reached the cluster, and its delivery profile waited. A person approved at 13:16. The watcher's next look published the release and applied the delivery profile at 13:18, and Sveltos reported it `Provisioned` at 13:20, with the same Kyverno as eu-central-prod1. |

## The rule the three levels come with

A class base holds what its class differs in as changes of its own: fields
it sets, protected, and objects it adds. A later change at the root reaches
every class base, and a class's protected fields keep the class's values.

The class's clusters get what the class holds when each promotion takes the
change as one diff, with `--squash`, as `apply.sh` and `run.sh` do. Without
it, ConfigHub replays the root's function on each cluster's unit, past the
class's protection: an earlier recording of this slice ended with every
cluster at the root's 4 replicas, while the class bases still said 2 and 3.
A three-Space reproduction is filed with ConfigHub
(confighubai/confighub#5529).

A class that removes an object the root has cannot protect the removal; the
plan says so when that happens, and here the root is chosen so it does not.

## What this slice is not

It is four clusters of Meridian's 99, and one of its 19 components. Its
deployments show live status once `cub sveltos status` runs. At full size the same shape needs about 1,200 Spaces, as the Meridian README
says, so an organization onboarding at that scale asks for its quota to be
raised first. `cub sveltos plan` prints the count.

## Run it yourself

With `cub` logged in to an organization that has 10 Spaces free, and kind,
kubectl and helm installed:

```bash
cub plugin install confighub/sveltos-confighub
cub plugin install confighub/cub-helm
node examples/meridian-slice/kind-fleet.mjs
bash examples/meridian-slice/run.sh
node examples/meridian-slice/kind-fleet.mjs --delete
```

`run.sh` keeps its ten `mer-` Spaces, so the tree above can be opened in
ConfigHub.

To see a cluster join, run the watcher with the options `run.sh` planned with,
then register one more cluster:

```bash
cub sveltos watch onboard/profiles.yaml --out onboard --context kind-mer-mgmt \
  --class-label class --stage-label class --stages test,uat,prod --prefix mer
node examples/meridian-slice/kind-fleet.mjs --join prod4    # in another terminal
```

The watcher prints the `cub variant approve` command to run.

Sveltos reaches each kind cluster with a token that lasts 30 days.
`node examples/meridian-slice/kind-fleet.mjs --refresh` gives every cluster a
new one, without rebuilding anything.
