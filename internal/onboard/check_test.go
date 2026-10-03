package onboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// check runs the function on exactly the revisions the attestation covers,
// in each variant of the stage the order has reached, and records a Pass or
// a rejection.
func TestCheck(t *testing.T) {
	result := func(passed bool, details ...string) string {
		data, _ := json.Marshal([]map[string]any{{"Passed": passed, "Details": details, "FunctionName": "vet-kyverno-server"}})
		out, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(data)})
		return string(out)
	}
	var recorded []HubAttestation
	hub := &fakeHub{t: t,
		order: func(space, order string) (HubChangeOrder, error) {
			if space != "sveltos-kyverno-base" || order != "owner-label" {
				t.Errorf("the order is read from its base Space: %s/%s", space, order)
			}
			return HubChangeOrder{ID: "order-id", InScope: []string{"id-eu", "id-us", "id-staging"},
				Stages: []stageGate{{Name: "staging", WhereSpace: "Labels.Stage = 'staging'"}, {Name: "prod", WhereSpace: "Labels.Stage = 'prod'"}}}, nil
		},
		spaces: func(where string) ([]HubSpace, error) {
			if where != "Labels.Stage = 'prod'" {
				t.Errorf("the stage's Spaces are the ones its workflow selects: %s", where)
			}
			return []HubSpace{{ID: "id-eu", Slug: "sveltos-kyverno-prod-eu"}, {ID: "id-us", Slug: "sveltos-kyverno-prod-us"}, {ID: "id-other", Slug: "someone-elses-prod"}}, nil
		},
		attest: func(a HubAttestation, dryRun bool) (HubAttested, error) {
			if a.Type != "PolicyCheck" || a.ChangeOrderID != "order-id" {
				t.Errorf("a PolicyCheck against the order: %+v", a)
			}
			if dryRun {
				return HubAttested{Subjects: []subject{{UnitSlug: "kyverno", RevisionNum: 7}}}, nil
			}
			recorded = append(recorded, a)
			return HubAttested{ID: "761ec119-55a8-4deb-a843-00db1ef0a068"}, nil
		}}
	run := func(name string, args ...string) ([]byte, error) {
		all := name + " " + strings.Join(args, " ")
		switch {
		case all == "cub function vet vet-kyverno-server --space sveltos-kyverno-prod-eu --revision kyverno/7 --worker policies/kyverno-checker -o jq=[.[] | .Outputs.ValidationResult]":
			return []byte(result(true)), nil
		case all == "cub function vet vet-kyverno-server --space sveltos-kyverno-prod-us --revision kyverno/7 --worker policies/kyverno-checker -o jq=[.[] | .Outputs.ValidationResult]":
			return []byte(result(false, `policy "disallow-latest-tag" rule "autogen-validate-image-tag": validation error`)), nil
		}
		t.Errorf("unexpected: %s", all)
		return nil, errors.New("unexpected")
	}
	results, err := Check(run, hub, CheckOptions{ChangeOrder: "sveltos-kyverno-base/owner-label", Stage: "prod", Worker: "policies/kyverno-checker", Function: []string{"vet-kyverno-server"}})
	if err != nil || len(results) != 2 {
		t.Fatalf("the two prod variants the order reached are checked, and no other Space: %+v %v", results, err)
	}
	eu, us := results[0], results[1]
	if !eu.Passed || eu.Revisions[0] != "kyverno/7" || eu.Recorded != "761ec119-55a8-4deb-a843-00db1ef0a068" {
		t.Errorf("prod-eu passed, on the revision the attestation covers: %+v", eu)
	}
	if us.Passed || len(us.Details) != 1 || !strings.Contains(us.Details[0], "kyverno/7: policy \"disallow-latest-tag\"") {
		t.Errorf("prod-us failed, naming the rule: %+v", us)
	}
	if len(recorded) != 2 || recorded[0].Space != "sveltos-kyverno-prod-eu" || recorded[0].Reject || recorded[1].Space != "sveltos-kyverno-prod-us" || !recorded[1].Reject ||
		recorded[0].Claims["check.confighub.com/function"] != "vet-kyverno-server" || !strings.Contains(recorded[0].Note, "vet-kyverno-server passed on kyverno/7") {
		t.Errorf("a Pass for prod-eu, a rejection for prod-us, both naming the function: %+v", recorded)
	}
	if _, err := Check(run, hub, CheckOptions{ChangeOrder: "sveltos-kyverno-base/owner-label", Stage: "canary", Function: []string{"vet-kyverno-server"}}); err == nil {
		t.Errorf("a stage the order does not have is an error")
	}
}

