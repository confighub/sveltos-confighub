package onboard

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
}

func (b *impactBench) exec(stdin []byte, name string, args ...string) ([]byte, []byte, error) {
	all := name + " " + strings.Join(args, " ")
	switch {
	case strings.HasPrefix(all, "cub space list --where Component.Slug = 'mer-kyverno'"):
		return []byte(`[{"Space":{"Slug":"mer-kyverno-eu-central-test1","Labels":{"Stage":"test","Cluster":"eu-central-test1"}}},
		  {"Space":{"Slug":"mer-kyverno-eu-central-prod1","Labels":{"Stage":"prod","Cluster":"eu-central-prod1"}}}]`), nil, nil
	case strings.HasPrefix(all, "cub unit list --space "):
		space := args[3]
		up := b.upstream[space]
		return []byte(fmt.Sprintf(`[{"Unit":{"Slug":"kyverno","HeadRevisionNum":9,"LastReleasedRevisionNum":7,"UpstreamUnitID":"u-%s","UpstreamSpaceID":"%s"}}]`, up, up)), nil, nil
	case strings.HasPrefix(all, "cub unit get --space "):
		space := args[3]
		return []byte(fmt.Sprintf(`{"Unit":{"Slug":"kyverno","SpaceSlug":"%s","HeadRevisionNum":12}}`, space)), nil, nil
	case strings.HasPrefix(all, "cub revision data --space "):
		key := fmt.Sprintf("%s/%s@%s", args[3], args[4], args[5])
		data, ok := b.units[key]
		if !ok {
			b.t.Errorf("no data for %s", key)
		}
		return []byte(data), nil, nil
	case strings.HasPrefix(all, "cub space get "):
		return []byte(`{"Stage":"bases"}`), nil, nil
	case strings.HasPrefix(all, "cub revision list --space "):
		var revs []map[string]any
		for _, n := range b.failing[args[3]] {
			revs = append(revs, map[string]any{"Revision": map[string]any{"RevisionNum": n, "ValidationErrors": map[string]bool{"mer-policies/kyverno/vet-kyverno-server": true}}})
		}
		revs = append(revs, map[string]any{"Revision": map[string]any{"RevisionNum": 5}})
		data, _ := json.Marshal(revs)
		return data, nil, nil
	}

	args = args[2:] // --kubeconfig <file>
	all = name + " " + strings.Join(args, " ")
	switch {
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
	return &impactBench{t: t, stageOf: map[string]string{}, ceilings: map[string]int{},
		upstream: map[string]string{"mer-kyverno-eu-central-test1": "mer-kyverno-class-test", "mer-kyverno-eu-central-prod1": "mer-kyverno-class-prod"},
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
	r, err := Impact(b.exec, ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Next: true, Settle: 1,
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
	r, err := Impact(b.exec, ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Settle: 1,
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
	r, err := Impact(b.exec, ImpactOptions{SandboxKubeconfig: "sandbox", Corpus: []string{"mer-kyverno-base"}, Settle: 1,
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
	r, err := Impact(b.exec, ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Settle: 1,
		Policies: []string{policy("replica-limits.yaml")}, Candidates: []string{who}})
	if err != nil {
		t.Fatal(err)
	}
	row := rowFor(t, r, "eu-central-prod1")
	if row.Verdict != Unknown || !strings.Contains(row.Why, "reads request.userInfo") || row.Current != "allowed" || row.Proposed != "unknown" {
		t.Errorf("a candidate that reads the requesting user cannot be judged from configuration, while the policies in force can: %+v", row)
	}
	if _, err := Impact(b.exec, ImpactOptions{Component: "mer-kyverno", Policies: []string{policy("replica-limits.yaml")}}); err == nil {
		t.Errorf("with neither a candidate nor --next there is nothing to compare")
	}
}

// Policies are applied over what the sandbox holds; one neither set has is
// removed, and the report says so, because a deleted policy can leave the
// parameters the others read stale until the API server restarts.
func TestImpactRemovesOnlyWhatNoSetHas(t *testing.T) {
	b := newImpactBench(t)
	b.leftover = []string{"an-old-policy"}
	r, err := Impact(b.exec, ImpactOptions{SandboxKubeconfig: "sandbox", Component: "mer-kyverno", Settle: 1,
		Policies: []string{policy("replica-limits.yaml")}, Candidates: []string{policy("candidates/replica-limits-prod-2.yaml")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(b.deleted) != 1 || b.deleted[0] != "validatingadmissionpolicy/an-old-policy" || len(r.Removed) != 1 {
		t.Errorf("only the leftover is deleted, and reported: deleted %v, reported %v", b.deleted, r.Removed)
	}
}
