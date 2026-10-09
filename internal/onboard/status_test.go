package onboard

import (
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var (
	published = time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)
	later     = published.Add(90 * time.Second)
	earlier   = published.Add(-time.Hour)
)

func summary(features ...map[string]any) map[string]any {
	fs := make([]any, len(features))
	for i, f := range features {
		fs[i] = f
	}
	return map[string]any{
		"spec":   map[string]any{"clusterName": "prod-eu"},
		"status": map[string]any{"featureSummaries": fs, "deployedGVKs": []any{map[string]any{"deployedGroupVersionKind": []any{"Deployment.v1.apps"}}}},
	}
}

func feature(status string, applied time.Time, failure string) map[string]any {
	f := map[string]any{"featureID": "Resources", "status": status}
	if !applied.IsZero() {
		f["lastAppliedTime"] = applied.Format(time.RFC3339)
	}
	if failure != "" {
		f["failureMessage"] = failure
	}
	return f
}

// What Sveltos reports, in ConfigHub's words, as a reading of the newest
// published release: the Healthy gate passes only on Synced and Healthy with
// no operation running or failed.
func TestLiveStatus(t *testing.T) {
	two := []release{{num: 1, digest: "sha256:one", createdAt: earlier}, {num: 2, digest: "sha256:two", createdAt: published}}
	now := later.Add(time.Minute)
	for _, c := range []struct {
		name                           string
		summary                        map[string]any
		releases                       []release
		checked                        bool
		sync, health, op, sveltos, msg string
		running                        int
	}{
		{"applied after the latest release, checked", summary(feature("Provisioned", later, "")), two, true, "Synced", "Healthy", "Succeeded", "Provisioned", "release 2 applied", 2},
		{"applied before the latest release", summary(feature("Provisioned", published.Add(-time.Minute), "")), two, true, "OutOfSync", "Progressing", "Running", "Provisioned", "release 2, created 2026-09-28T10:00:00Z, not applied yet; the cluster runs release 1", 1},
		{"applied before any release", summary(feature("Provisioned", earlier.Add(-time.Minute), "")), two, true, "OutOfSync", "Progressing", "Running", "Provisioned", "release 2, created 2026-09-28T10:00:00Z, not applied yet", 0},
		{"still deploying", summary(feature("Provisioning", time.Time{}, "")), two, true, "OutOfSync", "Progressing", "Running", "Provisioning", "Sveltos: Provisioning", 0},
		{"failed", summary(feature("Failed", time.Time{}, "GVK nvidia.com/v1, Kind=ClusterPolicy not found")), two, true, "OutOfSync", "Degraded", "Failed", "Failed", "Sveltos: Failed: GVK nvidia.com/v1, Kind=ClusterPolicy not found", 0},
		{"no summary yet", nil, two, true, "Unknown", "Unknown", "", "", "Sveltos has not deployed this profile yet", 0},
		{"applied, but no health checks", summary(feature("Provisioned", later, "")), two, false, "Synced", "Unknown", "Succeeded", "Provisioned", "release 2 applied; this delivery profile has no health checks, so Sveltos does not wait for its workloads", 2},
		{"no release published", summary(feature("Provisioned", later, "")), nil, true, "Unknown", "Unknown", "", "Provisioned", "the variant has no published release", 0},
	} {
		s, running := liveStatus("kyverno-prod-eu", c.summary, c.releases, c.checked, 90*time.Second, now)
		if s.Sync != c.sync || s.Health != c.health || s.Operation != c.op || s.ReporterSync != c.sveltos || s.Message != c.msg {
			t.Errorf("%s: got %s/%s/%s %q %q", c.name, s.Sync, s.Health, s.Operation, s.ReporterSync, s.Message)
		}
		got := 0
		if running != nil {
			got = running.num
		}
		if got != c.running {
			t.Errorf("%s: the release Sveltos is taken to run: %d, want %d", c.name, got, c.running)
		}
		if s.Reporter != "cub-sveltos" || s.DataSource != "kyverno-prod-eu" || s.ObservedAt != now.Format(time.RFC3339) {
			t.Errorf("%s: every reading names its reporter, its profile and when it was made: %+v", c.name, s)
		}
		if len(s.Message) > 1024 || len(s.ReporterSync) > 64 {
			t.Errorf("%s: the reading must fit what a release holds: %+v", c.name, s)
		}
	}
	if s, _ := liveStatus("p", summary(feature("Failed", time.Time{}, strings.Repeat("x", 2000))), two, true, 90*time.Second, now); len(s.Message) > 400 {
		t.Errorf("a long failure message is clipped")
	}
	if s, _ := liveStatus("p", summary(feature("Failed", time.Time{}, strings.Repeat("é", 2000))), two, true, 90*time.Second, now); !utf8.ValidString(s.Message) {
		t.Errorf("a long message is cut on a character, not inside one: %q", s.Message[len(s.Message)-8:])
	}
	// Sveltos stamps when it finished applying, not when it fetched. Release 2
	// was published while it was still applying release 1, and it finished 30
	// seconds later: the stamp is after release 2 was created, and release 2
	// is not what it applied. Until Sveltos has had its interval to fetch it,
	// the newest release is not called applied.
	soon := summary(feature("Provisioned", published.Add(30*time.Second), ""))
	s, running := liveStatus("p", soon, two, true, 90*time.Second, published.Add(time.Minute))
	if s.Sync != "OutOfSync" || s.Operation != "Running" || running != nil ||
		s.Message != "release 2, created 2026-09-28T10:00:00Z, is too new to tell from the one before: Sveltos fetches every 1m0s" {
		t.Errorf("a release newer than the fetch interval is not called applied yet: %+v %+v", s, running)
	}
	if s, running := liveStatus("p", soon, two, true, 90*time.Second, published.Add(2*time.Minute)); s.Sync != "Synced" || running == nil || running.num != 2 {
		t.Errorf("once it is older than that, and Sveltos still says it applied after, it is applied: %+v", s)
	}
	profile := map[string]any{"spec": map[string]any{"policyRefs": []any{
		map[string]any{"remoteURL": map[string]any{"url": "oci://oci.hub.confighub.com/space/other:latest", "interval": "10m"}},
		map[string]any{"remoteURL": map[string]any{"url": "oci://oci.hub.confighub.com/space/mine:latest", "interval": "5m0s"}}}}}
	if d := settleAfter(profile, "mine"); d != 5*time.Minute+30*time.Second {
		t.Errorf("the settle time follows the interval the profile fetches this Space at: %s", d)
	}
	if d := settleAfter(map[string]any{}, "mine"); d != 90*time.Second {
		t.Errorf("a profile that names no interval is given a minute: %s", d)
	}
}