// With a sandbox in place of a function, each revision is judged by the
// policies named, and the attestation says which revisions of them.
func TestCheckWithTheSandbox(t *testing.T) {
	b := newImpactBench(t)
	b.units["mer-kyverno-eu-central-test1/kyverno@9"] = deployment("kyverno-admission-controller", 6, "k:v1")
	var recorded []HubAttestation
	hub := b.hub()
	hub.order = func(space, order string) (HubChangeOrder, error) {
		return HubChangeOrder{ID: "order-id", InScope: []string{"id-test1"}, Stages: []stageGate{{Name: "test", WhereSpace: "Labels.Stage = 'test'"}}}, nil
	}
	hub.spaces = func(where string) ([]HubSpace, error) {
		return []HubSpace{{ID: "id-test1", Slug: "mer-kyverno-eu-central-test1", Labels: map[string]string{"Stage": "test"}}}, nil
	}
	hub.attest = func(a HubAttestation, dryRun bool) (HubAttested, error) {
		if dryRun {
			return HubAttested{Subjects: []subject{{UnitSlug: "kyverno", RevisionNum: 9}}}, nil
		}
		recorded = append(recorded, a)
		return HubAttested{ID: "761ec119-55a8-4deb-a843-00db1ef0a068"}, nil
	}
	// A sandbox check runs no function, so it never runs cub.
	run := func(name string, args ...string) ([]byte, error) {
		t.Errorf("unexpected: %s %s", name, strings.Join(args, " "))
		return nil, errors.New("unexpected")
	}
	opts := func(policies ...string) CheckOptions {
		return CheckOptions{ChangeOrder: "mer-kyverno-base/six-replicas", Stage: "test",
			Sandbox: &SandboxCheck{Exec: b.exec, Kubeconfig: "sandbox", Policies: policies, Settle: 1}}
	}
	results, err := Check(run, hub, opts("mer-policies@Tag:in-force"))
	if err != nil || len(results) != 1 {
		t.Fatalf("%+v %v", results, err)
	}
	if r := results[0]; r.Passed || len(r.Details) != 1 || !strings.Contains(r.Details[0], "kyverno/9: Deployment kyverno-admission-controller denied by mer-policies/replica-limits@2") {
		t.Errorf("six replicas in test are refused by the ceiling in force, named with its revision: %+v", r)
	}
	if len(recorded) != 1 || !recorded[0].Reject || recorded[0].Claims["check.confighub.com/policies"] != "mer-policies/disallow-latest-tag@2,mer-policies/replica-limits@2" {
		t.Errorf("a rejection, naming the policy revisions it was judged by: %v", recorded)
	}

	recorded = nil
	results, err = Check(run, hub, opts("mer-policies/disallow-latest-tag@Tag:in-force", "mer-policies/replica-limits@3"))
	if err != nil || !results[0].Passed || len(recorded) != 1 || recorded[0].Reject ||
		!strings.Contains(recorded[0].Note, "the policies mer-policies/disallow-latest-tag@2, mer-policies/replica-limits@3 passed on kyverno/9") {
		t.Errorf("under test's raised ceiling the change passes, and the Pass says by which policies: %+v %v %v", results, recorded, err)
	}
	if _, err := Check(run, hub, CheckOptions{ChangeOrder: "mer-kyverno-base/six-replicas", Stage: "test"}); err == nil {
		t.Errorf("a check with neither a function nor a sandbox is an error")
	}
}

