# Onboarding rehearsals

What [Onboard your Sveltos fleet](../user/onboard-your-sveltos-fleet.md)
claims was measured by running it, as a user already running Sveltos would,
on kind clusters with stock Sveltos v1.15.0 and one ConfigHub organization.

## The flattened model, 2026-09-27

Since #58, `cub sveltos` holds each cluster's configuration as the Kubernetes
objects it runs: each chart rendered by `cub helm template`, each policy
ConfigMap as the objects it holds. One delivery profile per variant on the
management cluster sends that variant's release to its one cluster.
[examples/onboard/run.sh](../../examples/onboard/run.sh) ran the example
fleet's whole journey; the output is
[rehearsal-2026-09-27.log](../../examples/onboard/rehearsal-2026-09-27.log).

| Step | Measured |
| --- | --- |
| Before | Three label-selector profiles live: Kyverno 3.8.1 (admission controller at 3 replicas) and its `disallow-latest-tag` policy on staging-eu, prod-eu and prod-us; ingress-nginx 4.15.1 on the two prod clusters |
| Plan, apply | Kyverno rendered to 71 objects (22 CRDs), ingress-nginx to 19 with its install hooks kept, the policy ConfigMap to its ClusterPolicy; 13 Spaces, 8 Links. `apply.sh` ran all six steps; the live profiles kept managing everything |
| Handover | `handover.sh` stepped the three live profiles aside, the policies before Kyverno, which they depend on, then applied the eight delivery profiles. All eight reported `Provisioned`; every long-running pod and the ClusterPolicy kept its UID; each Helm release stayed at revision 1 until its record was removed |
| A chart upgrade and a field, one change order | Kyverno 3.8.2 rendered with the command `apply.sh` records and stored on the base, then the admission controller set to 4 replicas. The base's diff showed exactly those: the five images and `replicas: 3` to `4`. ConfigHub refused prod until staging had released; staging-eu, then prod-eu and prod-us, ran 3.8.2 at 4 replicas; the change order finished `Completed` and `Released` |
| A cluster joins | staging-us registered; Sveltos put nothing on it by itself. Planning again from `onboard/profiles.yaml` and a fresh cluster list, `apply.sh` cloned its variants from the bases as they stood and released them; it ran 3.8.2 at 4 replicas, with the policy |

### What the rehearsals of the flattened model changed

Each of these was found by a run that failed or misbehaved, and fixed before
the run above:

1. **A handover deadlocked.** Sveltos holds a profile's deletion, `Blocked`,
   while another profile depends on it. The handover now steps dependents
   aside first.
2. **Handing over while both ran had side effects.** With the delivery
   profiles applied beside the live ones, `policyRefs` objects sat in
   conflict, and a live profile with drift detection took the delivery
   profile's first write as drift and ran one more `helm upgrade`, hooks and
   all. The live profiles now leave first, and the delivery profiles come
   after.
3. **A long promotion outlasted its request.** Each revision of Kyverno's
   5 MB unit takes about 30 seconds to promote; promoting two variants took
   about 90, and cub reported `no response body from server` while the server
   finished. The scripts ask again, and treat `nothing left to promote` as
   done.
4. **The review diff was all moves.** Onboarding had reordered the rendered
   objects, Namespace and CRDs first, so rendering the next version with
   `cub helm template` changed every line. Sveltos creates a missing
   Namespace before applying into it (measured: a fresh cluster took a
   rendering whose Namespace came last), so a chart is now held in the order
   `cub helm template` prints it, and the diff shows only what changed.
   (Later measured: ConfigHub lays out the YAML its own way when a unit is
   created, and keeps an update as given, so for some charts a text diff
   also shows layout. `cub unit diff -o mutations` compares objects and
   fields, and shows only what changed.)