// ReportStatus reads the management cluster and ConfigHub, and records a
// reading on the newest published release only when it changes or the one the
// release holds has gone stale.
func TestReportStatus(t *testing.T) {
	profiles := `{"items":[
	  {"metadata":{"name":"kyverno-prod-eu"},"spec":{"validateHealths":[{"name":"deployments-kyverno"}],"policyRefs":[{"deploymentType":"Remote","remoteURL":{"url":"oci://oci.hub.confighub.com/space/sveltos-kyverno-prod-eu:latest"}}]}},
	  {"metadata":{"name":"hand-made"},"spec":{"policyRefs":[{"kind":"ConfigMap","name":"x","namespace":"default"}]}}]}`
	summaries := `{"items":[{"metadata":{"labels":{"projectsveltos.io/cluster-profile-name":"kyverno-prod-eu"}},"spec":{"clusterNamespace":"projectsveltos","clusterName":"prod-eu"},
	  "status":{"featureSummaries":[{"featureID":"Resources","status":"Provisioned","lastAppliedTime":"` + later.Format(time.RFC3339) + `"}]}}]}`
	releases := []HubRelease{{Num: 1, Published: true, Current: true, Digest: "sha256:one", CreatedAt: published}, {Num: 2, Current: true, Digest: "sha256:draft", CreatedAt: later}}
	watching := `{"items":[]}`
	run := func(name string, args ...string) ([]byte, error) {
		all := name + " " + strings.Join(args, " ")
		switch {
		case all == "kubectl --context mgmt get clusterhealthchecks -o json":
			return []byte(watching), nil
		case strings.HasPrefix(all, "kubectl --context mgmt get clusterprofiles"):
			return []byte(profiles), nil
		case strings.HasPrefix(all, "kubectl --context mgmt get clustersummaries"):
			return []byte(summaries), nil
		}
		t.Errorf("unexpected: %s", all)
		return nil, errors.New("unexpected")
	}
	type write struct {
		release int
		status  LiveStatus
	}
	var writes []write
	annotations := map[string]string{LegacyLiveStatusAnnotation: `{"source":"sveltos","syncStatus":"Synced"}`, "kept": "yes"}
	var patches []string
	now := later.Add(time.Minute)
	opts := StatusOptions{Context: "mgmt", Refresh: 10 * time.Minute, Now: func() time.Time { return now }}
	hub := &fakeHub{t: t,
		releases: func(space string) ([]HubRelease, error) {
			if space != "sveltos-kyverno-prod-eu" {
				t.Errorf("releases are read for the Space the profile fetches from: %s", space)
			}
			return releases, nil
		},
		setLive: func(space string, release int, s LiveStatus) error {
			if space != "sveltos-kyverno-prod-eu" {
				t.Errorf("the reading is recorded in the variant's Space: %s", space)
			}
			writes = append(writes, write{release, s})
			for i := range releases {
				if releases[i].Num == release {
					held := s
					releases[i].Live = &held
				}
			}
			return nil
		},
		space: func(space string) (HubSpace, error) {
			return HubSpace{Slug: space, Annotations: annotations}, nil
		},
		patch: func(space string, patch []byte) error {
			patches = append(patches, string(patch))
			delete(annotations, LegacyLiveStatusAnnotation)
			return nil
		}}

	reports, err := ReportStatus(run, hub, opts)
	if err != nil || len(reports) != 1 || !reports[0].Wrote || reports[0].Cluster != "prod-eu" {
		t.Fatalf("one delivery profile, reported and written; a profile not from ConfigHub is left alone: %+v %v", reports, err)
	}
	// Release 2 is a draft: release 1 is the newest published one, the one
	// the gate reads.
	if w := writes[0]; w.release != 1 || w.status.Sync != "Synced" || w.status.Health != "Healthy" || w.status.Operation != "Succeeded" || w.status.Message != "release 1 applied" {
		t.Errorf("the reading written: %+v", w)
	}
	if r := reports[0]; r.Release != 1 || r.Running != 1 || r.Revision != "sha256:one" {
		t.Errorf("the report names the release recorded on and the one running: %+v", r)
	}
	if len(patches) != 1 || patches[0] != `{"Annotations":{"confighub.com/live-status":null}}` {
		t.Errorf("the reading an earlier version left on the Space is removed, and nothing else: %v", patches)
	}

	now = now.Add(time.Minute)
	reports, _ = ReportStatus(run, hub, opts)
	if reports[0].Wrote || reports[0].Why != "unchanged" || len(writes) != 1 {
		t.Errorf("the same reading a minute later is not written again: %+v", reports[0])
	}
	now = now.Add(15 * time.Minute)
	if reports, _ = ReportStatus(run, hub, opts); !reports[0].Wrote || len(patches) != 1 {
		t.Errorf("an unchanged reading is written again once the one held is older than --refresh, and the Space is not patched twice: %+v %v", reports[0], patches)
	}
	// The profile's ClusterHealthCheck sees a workload go down after the
	// release was applied, and Sveltos still says Provisioned.
	watching = `{"items":[{"metadata":{"name":"sveltos-kyverno","labels":{"` + ProfileLabel + `":"kyverno"}},"status":{"clusterCondition":[
	  {"clusterInfo":{"cluster":{"namespace":"projectsveltos","name":"prod-eu"}},"conditions":[{"type":"HealthCheck:workloads","name":"workloads","status":"False","lastTransitionTime":"` + later.Add(time.Minute).Format(time.RFC3339) + `",
	   "message":"Deployment: kyverno/kyverno-cleanup-controller status is Degraded  \nMessage: kyverno-cleanup-controller: 0 of 1 available  \n"}]},
	  {"clusterInfo":{"cluster":{"namespace":"projectsveltos","name":"prod-us"}},"conditions":[{"type":"HealthCheck:workloads","name":"workloads","status":"True"}]}]}}]}`
	reports, _ = ReportStatus(run, hub, opts)
	if s := reports[0].Status; s.Sync != "Synced" || s.Health != "Degraded" ||
		s.Message != "ClusterHealthCheck sveltos-kyverno: Deployment: kyverno/kyverno-cleanup-controller status is Degraded Message: kyverno-cleanup-controller: 0 of 1 available" {
		t.Errorf("a workload down after the release is Degraded, naming it, and the release still Synced: %+v", s)
	}
	if w := writes[len(writes)-1]; w.release != 1 || w.status.Health != "Degraded" {
		t.Errorf("the Degraded reading replaces the Healthy one on the release the gate reads: %+v", w)
	}
	watching = `{"items":[]}`

	// A newer release is published: the reading is now of that one, and says
	// it is not applied yet. Release 1 keeps what was true of it.
	releases[1].Published, releases[1].CreatedAt = true, later.Add(30*time.Second)
	n := len(writes)
	reports, _ = ReportStatus(run, hub, opts)
	if w := writes[len(writes)-1]; len(writes) != n+1 || w.release != 2 || w.status.Sync != "OutOfSync" || w.status.Operation != "Running" || reports[0].Running != 1 {
		t.Errorf("a newly published release gets its own reading, not release 1's: %+v %+v", w, reports[0])
	}

	// Another reporter's reading is left alone while it is fresh, and while
	// it says the same; it is replaced once it is old and says otherwise.
	theirs := LiveStatus{Reporter: "argobot", Sync: "Synced", Health: "Healthy", Operation: "Succeeded", ObservedAt: now.Format(time.RFC3339)}
	releases[1].Live = &theirs
	n = len(writes)
	if reports, _ = ReportStatus(run, hub, opts); reports[0].Wrote || reports[0].Why != "left to argobot" || len(writes) != n {
		t.Errorf("a fresh reading from another reporter is left alone: %+v", reports[0])
	}
	now = now.Add(time.Hour)
	if reports, _ = ReportStatus(run, hub, opts); !reports[0].Wrote || releases[1].Live.Reporter != "cub-sveltos" {
		t.Errorf("an old reading from another reporter that says otherwise is replaced: %+v", reports[0])
	}

	opts.DryRun = true
	summaries = strings.Replace(summaries, `"Provisioned"`, `"Provisioning"`, 1)
	n = len(writes)
	if reports, _ = ReportStatus(run, hub, opts); reports[0].Wrote || reports[0].Why != "dry run" || reports[0].Status.Message != "Sveltos: Provisioning" || len(writes) != n {
		t.Errorf("a dry run reports a changed reading, and writes nothing: %+v", reports[0])
	}
	opts.DryRun = false

	// A release published for a Target the Space has since moved away from is
	// not what ConfigHub serves or its gate reads, however new it is.
	releases = append(releases, HubRelease{Num: 3, Published: true, Digest: "sha256:elsewhere", CreatedAt: later.Add(time.Minute)})
	if reports, _ = ReportStatus(run, hub, opts); reports[0].Release != 2 {
		t.Errorf("the reading stays on the newest release for the Space's own Target: %+v", reports[0])
	}

	// A Space with no published release has nowhere to record a reading.
	releases = []HubRelease{{Num: 1, Current: true, Digest: "sha256:draft", CreatedAt: published}}
	n = len(writes)
	if reports, err = ReportStatus(run, hub, opts); err != nil || reports[0].Wrote || reports[0].Why != "no release" || reports[0].Release != 0 || len(writes) != n {
		t.Errorf("no published release: nothing is written, and it is no error: %+v %v", reports[0], err)
	}
}

