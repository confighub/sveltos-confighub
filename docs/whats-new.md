# What's new in cub sveltos

`cub sveltos` onboards a fleet you already run with Sveltos into ConfigHub:
one variant per cluster, every change reviewed and released stage by stage,
and Sveltos still delivering. Version 0.5 changes what ConfigHub holds.
Version 0.6 tells ConfigHub what Sveltos delivered, and proposes each cluster
that joins for a person to approve. Version 0.7 checks every change against
your policies before it ships. Version 0.8 previews what a change, or a new
policy, would do to each cluster. Version 0.9 keeps the policies themselves in
ConfigHub, with known cases, and checks each change by the same policies it was
previewed against. Version 0.10 watches each cluster's health after every
release too, can deliver the management cluster's record from ConfigHub, and
stores each cluster's facts on its Target.

- **Before 0.5,** it held each Sveltos ClusterProfile, so a chart's settings
  were a Helm values string.
- **From 0.5,** it holds the Kubernetes objects each cluster runs: every chart
  rendered with its values, and every policy as the object it is. A reviewer
  now sees fields, and Sveltos delivers plain objects.

The [onboarding guide](user/onboard-your-sveltos-fleet.md) is the full
walkthrough.

## 0.11.1, 2026-10-02

Needs `cub` v0.7.0 or newer.

**Targets without a worker.** Since `cub` v0.7.0 a Target has no worker,
provider or parameters: the identity that pulls its releases is granted View
and ViewChildren on it. `apply.sh` now creates each cluster's Target that way,
and grants the bot user of the server-hosted worker Sveltos reads with. A
Target from an earlier run gets the same grant. With `cub` v0.7.0, the
`apply.sh` of `cub sveltos` 0.11.0 and earlier stops at step 1
("unknown flag: --provider"). With a `cub` whose `target create` still takes
`--provider`, the new script stops before it changes anything and says to
upgrade.

The plugin is built on the ConfigHub SDK v0.8.0.

## 0.11.0, 2026-09-30

Explore a fleet before adding a ConfigHub server. `plan --format json` exports a
versioned preview of supplied input and proposed ConfigHub structure; ASCII
remains the default. Planning problems remain in JSON with a nonzero exit.

The optional shared ConfigHub UI is installed separately:

```sh
cub sveltos ui install --version plugin-ui-v0.1.0
cub sveltos ui
```

Installation verifies a pinned release archive and its file manifest before
selecting it. Failed upgrades preserve the previous UI. GitHub CLI access to
`confighub/ui` is needed to download its release. Offline archive installation
and `--assets-dir` remain available. No UI download is required for CLI use.
The source-tree `scripts/install-plugin.sh --with-ui plugin-ui-v0.1.0` offers
both in a single opt-in installation flow.

See [the preview guide](../examples/ui-preview/README.md) for scope, safety,
local installation, and error behavior. The UI never executes a preview or
uploads it automatically.

## 0.10.0, 2026-09-30

