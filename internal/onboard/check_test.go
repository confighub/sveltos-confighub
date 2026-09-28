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
	var recorded []string
	run := func(name string, args ...string) ([]byte, error) {
		all := name + " " + strings.Join(args, " ")
		switch {
		case all == "cub changeorder get --space sveltos-kyverno-base owner-label -o json":
			return []byte(`{"ChangeOrder":{"InScopeSpaceIDs":["id-eu","id-us","id-staging"],"ChangeWorkflow":{"Stages":[
			  {"Name":"staging","WhereSpace":"Labels.Stage = 'staging'"},{"Name":"prod","WhereSpace":"Labels.Stage = 'prod'"}]}}}`), nil
		case all == "cub space list --where Labels.Stage = 'prod' -o jq=[.[].Space | {SpaceID, Slug}]":
			return []byte(`[{"SpaceID":"id-eu","Slug":"sveltos-kyverno-prod-eu"},{"SpaceID":"id-us","Slug":"sveltos-kyverno-prod-us"},{"SpaceID":"id-other","Slug":"someone-elses-prod"}]`), nil
		case strings.HasPrefix(all, "cub attestation create") && strings.Contains(all, "--dry-run"):
			return []byte(`{"Subjects":[{"UnitSlug":"kyverno","RevisionNum":7}]}`), nil
		case all == "cub function vet vet-kyverno-server --space sveltos-kyverno-prod-eu --revision kyverno/7 --worker policies/kyverno-checker -o jq=[.[] | .Outputs.ValidationResult]":
			return []byte(result(true)), nil
		case all == "cub function vet vet-kyverno-server --space sveltos-kyverno-prod-us --revision kyverno/7 --worker policies/kyverno-checker -o jq=[.[] | .Outputs.ValidationResult]":
			return []byte(result(false, `policy "disallow-latest-tag" rule "autogen-validate-image-tag": validation error`)), nil
		case strings.HasPrefix(all, "cub attestation create --space "):
			recorded = append(recorded, all)
			return []byte("Recorded pass PolicyCheck attestation 761ec119-55a8-4deb-a843-00db1ef0a068 in x, covering 1 revision(s)"), nil
		}
		t.Errorf("unexpected: %s", all)
		return nil, errors.New("unexpected")
	}
	results, err := Check(run, CheckOptions{ChangeOrder: "sveltos-kyverno-base/owner-label", Stage: "prod", Worker: "policies/kyverno-checker", Function: []string{"vet-kyverno-server"}})
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
	if len(recorded) != 2 || strings.Contains(recorded[0], "--reject") || !strings.Contains(recorded[1], "--reject") ||
		!strings.Contains(recorded[0], "--type PolicyCheck --change-order sveltos-kyverno-base/owner-label") {
		t.Errorf("a Pass for prod-eu, a rejection for prod-us, both of PolicyCheck against the order: %v", recorded)
	}
	if _, err := Check(run, CheckOptions{ChangeOrder: "sveltos-kyverno-base/owner-label", Stage: "canary", Function: []string{"vet-kyverno-server"}}); err == nil {
		t.Errorf("a stage the order does not have is an error")
	}
}
