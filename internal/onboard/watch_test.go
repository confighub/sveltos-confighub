package onboard

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var watchOpts = Options{StageLabel: "env", Stages: []string{"staging", "prod"}}

const watchedProfile = "  clusterSelector: {matchLabels: {team: platform}}"

// fleetBench is a management cluster and a ConfigHub organization, as the
// watcher sees them through kubectl and cub.
type fleetBench struct {
	t         *testing.T
	clusters  string
	spaces    map[string]bool
	released  map[string]bool   // variant Spaces with a published release
	orders    map[string]string // base/order: its ID
	approvals map[string]int    // change order ID: approvals
	live      []string          // ClusterProfiles on the management cluster not from ConfigHub
	renders   int
	scripts   int
	annotated map[string]string
	afterRun  func()
}

func newBench(t *testing.T, clusters string) *fleetBench {
	b := &fleetBench{t: t, clusters: clusters, orders: map[string]string{}, approvals: map[string]int{}, annotated: map[string]string{},
		spaces: map[string]bool{"sveltos-targets": true, "sveltos-kyverno-base": true, "sveltos-management": true,
			"sveltos-kyverno-staging-eu": true, "sveltos-kyverno-prod-eu": true},
		released: map[string]bool{"sveltos-kyverno-staging-eu": true, "sveltos-kyverno-prod-eu": true}}
	return b
}

func (b *fleetBench) run(name string, args ...string) ([]byte, error) {
	all := name + " " + strings.Join(args, " ")
	switch {
	case all == "kubectl --context mgmt get sveltosclusters -A -o yaml":
		return []byte(b.clusters), nil
	case all == "kubectl --context mgmt get clusterprofiles -o json":
		var items []map[string]any
		for _, n := range b.live {
			items = append(items, map[string]any{"metadata": map[string]any{"name": n}, "spec": map[string]any{}})
		}
		return json.Marshal(map[string]any{"items": items})
	case all == "cub space list -o jq=[.[].Space.Slug]":
		var slugs []string
		for s := range b.spaces {
			slugs = append(slugs, s)
		}
		return json.Marshal(slugs)
	case all == "cub release list --space * --where Published = true AND Space.Slug LIKE 'sveltos-%' -o jq=[.[] | (.Release // .) | .SpaceSlug] | unique":
		var slugs []string
		for s := range b.released {
			slugs = append(slugs, s)
		}
		return json.Marshal(slugs)
	case strings.HasPrefix(all, "cub changeorder get --space ") && strings.HasSuffix(all, " -o jq=.ChangeOrder.ChangeOrderID"):
		id, ok := b.orders[args[3]+"/"+args[4]]
		if !ok {
			return nil, errors.New("not found")
		}
		return json.Marshal(id)
	case strings.HasPrefix(all, "cub attestation list --where ChangeOrderID = "):
		id := strings.Trim(strings.TrimPrefix(args[3], "ChangeOrderID = "), "'")
		return json.Marshal(b.approvals[id])
	}
	b.t.Errorf("unexpected: %s", all)
	return nil, errors.New("unexpected")
}

func (b *fleetBench) watcher(out string) *Watcher {
	opts := watchOpts
	opts.Render = func(c Chart) (Rendering, error) { b.renders++; return fake(c) }
	return NewWatcher(b.run, WatchOptions{
		Context: "mgmt", Out: out, Plan: opts,
		Profiles: parse(b.t, profile("kyverno", watchedProfile)),
		Now:      func() time.Time { return published },
		Script: func(dir, context string) ([]byte, error) {
			b.scripts++
			if context != "mgmt" {
				b.t.Errorf("apply.sh runs against the management cluster watched")
			}
			if b.afterRun != nil {
				b.afterRun()
			}
			return []byte("kyverno waits for approval in stage prod: cub variant approve ...\n"), nil
		},
		Write: func(space string, patch []byte) error {
			var p struct{ Annotations map[string]string }
			_ = json.Unmarshal(patch, &p)
			b.annotated[space] = p.Annotations[JoinAnnotation]
			return nil
		},
	})
}

func fleetClusters(extra string) string {
	return mgmt + cluster("staging-eu", "projectsveltos", "env", "staging", "team", "platform") +
		cluster("prod-eu", "projectsveltos", "env", "prod", "team", "platform") + extra
}

