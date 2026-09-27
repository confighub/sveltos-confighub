// Package onboard turns a Sveltos fleet, described in Sveltos's own terms, into
// the fleet ConfigHub governs: one base per ClusterProfile holding the objects
// its charts and policies render to, and one variant per cluster the profile
// selects. Sveltos delivers each variant's releases to its one cluster.
package onboard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	workflowSlug  = "rollout"
	workerSlug    = "server-worker"
	defaultStage  = "fleet"
	gatewayHost   = "oci.hub.confighub.com"
	releaseTag    = "latest"
	fetchInterval = "1m0s"
	// MinimumSveltos is the first release whose addon controller reads the
	// gzipped layers the ConfigHub gateway serves.
	MinimumSveltos    = "v1.14.0"
	secretNamespace   = "projectsveltos"
	secretType        = "addons.projectsveltos.io/cluster-profile"
	profileAPIVersion = "config.projectsveltos.io/v1beta1"
)

var clusterRefAPI = map[string]string{
	"SveltosCluster": "lib.projectsveltos.io/v1beta1",
	"Cluster":        "cluster.x-k8s.io/v1beta1",
}

// One gateway Secret per Targets Space: the gateway lets a Target's own worker
// pull its releases and refuses any other worker, so two onboardings that
// shared a Secret would lock one of them out.
func gatewaySecretName(targetsSpace string) string { return "confighub-" + targetsSpace }

// Options are the plan's choices beyond its input.
type Options struct {
	Prefix     string
	StageLabel string
	Stages     []string
	Management string
	Profiles   []string
	// ClassLabel adds a level between the base and the clusters: one class base
	// per value of this cluster label, each a variant of the base, and each
	// cluster's variant a variant of its class base.
	ClassLabel string
	// IncludeHooks names the chart releases whose Helm hook manifests are kept
	// as plain objects; "all" keeps every chart's. Otherwise hooks are left
	// out, as cub helm leaves them out.
	IncludeHooks []string
	// Render renders a chart; CubHelm when nil.
	Render Renderer
}

func (o Options) includeHooks(release string) bool {
	return contains(o.IncludeHooks, "all") || contains(o.IncludeHooks, release)
}

// Cluster is a SveltosCluster, or a Cluster API Cluster Sveltos addresses directly.
type Cluster struct {
	Kind      string
	Namespace string
	Name      string
	Labels    map[string]string
	Key       string
}

// ClusterRef is one clusterRefs entry, in the order Sveltos writes its fields.
type ClusterRef struct {
	APIVersion string `json:"apiVersion" yaml:"apiVersion"`
	Kind       string `json:"kind" yaml:"kind"`
	Namespace  string `json:"namespace" yaml:"namespace"`
	Name       string `json:"name" yaml:"name"`
}

// Variant is one cluster's copy of a profile's base, or of its class base. It
// holds the same objects as its upstream; Sveltos addresses it to its cluster.
type Variant struct {
	Upstream   string
	Class      string
	Cluster    string
	ClusterKey string
	Stage      string
	Target     string
	Space      string
	// ProfileName is the delivery profile on the management cluster that
	// sends this variant's releases to its cluster.
	ProfileName string
	Member      string
	ClusterRef  ClusterRef
	DependsOn   []string
}

// Profile is one onboarded component: its base, its classes and its variants.
type Profile struct {
	Name        string
	Live        bool
	Selector    string
	ClusterRefs int
	Component   string
	BaseSpace   string
	// Units are what the base holds: each chart rendered to its objects, and
	// the objects of each policy ConfigMap.
	Units        []Unit
	PolicyMaps   []Doc
	Source       *yaml.Node
	Stages       []string
	Variants     []Variant
	ReleaseOrder string
	WorkflowText string
	// Policies are the ConfigMaps whose objects the base holds, which the
	// delivery profiles no longer read.
	Policies   []string
	ClassLabel string
	Classes    []Class
	Members    []Member
}

// Class is one class base: a variant of the root base that a class of
// clusters shares, holding what that class differs in.
type Class struct {
	Value      string
	Space      string
	Member     string
	Departures []Departure
}

// Member is one input ClusterProfile a component was made from.
type Member struct {
	Name   string
	Live   bool
	Source *yaml.Node
}

// Skipped is a profile left as it is, with the reason.
type Skipped struct {
	Name   string
	Reason string
}

// DeliverySet is the management cluster's delivery profiles for one component.
type DeliverySet struct {
	Profile  string
	Unit     string
	Profiles []*yaml.Node
}

// Management is the management cluster's record.
type Management struct {
	Cluster   string
	Namespace string
	Target    string
	Component string
	Space     string
	ByProfile []DeliverySet
}

// Target is a named destination for one cluster.
type Target struct {
	Target  string
	Cluster string
}

