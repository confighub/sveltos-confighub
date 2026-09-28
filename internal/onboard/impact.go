package onboard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Exec runs a command with stdin, and returns what it printed and what it
// printed as errors.
type Exec func(stdin []byte, name string, args ...string) (stdout, stderr []byte, err error)

// RunWithInput runs a command on this machine.
func RunWithInput(stdin []byte, name string, args ...string) ([]byte, []byte, error) {
	cmd := exec.Command(name, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errs bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errs
	err := cmd.Run()
	return out.Bytes(), errs.Bytes(), err
}

// ImpactOptions name what to preview: the targets, the policies as they are,
// and either candidate policies or the configuration each target is about to
// take.
type ImpactOptions struct {
	// Sandbox is a disposable API server that holds policies and nothing
	// else, as a kubeconfig file and optionally a context in it.
	SandboxKubeconfig string
	SandboxContext    string
	// Component's cluster variants are the targets, each at the revision it
	// runs (its last release).
	Component string
	// StageLabel is the Space label that gives each target's stage, which the
	// policies' bindings select by.
	StageLabel string
	// Policies are the policy files in force. Candidates replace the objects
	// of the same kind, namespace and name, which is how a proposed policy
	// change is read.
	Policies   []string
	Candidates []string
	// Next compares each target's running configuration with what its next
	// promotion brings: the head of its upstream.
	Next bool
	// Corpus Spaces add their revisions ConfigHub recorded as failing a
	// policy, so a weaker candidate shows what it would newly allow.
	Corpus []string
	// Settle is how long the sandbox is given after policies change.
	Settle time.Duration
}

// ImpactRow is one object on one target, evaluated twice.
type ImpactRow struct {
	Target    string `json:"target"`
	Stage     string `json:"stage,omitempty"`
	Space     string `json:"space"`
	Config    string `json:"config"`
	Candidate string `json:"candidateConfig,omitempty"`
	Object    string `json:"object"`
	Current   string `json:"current"`
	Proposed  string `json:"candidate"`
	Verdict   string `json:"verdict"`
	Why       string `json:"why,omitempty"`
}

// ImpactReport is the whole preview.
type ImpactReport struct {
	Policies   []string `json:"policies"`
	Candidates []string `json:"candidatePolicies,omitempty"`
	// Removed are policies the sandbox held that neither set has. Their
	// removal can leave the parameters other policies read stale until the
	// sandbox's API server restarts.
	Removed []string    `json:"removedFromSandbox,omitempty"`
	Rows    []ImpactRow `json:"rows"`
}

const (
	NewlyDenied  = "newly denied"
	NewlyAllowed = "newly allowed"
	Unchanged    = "unchanged"
	Unknown      = "unknown"
)

// target is one set of objects to evaluate: a cluster's variant at a
// revision, or a revision from the corpus.
type target struct {
	name, stage, space, config, candidate string
	current, next                         []Doc
}

type admission struct {
	state string // allowed, denied or unknown
	why   string
}

var denied = regexp.MustCompile(`ValidatingAdmissionPolicy '([^']+)' with binding '([^']+)' denied request: (.*)`)

// contextBound are the parts of an admission request a configuration does
// not hold. A policy that reads one cannot be judged from configuration.
var contextBound = []string{"request.userInfo", "oldObject", "namespaceObject", "authorizer"}

// Impact evaluates every target under the policies in force and under the
// candidate, in the sandbox, and classifies each object's change: newly
// denied, newly allowed, unchanged, or unknown when the verdict needs what the
// configuration does not hold. The verdicts are the sandbox API server's own;
// nothing here judges a policy.
func Impact(x Exec, o ImpactOptions) (*ImpactReport, error) {
	if o.StageLabel == "" {
		o.StageLabel = "Stage"
	}
	if o.Settle == 0 {
		o.Settle = 5 * time.Second
	}
	current, err := readPolicies(o.Policies)
	if err != nil {
		return nil, err
	}
	candidate := current
	if len(o.Candidates) > 0 {
		c, err := readPolicies(o.Candidates)
		if err != nil {
			return nil, err
		}
		candidate = overlay(current, c)
	}
	if len(o.Candidates) == 0 && !o.Next {
		return nil, fmt.Errorf("give candidate policies (--candidate), or compare with what the next promotion brings (--next)")
	}
	targets, err := impactTargets(x, o)
	if err != nil {
		return nil, err
	}
	var removed []string
	s := sandbox{x: x, o: o, removed: &removed}
	kinds, err := s.discover(append(append([]Doc{}, current...), candidate...), targets)
	if err != nil {
		return nil, err
	}
	rules := policyRules(current, candidate)

	before, err := s.evaluate(current, targets, kinds, rules, false)
	if err != nil {
		return nil, err
	}
	after, err := s.evaluate(candidate, targets, kinds, rules, o.Next)
	if err != nil {
		return nil, err
	}

	report := &ImpactReport{Policies: o.Policies, Candidates: o.Candidates, Removed: removed}
	for _, t := range targets {
		for key, b := range before[t.name] {
			a, ok := after[t.name][key]
			if !ok {
				a = admission{"unknown", "not in the candidate configuration"}
			}
			row := ImpactRow{Target: t.name, Stage: t.stage, Space: t.space, Config: t.config, Object: key, Current: b.state, Proposed: a.state}
			if o.Next {
				row.Candidate = t.candidate
			}
			switch {
			case b.state == "unknown" || a.state == "unknown":
				row.Verdict, row.Why = Unknown, firstOf(a.why, b.why)
			case b.state == "allowed" && a.state == "denied":
				row.Verdict, row.Why = NewlyDenied, a.why
			case b.state == "denied" && a.state == "allowed":
				row.Verdict, row.Why = NewlyAllowed, b.why
			default:
				row.Verdict, row.Why = Unchanged, a.why
			}
			report.Rows = append(report.Rows, row)
		}
	}
	sort.Slice(report.Rows, func(i, j int) bool {
		if report.Rows[i].Target != report.Rows[j].Target {
			return report.Rows[i].Target < report.Rows[j].Target
		}
		return report.Rows[i].Object < report.Rows[j].Object
	})
	return report, nil
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func readPolicies(files []string) ([]Doc, error) {
	var docs []Doc
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		d, err := ParseDocs(data)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		docs = append(docs, d...)
	}
	return docs, nil
}

func objectKey(v map[string]any) string {
	meta := obj(v["metadata"])
	return strings.Join([]string{str(v["kind"]), str(meta["namespace"]), str(meta["name"])}, "/")
}

// overlay is the policies in force with the candidate's objects in place of
// those of the same kind, namespace and name.
func overlay(current, candidate []Doc) []Doc {
	replaced := map[string]bool{}
	for _, d := range candidate {
		replaced[objectKey(d.Value)] = true
	}
	var out []Doc
	for _, d := range current {
		if !replaced[objectKey(d.Value)] {
			out = append(out, d)
		}
	}
	return append(out, candidate...)
}

// A resourceRule is what a policy matches.
type resourceRule struct {
	policy                      string
	groups, versions, resources []string
	contextBound                string
}

func policyRules(sets ...[]Doc) []resourceRule {
	var rules []resourceRule
	for _, set := range sets {
		for _, d := range set {
			if str(d.Value["kind"]) != "ValidatingAdmissionPolicy" {
				continue
			}
			name := str(obj(d.Value["metadata"])["name"])
			spec, _ := json.Marshal(d.Value["spec"])
			bound := ""
			for _, c := range contextBound {
				if strings.Contains(string(spec), c) {
					bound = c
				}
			}
			for _, r := range list(obj(obj(d.Value["spec"])["matchConstraints"])["resourceRules"]) {
				r := obj(r)
				rules = append(rules, resourceRule{policy: name, groups: strs(r["apiGroups"]), versions: strs(r["apiVersions"]), resources: strs(r["resources"]), contextBound: bound})
			}
		}
	}
	return rules
}

func strs(v any) []string {
	var out []string
	for _, x := range list(v) {
		out = append(out, str(x))
	}
	return out
}

func matchesAny(values []string, v string) bool {
	for _, x := range values {
		if x == "*" || x == v {
			return true
		}
	}
	return false
}

// matching is the rules an object's group, version and resource meet.
func matching(rules []resourceRule, group, version, resource string) []resourceRule {
	var out []resourceRule
	for _, r := range rules {
		if matchesAny(r.groups, group) && matchesAny(r.versions, version) && matchesAny(r.resources, resource) {
			out = append(out, r)
		}
	}
	return out
}

// impactTargets are the component's cluster variants, each at the revision
// it runs, and the corpus's failing revisions.
func impactTargets(x Exec, o ImpactOptions) ([]target, error) {
	var targets []target
	if o.Component != "" {
		out, _, err := x(nil, "cub", "space", "list", "--where", fmt.Sprintf("Component.Slug = '%s' AND Labels.Role = 'deployment'", o.Component), "-o", "json")
		if err != nil {
			return nil, fmt.Errorf("listing the variants of %s: %w", o.Component, err)
		}
		var spaces []struct {
			Space struct {
				Slug   string
				Labels map[string]string
			}
		}
		if err := json.Unmarshal(out, &spaces); err != nil {
			return nil, err
		}
		for _, sp := range spaces {
			units, err := unitsOf(x, sp.Space.Slug)
			if err != nil {
				return nil, err
			}
			t := target{name: firstOf(sp.Space.Labels["Cluster"], sp.Space.Slug), stage: sp.Space.Labels[o.StageLabel], space: sp.Space.Slug}
			var configs, nexts []string
			for _, u := range units {
				rev := u.LastReleasedRevisionNum
				if rev == 0 {
					rev = u.HeadRevisionNum
				}
				docs, err := revisionDocs(x, sp.Space.Slug, u.Slug, rev)
				if err != nil {
					return nil, err
				}
				t.current = append(t.current, docs...)
				configs = append(configs, fmt.Sprintf("%s@%d", u.Slug, rev))
				if o.Next {
					if u.UpstreamUnitID == "" {
						return nil, fmt.Errorf("%s/%s has no upstream, so it has no next promotion", sp.Space.Slug, u.Slug)
					}
					out, _, err := x(nil, "cub", "unit", "get", "--space", u.UpstreamSpaceID, u.UpstreamUnitID, "-o", "json")
					if err != nil {
						return nil, fmt.Errorf("the upstream of %s/%s: %w", sp.Space.Slug, u.Slug, err)
					}
					var up struct {
						Unit struct {
							Slug            string
							SpaceSlug       string
							HeadRevisionNum int
						}
					}
					if err := json.Unmarshal(out, &up); err != nil {
						return nil, err
					}
					docs, err := revisionDocs(x, up.Unit.SpaceSlug, up.Unit.Slug, up.Unit.HeadRevisionNum)
					if err != nil {
						return nil, err
					}
					t.next = append(t.next, docs...)
					nexts = append(nexts, fmt.Sprintf("%s/%s@%d", up.Unit.SpaceSlug, up.Unit.Slug, up.Unit.HeadRevisionNum))
				}
			}
			t.config, t.candidate = strings.Join(configs, ","), strings.Join(nexts, ",")
			targets = append(targets, t)
		}
	}
	for _, space := range o.Corpus {
		units, err := unitsOf(x, space)
		if err != nil {
			return nil, err
		}
		stage := ""
		if out, _, err := x(nil, "cub", "space", "get", space, "-o", "jq=.Space.Labels"); err == nil {
			var labels map[string]string
			_ = json.Unmarshal(out, &labels)
			stage = labels[o.StageLabel]
		}
		for _, u := range units {
			out, _, err := x(nil, "cub", "revision", "list", "--space", space, u.Slug, "-o", "json")
			if err != nil {
				return nil, err
			}
			var revs []map[string]any
			if err := json.Unmarshal(out, &revs); err != nil {
				return nil, err
			}
			for _, r := range revs {
				rev := obj(r["Revision"])
				if rev == nil {
					rev = r
				}
				if len(obj(rev["ValidationErrors"])) == 0 {
					continue
				}
				num := int(rev["RevisionNum"].(float64))
				docs, err := revisionDocs(x, space, u.Slug, num)
				if err != nil {
					return nil, err
				}
				name := fmt.Sprintf("%s/%s@%d", space, u.Slug, num)
				t := target{name: name, stage: stage, space: space, config: fmt.Sprintf("%s@%d (recorded as failing)", u.Slug, num), current: docs}
				if o.Next {
					t.next = docs
				}
				targets = append(targets, t)
			}
		}
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no targets: give --component, --corpus, or both")
	}
	return targets, nil
}

type unitRow struct {
	Slug                    string
	HeadRevisionNum         int
	LastReleasedRevisionNum int
	UpstreamUnitID          string
	UpstreamSpaceID         string
}

func unitsOf(x Exec, space string) ([]unitRow, error) {
	out, _, err := x(nil, "cub", "unit", "list", "--space", space, "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("listing the units of %s: %w", space, err)
	}
	var rows []struct{ Unit unitRow }
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, err
	}
	var units []unitRow
	for _, r := range rows {
		units = append(units, r.Unit)
	}
	return units, nil
}