// The watcher proposes a variant for each cluster a profile newly selects,
// approves nothing, and runs apply.sh again only once a person has approved.
func TestWatchProposesAndWaitsForApproval(t *testing.T) {
	b := newBench(t, fleetClusters(cluster("dev-1", "projectsveltos", "env", "dev")))
	out := t.TempDir()
	w := b.watcher(out)

	r, err := w.Once()
	if err != nil || r.Ran || len(r.Joins) != 0 || len(r.Waiting) != 0 {
		t.Fatalf("a settled fleet: nothing proposed, nothing run: %+v %v", r, err)
	}
	if len(r.Unmatched) != 1 || r.Unmatched[0] != "dev-1" {
		t.Errorf("a cluster no profile selects is named, and gets nothing: %v", r.Unmatched)
	}
	renders := b.renders
	if r, _ = w.Once(); len(r.Unmatched) != 0 || b.renders != renders {
		t.Errorf("the same fleet a minute later: dev-1 is named once, and nothing is rendered again")
	}

	b.clusters += cluster("prod-us", "projectsveltos", "env", "prod", "team", "platform")
	joined := mustPlan(t, append(parse(t, profile("kyverno", watchedProfile)), parse(t, b.clusters)...), watchOpts)
	order := "sveltos-kyverno-base/" + joined.Profiles[0].ReleaseOrder
	b.afterRun = func() {
		b.spaces["sveltos-kyverno-prod-us"] = true
		b.orders[order] = "co-2"
	}
	r, err = w.Once()
	if err != nil || !r.Ran || b.scripts != 1 || len(r.Joins) != 1 {
		t.Fatalf("prod-us joined: its variant is proposed, and apply.sh runs: %+v %v", r, err)
	}
	j := r.Joins[0]
	if j.Cluster != "prod-us" || j.Space != "sveltos-kyverno-prod-us" || j.Stage != "prod" || j.Order != order || j.Labels["team"] != "platform" {
		t.Errorf("the join names its cluster, labels, variant, stage and release order: %+v", j)
	}
	if note := b.annotated["sveltos-kyverno-prod-us"]; !strings.Contains(note, `"cluster":"prod-us"`) || !strings.Contains(note, `"team":"platform"`) || !strings.Contains(note, `"profile":"kyverno"`) {
		t.Errorf("the variant's Space records why it was proposed: %s", note)
	}
	script, err := os.ReadFile(filepath.Join(out, "apply.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(script), "--description 'Proposed by cub sveltos watch: prod-us joined (env=prod, team=platform); selected by") {
		t.Errorf("the release order says why it was made")
	}

	// ConfigHub resolves an order that carries no change for a freshly cloned
	// variant, so what waits is read from the releases: prod-us has none.
	if r, _ = w.Once(); r.Ran || len(r.Waiting) != 1 || r.Waiting[0] != order {
		t.Errorf("while the release waits for a person, apply.sh is not run again: %+v", r)
	}
	b.approvals["co-2"] = 3
	b.afterRun = func() { b.released["sveltos-kyverno-prod-us"] = true }
	if r, _ = w.Once(); !r.Ran || b.scripts != 2 {
		t.Errorf("once a person approves, apply.sh runs again, to publish and deliver: %+v", r)
	}
	if r, _ = w.Once(); r.Ran || len(r.Waiting) != 0 {
		t.Errorf("once every variant has a release, the fleet is left alone: %+v", r)
	}
}

func TestWatchRefuses(t *testing.T) {
	joiner := cluster("prod-us", "projectsveltos", "env", "prod", "team", "platform")

	b := newBench(t, fleetClusters(joiner))
	b.live = []string{"kyverno"}
	if _, err := b.watcher(t.TempDir()).Once(); err == nil || !strings.Contains(err.Error(), "handover.sh") || b.scripts != 0 {
		t.Errorf("a profile still live beside the delivery profiles would fight them: %v", err)
	}

	b = newBench(t, fleetClusters(joiner))
	delete(b.spaces, "sveltos-kyverno-base")
	if _, err := b.watcher(t.TempDir()).Once(); err == nil || !strings.Contains(err.Error(), "apply.sh first") {
		t.Errorf("a fleet not onboarded yet is onboarded by a person first: %v", err)
	}

	b = newBench(t, fleetClusters(cluster("qa-1", "projectsveltos", "env", "qa", "team", "platform")))
	if _, err := b.watcher(t.TempDir()).Once(); err == nil || !strings.Contains(err.Error(), "nothing is proposed") || b.scripts != 0 {
		t.Errorf("a cluster the plan cannot place, here in no known stage, stops the proposals: %v", err)
	}
}

// fakeTools puts a cub and a kubectl on the PATH that log what they are asked
// and answer as ConfigHub and the management cluster would: a variant in
// $UNRELEASED has no release yet: its release waits for approval while it
// is in $WAITING, and is published once not. The others have nothing new.
func fakeTools(t *testing.T, dir string) {
	t.Helper()
	cub := `#!/usr/bin/env bash
echo "cub $*" >> "$LOG"
case "$*" in
  "unit get "*) echo 3 ;;
  "unit list "*) echo 99 ;;
  "changeworkflow get "*) echo staging,prod ;;
  "worker get "*UserID*) [ -n "$NO_BOT_USER" ] || echo bot-user ;;
  "worker get "*) echo x ;;
  "target create --help") if [ -n "$OLD_CUB" ]; then echo "      --provider string"; else echo "      --permission strings"; fi ;;
  "release publish "*)
    for s in $WAITING; do [ "$3" = "$s" ] && { echo "Failed: HTTP 422: requires approval: 1 Approval attestation(s) from eligible attesters; kyverno revision 3 has 0 of 1" >&2; exit 1; }; done
    for s in $NEEDS; do [ "$3" = "$s" ] && { echo "Failed: HTTP 422: requires policycheck: 1 PolicyCheck attestation(s) from eligible attesters; kyverno revision 3 has 0 of 1" >&2; exit 1; }; done
    for s in $HELD; do [ "$3" = "$s" ] && { echo "Failed: HTTP 422: outstanding ValidationErrors; triggers re-queued for evaluation" >&2; exit 1; }; done
    for s in $UNRELEASED; do [ "$3" = "$s" ] && { echo "$3" >> "$LOG.published"; exit 0; }; done
    echo "Failed: HTTP 400: no changes were made since :latest bundle" >&2; exit 1 ;;
  "release list "*)
    grep -qx "$4" "$LOG.published" 2>/dev/null && { echo 1; exit 0; }
    for s in $UNRELEASED; do [ "$4" = "$s" ] && { echo 0; exit 0; }; done
    echo 1 ;;
esac
exit 0
`
	kubectl := `#!/usr/bin/env bash
echo "kubectl $*" >> "$LOG"
case "$*" in
  *"get deployment addon-controller"*) echo ghcr.io/projectsveltos/addon-controller:v1.15.0 ;;
  *"apply -f -"*) cat >/dev/null ;;
  *"apply -f management/"*" -l "*) echo "clusterprofile.config.projectsveltos.io/${@: -1} created" ;;
esac
exit 0
`
	for name, text := range map[string]string{"cub": cub, "kubectl": kubectl} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// apply.sh with PROPOSE_ONLY approves nothing: the release of a joining
// cluster waits in its stage, later stages wait behind it, and its delivery
// profile waits for its release.
func TestProposeOnlyApplyScript(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("needs bash")
	}
	fleet := fleetClusters(cluster("prod-us", "projectsveltos", "env", "prod", "team", "platform") + cluster("staging-us", "projectsveltos", "env", "staging", "team", "platform"))
	plan := mustPlan(t, append(parse(t, profile("kyverno", watchedProfile)), parse(t, fleet)...), watchOpts)
	dir := t.TempDir()
	if _, err := WriteApply(plan, dir); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	fakeTools(t, bin)
	order := "sveltos-kyverno-base/" + plan.Profiles[0].ReleaseOrder
	needs, held := "", ""
	run := func(unreleased, waiting string, propose bool) (string, string, error) {
		log := filepath.Join(t.TempDir(), "calls")
		cmd := exec.Command("bash", filepath.Join(dir, "apply.sh"))
		cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "LOG="+log, "UNRELEASED="+unreleased, "WAITING="+waiting, "RETRY_SECONDS=0", "NEEDS="+needs, "HELD="+held)
		if propose {
			cmd.Env = append(cmd.Env, "PROPOSE_ONLY=1")
		}
		out, err := cmd.CombinedOutput()
		calls, _ := os.ReadFile(log)
		return string(out), string(calls), err
	}

	out, calls, err := run("sveltos-kyverno-prod-us", "sveltos-kyverno-prod-us", true)
	if err != nil {
		t.Fatalf("a release waiting for approval is not a failure: %v\n%s", err, out)
	}
	// Targets take the reading identity as permissions, with no worker,
	// provider or parameters.
	// The user is the worker's UserID, not its BridgeWorkerID, and a Target
	// that already exists gets the grant too.
	for _, target := range plan.Targets {
		for _, verb := range []string{"create", "update"} {
			if n := strings.Count(calls, "cub target "+verb+" "+target.Target+" --space sveltos-targets"); n != 1 {
				t.Errorf("one target %s for %s, found %d:\n%s", verb, target.Target, n, calls)
			}
		}
	}
	if !strings.Contains(calls, "cub worker get --space sveltos-targets server-worker -o jq=.BridgeWorker.UserID") ||
		strings.Count(calls, "--permission View:bot-user --permission ViewChildren:bot-user") != 2*len(plan.Targets) || strings.Contains(calls, "--provider") {
		t.Errorf("each Target grants the worker's bot user View and ViewChildren:\n%s", calls)
	}
	if strings.Contains(calls, "cub variant approve") {
		t.Errorf("PROPOSE_ONLY approves nothing")
	}
	if !strings.Contains(out, "sveltos-kyverno-prod-us waits for approval") ||
		!strings.Contains(out, "kyverno waits for approval in stage prod: cub variant approve --change-order "+order+" --stage prod") {
		t.Errorf("the script says what waits, and the command that approves it:\n%s", out)
	}
	if !strings.Contains(calls, "-l sveltos.confighub.com/variant=sveltos-kyverno-prod-eu") || strings.Contains(calls, "variant=sveltos-kyverno-prod-us") ||
		!strings.Contains(out, "sveltos-kyverno-prod-us has no release yet, so its delivery profile waits") {
		t.Errorf("only a variant with a release gets its delivery profile:\n%s", calls)
	}

	_, calls, err = run("sveltos-kyverno-staging-us", "sveltos-kyverno-staging-us", true)
	if err != nil || strings.Contains(calls, "--target-stage prod") {
		t.Errorf("a stage waits behind the stage ahead of it: %v\n%s", err, calls)
	}

	out, calls, err = run("sveltos-kyverno-prod-us", "", false)
	if err != nil || strings.Count(calls, "cub variant approve") != 2 || !strings.Contains(calls, "apply -f management/kyverno.yaml\n") {
		t.Errorf("without PROPOSE_ONLY, the script approves each stage and applies every delivery profile: %v\n%s\n%s", err, out, calls)
	}

	// Approved since: the order may already be resolved, so its promotions
	// have nothing left to do, and the release goes out.
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err != nil || !strings.Contains(calls, "cub release publish sveltos-kyverno-prod-us") || strings.Contains(out, "waits for approval") ||
		!strings.Contains(calls, "-l sveltos.confighub.com/variant=sveltos-kyverno-prod-us") {
		t.Errorf("once approved, the next run publishes and delivers: %v\n%s", err, out)
	}

	t.Setenv("OLD_CUB", "1")
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err == nil || !strings.Contains(out, "cub is older than "+MinimumCub) || strings.Contains(calls, "space create") {
		t.Errorf("a cub whose Targets still take a worker stops the script before it changes anything: %v\n%s", err, out)
	}
	os.Unsetenv("OLD_CUB")

	t.Setenv("NO_BOT_USER", "1")
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err == nil || !strings.Contains(out, "has no bot user") || strings.Contains(calls, "--allow-exists --quiet --permission") {
		t.Errorf("a worker with no bot user stops the script before any Target is made: %v\n%s", err, out)
	}
	os.Unsetenv("NO_BOT_USER")

	out, calls, err = run("", "", true)
	if err != nil || strings.Contains(calls, "changeorder create") || strings.Contains(calls, "release publish") || !strings.Contains(out, "every variant in this plan is released") {
		t.Errorf("with every variant released, no order is made and nothing is published: %v\n%s", err, calls)
	}

	// A stage that also requires a PolicyCheck waits for it, and says how to
	// record one.
	needs = "sveltos-kyverno-prod-us"
	out, _, err = run("sveltos-kyverno-prod-us", "", true)
	if err != nil || !strings.Contains(out, "sveltos-kyverno-prod-us waits for policycheck: cub attestation create --space sveltos-kyverno-prod-us --type PolicyCheck --change-order "+order) {
		t.Errorf("a release waiting for a required attestation names it: %v\n%s", err, out)
	}
	needs = ""

	// A release ConfigHub refuses for ValidationErrors is asked again, since
	// a check may still be running, and then stops the script.
	held = "sveltos-kyverno-prod-us"
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err == nil || strings.Count(calls, "release publish sveltos-kyverno-prod-us") != 3 || !strings.Contains(out, "is held by its policy checks, so it is not released") {
		t.Errorf("a release held by a policy stops the script after three tries: %v\n%s", err, out)
	}
}