5. **A kept hook Job ran forever.** ingress-nginx's certificate jobs delete
   themselves when they finish (`ttlSecondsAfterFinished: 0`). As plain
   objects under drift detection, Sveltos recreated one ten times in a minute
   and a half. Sveltos does not watch hooks when it runs Helm, and skips any
   object annotated `projectsveltos.io/driftDetectionIgnore`; the delivery
   profile now adds that annotation to hook objects with a patch. Measured:
   the Job ran once, stayed gone, and ran once more with the next release.
6. **cub-helm v0.1.0 created empty units** against today's server while
   reporting success; v0.1.1 is needed. The empty variant it led to was
   published and reported `Provisioned`, so a variant missing a unit is now
   never released.

Two more came from the GPU operator chapter and the Meridian slice, recorded
after the run above; neither changes what that run exercised, since its one
custom resource, the Kyverno policy, comes through its own delivery profile
after Kyverno's (`dependsOn`), and it has no classes:

7. **A custom resource before its CRD stopped a fresh cluster.** The GPU
   operator's rendering, as `cub helm template` prints it, lists its
   ClusterPolicy before the ClusterPolicy CRD. Sveltos stops at the first
   object that fails, so a cluster joining with nothing installed got
   nothing, on every retry. With `continueOnError: true` the CRDs land in the
   same pass and the ClusterPolicy on a retry, two minutes later. Delivery
   profiles now always set it: a profile exported from a live cluster says
   `false` by default, which is no choice.
8. **A root change reached a class's clusters past the class's
   protection.** In the Meridian slice, the root set the admission controller
   to 4 replicas with `set-yq`. Each class base kept its protected value (2
   for uat, 3 for prod), yet the promotion from each class base replayed the
   recorded `set-yq` on its clusters, which went to 4. A three-Space
   reproduction (`replay-root`, `replay-class`, `replay-cluster`, kept) shows
   the cluster keeping its class's value when promoted with `--squash`, which
   takes each change as one diff, and taking the root's without it
   (confighubai/confighub#5529). Every promotion now uses `--squash`.

### ConfigHub behaviour measured on the way

- **Protection holds on real fields.**
  - `cub unit set-protection` on `spec.replicas` kept a variant's value when the base changed the same field. Measured the same way:
    - a named list entry (`spec.template.spec.containers.?name=kyverno.resources.limits.memory`);
    - a whole unkeyed list (`spec.template.spec.tolerations`).
  - An unprotected override took the base's value.
  - Protecting a path the unit does not have is refused: `paths not found in unit data`.
- **A link's `MergeEnableSubtraction` did not keep an unprotected override.** The base's value won both when set by a function and when set by a full update.
- **`cub variant create` makes one upgrade Link per unit.** A chart split into one unit per template file, as `cub helm install` does, costs a Link per file per cluster (Kyverno: 57), so onboarding holds one unit per chart.
- **`upsert-resource` takes a JSON ResourceList,** the shape `get-resources` returns, not YAML.
- **handover.sh's comparison with what Helm installed, measured on a real Sveltos Helm release** (podinfo 6.7.1, installed by a live ClusterProfile on kind):
  - Helm's record, read through the cluster's kubeconfig, compared the same with `cub helm template`'s rendering at the same values (two objects, and the release's Namespace as a note). This held once a null value counted as absent: `cub helm template` prints `resources.limits: null` where Helm's record leaves `limits` out.
  - A replica count and a chart version changed were each named by field.
  - The Sveltos kubeconfig named `mer-test1-control-plane`, which only the management cluster's network resolves. That is why `CLUSTER_KUBECONFIGS` exists, and why an unreachable cluster stops the handover rather than being skipped.
- **`cub unit diff -o mutations` lists a change by object and field path,** and a whole new object as one entry. The GPU operator's upgrade is over 2,300 changed lines as text; as mutations it reads as 20 paths of the ClusterPolicy, 4 of the operator's Deployment, 12 of RBAC rules, 120 of CRD schema and 3 new CRDs.

## The first version, 2026-09-26

The first version stored each ClusterProfile itself, a chart's settings as a
Helm values string. Its record follows; its handover facts still hold, and
its note on values strings is why the model changed.