func revisionDocs(x Exec, space, unit string, rev int) ([]Doc, error) {
	out, _, err := x(nil, "cub", "revision", "data", "--space", space, unit, fmt.Sprint(rev))
	if err != nil {
		return nil, fmt.Errorf("%s/%s revision %d: %w", space, unit, rev, err)
	}
	return ParseDocs(out)
}

// sandbox is the disposable API server the verdicts come from.
type sandbox struct {
	x       Exec
	o       ImpactOptions
	removed *[]string
}

func (s sandbox) kubectl(stdin []byte, args ...string) ([]byte, []byte, error) {
	if s.o.SandboxContext != "" {
		args = append([]string{"--context", s.o.SandboxContext}, args...)
	}
	if s.o.SandboxKubeconfig != "" {
		args = append([]string{"--kubeconfig", s.o.SandboxKubeconfig}, args...)
	}
	return s.x(stdin, "kubectl", args...)
}

type kindInfo struct {
	resource   string
	namespaced bool
}

// discover asks the sandbox how each kind in play is served: its resource
// name, and whether it lives in a namespace.
func (s sandbox) discover(policies []Doc, targets []target) (map[string]kindInfo, error) {
	versions := map[string]bool{}
	for _, d := range policies {
		versions[str(d.Value["apiVersion"])] = true
	}
	for _, t := range targets {
		for _, d := range append(append([]Doc{}, t.current...), t.next...) {
			versions[str(d.Value["apiVersion"])] = true
		}
	}
	kinds := map[string]kindInfo{}
	for v := range versions {
		if v == "" {
			continue
		}
		path := "/apis/" + v
		if !strings.Contains(v, "/") {
			path = "/api/" + v
		}
		out, _, err := s.kubectl(nil, "get", "--raw", path)
		if err != nil {
			continue // a kind the sandbox does not serve is never evaluated
		}
		var list struct {
			Resources []struct {
				Name       string
				Kind       string
				Namespaced bool
			}
		}
		if json.Unmarshal(out, &list) != nil {
			continue
		}
		for _, r := range list.Resources {
			if !strings.Contains(r.Name, "/") {
				kinds[v+"/"+r.Kind] = kindInfo{resource: r.Name, namespaced: r.Namespaced}
			}
		}
	}
	return kinds, nil
}

