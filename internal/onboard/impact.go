package onboard

import (
	"bytes"
	"encoding/json"
	"fmt"
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
	// Policies are the policies in force, and Candidates replace the objects
	// of the same kind, namespace and name, which is how a proposed policy
	// change is read. Each is a file, or policies held in ConfigHub at a
	// revision (see policyset.go), such as mer-policies@Tag:in-force.
	Policies   []string
	Candidates []string
	// Tests are known cases, each an object annotated with the stage whose
	// policies it meets and the verdict it expects there.
	Tests []string
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
	// Policy is where the policy behind the verdict came from, such as
	// mer-policies/replica-limits@2.
	Policy string `json:"policy,omitempty"`
	// Expected is a test case's expected verdict.
	Expected string `json:"expected,omitempty"`
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
	// Tests are the test sources read. FailingNow are the cases the policies
	// in force do not treat as they expect; FailingThen the cases the
	// candidate does not, such as a known-bad change a weaker policy admits.
	Tests       []string `json:"tests,omitempty"`
	FailingNow  []string `json:"testsFailingNow,omitempty"`
	FailingThen []string `json:"testsFailingUnderCandidate,omitempty"`
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
	expect                                string // a test case's expected verdict
}

type admission struct {
	state  string // allowed, denied or unknown
	why    string
	policy string // the ValidatingAdmissionPolicy behind the verdict
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
func Impact(x Exec, hub Hub, o ImpactOptions) (*ImpactReport, error) {
	if o.StageLabel == "" {
		o.StageLabel = "Stage"
	}
	if o.Settle == 0 {
		o.Settle = 5 * time.Second
	}
	if len(o.Candidates) == 0 && !o.Next && len(o.Tests) == 0 {
		return nil, fmt.Errorf("give candidate policies (--candidate), compare with what the next promotion brings (--next), or run tests (--tests)")
	}
	cur, err := readSources(hub, o.Policies)
	if err != nil {
		return nil, err
	}
	current := cur.policies()
	if len(current) == 0 {
		return nil, fmt.Errorf("no policies in force: give --policy")
	}
	cand, candidate := cur, current
	var candSources []string
	if len(o.Candidates) > 0 {
		c, err := readSources(hub, o.Candidates)
		if err != nil {
			return nil, err
		}
		candidate = overlay(current, c.policies())
		cand = sourced{from: map[string]string{}}
		for k, v := range cur.from {
			cand.from[k] = v
		}
		for k, v := range c.from {
			cand.from[k] = v
		}
		candSources = c.sorted
	}
	targets, err := impactTargets(hub, o)
	if err != nil {
		return nil, err
	}
	var removed []string
	s := sandbox{x: x, o: o, removed: &removed}
	if err := s.ensure(); err != nil {
		return nil, err
	}
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

	report := &ImpactReport{Policies: cur.sorted, Candidates: candSources, Removed: removed}
	for _, t := range targets {
		if t.expect != "" && len(before[t.name]) == 0 {
			report.FailingNow = append(report.FailingNow, fmt.Sprintf("%s: expects %s, and no policy matches it", t.name, t.expect))
		}
		for key, b := range before[t.name] {
			a, ok := after[t.name][key]
			if !ok {
				a = admission{state: "unknown", why: "not in the candidate configuration"}
			}
			row := ImpactRow{Target: t.name, Stage: t.stage, Space: t.space, Config: t.config, Object: key, Current: b.state, Proposed: a.state}
			if o.Next {
				row.Candidate = t.candidate
			}
			switch {
			case a.state == "unknown":
				row.Verdict, row.Why, row.Policy = Unknown, a.why, cand.policy(a.policy)
			case b.state == "unknown":
				row.Verdict, row.Why, row.Policy = Unknown, b.why, cur.policy(b.policy)
			case b.state == "allowed" && a.state == "denied":
				row.Verdict, row.Why, row.Policy = NewlyDenied, a.why, cand.policy(a.policy)
			case b.state == "denied" && a.state == "allowed":
				row.Verdict, row.Why, row.Policy = NewlyAllowed, b.why, cur.policy(b.policy)
			default:
				row.Verdict, row.Why, row.Policy = Unchanged, a.why, cand.policy(a.policy)
			}
			if t.expect != "" {
				row.Expected = t.expect
				if b.state != t.expect {
					report.FailingNow = append(report.FailingNow, fmt.Sprintf("%s: expects %s, and the policies in force give %s", t.name, t.expect, b.state))
				}
				if len(o.Candidates) > 0 && a.state != t.expect {
					report.FailingThen = append(report.FailingThen, fmt.Sprintf("%s: expects %s, and the candidate gives %s", t.name, t.expect, a.state))
				}
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
	sort.Strings(report.FailingNow)
	sort.Strings(report.FailingThen)
	for _, t := range targets {
		if t.expect != "" && (len(report.Tests) == 0 || report.Tests[len(report.Tests)-1] != t.space) {
			report.Tests = append(report.Tests, t.space)
		}
	}
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
func impactTargets(hub Hub, o ImpactOptions) ([]target, error) {
	var targets []target
	if o.Component != "" {
		spaces, err := hub.Spaces(fmt.Sprintf("Component.Slug = '%s' AND Labels.Role = 'deployment'", o.Component))
		if err != nil {
			return nil, fmt.Errorf("listing the variants of %s: %w", o.Component, err)
		}
		for _, sp := range spaces {
			units, err := unitsOf(hub, sp.Slug)
			if err != nil {
				return nil, err
			}
			t := target{name: firstOf(sp.Labels["Cluster"], sp.Slug), stage: sp.Labels[o.StageLabel], space: sp.Slug}
			var configs, nexts []string
			for _, u := range units {
				rev := u.Released
				if rev == 0 {
					rev = u.Head
				}
				docs, err := revisionDocs(hub, sp.Slug, u.Slug, rev)
				if err != nil {
					return nil, err
				}
				t.current = append(t.current, docs...)
				configs = append(configs, fmt.Sprintf("%s@%d", u.Slug, rev))
				if o.Next {
					if u.UpstreamUnitID == "" {
						return nil, fmt.Errorf("%s/%s has no upstream, so it has no next promotion", sp.Slug, u.Slug)
					}
					up, err := hub.Unit(u.UpstreamSpaceID, u.UpstreamUnitID)
					if err != nil {
						return nil, fmt.Errorf("the upstream of %s/%s: %w", sp.Slug, u.Slug, err)
					}
					docs, err := revisionDocs(hub, up.SpaceSlug, up.Slug, up.Head)
					if err != nil {
						return nil, err
					}
					t.next = append(t.next, docs...)
					nexts = append(nexts, fmt.Sprintf("%s/%s@%d", up.SpaceSlug, up.Slug, up.Head))
				}
			}
			t.config, t.candidate = strings.Join(configs, ","), strings.Join(nexts, ",")
			targets = append(targets, t)
		}
	}
	if len(o.Tests) > 0 {
		s, err := readSources(hub, o.Tests)
		if err != nil {
			return nil, err
		}
		found := false
		for _, d := range s.docs {
			if !isTest(d) {
				continue
			}
			stage, expect, v := testCase(d)
			if expect != "denied" && expect != "allowed" {
				return nil, fmt.Errorf("test case %s expects %q; say denied or allowed", objectKey(d.Value), expect)
			}
			found = true
			from := s.from[objectKey(d.Value)]
			name := "tests/" + str(obj(v["metadata"])["name"])
			one := []Doc{{Value: v}}
			targets = append(targets, target{name: name, stage: stage, space: from, config: from, current: one, next: one, expect: expect})
		}
		if !found {
			return nil, fmt.Errorf("no test case in %s: annotate each with %s and %s", strings.Join(o.Tests, ", "), StageAnnotation, ExpectAnnotation)
		}
	}
	for _, space := range o.Corpus {
		units, err := unitsOf(hub, space)
		if err != nil {
			return nil, err
		}
		stage := ""
		if sp, err := hub.Space(space); err == nil {
			stage = sp.Labels[o.StageLabel]
		}
		for _, u := range units {
			revs, err := hub.Revisions(space, u.Slug, "")
			if err != nil {
				return nil, err
			}
			for _, r := range revs {
				if !r.Failing {
					continue
				}
				num := r.Num
				docs, err := revisionDocs(hub, space, u.Slug, num)
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
		return nil, fmt.Errorf("no targets: give --component, --corpus or --tests")
	}
	return targets, nil
}

func unitsOf(hub Hub, space string) ([]HubUnit, error) {
	units, err := hub.Units(space)
	if err != nil {
		return nil, fmt.Errorf("listing the units of %s: %w", space, err)
	}
	return units, nil
}

func revisionDocs(hub Hub, space, unit string, rev int) ([]Doc, error) {
	out, err := hub.RevisionData(space, unit, rev)
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

// ensure refuses a cluster that is not a sandbox. Its admission policies are
// replaced, and others deleted, so a sandbox has to be named, never taken from
// the current context, and has to run nothing but Kubernetes itself: on a
// management cluster the policies would refuse Sveltos its own writes.
func (s sandbox) ensure() error {
	if s.o.SandboxKubeconfig == "" && s.o.SandboxContext == "" {
		return fmt.Errorf("name the sandbox with --sandbox-kubeconfig or --sandbox-context: its admission policies are replaced, so the current context, which may be a real cluster, is never used")
	}
	out, stderr, err := s.kubectl(nil, "get", "deployments,statefulsets,daemonsets", "-A", "-o", `jsonpath={range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}`)
	if err != nil {
		return fmt.Errorf("reading what the sandbox runs: %v %s", err, strings.TrimSpace(string(stderr)))
	}
	var running []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		ns, _, _ := strings.Cut(l, "/")
		if l == "" || ns == "kube-system" || ns == "local-path-storage" {
			continue
		}
		running = append(running, l)
	}
	if len(running) > 0 {
		if len(running) > 3 {
			running = append(running[:3], fmt.Sprintf("and %d more", len(running)-3))
		}
		return fmt.Errorf("the cluster named as the sandbox runs %s, so it is not a sandbox: its admission policies would be replaced. Name a disposable cluster that runs nothing but Kubernetes", strings.Join(running, ", "))
	}
	return nil
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
					out[t.name][key] = admission{"unknown", fmt.Sprintf("policy %s reads %s, which the configuration does not hold", r.policy, r.contextBound), r.policy}
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
		return admission{"denied", fmt.Sprintf("%s (binding %s): %s", m[1], m[2], m[3]), m[1]}
	}
	if i := strings.LastIndex(msg, "\n"); i >= 0 {
		msg = msg[i+1:]
	}
	return admission{state: "unknown", why: "the sandbox could not judge it: " + msg}
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
