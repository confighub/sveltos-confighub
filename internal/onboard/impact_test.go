package onboard

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const policyDir = "../../examples/meridian-slice/policies"

func deployment(name string, replicas int, image string) string {
	return fmt.Sprintf("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: %s\n  namespace: kyverno\n  labels: {app.kubernetes.io/part-of: kyverno}\nspec:\n  replicas: %d\n  template:\n    spec:\n      containers: [{name: c, image: %q}]\n", name, replicas, image)
}

// impactBench is ConfigHub and a sandbox API server. The sandbox applies the
// two example policies' rules, reading the ceilings from whichever
// parameters were applied last, as the real one would.
type impactBench struct {
	t        *testing.T
	units    map[string]string // space/unit@rev: data
	upstream map[string]string // space: its upstream Space
	failing  map[string][]int  // space: revisions recorded as failing
	stageOf  map[string]string // sandbox namespace: stage
	ceilings map[string]int    // stage: ceiling
	exempt   bool              // disallow-latest-tag exempts Kyverno's controllers
	applies  int
	leftover []string // policies the sandbox holds from an earlier run
	deleted  []string
	runs     string // the workloads the sandbox runs, as kubectl lists them
	// the policies held in ConfigHub, in mer-policies: each unit's head, and
	// the revision tagged in-force
	policyHeads map[string]int
	inForce     map[string]int
}

// hub is the ConfigHub half of the bench.
func (b *impactBench) hub() *fakeHub {
	return &fakeHub{t: b.t,
		spaces: func(where string) ([]HubSpace, error) {
			if !strings.HasPrefix(where, "Component.Slug = 'mer-kyverno'") {
				b.t.Errorf("the targets are the component's cluster variants: %s", where)
			}
			return []HubSpace{
				{Slug: "mer-kyverno-eu-central-test1", Labels: map[string]string{"Stage": "test", "Cluster": "eu-central-test1"}},
				{Slug: "mer-kyverno-eu-central-prod1", Labels: map[string]string{"Stage": "prod", "Cluster": "eu-central-prod1"}}}, nil
		},
		space: func(space string) (HubSpace, error) {
			return HubSpace{Slug: space, Labels: map[string]string{"Stage": "bases"}}, nil
		},
		units: func(space string) ([]HubUnit, error) {
			if space == "mer-policies" {
				var slugs []string
				for u := range b.policyHeads {
					slugs = append(slugs, u)
				}
				sort.Strings(slugs)
				var units []HubUnit
				for _, u := range slugs {
					units = append(units, HubUnit{Slug: u, SpaceSlug: space, Head: b.policyHeads[u]})
				}
				return units, nil
			}
			up := b.upstream[space]
			return []HubUnit{{Slug: "kyverno", SpaceSlug: space, Head: 9, Released: 7, UpstreamUnitID: "u-" + up, UpstreamSpaceID: up}}, nil
		},
		unit: func(space, unit string) (HubUnit, error) {
			if space == "mer-policies" {
				head, ok := b.policyHeads[unit]
				if !ok {
					return HubUnit{}, errors.New("not found")
				}
				return HubUnit{Slug: unit, SpaceSlug: space, Head: head}, nil
			}
			return HubUnit{Slug: "kyverno", SpaceSlug: space, Head: 12}, nil
		},
		tagID: func(space, tag string) (string, error) {
			if space == "mer-policies" && tag == "in-force" {
				return "tag-in-force", nil
			}
			return "", errors.New("not found")
		},
		revisions: func(space, unit, where string) ([]HubRevision, error) {
			var revs []HubRevision
			if space == "mer-policies" {
				if where != "Tags ? 'tag-in-force'" {
					b.t.Errorf("a tagged revision is asked for by its tag: %q", where)
				}
				if n := b.inForce[unit]; n > 0 {
					revs = append(revs, HubRevision{Num: n, Tags: map[string]bool{"tag-in-force": true}})
				}
				return revs, nil
			}
			for _, n := range b.failing[space] {
				revs = append(revs, HubRevision{Num: n, Failing: true})
			}
			return append(revs, HubRevision{Num: 5}), nil
		},
		data: func(space, unit string, revision int) ([]byte, error) {
			key := fmt.Sprintf("%s/%s@%d", space, unit, revision)
			data, ok := b.units[key]
			if !ok {
				b.t.Errorf("no data for %s", key)
			}
			return []byte(data), nil
		},
	}
}