// A parity check compares each prod variant with what staging runs under the
// same order: a difference a guard declares passes, with its reason; any other
// fails, naming the field and both values.
func TestCheckParity(t *testing.T) {
	shop := func(replicas int, limit string) string {
		resources := ""
		if limit != "" {
			resources = "\n        resources:\n          limits:\n            memory: " + limit
		}
		return fmt.Sprintf(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
spec:
  replicas: %d
  template:
    spec:
      containers:
      - name: api
        image: python:3.12-alpine%s
`, replicas, resources)
	}
	data := map[string]string{
		"shop-staging/shop@7":  shop(2, ""),
		"shop-staging/shop@6":  shop(2, ""),
		"shop-prod-eu/shop@9":  shop(3, ""),
		"shop-prod-us/shop@9":  shop(3, "48Mi"),
		"shop-staging/cache@2": "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: cache, namespace: shop}\n",
	}
	replicasDeclared := map[string]map[string]map[string]string{"apps/v1/Deployment:shop/api": {"spec.replicas": {"departure": "prod-capacity"}}}
	stagingMarks := []subject{{UnitSlug: "shop", RevisionNum: 7}}
	stagingCache := false
	var recorded []HubAttestation
	hub := &fakeHub{t: t,
		order: func(space, order string) (HubChangeOrder, error) {
			return HubChangeOrder{ID: "order-id", InScope: []string{"id-staging", "id-eu", "id-us"},
				Stages: []stageGate{{Name: "staging", WhereSpace: "Labels.Stage = 'staging'"}, {Name: "prod", WhereSpace: "Labels.Stage = 'prod'"}}}, nil
		},
		spaces: func(where string) ([]HubSpace, error) {
			if where == "Labels.Stage = 'staging'" {
				return []HubSpace{{ID: "id-staging", Slug: "shop-staging"}}, nil
			}
			return []HubSpace{{ID: "id-eu", Slug: "shop-prod-eu"}, {ID: "id-us", Slug: "shop-prod-us"}}, nil
		},
		units: func(space string) ([]HubUnit, error) {
			units := []HubUnit{{Slug: "shop", SpaceSlug: space, Released: 6}}
			if space == "shop-staging" && stagingCache {
				units = append(units, HubUnit{Slug: "cache", SpaceSlug: space, Released: 2})
			}
			return units, nil
		},
		unit: func(space, unit string) (HubUnit, error) {
			return HubUnit{Slug: unit, SpaceSlug: space, Guards: replicasDeclared}, nil
		},
		data: func(space, unit string, revision int) ([]byte, error) {
			d, ok := data[fmt.Sprintf("%s/%s@%d", space, unit, revision)]
			if !ok {
				t.Errorf("unexpected revision %s/%s@%d", space, unit, revision)
			}
			return []byte(d), nil
		},
		attest: func(a HubAttestation, dryRun bool) (HubAttested, error) {
			if a.Type != "ParityCheck" {
				t.Errorf("a ParityCheck: %+v", a)
			}
			if dryRun {
				if a.Space == "shop-staging" {
					return HubAttested{Subjects: stagingMarks}, nil
				}
				return HubAttested{Subjects: []subject{{UnitSlug: "shop", RevisionNum: 9}}}, nil
			}
			recorded = append(recorded, a)
			return HubAttested{ID: "att-" + a.Space}, nil
		}}
	run := func(name string, args ...string) ([]byte, error) {
		t.Errorf("a parity check runs nothing: %s %s", name, strings.Join(args, " "))
		return nil, errors.New("unexpected")
	}
	opts := CheckOptions{ChangeOrder: "shop-base/bigger-cache", Stage: "prod", Parity: &ParityCheck{With: "staging"}}
	results, err := Check(run, hub, opts)
	if err != nil || len(results) != 2 {
		t.Fatalf("%+v %v", results, err)
	}
	eu, us := results[0], results[1]
	if !eu.Passed || len(eu.Declared) != 1 || eu.Declared[0] != "shop/9: Deployment shop/api spec.replicas is 3 here and 2 in shop-staging (departure=prod-capacity)" {
		t.Errorf("prod-eu departs only where a guard declares it, and the reason is kept: %+v", eu)
	}
	if us.Passed || len(us.Details) != 1 || us.Details[0] != `shop/9: Deployment shop/api spec.template.spec.containers[api].resources.limits.memory is "48Mi" here and unset in shop-staging, and no guard departure=<why> declares it` {
		t.Errorf("prod-us departs where nothing declares it, named with both values: %+v", us)
	}
	if len(recorded) != 2 || recorded[0].Reject || !recorded[1].Reject ||
		recorded[0].Claims["check.confighub.com/parity-with"] != "staging" ||
		!strings.Contains(recorded[0].Note, "parity with shop-staging/shop@7 passed on shop/9; declared departures (1): shop/9: Deployment shop/api spec.replicas") ||
		!strings.Contains(recorded[1].Note, "parity with shop-staging/shop@7 failed: shop/9: Deployment shop/api spec.template.spec.containers[api].resources.limits.memory") {
		t.Errorf("a Pass listing the declared departure, a rejection naming the field: %+v", recorded)
	}

	// Where the order marks nothing in staging, staging's last release is what
	// prod must match.
	stagingMarks, recorded = nil, nil
	if results, err := Check(run, hub, opts); err != nil || !results[0].Passed ||
		!strings.Contains(recorded[0].Note, "parity with shop-staging/shop@6") {
		t.Errorf("compared with staging's release: %+v %+v %v", results, recorded, err)
	}

	// A guard on the field itself declares it.
	replicasDeclared["apps/v1/Deployment:shop/api"]["spec.template.spec.containers.?name=api.resources.limits.memory"] = map[string]string{"departure": "prod-memory-cap"}
	if results, err := Check(run, hub, opts); err != nil || !results[1].Passed ||
		!strings.Contains(results[1].Declared[1], "resources.limits.memory is \"48Mi\" here and unset in shop-staging (departure=prod-memory-cap)") {
		t.Errorf("declared by a guard on the field: %+v %v", results, err)
	}
	delete(replicasDeclared["apps/v1/Deployment:shop/api"], "spec.template.spec.containers.?name=api.resources.limits.memory")

	// A guard on a path that holds the field, or on the object, declares it too.
	replicasDeclared["apps/v1/Deployment:shop/api"]["spec.template.spec.containers.?name=api"] = map[string]string{"departure": "prod-memory"}
	recorded = nil
	if results, err := Check(run, hub, opts); err != nil || !results[1].Passed ||
		!strings.Contains(results[1].Declared[1], "(departure=prod-memory)") {
		t.Errorf("declared by the container's guard: %+v %v", results, err)
	}
	// A unit staging runs and prod does not is a departure no guard in prod
	// can declare.
	stagingCache = true
	if results, err := Check(run, hub, opts); err != nil || results[0].Passed ||
		results[0].Details[0] != "shop-staging runs unit cache (revision 2), and this variant does not" {
		t.Errorf("prod lacks a unit staging runs: %+v %v", results, err)
	}
	stagingCache = false
	if r, err := Check(run, hub, CheckOptions{ChangeOrder: "shop-base/bigger-cache", Stage: "prod", Parity: &ParityCheck{With: "canary"}}); err == nil || r != nil {
		t.Errorf("a stage to match that the order does not have is an error, and no variant reads as passed: %+v %v", r, err)
	}
	if _, err := Check(run, hub, CheckOptions{ChangeOrder: "shop-base/bigger-cache", Stage: "prod", Parity: &ParityCheck{With: "prod"}}); err == nil {
		t.Errorf("parity of a stage with itself is an error")
	}
}

// What a parity check reads and prints, field by field: a variable whose name
// has a dot is its own path, an object only prod has is declared by a guard on
// the object, a Secret's values are never shown, and a unit staging runs that
// prod does not is a departure.
func TestParityDepartures(t *testing.T) {
	objects := func(yaml string) []Object {
		o, err := objectsOf([]byte(yaml))
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	api := func(env string) string {
		return `apiVersion: apps/v1
kind: Deployment
metadata: {name: api, namespace: shop}
spec:
  template:
    spec:
      containers:
      - name: api
        env:
        - {name: a, value: "1"}
        - {name: a.b, value: "` + env + `"}
        ports:
        - {name: http, containerPort: 8080}
`
	}
	spots := parityDepartures(objects(api("x")), objects(api("y")), "staging")
	if len(spots) != 1 || spots[0].path != "spec.template.spec.containers.?name=api.env.?name=a~1b.value" {
		t.Fatalf("the variable a.b, escaped as ConfigHub escapes it: %+v", spots)
	}
	guards := map[string]map[string]map[string]string{"apps/v1/Deployment:shop/api": {"spec.template.spec.containers.?name=api.env.?name=a": {"departure": "wrong"}}}
	if _, ok := declaredBy(guards, spots[0], "departure"); ok {
		t.Errorf("a guard on the variable a does not declare a.b")
	}
	guards["apps/v1/Deployment:shop/api"]["spec.template.spec.containers.?name=api.env.?name=a~1b"] = map[string]string{"departure": "prod-endpoint"}
	guards["apps/v1/Deployment:shop/api"][""] = map[string]string{"departure": "whole"}
	if why, ok := declaredBy(guards, spots[0], "departure"); !ok || why != "prod-endpoint" {
		t.Errorf("the nearest guard says why: %q %v", why, ok)
	}

	ports := strings.Replace(api("x"), "containerPort: 8080", "containerPort: 9090", 1)
	if spots := parityDepartures(objects(api("x")), objects(ports), "staging"); len(spots) != 1 || spots[0].path != "spec.template.spec.containers.?name=api.ports" {
		t.Errorf("ports are keyed by port, not name, so the list departs whole: %+v", spots)
	}

	secret := func(v string) string {
		return "apiVersion: v1\nkind: Secret\nmetadata: {name: token, namespace: shop}\ndata: {token: " + v + "}\n"
	}
	spots = parityDepartures(objects(secret("c2VjcmV0MQ==")), objects(secret("c2VjcmV0Mg==")), "staging")
	if len(spots) != 1 || strings.Contains(spots[0].shown, "c2Vj") || !strings.Contains(spots[0].shown, "not shown") {
		t.Errorf("a Secret's values are never shown: %+v", spots)
	}

	extra := parityDepartures(nil, objects(secret("eA==")), "stage staging")
	if len(extra) != 1 || extra[0].path != "" || extra[0].shown != "Secret shop/token is here and not in stage staging" {
		t.Errorf("an object only prod has departs as a whole: %+v", extra)
	}
	if why, ok := declaredBy(map[string]map[string]map[string]string{"v1/Secret:shop/token": {"": {"departure": "prod-only"}}}, extra[0], "departure"); !ok || why != "prod-only" {
		t.Errorf("a guard on the object declares it")
	}
}