// One Space that cannot be read or written does not stop the others being
// reported.
func TestReportStatusCarriesOn(t *testing.T) {
	profile := func(space string) string {
		return `{"metadata":{"name":"` + space + `"},"spec":{"validateHealths":[{"name":"x"}],"policyRefs":[{"remoteURL":{"url":"oci://oci.hub.confighub.com/space/` + space + `:latest"}}]}}`
	}
	sum := func(space string) string {
		return `{"metadata":{"labels":{"projectsveltos.io/cluster-profile-name":"` + space + `"}},"spec":{"clusterNamespace":"projectsveltos","clusterName":"c-` + space + `"},
		  "status":{"featureSummaries":[{"featureID":"Resources","status":"Provisioned","lastAppliedTime":"` + later.Format(time.RFC3339) + `"}]}}`
	}
	run := func(name string, args ...string) ([]byte, error) {
		all := name + " " + strings.Join(args, " ")
		switch {
		case strings.Contains(all, "get clusterhealthchecks"):
			return []byte(`{"items":[]}`), nil
		case strings.Contains(all, "get clusterprofiles"):
			return []byte(`{"items":[` + profile("a-gone") + `,` + profile("b-denied") + `,` + profile("c-fine") + `]}`), nil
		case strings.Contains(all, "get clustersummaries"):
			return []byte(`{"items":[` + sum("a-gone") + `,` + sum("b-denied") + `,` + sum("c-fine") + `]}`), nil
		}
		return nil, errors.New("unexpected")
	}
	var wrote []string
	hub := &fakeHub{t: t,
		releases: func(space string) ([]HubRelease, error) {
			if space == "a-gone" {
				return nil, errors.New("space not found")
			}
			return []HubRelease{{Num: 1, Published: true, Current: true, Digest: "sha256:one", CreatedAt: published}}, nil
		},
		setLive: func(space string, release int, s LiveStatus) error {
			if space == "b-denied" {
				return errors.New("HTTP 403: permission denied\nDetails:\n  failed to update entity\n")
			}
			wrote = append(wrote, space)
			return nil
		},
		space: func(space string) (HubSpace, error) {
			return HubSpace{Slug: space, Annotations: map[string]string{LegacyLiveStatusAnnotation: "{}"}}, nil
		},
		patch: func(space string, patch []byte) error { return errors.New("HTTP 403: permission denied") },
	}
	now := later.Add(time.Minute)
	reports, err := ReportStatus(run, hub, StatusOptions{Refresh: 10 * time.Minute, Now: func() time.Time { return now }})
	if err == nil || !strings.Contains(err.Error(), "a-gone: space not found") || !strings.Contains(err.Error(), "b-denied: recording the live status of release 1, which takes EditChildren on the Space or on its Target: HTTP 403: permission denied Details: failed to update entity") {
		t.Errorf("each Space that failed is named, with why: %v", err)
	}
	if len(wrote) != 1 || wrote[0] != "c-fine" {
		t.Errorf("the Space after the two that failed is still written: %v", wrote)
	}
	if len(reports) != 2 || reports[0].Space != "b-denied" || reports[0].Wrote || reports[0].Why != "failed" || !reports[1].Wrote {
		t.Errorf("the readings taken are still reported: %+v", reports)
	}
	// c-fine's reading is recorded; the old annotation it may not remove is
	// something to say, and no failure.
	if strings.Contains(err.Error(), "c-fine") || !strings.Contains(reports[1].Note, "c-fine still holds the annotation confighub.com/live-status") || !strings.Contains(reports[1].Note, "takes Edit on the Space") {
		t.Errorf("an annotation that cannot be removed is a note: %q; %v", reports[1].Note, err)
	}
	if reports[0].Note != "" {
		t.Errorf("nothing is tidied in a Space whose reading was not recorded: %q", reports[0].Note)
	}
}