func (b *impactBench) exec(stdin []byte, name string, args ...string) ([]byte, []byte, error) {
	if name == "cub" {
		b.t.Errorf("impact asks ConfigHub through the Hub, not cub: %s", strings.Join(args, " "))
		return nil, nil, errors.New("unexpected")
	}
	args = args[2:] // --kubeconfig <file>
	all := name + " " + strings.Join(args, " ")
	switch {
	case strings.HasPrefix(all, "kubectl get deployments,statefulsets,daemonsets -A"):
		return []byte(b.runs), nil, nil
	case all == "kubectl get validatingadmissionpolicies,validatingadmissionpolicybindings -o json":
		items := []map[string]any{}
		for _, n := range b.leftover {
			items = append(items, map[string]any{"kind": "ValidatingAdmissionPolicy", "metadata": map[string]any{"name": n}})
		}
		data, _ := json.Marshal(map[string]any{"items": items})
		return data, nil, nil
	case strings.HasPrefix(all, "kubectl delete validatingadmissionpolicy/"):
		b.deleted = append(b.deleted, args[1])
		b.leftover = nil
		return nil, nil, nil
	case all == "kubectl get --raw /apis/apps/v1":
		return []byte(`{"resources":[{"name":"deployments","kind":"Deployment","namespaced":true},{"name":"deployments/scale","kind":"Scale","namespaced":true}]}`), nil, nil
	case strings.HasPrefix(all, "kubectl get --raw "):
		return nil, nil, errors.New("not served")
	case all == "kubectl get validatingadmissionpolicies -o json":
		return []byte(`{"items":[{"metadata":{"generation":1},"status":{"observedGeneration":1}}]}`), nil, nil
	case all == "kubectl apply -f -":
		var doc map[string]any
		_ = json.Unmarshal(stdin, &doc)
		if str(doc["kind"]) == "Namespace" {
			meta := obj(doc["metadata"])
			b.stageOf[str(meta["name"])] = str(obj(meta["labels"])["impact.confighub.com/stage"])
			return nil, nil, nil
		}
		b.applies++
		b.exempt = false
		for _, item := range list(doc["items"]) {
			item := obj(item)
			meta := obj(item["metadata"])
			if str(item["kind"]) == "ConfigMap" && strings.HasPrefix(str(meta["name"]), "replica-limits-") {
				var n int
				fmt.Sscan(str(obj(item["data"])["max"]), &n)
				b.ceilings[strings.TrimPrefix(str(meta["name"]), "replica-limits-")] = n
			}
			if str(meta["name"]) == "disallow-latest-tag" && obj(obj(item["spec"])["matchConstraints"])["objectSelector"] != nil {
				b.exempt = true
			}
		}
		return nil, nil, nil
	case all == "kubectl create --dry-run=server -f -":
		var o map[string]any
		_ = json.Unmarshal(stdin, &o)
		meta := obj(o["metadata"])
		stage := b.stageOf[str(meta["namespace"])]
		replicas := int(obj(o["spec"])["replicas"].(float64))
		if max, bound := b.ceilings[stage]; bound && replicas > max {
			return nil, []byte(fmt.Sprintf("The deployments %q is invalid: : ValidatingAdmissionPolicy 'replica-limits' with binding 'replica-limits-%s' denied request: replicas %d is above the ceiling of %d for this class", meta["name"], stage, replicas, max)), errors.New("exit 1")
		}
		image := str(obj(list(obj(obj(obj(o["spec"])["template"])["spec"])["containers"])[0])["image"])
		if strings.HasSuffix(image, ":latest") && !b.exempt {
			return nil, []byte("The deployments \"x\" is invalid: : ValidatingAdmissionPolicy 'disallow-latest-tag' with binding 'disallow-latest-tag' denied request: Using a mutable image tag such as 'latest' is not allowed."), errors.New("exit 1")
		}
		return []byte("created (server dry run)"), nil, nil
	}
	b.t.Errorf("unexpected: %s", all)
	return nil, nil, errors.New("unexpected")
}

