package onboard

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	}
	b.t.Errorf("unexpected: %s", all)
	return nil, errors.New("unexpected")
}

// hub is the ConfigHub half of the bench.
func (b *fleetBench) hub() *fakeHub {
	return &fakeHub{t: b.t,
		spaces: func(where string) ([]HubSpace, error) {
			if where != "" {
				b.t.Errorf("the watcher reads every Space: %q", where)
			}
			var spaces []HubSpace
			for s := range b.spaces {
				spaces = append(spaces, HubSpace{Slug: s})
			}
			return spaces, nil
		},
		released: func(prefix string) ([]string, error) {
			if prefix != "sveltos-" {
				b.t.Errorf("releases are read for the plan's Spaces: %q", prefix)
			}
			var slugs []string
			for s := range b.released {
				slugs = append(slugs, s)
			}
			return slugs, nil
		},
		order: func(space, order string) (HubChangeOrder, error) {
			id, ok := b.orders[space+"/"+order]
			if !ok {
				return HubChangeOrder{}, errors.New("not found")
			}
			return HubChangeOrder{ID: id}, nil
		},
		attestations: func(changeOrderID string) (int, error) {
			return b.approvals[changeOrderID], nil
		},
		patch: func(space string, patch []byte) error {
			var p struct{ Annotations map[string]string }
			_ = json.Unmarshal(patch, &p)
			b.annotated[space] = p.Annotations[JoinAnnotation]
			return nil
		},
	}
}

