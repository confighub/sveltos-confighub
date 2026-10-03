package onboard

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
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
	// Sandbox, in place of a function, judges each revision as `cub sveltos
	// impact` does: a server-side dry run in a disposable API server that holds
	// the policies, in a namespace labelled with the variant's stage. The
	// attestation then names the policy revisions it was judged by.
	Sandbox *SandboxCheck
	// Parity, in place of a function or a sandbox, compares each variant with
	// the variants of an earlier stage, field by field.
	Parity *ParityCheck
}

// ParityCheck is the stage a variant must match, and the guard that declares
// where it may depart from it.
type ParityCheck struct {
	// With is the stage to match, such as staging. Each of its variants is
	// read at the revision the change order marks there, or, where the order
	// marks none, at its last release: what it runs, or will run.
	With string
	// DeclaredBy is the guard key that declares a departure, recorded with cub
	// unit set-guard on the path or an object that holds it, with the reason
	// as its value: departure=prod-capacity.
	DeclaredBy string
}

// SandboxCheck is the sandbox and the policies a check is judged by.
type SandboxCheck struct {
	Exec                Exec
	Kubeconfig, Context string
	// Policies are policy sources, such as mer-policies@Tag:in-force.
	Policies   []string
	StageLabel string
	Settle     time.Duration
}

