package onboard

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// go test ./internal/onboard -update rewrites the committed example from the code.
var update = flag.Bool("update", false, "rewrite examples/onboard from the code")

// go test ./internal/onboard -record renders the example's charts with cub helm
// and keeps what it printed in testdata, so the tests run offline.
var record = flag.Bool("record", false, "render the example's charts with cub helm and record them")

const exampleDir = "../../examples/onboard"

var exampleOpts = Options{StageLabel: "env", Stages: []string{"staging", "prod"}, IncludeHooks: []string{"ingress-nginx"}, Render: recorded}

// recorded replays a rendering cub helm template printed for the same chart,
// recorded under testdata/renders.
func recorded(c Chart) (Rendering, error) {
	file := filepath.Join("testdata", "renders", c.Key()+".json.gz")
	if *record {
		r, err := CubHelm(c)
		if err != nil {
			return r, err
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		_ = json.NewEncoder(zw).Encode(recording{string(r.Stdout), string(r.Stderr)})
		_ = zw.Close()
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return r, err
		}
		return r, os.WriteFile(file, buf.Bytes(), 0o644)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return Rendering{}, fmt.Errorf("no recorded rendering of %s %s; run go test ./internal/onboard -record", c.Ref, c.Version)
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return Rendering{}, err
	}
	var r recording
	err = json.NewDecoder(zr).Decode(&r)
	return Rendering{Stdout: []byte(r.Stdout), Stderr: []byte(r.Stderr)}, err
}

// recording is a rendering as testdata keeps it: text, which compresses.
type recording struct {
	Stdout string
	Stderr string
}

// fake renders a chart into a Namespace and one Deployment whose fields come
// from the values: replicas, and one environment variable per value, so a
// class's values show up as real fields. More than one replica adds a
// PodDisruptionBudget, as Kyverno's chart does. A value hooks: install adds a
// hook the rendering leaves out.
func fake(c Chart) (Rendering, error) {
	var values map[string]any
	if err := yaml.Unmarshal([]byte(c.Values), &values); err != nil {
		return Rendering{}, err
	}
	replicas := 1
	if r, ok := values["replicas"].(int); ok {
		replicas = r
	}
	var env []string
	var flat func(prefix string, v any)
	flat = func(prefix string, v any) {
		if m, ok := v.(map[string]any); ok {
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				flat(strings.Trim(prefix+"_"+strings.ToUpper(k), "_"), m[k])
			}
			return
		}
		env = append(env, fmt.Sprintf("            - {name: %s, value: %q}", prefix, fmt.Sprint(v)))
	}
	delete(values, "replicas")
	delete(values, "hooks")
	flat("", values)
	envBlock := ""
	if len(env) > 0 {
		envBlock = "\n          env:\n" + strings.Join(env, "\n")
	}
	out := fmt.Sprintf(`# Unit: namespace
apiVersion: v1
kind: Namespace
metadata:
  name: %[1]s
---
# Unit: deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: %[2]s
  namespace: %[1]s
spec:
  replicas: %[3]d
  template:
    spec:
      containers:
        - name: %[2]s
          image: %[4]s:%[5]s%[6]s
`, c.Namespace, c.Release, replicas, c.Ref, c.Version, envBlock)
	if replicas > 1 {
		out += fmt.Sprintf(`---
# Unit: pdb
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: %[1]s
  namespace: %[2]s
spec:
  minAvailable: 1
`, c.Release, c.Namespace)
	}
	stderr := ""
	if strings.Contains(c.Values, "hooks: install") && !c.IncludeHooks {
		stderr = fmt.Sprintf("Dropped hook manifest: Job %s-certgen (helm.sh/hook: pre-install,pre-upgrade) from x\nDropped hook manifest: Pod %s-test (helm.sh/hook: test) from y\n", c.Release, c.Release)
	}
	return Rendering{Stdout: []byte(out), Stderr: []byte(stderr)}, nil
}