What [Onboard your Sveltos fleet](../user/onboard-your-sveltos-fleet.md)
claims was measured by running it, as a user already running Sveltos would,
on kind clusters: a management cluster and four workload clusters, stock
Sveltos v1.15.0 (`projectsveltos/addon-controller:v1.15.0`, no override),
Kubernetes v1.35.0, cub v0.6.2, and one ConfigHub organization. The full
output of the final run is in
[onboarding-rehearsal-2026-09-26.log](onboarding-rehearsal-2026-09-26.log);
it carries no credential.

The tool ran then as `npm run onboard`; it has since become the `cub sveltos`
plugin, which writes the same steps.

### The journey, and what each step showed

| Step | What the user ran | Measured |
| --- | --- | --- |
| Before | Two label-selector ClusterProfiles live: kyverno on `env In [staging, prod]`, ingress-nginx on `env=prod` | Five Helm releases on three clusters, 20 pods recorded |
| Plan | `kubectl get clusterprofiles,sveltosclusters -A -o yaml`, then `npm run onboard -- plan` | Two bases, five variants, stages staging then prod; both profiles flagged live |
| Apply | `npm run onboard -- apply`, then `bash onboard/apply.sh` | All six steps ran; each per-cluster profile arrived and waited: `cannot manage chart ... ClusterSummary ... managing it`; the live profiles kept managing |
| Handover | `bash onboard/takeover.sh` | Every per-cluster profile `Provisioned`; every Helm release at the revision it had; all 20 pods the same (by UID): nothing reinstalled |
| A change | The guide's day-two commands, kyverno admission controller 3 to 4 replicas | staging-eu ran 4 while both prod clusters held 3; prod promoted only after staging released; then all ran 4 |
| A cluster joins | Registered `staging-us` (env=staging); re-plan with `onboard/profiles.yaml` and a fresh cluster list; re-run `apply.sh` | Sveltos put nothing on it by itself; the script left every existing variant as it was, cloned the new one from the base as it stood, and released it through both stages; staging-us ran 4 replicas, the change it joined after |

Delivery ran on the credential the guide recommends: the Targets' server
worker as `username` and `password` in the gateway Secret. Sveltos's ORAS
client exchanges them at the gateway's token endpoint, and the gateway lets
a Target's own worker pull that Target's releases.

### What the rehearsals changed in the tool

Earlier runs the same evening found six things, each fixed before the final
run above:

1. **Two profiles, two change orders called `baseline`.** A release named
   `ChangeOrder:baseline` was refused as ambiguous across Spaces. Releases
   now name the change order with its base Space.
2. **A finished change order cannot be promoted again.** Re-running the
   first release failed with `has completed ChangeWorkflow ... nothing left
   to promote`. The script now asks ConfigHub where each release stands and
   skips a finished one.
3. **A second onboarding locked the first out.** Both used one gateway
   Secret, the second overwrote it with its own worker, and every fetch of
   the first fleet failed with `403 Forbidden`. Each Targets Space now has
   its own Secret.
4. **A re-run wrote over a later change.** Re-storing each variant from the
   onboarding files put the original values back as a new head revision.
   Departures are now stored only on a fresh clone (head revision 2).
5. **A joining cluster would have missed earlier changes.** Its departures
   were written as a whole document from the original profile. They are now
   applied with `cub function set ... set-yq`, touching only their own
   fields, so the clone keeps what the base holds today; a probe confirmed
   the variant keeps its lineage and inherits later base changes.
6. **The organization's Space quota.** Rehearsals hit it (100 Spaces). The
   plan now states the Spaces it needs as well as the Links.

### ConfigHub behaviour measured on the way

- Promoting a stage again, or approving it again, succeeds and changes
  nothing. Publishing a release that is already published is refused with
  `no changes were made since :latest bundle`.
- A variant with nothing new under a change order counts as released for it,
  even though its publish is refused that way, and the next stage opens. This
  is what lets a joining cluster be released without touching the others.
