# chartrender

Renders a Helm chart to the objects ConfigHub holds, with the rules that make
a rendering stand for what runs. `cub sveltos` uses it to flatten the charts
of Sveltos ClusterProfiles. Anything else that flattens charts into ConfigHub
can use the same rules: a Flux HelmRelease, or an Argo CD chart source.

```go
import "github.com/confighub/sveltos-confighub/chartrender"

c := chartrender.Chart{
	Release: "edge-router", Ref: "edge-router", Repo: "https://charts.example.com",
	Version: "2.4.1", Namespace: "ingress", Values: values,
}
if !chartrender.ExactVersion(c.Version) {
	// refuse: "2.4.x" renders whatever is newest that day
}
r, err := chartrender.Render(chartrender.CubHelm, c)
switch {
case errors.Is(err, chartrender.ErrNotRepeatable):
	// refuse, or leave the source to render late: it mints values per render
case err != nil:
	// the chart does not render
}
// r.Objects is the text to store as the unit.
// r.Hooks are the hook manifests left out; see AtInstall.
// Record how it was rendered, beside it:
recorded := strings.Join(c.Command("values.yaml"), " ") + " | " + chartrender.Filter
```

## The rules, and why

| Rule | Why |
| --- | --- |
| One exact version (`ExactVersion`) | `cub helm template --version` also takes a range. A range renders whatever is newest when it is rendered, which need not be what the cluster runs. |
| The same bytes twice (`Render`) | A chart that mints a password or a certificate per render, or reads `lookup`, cannot be held as one reviewed set of objects. |
| Hooks named (`HooksOf`, in `Render`) | Only Helm runs hooks. An install hook's work is missing from plain objects unless something routes it: `cub sveltos` refuses such a chart until it is told to keep its hooks as plain objects, which its delivery marks `projectsveltos.io/driftDetectionIgnore`. Hooks for upgrade, delete or test are left out, and named. |
| No stray line (`DropStrayLines`, `Filter`) | `cub helm template` prints `$comment$head$: ""` at the top of some documents (26 in Kyverno 3.8.1). ConfigHub drops it when a unit is created, but keeps it when a unit is updated, so a chart upgrade would carry it into review and to the clusters. |

Measured on kind with stock Sveltos v1.15.0 and ConfigHub production; see
[the onboarding rehearsal record](../docs/planning/onboarding-rehearsal.md).

## In helm-expt's terms

In the four flattening verdicts helm-expt records, a chart that passes these
rules with no hooks is `safe-to-flatten`. One with install hooks is
`flatten-with-routes`: each hook needs a route. Hooks for upgrade, delete or
test are left out; whether that loses something, an upgrade hook that
migrates CRDs say, is a judgement per chart. `ErrNotRepeatable` has no route
here: `unsafe-to-flatten`, and the source stays authoritative.

## Comparing with what Helm installed

`Compare` compares a release's manifest, the objects Helm installed and
recorded, with the objects stored to replace it. It returns what is the
same, each difference by object and field path, and notes for what Helm
keeps out of its manifest: hooks, the release's Namespace, and a chart's
`crds/` directory. A key set to null counts as absent, as Kubernetes reads
it. `ReleaseManifest` reads the manifest out of a Helm release Secret's
`data.release`.

`cub sveltos compare` uses both before a handover, and so can anything that
takes a release over from Helm. It catches what the rules above cannot: a
chart that rendered differently on the cluster, through `.Capabilities` or
`lookup`.

## What it does not decide

- **The cluster's Kubernetes version and APIs.** `cub helm template` renders
  `.Capabilities` for a default cluster. A chart that branches on them can
  render other objects than the cluster runs; `Compare` finds them.
- **A deterministic `lookup`.** It renders the same twice, but not what it
  found on the cluster; `Compare` finds that too.
- **`helm.sh/resource-policy: keep`.** Helm keeps such an object when it
  leaves the chart; plain delivery removes it.
- **How the objects are delivered.** That belongs to the delivery runtime.