func exampleDocs(t *testing.T) []Doc {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(exampleDir, "my-fleet.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	docs, err := ParseDocs(data)
	if err != nil {
		t.Fatal(err)
	}
	return docs
}

func mustPlan(t *testing.T, docs []Doc, opts Options) *Plan {
	t.Helper()
	if opts.Render == nil {
		opts.Render = fake
	}
	p, err := PlanFleet(docs, opts)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func parse(t *testing.T, text string) []Doc {
	t.Helper()
	docs, err := ParseDocs([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return docs
}

func cluster(name, ns string, labels ...string) string {
	var l strings.Builder
	for i := 0; i+1 < len(labels); i += 2 {
		l.WriteString("\n    " + labels[i] + ": " + labels[i+1])
	}
	labelBlock := ""
	if l.Len() > 0 {
		labelBlock = "\n  labels:" + l.String()
	}
	return "apiVersion: lib.projectsveltos.io/v1beta1\nkind: SveltosCluster\nmetadata:\n  name: " + name + "\n  namespace: " + ns + labelBlock + "\n---\n"
}

const mgmt = "apiVersion: lib.projectsveltos.io/v1beta1\nkind: SveltosCluster\nmetadata:\n  name: mgmt\n  namespace: mgmt\n---\n"

// profile is a ClusterProfile installing one chart, named for the profile.
func profile(name, spec string) string {
	return "apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: " + name + "}\nspec:\n" + spec +
		"\n  helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/" + name + ", chartVersion: 1.0.0, releaseName: " + name + ", releaseNamespace: " + name + "}]\n---\n"
}

func TestSelects(t *testing.T) {
	labels := map[string]string{"env": "prod", "region": "eu"}
	cases := []struct {
		selector string
		want     bool
	}{
		{"matchLabels: {env: prod}", true},
		{"matchLabels: {env: staging}", false},
		{"matchExpressions: [{key: env, operator: In, values: [staging, prod]}]", true},
		{"matchExpressions: [{key: tier, operator: In, values: [a]}]", false},
		{"matchExpressions: [{key: tier, operator: NotIn, values: [a]}]", true},
		{"matchExpressions: [{key: env, operator: NotIn, values: [prod]}]", false},
		{"matchExpressions: [{key: region, operator: Exists}]", true},
		{"matchExpressions: [{key: region, operator: DoesNotExist}]", false},
	}
	for _, c := range cases {
		var sel map[string]any
		if err := yaml.Unmarshal([]byte(c.selector), &sel); err != nil {
			t.Fatal(err)
		}
		got, err := Selects(sel, labels)
		if err != nil || got != c.want {
			t.Errorf("%s: got %v %v, want %v", c.selector, got, err, c.want)
		}
	}
}

// renderedCharts are the files apply writes that hold a rendered chart. The
// committed example leaves them out (Kyverno's alone is over 5 MB); they are
// what cub helm template prints, recorded under testdata/renders.
func renderedCharts(plan *Plan) map[string]bool {
	out := map[string]bool{}
	for _, p := range plan.Profiles {
		for _, u := range p.Units {
			if u.Chart != nil {
				out[p.Name+"/"+u.Slug+".yaml"] = true
			}
		}
	}
	return out
}

// The committed example is what the code produces today; -update rewrites it.
func TestExampleIsCurrent(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	if len(plan.Problems) > 0 {
		t.Fatalf("the example plans with problems: %v", plan.Problems)
	}
	scratch := t.TempDir()
	if _, err := WriteApply(plan, scratch); err != nil {
		t.Fatal(err)
	}
	planText := RenderPlan(plan, true)
	if *update {
		if err := os.WriteFile(filepath.Join(exampleDir, "plan.txt"), []byte(planText), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(filepath.Join(exampleDir, "apply")); err != nil {
			t.Fatal(err)
		}
		if _, err := WriteApply(plan, filepath.Join(exampleDir, "apply")); err != nil {
			t.Fatal(err)
		}
		for f := range renderedCharts(plan) {
			if err := os.Remove(filepath.Join(exampleDir, "apply", f)); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
	committed, err := os.ReadFile(filepath.Join(exampleDir, "plan.txt"))
	if err != nil || string(committed) != planText {
		t.Errorf("examples/onboard/plan.txt is not what plan prints today; run go test ./internal/onboard -update")
	}
	skip := renderedCharts(plan)
	want, got := listFiles(t, filepath.Join(exampleDir, "apply"), skip), listFiles(t, scratch, skip)
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("examples/onboard/apply holds %v but apply writes %v; run go test ./internal/onboard -update", want, got)
	}
	for _, f := range got {
		a, _ := os.ReadFile(filepath.Join(exampleDir, "apply", f))
		b, _ := os.ReadFile(filepath.Join(scratch, f))
		if string(a) != string(b) {
			t.Errorf("examples/onboard/apply/%s is not what apply writes today; run go test ./internal/onboard -update", f)
		}
	}
}

func listFiles(t *testing.T, dir string, skip map[string]bool) []string {
	t.Helper()
	var out []string
	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			if !skip[rel] {
				out = append(out, rel)
			}
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func TestExamplePlan(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	byName := map[string]Profile{}
	for _, p := range plan.Profiles {
		byName[p.Name] = p
	}
	var got [][2]string
	for _, v := range byName["kyverno"].Variants {
		got = append(got, [2]string{v.Cluster, v.Stage})
	}
	want := [][2]string{{"staging-eu", "staging"}, {"prod-eu", "prod"}, {"prod-us", "prod"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("kyverno should reach staging-eu in staging, then prod-eu and prod-us in prod; got %v", got)
	}
	if !reflect.DeepEqual(byName["ingress-nginx"].Stages, []string{"prod"}) {
		t.Errorf("ingress-nginx selects only prod clusters, so its workflow should hold only prod")
	}
	if len(plan.Ungoverned) != 1 || plan.Ungoverned[0].Name != "dev-1" {
		t.Errorf("dev-1 is selected by no profile and should be reported: %v", plan.Ungoverned)
	}
	n := 0
	var units []string
	for _, b := range plan.Management.ByProfile {
		n += len(b.Profiles)
		units = append(units, b.Unit)
	}
	if n != 8 || strings.Join(units, ",") != "delivery-ingress-nginx,delivery-kyverno,delivery-kyverno-policies" {
		t.Errorf("one delivery profile per variant, one unit per profile; got %d in %v", n, units)
	}
	if plan.Live {
		t.Errorf("the written example is not live")
	}
	kyverno := byName["kyverno"].Units
	if len(kyverno) != 1 || kyverno[0].Slug != "kyverno" || kyverno[0].count("CustomResourceDefinition") == 0 {
		t.Fatalf("kyverno's base should hold its chart rendered to objects, CRDs included, as one unit: %+v", kyverno)
	}
	for _, o := range kyverno[0].Objects {
		if o.Kind == "Deployment" && o.Name == "kyverno-admission-controller" && fmt.Sprint(obj(o.Value["spec"])["replicas"]) != "3" {
			t.Errorf("the chart should render with the profile's values: the admission controller at 3 replicas")
		}
	}
	if text, _ := kyverno[0].Text(); !strings.HasPrefix(string(text), "# Unit: ") {
		t.Errorf("a chart's unit holds what cub helm template printed, as printed, so rendering the next version shows only what changed")
	}
	if !strings.Contains(RenderPlan(plan, true), "13 Spaces and 8 Links") {
		t.Errorf("one Link per unit of each variant: %s", RenderPlan(plan, true))
	}
}

// Everything the management cluster gets addresses exactly one cluster: no
// selector, no ClusterSet, one clusterRefs entry naming a SveltosCluster or a
// Cluster API Cluster. This is the rule the repository holds its examples to.
func addressedStructurally(v map[string]any) bool {
	spec := obj(v["spec"])
	if _, ok := spec["clusterSelector"]; ok {
		return false
	}
	if _, ok := spec["setRefs"]; ok {
		return false
	}
	refs := list(spec["clusterRefs"])
	if len(refs) != 1 {
		return false
	}
	ref := obj(refs[0])
	kind := str(ref["kind"])
	return (kind == "SveltosCluster" || kind == "Cluster") && str(ref["name"]) != "" && str(ref["namespace"]) != ""
}

func valueOf(t *testing.T, n *yaml.Node) map[string]any {
	t.Helper()
	var v map[string]any
	if err := n.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestEverythingDeliveredAddressesOneCluster(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	for _, p := range plan.Profiles {
		for _, u := range p.Units {
			for _, o := range u.Objects {
				if o.Kind == "ClusterProfile" || o.Kind == "Profile" {
					t.Errorf("%s's base should hold what is delivered, not a Sveltos profile: %s", p.Name, o.Shown())
				}
			}
		}
	}
	for _, b := range plan.Management.ByProfile {
		for i, dp := range b.Profiles {
			value := valueOf(t, dp)
			if !addressedStructurally(value) {
				t.Errorf("delivery profile %s fans out", str(obj(value["metadata"])["name"]))
			}
			var p Profile
			for _, pr := range plan.Profiles {
				if pr.Name == b.Profile {
					p = pr
				}
			}
			v := p.Variants[i]
			ref := obj(list(obj(value["spec"])["policyRefs"])[0])
			if str(obj(ref["remoteURL"])["url"]) != "oci://oci.hub.confighub.com/space/"+v.Space+":latest" || str(ref["deploymentType"]) != "Remote" {
				t.Errorf("%s should deliver %s's latest release to its cluster: %v", v.ProfileName, v.Space, ref)
			}
			if str(obj(list(obj(value["spec"])["clusterRefs"])[0])["name"]) != v.Cluster {
				t.Errorf("%s should be addressed to %s", v.ProfileName, v.Cluster)
			}
		}
	}
}

func TestDeliveryKeepsTheProfilesSettings(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	for _, b := range plan.Management.ByProfile {
		data, err := EncodeYAML(b.Profiles[0])
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		if !strings.Contains(text, "syncMode: ContinuousWithDriftDetection") {
			t.Errorf("%s's delivery profile should keep its syncMode, so Sveltos still repairs drift:\n%s", b.Profile, text)
		}
		if strings.Index(text, "clusterRefs") > strings.Index(text, "syncMode") || strings.Index(text, "syncMode") > strings.Index(text, "policyRefs") {
			t.Errorf("the delivery profile reads clusterRefs, the profile's own settings, then policyRefs:\n%s", text)
		}
		if strings.Contains(text, "helmCharts") || strings.Contains(text, "kind: ConfigMap") {
			t.Errorf("what ConfigHub holds is not delivered a second time:\n%s", text)
		}
		if !strings.Contains(text, "continueOnError: true") {
			t.Errorf("a delivery profile continues past an object that fails, so a custom resource listed before its CRD lands on the retry:\n%s", text)
		}
	}
	carried := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+profile("p", "  clusterSelector: {matchLabels: {env: prod}}\n  continueOnError: false\n  tier: 50\n  policyRefs: [{kind: Secret, namespace: default, name: creds}]\n  kustomizationRefs: [{kind: GitRepository, namespace: flux-system, name: apps, path: ./apps}]")), Options{})
	text, _ := EncodeYAML(carried.Management.ByProfile[0].Profiles[0])
	if strings.Contains(string(text), "continueOnError: false") || !strings.Contains(string(text), "continueOnError: true") {
		t.Errorf("a delivery profile always continues: an exported profile says false by default, which is no choice:\n%s", text)
	}
	for _, want := range []string{"tier: 50", "name: creds", "kustomizationRefs:", "path: ./apps"} {
		if !strings.Contains(string(text), want) {
			t.Errorf("a setting ConfigHub does not hold stays on the delivery profile (%s):\n%s", want, text)
		}
	}
	notes := strings.Join(carried.Notes, " ")
	if !strings.Contains(notes, "Secret default/creds") || !strings.Contains(notes, "kustomizationRefs") {
		t.Errorf("the plan should say what stays out of ConfigHub: %v", carried.Notes)
	}
}

func TestWorkflowGates(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	for _, p := range plan.Profiles {
		if p.Name != "kyverno" {
			continue
		}
		if !regexp.MustCompile(`Name: staging\n {4}WhereSpace: "Labels.Stage = 'staging'"\n {4}ReleasePrerequisites`).MatchString(p.WorkflowText) {
			t.Errorf("the first stage should wait only for approval")
		}
		if !regexp.MustCompile(`Name: prod\n[^\x00]*Prerequisites:\n {6}- Released\n {4}ReleasePrerequisites:\n {6}- approval`).MatchString(p.WorkflowText) {
			t.Errorf("a later stage should wait for Released and approval")
		}
	}
}

func TestApplyScript(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	script := ApplyScript(plan)
	var kyverno Profile
	for _, p := range plan.Profiles {
		if p.Name == "kyverno" {
			kyverno = p
		}
	}
	order := "sveltos-kyverno-base/" + kyverno.ReleaseOrder
	checks := []struct {
		ok   bool
		what string
	}{
		{strings.Contains(script, "cub unit create --space sveltos-kyverno-base kyverno kyverno/kyverno.yaml --change-desc 'Onboard kyverno: chart kyverno 3.8.1 from https://kyverno.github.io/kyverno'"),
			"the base holds the chart's rendered objects, from the file apply wrote"},
		{strings.Contains(script, "publish sveltos-kyverno-prod-eu "+order+" 1") && strings.Contains(script, `--revision "ChangeOrder:$2"`),
			"a release names its change order with its base Space, and how many units the variant must hold"},
		{strings.Contains(script, `holds "$1" "$3" || return 1`), "a variant that lacks units is never released: Sveltos would remove what the release no longer holds"},
		{strings.Contains(script, "holds sveltos-kyverno-prod-eu 1\n"), "a variant is checked right after it is made"},
		{strings.Contains(script, "if rolled_out "+order+"; then"), "a finished first release is skipped on a re-run"},
		{strings.Contains(script, `stages_are sveltos-kyverno-base rollout staging,prod || echo '{"Stages":[{"Name":"staging","WhereSpace":"Labels.Stage = '\''staging'\''","ReleasePrerequisites":["approval"]},{"Name":"prod","WhereSpace":"Labels.Stage = '\''prod'\''","Prerequisites":["Released"],"ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space sveltos-kyverno-base rollout --from-stdin --quiet`),
			"a stage a joining cluster brings is patched into the workflow, and only the stages"},
		{!strings.Contains(script, "depart sveltos-kyverno-prod-eu"), "a cluster's variant holds what its base holds: Sveltos addresses it, so it has nothing to depart in"},
		{strings.Index(script, "promote "+order+" staging") > 0 && strings.Index(script, "promote "+order+" staging") < strings.Index(script, "promote "+order+" prod"),
			"a profile's stages roll out in order"},
		{strings.Contains(script, `case "$out" in *"nothing left to promote"*) return 0`), "a promotion that outlasts its request is asked again, and one the change order finished counts as done"},
		{strings.Contains(script, `--target-stage "$2" --squash --quiet`), "a promotion takes each change as one diff, so a function run at the root cannot reach a class's clusters past its protection"},
		{strings.Contains(script, "k create secret generic confighub-sveltos-targets "), "the gateway Secret is named for its Targets Space"},
		{regexp.MustCompile(`--from-file=username=<\(cub worker get [^)]*BridgeWorkerID`).MatchString(script) &&
			regexp.MustCompile(`--from-file=password=<\(cub worker get [^)]*--include-secret -o jq=\.BridgeWorker\.Secret`).MatchString(script),
			"the gateway credential is the Targets' worker, fed to the Secret through file descriptors"},
		{!strings.Contains(script, "get-token"), "a login token expires within a day, so the fleet must not read the gateway with one"},
		{!strings.Contains(script, "--from-literal"), "a credential on the command line shows in the process list"},
	}
	for _, c := range checks {
		if !c.ok {
			t.Error(c.what)
		}
	}
	for _, b := range plan.Management.ByProfile {
		for _, dp := range b.Profiles {
			v := valueOf(t, dp)
			ref := obj(list(obj(v["spec"])["policyRefs"])[0])
			if str(obj(obj(ref["remoteURL"])["secretRef"])["name"]) != "confighub-sveltos-targets" {
				t.Errorf("%s should read the gateway through this onboarding's own Secret", str(obj(v["metadata"])["name"]))
			}
		}
	}
}

func TestKyvernoPolicies(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	var policies Profile
	for _, p := range plan.Profiles {
		if p.Name == "kyverno-policies" {
			policies = p
		}
	}
	if len(policies.Units) != 1 || policies.Units[0].Slug != "kyverno-policies" || policies.Units[0].Chart != nil {
		t.Fatalf("the policy ConfigMap's objects should be held in ConfigHub as one unit: %+v", policies.Units)
	}
	o := policies.Units[0].Objects[0]
	if o.Kind != "ClusterPolicy" || o.Name != "disallow-latest-tag" {
		t.Errorf("the unit should hold the policy itself, not the ConfigMap around it: %s", o.Shown())
	}
	for _, v := range policies.Variants {
		if len(v.DependsOn) != 1 || v.DependsOn[0] != "kyverno-"+v.Target {
			t.Errorf("%s should wait for the kyverno delivery profile of its own cluster: %v", v.ProfileName, v.DependsOn)
		}
	}
	dp, _ := EncodeYAML(plan.Management.ByProfile[2].Profiles[0])
	if !strings.Contains(string(dp), "dependsOn: [kyverno-staging-eu]") || strings.Contains(string(dp), "kind: ConfigMap") {
		t.Errorf("the delivery profile should depend on kyverno's for its cluster, and read the policies from ConfigHub, not the ConfigMap:\n%s", dp)
	}

	missing := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+profile("p", "  clusterSelector: {matchLabels: {env: prod}}\n  policyRefs: [{kind: ConfigMap, namespace: default, name: pols}, {kind: Secret, namespace: default, name: creds}, {kind: ConfigMap, name: local}]")), Options{})
	all := strings.Join(missing.Problems, " ")
	if !strings.Contains(all, "kubectl get configmap -n default pols -o yaml > pols.yaml and pass that file too") {
		t.Errorf("a ConfigMap missing from the input should be named with the command that adds it: %v", missing.Problems)
	}
	if !strings.Contains(all, "without a namespace") {
		t.Errorf("a ConfigMap named without a namespace should be named as not yet onboarded")
	}
	if !strings.Contains(strings.Join(missing.Notes, " "), "Secret default/creds") {
		t.Errorf("a Secret should be named and left where it is")
	}
	templated := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: pols, namespace: default, annotations: {projectsveltos.io/template: ok}}\ndata: {p.yaml: \"kind: ClusterPolicy\\nmetadata: {name: x}\"}\n---\n"+profile("p", "  clusterSelector: {matchLabels: {env: prod}}\n  policyRefs: [{kind: ConfigMap, namespace: default, name: pols}]")), Options{})
	if !strings.Contains(strings.Join(templated.Problems, " "), "a Sveltos template") {
		t.Errorf("a templated ConfigMap differs per cluster and should be named: %v", templated.Problems)
	}

	live := mgmt + cluster("a", "projectsveltos", "env", "prod") + "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: pols, namespace: default, uid: \"9\"}\ndata: {p.yaml: \"apiVersion: kyverno.io/v1\\nkind: ClusterPolicy\\nmetadata: {name: x}\"}\n---\napiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p, uid: \"1\"}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n  policyRefs: [{kind: ConfigMap, namespace: default, name: pols}]\n"
	handover := HandoverScript(mustPlan(t, parse(t, live), Options{}))
	if !strings.Contains(handover, "kubectl delete configmap -n default pols") {
		t.Errorf("the handover should name the original ConfigMap, which is no longer read")
	}
}

func TestHooks(t *testing.T) {
	fleet := mgmt + cluster("a", "projectsveltos", "env", "prod") + "apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: ingress}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n  helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/ingress, chartVersion: 1.0.0, releaseName: ingress, releaseNamespace: ingress, values: \"hooks: install\\n\"}]\n"
	dropped := mustPlan(t, parse(t, fleet), Options{})
	if !strings.Contains(strings.Join(dropped.Problems, " "), "runs Helm hooks when it installs (Job ingress-certgen)") ||
		!strings.Contains(strings.Join(dropped.Problems, " "), "--include-hooks ingress") {
		t.Errorf("a chart that needs its hooks to install should be named, with the flag that keeps them: %v", dropped.Problems)
	}
	if !strings.Contains(strings.Join(dropped.Notes, " "), "1 Helm hook for upgrade, delete or test") {
		t.Errorf("hooks only Helm needs (test, upgrade, delete) should be named as left out: %v", dropped.Notes)
	}
	kept := mustPlan(t, parse(t, fleet), Options{IncludeHooks: []string{"ingress"}})
	if len(kept.Problems) > 0 || !kept.Profiles[0].Units[0].Chart.IncludeHooks {
		t.Errorf("--include-hooks should render the chart with its hooks as plain objects: %v", kept.Problems)
	}
}

func TestRenderProblems(t *testing.T) {
	base := mgmt + cluster("a", "projectsveltos", "env", "prod")
	chart := func(extra string) string {
		return base + "apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n  helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/p, chartVersion: 1.0.0, releaseName: p, releaseNamespace: p" + extra + "}]\n"
	}
	cases := map[string]string{
		", valuesFrom: [{kind: ConfigMap, name: v}]":      "valuesFrom",
		`, values: "image: {{ .Cluster.metadata.name }}"`: "templates the values",
		", helmChartAction: Uninstall":                    "uninstalls chart",
	}
	for extra, want := range cases {
		p := mustPlan(t, parse(t, chart(extra)), Options{})
		if !strings.Contains(strings.Join(p.Problems, " "), want) {
			t.Errorf("%s should be a problem saying %q: %v", extra, want, p.Problems)
		}
	}
	n := 0
	random := func(c Chart) (Rendering, error) {
		n++
		return Rendering{Stdout: []byte(fmt.Sprintf("apiVersion: v1\nkind: Secret\nmetadata: {name: s, namespace: p}\nstringData: {password: \"%d\"}\n", n))}, nil
	}
	p := mustPlan(t, parse(t, chart("")), Options{Render: random})
	if !strings.Contains(strings.Join(p.Problems, " "), "renders differently each time") {
		t.Errorf("a chart that renders differently each time should be a problem: %v", p.Problems)
	}
	broken := mustPlan(t, parse(t, chart("")), Options{Render: func(Chart) (Rendering, error) {
		return Rendering{}, errors.New("rendering charts needs the cub helm plugin: cub plugin install confighub/cub-helm")
	}})
	if !strings.Contains(strings.Join(broken.Problems, " "), "cub plugin install confighub/cub-helm") {
		t.Errorf("a chart that cannot be rendered should say why: %v", broken.Problems)
	}
	nothing := mustPlan(t, parse(t, base+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec: {clusterSelector: {matchLabels: {env: prod}}}\n"), Options{})
	if !strings.Contains(strings.Join(nothing.Problems, " "), "ConfigHub would hold nothing") {
		t.Errorf("a profile with nothing to hold should be named: %v", nothing.Problems)
	}
}

func TestChartReferences(t *testing.T) {
	var spec map[string]any
	_ = yaml.Unmarshal([]byte(`helmCharts:
  - {repositoryURL: https://kyverno.github.io/kyverno/, chartName: kyverno/kyverno, chartVersion: 3.8.1, releaseName: kyverno, releaseNamespace: kyverno}
  - {repositoryURL: oci://registry-1.docker.io/bitnamicharts, chartName: vault, chartVersion: 1.4.0, releaseName: vault}
  - {repositoryURL: oci://ghcr.io/org/charts/app, chartName: app, chartVersion: 2.0.0, releaseName: app, releaseNamespace: apps, options: {skipCRDs: true}}
`), &spec)
	charts, problems := chartsOf("p", spec, func(string) bool { return false })
	if len(problems) > 0 || len(charts) != 3 {
		t.Fatalf("%v %v", charts, problems)
	}
	got := []string{strings.Join(charts[0].Command("v.yaml"), " "), strings.Join(charts[1].Command(""), " "), strings.Join(charts[2].Command(""), " ")}
	want := []string{
		"cub helm template kyverno kyverno --repo https://kyverno.github.io/kyverno --version 3.8.1 --namespace kyverno --create-namespace",
		"cub helm template vault oci://registry-1.docker.io/bitnamicharts/vault --version 1.4.0 --namespace default --create-namespace",
		"cub helm template app oci://ghcr.io/org/charts/app --version 2.0.0 --namespace apps --create-namespace --skip-crds",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("chart references:\n got %q\nwant %q", got, want)
	}
}

func gpuFamily(extraMeta string) string {
	return mgmt + cluster("gpu-a", "projectsveltos", "env", "staging", "accelerator", "h100") +
		cluster("gpu-b", "projectsveltos", "env", "prod", "accelerator", "h100") +
		cluster("rtx-a", "projectsveltos", "env", "prod", "accelerator", "rtx-pro-6000") + `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: gpu-operator-h100` + extraMeta + `}
spec:
  clusterSelector: {matchLabels: {accelerator: h100}}
  helmCharts:
    - {repositoryURL: https://helm.ngc.nvidia.com/nvidia, chartName: nvidia/gpu-operator, chartVersion: v26.7.0, releaseName: gpu-operator, releaseNamespace: gpu-operator, values: "replicas: 1\ndriver:\n  version: 580.173.02\nmig:\n  strategy: single\n"}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: gpu-operator-rtx-pro-6000` + extraMeta + `}
spec:
  clusterSelector:
    matchExpressions: [{key: accelerator, operator: In, values: [rtx-pro-6000]}]
  helmCharts:
    - {repositoryURL: https://helm.ngc.nvidia.com/nvidia, chartName: nvidia/gpu-operator, chartVersion: v26.7.0, releaseName: gpu-operator, releaseNamespace: gpu-operator, values: "replicas: 2\ndriver:\n  version: 580.173.02\nmig:\n  strategy: none\n"}
`
}

func TestClassBasesFromAccelerators(t *testing.T) {
	plan := mustPlan(t, parse(t, gpuFamily("")), Options{StageLabel: "env", Stages: []string{"staging", "prod"}, ClassLabel: "accelerator"})
	if len(plan.Problems) > 0 {
		t.Fatalf("problems: %v", plan.Problems)
	}
	if len(plan.Profiles) != 1 || plan.Profiles[0].Name != "gpu-operator" {
		t.Fatalf("two accelerator profiles of one chart should be one component named for what they share: %+v", plan.Profiles)
	}
	p := plan.Profiles[0]
	if len(p.Classes) != 2 || p.Classes[0].Value != "h100" || len(p.Classes[0].Departures) != 0 {
		t.Fatalf("the first class is the base itself, with no departures: %+v", p.Classes)
	}
	rtx := p.Classes[1]
	var shown, paths, edits []string
	for _, d := range rtx.Departures {
		shown = append(shown, d.Shown)
		paths = append(paths, d.Resource+":"+d.Path)
		edits = append(edits, d.Edit)
	}
	if rtx.Space != "sveltos-gpu-operator-class-rtx-pro-6000" || !reflect.DeepEqual(shown, []string{
		"Deployment gpu-operator/gpu-operator spec.replicas",
		"Deployment gpu-operator/gpu-operator spec.template.spec.containers[gpu-operator].env[MIG_STRATEGY].value",
		"adds PodDisruptionBudget gpu-operator/gpu-operator",
	}) {
		t.Fatalf("the rtx class should depart in the fields its values render to, and only those: %v", shown)
	}
	if paths[1] != "apps/v1/Deployment:gpu-operator/gpu-operator:spec.template.spec.containers.?name=gpu-operator.env.?name=MIG_STRATEGY.value" {
		t.Errorf("a departure is protected by the path ConfigHub resolves, a named list entry as ?name=: %s", paths[1])
	}
	if edits[1] != `(select(.kind == "Deployment" and .metadata.name == "gpu-operator" and .metadata.namespace == "gpu-operator") | .spec.template.spec.containers[] | select(.name == "gpu-operator") | .env[] | select(.name == "MIG_STRATEGY") | .value) = "none"` {
		t.Errorf("a departure edits one field of one object: %s", edits[1])
	}
	up := map[string]string{}
	for _, v := range p.Variants {
		up[v.Cluster] = v.Upstream
	}
	if up["gpu-a"] != "sveltos-gpu-operator-class-h100" || up["rtx-a"] != "sveltos-gpu-operator-class-rtx-pro-6000" {
		t.Errorf("each cluster's variant should come from its class base: %v", up)
	}
	if !strings.Contains(p.WorkflowText, "- Name: bases") || strings.Contains(p.WorkflowText, "Name: bases\n    WhereSpace: \"Labels.Stage = 'bases'\"\n    ReleasePrerequisites") {
		t.Errorf("the workflow should carry changes into the class bases first, with nothing to release there:\n%s", p.WorkflowText)
	}
	script := ApplyScript(plan)
	for _, want := range []string{
		"cub variant create class-rtx-pro-6000 sveltos-gpu-operator-base --stage bases --space-pattern template:sveltos-gpu-operator-class-rtx-pro-6000 --allow-exists --quiet",
		"if fresh sveltos-gpu-operator-class-rtx-pro-6000 gpu-operator; then\n  cub function set --space sveltos-gpu-operator-class-rtx-pro-6000 --unit gpu-operator --change-desc 'Class rtx-pro-6000 departs from the base: Deployment",
		`-- upsert-resource '[{"ResourceBody":"apiVersion: policy/v1\nkind: PodDisruptionBudget`,
		"policy/v1/PodDisruptionBudget gpu-operator/gpu-operator >/dev/null\n",
		"cub unit set-protection --space sveltos-gpu-operator-class-rtx-pro-6000 gpu-operator --protect apps/v1/Deployment:gpu-operator/gpu-operator:spec.replicas --protect 'apps/v1/Deployment:gpu-operator/gpu-operator:spec.template.spec.containers.?name=gpu-operator.env.?name=MIG_STRATEGY.value' --quiet",
		"cub variant create rtx-a sveltos-gpu-operator-class-rtx-pro-6000 --stage prod",
		"--space-label Role=deployment --space-label Cluster=rtx-a",
		"--component sveltos-gpu-operator --label Component=sveltos-gpu-operator --label Role=base",
		" bases\n",
		"stages_are sveltos-gpu-operator-base rollout bases,staging,prod",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("apply.sh should contain %q", want)
		}
	}
	if strings.Contains(script, "fresh sveltos-gpu-operator-class-h100 ") {
		t.Errorf("a class that is the base itself has nothing to depart in")
	}
	if strings.Index(script, "set-protection --space sveltos-gpu-operator-class-rtx-pro-6000") < strings.Index(script, "-- set-yq '(select(.kind == \"Deployment\"") {
		t.Errorf("a class protects its departures after making them")
	}
	if strings.Index(script, "/onboard-") < 0 || strings.Index(script, " bases\n") > strings.Index(script, " staging\n") {
		t.Errorf("a change should reach the class bases before any cluster")
	}
	text := RenderPlan(plan, true)
	if !strings.Contains(text, "one profile per accelerator: h100, rtx-pro-6000") || !strings.Contains(text, "differs from the base in Deployment gpu-operator/gpu-operator spec.replicas") {
		t.Errorf("the plan should say which classes it made and what they differ in:\n%s", text)
	}

	live := mustPlan(t, parse(t, gpuFamily(`, uid: "1"`)), Options{StageLabel: "env", Stages: []string{"staging", "prod"}, ClassLabel: "accelerator"})
	handover := HandoverScript(live)
	if !strings.Contains(handover, "k delete clusterprofile gpu-operator-h100 ") || !strings.Contains(handover, "k delete clusterprofile gpu-operator-rtx-pro-6000 ") {
		t.Errorf("the handover should hand over every live profile the component was made from")
	}
	if !strings.Contains(handover, "kubectl -n gpu-operator delete secret -l owner=helm,name=gpu-operator") {
		t.Errorf("the handover should say how to remove Helm's record of the release, which a helm uninstall would act on")
	}
}

func TestClassesThatDifferInObjects(t *testing.T) {
	// Kyverno renders a PodDisruptionBudget only above one replica, so a
	// class at 1 lacks an object the others have. The root is the class
	// whose objects every other class has; the others add theirs.
	fleet := mgmt + cluster("t", "projectsveltos", "class", "test") + cluster("p", "projectsveltos", "class", "prod") +
		"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: kyverno-prod}\nspec:\n  clusterSelector: {matchLabels: {class: prod}}\n  helmCharts: [{repositoryURL: https://kyverno.github.io/kyverno, chartName: kyverno/kyverno, chartVersion: 3.8.1, releaseName: kyverno, releaseNamespace: kyverno, values: \"replicas: 3\"}]\n---\n" +
		"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: kyverno-test}\nspec:\n  clusterSelector: {matchLabels: {class: test}}\n  helmCharts: [{repositoryURL: https://kyverno.github.io/kyverno, chartName: kyverno/kyverno, chartVersion: 3.8.1, releaseName: kyverno, releaseNamespace: kyverno, values: \"replicas: 1\"}]\n"
	plan := mustPlan(t, parse(t, fleet), Options{ClassLabel: "class"})
	if len(plan.Problems) > 0 {
		t.Fatalf("classes that differ in objects are classes: %v", plan.Problems)
	}
	p := plan.Profiles[0]
	for _, o := range p.Units[0].Objects {
		if o.Kind == "PodDisruptionBudget" {
			t.Errorf("the base holds what every class has, so no PodDisruptionBudget")
		}
	}
	var prod Class
	for _, c := range p.Classes {
		if c.Value == "prod" {
			prod = c
		}
		if c.Value == "test" && len(c.Departures) > 0 {
			t.Errorf("the class the root was rendered from departs in nothing: %v", c.Departures)
		}
	}
	if describeDepartures(prod.Departures) != "Deployment kyverno/kyverno spec.replicas, adds PodDisruptionBudget kyverno/kyverno" {
		t.Errorf("prod departs in its replicas and adds its PodDisruptionBudget: %s", describeDepartures(prod.Departures))
	}

	var root, class Unit
	root.Slug, class.Slug = "app", "app"
	root.Objects, _ = objectsOf([]byte("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a, namespace: n}\ndata: {k: v}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: c, namespace: n}\n"))
	class.Objects, _ = objectsOf([]byte("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a, namespace: n}\ndata: {k: v}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: b, namespace: n}\n"))
	if got := describeDepartures(departuresOf(root, class)); got != "adds ConfigMap n/b, removes ConfigMap n/c" {
		t.Errorf("a class adds the objects only it has and removes those only the root has: %s", got)
	}
}

func TestFieldChanges(t *testing.T) {
	var from, to map[string]any
	_ = yaml.Unmarshal([]byte(`spec:
  a: 1
  keep: x
  gone: y
  tolerations: [{key: gpu}]
  containers: [{name: c, image: "i:1", env: [{name: A, value: "1"}]}, {name: s, image: "s:1"}]
  labels: {app.kubernetes.io/version: "1"}
`), &from)
	_ = yaml.Unmarshal([]byte(`spec:
  a: 2
  keep: x
  tolerations: [{key: gpu}, {key: infra}]
  containers: [{name: c, image: "i:2", env: [{name: A, value: "2"}]}, {name: s, image: "s:1"}]
  labels: {app.kubernetes.io/version: "2"}
`), &to)
	got := map[string]string{}
	for _, fc := range fieldChanges(from, to, fieldPath{}) {
		got[fc.at.ch] = fmt.Sprintf("%s|%v|%v", fc.at.yq, fc.value, fc.removed)
	}
	want := map[string]string{
		"spec.a":                        ".spec.a|2|false",
		"spec.gone":                     ".spec.gone|<nil>|true",
		"spec.tolerations":              ".spec.tolerations|[map[key:gpu] map[key:infra]]|false",
		"spec.containers.?name=c.image": ".spec.containers[] | select(.name == \"c\") | .image|i:2|false",
		"spec.containers.?name=c.env.?name=A.value": ".spec.containers[] | select(.name == \"c\") | .env[] | select(.name == \"A\") | .value|2|false",
		"spec.labels.app~1kubernetes~1io/version":   ".spec.labels[\"app.kubernetes.io/version\"]|2|false",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("field changes:\n got %v\nwant %v", got, want)
	}
}

func TestJoiningCluster(t *testing.T) {
	base := mustPlan(t, exampleDocs(t), exampleOpts)
	docs := append(exampleDocs(t), parse(t, cluster("staging-us", "projectsveltos", "env", "staging")+cluster("prod-eu", "projectsveltos", "env", "prod", "region", "eu"))...)
	joined := mustPlan(t, docs, exampleOpts)
	orders := func(p *Plan) map[string]string {
		out := map[string]string{}
		for _, pr := range p.Profiles {
			out[pr.Name] = pr.ReleaseOrder
		}
		return out
	}
	if orders(joined)["kyverno"] == orders(base)["kyverno"] || orders(joined)["ingress-nginx"] != orders(base)["ingress-nginx"] {
		t.Errorf("a joining cluster should give its profiles a new release change order, and leave the others' unchanged")
	}
	n := 0
	for _, tg := range joined.Targets {
		if tg.Cluster == "prod-eu" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("a cluster given twice should be one cluster, the later description winning")
	}
}

func TestSavedProfilesReplanTheSameFleet(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	dir := t.TempDir()
	if _, err := WriteApply(plan, dir); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(filepath.Join(dir, "profiles.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var clusters, maps []Doc
	for _, d := range exampleDocs(t) {
		if isClusterKind(d.Value) {
			clusters = append(clusters, d)
		}
		if str(d.Value["kind"]) == "ConfigMap" {
			maps = append(maps, d)
		}
	}
	again := mustPlan(t, append(append(parse(t, string(saved)), clusters...), maps...), exampleOpts)
	if again.Live {
		t.Errorf("the saved profiles.yaml should not read as live profiles")
	}
	for i := range plan.Profiles {
		if plan.Profiles[i].ReleaseOrder != again.Profiles[i].ReleaseOrder {
			t.Errorf("the saved profiles.yaml should plan the same fleet again")
		}
		a, _ := plan.Profiles[i].Units[0].Text()
		b, _ := again.Profiles[i].Units[0].Text()
		if !bytes.Equal(a, b) {
			t.Errorf("re-planning should render the same objects")
		}
	}
}

func TestLiveProfiles(t *testing.T) {
	list := `apiVersion: v1
kind: List
items:
- {apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, metadata: {name: mgmt, namespace: mgmt}}
- {apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, metadata: {name: a, namespace: projectsveltos, labels: {env: prod}}}
- apiVersion: config.projectsveltos.io/v1beta1
  kind: ClusterProfile
  metadata: {name: p, uid: "1", resourceVersion: "7"}
  spec:
    clusterSelector: {matchLabels: {env: prod}}
    helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/p, chartVersion: 1.0.0, releaseName: p, releaseNamespace: p}]
`
	plan := mustPlan(t, parse(t, list), Options{})
	if len(plan.Profiles) != 1 || len(plan.Profiles[0].Variants) != 1 || !plan.Live {
		t.Fatalf("a kubectl List should flatten, and a profile with a uid is live")
	}
	if !strings.Contains(RenderPlan(plan, true), "handover.sh") || !strings.Contains(RenderPlan(plan, true), "If your profiles are live") {
		t.Errorf("a live fleet's plan should point at handover.sh and its guide")
	}
	handover := HandoverScript(plan)
	if !(strings.Index(handover, `LeavePolicies`) > 0 && strings.Index(handover, "LeavePolicies") < strings.Index(handover, "k delete clusterprofile p ")) {
		t.Errorf("the handover should set LeavePolicies before deleting the live profile, or the add-ons are uninstalled first")
	}
	if !(strings.Index(handover, "k delete clusterprofile p ") < strings.Index(handover, "k apply -f management/p.yaml")) {
		t.Errorf("the handover applies the delivery profiles after the live profile has left, so no object has two profiles managing it:\n%s", handover)
	}
	if !strings.Contains(handover, "k get secret -n projectsveltos confighub-sveltos-targets") {
		t.Errorf("the handover checks that apply.sh has run before anything leaves")
	}
	if script := ApplyScript(plan); strings.Contains(script, "k apply -f management/p.yaml") {
		t.Errorf("apply.sh leaves a live profile's delivery profiles to handover.sh")
	}
}

func TestRecordedMatchesAndSkips(t *testing.T) {
	recorded := mgmt + cluster("a", "projectsveltos", "env", "prod") + cluster("b", "projectsveltos", "env", "prod") + `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: p, uid: "1"}
spec:
  clusterSelector: {matchLabels: {env: prod}}
  helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/p, chartVersion: 1.0.0, releaseName: p, releaseNamespace: p}]
status:
  matchingClusters: [{apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, namespace: projectsveltos, name: a}]
`
	plan := mustPlan(t, parse(t, recorded), Options{})
	if len(plan.Profiles[0].Variants) != 1 || plan.Profiles[0].Variants[0].Cluster != "a" || !strings.Contains(strings.Join(plan.Notes, " "), "projectsveltos/b") {
		t.Errorf("a live profile should follow Sveltos's own record of the clusters it reaches, and say where its selector disagrees")
	}

	skips := mgmt + cluster("a", "projectsveltos", "env", "prod") + `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: e, ownerReferences: [{kind: EventTrigger, name: t}]}
spec: {clusterSelector: {matchLabels: {env: prod}}}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: s}
spec: {setRefs: [prod-set]}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: empty}
spec: {clusterSelector: {}}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: confighub-sveltos-p-a
spec:
  clusterRefs: [{kind: SveltosCluster, namespace: mgmt, name: mgmt}]
  policyRefs: [{deploymentType: Remote, remoteURL: {url: "oci://oci.hub.confighub.com/space/sveltos-p-a:latest"}}]
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: p-a
  annotations: {confighub.com/origin: "{}"}
spec:
  clusterRefs: [{kind: SveltosCluster, namespace: projectsveltos, name: a}]
`
	plan = mustPlan(t, parse(t, skips), Options{})
	reasons := map[string]string{}
	for _, s := range plan.Skipped {
		reasons[s.Name] = s.Reason
	}
	if !strings.Contains(reasons["e"], "event framework") || !strings.Contains(reasons["s"], "ClusterSets") || !strings.Contains(reasons["empty"], "empty clusterSelector") {
		t.Errorf("event-made, ClusterSet and empty-selector profiles should be left out with their reasons: %v", reasons)
	}
	if len(plan.Profiles) != 0 || !strings.Contains(strings.Join(plan.Notes, " "), "confighub-sveltos-p-a, p-a") {
		t.Errorf("profiles ConfigHub already delivers should be left out, not onboarded twice: %v", plan.Notes)
	}
}

func TestProblemsAndOptions(t *testing.T) {
	onProd := "  clusterSelector: {matchLabels: {env: prod}}"
	noMgmt := mustPlan(t, parse(t, cluster("a", "projectsveltos", "env", "prod")+profile("p", onProd)), Options{})
	if !strings.Contains(strings.Join(noMgmt.Problems, " "), "no management cluster") {
		t.Errorf("a plan without a management cluster should say so")
	}
	badStage := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "qa")+profile("p", "  clusterSelector: {matchLabels: {env: qa}}")), Options{StageLabel: "env", Stages: []string{"prod"}})
	if !strings.Contains(strings.Join(badStage.Problems, " "), `its env label is "qa"`) {
		t.Errorf("a cluster outside the stages should be named: %v", badStage.Problems)
	}
	if _, err := WriteApply(badStage, t.TempDir()); err == nil {
		t.Errorf("apply should refuse a plan with problems")
	}
	two := mgmt + cluster("a", "projectsveltos", "env", "prod") + profile("p", onProd) + profile("q", onProd)
	only := mustPlan(t, parse(t, two), Options{Profiles: []string{"q"}})
	if len(only.Profiles) != 1 || only.Profiles[0].Name != "q" {
		t.Errorf("--profiles should onboard only the named profiles")
	}
	unknown := mustPlan(t, parse(t, two), Options{Profiles: []string{"nope"}})
	if !strings.Contains(strings.Join(unknown.Problems, " "), "--profiles names nope") {
		t.Errorf("--profiles naming a missing profile should say so")
	}
	deps := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+profile("cert-manager", onProd)+profile("app", onProd+"\n  dependsOn: [cert-manager]")), Options{})
	for _, p := range deps.Profiles {
		if p.Name == "app" {
			if v := p.Variants[0]; v.DependsOn[0] != "cert-manager-a" {
				t.Errorf("dependsOn should name the dependency's delivery profile for the same cluster: %v", v.DependsOn)
			}
		}
	}
	unmet := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+profile("app", onProd+"\n  dependsOn: [missing]")), Options{})
	if !strings.Contains(strings.Join(unmet.Problems, " "), "depends on missing") {
		t.Errorf("a dependency the input does not onboard should be named")
	}
	capi := mustPlan(t, parse(t, mgmt+"apiVersion: cluster.x-k8s.io/v1beta1\nkind: Cluster\nmetadata: {name: c1, namespace: fleet, labels: {gpu: \"true\"}}\n---\n"+profile("gpu-operator", "  clusterSelector: {matchLabels: {gpu: \"true\"}}")), Options{})
	ref := capi.Profiles[0].Variants[0].ClusterRef
	if ref.Kind != "Cluster" || ref.APIVersion != "cluster.x-k8s.io/v1beta1" || ref.Namespace != "fleet" {
		t.Errorf("a Cluster API cluster should be addressed as its Cluster: %+v", ref)
	}
	twins := mustPlan(t, parse(t, mgmt+cluster("a", "team-1", "env", "prod")+cluster("a", "team-2", "env", "prod")+profile("p", onProd)), Options{})
	var targets []string
	for _, v := range twins.Profiles[0].Variants {
		targets = append(targets, v.Target)
	}
	if strings.Join(targets, ",") != "team-1-a,team-2-a" {
		t.Errorf("two clusters of one name should keep their namespaces in their Targets: %v", targets)
	}
	clash := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+profile("p", onProd)+profile("p-a", "  clusterRefs: [{kind: SveltosCluster, namespace: projectsveltos, name: a}]")), Options{Profiles: []string{"p"}})
	if !strings.Contains(strings.Join(clash.Problems, " "), "would be named p-a, which is already the name of one of your profiles") {
		t.Errorf("a delivery profile must not replace a profile the fleet already has: %v", clash.Problems)
	}
}