func (b *fleetBench) watcher(out string) *Watcher {
	opts := watchOpts
	opts.Render = func(c Chart) (Rendering, error) { b.renders++; return fake(c) }
	return NewWatcher(b.run, b.hub(), WatchOptions{
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
  "serviceaccount token create --help") if [ -n "$OLD_CUB" ]; then echo 'unknown command "serviceaccount"'; else echo "      --expires-in duration"; fi ;;
  "serviceaccount token create "*) if [ -n "$NO_TOKEN" ]; then echo null; else echo '"jti-new tok-123"'; fi ;;
  "serviceaccount token list "*) [ -z "$LIST_FAILS" ] || exit 1; echo "${LIVE:-0}" ;;
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
  *"get secret"*'index .data "username"'*) [ -z "$HELD_USER" ] && exit 1; printf '%s' "$HELD_USER" ;;
  *"get secret"*"index .metadata.annotations"*) [ -z "$HELD_USER" ] && exit 1; printf '%s' "${HELD_JTI:-<no value>}" ;;
  *"annotate --local -f -"*) j=""; for a in "$@"; do case "$a" in *token-jti=*) j=${a#*=} ;; esac; done; cat; echo "# token-jti: $j" ;;
  *"get secret -n "*) [ -n "$HELD_USER" ] || exit 1 ;;
  *"apply -f -"*|*"replace -f -"*|*"create -f -"*) [ -z "$APPLY_FAILS" ] || exit 1; cat >> "$LOG.applied" ;;
  *"create secret generic "*)
    name="" user="" pw="" next=""
    for a in "$@"; do
      [ "$next" = 1 ] && { name=$a; next=""; }
      case "$a" in generic) next=1 ;; --from-literal=username=*) user=${a#--from-literal=username=} ;; --from-file=password=*) pw=$(cat "${a#--from-file=password=}") ;; esac
    done
    printf 'kind: Secret\nmetadata:\n  name: %s\ndata:\n  username: %s\n  password: %s\n' "$name" "$(printf '%s' "$user" | base64)" "$(printf '%s' "$pw" | base64)" ;;
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
	needs, held, heldUser, heldJTI, live := "", "", "", "", ""
	var applied string
	run := func(unreleased, waiting string, propose bool) (string, string, error) {
		log := filepath.Join(t.TempDir(), "calls")
		cmd := exec.Command("bash", filepath.Join(dir, "apply.sh"))
		cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "LOG="+log, "UNRELEASED="+unreleased, "WAITING="+waiting, "RETRY_SECONDS=0", "NEEDS="+needs, "HELD="+held,
			"HELD_USER="+heldUser, "HELD_JTI="+heldJTI, "LIVE="+live)
		if propose {
			cmd.Env = append(cmd.Env, "PROPOSE_ONLY=1")
		}
		out, err := cmd.CombinedOutput()
		calls, _ := os.ReadFile(log)
		a, _ := os.ReadFile(log + ".applied")
		applied = string(a)
		return string(out), string(calls), err
	}

	out, calls, err := run("sveltos-kyverno-prod-us", "sveltos-kyverno-prod-us", true)
	if err != nil {
		t.Fatalf("a release waiting for approval is not a failure: %v\n%s", err, out)
	}
	// Targets grant the delivery service account View and ViewChildren, made
	// with update so that a Target that already exists gets the grant too.
	for _, target := range plan.Targets {
		for _, verb := range []string{"create", "update"} {
			if n := strings.Count(calls, "cub target "+verb+" "+target.Target+" --space sveltos-targets"); n != 1 {
				t.Errorf("one target %s for %s, found %d:\n%s", verb, target.Target, n, calls)
			}
		}
	}
	if !strings.Contains(calls, "cub serviceaccount create sveltos-delivery --allow-exists --quiet") ||
		strings.Count(calls, "--permission View:serviceaccount:sveltos-delivery --permission ViewChildren:serviceaccount:sveltos-delivery") != len(plan.Targets) ||
		strings.Contains(calls, "cub worker") {
		t.Errorf("each Target grants the service account sveltos-delivery View and ViewChildren, and no worker is used:\n%s", calls)
	}
	if !strings.Contains(calls, "cub serviceaccount token create sveltos-delivery ") ||
		!strings.Contains(applied, "name: confighub-sveltos-targets") || !strings.Contains(applied, "username: dG9rZW4=") || !strings.Contains(applied, "password: dG9rLTEyMw==") ||
		!strings.Contains(applied, "# token-jti: jti-new") {
		t.Errorf("the gateway Secret holds username token and a token of the service account:\n%s\n%s", calls, applied)
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
		t.Errorf("a cub without service accounts stops the script before it changes anything: %v\n%s", err, out)
	}
	os.Unsetenv("OLD_CUB")

	t.Setenv("NO_TOKEN", "1")
	out, _, err = run("sveltos-kyverno-prod-us", "", true)
	if err == nil || !strings.Contains(out, "could not issue a token for sveltos-delivery") || !strings.Contains(out, "Impersonate") || strings.Contains(applied, "kind: Secret") {
		t.Errorf("no token, no Secret, and the likely reason: %v\n%s", err, out)
	}
	os.Unsetenv("NO_TOKEN")

	heldUser, heldJTI, live = "token", "jti-old", "1"
	_, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err != nil || strings.Contains(calls, "serviceaccount token create sveltos-delivery ") || strings.Contains(applied, "kind: Secret") ||
		!strings.Contains(calls, `select(.Jti == "jti-old"`) {
		t.Errorf("a re-run keeps a token ConfigHub says is live: %v\n%s", err, calls)
	}
	live = "0"
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err != nil || !strings.Contains(calls, "serviceaccount token create sveltos-delivery ") || !strings.Contains(applied, "# token-jti: jti-new") ||
		!strings.Contains(out, "cub serviceaccount token revoke sveltos-delivery jti-old") {
		t.Errorf("a revoked or expired token is replaced, and the old one named: %v\n%s\n%s", err, out, calls)
	}
	// kubectl apply would copy the token into the Secret's last-applied-configuration
	// annotation: an existing Secret is replaced, a new one created.
	if !strings.Contains(calls, "replace -f -") || strings.Contains(calls, "apply -f -") {
		t.Errorf("an existing Secret is replaced, never applied: %v\n%s", err, calls)
	}
	live = "1"
	t.Setenv("ROTATE_TOKEN", "1")
	_, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err != nil || !strings.Contains(calls, "serviceaccount token create sveltos-delivery ") {
		t.Errorf("ROTATE_TOKEN issues a new token even while the old one is live: %v\n%s", err, calls)
	}
	os.Unsetenv("ROTATE_TOKEN")
	t.Setenv("LIST_FAILS", "1")
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err != nil || strings.Contains(calls, "serviceaccount token create sveltos-delivery ") || !strings.Contains(out, "the Secret keeps it") {
		t.Errorf("when ConfigHub cannot be asked, the Secret keeps its token: %v\n%s", err, out)
	}
	os.Unsetenv("LIST_FAILS")
	heldUser, heldJTI = "6f1c9a40-worker-id", ""
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err != nil || !strings.Contains(calls, "serviceaccount token create sveltos-delivery ") ||
		!strings.Contains(out, "delete it, once Sveltos has fetched with the token: cub worker delete --space sveltos-targets server-worker") {
		t.Errorf("a Secret holding a worker's credential is replaced, and the old worker named: %v\n%s", err, out)
	}
	heldUser, live = "", ""
	t.Setenv("APPLY_FAILS", "1")
	out, calls, err = run("sveltos-kyverno-prod-us", "", true)
	if err == nil || !strings.Contains(calls, "create -f -") || strings.Contains(calls, "apply -f -") ||
		!strings.Contains(calls, "cub serviceaccount token revoke sveltos-delivery jti-new") || !strings.Contains(out, "the token issued for it is revoked") {
		t.Errorf("a token issued for a Secret that could not be written is revoked: %v\n%s\n%s", err, out, calls)
	}
	os.Unsetenv("APPLY_FAILS")

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

