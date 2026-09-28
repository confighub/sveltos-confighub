package onboard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// JoinAnnotation is written on each variant Space the watcher proposes: which
// cluster joined, with which labels, and which profile's selector matched it.
const JoinAnnotation = "sveltos.confighub.com/joined"

// WatchOptions are what the watcher needs from the fleet's onboarding.
type WatchOptions struct {
	// Context is the management cluster's kubectl context.
	Context string
	// Out is the directory apply wrote, which the watcher writes again when a
	// cluster joins, and whose apply.sh it runs.
	Out string
	// Plan is the options the fleet was planned with.
	Plan Options
	// Profiles are the profiles apply saved, in profiles.yaml.
	Profiles []Doc
	Now      func() time.Time
	// Script runs apply.sh in Out with PROPOSE_ONLY=1, and returns what it
	// printed.
	Script func(dir, context string) ([]byte, error)
	// Write patches a Space, as the status reporter does.
	Write func(space string, patch []byte) error
}

// Join is one variant proposed for a cluster that joined.
type Join struct {
	Cluster  string            `json:"cluster"`
	Labels   map[string]string `json:"labels"`
	Profile  string            `json:"profile"`
	Selector string            `json:"selector,omitempty"`
	Stage    string            `json:"stage,omitempty"`
	Space    string            `json:"space"`
	Order    string            `json:"changeOrder"`
	At       string            `json:"proposedAt"`
}

// WatchReport is what one look at the fleet found and did.
type WatchReport struct {
	// Joins are the variants proposed, for clusters new to a profile.
	Joins []Join
	// Unmatched are clusters no profile selects, newly seen: nothing is
	// proposed for them.
	Unmatched []string
	// Waiting are the release orders not finished, as <base>/<order>.
	Waiting []string
	// Ran says apply.sh ran, and Output is what it printed.
	Ran    bool
	Output []byte
	// Recorded are the problems writing JoinAnnotation, which do not stop
	// the proposal.
	Recorded []string
}

// Watcher looks at the fleet again and again, remembering the last plan so a
// fleet whose clusters have not changed is not rendered again.
type Watcher struct {
	run  Runner
	opts WatchOptions
	seen string
	plan *Plan
	told map[string]bool
	// approvals are each waiting order's approvals when apply.sh last ran.
	approvals map[string]int
}

// NewWatcher is a watcher over one onboarded fleet.
func NewWatcher(run Runner, opts WatchOptions) *Watcher {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Script == nil {
		opts.Script = runProposeOnly
	}
	if opts.Write == nil {
		opts.Write = writeSpacePatch
	}
	return &Watcher{run: run, opts: opts, told: map[string]bool{}, approvals: map[string]int{}}
}

func runProposeOnly(dir, context string) ([]byte, error) {
	cmd := exec.Command("bash", filepath.Join(dir, "apply.sh"))
	cmd.Env = append(os.Environ(), "PROPOSE_ONLY=1")
	if context != "" {
		cmd.Env = append(cmd.Env, "MGMT_CONTEXT="+context)
	}
	return cmd.CombinedOutput()
}

func (w *Watcher) kubectl(args ...string) ([]byte, error) {
	if w.opts.Context != "" {
		args = append([]string{"--context", w.opts.Context}, args...)
	}
	return w.run("kubectl", args...)
}

