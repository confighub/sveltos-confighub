package onboard

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

var gated = Gates{Policy: "platform-policies/kyverno", Require: []string{"PolicyCheck"}}

// With a policy, a failing check holds a change: each stage after another,
// and the first stage after the class bases, waits until the stage ahead
// holds no ValidationErrors. A required attestation gates every release.
func TestGatesInTheWorkflow(t *testing.T) {
	var w struct {
		AttestationPrerequisites []requirement
		Stages                   []stageGate
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(workflowText([]string{"test", "uat", "prod"}, true, gated)), &doc); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(doc)
	if err := json.Unmarshal(data, &w); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, s := range w.Stages {
		got[s.Name] = strings.Join(s.Prerequisites, ",") + " | " + strings.Join(s.ReleasePrerequisites, ",")
	}
	want := map[string]string{
		"bases": " | ",
		"test":  "Validated | approval,policycheck",
		"uat":   "Released,Validated | approval,policycheck",
		"prod":  "Released,Validated | approval,policycheck",
	}
	for name, g := range want {
		if got[name] != g {
			t.Errorf("stage %s waits for %q, want %q", name, got[name], g)
		}
	}
	if len(w.AttestationPrerequisites) != 2 || w.AttestationPrerequisites[1] != (requirement{Name: "policycheck", Type: "PolicyCheck", Count: 1, AllowAuthors: true}) {
		t.Errorf("the required type is an attestation requirement: %+v", w.AttestationPrerequisites)
	}
	var patch struct{ Stages []stageGate }
	_ = json.Unmarshal([]byte(stagesJSON([]string{"test", "uat", "prod"}, true, gated)), &patch)
	if len(patch.Stages) != len(w.Stages) || strings.Join(patch.Stages[1].Prerequisites, ",") != "Validated" {
		t.Errorf("the stages patch carries the same gates as the workflow file: %+v", patch.Stages)
	}

	plain := workflowText([]string{"staging", "prod"}, false, Gates{Policy: "p/f"})
	if strings.Count(plain, "- Validated") != 1 {
		t.Errorf("without class bases, the first stage has no stage ahead to be validated:\n%s", plain)
	}
	for _, g := range []Gates{{Policy: "no-slash"}, {Policy: "a/b/c"}, {Require: []string{"Approval"}}, {Require: []string{"X", "x"}}} {
		if len(g.problems()) == 0 {
			t.Errorf("%+v is refused", g)
		}
	}
}

// apply.sh gives every base, class base and variant the policy, and adds the
// gates to a workflow that lacks them, keeping what was made there since.
func TestGatesInApplyScript(t *testing.T) {
	opts := watchOpts
	opts.Gates = gated
	plan := mustPlan(t, append(parse(t, profile("kyverno", watchedProfile)), parse(t, fleetClusters(""))...), opts)
	script := ApplyScript(plan)
	for _, s := range []string{"sveltos-kyverno-base", "sveltos-kyverno-staging-eu", "sveltos-kyverno-prod-eu"} {
		if !strings.Contains(script, "\npoliced "+s+" platform-policies/kyverno\n") {
			t.Errorf("%s is given the policy", s)
		}
	}
	if !strings.Contains(script, "\ngated sveltos-kyverno-base rollout ") {
		t.Errorf("the workflow's gates are checked, and added when missing")
	}
	if strings.Contains(ApplyScript(mustPlan(t, append(parse(t, profile("kyverno", watchedProfile)), parse(t, fleetClusters(""))...), watchOpts)), "policed") {
		t.Errorf("without gates, the script is as before")
	}
}

// The expressions run in cub's jq, which is gojq; jq agrees on everything
// they use.
func TestGatesMergeKeepsWhatIsThere(t *testing.T) {
	jq, err := exec.LookPath("jq")
	if err != nil {
		t.Skip("needs jq")
	}
	run := func(expr, input string) string {
		cmd := exec.Command(jq, "-c", expr)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("jq %s: %v", expr, err)
		}
		return strings.TrimSpace(string(out))
	}
	// A workflow onboarded without gates, with a Healthy gate and a review
	// requirement a person added since.
	before := `{"ChangeWorkflow":{"AttestationPrerequisites":[{"Name":"approval","Type":"Approval","Count":1,"AllowAuthors":true},{"Name":"review","Type":"SecurityReview","Count":1}],
	  "Stages":[{"Name":"staging","WhereSpace":"Labels.Stage = 'staging'","ReleasePrerequisites":["approval"]},
	            {"Name":"prod","WhereSpace":"Labels.Stage = 'prod'","Prerequisites":["Released","Healthy"],"ReleasePrerequisites":["approval","review"]}]}}`
	has, merged := gatesJQ([]string{"staging", "prod"}, false, gated)
	if run(has, before) != "false" {
		t.Fatalf("a workflow without the gates lacks them")
	}
	after := run(merged, before)
	var w struct {
		AttestationPrerequisites []requirement
		Stages                   []stageGate
	}
	_ = json.Unmarshal([]byte(after), &w)
	if len(w.AttestationPrerequisites) != 3 || w.AttestationPrerequisites[1].Name != "review" || w.AttestationPrerequisites[2].Name != "policycheck" {
		t.Errorf("the requirement is added, and the person's own kept: %+v", w.AttestationPrerequisites)
	}
	if p := w.Stages[1]; strings.Join(p.Prerequisites, ",") != "Released,Healthy,Validated" || strings.Join(p.ReleasePrerequisites, ",") != "approval,review,policycheck" {
		t.Errorf("prod keeps Healthy and review, and takes Validated and policycheck: %+v", p)
	}
	if w.Stages[0].WhereSpace != "Labels.Stage = 'staging'" || len(w.Stages[0].Prerequisites) != 0 {
		t.Errorf("a stage's own settings stay, and the first stage has nothing ahead to validate: %+v", w.Stages[0])
	}
	if run(has, `{"ChangeWorkflow":`+after+`}`) != "true" {
		t.Errorf("once merged, the workflow has every gate, so a re-run changes nothing")
	}
}
