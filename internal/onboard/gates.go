package onboard

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Gates are what each stage of a profile's rollout waits for beyond its
// approval.
type Gates struct {
	// Policy is a trigger Filter, <space>/<filter>, whose Triggers every base
	// and variant Space runs, such as a Kyverno check. A change that fails
	// one carries ValidationErrors, which ConfigHub refuses to release, and
	// each stage after the first also waits until the stage ahead holds no
	// such errors (Validated).
	Policy string
	// Require are attestation types, such as PolicyCheck, that each stage's
	// release waits for as well: a Pass recorded against the change as it
	// stands in that stage. Unlike a Trigger, a requirement never fails open.
	Require []string
	// Approvers are the ConfigHub user IDs whose approvals count. With any
	// named, an approval from anyone else, or from the change's author,
	// counts for nothing.
	Approvers []string
}

// any says whether the plan adds gates beyond an approval anyone may give.
func (g Gates) any() bool { return g.Policy != "" || len(g.Require) > 0 || len(g.Approvers) > 0 }

var userID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// requirement is one attestation a stage's release can wait for.
type requirement struct {
	Name         string `json:"Name"`
	Type         string `json:"Type"`
	Count        int    `json:"Count"`
	AllowAuthors bool   `json:"AllowAuthors"`
	// FromUserIDs are the users whose attestations count; anyone's when empty.
	FromUserIDs []string `json:"FromUserIDs,omitempty"`
}

// stageGate is one stage of the workflow and what it waits for.
type stageGate struct {
	Name                 string   `json:"Name"`
	WhereSpace           string   `json:"WhereSpace,omitempty"`
	Prerequisites        []string `json:"Prerequisites,omitempty"`
	ReleasePrerequisites []string `json:"ReleasePrerequisites,omitempty"`
}

func (g Gates) requirements() []requirement {
	out := []requirement{{Name: "approval", Type: "Approval", Count: 1, AllowAuthors: len(g.Approvers) == 0, FromUserIDs: g.Approvers}}
	for _, t := range g.Require {
		out = append(out, requirement{Name: Slug(t), Type: t, Count: 1, AllowAuthors: true})
	}
	return out
}

// stages are the workflow's stages: the class bases first when there are
// any, then each stage of clusters. A stage after another waits until the
// stage ahead has released the change and, with a policy, holds no
// ValidationErrors; the first stage after the class bases reads them.
func (g Gates) stages(stages []string, bases bool) []stageGate {
	var out []stageGate
	if bases {
		out = append(out, stageGate{Name: basesStage, WhereSpace: fmt.Sprintf("Labels.Stage = '%s'", basesStage)})
	}
	release := []string{"approval"}
	for _, t := range g.Require {
		release = append(release, Slug(t))
	}
	for i, s := range stages {
		st := stageGate{Name: s, WhereSpace: fmt.Sprintf("Labels.Stage = '%s'", s), ReleasePrerequisites: release}
		if i > 0 {
			st.Prerequisites = append(st.Prerequisites, "Released")
		}
		if g.Policy != "" && (i > 0 || bases) {
			st.Prerequisites = append(st.Prerequisites, "Validated")
		}
		out = append(out, st)
	}
	return out
}

// problems are the gates this plan cannot write.
func (g Gates) problems() []string {
	var out []string
	if g.Policy != "" {
		space, filter, ok := strings.Cut(g.Policy, "/")
		if !ok || space == "" || filter == "" || strings.Contains(filter, "/") {
			out = append(out, fmt.Sprintf("--policy %s names a trigger Filter as <space>/<filter>", g.Policy))
		}
	}
	for _, a := range g.Approvers {
		if !userID.MatchString(a) {
			out = append(out, fmt.Sprintf("--approver %s is not a ConfigHub user ID; cub user list shows each user's", a))
		}
	}
	seen := map[string]bool{"approval": true}
	for _, t := range g.Require {
		switch n := Slug(t); {
		case n == "":
			out = append(out, fmt.Sprintf("--require %q names no attestation type", t))
		case seen[n]:
			out = append(out, fmt.Sprintf("--require %s is already required: every stage's release waits for an approval, and for each type once", t))
		default:
			seen[n] = true
		}
	}
	return out
}

