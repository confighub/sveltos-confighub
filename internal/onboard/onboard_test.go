package onboard

import (
	"flag"
	"os"
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

const exampleDir = "../../examples/onboard"

var exampleOpts = Options{StageLabel: "env", Stages: []string{"staging", "prod"}}

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
		return
	}
	committed, err := os.ReadFile(filepath.Join(exampleDir, "plan.txt"))
	if err != nil || string(committed) != planText {
		t.Errorf("examples/onboard/plan.txt is not what plan prints today; run go test ./internal/onboard -update")
	}
	want, got := listFiles(t, filepath.Join(exampleDir, "apply")), listFiles(t, scratch)
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

func listFiles(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			out = append(out, rel)
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
	if n != 8 || strings.Join(units, ",") != "bootstrap-ingress-nginx,bootstrap-kyverno,bootstrap-kyverno-policies" {
		t.Errorf("one bootstrap profile per variant, one unit per profile; got %d in %v", n, units)
	}
	if plan.Live {
		t.Errorf("the written example is not live")
	}
}

// Everything apply stores addresses at most one cluster: no selector, no
// ClusterSet, at most one clusterRefs entry naming a SveltosCluster or a
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
	if len(refs) > 1 {
		return false
	}
	if len(refs) == 0 {
		return true
	}
	ref := obj(refs[0])
	kind := str(ref["kind"])
	return (kind == "SveltosCluster" || kind == "Cluster") && str(ref["name"]) != "" && str(ref["namespace"]) != ""
}

func TestEverythingStoredAddressesOneCluster(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	for _, p := range plan.Profiles {
		if !addressedStructurally(p.BaseValue) {
			t.Errorf("%s's base fans out", p.Name)
		}
		for _, v := range p.Variants {
			value, err := VariantValue(p, v)
			if err != nil {
				t.Fatal(err)
			}
			if !addressedStructurally(value) {
				t.Errorf("%s fans out", v.Space)
			}
			// A variant is the base plus exactly its departures.
			back := value
			obj(back["metadata"])["name"] = str(obj(p.BaseValue["metadata"])["name"])
			obj(back["spec"])["clusterRefs"] = []any{}
			if deps, ok := obj(p.BaseValue["spec"])["dependsOn"]; ok {
				obj(back["spec"])["dependsOn"] = deps
			}
			for i, pm := range p.Policies {
				for _, r := range list(obj(back["spec"])["policyRefs"]) {
					if ref := obj(r); str(ref["name"]) == v.Policies[i].Name {
						ref["name"] = pm.Name
					}
				}
			}
			base, _ := yaml.Marshal(p.BaseValue)
			again, _ := yaml.Marshal(back)
			if string(base) != string(again) {
				t.Errorf("%s should differ from its base only in %v", v.Space, v.Departures)
			}
		}
	}
	for _, b := range plan.Management.ByProfile {
		for _, bp := range b.Profiles {
			data, _ := yaml.Marshal(bp)
			var value map[string]any
			_ = yaml.Unmarshal(data, &value)
			if !addressedStructurally(value) {
				t.Errorf("bootstrap %s fans out", bp.Metadata.Name)
			}
		}
	}
}

