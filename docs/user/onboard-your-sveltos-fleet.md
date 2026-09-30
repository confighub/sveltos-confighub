# Onboard your Sveltos fleet

You already describe your fleet in Sveltos's own terms: ClusterProfiles that
pick clusters by label and install Helm charts or policies, and the
SveltosClusters they pick from. This guide turns that into a fleet ConfigHub
governs, with three commands, and the first two change nothing.

What changes is where the truth lives. ConfigHub holds, for each cluster, the
Kubernetes objects that cluster runs: each chart rendered with its values,
each policy as the object it is. Every change is a reviewed change to those
objects, released stage by stage. Sveltos keeps doing what it does well: it
delivers each cluster's release to that cluster and repairs drift.
`cub sveltos` is how you get there; after onboarding, every change is made
with ConfigHub's own commands.

![Before and after the handover: one label-selector profile installing Kyverno on three clusters becomes a ConfigHub base with one variant per cluster, delivered by one Sveltos delivery profile per variant to the same clusters, with nothing reinstalled](../images/sveltos/sveltos-handover-before-after.svg)

A change is made once, on the base, and reaches each variant through the
stages. Each delivery profile names one cluster (`clusterRefs`) and reads one
variant's latest approved release from ConfigHub's OCI gateway. If your
profiles are live, the handover moves them over in the numbered order, with
nothing reinstalled.

You need the `cub` CLI logged in to your ConfigHub organization
(`cub auth login`), `kubectl` access to your management cluster, which must
run Sveltos v1.14.0 or newer, and two plugins:

```bash
cub plugin install confighub/sveltos-confighub
cub plugin install confighub/cub-helm
```

If you installed them before, `cub plugin upgrade sveltos-confighub` and
`cub plugin upgrade helm` bring them up to date.

`cub sveltos` renders charts with `cub helm template`, ConfigHub's own Helm
renderer, so a chart onboarded here holds the objects `cub helm` would.

