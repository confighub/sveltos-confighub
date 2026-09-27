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

## What was recorded

Recorded on kind on 2026-09-27 with stock Sveltos v1.15.0 and Kyverno, by
running [run.sh](run.sh) against a fleet from
[kind-fleet.mjs](kind-fleet.mjs). The full output is
[rehearsal-2026-09-27.log](rehearsal-2026-09-27.log).

| Step | Measured |
| --- | --- |
| Before | Kyverno 3.8.1 on all four clusters from three profiles, one per class: test at 1 replica, uat at 2 and prod at 3, uat and prod with a PodDisruptionBudget. |
| Onboard: plan, apply, handover | One component: a root base (test's rendering, 70 objects, 22 of them CRDs), three class bases and a deployment per cluster, in 10 Spaces with 7 Links. The handover stepped the three profiles aside, and four delivery profiles took over with every pod the same: nothing was reinstalled. Meridian's queries (`Labels.Role = 'base'`, `'deployment'`) find the four bases and the four deployments. |
| One change for every class | Kyverno 3.8.2 and 4 replicas, both made on the root, in one change order. After its first stage, `bases`, every class base held 3.8.2; test's took 4 replicas, and uat's and prod's kept 2 and 3. uat was refused while test had not taken the change. Test, uat and prod then took it in order, and the clusters ended at 3.8.2 with 4, 2, 3 and 3 replicas. The change order ended `Completed`, `Released`. |

## The rule the three levels come with

A class base holds what its class differs in as changes of its own: fields
it sets, protected, and objects it adds. A later change at the root reaches
every class base, and a class's protected fields keep the class's values.

The class's clusters get what the class holds when each promotion takes the
change as one diff, with `--squash`, as `apply.sh` and `run.sh` do. Without
it, ConfigHub replays the root's function on each cluster's unit, past the
class's protection: an earlier recording of this slice ended with every
cluster at the root's 4 replicas, while the class bases still said 2 and 3.
The [rehearsal record](../../docs/planning/onboarding-rehearsal.md) has the
three-Space reproduction.

A class that removes an object the root has cannot protect the removal; the
plan says so when that happens, and here the root is chosen so it does not.

## What this slice is not

It is four clusters of Meridian's 99 and one of its 19 components. Its
deployments show "Not reported yet" where Meridian shows generated live
status: nothing reports Sveltos's view to ConfigHub until the status reporter
([#33](https://github.com/confighub/sveltos-confighub/issues/33)) exists. At
full size the same shape needs about 1,200 Spaces, as the Meridian README
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