// apply.sh asks cub's jq whether the token a Secret holds is still live, and
// reads a new token's jti. cub v0.9.0 and later wrap each token as
// {UserToken: ...}; earlier ones do not. Both shapes must work, with jq.
func TestTokenExpressionsReadBothShapes(t *testing.T) {
	jq, err := exec.LookPath("jq")
	if err != nil {
		t.Skip("needs jq")
	}
	run := func(filter, input string) string {
		cmd := exec.Command(jq, "-r", filter)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("jq %s: %v", filter, err)
		}
		return strings.TrimSpace(string(out))
	}
	live := strings.ReplaceAll(liveTokenJQ, `\"$jti\"`, `"j-1"`)
	for name, c := range map[string]struct{ list, want string }{
		"v0.9 shape, live":          {`[{"UserToken":{"Jti":"j-1","RevokedAt":null,"ExpiresAt":null}}]`, "1"},
		"v0.8 shape, live":          {`[{"Jti":"j-1","RevokedAt":null}]`, "1"},
		"revoked":                   {`[{"UserToken":{"Jti":"j-1","RevokedAt":"2026-10-26T08:18:25Z"}}]`, "0"},
		"expired":                   {`[{"Jti":"j-1","ExpiresAt":"2020-01-01T00:00:00Z"}]`, "0"},
		"expires later":             {`[{"UserToken":{"Jti":"j-1","ExpiresAt":"2999-01-01T00:00:00.123456Z"}}]`, "1"},
		"another token":             {`[{"UserToken":{"Jti":"j-2"}}]`, "0"},
		"an account with no tokens": {`[]`, "0"},
	} {
		if got := run(live, c.list); got != c.want {
			t.Errorf("%s: %s gives %s, want %s", name, c.list, got, c.want)
		}
	}
	script := ApplyScript(mustPlan(t, exampleDocs(t), exampleOpts))
	m := regexp.MustCompile(`token create [^\n]*-o 'jq=([^']*)'`).FindStringSubmatch(script)
	if m == nil {
		t.Fatalf("no token create -o jq in apply.sh")
	}
	for issued, want := range map[string]string{
		`{"UserToken":{"Jti":"j-9"},"Token":"tok"}`: "j-9 tok",
		`{"Jti":"j-9","Token":"tok"}`:               "j-9 tok",
		`{"Token":"tok"}`:                           " tok",
	} {
		cmd := exec.Command(jq, "-r", m[1])
		cmd.Stdin = strings.NewReader(issued)
		out, err := cmd.Output()
		if got := strings.TrimSuffix(string(out), "\n"); err != nil || got != want {
			t.Errorf("issued %s reads as %q, want %q", issued, got, want)
		}
	}
}
