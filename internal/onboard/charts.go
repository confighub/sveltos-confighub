package onboard

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Chart is one Helm chart a profile installs, and how it is rendered.
type Chart struct {
	Release   string
	Namespace string
	// Ref is what cub helm template is given: a chart name resolved against
	// Repo, or an oci:// reference.
	Ref          string
	Repo         string
	Version      string
	Values       string
	SkipCRDs     bool
	IncludeHooks bool
}

// Key identifies a rendering: the same chart, version, namespace and values
// always render the same objects.
func (c Chart) Key() string {
	sum := sha256.Sum256([]byte(strings.Join([]string{c.Release, c.Namespace, c.Ref, c.Repo, c.Version, c.Values, fmt.Sprint(c.SkipCRDs), fmt.Sprint(c.IncludeHooks)}, "\x00")))
	return fmt.Sprintf("%s-%s-%s", Slug(c.Release), Slug(c.Version), hex.EncodeToString(sum[:])[:8])
}

// Command is the cub helm template command line that renders the chart, with
// the values read from valuesFile.
func (c Chart) Command(valuesFile string) []string {
	args := []string{"cub", "helm", "template", c.Release, c.Ref}
	if c.Repo != "" {
		args = append(args, "--repo", c.Repo)
	}
	if c.Version != "" {
		args = append(args, "--version", c.Version)
	}
	args = append(args, "--namespace", c.Namespace, "--create-namespace")
	if c.SkipCRDs {
		args = append(args, "--skip-crds")
	}
	if c.IncludeHooks {
		args = append(args, "--include-hooks")
	}
	if c.Values != "" && valuesFile != "" {
		args = append(args, "-f", valuesFile)
	}
	return args
}

// Rendering is what rendering a chart printed: the objects, and the hook
// manifests it left out.
type Rendering struct {
	Stdout []byte
	Stderr []byte
}

// Renderer renders a chart the way cub helm install would.
type Renderer func(Chart) (Rendering, error)

// CubHelm renders with the cub helm plugin's template command, which needs no
// ConfigHub connection: ConfigHub's own Helm renderer, so a chart onboarded
// here holds the objects cub helm install would have written.
func CubHelm(c Chart) (Rendering, error) {
	cub, err := exec.LookPath("cub")
	if err != nil {
		return Rendering{}, errors.New("rendering charts needs cub on the PATH")
	}
	valuesFile := ""
	if c.Values != "" {
		f, err := os.CreateTemp("", "sveltos-values-*.yaml")
		if err != nil {
			return Rendering{}, err
		}
		defer os.Remove(f.Name())
		if _, err := io.WriteString(f, c.Values); err != nil {
			f.Close()
			return Rendering{}, err
		}
		f.Close()
		valuesFile = f.Name()
	}
	args := c.Command(valuesFile)
	cmd := exec.Command(cub, args[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		text := strings.TrimSpace(stderr.String())
		if strings.Contains(text, "unknown command") {
			return Rendering{}, errors.New("rendering charts needs the cub helm plugin: cub plugin install confighub/cub-helm")
		}
		if i := strings.LastIndex(text, "\n"); i >= 0 {
			text = text[i+1:]
		}
		return Rendering{}, fmt.Errorf("%s: %s", strings.Join(args[:5], " "), text)
	}
	return Rendering{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}, nil
}

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
	// raw is a chart's rendering as cub helm template printed it, which the
	// unit holds byte for byte, so rendering the next version the same way
	// shows a reviewer only what changed.
	raw []byte
}

// Hook is a Helm hook manifest: an object Helm creates at a point in a
// release's life, which plain delivery does not have.
type Hook struct {
	Kind   string
	Name   string
	Events string
}

func (h Hook) String() string { return h.Kind + " " + h.Name }

// atInstall is a hook Helm runs to install the chart: without it, a cluster
// that installs the chart from its plain objects lacks what the hook makes.
func (h Hook) atInstall() bool {
	return strings.Contains(h.Events, "pre-install") || strings.Contains(h.Events, "post-install")
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
		if h.Kind == "Job" && !h.atInstall() {
			jobs = append(jobs, h.Name)
		}
	}
	if len(jobs) == 0 {
		return ""
	}
	return ", among them Jobs " + strings.Join(jobs, ", ")
}

var droppedHook = regexp.MustCompile(`Dropped hook manifest: (\S+) (\S+) \(helm\.sh/hook: ([^)]*)\)`)

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

func hooksOf(stderr []byte) []Hook {
	var out []Hook
	for _, m := range droppedHook.FindAllStringSubmatch(string(stderr), -1) {
		out = append(out, Hook{Kind: m[1], Name: m[2], Events: m[3]})
	}
	return out
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
	first, err := rc.render(c)
	if err != nil {
		return renderResult{err: err}
	}
	second, err := rc.render(c)
	if err != nil {
		return renderResult{err: err}
	}
	if !bytes.Equal(first.Stdout, second.Stdout) {
		return renderResult{err: fmt.Errorf("renders differently each time it is rendered (random values or lookup), so it cannot be held as one set of objects; set those values explicitly")}
	}
	objects, err := objectsOf(first.Stdout)
	if err != nil {
		return renderResult{err: fmt.Errorf("reading its rendering: %w", err)}
	}
	if len(objects) == 0 {
		return renderResult{err: errors.New("renders no objects")}
	}
	return renderResult{objects: objects, hooks: hooksOf(first.Stderr), raw: first.Stdout}
}

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