- A per-cluster profile that reported `FailedNonRetriable` while another
  profile managed its release took the release over by itself within a
  minute of that profile being deleted with `LeavePolicies`.
- `cub unit get -o json` answers `HeadRevisionNum`; a fresh clone is at 2.
- A variant of a variant works as a class base (2026-09-27). A workflow stage
  with no release prerequisite carries a change into the class bases. The
  change order still reaches `Completed` and `Released`, although the class
  bases never publish. A class base's departure in one key of a map, and a
  root change to another key of the same map, both survived the promotion.
- Inside a Helm values string, measured the same day on throwaway Spaces
  (`valprobe-*`):
  - A root change to one setting and a class override of another both
    survived, so ConfigHub merges inside the string.
  - A root change to the setting the class overrides replaced the override,
    with no conflict reported.
  - `cub unit set-protection` on `spec.helmCharts.0.values` was recorded and
    listed as "preserved during merges", yet the next promotion overwrote it.
    ConfigHub tracks the chart-list entry by a content hash, not by position.
  - The older runner note, and the first version of the class-base docs,
    said the override wins. That is not what ConfigHub does now.

### The handover with plain resources

A second run the same night, on a management cluster and one workload
cluster ([log](onboarding-rehearsal-policyrefs-2026-09-26.log)), repeated the
handover for a live profile that deploys a Namespace and a ConfigMap through
`policyRefs`. While both profiles existed, the per-cluster one reported `A
conflict was detected while deploying resource Namespace:/demo-policyrefs`
and nothing changed. After `takeover.sh` it reported `Provisioned`, and both
objects kept their UIDs: nothing was deleted or recreated. The ConfigMap the
profile names stays on the management cluster; ConfigHub governs the profile.

### The plugin

On 2026-09-27 the same path ran through the installed `cub sveltos` plugin,
built from this repository and installed with `cub plugin install`, whose
hook wrote its manifest ([log](onboarding-rehearsal-plugin-2026-09-27.log)):
a live `podinfo` profile, `cub sveltos plan`, `cub sveltos apply`,
`apply.sh`, then `takeover.sh`. The release stayed at revision 1 with the
same pod.

### Kyverno policies

Also on 2026-09-27 ([log](onboarding-rehearsal-kyverno-2026-09-27.log)), on a
management cluster and a staging and a prod cluster: a live `kyverno-policies`
profile deploying a `disallow-latest-tag` ClusterPolicy from a ConfigMap was
onboarded together with its ConfigMap (#53). Each variant received its own
copy of the ConfigMap from ConfigHub, and the handover left both
ClusterPolicy objects unchanged. The policy was then changed from Audit to
Enforce on the base: after staging's release a `:latest` pod was refused on
staging and admitted on prod; after prod's own approval and release, prod
refused it too.

### The GPU operator

Chapter seven ([examples/gpu-operator](../../examples/gpu-operator/README.md))
ran the same path for NVIDIA's GPU operator, with the `h100-any` recipe on
kind. The live label-selector profile handed over with the same release and
operator pod. A newly labelled cluster received nothing until its variant was
released through the prod stage, which a re-run added to the workflow. A
mislabelled cluster received nothing. The operator and driver upgrade reached
staging before prod. Kind has no GPUs, so no driver ran.

### Class bases: a slice of Meridian

Also on 2026-09-27 ([examples/meridian-slice](../../examples/meridian-slice/README.md)):
three per-class Kyverno profiles on four Meridian-named kind clusters became
one component with `--class-label class`, a root base, three class bases and
four deployments. The handover kept every release and each class's replicas.
A Kyverno 3.8.1 to 3.8.2 upgrade on the root went through the class bases,
then test, uat and prod in order, and each class kept its replicas.

### Not measured

The handover with Kustomize profiles; Cluster API clusters as input;
namespaced `Profile` objects; EventTrigger-made profiles. The guide says so
where each would matter.