// workflowText is the workflow file: the order a change moves through this
// profile's clusters, and what each stage waits for.
func workflowText(stages []string, bases bool, g Gates) string {
	lines := []string{
		"# The order a change moves through this profile's clusters, and what each",
		"# stage waits for. ConfigHub enforces both on the server.",
		"#",
	}
	if len(g.Approvers) > 0 {
		lines = append(lines,
			"# Only the approvals of the users in FromUserIDs count, and never one from",
			"# the person or agent that wrote the change.")
	} else {
		lines = append(lines,
			"# AllowAuthors: true lets the person who promoted a change also approve it,",
			"# which one person trying this needs. Set it to false once a second person",
			"# approves: ConfigHub then refuses an approval from the change's author.")
	}
	if g.Policy != "" {
		lines = append(lines,
			"#",
			fmt.Sprintf("# Every base and variant runs the Triggers of %s. A change that", g.Policy),
			"# fails one is not released, and Validated holds each stage until the",
			"# stage ahead passes them.")
	}
	if len(g.Require) > 0 {
		lines = append(lines,
			"#",
			fmt.Sprintf("# Each stage's release also waits for a Pass of each of %s, recorded", strings.Join(g.Require, ", ")),
			"# against the change as it stands there with cub attestation create.")
	}
	lines = append(lines, "AttestationPrerequisites:")
	for _, r := range g.requirements() {
		lines = append(lines,
			"  - Name: "+r.Name,
			"    Type: "+r.Type,
			fmt.Sprintf("    Count: %d", r.Count),
			fmt.Sprintf("    AllowAuthors: %t", r.AllowAuthors))
		if len(r.FromUserIDs) > 0 {
			lines = append(lines, "    FromUserIDs:")
			for _, id := range r.FromUserIDs {
				lines = append(lines, "      - "+id)
			}
		}
	}
	lines = append(lines, "Stages:")
	for _, st := range g.stages(stages, bases) {
		if st.Name == basesStage {
			lines = append(lines,
				"  # carries a change from the root base into every class base;",
				"  # class bases are never released, so nothing waits on this stage")
		}
		lines = append(lines, "  - Name: "+st.Name, fmt.Sprintf("    WhereSpace: %q", st.WhereSpace))
		for _, list := range []struct {
			key    string
			values []string
		}{{"Prerequisites", st.Prerequisites}, {"ReleasePrerequisites", st.ReleasePrerequisites}} {
			if len(list.values) == 0 {
				continue
			}
			lines = append(lines, "    "+list.key+":")
			for _, v := range list.values {
				lines = append(lines, "      - "+v)
			}
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

// stagesJSON is the workflow's stages as a patch, the same stages
// workflowText writes.
func stagesJSON(stages []string, bases bool, g Gates) string {
	data, _ := json.Marshal(map[string]any{"Stages": g.stages(stages, bases)})
	return string(data)
}

// gatesJQ are two expressions over `cub changeworkflow get`: one says whether
// the workflow already has every gate these Gates add, the other is the
// workflow with any it lacks added. A gate or stage setting made in ConfigHub
// since is kept, so a fleet onboarded without a policy takes one on a re-run.
func gatesJQ(stages []string, bases bool, g Gates) (has, merged string) {
	var want []stageGate
	for _, st := range g.stages(stages, bases) {
		st.WhereSpace = ""
		want = append(want, st)
	}
	data, _ := json.Marshal(map[string]any{"req": g.requirements(), "stages": want})
	head := ".ChangeWorkflow as $w | " + string(data) + " as $g | "
	// The approval requirement is kept as it is in ConfigHub, unless the plan
	// names approvers: then who may approve is the plan's.
	approvers := ""
	if len(g.Approvers) > 0 {
		approvers = `([($w.AttestationPrerequisites // [])[] | select(.Name == "approval") | (.FromUserIDs // []) == ($g.req[0].FromUserIDs) and (.AllowAuthors // false) == false] | all) and `
	}
	has = head + approvers +
		`(($g.req | map(.Name)) - [($w.AttestationPrerequisites // [])[].Name] | length == 0) and ` +
		`([$w.Stages[] | . as $s | [$g.stages[] | select(.Name == $s.Name)][0] as $want | ` +
		`$want == null or ((($want.Prerequisites // []) - ($s.Prerequisites // []) | length == 0) and ` +
		`(($want.ReleasePrerequisites // []) - ($s.ReleasePrerequisites // []) | length == 0))] | all)`
	add := func(key string) string {
		return fmt.Sprintf(`| .%[1]s = (($s.%[1]s // []) + [($want.%[1]s // [])[] | select(. as $p | ($s.%[1]s // []) | index($p) | not)]) | if (.%[1]s | length) == 0 then del(.%[1]s) else . end `, key)
	}
	merged = head +
		`{AttestationPrerequisites: ([($w.AttestationPrerequisites // [])[] | ` + approvalFrom(g) + `] + [$g.req[] | select(.Name as $n | [($w.AttestationPrerequisites // [])[].Name] | index($n) | not)]), ` +
		`Stages: [$w.Stages[] | . as $s | [$g.stages[] | select(.Name == $s.Name)][0] as $want | ` +
		`if $want == null then $s else $s ` + add("Prerequisites") + add("ReleasePrerequisites") + `end]}`
	return has, merged
}

// approvalFrom is a jq step over one attestation prerequisite: with approvers
// named, the approval requirement takes them, and no longer counts the
// change's author; anything else passes through.
func approvalFrom(g Gates) string {
	if len(g.Approvers) == 0 {
		return "."
	}
	ids, _ := json.Marshal(g.Approvers)
	return fmt.Sprintf(`if .Name == "approval" then .FromUserIDs = %s | .AllowAuthors = false else . end`, ids)
}