// Plan is what ConfigHub would hold.
type Plan struct {
	Prefix       string
	StageLabel   string
	StageOrder   []string
	TargetsSpace string
	Targets      []Target
	Profiles     []Profile
	Skipped      []Skipped
	Ungoverned   []Cluster
	Management   *Management
	Live         bool
	Notes        []string
	Problems     []string
}

var slugInvalid = regexp.MustCompile(`[^a-z0-9-]+`)
var slugDashes = regexp.MustCompile(`-+`)

// Slug makes a name safe for a Space: lowercase letters, digits and dashes.
func Slug(value string) string {
	s := slugInvalid.ReplaceAllString(strings.ToLower(value), "-")
	s = slugDashes.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func obj(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func list(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

func labelsOf(v any) map[string]string {
	out := map[string]string{}
	for k, val := range obj(v) {
		out[k] = fmt.Sprint(val)
	}
	return out
}

func isClusterKind(v map[string]any) bool {
	kind := str(v["kind"])
	return kind == "SveltosCluster" || (kind == "Cluster" && strings.HasPrefix(str(v["apiVersion"]), "cluster.x-k8s.io/"))
}

func refKey(ref map[string]any) string {
	ns := str(ref["namespace"])
	if ns == "" {
		ns = "default"
	}
	return fmt.Sprintf("%s:%s/%s", str(ref["kind"]), ns, str(ref["name"]))
}

func clusterOf(v map[string]any) Cluster {
	meta := obj(v["metadata"])
	ns := str(meta["namespace"])
	if ns == "" {
		ns = "default"
	}
	c := Cluster{Kind: str(v["kind"]), Namespace: ns, Name: str(meta["name"]), Labels: labelsOf(meta["labels"])}
	c.Key = fmt.Sprintf("%s:%s/%s", c.Kind, c.Namespace, c.Name)
	return c
}

// Selects applies Kubernetes label-selector semantics, the ones Sveltos
// evaluates a ClusterProfile's clusterSelector with.
func Selects(selector map[string]any, labels map[string]string) (bool, error) {
	for key, value := range obj(selector["matchLabels"]) {
		if labels[key] != fmt.Sprint(value) {
			return false, nil
		}
	}
	for _, e := range list(selector["matchExpressions"]) {
		expr := obj(e)
		key := str(expr["key"])
		value, has := labels[key]
		var values []string
		for _, v := range list(expr["values"]) {
			values = append(values, fmt.Sprint(v))
		}
		in := has && contains(values, value)
		switch str(expr["operator"]) {
		case "In":
			if !in {
				return false, nil
			}
		case "NotIn":
			if in {
				return false, nil
			}
		case "Exists":
			if !has {
				return false, nil
			}
		case "DoesNotExist":
			if has {
				return false, nil
			}
		default:
			return false, fmt.Errorf("unknown selector operator %q", str(expr["operator"]))
		}
	}
	return true, nil
}

func contains(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}

func selectorGiven(selector map[string]any) bool {
	return len(obj(selector["matchLabels"])) > 0 || len(list(selector["matchExpressions"])) > 0
}

func describeSelector(selector map[string]any) string {
	var parts []string
	keys := make([]string, 0)
	for k := range obj(selector["matchLabels"]) {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, obj(selector["matchLabels"])[k]))
	}
	for _, e := range list(selector["matchExpressions"]) {
		expr := obj(e)
		switch op := str(expr["operator"]); op {
		case "Exists":
			parts = append(parts, str(expr["key"]))
		case "DoesNotExist":
			parts = append(parts, "!"+str(expr["key"]))
		default:
			var values []string
			for _, v := range list(expr["values"]) {
				values = append(values, fmt.Sprint(v))
			}
			parts = append(parts, fmt.Sprintf("%s %s [%s]", str(expr["key"]), op, strings.Join(values, ", ")))
		}
	}
	return strings.Join(parts, ", ")
}

type resolution struct {
	matched    []Cluster
	byRef      map[string]bool
	missing    []string
	fromStatus bool
	differs    []string
}

// Which clusters a profile reaches today. A live profile carries Sveltos's own
// answer in status.matchingClusters, which is used as it stands; a written one
// is evaluated here with Sveltos's selector semantics.
func resolveMatches(profile map[string]any, clusters []Cluster) (resolution, error) {
	spec := obj(profile["spec"])
	byRef := map[string]bool{}
	var refOrder []string
	for _, r := range list(spec["clusterRefs"]) {
		k := refKey(obj(r))
		if !byRef[k] {
			refOrder = append(refOrder, k)
		}
		byRef[k] = true
	}
	selector := obj(spec["clusterSelector"])
	var evaluated []Cluster
	for _, c := range clusters {
		hit := byRef[c.Key]
		if !hit && selectorGiven(selector) {
			ok, err := Selects(selector, c.Labels)
			if err != nil {
				return resolution{}, err
			}
			hit = ok
		}
		if hit {
			evaluated = append(evaluated, c)
		}
	}
	known := map[string]bool{}
	for _, c := range clusters {
		known[c.Key] = true
	}
	recorded, isList := obj(profile["status"])["matchingClusters"].([]any)
	if !isList {
		var missing []string
		for _, k := range refOrder {
			if !known[k] {
				missing = append(missing, k)
			}
		}
		return resolution{matched: evaluated, byRef: byRef, missing: missing}, nil
	}
	recordedKeys := map[string]bool{}
	var recordedOrder []string
	for _, r := range recorded {
		k := refKey(obj(r))
		if !recordedKeys[k] {
			recordedOrder = append(recordedOrder, k)
		}
		recordedKeys[k] = true
	}
	var matched []Cluster
	evaluatedKeys := map[string]bool{}
	for _, c := range evaluated {
		evaluatedKeys[c.Key] = true
	}
	for _, c := range clusters {
		if recordedKeys[c.Key] {
			matched = append(matched, c)
		}
	}
	var differs []string
	seen := map[string]bool{}
	for _, k := range append(append([]string{}, recordedOrder...), keysOf(evaluated)...) {
		if seen[k] {
			continue
		}
		seen[k] = true
		if recordedKeys[k] != evaluatedKeys[k] {
			differs = append(differs, stripKind(k))
		}
	}
	var missing []string
	for _, k := range recordedOrder {
		if !known[k] {
			missing = append(missing, k)
		}
	}
	return resolution{matched: matched, byRef: byRef, missing: missing, fromStatus: true, differs: differs}, nil
}

func keysOf(clusters []Cluster) []string {
	out := make([]string, len(clusters))
	for i, c := range clusters {
		out[i] = c.Key
	}
	return out
}

func stripKind(key string) string {
	if i := strings.Index(key, ":"); i >= 0 {
		return key[i+1:]
	}
	return key
}

// A bootstrap profile reads a Space from the ConfigHub gateway. A profile it
// delivered carries ConfigHub's origin annotation, and Sveltos records the
// gateway reference it came from. Both are ConfigHub's already.
func deliveredByConfigHub(v map[string]any) bool {
	gateway := "oci://" + gatewayHost + "/"
	for _, r := range list(obj(v["spec"])["policyRefs"]) {
		if strings.HasPrefix(str(obj(obj(r)["remoteURL"])["url"]), gateway) {
			return true
		}
	}
	annotations := obj(obj(v["metadata"])["annotations"])
	if _, ok := annotations["confighub.com/origin"]; ok {
		return true
	}
	return strings.HasPrefix(str(annotations["projectsveltos.io/reference-name"]), gateway)
}

var eventOwner = regexp.MustCompile(`^Event(Trigger|BasedAddOn)$`)
var eventLabel = regexp.MustCompile(`(?i)event-?trigger`)

// Sveltos's event framework creates profiles when something happens, so their
// scope changes by itself; the template that makes them is what to govern.
func madeByEvents(v map[string]any) bool {
	meta := obj(v["metadata"])
	for _, o := range list(meta["ownerReferences"]) {
		if eventOwner.MatchString(str(obj(o)["kind"])) {
			return true
		}
	}
	for l := range obj(meta["labels"]) {
		if eventLabel.MatchString(l) {
			return true
		}
	}
	return false
}

// The profile as its owner described it, kept so the fleet can be planned again.
func sourceOf(node *yaml.Node, value map[string]any) *yaml.Node {
	metadata := mapping(scalar("name"), scalar(str(obj(value["metadata"])["name"])))
	if labels := mapGet(mapGet(node, "metadata"), "labels"); labels != nil && len(labels.Content) > 0 {
		metadata.Content = append(metadata.Content, scalar("labels"), deepCopy(labels))
	}
	spec := deepCopy(mapGet(node, "spec"))
	if spec == nil {
		spec = mapping()
	}
	return mapping(
		scalar("apiVersion"), scalar(apiVersionOf(value)),
		scalar("kind"), scalar("ClusterProfile"),
		scalar("metadata"), metadata,
		scalar("spec"), spec,
	)
}

func apiVersionOf(value map[string]any) string {
	if v := str(value["apiVersion"]); v != "" {
		return v
	}
	return profileAPIVersion
}

// profileDoc is one input ClusterProfile, as a node and as a value.
type profileDoc struct {
	node  *yaml.Node
	value map[string]any
}

// PlanFleet shows what ConfigHub would hold for these objects.
func PlanFleet(docs []Doc, opts Options) (*Plan, error) {
	prefix := Slug(opts.Prefix)
	if opts.Prefix == "" {
		prefix = "sveltos"
	}
	stageOrder := []string{defaultStage}
	if opts.StageLabel != "" {
		stageOrder = opts.Stages
	}
	plan := &Plan{Prefix: prefix, StageLabel: opts.StageLabel, StageOrder: stageOrder, TargetsSpace: prefix + "-targets"}
	render := opts.Render
	if render == nil {
		render = CubHelm
	}
	rc := &renderCache{render: render, done: map[string]renderResult{}}

	// A later input wins, so a fresh cluster list can be given after the file
	// that first described the fleet.
	var clusters []Cluster
	clusterAt := map[string]int{}
	var allProfiles []profileDoc
	profileAt := map[string]int{}
	var namespaced []string
	configMaps := map[string]Doc{}
	for _, d := range docs {
		switch {
		case str(d.Value["kind"]) == "ConfigMap" && str(d.Value["apiVersion"]) == "v1":
			meta := obj(d.Value["metadata"])
			configMaps[str(meta["namespace"])+"/"+str(meta["name"])] = d
		case isClusterKind(d.Value):
			c := clusterOf(d.Value)
			if i, ok := clusterAt[c.Key]; ok {
				clusters[i] = c
			} else {
				clusterAt[c.Key] = len(clusters)
				clusters = append(clusters, c)
			}
		case str(d.Value["kind"]) == "ClusterProfile":
			name := str(obj(d.Value["metadata"])["name"])
			if i, ok := profileAt[name]; ok {
				allProfiles[i] = profileDoc{d.Node, d.Value}
			} else {
				profileAt[name] = len(allProfiles)
				allProfiles = append(allProfiles, profileDoc{d.Node, d.Value})
			}
		case str(d.Value["kind"]) == "Profile":
			namespaced = append(namespaced, str(obj(d.Value["metadata"])["name"]))
		}
	}

	wanted := map[string]bool{}
	for _, p := range opts.Profiles {
		wanted[p] = true
	}
	var profiles []profileDoc
	var delivered []string
	for _, p := range allProfiles {
		name := str(obj(p.value["metadata"])["name"])
		if deliveredByConfigHub(p.value) {
			delivered = append(delivered, name)
			continue
		}
		if len(wanted) > 0 && !wanted[name] {
			continue
		}
		profiles = append(profiles, p)
	}
	for _, name := range opts.Profiles {
		if _, ok := profileAt[name]; !ok {
			plan.Problems = append(plan.Problems, fmt.Sprintf("--profiles names %s, but no ClusterProfile of that name is in the input", name))
		}
	}
	if len(delivered) > 0 {
		plan.Notes = append(plan.Notes, fmt.Sprintf("%d profile(s) already come from ConfigHub and are left as they are: %s.", len(delivered), strings.Join(delivered, ", ")))
	}
	if len(namespaced) > 0 {
		plan.Notes = append(plan.Notes, fmt.Sprintf("%d namespaced Profile(s) left as they are: %s. This first version onboards ClusterProfiles.", len(namespaced), strings.Join(namespaced, ", ")))
	}
	if opts.StageLabel != "" && len(stageOrder) == 0 {
		plan.Problems = append(plan.Problems, fmt.Sprintf("--stage-label %s needs --stages to say the order, for example --stages staging,prod", opts.StageLabel))
	}

	managementKey := "SveltosCluster:mgmt/mgmt"
	if opts.Management != "" {
		managementKey = "SveltosCluster:" + opts.Management
	}
	var management *Cluster
	for i := range clusters {
		if clusters[i].Key == managementKey {
			management = &clusters[i]
		}
	}
	if management == nil {
		if opts.Management != "" {
			plan.Problems = append(plan.Problems, fmt.Sprintf("no SveltosCluster %s in the input; --management names the management cluster as <namespace>/<name>", opts.Management))
		} else {
			plan.Problems = append(plan.Problems, "no management cluster in the input: Sveltos registers it as mgmt/mgmt, or name yours with --management <namespace>/<name>")
		}
	}

	// One Target per cluster, named for it. Two clusters of the same name in
	// different namespaces keep the namespace in the name.
	nameCounts := map[string]int{}
	for _, c := range clusters {
		nameCounts[c.Name]++
	}
	targetOf := func(c Cluster) string {
		if nameCounts[c.Name] > 1 {
			return Slug(c.Namespace + "-" + c.Name)
		}
		return Slug(c.Name)
	}

	profileNames := map[string]bool{}
	profileByName := map[string]map[string]any{}
	for _, p := range profiles {
		name := str(obj(p.value["metadata"])["name"])
		profileNames[name] = true
		profileByName[name] = p.value
	}
	sort.SliceStable(profiles, func(i, j int) bool {
		return str(obj(profiles[i].value["metadata"])["name"]) < str(obj(profiles[j].value["metadata"])["name"])
	})
	if opts.ClassLabel != "" && contains(stageOrder, basesStage) {
		plan.Problems = append(plan.Problems, fmt.Sprintf("with --class-label, the stage name %q is taken by the class bases; choose another stage name", basesStage))
	}

	// With a class label, profiles that each pin one class and are otherwise the
	// same component (the same charts and policies, the same other selector
	// terms) become one component with a class base per profile. Every other
	// profile is a component of its own.
	type family struct {
		name    string
		members []profileDoc
		classes []string
	}
	var families []*family
	familyAt := map[string]*family{}
	for _, p := range profiles {
		name := str(obj(p.value["metadata"])["name"])
		spec := obj(p.value["spec"])
		class, rest := pinnedClass(obj(spec["clusterSelector"]), opts.ClassLabel)
		if class == "" {
			families = append(families, &family{name: name, members: []profileDoc{p}, classes: []string{""}})
			continue
		}
		restJSON, _ := json.Marshal(rest)
		key := string(restJSON) + "#" + deliveryIdentity(spec)
		if f, ok := familyAt[key]; ok {
			f.members = append(f.members, p)
			f.classes = append(f.classes, class)
			continue
		}
		f := &family{members: []profileDoc{p}, classes: []string{class}}
		familyAt[key] = f
		families = append(families, f)
	}
	memberFamily := map[string]string{}
	for _, f := range families {
		if f.name == "" {
			f.name = familyName(f.members, f.classes)
		}
		for _, m := range f.members {
			memberFamily[str(obj(m.value["metadata"])["name"])] = f.name
		}
	}
	sort.SliceStable(families, func(i, j int) bool { return families[i].name < families[j].name })

	type resolvedMember struct {
		doc   profileDoc
		name  string
		class string
		res   resolution
	}
	for _, f := range families {
		var members []resolvedMember
		for i, p := range f.members {
			name := str(obj(p.value["metadata"])["name"])
			spec := obj(p.value["spec"])
			if len(list(spec["setRefs"])) > 0 {
				plan.Skipped = append(plan.Skipped, Skipped{name, "selects through ClusterSets, which choose clusters at delivery time; list the clusters with clusterRefs or labels instead"})
				continue
			}
			if madeByEvents(p.value) {
				plan.Skipped = append(plan.Skipped, Skipped{name, "was made by Sveltos's event framework, which changes its scope when something happens; govern the EventTrigger that makes it instead"})
				continue
			}
			if selector, has := spec["clusterSelector"]; has && !selectorGiven(obj(selector)) {
				plan.Skipped = append(plan.Skipped, Skipped{name, "has an empty clusterSelector; say which clusters it is for with labels or clusterRefs"})
				continue
			}
			res, err := resolveMatches(p.value, clusters)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
			verb := "names"
			if res.fromStatus {
				verb = "reaches"
			}
			for _, k := range res.missing {
				plan.Problems = append(plan.Problems, fmt.Sprintf("%s %s %s, but no such cluster is in the input; export the SveltosClusters too", name, verb, stripKind(k)))
			}
			if len(res.differs) > 0 {
				plan.Notes = append(plan.Notes, fmt.Sprintf("%s: Sveltos records it reaching a different set of clusters than its selector gives today (%s); the plan follows Sveltos's record.", name, strings.Join(res.differs, ", ")))
			}
			if len(res.matched) == 0 {
				plan.Skipped = append(plan.Skipped, Skipped{name, "selects no cluster today, so there is nothing to govern yet"})
				continue
			}
			members = append(members, resolvedMember{doc: p, name: name, class: f.classes[i], res: res})
		}
		if len(members) == 0 {
			continue
		}
		sort.SliceStable(members, func(i, j int) bool { return members[i].class < members[j].class })
		pinned := members[0].class != ""

		name := f.name
		root := members[0]
		spec := obj(root.doc.value["spec"])
		component := prefix + "-" + Slug(name)
		baseSpace := component + "-base"
		mdocs := make([]memberDoc, len(members))
		for i, m := range members {
			mdocs[i] = memberDoc{name: m.name, class: m.class, node: m.doc.node, value: m.doc.value}
		}
		keepHooks := func(m memberDoc, release string) bool {
			return opts.includeHooks(release)
		}
		r := renderComponent(name, mdocs, configMaps, keepHooks, rc)
		plan.Problems = append(plan.Problems, r.problems...)
		plan.Notes = append(plan.Notes, r.notes...)
		units, policies := r.units, r.policies
		var dependsOn []string
		for _, d := range list(spec["dependsOn"]) {
			dependsOn = append(dependsOn, fmt.Sprint(d))
		}

		var classes []Class
		classOf := map[string]*Class{}
		addClass := func(value, member string, departures []Departure) {
			classes = append(classes, Class{Value: value, Space: component + "-class-" + Slug(value), Member: member, Departures: departures})
		}
		if opts.ClassLabel != "" {
			if pinned {
				for _, m := range members {
					addClass(m.class, m.name, r.departures[m.class])
				}
			} else {
				seen := map[string]bool{}
				var values []string
				for _, c := range root.res.matched {
					if v, ok := c.Labels[opts.ClassLabel]; ok && !seen[v] {
						seen[v] = true
						values = append(values, v)
					}
				}
				sort.Strings(values)
				for _, v := range values {
					addClass(v, root.name, nil)
				}
			}
			for i := range classes {
				classOf[classes[i].Value] = &classes[i]
			}
		}

		var variants []Variant
		for _, m := range members {
			for _, c := range m.res.matched {
				stage := defaultStage
				if opts.StageLabel != "" {
					value, has := c.Labels[opts.StageLabel]
					if !has || !contains(stageOrder, value) {
						shown := "missing"
						if has {
							shown = fmt.Sprintf("%q", value)
						}
						plan.Problems = append(plan.Problems, fmt.Sprintf("%s is selected by %s but its %s label is %s, which is not one of the stages (%s)", c.Name, m.name, opts.StageLabel, shown, strings.Join(stageOrder, ", ")))
						continue
					}
					stage = value
				}
				upstream, class := baseSpace, ""
				if opts.ClassLabel != "" {
					class = m.class
					if class == "" {
						value, has := c.Labels[opts.ClassLabel]
						if !has {
							plan.Problems = append(plan.Problems, fmt.Sprintf("%s is selected by %s but has no %s label, so it belongs to no class", c.Name, m.name, opts.ClassLabel))
							continue
						}
						class = value
					}
					upstream = classOf[class].Space
				}
				target := targetOf(c)
				ref := ClusterRef{APIVersion: clusterRefAPI[c.Kind], Kind: c.Kind, Namespace: c.Namespace, Name: c.Name}
				v := Variant{
					Upstream:    upstream,
					Class:       class,
					Cluster:     c.Name,
					ClusterKey:  c.Key,
					Stage:       stage,
					Target:      target,
					Space:       component + "-" + target,
					ProfileName: name + "-" + target,
					Member:      m.name,
					ClusterRef:  ref,
				}
				if len(dependsOn) > 0 {
					var unmet []string
					for _, dep := range dependsOn {
						ok := false
						if profileNames[dep] {
							depRes, err := resolveMatches(profileByName[dep], clusters)
							if err != nil {
								return nil, err
							}
							for _, dm := range depRes.matched {
								if dm.Key == c.Key {
									ok = true
								}
							}
						}
						if !ok {
							unmet = append(unmet, dep)
						}
					}
					if len(unmet) > 0 {
						plan.Problems = append(plan.Problems, fmt.Sprintf("%s depends on %s, which the input does not onboard for %s; onboard them together", m.name, strings.Join(unmet, ", "), c.Name))
					}
					for _, dep := range dependsOn {
						depName := dep
						if fam, ok := memberFamily[dep]; ok {
							depName = fam
						}
						v.DependsOn = append(v.DependsOn, depName+"-"+target)
					}
				}
				variants = append(variants, v)
			}
		}
		sort.SliceStable(variants, func(i, j int) bool {
			si, sj := indexOf(stageOrder, variants[i].Stage), indexOf(stageOrder, variants[j].Stage)
			if si != sj {
				return si < sj
			}
			return variants[i].Cluster < variants[j].Cluster
		})
		var stages []string
		for _, st := range stageOrder {
			for _, v := range variants {
				if v.Stage == st {
					stages = append(stages, st)
					break
				}
			}
		}
		selectorText := ""
		if pinned {
			_, rest := pinnedClass(obj(spec["clusterSelector"]), opts.ClassLabel)
			if selectorGiven(rest) {
				selectorText = describeSelector(rest) + "; "
			}
			var values []string
			for _, c := range classes {
				values = append(values, c.Value)
			}
			selectorText += fmt.Sprintf("one profile per %s: %s", opts.ClassLabel, strings.Join(values, ", "))
		} else if sel, has := spec["clusterSelector"]; has {
			selectorText = describeSelector(obj(sel))
			if len(classes) > 0 {
				selectorText += "; classes by " + opts.ClassLabel
			}
		}
		refs := 0
		var memberList []Member
		live := false
		for _, m := range members {
			refs += len(m.res.byRef)
			_, hasUID := obj(m.doc.value["metadata"])["uid"]
			_, hasStatus := m.doc.value["status"]
			source := sourceOf(m.doc.node, m.doc.value)
			memberList = append(memberList, Member{Name: m.name, Live: hasUID || hasStatus, Source: source})
			live = live || hasUID || hasStatus
		}
		plan.Profiles = append(plan.Profiles, Profile{
			Name:         name,
			Live:         live,
			Selector:     selectorText,
			ClusterRefs:  refs,
			Component:    component,
			BaseSpace:    baseSpace,
			Units:        units,
			PolicyMaps:   r.policyMaps,
			Source:       memberList[0].Source,
			Stages:       stages,
			Variants:     variants,
			ReleaseOrder: releaseOrder(variants, classes),
			WorkflowText: workflowText(stages, len(classes) > 0),
			Policies:     policies,
			ClassLabel:   opts.ClassLabel,
			Classes:      classes,
			Members:      memberList,
		})
	}

	governed := map[string]bool{}
	for _, p := range plan.Profiles {
		for _, v := range p.Variants {
			governed[v.ClusterKey] = true
		}
	}
	for _, c := range clusters {
		if !governed[c.Key] && (management == nil || c.Key != management.Key) {
			plan.Ungoverned = append(plan.Ungoverned, c)
		}
	}

	if management != nil {
		m := &Management{
			Cluster:   management.Name,
			Namespace: management.Namespace,
			Target:    targetOf(*management),
			Component: prefix + "-management",
			Space:     prefix + "-management",
		}
		for _, p := range plan.Profiles {
			set := DeliverySet{Profile: p.Name, Unit: "delivery-" + Slug(p.Name)}
			sources := map[string]*yaml.Node{}
			for _, mb := range p.Members {
				sources[mb.Name] = mb.Source
			}
			keptHooks := false
			for _, u := range p.Units {
				if u.Chart != nil && u.Chart.IncludeHooks {
					keptHooks = true
				}
			}
			for _, v := range p.Variants {
				set.Profiles = append(set.Profiles, deliveryProfile(v, sources[v.Member], gatewaySecretName(plan.TargetsSpace), keptHooks))
			}
			m.ByProfile = append(m.ByProfile, set)
		}
		plan.Management = m
	}

	// A delivery profile takes the name <profile>-<cluster>; a profile of that
	// name the fleet already has would be replaced.
	delivery := map[string]string{}
	for _, p := range plan.Profiles {
		for _, v := range p.Variants {
			delivery[v.ProfileName] = v.Cluster
		}
	}
	for _, p := range allProfiles {
		name := str(obj(p.value["metadata"])["name"])
		if c, clash := delivery[name]; clash && !deliveredByConfigHub(p.value) {
			plan.Problems = append(plan.Problems, fmt.Sprintf("the delivery profile for %s would be named %s, which is already the name of one of your profiles; rename that profile first", c, name))
		}
	}

	targets := map[string]string{}
	for _, p := range plan.Profiles {
		for _, v := range p.Variants {
			targets[v.Target] = v.Cluster
		}
	}
	if management != nil {
		targets[targetOf(*management)] = management.Name
	}
	for t, c := range targets {
		plan.Targets = append(plan.Targets, Target{Target: t, Cluster: c})
	}
	sort.Slice(plan.Targets, func(i, j int) bool { return plan.Targets[i].Target < plan.Targets[j].Target })

	spaces := []string{plan.TargetsSpace}
	for _, p := range plan.Profiles {
		spaces = append(spaces, p.BaseSpace)
		for _, c := range p.Classes {
			spaces = append(spaces, c.Space)
		}
		for _, v := range p.Variants {
			spaces = append(spaces, v.Space)
		}
	}
	if plan.Management != nil {
		spaces = append(spaces, plan.Management.Space)
	}
	seenSpace := map[string]int{}
	for _, s := range spaces {
		seenSpace[s]++
		if seenSpace[s] == 2 {
			plan.Problems = append(plan.Problems, fmt.Sprintf("two things would share the Space name %s; rename one of the clusters or profiles, or pass --prefix", s))
		}
	}
	for _, s := range spaces {
		if len(s) > 63 {
			plan.Problems = append(plan.Problems, fmt.Sprintf("%s is longer than 63 characters; pass a shorter --prefix", s))
		}
	}
	for _, p := range plan.Profiles {
		if p.Live {
			plan.Live = true
		}
	}
	return plan, nil
}

// basesStage is the first stage when a component has class bases: it carries a
// change from the root base into every class base, which are never released.
const basesStage = "bases"

// The class a profile's selector pins, and its selector without that term.
func pinnedClass(selector map[string]any, label string) (string, map[string]any) {
	if label == "" || selector == nil {
		return "", selector
	}
	rest := map[string]any{}
	class := ""
	if ml := obj(selector["matchLabels"]); len(ml) > 0 {
		kept := map[string]any{}
		for k, v := range ml {
			if k == label {
				class = fmt.Sprint(v)
				continue
			}
			kept[k] = v
		}
		if len(kept) > 0 {
			rest["matchLabels"] = kept
		}
	}
	var exprs []any
	for _, e := range list(selector["matchExpressions"]) {
		expr := obj(e)
		if str(expr["key"]) == label && str(expr["operator"]) == "In" && len(list(expr["values"])) == 1 && class == "" {
			class = fmt.Sprint(list(expr["values"])[0])
			continue
		}
		exprs = append(exprs, e)
	}
	if len(exprs) > 0 {
		rest["matchExpressions"] = exprs
	}
	return class, rest
}

// What makes two profiles the same component in different classes: they
// install the same charts and read the same policies, whatever the values.
func deliveryIdentity(spec map[string]any) string {
	var ids []string
	for _, h := range list(spec["helmCharts"]) {
		hc := obj(h)
		ids = append(ids, "helm:"+str(hc["repositoryURL"])+"|"+str(hc["chartName"])+"|"+str(hc["releaseNamespace"])+"/"+str(hc["releaseName"]))
	}
	for _, r := range list(spec["policyRefs"]) {
		ref := obj(r)
		ids = append(ids, "policy:"+str(ref["kind"])+"|"+str(ref["namespace"])+"/"+str(ref["name"])+"|"+str(obj(ref["remoteURL"])["url"]))
	}
	for _, r := range list(spec["kustomizationRefs"]) {
		ref := obj(r)
		ids = append(ids, "kustomize:"+str(ref["kind"])+"|"+str(ref["namespace"])+"/"+str(ref["name"]))
	}
	return strings.Join(ids, ";")
}

var plainKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func reflectEqual(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

func indexOf(list []string, value string) int {
	for i, v := range list {
		if v == value {
			return i
		}
	}
	return -1
}

func jsonString(s string) string {
	out, _ := json.Marshal(s)
	return string(out)
}

// The first release goes through a change order named for the set of variants
// it releases. Re-running with the same fleet finds it finished; a cluster that
// joined makes a new set, and a new change order releases the newcomer while
// every other variant has nothing new.
func releaseOrder(variants []Variant, classes []Class) string {
	var spaces []string
	for _, c := range classes {
		spaces = append(spaces, c.Space)
	}
	for _, v := range variants {
		spaces = append(spaces, v.Space)
	}
	sort.Strings(spaces)
	sum := sha256.Sum256([]byte(strings.Join(spaces, "\n")))
	return "onboard-" + hex.EncodeToString(sum[:])[:8]
}

// A component made of several input profiles is named for what they share: the
// profile name without its class, or the chart's release name.
func familyName(members []profileDoc, classes []string) string {
	stripped := ""
	for i, m := range members {
		name := str(obj(m.value["metadata"])["name"])
		s := strings.TrimSuffix(name, "-"+Slug(classes[i]))
		if s == name {
			s = strings.TrimSuffix(name, "-"+classes[i])
		}
		if i == 0 {
			stripped = s
		} else if s != stripped {
			stripped = ""
			break
		}
	}
	if stripped != "" && len(members) > 0 && stripped != str(obj(members[0].value["metadata"])["name"]) {
		return stripped
	}
	for _, h := range list(obj(members[0].value["spec"])["helmCharts"]) {
		if r := str(obj(h)["releaseName"]); r != "" {
			return r
		}
	}
	return str(obj(members[0].value["metadata"])["name"])
}

// Every stage's releases wait for one approval of the change as it stands
// there, and every stage after the first waits until the stage ahead has
// released it.
func workflowText(stages []string, bases bool) string {
	lines := []string{
		"# The order a change moves through this profile's clusters, and what each",
		"# stage waits for. ConfigHub enforces both on the server.",
		"#",
		"# AllowAuthors: true lets the person who promoted a change also approve it,",
		"# which one person trying this needs. Set it to false once a second person",
		"# approves: ConfigHub then refuses an approval from the change's author.",
		"AttestationPrerequisites:",
		"  - Name: approval",
		"    Type: Approval",
		"    Count: 1",
		"    AllowAuthors: true",
		"Stages:",
	}
	if bases {
		lines = append(lines,
			"  # carries a change from the root base into every class base;",
			"  # class bases are never released, so nothing waits on this stage",
			"  - Name: "+basesStage,
			fmt.Sprintf("    WhereSpace: \"Labels.Stage = '%s'\"", basesStage))
	}
	for i, stage := range stages {
		lines = append(lines, "  - Name: "+stage, fmt.Sprintf("    WhereSpace: \"Labels.Stage = '%s'\"", stage))
		if i > 0 {
			lines = append(lines, "    Prerequisites:", "      - Released")
		}
		lines = append(lines, "    ReleasePrerequisites:", "      - approval")
	}
	return strings.Join(lines, "\n") + "\n"
}