func TestKeptHooks(t *testing.T) {
	// ingress-nginx's jobs that make its webhook certificate are hooks Helm
	// runs at install, and the chart gives them a TTL of 0: they delete
	// themselves when they finish.
	kept := func(c Chart) (Rendering, error) {
		out := "# Unit: certgen\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: certgen\n  namespace: n\n  annotations:\n    helm.sh/hook: pre-install,pre-upgrade\nspec:\n  ttlSecondsAfterFinished: 0\n  template:\n    spec:\n      containers:\n        - {name: c, image: \"i:1\"}\n"
		if strings.Contains(c.Values, "tests") {
			out += "---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: smoke\n  namespace: n\n  annotations:\n    helm.sh/hook: test\n"
		}
		return Rendering{Stdout: []byte(out)}, nil
	}
	fleet := func(values string) []Doc {
		return parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: ingress}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n  helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/ingress, chartVersion: 1.0.0, releaseName: ingress, releaseNamespace: ingress, values: \""+values+"\"}]\n")
	}
	plan := mustPlan(t, fleet("a: 1"), Options{IncludeHooks: []string{"ingress"}, Render: kept})
	text, _ := plan.Profiles[0].Units[0].Text()
	rendering, _ := kept(Chart{Values: "a: 1"})
	if len(plan.Problems) > 0 || string(text) != string(rendering.Stdout) {
		t.Errorf("a chart whose hooks are kept is held exactly as cub helm template printed it, TTL and all:\n%s\n%v", text, plan.Problems)
	}
	if script := ApplyScript(plan); !strings.Contains(script, "--include-hooks -f ingress/ingress.values.yaml | "+renderFilter+"\n") {
		t.Errorf("apply.sh records the plain render, so the next version is rendered the same way:\n%s", script)
	}
	dp, _ := EncodeYAML(plan.Management.ByProfile[0].Profiles[0])
	if !strings.Contains(string(dp), "annotationSelector: helm.sh/hook") || !strings.Contains(string(dp), "path: /metadata/annotations/projectsveltos.io~1driftDetectionIgnore") {
		t.Errorf("the delivery profile marks the hooks as Sveltos does for Helm, so a Job that deletes itself is not recreated as drift:\n%s", dp)
	}
	without := mustPlan(t, fleet("a: 1"), Options{Render: fake})
	if dp, _ := EncodeYAML(without.Management.ByProfile[0].Profiles[0]); strings.Contains(string(dp), "patches") {
		t.Errorf("a profile with no kept hooks gets no patch:\n%s", dp)
	}
	tests := mustPlan(t, fleet("tests: true"), Options{IncludeHooks: []string{"ingress"}, Render: kept})
	if !strings.Contains(strings.Join(tests.Problems, " "), "Helm hooks that are not for install (Pod smoke)") {
		t.Errorf("a test or delete hook kept as a plain object would run at install, so it is a problem: %v", tests.Problems)
	}
}
func TestHandoverHandsDependentsOverFirst(t *testing.T) {
	live := func(name, extra string) string {
		return "apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: " + name + ", uid: \"" + name + "\"}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}" + extra +
			"\n  helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/" + name + ", chartVersion: 1.0.0, releaseName: " + name + ", releaseNamespace: " + name + "}]\n---\n"
	}
	fleet := mgmt + cluster("a", "projectsveltos", "env", "prod") + live("kyverno", "") + live("kyverno-policies", "\n  dependsOn: [kyverno]")
	handover := HandoverScript(mustPlan(t, parse(t, fleet), Options{}))
	if strings.Index(handover, "k delete clusterprofile kyverno-policies ") > strings.Index(handover, "k delete clusterprofile kyverno ") {
		t.Errorf("Sveltos holds a profile's deletion while another depends on it, so the dependent is handed over first:\n%s", handover)
	}
}