// The continuous check speaks for health only once the latest release is
// applied, fills in health a profile without apply-time checks lacks, tells a
// rollout from a failure, and ignores a failure older than the release.
func TestWatchApply(t *testing.T) {
	applied := later
	cond := func(status, message string, at time.Time) watch {
		return watch{check: "c", conditions: []any{map[string]any{"type": "HealthCheck:workloads", "status": status, "message": message, "lastTransitionTime": at.Format(time.RFC3339)}}}
	}
	after, before := applied.Add(time.Minute), applied.Add(-time.Minute)
	if s := cond("False", "", after).apply(LiveStatus{Sync: "OutOfSync", Health: "Progressing"}, applied); s.Health != "Progressing" {
		t.Errorf("while a release is on its way, Sveltos's reading stands: %+v", s)
	}
	if s := cond("False", "", after).apply(LiveStatus{Sync: "Synced", Health: "Healthy"}, applied); s.Health != "Degraded" || s.Message != "ClusterHealthCheck c: a workload is not healthy" {
		t.Errorf("a failing check with no message still says so: %+v", s)
	}
	if s := cond("False", "Deployment: kyverno/x status is Progressing Message: x: rolling out", after).apply(LiveStatus{Sync: "Synced", Health: "Healthy"}, applied); s.Health != "Progressing" {
		t.Errorf("a workload rolling out is Progressing, not Degraded: %+v", s)
	}
	if s := cond("False", "old news", before).apply(LiveStatus{Sync: "Synced", Health: "Healthy"}, applied); s.Health != "Healthy" {
		t.Errorf("a failure seen before the release was applied is stale: %+v", s)
	}
	if s := cond("True", "", after).apply(LiveStatus{Sync: "Synced", Health: "Unknown"}, applied); s.Health != "Healthy" || s.Message != "watched by ClusterHealthCheck c" {
		t.Errorf("a profile without apply-time checks is healthy when its continuous check passes: %+v", s)
	}
	if s := (watch{check: "c"}).apply(LiveStatus{Sync: "Synced", Health: "Unknown"}, applied); s.Health != "Unknown" {
		t.Errorf("a check that has not evaluated yet says nothing: %+v", s)
	}
	w := map[string]map[string]watch{"kyverno": {}, "kyverno-extra": {}}
	if p := watchingProfile(w, "kyverno-extra-projectsveltos-prod"); p != "kyverno-extra" {
		t.Errorf("the longest profile name that prefixes a delivery profile is its profile: %q", p)
	}
}