In this guide:
- [The words you will meet](#the-words-you-will-meet)
- [The journey](#the-journey), in three steps:
  [export](#1-export-what-sveltos-knows), [plan](#2-see-the-plan),
  [apply](#3-write-the-steps-read-them-run-them)
- [If your profiles are live](#if-your-profiles-are-live): the handover, and its checks
- [Kyverno policies, and other `policyRefs`](#kyverno-policies-and-other-policyrefs)
- [Classes: a base per environment, or per accelerator](#classes-a-base-per-environment-or-per-accelerator)
- [Making a change afterwards](#making-a-change-afterwards): a field, a chart upgrade, the rollout
- [When a cluster joins](#when-a-cluster-joins)
- [What this version leaves alone](#what-this-version-leaves-alone)

## The words you will meet

- **Base**: what a profile's charts and policies render to, stored once. It
  reaches no cluster. A change for every cluster is made here.
- **Variant**: a copy of the base for one cluster, holding the objects that
  cluster runs. It takes every later change to the base.
- **Class base**: with `--class-label`, a level between the base and the
  clusters, one per class (test, uat, prod; or h100, rtx-pro-6000), holding
  what that class differs in.
- **Delivery profile**: one ClusterProfile per variant on your management
  cluster, addressed to that cluster alone, that fetches the variant's
  latest release from ConfigHub.
- **Space**: ConfigHub's folder for configuration. Each base, class base and
  variant gets one; your organization has a quota of them.
- **Component**: one base with its class bases and variants. There is one
  per profile, or one per set of class profiles.
- **Target**: a named destination, one per cluster. A variant's releases go
  to its cluster's Target.
- **Link**: what ties a unit to the one it takes changes from; also under a
  quota.
- **Change order**: one change moving through the stages, test to prod, with
  an approval recorded in each stage before its release. **Workflow**: the
  stages and what each waits for.

## The journey

```mermaid
flowchart LR
  ex["1. export<br/>kubectl get clusterprofiles,<br/>sveltosclusters"] --> plan["2. cub sveltos plan<br/>prints what ConfigHub<br/>would hold"]
  plan --> apply["3. cub sveltos apply<br/>writes the files<br/>and the scripts"]
  apply --> as["apply.sh<br/>ConfigHub, then your<br/>management cluster"]
  as --> ho["handover.sh<br/>only if your profiles<br/>are live"]
```

The first three steps change nothing anywhere: `plan` needs no account and no
cluster, and `apply` only writes files. You read `apply.sh` before you run it.

## 1. Export what Sveltos knows

On your management cluster:

```bash
kubectl get clusterprofiles,sveltosclusters -A -o yaml > my-fleet.yaml
```

A file you wrote by hand works too; [my-fleet.yaml](../../examples/onboard/my-fleet.yaml)
is an example with three profiles and five clusters. If a profile names
ConfigMaps in `policyRefs`, the plan asks for them too.

**Starting something new.** You don't need a profile that already runs.
Write the ClusterProfile you would have given Sveltos, which selects clusters
by label and names a chart, and plan from it with a list of your clusters. You
never apply that profile to the management cluster; it is only the
description. `apply.sh` builds the base and a variant for each cluster it
selects, and puts one delivery profile per cluster in place:

```yaml
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: cert-manager
spec:
  clusterSelector:
    matchLabels:
      env: prod
  syncMode: ContinuousWithDriftDetection
  helmCharts:
    - repositoryURL: https://charts.jetstack.io
      repositoryName: jetstack
      chartName: jetstack/cert-manager
      chartVersion: v1.21.2
      releaseName: cert-manager
      releaseNamespace: cert-manager
      helmChartAction: Install
      values: |
        crds:
          enabled: true
        startupapicheck:
          enabled: false
```

```bash
kubectl get sveltosclusters -A -o yaml > clusters.yaml
cub sveltos plan cert-manager.yaml clusters.yaml --stage-label env --stages staging,prod
```

Measured on kind, with this profile selecting the two prod clusters of the
[Meridian slice](../../examples/meridian-slice/README.md): `apply.sh` made the
base (47 objects, 6 of them CRDs) and two variants, released them, and
Sveltos had cert-manager on both clusters about 75 seconds after `apply.sh`
started. It put nothing on the test and uat clusters. The startup check Job
is turned off in the values because it is a Helm hook that runs at install.
The plan would otherwise stop and ask for `--include-hooks cert-manager`.

## 2. See the plan

```bash
kubectl get configmap -n default kyverno-policies -o yaml > kyverno-policies.yaml
cub sveltos plan my-fleet.yaml kyverno-policies.yaml \
  --stage-label env --stages staging,prod --include-hooks ingress-nginx
```

The plan renders each chart, needs no account and no cluster, and shows what
ConfigHub would hold:

```text
kyverno  (selects env In [staging, prod])
  base     sveltos-kyverno-base  holds what its charts and policies render to, and delivers to no cluster:
    unit   kyverno  chart kyverno 3.8.1 from https://kyverno.github.io/kyverno: 71 objects (22 CRDs)
  stage staging
    staging-eu   variant sveltos-kyverno-staging-eu  ->  Target sveltos-targets/staging-eu
  stage prod
    prod-eu      variant sveltos-kyverno-prod-eu  ->  Target sveltos-targets/prod-eu
    prod-us      variant sveltos-kyverno-prod-us  ->  Target sveltos-targets/prod-us
```

```mermaid
flowchart LR
  hc["helmCharts entry<br/>kyverno 3.8.1 and its values"] -->|"cub helm template"| u1["unit kyverno<br/>71 objects, 22 of them CRDs"]
  pr["policyRefs ConfigMap<br/>default/kyverno-policies"] -->|"the objects it holds"| u2["unit kyverno-policies<br/>1 ClusterPolicy"]
```

Each chart becomes one unit holding the objects `cub helm template`
renders, in the order it prints them. Your labels chose the clusters, and
`--stage-label` turns them into the order a change rolls out in; leave it
out and every cluster is in one stage, `fleet`. The [full plan for the example](../../examples/onboard/plan.txt)
also lists what is left out and why, and how many Spaces and Links the fleet
needs: check your organization's quotas for both first.

**Helm hooks.** Only Helm runs hooks, so rendered objects leave them out, as
`cub helm` does. A chart whose hooks run when it installs, such as
ingress-nginx's jobs that make its webhook certificate, is a problem in the
plan until you pass `--include-hooks <release>`. That keeps its hooks, exactly
as `cub helm template --include-hooks` prints them, and its delivery profiles
mark them the way Sveltos treats hooks when it runs Helm: annotated
`projectsveltos.io/driftDetectionIgnore`, so they are not watched for drift.
Measured on kind with a hook Job that deletes itself when it finishes, as
ingress-nginx's do: without the mark, Sveltos recreated it ten times in a
minute and a half; with it, the Job ran once, stayed gone, and ran once more
with the next release, as a Helm upgrade runs it. A chart with hooks for
delete or test cannot be kept this way, since they would run at install too;
the plan says so.

## 3. Write the steps, read them, run them

```bash
cub sveltos apply my-fleet.yaml kyverno-policies.yaml \
  --stage-label env --stages staging,prod --include-hooks ingress-nginx --out onboard
MGMT_CONTEXT=<kubectl context of your management cluster> bash onboard/apply.sh
```

`apply` writes the files, the rendered objects among them, and one script,
and runs nothing. The script for the example is
[committed](../../examples/onboard/apply/apply.sh), so you can read exactly
what yours will do. It checks first that `cub` is logged in and that your
management cluster runs Sveltos v1.14.0 or newer (earlier releases cannot
read the gzipped layers ConfigHub's gateway serves), then:

1. Creates one Target per cluster, named for it, on a server-hosted worker.
2. Stores each base, and the workflow its changes follow. Above each chart
   it notes the `cub helm template` command the chart was rendered with,
   and `apply` writes the chart's values beside it, so the next version can
   be rendered the same way.
3. Creates each class base with what its class differs in, and each
   cluster's variant, bound to its Target. A variant is checked to hold every
   unit of its base.
4. Stores the management cluster's record: one delivery profile per variant.
5. Rolls out the first release stage by stage: promote, approve, publish.
   A variant missing a unit is never released: Sveltos would remove from its
   cluster whatever the release no longer holds.
6. On your management cluster, adds the gateway Secret and the delivery
   profiles. From then on Sveltos delivers each variant's latest release to
   its cluster, within a minute of it being published, and puts back
   anything changed by hand.

![A delivery profile as apply writes it, annotated: one per variant, addressed to one cluster by clusterRefs, drift put back, continueOnError always on, and one policyRefs entry reading the variant's latest approved release from ConfigHub's OCI gateway with the Targets' worker credential](../images/sveltos/sveltos-delivery-profile.svg)

The whole script is safe to re-run. It picks up where ConfigHub says each
step stands, and it never writes over a change made in ConfigHub since.

Sveltos reads the gateway as the Targets' server worker. That credential does
not expire, it can pull only the releases of those Targets, and the script
moves it from `cub` into the Secret without writing it to disk or showing it.

## If your profiles are live

If you exported from a live management cluster, the plan says which profiles
are live, and `apply` also writes `handover.sh`. `apply.sh` then leaves those
profiles' delivery profiles for `handover.sh`. Run it after `apply.sh`:

```bash
MGMT_CONTEXT=<kubectl context of your management cluster> bash onboard/handover.sh
```

Before it changes anything, `handover.sh` checks that what was planned is
still what is live:
- each live profile is the one you exported, unchanged since (its uid and
  generation);
- it still reaches the clusters planned;
- each ConfigMap of policies is unchanged.

If one has moved on since the export, say a chart was upgraded in the
profile or a cluster was labelled, ConfigHub no longer holds what runs, and
the delivery profiles would change the clusters to match an older plan. So
it stops, before touching anything, and asks you to export, plan and apply
again. A run that stopped half-way can simply be run again.

Then, for each live chart on each cluster, it compares what ConfigHub
released for that cluster's variant with the manifest Helm recorded when
Sveltos installed the chart there. It reads Helm's record through the
cluster's kubeconfig Secret on the management cluster, the way Sveltos
reaches the cluster. The two match when the chart rendered the same for
ConfigHub as it did on the cluster. They differ when the chart branches on
the cluster's Kubernetes version or APIs, or reads the cluster with
`lookup`. Then the handover would change the cluster, so the script stops
and names each difference, for example:

```text
eu-central-prod1 kyverno: ConfigHub releases something other than what Helm installed, so the handover would change the cluster:
  - Deployment kyverno/kyverno-admission-controller: spec.replicas is 3 on the cluster, 1 stored
```

Find out why first. To hand over anyway, and let the delivery profiles make
those changes, run it with `ACCEPT_DIFFERENCES=yes`.

- **A cluster at an address only the management cluster can reach**, as with
  kind or many Cluster API setups: put a kubeconfig that reaches it from where
  you run the script at `<dir>/<cluster>.kubeconfig`, and set
  `CLUSTER_KUBECONFIGS=<dir>`. The script does not skip a cluster it cannot
  reach.
- **A cluster in pull mode**, which the management cluster cannot read, is
  named as not compared.

Measured on kind, against a chart Sveltos installed through Helm:
- the same values compared the same;
- a changed replica count was named, and so was a changed chart version.

Until then your live profiles keep managing everything. `handover.sh` sets
each live profile to `stopMatchingBehavior: LeavePolicies`, so deleting it
leaves everything in place, and deletes it; a profile another live profile
depends on goes after it, since Sveltos holds its deletion until the
dependent is gone. Then it applies the delivery profiles, which adopt what
is there. No object ever has two profiles managing it. Do not delete a live
profile without `LeavePolicies`: by default Sveltos withdraws what it
deployed.

```mermaid
sequenceDiagram
  participant H as handover.sh
  participant L as live profile
  participant S as Sveltos
  participant D as delivery profiles
  participant C as your clusters
  H->>L: stopMatchingBehavior: LeavePolicies
  H->>L: delete, dependents first
  S-->>C: leaves every object in place
  H->>D: apply, one per variant
  D->>S: fetch each variant's release from ConfigHub
  S->>C: adopt the same objects: nothing reinstalled
```

Measured on kind: every long-running pod and the Kyverno policy kept its
identity, and each Helm release stayed at the revision it had. In an earlier
run, with the delivery profiles applied while the live ones still ran, a
live profile with drift detection took their first write as drift and ran
one more `helm upgrade`, hooks and all, and `policyRefs` objects sat in
conflict; that is why the live profiles now leave first.

Helm still records each release it installed, though ConfigHub manages the
objects now, and a `helm uninstall` would remove them. `handover.sh` prints
the command that removes the record on each cluster and leaves the objects.

If a live profile is itself applied from somewhere else, by Flux, Argo CD
or Helm, the plan says so, from the labels those tools leave, and
`handover.sh` stops while the profile is still there: deleting it would only
see it applied again, competing with its delivery profiles. Hand it over
where it comes from instead:
1. Set `stopMatchingBehavior: LeavePolicies` on it there, and let that apply.
2. Remove it there. That deletes it, and leaves everything it deployed in
   place.
3. Run `handover.sh`. It finds the profile gone and applies its delivery
   profiles.

Removing it without step 1 would withdraw its add-ons from every cluster.

## Kyverno policies, and other `policyRefs`

A ConfigMap a profile names in `policyRefs` holds the objects Sveltos
deploys; for Kyverno, the policies themselves. The base holds those objects,
so a policy is reviewed and staged like any other change, and each cluster
gets it from its own release. After the handover the original ConfigMap is
no longer read, and `handover.sh` says so.

Secrets named in `policyRefs`, entries fetched from elsewhere, and
`kustomizationRefs` stay on each delivery profile as they were, delivered by
Sveltos from their sources; the plan names them. So do `patches`, which
Sveltos applies on top of what ConfigHub releases.

## Classes: a base per environment, or per accelerator

With `--class-label <label>`, onboarding adds a level between each base and
its clusters, the way ConfigHub's Meridian demo fleet is laid out: a root
base, one class base per value of the label, and each cluster's variant
cloned from its class base.

```bash
cub sveltos plan my-fleet.yaml --class-label class --stage-label class --stages test,uat,prod
```

- **You keep one profile per class already** (`kyverno-test`, `kyverno-uat`,
  `kyverno-prod`, each selecting its class and setting its values). The plan
  recognises them as one component, because they install the same charts.
  Each class's chart is rendered with that class's values, and its class
  base holds exactly what that rendering differs in: fields, such as
  `spec.replicas` of the admission controller's Deployment, and whole
  objects, such as the PodDisruptionBudget Kyverno adds above one replica.
  The root base is the class whose objects every other class also has, so
  the others add objects and change fields. `handover.sh` hands every
  profile over.
- **One profile covers several classes.** It gets a class base per class,
  the same as the base at first, so a change for one class has a place to go.

![One change at the root reaches three class bases; test takes 4 replicas, uat and prod keep their protected 2 and 3, and each cluster takes what its class holds. Promote with --squash](../images/sveltos/sveltos-meridian-three-levels.svg)

Each field a class departs in is protected, so a later change to the same
field at the root does not replace it. A change for every class is made
once, on the root base: the workflow's first stage, `bases`, carries it into
every class base, which are never released, and then it moves stage by stage
to the clusters. Measured on [a slice of Meridian](../../examples/meridian-slice/README.md):
Kyverno 3.8.2 and 4 replicas, both made on the root, reached every class
base in one change order. Test's clusters took the 4 replicas, and uat's and
prod's kept 2 and 3.

Protection holds on the fields ConfigHub resolves: a field, a list entry
with a name (`containers.?name=kyverno`), or a whole list. A field a class
removes cannot be protected, and the plan says so.

## Making a change afterwards

After onboarding, ConfigHub holds what runs, and a change is made to it with
ConfigHub's own commands, then taken through the stages by a change order.

```mermaid
flowchart LR
  edit["edit the base<br/>a function, or a<br/>chart upgrade"] --> co["change order"]
  co --> st["staging<br/>promote --squash,<br/>approve, publish"]
  st -->|"refused until staging<br/>has released"| pd["prod<br/>promote --squash,<br/>approve, publish"]
  st -.->|"Sveltos, within a minute"| cs["staging clusters"]
  pd -.->|"Sveltos, within a minute"| cp["prod clusters"]
```

In ConfigHub's Rollouts view, each change order shows its promotion path and
what it waits for. This one is finished: promoted through the class bases, and
promoted and released in test, uat and prod.

![A finished rollout in ConfigHub: the promotion path from source through bases, test, uat and prod, each marked promoted and released, four of four stages taken](../images/sveltos/sveltos-rollout-complete.png)

**A field**, for every cluster, on the base:

```bash
cub function set --space sveltos-kyverno-base --unit kyverno --change-desc "Admission controller at 4 replicas" -- \
  set-yq '(select(.kind == "Deployment" and .metadata.name == "kyverno-admission-controller") | .spec.replicas) = 4'
```

For one class, the same on its class base, followed by
`cub unit set-protection` on the field, so a later change at the root keeps
it.

**A chart upgrade.** Render the new version the way the chart was rendered
at onboarding, which `apply.sh` notes above the chart's unit, and store it
on the base:

```bash
cub helm template kyverno kyverno --repo https://kyverno.github.io/kyverno --version 3.8.2 \
  --namespace kyverno --create-namespace -f onboard/kyverno/kyverno.values.yaml \
  | grep -vxF '$comment$head$: ""' > kyverno.yaml
cub unit update --space sveltos-kyverno-base kyverno kyverno.yaml --change-desc "Kyverno 3.8.2"
```

The `grep` drops a stray line `cub helm template` prints at the top of some
documents, which is no part of the chart; `apply.sh` renders the same way.

Review it object by object: this lists what the new version changes, each
changed field by its path, including what the chart changed besides your
values, such as new RBAC rules, CRD schema and whole new objects:

```bash
cub unit diff --space sveltos-kyverno-base kyverno --from=-1 -o mutations
```

The update replaces the base's objects, so a field changed on the base since
goes back to the chart's value, and the review shows that too: upgrade
first, then change fields, in one change order. What classes and clusters
hold differently stays: a class's protected fields and added objects, and
every variant's own changes.

Then take the changes through the stages:

```bash
cub changeorder create --space sveltos-kyverno-base kyverno-3-8-2 \
  --change-workflow sveltos-kyverno-base/rollout --description "Kyverno 3.8.2"

cub variant promote --change-order sveltos-kyverno-base/kyverno-3-8-2 --target-stage staging --squash
cub variant approve --change-order sveltos-kyverno-base/kyverno-3-8-2 --stage staging
cub release publish sveltos-kyverno-staging-eu --revision ChangeOrder:sveltos-kyverno-base/kyverno-3-8-2

cub variant promote --change-order sveltos-kyverno-base/kyverno-3-8-2 --target-stage prod --squash
cub variant approve --change-order sveltos-kyverno-base/kyverno-3-8-2 --stage prod
cub release publish sveltos-kyverno-prod-eu --revision ChangeOrder:sveltos-kyverno-base/kyverno-3-8-2
cub release publish sveltos-kyverno-prod-us --revision ChangeOrder:sveltos-kyverno-base/kyverno-3-8-2
```

Promote with `--squash`, as `apply.sh` does: each variant takes the change
as one diff. Without it, a promotion replays the functions a change was made
with, one revision at a time, and a function run at the root then reaches a
class's clusters even though the class base protected that field. Measured on
kind: a root change to 4 replicas, made with `set-yq`, left the uat class base
at its protected 2, and then set the uat cluster to 4
(confighubai/confighub#5529).

ConfigHub refuses to promote into prod until staging has released the
change, and refuses each release until the change is approved in its stage;
both refusals come from the server, in its own words. What a reviewer sees
is the objects' fields: a chart upgrade shows the images and anything else
the chart changed, not a values string.

The generated workflow lets the person who promotes a change also approve
it, which one person trying this needs. Once a second person approves, set
`AllowAuthors: false` in each profile's `change-workflow.yaml`, and ConfigHub
refuses an approval from the change's author.

## Live status in ConfigHub

`cub sveltos status` tells ConfigHub what Sveltos delivered to each cluster.
Run it once, or keep it running:

```bash
cub sveltos status --context <management cluster context>
cub sveltos status --context <management cluster context> --watch   # every 30 seconds
```

It prints one line per cluster, and writes the same reading to that
cluster's variant, where ConfigHub shows it:

```text
CLUSTER           SPACE                          SYNC       HEALTH       REVISION             WRITTEN  MESSAGE
eu-central-test1  mer-kyverno-eu-central-test1   OutOfSync  Progressing  sha256:3e39eaa74376  yes      release 3, created 2026-09-28T11:03:43Z, not applied yet
eu-central-uat1   mer-kyverno-eu-central-uat1    Synced     Healthy      sha256:e2b3ed3756b1  yes
```

ConfigHub's component map shows the same readings on each cluster's variant.
Each is marked Live and Synced, and is marked behind while a rollout still
has a release to bring it:

![The Meridian slice in ConfigHub's component map: mer-kyverno-base, three class bases (prod, test, uat), and six cluster variants, each marked Live and Synced, some one release behind a rollout in progress](../images/sveltos/sveltos-meridian-tree.png)

- **Synced and Healthy:** Sveltos applied the latest release, and the
  Deployments, StatefulSets and DaemonSets it delivers were available when it
  did. The revision is the digest of that release.
- **OutOfSync and Progressing:** a newer release was created after Sveltos
  last applied, or Sveltos is still deploying.
- **Degraded:** Sveltos reports a failure, and the message says what failed.

**Which release a cluster runs is worked out from times.** Sveltos does not
report which release it fetched. So `status` takes the latest release created
before Sveltos last applied the delivery profile, and reports its digest. Two
releases created close together, or clocks that disagree, can make it name the
wrong one. That matters, because when the revision equals a release's digest,
ConfigHub moves that release's change order on by itself. The reading says
what Sveltos applied and when; it is not proof that the cluster runs that exact
release. Checking the running objects against the release is
[#39](https://github.com/confighub/sveltos-confighub/issues/39)'s drift report.

It writes a reading only when it changes, or when the one ConfigHub holds is
older than `--refresh` (ten minutes by default). A refreshed reading has a new
time, but the health checks did not run again.

**Health comes from Sveltos, when it deploys and after.** Each delivery
profile carries `validateHealths` for the workloads its charts deliver, named
one by one, and Sveltos reports the profile `Provisioned` only once they are
available. Sveltos checks this when it applies a release, not afterwards: the
Sveltos project confirms these checks are like Helm's post-install and
post-upgrade hooks.

So `apply` also writes a continuous check for each profile, in
`management/<profile>-health.yaml`, which `apply.sh` applies after the
delivery profiles and ConfigHub holds in the management record:
- a **HealthCheck** that judges the Deployments, StatefulSets and DaemonSets
  the profile delivers, named one by one: Progressing while one rolls out,
  Degraded once too few of its pods are available;
- a **ClusterHealthCheck** that runs it on the profile's clusters all the time,
  and emits a Kubernetes event when a cluster's health changes.

`status` reads each cluster's condition from the ClusterHealthCheck. A
workload that goes down after its release was applied turns the cluster
Degraded, naming it, while its release stays Synced; it turns Healthy again
when the workload recovers. ConfigHub's `Healthy` gate then holds the next
stage while a cluster is Degraded. Measured on the Meridian slice
([health-2026-09-30.log](../../examples/meridian-slice/health-2026-09-30.log)):
- a Kyverno controller stopped on test1 after its release was reported in 37
  seconds, naming it, and its recovery 46 seconds after it came back, while
  Sveltos still reported the profile `Provisioned`;
- later that morning, with the laptop overloaded, Kyverno's pods began
  restarting on their own. The check found it on all six clusters, which
  `status` had reported Synced and Healthy minutes before.

Sveltos's other liveness type, `Addons`, stayed passing throughout: it follows
what Sveltos deployed, not whether it is running.

A ClusterHealthCheck chooses clusters by label only, while a delivery profile
names its one cluster. So the check selects by the profile's own labels, with
every class of a component (for Meridian, `class In (test, uat, prod)`). A
profile that names its clusters by `clusterRefs` is checked on every cluster
Sveltos manages; a cluster without its workloads passes.

A delivery profile written by 0.5 or earlier has no apply-time checks, and
`status` says so, with health `Unknown` unless a continuous check covers it.
Run `apply` again and apply the new `management/<profile>.yaml` to add both.

**ConfigHub can gate a rollout on it.** A stage in the change workflow can
list `Healthy` among its prerequisites. ConfigHub then refuses to promote
into that stage until every cluster in the stage ahead reports Synced and
Healthy. Measured on the Meridian slice, with `Healthy` added before uat:

```text
$ cub variant promote --change-order mer-kyverno-base/healthy-gate-probe --target-stage uat --squash
Failed: Variant 'eu-central-test1' is not synced
```

To use it, add `Healthy` to the `Prerequisites` of each stage after the
first in `change-workflow.yaml`, and keep `cub sveltos status --watch`
running. Without the reporter, the gate never opens. ConfigHub checks the
words in the reading, not which release it is about. So promote after
`status` has reported the new release, which it does within one interval of
Sveltos applying it.

## When a cluster joins

Register the cluster with Sveltos and label it as you always have. Nothing
ships to it yet: a label no longer deploys anything by itself. Then plan and
apply again, with the same options, from the profiles `apply` saved (with
the ConfigMaps they name) and a fresh cluster list:

```bash
kubectl get sveltosclusters -A -o yaml > clusters.yaml
cub sveltos plan onboard/profiles.yaml clusters.yaml --stage-label env --stages staging,prod --include-hooks ingress-nginx
cub sveltos apply onboard/profiles.yaml clusters.yaml --stage-label env --stages staging,prod --include-hooks ingress-nginx --out onboard
MGMT_CONTEXT=<kubectl context of your management cluster> bash onboard/apply.sh
```

```mermaid
flowchart LR
  lab["label the new cluster:<br/>nothing ships yet"] --> pl["plan and apply<br/>from onboard/profiles.yaml"]
  pl --> v["its variant, cloned from<br/>the base as it stands today"]
  v --> rel["approved and released<br/>through its stage"]
```

The plan shows the new cluster's variants. The script leaves every existing
variant as it is. It clones the new one from the base as the base stands
today, including every change made since onboarding, and releases it through
its stages. So joining the fleet is one reviewed change rather than a side
effect of a label.

### Let `cub sveltos watch` propose it

Run by hand as above, `apply.sh` approves the release itself. `cub sveltos
watch` does the same work as each cluster registers, but approves nothing:

```bash
cub sveltos watch onboard/profiles.yaml --out onboard --context <management cluster context> \
  --stage-label env --stages staging,prod --include-hooks ingress-nginx
```

Give it the options you planned with. Every minute it reads the
SveltosClusters and plans them against the saved profiles. When a profile
newly selects a cluster:

1. It writes the plan to `onboard` again and runs `apply.sh` with
   `PROPOSE_ONLY=1`. The cluster's variants are made, and the release order
   is promoted stage by stage.
2. A stage with nothing new for its variants needs no approval. So the order
   stops at the new cluster's own stage, waiting for a person:

   ```
   kyverno waits for approval in stage prod: cub variant approve --change-order sveltos-kyverno-base/onboard-1a2b3c4d --stage prod
   ```

3. Nothing reaches the cluster yet. Its delivery profile is applied only once
   its variant has a release.
4. Once someone approves, the watcher's next look runs `apply.sh` again. That
   publishes the release, finishes the order and applies the delivery
   profile, and Sveltos delivers within a minute.

While it waits, the watcher only looks. It runs `apply.sh` again only when the
order has gained an approval.

It records why it proposed each variant:
- in the release order's description, for example `Proposed by cub sveltos
  watch: prod-us joined (env=prod, region=us); selected by env in (staging,
  prod)`;
- on the variant's Space, as the annotation `sveltos.confighub.com/joined`
  (the cluster, its labels, the profile, the selector, the stage and the
  order);
- in `onboard/watch.log`, with everything `apply.sh` printed.

**What it refuses:**
- A cluster no profile selects gets nothing. The watcher names it once.
- A cluster the plan cannot place, such as one whose stage label is not one of
  the stages, stops every proposal until it is fixed. The watcher shows the
  plan's problem.
- It will not run while a profile you onboarded is still live on the
  management cluster: run `handover.sh` first.

`--once` looks once and stops. `PROPOSE_ONLY=1 bash onboard/apply.sh` is the
same behaviour by hand.

Recorded on the Meridian kind fleet
([join-2026-09-28.log](../../examples/meridian-slice/join-2026-09-28.log)):

| Time (UTC) | What happened |
| --- | --- |
| 13:06 | eu-central-prod4 registered with Sveltos, labelled `class: prod` |
| 13:10 | The watcher proposed `mer-kyverno-eu-central-prod4`. The order passed test and uat with no approval and waited in prod. Nothing reached the cluster. |
| 13:16 | A person approved: `cub variant approve --change-order mer-kyverno-base/onboard-f68adc1c --stage prod` |
| 13:18 | The watcher published the release and applied the delivery profile |
| 13:20 | Sveltos reported it `Provisioned`, with the same Kyverno as the other prod clusters |

**Two things ConfigHub does here:**
- A release order promoted through stages with nothing new for their
  variants needs no approval in them. Publishing reports no changes, the next
  stage opens, and the order completes.
- An order that carries no change for a freshly cloned variant is marked
  resolved, although that variant still waits for its first release and its
  approval. So the watcher and `apply.sh` decide what waits from the
  published releases, not from the order's stage.

eu-central-prod3 and eu-central-prod4 in the component map above are the two
clusters that joined this way.

## What you will see

Every command in this guide was rehearsed end to end on kind clusters running
stock Sveltos v1.15.0; the [rehearsal record](../planning/onboarding-rehearsal.md)
says what was measured, and [examples/onboard](../../examples/onboard) runs it
again on your machine.

## What this version leaves alone

- Namespaced `Profile` objects; it onboards `ClusterProfile`s.
- Profiles that select through ClusterSets, or that Sveltos's event framework
  made.
- Charts whose values are templated per cluster or come from `valuesFrom`,
  ConfigMaps Sveltos instantiates as templates, and `policyRefs` deployed to
  the management cluster itself (`deploymentType: Local`). The plan names
  each as a problem.
- Charts that render differently each time they are rendered, through
  `lookup` or random values; set those values explicitly.
- Charts at a version range (`1.2.x`, `^1.2.0`) or read from a Flux source
  (`gitrepository://`, `ocirepository://`, `bucket://`). What ConfigHub
  renders must be the exact chart that is running, so the plan names each as
  a problem; pin the version that runs.
- Profiles another object owns, such as those a ClusterPromotion makes; the
  plan skips them, since the owner would make them again. Govern the owner.
- Charts that render differently by the cluster's Kubernetes version or APIs
  (`.Capabilities`), or through `lookup`. `cub helm template` renders them for
  a default cluster without reading it, so the plan cannot know.
  `handover.sh` finds where the result differs from what Helm installed, and
  stops.
- Profiles that select no cluster today, and clusters no profile selects;
  the plan lists them.

Cluster API clusters are addressed as their `Cluster`, the same structural
way; that path has not been rehearsed live yet.