func TestBaseKeepsTheUsersOrder(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	for _, p := range plan.Profiles {
		data, err := EncodeYAML(p.Base)
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		if strings.HasPrefix(strings.TrimSpace(text), "{") {
			t.Errorf("%s's base should be YAML: a JSON base does not line up with its variants", p.Name)
		}
		if strings.Contains(text, "helmCharts") && strings.Index(text, "syncMode") > strings.Index(text, "helmCharts") {
			t.Errorf("%s's base should keep the key order the user wrote", p.Name)
		}
		if !strings.Contains(text, "clusterRefs: []") {
			t.Errorf("%s's base should reach no cluster", p.Name)
		}
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
		{strings.Contains(script, "publish sveltos-kyverno-prod-eu "+order) && strings.Contains(script, `--revision "ChangeOrder:$2"`),
			"a release names its change order with its base Space, so two profiles' change orders cannot be confused"},
		{strings.Contains(script, "if rolled_out "+order+"; then"), "a finished first release is skipped on a re-run"},
		{strings.Contains(script, `depart sveltos-kyverno-prod-eu clusterprofile '.metadata.name = "kyverno-prod-eu" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-eu"}]'`) &&
			!regexp.MustCompile(`(?m)^cub unit update --space sveltos-kyverno-prod-eu`).MatchString(script),
			"departures touch only their own fields, once, so a variant keeps what the base holds today"},
		{strings.Index(script, order+" --target-stage staging") > 0 && strings.Index(script, order+" --target-stage staging") < strings.Index(script, order+" --target-stage prod"),
			"a profile's stages roll out in order"},
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
		for _, bp := range b.Profiles {
			if bp.Spec.PolicyRefs[0].RemoteURL.SecretRef.Name != "confighub-sveltos-targets" {
				t.Errorf("%s should read the gateway through this onboarding's own Secret", bp.Metadata.Name)
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
	if len(policies.Policies) != 1 || policies.Policies[0].Unit != "configmap-default-kyverno-policies" {
		t.Fatalf("the policy ConfigMap should be held in ConfigHub as one unit beside the profile: %+v", policies.Policies)
	}
	base := policies.Policies[0].BaseValue
	if _, ok := obj(base["metadata"])["uid"]; ok || !strings.Contains(str(obj(base["data"])["disallow-latest-tag.yaml"]), "kind: ClusterPolicy") {
		t.Errorf("the ConfigMap's policies should be held, and nothing the API server wrote back")
	}
	script := ApplyScript(plan)
	for _, v := range policies.Variants {
		if len(v.Policies) != 1 || v.Policies[0].Name != "kyverno-policies-"+v.Target {
			t.Errorf("%s should read its own copy of the policies: %+v", v.Space, v.Policies)
		}
		if !strings.Contains(v.DepartExpression, `select(.kind == "ConfigMap" and .namespace == "default" and .name == "kyverno-policies") | .name) = "kyverno-policies-`+v.Target+`"`) {
			t.Errorf("%s's policyRefs entry should be renamed where it stands: %s", v.Space, v.DepartExpression)
		}
		if !strings.Contains(script, "depart "+v.Space+" configmap-default-kyverno-policies '.metadata.name = \"kyverno-policies-"+v.Target+"\"'") {
			t.Errorf("%s's copy of the ConfigMap should be renamed for its cluster", v.Space)
		}
		value, err := VariantValue(policies, v)
		if err != nil {
			t.Fatal(err)
		}
		ref := obj(list(obj(value["spec"])["policyRefs"])[0])
		if str(ref["name"]) != "kyverno-policies-"+v.Target || !addressedStructurally(value) {
			t.Errorf("%s should address one cluster and read its own policies: %v", v.Space, ref)
		}
		if v.DependsOn[0] != "kyverno-"+v.Target {
			t.Errorf("%s should depend on the kyverno variant for its own cluster", v.Space)
		}
	}
	if !strings.Contains(script, "cub unit create --space sveltos-kyverno-policies-base configmap-default-kyverno-policies kyverno-policies/configmap-default-kyverno-policies.yaml") {
		t.Errorf("the base should hold the policy ConfigMap")
	}

	missing := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n  policyRefs: [{kind: ConfigMap, namespace: default, name: pols}, {kind: Secret, namespace: default, name: creds}, {kind: ConfigMap, name: local}]\n"), Options{})
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

	live := strings.Replace(mgmt+cluster("a", "projectsveltos", "env", "prod")+"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: pols, namespace: default, uid: \"9\"}\ndata: {p.yaml: x}\n---\napiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p, uid: \"1\"}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n  policyRefs: [{kind: ConfigMap, namespace: default, name: pols}]\n", "\\n", "\n", -1)
	takeover := TakeoverScript(mustPlan(t, parse(t, live), Options{}))
	if !strings.Contains(takeover, "kubectl delete configmap -n default pols") {
		t.Errorf("the takeover should name the original ConfigMap, which is no longer read")
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
	var clusters []Doc
	for _, d := range exampleDocs(t) {
		if isClusterKind(d.Value) {
			clusters = append(clusters, d)
		}
	}
	again := mustPlan(t, append(parse(t, string(saved)), clusters...), exampleOpts)
	if again.Live {
		t.Errorf("the saved profiles.yaml should not read as live profiles")
	}
	for i := range plan.Profiles {
		if plan.Profiles[i].ReleaseOrder != again.Profiles[i].ReleaseOrder {
			t.Errorf("the saved profiles.yaml should plan the same fleet again")
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
  spec: {clusterSelector: {matchLabels: {env: prod}}}
`
	plan := mustPlan(t, parse(t, list), Options{})
	if len(plan.Profiles) != 1 || len(plan.Profiles[0].Variants) != 1 || !plan.Live {
		t.Fatalf("a kubectl List should flatten, and a profile with a uid is live")
	}
	if !strings.Contains(RenderPlan(plan, true), "takeover.sh") || !strings.Contains(RenderPlan(plan, true), "If your profiles are live") {
		t.Errorf("a live fleet's plan should point at takeover.sh and its guide")
	}
	if _, ok := obj(plan.Profiles[0].BaseValue["metadata"])["uid"]; ok {
		t.Errorf("the base should keep nothing the API server wrote")
	}
	takeover := TakeoverScript(plan)
	if !(strings.Index(takeover, `LeavePolicies`) > 0 && strings.Index(takeover, "LeavePolicies") < strings.Index(takeover, "k delete clusterprofile p ")) {
		t.Errorf("the takeover should set LeavePolicies before deleting the live profile, or the add-ons are uninstalled first")
	}
	if !strings.Contains(takeover, "for profile in p-a; do") {
		t.Errorf("the takeover should wait until every per-cluster profile has arrived")
	}
}

func TestRecordedMatchesAndSkips(t *testing.T) {
	recorded := mgmt + cluster("a", "projectsveltos", "env", "prod") + cluster("b", "projectsveltos", "env", "prod") + `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: p, uid: "1"}
spec: {clusterSelector: {matchLabels: {env: prod}}}
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
	noMgmt := mustPlan(t, parse(t, cluster("a", "projectsveltos", "env", "prod")+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec: {clusterSelector: {matchLabels: {env: prod}}}\n"), Options{})
	if !strings.Contains(strings.Join(noMgmt.Problems, " "), "no management cluster") {
		t.Errorf("a plan without a management cluster should say so")
	}
	badStage := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "qa")+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec: {clusterSelector: {matchLabels: {env: qa}}}\n"), Options{StageLabel: "env", Stages: []string{"prod"}})
	if !strings.Contains(strings.Join(badStage.Problems, " "), `its env label is "qa"`) {
		t.Errorf("a cluster outside the stages should be named: %v", badStage.Problems)
	}
	if _, err := WriteApply(badStage, t.TempDir()); err == nil {
		t.Errorf("apply should refuse a plan with problems")
	}
	two := mgmt + cluster("a", "projectsveltos", "env", "prod") + "apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec: {clusterSelector: {matchLabels: {env: prod}}}\n---\napiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: q}\nspec: {clusterSelector: {matchLabels: {env: prod}}}\n"
	only := mustPlan(t, parse(t, two), Options{Profiles: []string{"q"}})
	if len(only.Profiles) != 1 || only.Profiles[0].Name != "q" {
		t.Errorf("--profiles should onboard only the named profiles")
	}
	unknown := mustPlan(t, parse(t, two), Options{Profiles: []string{"nope"}})
	if !strings.Contains(strings.Join(unknown.Problems, " "), "--profiles names nope") {
		t.Errorf("--profiles naming a missing profile should say so")
	}
	deps := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: cert-manager}\nspec: {clusterSelector: {matchLabels: {env: prod}}}\n---\napiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: app}\nspec: {clusterSelector: {matchLabels: {env: prod}}, dependsOn: [cert-manager]}\n"), Options{})
	for _, p := range deps.Profiles {
		if p.Name == "app" {
			v := p.Variants[0]
			if v.DependsOn[0] != "cert-manager-a" || !strings.HasSuffix(v.DepartExpression, `.spec.dependsOn = ["cert-manager-a"]`) {
				t.Errorf("dependsOn should name the dependency's variant for the same cluster: %v", v.DepartExpression)
			}
		}
	}
	unmet := mustPlan(t, parse(t, mgmt+cluster("a", "projectsveltos", "env", "prod")+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: app}\nspec: {clusterSelector: {matchLabels: {env: prod}}, dependsOn: [missing]}\n"), Options{})
	if !strings.Contains(strings.Join(unmet.Problems, " "), "depends on missing") {
		t.Errorf("a dependency the input does not onboard should be named")
	}
	capi := mustPlan(t, parse(t, mgmt+"apiVersion: cluster.x-k8s.io/v1beta1\nkind: Cluster\nmetadata: {name: c1, namespace: fleet, labels: {gpu: \"true\"}}\n---\napiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: gpu-operator}\nspec: {clusterSelector: {matchLabels: {gpu: \"true\"}}}\n"), Options{})
	ref := capi.Profiles[0].Variants[0].ClusterRef
	if ref.Kind != "Cluster" || ref.APIVersion != "cluster.x-k8s.io/v1beta1" || ref.Namespace != "fleet" {
		t.Errorf("a Cluster API cluster should be addressed as its Cluster: %+v", ref)
	}
	twins := mustPlan(t, parse(t, mgmt+cluster("a", "team-1", "env", "prod")+cluster("a", "team-2", "env", "prod")+"apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec: {clusterSelector: {matchLabels: {env: prod}}}\n"), Options{})
	var targets []string
	for _, v := range twins.Profiles[0].Variants {
		targets = append(targets, v.Target)
	}
	if strings.Join(targets, ",") != "team-1-a,team-2-a" {
		t.Errorf("two clusters of one name should keep their namespaces in their Targets: %v", targets)
	}
}
