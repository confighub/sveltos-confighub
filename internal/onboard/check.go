package onboard

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// CheckOptions name a check to run on a change order as it stands in one
// stage, and the attestation that records its verdict.
type CheckOptions struct {
	// ChangeOrder is <base space>/<order>.
	ChangeOrder string
	Stage       string
	// Type is the attestation type a stage's release waits for, such as
	// PolicyCheck.
	Type string
	// Worker runs the function, as <space>/<worker>, for a worker function
	// such as vet-kyverno-server.
	Worker string
	// Function is a validating function and its arguments.
	Function []string
}

// CheckResult is one variant's verdict.
type CheckResult struct {
	Space string
	// Revisions are what was checked, as <unit>/<revision>: exactly what the
	// attestation covers.
	Revisions []string
	Passed    bool
	Details   []string
	// Recorded is the attestation's ID; Skipped says why none was recorded.
	Recorded string
	Skipped  string
}

type subject struct {
	UnitSlug    string
	RevisionNum int
}

type verdict struct {
	Passed  bool
	Details []string
}

var recordedID = regexp.MustCompile(`attestation ([0-9a-f-]{36})`)

// Check runs a validating function on each variant a change order has reached
// in a stage, on the revisions the order marks there, and records the verdict
// as an attestation of opts.Type: a Pass, or a rejection that blocks the
// release until it is revoked. A stage whose releases require that type then
// publishes only what passed; unlike a Trigger, nothing lets a release
// through when the check has not run.
func Check(run Runner, opts CheckOptions) ([]CheckResult, error) {
	base, order, ok := strings.Cut(opts.ChangeOrder, "/")
	if !ok || base == "" || order == "" || opts.Stage == "" || len(opts.Function) == 0 {
		return nil, fmt.Errorf("check needs --change-order <base space>/<order>, --stage and a function")
	}
	if opts.Type == "" {
		opts.Type = "PolicyCheck"
	}
	out, err := run("cub", "changeorder", "get", "--space", base, order, "-o", "json")
	if err != nil {
		return nil, err
	}
	var co struct {
		ChangeOrder struct {
			InScopeSpaceIDs []string
			ChangeWorkflow  struct{ Stages []stageGate }
		}
	}
	if err := json.Unmarshal(out, &co); err != nil {
		return nil, fmt.Errorf("reading change order %s: %w", opts.ChangeOrder, err)
	}
	where := ""
	for _, s := range co.ChangeOrder.ChangeWorkflow.Stages {
		if s.Name == opts.Stage {
			where = s.WhereSpace
		}
	}
	if where == "" {
		return nil, fmt.Errorf("change order %s has no stage %s", opts.ChangeOrder, opts.Stage)
	}
	out, err = run("cub", "space", "list", "--where", where, "-o", "jq=[.[].Space | {SpaceID, Slug}]")
	if err != nil {
		return nil, err
	}
	var spaces []struct{ SpaceID, Slug string }
	if err := json.Unmarshal(out, &spaces); err != nil {
		return nil, fmt.Errorf("reading the Spaces of stage %s: %w", opts.Stage, err)
	}
	inScope := map[string]bool{}
	for _, id := range co.ChangeOrder.InScopeSpaceIDs {
		inScope[id] = true
	}
	var results []CheckResult
	for _, sp := range spaces {
		if !inScope[sp.SpaceID] {
			continue
		}
		r := CheckResult{Space: sp.Slug, Passed: true}
		// The revisions the attestation would cover, which are the ones to check.
		out, err := run("cub", "attestation", "create", "--space", sp.Slug, "--type", opts.Type, "--change-order", opts.ChangeOrder, "--dry-run", "-o", "json")
		if err != nil {
			return results, err
		}
		var dry struct{ Subjects []subject }
		if err := json.Unmarshal(out, &dry); err != nil {
			return results, fmt.Errorf("%s: reading what the attestation would cover: %w", sp.Slug, err)
		}
		if len(dry.Subjects) == 0 {
			r.Skipped = "the change order marks no revision here yet; promote it into the stage first"
			results = append(results, r)
			continue
		}
		for _, s := range dry.Subjects {
			rev := fmt.Sprintf("%s/%d", s.UnitSlug, s.RevisionNum)
			r.Revisions = append(r.Revisions, rev)
			args := append(append([]string{"function", "vet"}, opts.Function...), "--space", sp.Slug, "--revision", rev)
			if opts.Worker != "" {
				args = append(args, "--worker", opts.Worker)
			}
			out, err := run("cub", append(args, "-o", "jq=[.[] | .Outputs.ValidationResult]")...)
			if err != nil {
				return results, fmt.Errorf("%s %s: %w", sp.Slug, rev, err)
			}
			v, err := verdicts(out)
			if err != nil {
				return results, fmt.Errorf("%s %s: %w", sp.Slug, rev, err)
			}
			for _, one := range v {
				if !one.Passed {
					r.Passed = false
					for _, d := range one.Details {
						r.Details = append(r.Details, rev+": "+d)
					}
				}
			}
		}
		note := fmt.Sprintf("%s passed on %s", opts.Function[0], strings.Join(r.Revisions, ", "))
		args := []string{"attestation", "create", "--space", sp.Slug, "--type", opts.Type, "--change-order", opts.ChangeOrder,
			"--claim", "check.confighub.com/function=" + opts.Function[0]}
		if !r.Passed {
			note = clip(fmt.Sprintf("%s failed: %s", opts.Function[0], strings.Join(r.Details, "; ")))
			args = append(args, "--reject")
		}
		out, err = run("cub", append(args, "--note", note)...)
		if err != nil {
			return results, fmt.Errorf("%s: recording the verdict: %w", sp.Slug, err)
		}
		if m := recordedID.FindStringSubmatch(string(out)); m != nil {
			r.Recorded = m[1]
		}
		results = append(results, r)
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Space < results[j].Space })
	if len(results) == 0 {
		return nil, fmt.Errorf("no Space of stage %s is in change order %s", opts.Stage, opts.ChangeOrder)
	}
	return results, nil
}

// verdicts reads what a validating function returned for one revision: a
// base64 JSON list of results.
func verdicts(out []byte) ([]verdict, error) {
	var encoded []string
	if err := json.Unmarshal(out, &encoded); err != nil {
		return nil, fmt.Errorf("reading the function's result: %w", err)
	}
	var all []verdict
	for _, e := range encoded {
		data, err := base64.StdEncoding.DecodeString(e)
		if err != nil {
			return nil, fmt.Errorf("reading the function's result: %w", err)
		}
		var v []verdict
		if err := json.Unmarshal(data, &v); err != nil {
			return nil, fmt.Errorf("reading the function's result: %w", err)
		}
		all = append(all, v...)
	}
	if len(all) == 0 {
		return nil, fmt.Errorf("the function returned no validation result; is it a validating function?")
	}
	return all, nil
}
