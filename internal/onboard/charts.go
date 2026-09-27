package onboard

import (
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/confighub/sveltos-confighub/chartrender"
	"gopkg.in/yaml.v3"
)

// Chart, Rendering, Renderer and Hook are chartrender's, which holds the rules
// that make a rendering stand for what runs, for anything that flattens charts
// into ConfigHub.
type (
	Chart     = chartrender.Chart
	Rendering = chartrender.Rendering
	Renderer  = chartrender.Renderer
	Hook      = chartrender.Hook
)

// CubHelm renders with cub helm template, ConfigHub's own Helm renderer, so a
// chart onboarded here holds the objects cub helm install would have written.
var CubHelm = chartrender.CubHelm

// Object is one Kubernetes object a unit holds.
type Object struct {
	APIVersion string
	Kind       string
	Namespace  string
	Name       string
	Node       *yaml.Node
	Value      map[string]any
}

// Resource is how ConfigHub names the object in a protected path:
// apps/v1/Deployment:kyverno/kyverno-admission-controller.
func (o Object) Resource() string {
	return fmt.Sprintf("%s/%s:%s/%s", o.APIVersion, o.Kind, o.Namespace, o.Name)
}

// Shown is the object as a person reads it.
func (o Object) Shown() string {
	if o.Namespace == "" {
		return o.Kind + " " + o.Name
	}
	return fmt.Sprintf("%s %s/%s", o.Kind, o.Namespace, o.Name)
}

// Select is the yq filter that picks this object out of a unit.
func (o Object) Select() string {
	ns := fmt.Sprintf(".metadata.namespace == %s", jsonString(o.Namespace))
	if o.Namespace == "" {
		ns = `(.metadata.namespace // "") == ""`
	}
	return fmt.Sprintf("select(.kind == %s and .metadata.name == %s and %s)", jsonString(o.Kind), jsonString(o.Name), ns)
}

func (o Object) id() string { return o.Kind + ":" + o.Namespace + "/" + o.Name }

// Unit is one unit of a base: a rendered chart, or the objects a policy
// ConfigMap holds.
type Unit struct {
	Slug    string
	Source  string
	Chart   *Chart
	Objects []Object
	// Hooks are the Helm hook manifests the rendering left out.
	Hooks []Hook
	// raw is a chart's rendering as cub helm template printed it, in its order
	// and without the stray line, so rendering the next version the same way
	// shows a reviewer only what changed.
	raw []byte
}

// Text is the unit's content: a chart's rendering as printed, or a policy
// ConfigMap's objects as YAML documents.
func (u Unit) Text() ([]byte, error) {
	if u.raw != nil {
		return u.raw, nil
	}
	nodes := make([]any, len(u.Objects))
	for i, o := range u.Objects {
		nodes[i] = o.Node
	}
	return EncodeYAML(nodes...)
}

func (u Unit) count(kind string) int {
	n := 0
	for _, o := range u.Objects {
		if o.Kind == kind {
			n++
		}
	}
	return n
}

// Summary says what the unit holds, for the plan.
func (u Unit) Summary() string {
	what := count(len(u.Objects), "object")
	if crds := u.count("CustomResourceDefinition"); crds > 0 {
		what += fmt.Sprintf(" (%s)", count(crds, "CRD"))
	}
	if u.Chart != nil && u.Chart.IncludeHooks {
		what += ", its Helm hooks among them as plain objects"
	}
	return what
}

// jobsAmong names the Jobs among the hooks that are not run at install,
// which are the ones worth reading about.
func jobsAmong(hooks []Hook) string {
	var jobs []string
	for _, h := range hooks {
		if h.Kind == "Job" && !h.AtInstall() {
			jobs = append(jobs, h.Name)
		}
	}
	if len(jobs) == 0 {
		return ""
	}
	return ", among them Jobs " + strings.Join(jobs, ", ")
}

// objectsOf reads the objects of a YAML stream, in the order they come. Sveltos
// applies a release's objects in whatever order they are in: measured, a
// fresh cluster took a chart whose Namespace came after the objects in it.
func objectsOf(data []byte) ([]Object, error) {
	docs, err := ParseDocs(data)
	if err != nil {
		return nil, err
	}
	var out []Object
	for _, d := range docs {
		meta := obj(d.Value["metadata"])
		stripUnitComment(d.Node)
		o := Object{APIVersion: str(d.Value["apiVersion"]), Kind: str(d.Value["kind"]), Namespace: str(meta["namespace"]), Name: str(meta["name"]), Node: d.Node, Value: d.Value}
		if o.Kind == "" || o.Name == "" {
			continue
		}
		out = append(out, o)
	}
	return out, nil
}

// renderCache renders each chart once per plan, twice the first time: a chart
// that renders differently each time (random values, lookup) cannot be held
// as one reviewed set of objects.
type renderCache struct {
	render Renderer
	done   map[string]renderResult
}

type renderResult struct {
	objects []Object
	hooks   []Hook
	raw     []byte
	err     error
}

func (rc *renderCache) get(c Chart) renderResult {
	if r, ok := rc.done[c.Key()]; ok {
		return r
	}
	r := rc.do(c)
	rc.done[c.Key()] = r
	return r
}

