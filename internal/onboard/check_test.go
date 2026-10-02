package onboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
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