**The management cluster's record, delivered from ConfigHub** (#81), with
`--management-release`. The management Space publishes releases, and one root
profile on the management cluster fetches them, as Argo CD's app of apps does:
after `apply.sh` applies it once, a change to the delivery profiles reaches the
management cluster by publishing, not `kubectl`. A variant's delivery profile
joins the record only once that variant has a release, so a joining cluster
still waits for its approval. Measured on the Meridian slice:
the root took over the six delivery profiles 17 seconds after it was applied,
a change made only in ConfigHub arrived 44 seconds after publishing, and a
check deleted by hand was back in 16. See [the management cluster's
record](user/onboard-your-sveltos-fleet.md#the-management-clusters-record-delivered-from-confighub).

**Health, watched after every release too** (#71). Sveltos runs a delivery
profile's `validateHealths` only when it deploys. `cub sveltos apply` now also
writes, beside each profile's delivery profiles, a HealthCheck that judges the
workloads the profile delivers and a ClusterHealthCheck that runs it on the
profile's clusters all the time. `cub sveltos status` reads each cluster's
condition: a workload that goes down after its release was applied turns the
cluster Degraded, naming it, and Healthy again when it recovers. A rollout
in progress reads Progressing. Measured on the Meridian slice: a stopped
controller was reported in 37 seconds and its recovery in 46, while Sveltos
still said `Provisioned`
([health-2026-09-30.log](../examples/meridian-slice/health-2026-09-30.log)).
The check needs Sveltos's ClusterHealthCheck installed; without it, `apply.sh`
says so and goes on. See [live status](user/onboard-your-sveltos-fleet.md#live-status-in-confighub).

**Each cluster's facts on its Target: `cub sveltos facts`** (part of #39). For
every cluster Sveltos manages, it runs `cub k8s collect` through the
kubeconfig Sveltos reaches the cluster with, and stores the facts on the
cluster's Target: its Kubernetes version, CRDs, and storage and ingress
classes. `apply.sh` runs it after making the Targets, and goes on if a cluster
cannot be reached. Measured on the Meridian slice: all seven Targets.

## 0.9.0, 2026-09-30

**Policies held in ConfigHub, known cases, and one judge for preview and gate.**
- `--policy` and `--candidate` read policies held in ConfigHub as well as
  files, each at a revision: `<space>/<unit>`, `@<n>`, `@Tag:<tag>`, or a whole
  Space such as `mer-policies@Tag:in-force`. A policy change is a new revision,
  previewed before a person moves the tag. Each denied or unknown result
  names the policy revision behind it.
- `--tests` adds known cases: objects annotated with the stage they meet and
  the verdict they expect. A case the policies in force get wrong is reported,
  and so is a known-bad case a candidate would admit.
- `cub sveltos check` can judge with the same sandbox and policies instead of
  a worker function. The PolicyCheck it records names the policy revisions, so
  a change is released under exactly the policies it was previewed against.

**Live status says how it knows which release a cluster runs.** Sveltos does
not report which release it fetched, so `cub sveltos status` works it out from
release and apply times. The onboarding guide now says so, and why it matters:
ConfigHub moves a change order on when the reported revision equals a
release's digest. A waiting release's message now says when it was created,
which is the time `status` reads.

## 0.8.0, 2026-09-28

**Preview a change's impact before anything ships: `cub sveltos impact`.** It
evaluates each cluster's configuration under the policies in force and under a
candidate, in a disposable API server, by server-side dry run. Each object
comes out newly denied, newly allowed, unchanged, or unknown.
- `--candidate` previews a proposed policy against every configuration running.
- `--next` previews what each cluster's next promotion brings against its own
  policies.
- `--corpus` adds the revisions ConfigHub recorded as failing, so a weaker
  policy shows what it would newly allow.

Recorded on the Meridian slice ([impact-2026-09-28.log](../examples/meridian-slice/impact-2026-09-28.log)).
See [Before anything ships](user/policy-checks.md#before-anything-ships-preview-a-changes-impact).

## 0.7.0, 2026-09-28

**Check every change against your policies.** Three additions, all measured
on the Meridian kind fleet with a Kyverno checker. See [Check every change
against your policies](user/policy-checks.md).
- **`--policy <space>/<filter>`** gives every base, class base and variant a
  trigger Filter, such as a Kyverno check. It also adds `Validated` to each
  stage that has a stage ahead. A change that fails is not promoted past its
  stage, and not released.
- **`--require <type>`** makes each stage's release wait for a Pass of that
  attestation type, as well as the approval. This uses ConfigHub's
  attestation requirements, and it never lets an unchecked change through.
- **`cub sveltos check`** runs a validating function, such as
  `vet-kyverno-server`, on exactly the revisions a change order marks in a
  stage. It records a Pass, or a rejection that holds the release.

`apply.sh` adds these gates to a workflow made before them, and keeps gates
and stage settings made in ConfigHub since. A release refused for
ValidationErrors is asked for again twice, because a check may still be
running; then the script stops.

**Measured, and worth knowing:** with the checker's worker stopped, ConfigHub
still showed it `Ready` 25 minutes later, and never started its six-hour
fail-open clock. A change made in that window was never checked and was
released. Both gates read a missing result as a pass. A required check is the
gate to rely on. Reported to ConfigHub as confighubai/confighub#5530.

## 0.6.0, 2026-09-28

**Live status from Sveltos: `cub sveltos status`** (#33). It tells ConfigHub
what Sveltos delivered to each cluster. For each delivery profile, it reads the
ClusterSummary Sveltos keeps and the variant's published releases, and writes
the variant's `confighub.com/live-status`:
- Synced and Healthy, with the digest of the release the cluster runs, worked
  out from release and apply times
  ([why](user/onboard-your-sveltos-fleet.md#live-status-in-confighub));
- OutOfSync while a newer release waits;
- Degraded when Sveltos reports a failure.

Run it once, or with `--watch`.

**Delivery profiles carry health checks.** Each one lists `validateHealths`
for the Deployments, StatefulSets and DaemonSets its charts deliver, named one
by one. Sveltos then reports the profile `Provisioned` only once they are
available.
- A source profile's own checks are kept.
- A check it ran after its Helm charts now runs after the delivered
  Resources.

Sveltos runs these checks when it applies a release, not continuously, like
Helm's post-install hooks. Its ClusterHealthCheck watches continuously;
reading it is #71.

**Measured on kind:**
- with a `Healthy` prerequisite in the workflow, ConfigHub refused to promote
  into uat while test's new release was not applied yet;
- the promotion went through once `status` reported test Synced and Healthy.

**A cluster that joins is proposed, and ships once approved: `cub sveltos
watch`** (#41). Each minute it plans the saved profiles against the
SveltosClusters. For a cluster a profile newly selects, it runs `apply.sh` with
`PROPOSE_ONLY=1`, which makes the cluster's variants and approves nothing. The
release order waits in the new cluster's own stage, since a stage with nothing
new needs no approval. Once a person approves, the next look publishes the
release and applies the delivery profile. It records why it proposed each
variant, on its Space and in the order's description. A cluster no profile
selects gets nothing, and is named. See [When a cluster
joins](user/onboard-your-sveltos-fleet.md#when-a-cluster-joins).

Recorded on the Meridian kind fleet: a prod cluster registered at 13:06 was
proposed at 13:10 and waited. After the approval at 13:16 it was delivered, and
reported `Provisioned` at 13:20.

**`apply.sh` decides what to release from the published releases.** A re-run
skips a profile once every variant has a published release, before it makes a
change order. The order's own stage cannot say this: ConfigHub resolves an
order that carries no change for a freshly cloned variant, while that variant
still waits for its first release.

**`PROPOSE_ONLY=1 bash apply.sh`** is the same by hand. A release that needs
approval waits instead of failing. The stages after it wait too, and a
delivery profile waits for its variant's first release.

**Each delivery profile is labelled with its variant**:
`sveltos.confighub.com/variant: <variant Space>`. So one cluster's profile can
be applied alone (`kubectl apply -f management/<profile>.yaml -l …`) or listed.

**Starting something new** is documented. Write the ClusterProfile you would
have given Sveltos, and plan from it. It was measured with cert-manager on the
Meridian slice's two prod clusters.

## 0.5.1, 2026-09-28

**The handover compares what ConfigHub releases with what Helm installed.**
Before `handover.sh` changes anything, it runs `cub sveltos compare` for each
live chart on each cluster. The comparison is between:
- what ConfigHub last released for that cluster's variant;
- the manifest Helm recorded when Sveltos installed the chart there.

It reads Helm's record through the cluster's kubeconfig Secret on the
management cluster, the way Sveltos reaches the cluster.

- **They match** when the chart rendered the same for ConfigHub as it did on
  the cluster. The handover goes ahead.
- **They differ** when a chart branches on the cluster's Kubernetes version or
  APIs (`.Capabilities`), reads the cluster with `lookup`, or when the values
  moved on. The handover stops and names each difference, for example
  `Deployment kyverno/kyverno-admission-controller: spec.replicas is 3 on the
  cluster, 1 stored`. `ACCEPT_DIFFERENCES=yes bash handover.sh` hands over
  anyway.
- **A cluster the script cannot reach stops it too.** Sveltos often reaches a
  cluster at an address only the management cluster resolves, as with kind
  and many Cluster API setups. Set `CLUSTER_KUBECONFIGS` to a directory of
  `<cluster>.kubeconfig` files that reach them from where you run the script.
- **A cluster in pull mode** cannot be read from the management cluster. It
  is named as not compared.

**The chart rules are a package,**
[`chartrender`](../chartrender/README.md), for anything else that flattens
Helm charts into ConfigHub, such as a Flux HelmRelease or an Argo CD chart
source. It holds:
- an exact chart version;
- a rendering that repeats byte for byte;
- the hooks it left out, named;
- no stray line;
- the command to record beside the rendering;
- the comparison with a Helm release record.

**Rehearsed end to end on the release,** with the [Meridian
slice](../examples/meridian-slice/README.md):
- the three live profiles passed the export checks;
- each of the four clusters matched Helm's record object for object;
- the handover reinstalled nothing.

## 0.5.0, 2026-09-27

**The base holds what your charts render to.**
- Each chart in a profile is rendered with its values by `cub helm template`,
  ConfigHub's own Helm renderer, into one unit. It is stored in the order the
  command prints it.
- `apply.sh` records the command above each chart's unit, and `apply` writes
  the chart's values beside it, so the next version is rendered the same way.
- Each ConfigMap a profile names in `policyRefs` becomes a unit of the
  objects in it.

**One delivery profile per variant.** On the management cluster, each
variant gets one ClusterProfile, named `<profile>-<cluster>`:
- `clusterRefs` names its one cluster;
- one `policyRefs` entry reads the variant's latest approved release from
  ConfigHub's OCI gateway, every minute.

It keeps your profile's other settings: `syncMode`, `tier`, Secret
references, `kustomizationRefs`, `patches`. `dependsOn` is renamed to the
delivery profiles. See the [annotated delivery
profile](images/sveltos/sveltos-delivery-profile.svg).

**Classes differ in real fields and objects.** With `--class-label`:
- a class base holds what its class's values render differently, such as
  fields (each one protected) or whole objects (a PodDisruptionBudget Kyverno
  adds above one replica);
- the root is the class whose objects every other class also has.

**The handover leaves first, then delivers.** `handover.sh` was called
`takeover.sh` before 0.5.
1. It sets each live profile to `stopMatchingBehavior: LeavePolicies` and
   deletes it. A profile another depends on goes after its dependents,
   because Sveltos holds its deletion until they are gone.
2. Then it applies the delivery profiles, which adopt what is there. No object
   ever has two profiles managing it.

Measured: every long-running pod kept its identity, and Helm stayed at the
revision it had.

**Checks before the handover changes anything.** `handover.sh` stops, and
asks for a fresh export, if since the export:
- a live profile changed (its uid or generation);
- it reaches other clusters;
- a ConfigMap of policies changed.

**The plan refuses what cannot be held as the running chart:**
- a chart at a version range (`1.2.x`, `^1.2.0`);
- a chart read from a Flux source (`gitrepository://`, `ocirepository://`,
  `bucket://`);
- a chart that renders differently each time.

**The plan also names profiles that would come back after the handover:**
- a profile another object owns, such as a ClusterPromotion's, is skipped;
- a live profile Flux, Argo CD or Helm applies is named, with the order to
  hand it over in its source. `handover.sh` stops while it is still there.

**Helm hooks follow Sveltos's lead.**
- A chart whose hooks run at install is a problem in the plan until
  `--include-hooks <release>`. Its delivery profiles then mark the hooks
  `projectsveltos.io/driftDetectionIgnore`, as Sveltos treats hooks under
  Helm.
- Measured: a self-deleting hook Job ran once, and once more with the next
  release. Without the mark, it was recreated ten times in ninety seconds.
- Hooks for upgrade, delete or test are left out, and named.

**Delivery profiles always set `continueOnError: true`.** A chart that lists
a custom resource before its CRD, such as NVIDIA's GPU operator, otherwise
stops a fresh cluster at the first object, on every retry.

**Promotions use `--squash`.** Without it, a promotion replays the functions
a change was made with. A function run at the root then reaches a class's
clusters, even though the class base protected the field (reported as
confighubai/confighub#5529).

**Also in 0.5.0:**
- **The worker:** `apply.sh` creates the Targets' server worker with
  `cub worker create --is-server-worker`, and `worker.json` is gone.
- **A stray line from `cub helm template`** (`$comment$head$: ""`, 26 in
  Kyverno 3.8.1) is dropped at render, because ConfigHub keeps it when a unit
  is updated.
- **Each base unit is checked** to hold every object of its file.
- **Review a chart upgrade object by object:**
  `cub unit diff --space <base> <unit> --from=-1 -o mutations`.

## Upgrading from 0.4

**A fleet onboarded with 0.4 is not converted, and moving one has not been
rehearsed.** Its bases hold ClusterProfiles with values strings, and Sveltos
installs those charts with Helm. The outline:

1. Plan again from the profiles 0.4 saved (`onboard/profiles.yaml`), into new
   Spaces, and write the steps:

   ```bash
   cub sveltos apply onboard/profiles.yaml clusters.yaml --prefix <new-prefix> <your options> --out onboard-0.5
   ```

2. Before you run the new `apply.sh`, step the 0.4 delivery profiles aside:
   set `stopMatchingBehavior: LeavePolicies` on each, then delete it. The
   plan leaves profiles that come from ConfigHub alone, so it does not do
   this for you.
3. Run the new `apply.sh`. Its delivery profiles adopt what is there.
4. Remove Helm's release records, which leaves the objects:
   `kubectl -n <namespace> delete secret -l owner=helm,name=<release>` on
   each cluster.

**You now need the cub helm plugin at v0.1.1 or newer:**

```bash
cub plugin install confighub/cub-helm
```

v0.1.0 created empty units against today's server while reporting success.

**Sveltos must still be v1.14.0 or newer on the management cluster.** Earlier
releases cannot read the gzipped layers ConfigHub's gateway serves.

## Recorded on kind, stock Sveltos v1.15.0

| Example | What it shows |
| --- | --- |
| [Onboarding example](../examples/onboard/README.md) | Three live label-selector profiles (Kyverno, its policies, ingress-nginx) handed over with nothing reinstalled. Kyverno 3.8.2 and 4 replicas in one change order, staging before prod. A joining cluster gets both. |
| [The GPU operator](../examples/gpu-operator/README.md) | NVIDIA's operator on exactly the clusters approved for it; a mislabel ships nothing. The driver upgrade reaches staging first, and review lists the ClusterPolicy's `spec.driver.version` and what the chart changed besides. |
| [A slice of Meridian](../examples/meridian-slice/README.md) | Three profiles, one per class, become a root base, three class bases and four deployments. One root change reaches every class, and uat and prod keep their replicas. Recorded on 0.5.1, with the handover's checks. A cluster that joins is proposed by `cub sveltos watch` and ships once approved, recorded on 0.6.0. |

## 0.4.0, 2026-09-27

**Class bases: `--class-label <label>`.** A middle level between each base and
its clusters: one class base per value of a cluster label (Meridian's test,
uat and prod), each a variant of the root base, and each cluster's variant
cloned from its class base.
- Profiles that each pin one class and otherwise install the same charts become
  one component. Each class base departs in exactly what its profile differs in.
- The rollout workflow gains a first stage, `bases`, which carries a change into
  the class bases without releasing it.
- Spaces carry the labels `Component`, `Role` (base or deployment) and
  `Cluster`.

Recorded on kind with a slice of Meridian: Kyverno 3.8.1 to 3.8.2 went root,
class bases, then test, uat and prod in order, and each class kept its
replicas. In this version a base still held each Sveltos ClusterProfile, with a
chart's settings as a Helm values string; 0.5 replaced that.

## 0.3.0, 2026-09-27

**The GPU operator, on exactly the clusters approved for it**
([the example](../examples/gpu-operator/README.md)).
- Labelling a new cluster ships nothing by itself: planning again proposes its
  variant, and it ships once released.
- A mislabelled cluster gets nothing.
- An operator and driver upgrade reached staging first; prod was refused until
  then.
- kind has no GPUs, so no driver runs there.

**Fix:** a cluster joining a stage the workflow did not have could not be
promoted. `apply.sh` now adds only the missing stages, and keeps approval
settings made in ConfigHub since.

## 0.2.0, 2026-09-27

**Kyverno policies come into ConfigHub with their profile.**
- Each ConfigMap a profile's `policyRefs` names becomes a unit beside the
  profile, and each variant gets its own copy.
- A ConfigMap missing from the input is named, with the `kubectl` command to
  export it.
- `takeover.sh` (`handover.sh` from 0.5) names the original ConfigMap as no
  longer read.

Recorded on kind: a policy change from Audit to Enforce reached staging first.
A `:latest` pod was refused on staging and admitted on prod, until prod's own
approval and release.

## 0.1.0, 2026-09-27

**The first release as a `cub` plugin:** `cub plugin install
confighub/sveltos-confighub`.
- **`cub sveltos plan`** reads your ClusterProfiles and clusters, and shows
  what ConfigHub would hold. It changes nothing.
- **`cub sveltos apply`** writes the files and a script, `apply.sh`, to read and
  then run, and `takeover.sh` for live profiles.
- Each profile became a base with a variant per cluster, each bound to a Target
  and released stage by stage, and Sveltos delivered each variant's release.

Tested live: a `podinfo` profile went through plan, apply, `apply.sh` and
`takeover.sh`, and its Helm release stayed at revision 1 with the same pod.