func newImpactBench(t *testing.T) *impactBench {
	read := func(name string) string {
		data, err := os.ReadFile(policy(name))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	limits := read("replica-limits.yaml")
	testAtSix := strings.Replace(limits, "name: replica-limits-test\n  namespace: policy-params\ndata:\n  max: \"4\"", "name: replica-limits-test\n  namespace: policy-params\ndata:\n  max: \"6\"", 1)
	if testAtSix == limits {
		t.Fatal("could not raise test's ceiling in the example")
	}
	return &impactBench{t: t, stageOf: map[string]string{}, ceilings: map[string]int{}, runs: "kube-system/coredns\nlocal-path-storage/local-path-provisioner\nkube-system/kindnet\n",
		policyHeads: map[string]int{"replica-limits": 3, "disallow-latest-tag": 2, "platform-team-only": 1, "policy-tests": 2},
		inForce:     map[string]int{"replica-limits": 2, "disallow-latest-tag": 2, "policy-tests": 2},
		upstream:    map[string]string{"mer-kyverno-eu-central-test1": "mer-kyverno-class-test", "mer-kyverno-eu-central-prod1": "mer-kyverno-class-prod"},
		units: map[string]string{
			// what runs: test at 4 replicas, prod at 3
			"mer-kyverno-eu-central-test1/kyverno@7": deployment("kyverno-admission-controller", 4, "k:v1"),
			"mer-kyverno-eu-central-prod1/kyverno@7": deployment("kyverno-admission-controller", 3, "k:v1"),
			// what the next promotion brings: the root's 6 reaches test, which
			// does not protect replicas; prod protects its 3
			"mer-kyverno-class-test/kyverno@12": deployment("kyverno-admission-controller", 6, "k:v1"),
			"mer-kyverno-class-prod/kyverno@12": deployment("kyverno-admission-controller", 3, "k:v1"),
			// a revision recorded as failing: an image on :latest
			"mer-kyverno-base/kyverno@6": deployment("kyverno-cleanup-controller", 1, "k:latest"),
			// the policies in ConfigHub: in force, test's ceiling raised to 6
			// as a proposal, a policy not yet in force, and the known cases
			"mer-policies/replica-limits@2":      limits,
			"mer-policies/replica-limits@3":      testAtSix,
			"mer-policies/disallow-latest-tag@2": read("disallow-latest-tag.yaml"),
			"mer-policies/platform-team-only@1":  read("candidates/platform-team-only.yaml"),
			"mer-policies/policy-tests@2":        read("tests.yaml"),
		}}
}

func policy(name string) string { return filepath.Join(policyDir, name) }

func rowFor(t *testing.T, r *ImpactReport, target string) ImpactRow {
	t.Helper()
	for _, row := range r.Rows {
		if row.Target == target {
			return row
		}
	}
	t.Fatalf("no row for %s in %+v", target, r.Rows)
	return ImpactRow{}
}

func TestImpactApplicationToPolicies(t *testing.T) {
	b := newImpactBench(t)
	r, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Next: true, Settle: 1,
		Policies: []string{policy("replica-limits.yaml"), policy("disallow-latest-tag.yaml")}})
	if err != nil {
		t.Fatal(err)
	}
	test, prod := rowFor(t, r, "eu-central-test1"), rowFor(t, r, "eu-central-prod1")
	if test.Verdict != NewlyDenied || !strings.Contains(test.Why, "replicas 6 is above the ceiling of 4") || test.Candidate != "mer-kyverno-class-test/kyverno@12" {
		t.Errorf("the root's 6 replicas reach test, whose ceiling is 4: %+v", test)
	}
	if prod.Verdict != Unchanged || prod.Current != "allowed" {
		t.Errorf("prod protects its 3 replicas, so nothing changes there: %+v", prod)
	}
}

func TestImpactPolicyToEstate(t *testing.T) {
	b := newImpactBench(t)
	r, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Settle: 1,
		Policies:   []string{policy("replica-limits.yaml"), policy("disallow-latest-tag.yaml")},
		Candidates: []string{policy("candidates/replica-limits-prod-2.yaml")}})
	if err != nil {
		t.Fatal(err)
	}
	if b.applies != 2 {
		t.Errorf("the sandbox holds the policies in force, then the candidate: %d applies", b.applies)
	}
	prod, test := rowFor(t, r, "eu-central-prod1"), rowFor(t, r, "eu-central-test1")
	if prod.Verdict != NewlyDenied || !strings.Contains(prod.Why, "above the ceiling of 2") || prod.Config != "kyverno@7" {
		t.Errorf("prod runs 3 replicas, above the candidate ceiling of 2, at the revision it runs: %+v", prod)
	}
	if test.Verdict != Unchanged {
		t.Errorf("test's ceiling is not changed: %+v", test)
	}
}