// liveFleet is a live profile as kubectl exports it: installing one chart and
// the policies of one ConfigMap, reaching clusters a and b.
const liveFleet = `apiVersion: v1
kind: List
items:
- {apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, metadata: {name: mgmt, namespace: mgmt}}
- {apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, metadata: {name: a, namespace: projectsveltos, labels: {env: prod}}}
- {apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, metadata: {name: b, namespace: projectsveltos, labels: {env: prod}}}
- apiVersion: v1
  kind: ConfigMap
  metadata: {name: policies, namespace: default, resourceVersion: "41"}
  data: {policy.yaml: "apiVersion: kyverno.io/v1\nkind: ClusterPolicy\nmetadata: {name: no-latest}\n"}
- apiVersion: config.projectsveltos.io/v1beta1
  kind: ClusterProfile
  metadata: {name: p, uid: u-1, generation: 3}
  spec:
    clusterSelector: {matchLabels: {env: prod}}
    helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/p, chartVersion: 1.0.0, releaseName: p, releaseNamespace: p}]
    policyRefs: [{kind: ConfigMap, namespace: default, name: policies}]
  status:
    matchingClusters:
    - {apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, namespace: projectsveltos, name: a}
    - {apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, namespace: projectsveltos, name: b}
`

// The handover must not swap in what ConfigHub holds when the live profile
// or its policies changed after the export: the delivery profiles would
// change the clusters to match an older plan. This runs handover.sh itself
// against a stand-in kubectl, so it tests what the checks do, not their text.
func TestHandoverStopsWhenWhatIsLiveHasChanged(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("needs bash")
	}
	plan := mustPlan(t, parse(t, liveFleet), Options{})
	if len(plan.Problems) > 0 {
		t.Fatalf("problems: %v", plan.Problems)
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	kubectl := `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"get secret"*) exit 0 ;;
  *"get clusterprofile"*uid*) [ -n "$PROFILE_NOW" ] || exit 1; printf '%s' "$PROFILE_NOW" ;;
  *"get clusterprofile"*matchingClusters*) [ -n "$PROFILE_NOW" ] || exit 1; printf '%b' "$CLUSTERS_NOW" ;;
  *"get clusterprofile"*) [ -n "$PROFILE_NOW" ] || exit 1 ;;
  *"get configmap"*) printf '%s' "$POLICIES_NOW" ;;
  *) echo "$args" >> "$LOG" ;;
esac
`
	for name, text := range map[string]string{"kubectl": kubectl, "sleep": "#!/bin/sh\nexit 0\n"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(text), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script := filepath.Join(dir, "handover.sh")
	if err := os.WriteFile(script, []byte(HandoverScript(plan)), 0o755); err != nil {
		t.Fatal(err)
	}
	both := `SveltosCluster/projectsveltos/a\nSveltosCluster/projectsveltos/b\n`
	for _, c := range []struct {
		name, profile, clusters, policies string
		stops                             string
	}{
		{"as exported", "u-1 3 WithdrawPolicies", both, "41", ""},
		{"a run that stopped after LeavePolicies", "u-1 4 LeavePolicies", both, "41", ""},
		{"already handed over", "", both, "41", ""},
		{"changed since the export", "u-1 4 WithdrawPolicies", both, "41", "p has changed since you exported it (generation 3, now 4)"},
		{"deleted and made again", "u-2 1 WithdrawPolicies", both, "41", "p is not the profile you exported"},
		{"reaching other clusters", "u-1 3 WithdrawPolicies", `SveltosCluster/projectsveltos/a\n`, "41", "p reaches SveltosCluster/projectsveltos/a now"},
		{"policies edited", "u-1 3 WithdrawPolicies", both, "42", "ConfigMap default/policies has changed since you exported it"},
	} {
		log := filepath.Join(dir, c.name+".log")
		cmd := exec.Command("bash", script)
		cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "LOG="+log,
			"PROFILE_NOW="+c.profile, "CLUSTERS_NOW="+c.clusters, "POLICIES_NOW="+c.policies)
		out, err := cmd.CombinedOutput()
		changed, _ := os.ReadFile(log)
		if c.stops == "" {
			if err != nil || !strings.Contains(string(changed), "apply -f management/p.yaml") {
				t.Errorf("%s: the handover should go ahead (err %v):\n%s\nkubectl changed:\n%s", c.name, err, out, changed)
			}
			if c.profile == "" && strings.Contains(string(changed), "delete clusterprofile") {
				t.Errorf("%s: a profile already gone is not deleted again", c.name)
			}
			continue
		}
		if err == nil || !strings.Contains(string(out), c.stops) {
			t.Errorf("%s: the handover should stop with %q (err %v):\n%s", c.name, c.stops, err, out)
		}
		if len(changed) > 0 {
			t.Errorf("%s: the handover changed something before it stopped:\n%s", c.name, changed)
		}
	}
}