// A profile's continuous check names its workloads and selects its clusters by
// its own labels; one that names clusters by clusterRefs is checked everywhere.
func TestContinuousHealth(t *testing.T) {
	units := []Unit{{Objects: []Object{
		{Kind: "Deployment", APIVersion: "apps/v1", Namespace: "kyverno", Name: "kyverno-admission-controller", Value: map[string]any{}},
		{Kind: "Service", APIVersion: "v1", Namespace: "kyverno", Name: "svc", Value: map[string]any{}},
	}}}
	docs := continuousHealth(Profile{Name: "kyverno", Component: "mer-kyverno", Units: units,
		Clusters: classSelector(map[string]any{"matchLabels": map[string]any{"region": "eu"}}, "class", []string{"test", "prod"})})
	if len(docs) != 2 {
		t.Fatalf("a HealthCheck and a ClusterHealthCheck: %d", len(docs))
	}
	out, _ := EncodeYAML(docs[0], docs[1])
	text := string(out)
	for _, want := range []string{"kind: HealthCheck", `["Deployment/kyverno/kyverno-admission-controller"] = true`, "status = status, message = message",
		"kind: ClusterHealthCheck", "region: eu", "key: class", "operator: In", "- test", "- prod", ProfileLabel + ": kyverno", "type: KubernetesEvent"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "svc") {
		t.Errorf("only workloads are watched:\n%s", text)
	}
	docs = continuousHealth(Profile{Name: "kyverno", Component: "mer-kyverno", Units: units})
	out, _ = EncodeYAML(docs[1])
	if !strings.Contains(string(out), "key: projectsveltos.io/k8s-version") || !strings.Contains(string(out), "operator: Exists") {
		t.Errorf("a profile addressed by clusterRefs is checked on every cluster Sveltos manages:\n%s", out)
	}
	if continuousHealth(Profile{Name: "policies", Units: []Unit{{Objects: []Object{{Kind: "ConfigMap", APIVersion: "v1", Name: "x"}}}}}) != nil {
		t.Errorf("a profile that delivers no workloads has nothing to watch")
	}
}