func TestImpactCorpusShowsWhatAWeakerPolicyAllows(t *testing.T) {
	b := newImpactBench(t)
	b.failing = map[string][]int{"mer-kyverno-base": {6}}
	r, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Corpus: []string{"mer-kyverno-base"}, Settle: 1,
		Policies:   []string{policy("disallow-latest-tag.yaml")},
		Candidates: []string{policy("candidates/disallow-latest-tag-exempt-kyverno.yaml")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Rows) != 1 {
		t.Fatalf("only the revision recorded as failing is evaluated: %+v", r.Rows)
	}
	row := r.Rows[0]
	if row.Target != "mer-kyverno-base/kyverno@6" || row.Verdict != NewlyAllowed || !strings.Contains(row.Why, "mutable image tag") {
		t.Errorf("exempting Kyverno's controllers newly allows the :latest revision it once refused: %+v", row)
	}
}

func TestImpactUnknownWhenThePolicyReadsTheRequest(t *testing.T) {
	b := newImpactBench(t)
	dir := t.TempDir()
	who := filepath.Join(dir, "who.yaml")
	os.WriteFile(who, []byte(`apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata: {name: only-platform-team}
spec:
  matchConstraints:
    resourceRules: [{apiGroups: [apps], apiVersions: [v1], operations: [CREATE], resources: [deployments]}]
  validations:
    - expression: "request.userInfo.groups.exists(g, g == 'platform')"
`), 0o644)
	r, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Settle: 1,
		Policies: []string{policy("replica-limits.yaml")}, Candidates: []string{who}})
	if err != nil {
		t.Fatal(err)
	}
	row := rowFor(t, r, "eu-central-prod1")
	if row.Verdict != Unknown || !strings.Contains(row.Why, "reads request.userInfo") || row.Current != "allowed" || row.Proposed != "unknown" {
		t.Errorf("a candidate that reads the requesting user cannot be judged from configuration, while the policies in force can: %+v", row)
	}
	if _, err := Impact(b.exec, b.hub(), ImpactOptions{Component: "mer-kyverno", Policies: []string{policy("replica-limits.yaml")}}); err == nil {
		t.Errorf("with neither a candidate nor --next there is nothing to compare")
	}
}

// Policies are applied over what the sandbox holds; one neither set has is
// removed, and the report says so, because a deleted policy can leave the
// parameters the others read stale until the API server restarts.
func TestImpactRemovesOnlyWhatNoSetHas(t *testing.T) {
	b := newImpactBench(t)
	b.leftover = []string{"an-old-policy"}
	r, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Settle: 1,
		Policies: []string{policy("replica-limits.yaml")}, Candidates: []string{policy("candidates/replica-limits-prod-2.yaml")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(b.deleted) != 1 || b.deleted[0] != "validatingadmissionpolicy/an-old-policy" || len(r.Removed) != 1 {
		t.Errorf("only the leftover is deleted, and reported: deleted %v, reported %v", b.deleted, r.Removed)
	}
}

// Policies held in ConfigHub are read at the revision a tag marks, and each
// verdict names the policy revision behind it. A unit the tag does not mark is
// not in force, and a unit of test cases is not a policy.
func TestImpactReadsPoliciesFromConfigHub(t *testing.T) {
	b := newImpactBench(t)
	r, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Next: true, Settle: 1,
		Policies: []string{"mer-policies@Tag:in-force"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.Policies, ",") != "mer-policies/disallow-latest-tag@2,mer-policies/replica-limits@2" {
		t.Errorf("the policies in force are the tagged revisions, without the untagged unit or the tests: %v", r.Policies)
	}
	test := rowFor(t, r, "eu-central-test1")
	if test.Verdict != NewlyDenied || test.Policy != "mer-policies/replica-limits@2" {
		t.Errorf("the root's 6 replicas are refused by the revision of replica-limits in force: %+v", test)
	}

	// The proposal at the head of replica-limits raises test's ceiling to 6.
	r, err = Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Next: true, Settle: 1,
		Policies: []string{"mer-policies@Tag:in-force"}, Candidates: []string{"mer-policies/replica-limits"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.Candidates, ",") != "mer-policies/replica-limits@3" {
		t.Errorf("a unit without a revision is read at its head: %v", r.Candidates)
	}
	if test := rowFor(t, r, "eu-central-test1"); test.Verdict != Unchanged || test.Proposed != "allowed" {
		t.Errorf("under the proposal, test takes the root's 6 replicas: %+v", test)
	}

	for _, bad := range []string{"mer-policies/nothing-here", "mer-policies/replica-limits@0", "mer-policies/platform-team-only@Tag:in-force", "mer-policies@Tag:no-such-tag"} {
		if _, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Next: true, Settle: 1, Policies: []string{bad}}); err == nil {
			t.Errorf("%s names no policy, and is an error", bad)
		}
	}
}