// evaluate puts one set of policies in the sandbox, then submits every object
// a policy matches, from each target, with a server-side dry run.
func (s sandbox) evaluate(policies []Doc, targets []target, kinds map[string]kindInfo, rules []resourceRule, next bool) (map[string]map[string]admission, error) {
	namespaces := map[string]bool{}
	for _, d := range policies {
		if ns := str(obj(d.Value["metadata"])["namespace"]); ns != "" {
			namespaces[ns] = true
		}
	}
	for ns := range namespaces {
		if err := s.namespace(ns, nil); err != nil {
			return nil, err
		}
	}
	var docs []any
	for _, d := range policies {
		docs = append(docs, d.Value)
	}
	// The policies are applied over what the sandbox holds, never deleted and
	// made again: measured on Kubernetes v1.35, once a ValidatingAdmissionPolicy
	// is deleted, the parameters its successors read stay as they were until the
	// API server restarts. So only a policy the set does not have is removed, and
	// the report says so.
	if len(docs) > 0 {
		data, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "List", "items": docs})
		if _, errs, err := s.kubectl(data, "apply", "-f", "-"); err != nil {
			return nil, fmt.Errorf("putting the policies in the sandbox: %s", strings.TrimSpace(string(errs)))
		}
	}
	keep := map[string]bool{}
	for _, d := range policies {
		keep[strings.ToLower(str(d.Value["kind"]))+"/"+str(obj(d.Value["metadata"])["name"])] = true
	}
	held, _, err := s.kubectl(nil, "get", "validatingadmissionpolicies,validatingadmissionpolicybindings", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("reading the sandbox's policies: %w", err)
	}
	var heldList struct {
		Items []struct {
			Kind     string
			Metadata struct{ Name string }
		}
	}
	_ = json.Unmarshal(held, &heldList)
	for _, item := range heldList.Items {
		key := strings.ToLower(item.Kind) + "/" + item.Metadata.Name
		if keep[key] {
			continue
		}
		if _, errs, err := s.kubectl(nil, "delete", key); err != nil {
			return nil, fmt.Errorf("removing %s from the sandbox: %s", key, strings.TrimSpace(string(errs)))
		}
		*s.removed = append(*s.removed, key)
	}
	if err := s.settle(); err != nil {
		return nil, err
	}

	out := map[string]map[string]admission{}
	for _, t := range targets {
		ns := "impact-" + Slug(t.name)
		if len(ns) > 63 {
			ns = ns[:63]
		}
		ns = strings.TrimRight(ns, "-")
		if err := s.namespace(ns, map[string]string{"impact.confighub.com/stage": t.stage}); err != nil {
			return nil, err
		}
		objects := t.current
		if next {
			objects = t.next
		}
		out[t.name] = map[string]admission{}
		for _, d := range objects {
			v := d.Value
			apiVersion, kind := str(v["apiVersion"]), str(v["kind"])
			info, served := kinds[apiVersion+"/"+kind]
			if !served {
				continue
			}
			group, version := "", apiVersion
			if g, ver, ok := strings.Cut(apiVersion, "/"); ok {
				group, version = g, ver
			}
			// Every object either set's policies match is submitted in both
			// evaluations, so the two can be compared; whether a verdict
			// needs what configuration does not hold depends on this set's
			// policies alone.
			if len(matching(rules, group, version, info.resource)) == 0 {
				continue
			}
			key := kind + " " + str(obj(v["metadata"])["name"])
			for _, r := range matching(policyRules(policies), group, version, info.resource) {
				if r.contextBound != "" {
					out[t.name][key] = admission{"unknown", fmt.Sprintf("policy %s reads %s, which the configuration does not hold", r.policy, r.contextBound)}
				}
			}
			if _, done := out[t.name][key]; done {
				continue
			}
			out[t.name][key] = s.submit(v, info, ns)
		}
	}
	return out, nil
}