// A chart ConfigHub renders must be the chart Sveltos installed: an exact
// version from a Helm or OCI repository.
func TestChartVersionsMustBeExact(t *testing.T) {
	for _, c := range []struct {
		repo, version string
		problem       string
	}{
		{"https://charts.example.com", "1.0.0", ""},
		{"https://charts.example.com", "v26.3.1", ""},
		{"oci://registry.example/charts", "1.2.3-rc.1", ""},
		{"https://charts.example.com", "1.0.x", `at "1.0.x", which is not one exact version`},
		{"https://charts.example.com", "^1.0.0", `at "^1.0.0", which is not one exact version`},
		{"https://charts.example.com", "1.0", `at "1.0", which is not one exact version`},
		{"https://charts.example.com", "", `at "", which is not one exact version`},
		{"gitrepository://flux-system/flux-system/charts/p", "", "from a Flux source, gitrepository://flux-system/flux-system/charts/p"},
		{"ocirepository://flux-system/charts/p", "1.0.0", "from a Flux source"},
	} {
		fleet := mgmt + cluster("a", "projectsveltos", "env", "prod") +
			"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n" +
			"  helmCharts: [{repositoryURL: \"" + c.repo + "\", chartName: example/p, chartVersion: \"" + c.version + "\", releaseName: p, releaseNamespace: p}]\n"
		plan := mustPlan(t, parse(t, fleet), Options{})
		got := strings.Join(plan.Problems, "\n")
		if c.problem == "" && got != "" {
			t.Errorf("%s at %q is one exact chart, but: %s", c.repo, c.version, got)
		}
		if c.problem != "" && !strings.Contains(got, c.problem) {
			t.Errorf("%s at %q should be a problem saying %q, got: %q", c.repo, c.version, c.problem, got)
		}
	}
}

