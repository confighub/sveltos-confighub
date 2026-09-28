# Sveltos on ConfigHub

Run your Kubernetes add-ons with [Sveltos](https://projectsveltos.io), and
manage every change to them in [ConfigHub](https://confighub.com): reviewed,
approved, rolled out staging before prod, and on record afterwards.

This repository has three things:
- **the integration:** how Sveltos and ConfigHub work together;
- **the plugin, `cub sveltos`:** it moves a fleet you already run with Sveltos
  onto ConfigHub;
- **examples you can run on your laptop.**

## How it fits together

```mermaid
flowchart LR
  you["You, or an AI assistant"] -->|"make a change once"| base["ConfigHub<br/>base"]
  base --> a["variant<br/>staging-eu"]
  base --> b["variant<br/>prod-eu"]
  base --> c["variant<br/>prod-us"]
  a -->|"approved release"| sv["Sveltos<br/>management cluster"]
  b -->|"approved release"| sv
  c -->|"approved release"| sv
  sv --> ca["cluster staging-eu"]
  sv --> cb["cluster prod-eu"]
  sv --> cc["cluster prod-us"]
```

- **ConfigHub holds what each cluster runs.** For every add-on, a **base**
  holds the Kubernetes objects its Helm chart renders to, and each cluster has
  a **variant** of that base.
- **You change the base once.** The change reaches every cluster's variant,
  stage by stage: staging first, then prod, with an approval in each stage.
- **Sveltos delivers.** For each cluster, one small Sveltos profile fetches
  that cluster's latest approved release from ConfigHub and applies it. If
  anyone edits the cluster by hand, Sveltos puts it back.

You keep Sveltos. You gain a review of every change, a record of which
revision each cluster runs, and a rollout order that ConfigHub enforces.

## The plugin: `cub sveltos`

```bash
cub plugin install confighub/sveltos-confighub
cub plugin install confighub/cub-helm        # renders charts; v0.1.1 or newer
```

| Command | What it does |
| --- | --- |
| `cub sveltos plan` | Reads your Sveltos ClusterProfiles and clusters, and shows what ConfigHub would hold. **Changes nothing**, and needs no account or cluster. |
| `cub sveltos apply` | Writes the plan out as files and a script, `apply.sh`, for you to read and then run. Writes `handover.sh` too, if your profiles are live. |
| `cub sveltos compare` | Checks that what ConfigHub will deliver to a cluster is exactly what Helm installed there. `handover.sh` runs it for you. |
| `cub sveltos status` | Tells ConfigHub what Sveltos delivered to each cluster: synced, healthy, and which release it runs. New, not released yet. |
| `cub sveltos version` | Prints the version. The current release is **v0.5.1**; see [what's new](docs/whats-new.md). |

After onboarding you don't need the plugin day to day: changes are made with
ConfigHub's own `cub` commands, shown below.

You need the `cub` CLI (`cub auth login`), `kubectl` access to your Sveltos
management cluster, and Sveltos v1.14.0 or newer.

## What you can do with it

### 1. Bring the fleet you already run into ConfigHub

Export what Sveltos knows, and see the plan. Nothing changes yet:

```bash
kubectl get clusterprofiles,sveltosclusters -A -o yaml > my-fleet.yaml
cub sveltos plan my-fleet.yaml --stage-label env --stages staging,prod
```

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

Then write the steps, read them, and run them:

```bash
cub sveltos apply my-fleet.yaml --stage-label env --stages staging,prod --out onboard
MGMT_CONTEXT=<your management cluster context> bash onboard/apply.sh
MGMT_CONTEXT=<your management cluster context> bash onboard/handover.sh   # if your profiles are live
```

The handover moves each cluster over to ConfigHub with nothing reinstalled.
Before it changes anything, it checks that your profiles are still what you
exported, and that each cluster runs exactly what ConfigHub will deliver. If
not, it stops and says why.

![Before and after the handover: one label-selector profile installing Kyverno on three clusters becomes a ConfigHub base with one variant per cluster, delivered by one Sveltos delivery profile per variant to the same clusters, with nothing reinstalled](docs/images/sveltos/sveltos-handover-before-after.svg)

### 2. Start something new

You don't need a profile that already runs. Write the ClusterProfile you
would have given Sveltos: which clusters, by label, and which chart. It is
only a description; you never apply it to the management cluster.

```yaml
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: cert-manager
spec:
  clusterSelector:
    matchLabels:
      env: prod                     # every production cluster
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
cub sveltos apply cert-manager.yaml clusters.yaml --stage-label env --stages staging,prod --out cert-manager
MGMT_CONTEXT=<your management cluster context> bash cert-manager/apply.sh
```

ConfigHub gets a base for cert-manager and a variant for each production
cluster. Sveltos installs it on those clusters and nowhere else. On kind it
was running on both production clusters about 75 seconds after `apply.sh`
started.

### 3. Roll a change out to every cluster, staging first

Make the change once, on the base. Here, four replicas for Kyverno's
admission controller:

```bash
cub function set --space sveltos-kyverno-base --unit kyverno --change-desc "4 replicas" -- \
  set-yq '(select(.kind == "Deployment" and .metadata.name == "kyverno-admission-controller") | .spec.replicas) = 4'
cub changeorder create --space sveltos-kyverno-base replicas-4 \
  --change-workflow sveltos-kyverno-base/rollout --description "4 replicas"
```

Then take it through the stages. In each stage you promote, approve and
publish:

```bash
cub variant promote --change-order sveltos-kyverno-base/replicas-4 --target-stage staging --squash
cub variant approve --change-order sveltos-kyverno-base/replicas-4 --stage staging
cub release publish sveltos-kyverno-staging-eu --revision ChangeOrder:sveltos-kyverno-base/replicas-4
```

Sveltos delivers it to staging within a minute. ConfigHub refuses to start
prod before staging has released the change:

```text
Failed: unable to promote to stage 'prod', Variant 'staging-eu' has taken change order 'replicas-4' but has not released it
```

### 4. Upgrade a chart, and review exactly what changes

`apply.sh` records the command each chart was rendered with. Render the new
version the same way, and store it on the base:

```bash
cub helm template kyverno kyverno --repo https://kyverno.github.io/kyverno --version 3.8.2 \
  --namespace kyverno --create-namespace -f onboard/kyverno/kyverno.values.yaml \
  | grep -vxF '$comment$head$: ""' > kyverno.yaml
cub unit update --space sveltos-kyverno-base kyverno kyverno.yaml --change-desc "Kyverno 3.8.2"
cub unit diff --space sveltos-kyverno-base kyverno --from=-1 -o mutations
```

The review lists each changed field, object by object. It shows the chart's
new images, and anything else the chart changed besides your values, such as
new RBAC rules or CRDs. Here is part of the GPU operator's upgrade from
v26.3.1 to v26.7.0:

```text
Resource: nvidia.com/v1/ClusterPolicy /cluster-policy
  ~ [Update] spec.driver.version
  ~ [Update] spec.toolkit.version
  ~ [Update] spec.devicePlugin.version
Resource: apiextensions.k8s.io/v1/CustomResourceDefinition /gpuclusters.nvidia.com
  + [Add]
```

Then roll it out as in 3.

### 5. Give each environment, or each kind of cluster, its own settings

If you keep one Sveltos profile per environment (say `kyverno-test`,
`kyverno-uat`, `kyverno-prod`), onboard them as one add-on with a **class
base** per environment:

```bash
cub sveltos plan my-fleet.yaml --class-label class --stage-label class --stages test,uat,prod
```

Each class base holds only what its class differs in, such as its replica
count or an extra PodDisruptionBudget, and keeps it protected. A change made
once at the root reaches every class, and each class keeps what it protects.
The same works for GPU types: one class per accelerator.

![One change at the root reaches three class bases; test takes 4 replicas, uat and prod keep their protected 2 and 3, and each cluster takes what its class holds](docs/images/sveltos/sveltos-meridian-three-levels.svg)

### 6. Add a new cluster

Label the new cluster as you always have. **Nothing ships yet**: in this
setup, a label alone deploys nothing. Plan and apply again, from the profiles
`apply` saved:

```bash
kubectl get sveltosclusters -A -o yaml > clusters.yaml
cub sveltos apply onboard/profiles.yaml clusters.yaml --stage-label env --stages staging,prod --out onboard
MGMT_CONTEXT=<your management cluster context> bash onboard/apply.sh
```

The new cluster gets its own variant, with every change made since
onboarding, and is released through its stage with an approval. A cluster
labelled by mistake gets nothing.

### 7. See what every cluster runs, whether it is healthy, and who changed it

```bash
cub space list --where "Labels.Cluster = 'prod-eu'"                  # everything on prod-eu
cub unit data --space sveltos-kyverno-prod-eu kyverno                # the exact objects it runs
cub revision list --space sveltos-kyverno-prod-eu kyverno            # every change, with who and why
cub changeorder get --space sveltos-kyverno-base replicas-4          # where a rollout has got to
cub sveltos status --context <management cluster context> --watch    # live status, from Sveltos
```

`cub sveltos status` writes what Sveltos delivered to each cluster into
ConfigHub, as its live status:
- **Synced and Healthy** once the latest release is applied and its workloads
  are available;
- **OutOfSync** while a newer release waits.

A change workflow can then hold each stage until the one before it is
healthy. On kind, ConfigHub refused to promote to uat while test's new
release was not applied yet. (New since v0.5.1; not released yet.)

Each change carries its author and a reason. Each stage's approval is
recorded. ConfigHub's refusals come in its own words, and that's the
record an audit needs.

### 8. Run it at business size

Sveltos brings the same three levels to a large fleet: a root base, class
bases, and a variant per cluster. That's the shape of ConfigHub's
**Meridian** demo fleet: 99 clusters across 8 regions and 4 classes.

The [Meridian slice](examples/meridian-slice/README.md) runs four of its
clusters for real, delivered by Sveltos. One change at the root reached every
class, test before uat before prod, and each class kept its own settings.
However big the fleet, a change costs the same: one edit, then one promotion
and one approval per stage.

### 9. Work with an AI assistant

Every step is a `cub` or `kubectl` command, so an assistant in your terminal
can do the work:

| You ask | It runs |
| --- | --- |
| "What would ConfigHub hold for my fleet?" | `cub sveltos plan …` |
| "Upgrade Kyverno to 3.8.2, and show me what changes" | `cub helm template …`, `cub unit update …`, `cub unit diff … -o mutations` |
| "Four replicas, for uat only" | `cub function set …` on uat's class base, then `cub unit set-protection …` |
| "Roll it out" | `cub changeorder create …`, then `cub variant promote … --squash` into each stage |

**Approval stays with people.**
- Each stage's release waits for `cub variant approve`.
- ConfigHub refuses a stage out of order.
- Set `AllowAuthors: false` in the change workflow, and whoever made a change,
  person or assistant, cannot approve it.

That's what makes a change an assistant prepared safe to accept.

## Try it on your laptop

Each example builds its own [kind](https://kind.sigs.k8s.io) clusters,
installs stock Sveltos v1.15.0, and runs the whole story against your
ConfigHub organization. Each has a recorded log of a real run.

| Example | What it shows |
| --- | --- |
| [Onboarding](examples/onboard/README.md) | Three live Sveltos profiles (Kyverno, its policies, ingress-nginx) handed over with nothing reinstalled. A Kyverno upgrade, staging before prod. A new cluster joining. |
| [The GPU operator](examples/gpu-operator/README.md) | NVIDIA's GPU operator on exactly the clusters approved for it; a mislabelled cluster gets nothing. The operator and driver upgrade reaches staging before prod. |
| [A slice of Meridian](examples/meridian-slice/README.md) | Three levels, from one Sveltos profile per class. One change at the root reaches every class, and each keeps its own replicas. |

```bash
node examples/onboard/kind-fleet.mjs      # build the kind fleet
bash examples/onboard/run.sh              # run the story
```

Every check in the repository also runs offline, with no account and no
cluster: `npm run verify` and `go test ./...`.

## Documentation

- [Onboard your Sveltos fleet](docs/user/onboard-your-sveltos-fleet.md): the
  full guide, from plan to handover to changes afterwards.
- [What's new in 0.5](docs/whats-new.md): what 0.5.0 and 0.5.1 changed, and
  how to move from 0.4.
- [Run your own fleet on one variant per cluster](docs/user/run-your-own-fleet.md):
  the shape at any size, what a change costs, and the limits measured here.
- [chartrender](chartrender/README.md): the chart rules, as a Go package for
  other tools.
- [The recorded chapters](docs/chapters.md): six chapters recorded on the
  first design of this integration, with their receipts.

## Status

`cub sveltos` v0.5.1 is tested on kind with stock Sveltos v1.15.0. It has not
run in a production fleet yet. `cub sveltos status`, which reports live status
to ConfigHub, is on main and not released yet. Rollback here restores one
cluster to an exact revision. There's no single action that halts and reverses
a rollout across the fleet.

This work was extracted from
[confighub/helm-expt](https://github.com/confighub/helm-expt) with paths
preserved, so every committed receipt verifies here unchanged.