// submit asks the sandbox to create one object, and changes nothing.
func (s sandbox) submit(v map[string]any, info kindInfo, ns string) admission {
	o := map[string]any{}
	for k, val := range v {
		if k != "status" {
			o[k] = val
		}
	}
	meta := map[string]any{}
	for k, val := range obj(v["metadata"]) {
		switch k {
		case "resourceVersion", "uid", "creationTimestamp", "managedFields", "generation":
		default:
			meta[k] = val
		}
	}
	if info.namespaced {
		meta["namespace"] = ns
	}
	o["metadata"] = meta
	data, _ := json.Marshal(o)
	_, errs, err := s.kubectl(data, "create", "--dry-run=server", "-f", "-")
	if err == nil {
		return admission{state: "allowed"}
	}
	msg := strings.TrimSpace(string(errs))
	if m := denied.FindStringSubmatch(msg); m != nil {
		return admission{"denied", fmt.Sprintf("%s (binding %s): %s", m[1], m[2], m[3])}
	}
	if i := strings.LastIndex(msg, "\n"); i >= 0 {
		msg = msg[i+1:]
	}
	return admission{"unknown", "the sandbox could not judge it: " + msg}
}

func (s sandbox) namespace(name string, labels map[string]string) error {
	meta := map[string]any{"name": name}
	if len(labels) > 0 {
		meta["labels"] = labels
	}
	data, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": meta})
	if _, errs, err := s.kubectl(data, "apply", "-f", "-"); err != nil {
		return fmt.Errorf("namespace %s in the sandbox: %s", name, strings.TrimSpace(string(errs)))
	}
	return nil
}

// settle waits for the API server to have checked every policy, then gives
// its bindings a moment to take effect.
func (s sandbox) settle() error {
	for i := 0; i < 60; i++ {
		out, _, err := s.kubectl(nil, "get", "validatingadmissionpolicies", "-o", "json")
		if err != nil {
			return err
		}
		var list struct {
			Items []struct {
				Metadata struct{ Generation int64 }
				Status   struct{ ObservedGeneration int64 }
			}
		}
		if err := json.Unmarshal(out, &list); err != nil {
			return err
		}
		ready := true
		for _, p := range list.Items {
			if p.Status.ObservedGeneration < p.Metadata.Generation {
				ready = false
			}
		}
		if ready {
			if s.o.Settle > 0 {
				time.Sleep(s.o.Settle)
			}
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("the sandbox did not check the policies within 30 seconds")
}