// Once looks at the fleet: it plans again when the clusters or their labels
// changed, proposes a variant for each cluster a profile newly selects, and
// runs apply.sh without approving anything while a release order is not
// finished. A person approves in ConfigHub; the next look publishes what they
// approved and applies its delivery profile.
func (w *Watcher) Once() (WatchReport, error) {
	var report WatchReport
	out, err := w.kubectl("get", "sveltosclusters", "-A", "-o", "yaml")
	if err != nil {
		return report, err
	}
	clusterDocs, err := ParseDocs(out)
	if err != nil {
		return report, err
	}
	labels := map[string]map[string]string{}
	var keys []string
	for _, d := range clusterDocs {
		if isClusterKind(d.Value) {
			c := clusterOf(d.Value)
			labels[c.Key] = c.Labels
			keys = append(keys, c.Key+" "+fmt.Sprint(sortedLabels(c.Labels)))
		}
	}
	sort.Strings(keys)
	sum := sha256.Sum256([]byte(strings.Join(keys, "\n")))
	if seen := hex.EncodeToString(sum[:]); seen != w.seen || w.plan == nil {
		plan, err := PlanFleet(append(append([]Doc{}, w.opts.Profiles...), clusterDocs...), w.opts.Plan)
		if err != nil {
			return report, err
		}
		if len(plan.Problems) > 0 {
			return report, fmt.Errorf("the plan has problems, so nothing is proposed until they are fixed:\n  - %s", strings.Join(plan.Problems, "\n  - "))
		}
		w.plan, w.seen = plan, seen
	}
	plan := w.plan
	for _, c := range plan.Ungoverned {
		if !w.told[c.Key] {
			w.told[c.Key] = true
			report.Unmatched = append(report.Unmatched, c.Name)
		}
	}

	out, err = w.run("cub", "space", "list", "-o", "jq=[.[].Space.Slug]")
	if err != nil {
		return report, err
	}
	var slugs []string
	if err := json.Unmarshal(out, &slugs); err != nil {
		return report, fmt.Errorf("reading the Spaces: %w", err)
	}
	exists := map[string]bool{}
	for _, s := range slugs {
		exists[s] = true
	}
	now := w.opts.Now().UTC().Format(time.RFC3339)
	// apply.sh runs for a join, for a release order not made yet, and when a
	// waiting order has approvals it did not have when apply.sh last ran. An
	// order waiting on a person is otherwise only looked at.
	needed := false
	approvals := map[string]int{}
	for i := range plan.Profiles {
		p := &plan.Profiles[i]
		if !exists[p.BaseSpace] {
			return report, fmt.Errorf("%s is not in ConfigHub: onboard the fleet with apply.sh first", p.BaseSpace)
		}
		order := p.BaseSpace + "/" + p.ReleaseOrder
		var joins []Join
		for _, v := range p.Variants {
			if !exists[v.Space] {
				joins = append(joins, Join{Cluster: v.Cluster, Labels: labels[v.ClusterKey], Profile: p.Name, Selector: p.Selector, Stage: v.Stage, Space: v.Space, Order: order, At: now})
			}
		}
		if len(joins) > 0 {
			p.Description = joinDescription(joins)
			report.Joins = append(report.Joins, joins...)
			report.Waiting = append(report.Waiting, order)
			approvals[order], needed = 0, true
			continue
		}
		out, err := w.run("cub", "changeorder", "get", "--space", p.BaseSpace, p.ReleaseOrder, "-o", "jq=[.ChangeOrder.Stage, .ChangeOrder.ChangeOrderID]")
		var got []string
		if err != nil || json.Unmarshal(out, &got) != nil || len(got) != 2 {
			report.Waiting = append(report.Waiting, order)
			approvals[order], needed = 0, true
			continue
		}
		if got[0] == "Completed" {
			continue
		}
		report.Waiting = append(report.Waiting, order)
		out, err = w.run("cub", "attestation", "list", "--where", fmt.Sprintf("ChangeOrderID = '%s'", got[1]), "-o", "jq=length")
		if err != nil {
			return report, err
		}
		n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
		approvals[order] = n
		if last, ran := w.approvals[order]; !ran || last != n {
			needed = true
		}
	}
	if !needed {
		return report, nil
	}

	// A delivery profile applied beside a live profile of the same charts
	// conflicts with it; the fleet's live profiles leave with handover.sh.
	out, err = w.kubectl("get", "clusterprofiles", "-o", "json")
	if err != nil {
		return report, err
	}
	var profiles struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(out, &profiles); err != nil {
		return report, fmt.Errorf("reading the ClusterProfiles: %w", err)
	}
	for _, item := range profiles.Items {
		name := str(obj(item["metadata"])["name"])
		for _, p := range plan.Profiles {
			for _, m := range p.Members {
				if m.Name == name && !deliveredByConfigHub(item) {
					return report, fmt.Errorf("%s is still live on the management cluster: hand it over with handover.sh first, so no object has two profiles managing it", name)
				}
			}
		}
	}

	if _, err := WriteApply(plan, w.opts.Out); err != nil {
		return report, err
	}
	report.Ran = true
	report.Output, err = w.opts.Script(w.opts.Out, w.opts.Context)
	if err == nil {
		for order, n := range approvals {
			w.approvals[order] = n
		}
	}
	for _, j := range report.Joins {
		doc, _ := json.Marshal(j)
		patch, _ := json.Marshal(map[string]any{"Annotations": map[string]string{JoinAnnotation: string(doc)}})
		if werr := w.opts.Write(j.Space, patch); werr != nil {
			report.Recorded = append(report.Recorded, werr.Error())
		}
	}
	if err != nil {
		return report, fmt.Errorf("apply.sh: %w", err)
	}
	return report, nil
}

// joinDescription says why a release order was made: which clusters joined,
// with the labels that matched.
func joinDescription(joins []Join) string {
	var parts []string
	for _, j := range joins {
		parts = append(parts, fmt.Sprintf("%s joined (%s)", j.Cluster, strings.Join(sortedLabels(j.Labels), ", ")))
	}
	text := "Proposed by cub sveltos watch: " + strings.Join(parts, "; ")
	if joins[0].Selector != "" {
		text += "; selected by " + joins[0].Selector
	}
	if len(text) > 500 {
		text = text[:497] + "..."
	}
	return text
}

func sortedLabels(labels map[string]string) []string {
	var out []string
	for k, v := range labels {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}