// A profile something else makes or applies comes back after the handover
// deletes it, and competes with the delivery profiles.
func TestProfilesSomethingElseApplies(t *testing.T) {
	owned := mgmt + cluster("a", "projectsveltos", "env", "prod") +
		"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata:\n  name: p-staging\n  ownerReferences: [{apiVersion: config.projectsveltos.io/v1beta1, kind: ClusterPromotion, name: p, uid: x}]\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n" +
		"  helmCharts: [{repositoryURL: https://charts.example.com, chartName: example/p, chartVersion: 1.0.0, releaseName: p, releaseNamespace: p}]\n"
	plan := mustPlan(t, parse(t, owned), Options{})
	if len(plan.Profiles) != 0 || len(plan.Skipped) != 1 || !strings.Contains(plan.Skipped[0].Reason, "owned by ClusterPromotion p") {
		t.Errorf("a profile a ClusterPromotion owns is left to it, with the reason: %+v", plan.Skipped)
	}

	gitops := strings.Replace(liveFleet, "metadata: {name: p, uid: u-1, generation: 3}",
		"metadata: {name: p, uid: u-1, generation: 3, labels: {kustomize.toolkit.fluxcd.io/name: infra, kustomize.toolkit.fluxcd.io/namespace: flux-system}}", 1)
	plan = mustPlan(t, parse(t, gitops), Options{})
	if !strings.Contains(strings.Join(plan.Notes, "\n"), "p is applied by Flux Kustomization flux-system/infra") {
		t.Errorf("the plan should say a live profile is applied by Flux, and how to hand it over: %v", plan.Notes)
	}
	handover := HandoverScript(plan)
	guard := strings.Index(handover, "k get clusterprofile p >/dev/null 2>&1 && fail")
	if guard < 0 || guard > strings.Index(handover, "k patch clusterprofile p") {
		t.Errorf("handover.sh should stop, before changing anything, while Flux still applies the profile:\n%s", handover)
	}
}

// cub helm template prints a stray line at the top of some documents, which
// ConfigHub drops when a unit is created but keeps when it is updated. The
// base must hold the render without it, and every object the render has.
func TestStrayLinesAreDropped(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	for _, p := range plan.Profiles {
		for _, u := range p.Units {
			if u.Chart == nil {
				continue
			}
			text, _ := u.Text()
			rendering, _ := recorded(*u.Chart)
			if strings.Contains(string(text), strayLine) {
				t.Errorf("%s: the base holds the stray line cub helm template prints", u.Slug)
			}
			want := strings.Count(string(rendering.Stdout), "\n"+strayLine+"\n")
			if got := strings.Count(string(rendering.Stdout), "\n") - strings.Count(string(text), "\n"); got != want {
				t.Errorf("%s: %d lines dropped, want the %d stray ones only", u.Slug, got, want)
			}
			if u.Slug == "kyverno" && (want == 0 || len(u.Objects) != 71) {
				t.Errorf("kyverno's recorded render has stray lines (%d), and all 71 objects stay (%d)", want, len(u.Objects))
			}
		}
	}
}