// Known cases are evaluated in the stage each names. A case the policies in
// force get wrong is reported, and so is a known-bad case the candidate admits.
func TestImpactTests(t *testing.T) {
	b := newImpactBench(t)
	r, err := Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Settle: 1,
		Policies: []string{"mer-policies@Tag:in-force"}, Candidates: []string{"mer-policies/replica-limits@3"},
		Tests: []string{"mer-policies/policy-tests@Tag:in-force"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Rows) != 6 || strings.Join(r.Tests, ",") != "mer-policies/policy-tests@2" {
		t.Fatalf("six cases, from the tagged revision of the tests: %v %+v", r.Tests, r.Rows)
	}
	if len(r.FailingNow) != 0 {
		t.Errorf("the policies in force treat every case as it expects: %v", r.FailingNow)
	}
	if len(r.FailingThen) != 1 || !strings.HasPrefix(r.FailingThen[0], "tests/test-five-replicas: expects denied, and the candidate gives allowed") {
		t.Errorf("raising test's ceiling to 6 admits the five-replica case, and nothing else: %v", r.FailingThen)
	}
	five := rowFor(t, r, "tests/test-five-replicas")
	if five.Stage != "test" || five.Verdict != NewlyAllowed || five.Expected != "denied" || five.Policy != "mer-policies/replica-limits@2" {
		t.Errorf("the case is met in test, and was refused by the revision in force: %+v", five)
	}
	if seven := rowFor(t, r, "tests/test-seven-replicas"); seven.Proposed != "denied" {
		t.Errorf("seven replicas are still above the raised ceiling: %+v", seven)
	}

	dir := t.TempDir()
	wrong := filepath.Join(dir, "wrong.yaml")
	os.WriteFile(wrong, []byte(strings.Replace(deployment("uat-five", 5, "k:v1"), "metadata:\n", "metadata:\n  annotations: {impact.confighub.com/stage: uat, impact.confighub.com/expect: allowed}\n", 1)), 0o644)
	r, err = Impact(b.exec, b.hub(), ImpactOptions{SandboxKubeconfig: "sandbox", Settle: 1, Policies: []string{"mer-policies@Tag:in-force"}, Tests: []string{wrong}})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.FailingNow) != 1 || !strings.Contains(r.FailingNow[0], "tests/uat-five: expects allowed, and the policies in force give denied") {
		t.Errorf("a case the policies in force get wrong is reported: %v", r.FailingNow)
	}
}

// The sandbox's admission policies are replaced, so impact never takes the
// current context as one, and refuses a cluster that runs anything but
// Kubernetes itself: on a management cluster, the policies would refuse
// Sveltos its own writes.
func TestImpactRefusesWhatIsNotASandbox(t *testing.T) {
	b := newImpactBench(t)
	opts := ImpactOptions{Component: "mer-kyverno", Settle: 1,
		Policies:   []string{policy("replica-limits.yaml")},
		Candidates: []string{policy("candidates/replica-limits-prod-2.yaml")}}
	if _, err := Impact(b.exec, b.hub(), opts); err == nil || !strings.Contains(err.Error(), "name the sandbox") || b.applies != 0 {
		t.Errorf("no sandbox named: refused before anything is applied: %v, %d applies", err, b.applies)
	}
	b.runs = "kube-system/coredns\nprojectsveltos/addon-controller\nprojectsveltos/sc-manager\n"
	opts.SandboxKubeconfig = "sandbox"
	if _, err := Impact(b.exec, b.hub(), opts); err == nil || !strings.Contains(err.Error(), "runs projectsveltos/addon-controller, projectsveltos/sc-manager, so it is not a sandbox") || b.applies != 0 {
		t.Errorf("a management cluster named as the sandbox: refused before anything is applied: %v, %d applies", err, b.applies)
	}
}