// CheckResult is one variant's verdict.
type CheckResult struct {
	Space string
	// Revisions are what was checked, as <unit>/<revision>: exactly what the
	// attestation covers.
	Revisions []string
	Passed    bool
	Details   []string
	// Declared are the departures a parity check found declared, with why.
	Declared []string
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

// Check runs a validating function on each variant a change order has reached
// in a stage, on the revisions the order marks there, and records the verdict
// as an attestation of opts.Type: a Pass, or a rejection that blocks the
// release until it is revoked. A stage whose releases require that type then
// publishes only what passed; unlike a Trigger, nothing lets a release
// through when the check has not run.
func Check(run Runner, hub Hub, opts CheckOptions) ([]CheckResult, error) {
	base, order, ok := strings.Cut(opts.ChangeOrder, "/")
	if !ok || base == "" || order == "" || opts.Stage == "" || (len(opts.Function) == 0 && opts.Sandbox == nil && opts.Parity == nil) {
		return nil, fmt.Errorf("check needs --change-order <base space>/<order>, --stage, and a function, a sandbox with policies, or --parity-with <stage>")
	}
	if opts.Type == "" {
		opts.Type = "PolicyCheck"
		if opts.Parity != nil {
			opts.Type = "ParityCheck"
		}
	}
	if opts.Parity != nil {
		if opts.Parity.DeclaredBy == "" {
			opts.Parity.DeclaredBy = "departure"
		}
		if opts.Parity.With == opts.Stage {
			return nil, fmt.Errorf("a stage cannot be checked for parity with itself")
		}
		if len(opts.Function) > 0 || opts.Sandbox != nil || opts.Worker != "" {
			return nil, fmt.Errorf("check parity, with a function, or with the sandbox: one of them")
		}
	}
	co, err := hub.ChangeOrder(base, order)
	if err != nil {
		return nil, fmt.Errorf("reading change order %s: %w", opts.ChangeOrder, err)
	}
	where := ""
	for _, s := range co.Stages {
		if s.Name == opts.Stage {
			where = s.WhereSpace
		}
	}
	if where == "" {
		return nil, fmt.Errorf("change order %s has no stage %s", opts.ChangeOrder, opts.Stage)
	}
	spaces, err := hub.Spaces(where)
	if err != nil {
		return nil, fmt.Errorf("reading the Spaces of stage %s: %w", opts.Stage, err)
	}
	inScope := map[string]bool{}
	for _, id := range co.InScope {
		inScope[id] = true
	}
	var results []CheckResult
	subjects := map[string][]subject{}
	var targets []target
	for _, sp := range spaces {
		if !inScope[sp.ID] {
			continue
		}
		r := CheckResult{Space: sp.Slug, Passed: true}
		// The revisions the attestation would cover, which are the ones to check.
		dry, err := hub.Attest(HubAttestation{Space: sp.Slug, Type: opts.Type, ChangeOrderID: co.ID}, true)
		if err != nil {
			return results, fmt.Errorf("%s: reading what the attestation would cover: %w", sp.Slug, err)
		}
		if len(dry.Subjects) == 0 {
			r.Skipped = "the change order marks no revision here yet; promote it into the stage first"
		}
		subjects[sp.Slug] = dry.Subjects
		for _, s := range dry.Subjects {
			r.Revisions = append(r.Revisions, fmt.Sprintf("%s/%d", s.UnitSlug, s.RevisionNum))
			if opts.Sandbox != nil {
				docs, err := revisionDocs(hub, sp.Slug, s.UnitSlug, s.RevisionNum)
				if err != nil {
					return results, err
				}
				stage := sp.Labels[firstOf(opts.Sandbox.StageLabel, "Stage")]
				targets = append(targets, target{name: fmt.Sprintf("%s/%s@%d", sp.Slug, s.UnitSlug, s.RevisionNum), stage: stage, current: docs})
			}
		}
		results = append(results, r)
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("no Space of stage %s is in change order %s", opts.Stage, opts.ChangeOrder)
	}

	checker := ""
	var claims map[string]string
	var judged map[string]map[string]admission
	var policies sourced
	if opts.Sandbox != nil {
		var err error
		if judged, policies, err = sandboxJudge(*opts.Sandbox, hub, targets); err != nil {
			// Nothing was judged, so no variant is reported as passed.
			return nil, err
		}
		checker = "the policies " + strings.Join(policies.sorted, ", ")
		claims = map[string]string{"check.confighub.com/policies": strings.Join(policies.sorted, ",")}
	} else if opts.Parity != nil {
		checker = "parity with " + opts.Parity.With
		claims = map[string]string{"check.confighub.com/parity-with": opts.Parity.With}
	} else {
		checker = opts.Function[0]
		claims = map[string]string{"check.confighub.com/function": opts.Function[0]}
	}
	var parity map[string]*parityFinding
	toCheck := false
	for _, subs := range subjects {
		toCheck = toCheck || len(subs) > 0
	}
	if opts.Parity != nil && toCheck {
		var err error
		if parity, err = parityJudge(hub, co, opts, subjects); err != nil {
			return nil, err
		}
	}

	for i := range results {
		r := &results[i]
		if r.Skipped != "" {
			continue
		}
		if f := parity[r.Space]; f != nil {
			r.Details = append(r.Details, f.undeclared...)
			r.Declared = f.declared
			r.Passed = len(f.undeclared) == 0
			checker = "parity with " + strings.Join(f.against, ", ")
		}
		for _, s := range subjects[r.Space] {
			if opts.Parity != nil {
				break
			}
			rev := fmt.Sprintf("%s/%d", s.UnitSlug, s.RevisionNum)
			if opts.Sandbox != nil {
				verdicts := judged[fmt.Sprintf("%s/%s@%d", r.Space, s.UnitSlug, s.RevisionNum)]
				keys := make([]string, 0, len(verdicts))
				for k := range verdicts {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				for _, k := range keys {
					switch a := verdicts[k]; a.state {
					case "denied":
						r.Passed = false
						r.Details = append(r.Details, fmt.Sprintf("%s: %s denied by %s", rev, k, firstOf(policies.policy(a.policy), a.policy)+": "+a.why))
					case "unknown":
						r.Passed = false
						r.Details = append(r.Details, fmt.Sprintf("%s: %s not judged: %s", rev, k, a.why))
					}
				}
				continue
			}
			// The function and its arguments are the user's, in cub's own
			// syntax, so cub runs it.
			args := append(append([]string{"function", "vet"}, opts.Function...), "--space", r.Space, "--revision", rev)
			if opts.Worker != "" {
				args = append(args, "--worker", opts.Worker)
			}
			out, err := run("cub", append(args, "-o", "jq=[.[] | .Outputs.ValidationResult]")...)
			if err != nil {
				return results, fmt.Errorf("%s %s: %w", r.Space, rev, err)
			}
			v, err := verdicts(out)
			if err != nil {
				return results, fmt.Errorf("%s %s: %w", r.Space, rev, err)
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
		verdict := HubAttestation{Space: r.Space, Type: opts.Type, ChangeOrderID: co.ID, Claims: claims,
			Note: fmt.Sprintf("%s passed on %s", checker, strings.Join(r.Revisions, ", "))}
		if len(r.Declared) > 0 {
			verdict.Note = clip(fmt.Sprintf("%s; declared departures (%d): %s", verdict.Note, len(r.Declared), strings.Join(r.Declared, "; ")))
		}
		if !r.Passed {
			verdict.Note = clip(fmt.Sprintf("%s failed: %s", checker, strings.Join(r.Details, "; ")))
			verdict.Reject = true
		}
		recorded, err := hub.Attest(verdict, false)
		if err != nil {
			return results, fmt.Errorf("%s: recording the verdict: %w", r.Space, err)
		}
		r.Recorded = recorded.ID
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Space < results[j].Space })
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

// sandboxJudge puts the policies in the sandbox and submits every object they
// match, from each revision, with a server-side dry run.
func sandboxJudge(o SandboxCheck, hub Hub, targets []target) (map[string]map[string]admission, sourced, error) {
	set, err := readSources(hub, o.Policies)
	if err != nil {
		return nil, set, err
	}
	policies := set.policies()
	if len(policies) == 0 {
		return nil, set, fmt.Errorf("no policies to judge by: give --policy")
	}
	if o.Settle == 0 {
		o.Settle = 5 * time.Second
	}
	var removed []string
	s := sandbox{x: o.Exec, o: ImpactOptions{SandboxKubeconfig: o.Kubeconfig, SandboxContext: o.Context, Settle: o.Settle}, removed: &removed}
	if err := s.ensure(); err != nil {
		return nil, set, err
	}
	kinds, err := s.discover(policies, targets)
	if err != nil {
		return nil, set, err
	}
	judged, err := s.evaluate(policies, targets, kinds, policyRules(policies), false)
	return judged, set, err
}