func (rc *renderCache) do(c Chart) renderResult {
	r, err := chartrender.Render(rc.render, c)
	if err != nil {
		return renderResult{err: err}
	}
	objects, err := objectsOf(r.Objects)
	if err != nil {
		return renderResult{err: fmt.Errorf("reading its rendering: %w", err)}
	}
	if len(objects) == 0 {
		return renderResult{err: errors.New("renders no objects")}
	}
	return renderResult{objects: objects, hooks: r.Hooks, raw: r.Objects}
}

// Sveltos reads a chart from a Flux source when its repositoryURL is
// gitrepository://, ocirepository:// or bucket://, and ignores chartVersion.
var fluxSource = regexp.MustCompile(`(?i)^(gitrepository|ocirepository|bucket)://`)

// chartsOf reads a profile's helmCharts, and says what cannot be rendered once
// for every cluster the profile reaches.
func chartsOf(profile string, spec map[string]any, includeHooks func(string) bool) ([]Chart, []string) {
	var charts []Chart
	var problems []string
	for _, h := range list(spec["helmCharts"]) {
		hc := obj(h)
		release := str(hc["releaseName"])
		switch {
		case str(hc["helmChartAction"]) == "Uninstall":
			problems = append(problems, fmt.Sprintf("%s uninstalls chart %s; onboard it once the uninstall has run and the entry is gone", profile, release))
			continue
		case len(list(hc["valuesFrom"])) > 0:
			problems = append(problems, fmt.Sprintf("%s reads values for %s from valuesFrom, which Sveltos resolves per cluster; this version renders charts whose values are in the profile", profile, release))
			continue
		case strings.Contains(str(hc["values"]), "{{"):
			problems = append(problems, fmt.Sprintf("%s templates the values of %s per cluster; this version renders charts whose values are the same for every cluster", profile, release))
			continue
		case release == "" || str(hc["chartName"]) == "":
			problems = append(problems, fmt.Sprintf("%s has a helmCharts entry without a releaseName or chartName", profile))
			continue
		case fluxSource.MatchString(str(hc["repositoryURL"])):
			problems = append(problems, fmt.Sprintf("%s reads chart %s from a Flux source, %s, whose content moves when its source does, with no version of its own; this version renders charts from Helm and OCI repositories at an exact version", profile, release, str(hc["repositoryURL"])))
			continue
		case !chartrender.ExactVersion(str(hc["chartVersion"])):
			problems = append(problems, fmt.Sprintf("%s installs chart %s at %q, which is not one exact version, so what ConfigHub renders may not be what Sveltos installed; pin chartVersion to the exact version running, then onboard", profile, release, str(hc["chartVersion"])))
			continue
		}
		repo := strings.TrimSuffix(str(hc["repositoryURL"]), "/")
		c := Chart{
			Release:      release,
			Namespace:    str(hc["releaseNamespace"]),
			Version:      str(hc["chartVersion"]),
			Values:       str(hc["values"]),
			SkipCRDs:     obj(hc["options"])["skipCRDs"] == true,
			IncludeHooks: includeHooks(release),
		}
		if c.Namespace == "" {
			c.Namespace = "default"
		}
		base := path.Base(str(hc["chartName"]))
		if strings.HasPrefix(repo, "oci://") {
			c.Ref = repo
			if path.Base(repo) != base {
				c.Ref = repo + "/" + base
			}
		} else {
			c.Ref, c.Repo = base, repo
		}
		charts = append(charts, c)
	}
	return charts, problems
}

// renderUnits renders a profile's charts into one unit each.
func renderUnits(profile string, charts []Chart, rc *renderCache) ([]Unit, []string) {
	var units []Unit
	var problems []string
	releases := map[string]int{}
	for _, c := range charts {
		releases[c.Release]++
	}
	for _, c := range charts {
		r := rc.get(c)
		if r.err != nil {
			problems = append(problems, fmt.Sprintf("%s: chart %s %s %s", profile, c.Ref, c.Version, r.err))
			continue
		}
		slug := Slug(c.Release)
		if releases[c.Release] > 1 {
			slug = Slug(c.Namespace + "-" + c.Release)
		}
		chart := c
		raw, objects := r.raw, r.objects
		source := strings.TrimSpace("chart " + c.Ref + " " + c.Version)
		if c.Repo != "" {
			source += " from " + c.Repo
		}
		units = append(units, Unit{Slug: slug, Source: source, Chart: &chart, Objects: objects, Hooks: r.hooks, raw: raw})
	}
	return units, problems
}

// keptHooks are the objects of a rendering that are Helm hooks.
func keptHooks(objects []Object) []Hook {
	var out []Hook
	for _, o := range objects {
		if events, ok := obj(obj(o.Value["metadata"])["annotations"])["helm.sh/hook"].(string); ok {
			out = append(out, Hook{Kind: o.Kind, Name: o.Name, Events: events})
		}
	}
	return out
}

// stripUnitComment drops the "# Unit: <slug>" line cub helm template writes
// above each object: the unit it names is cub helm's, not ours.
func stripUnitComment(node *yaml.Node) {
	for _, n := range []*yaml.Node{node, firstKey(node)} {
		if n == nil || n.HeadComment == "" {
			continue
		}
		var kept []string
		for _, l := range strings.Split(n.HeadComment, "\n") {
			if !strings.HasPrefix(strings.TrimSpace(l), "# Unit:") {
				kept = append(kept, l)
			}
		}
		n.HeadComment = strings.Join(kept, "\n")
	}
}

func firstKey(node *yaml.Node) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode || len(node.Content) == 0 {
		return nil
	}
	return node.Content[0]
}
