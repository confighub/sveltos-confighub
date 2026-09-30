package onboard

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
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

// What Sveltos reports, in ConfigHub's words: the healthy gate passes only on
// Synced, Succeeded and Healthy, and a revision naming the release applied.
func TestLiveStatus(t *testing.T) {
	two := []release{{1, "sha256:one", earlier}, {2, "sha256:two", published}}
	now := later.Add(time.Minute)
	for _, c := range []struct {
		name                               string
		summary                            map[string]any
		releases                           []release
		checked                            bool
		sync, health, phase, revision, msg string
	}{
		{"applied after the latest release, checked", summary(feature("Provisioned", later, "")), two, true, "Synced", "Healthy", "Succeeded", "sha256:two", ""},
		{"applied before the latest release", summary(feature("Provisioned", published.Add(-time.Minute), "")), two, true, "OutOfSync", "Progressing", "Running", "sha256:one", "release 2, created 2026-09-28T10:00:00Z, not applied yet"},
		{"still deploying", summary(feature("Provisioning", time.Time{}, "")), two, true, "OutOfSync", "Progressing", "Running", "", "Sveltos: Provisioning"},
		{"failed", summary(feature("Failed", time.Time{}, "GVK nvidia.com/v1, Kind=ClusterPolicy not found")), two, true, "OutOfSync", "Degraded", "Failed", "", "Sveltos: Failed: GVK nvidia.com/v1, Kind=ClusterPolicy not found"},
		{"no summary yet", nil, two, true, "Unknown", "Unknown", "", "", "Sveltos has not deployed this profile yet"},
		{"applied, but no health checks", summary(feature("Provisioned", later, "")), two, false, "Synced", "Unknown", "Succeeded", "sha256:two", "applied; this delivery profile has no health checks, so Sveltos does not wait for its workloads"},
		{"no release published", summary(feature("Provisioned", later, "")), nil, true, "Unknown", "Unknown", "", "", "the variant has no published release"},
	} {
		s := liveStatus("kyverno-prod-eu", c.summary, c.releases, c.checked, now)
		if s.SyncStatus != c.sync || s.HealthStatus != c.health || s.OperationPhase != c.phase || s.Revision != c.revision || s.Message != c.msg {
			t.Errorf("%s: got %s/%s/%s %q %q", c.name, s.SyncStatus, s.HealthStatus, s.OperationPhase, s.Revision, s.Message)
		}
		if s.Source != "sveltos" || s.App != "kyverno-prod-eu" || s.ObservedAt != now.Format(time.RFC3339) {
			t.Errorf("%s: every reading names its source, its profile and when it was made: %+v", c.name, s)
		}
		if doc, _ := json.Marshal(s); len(doc) > 1024 {
			t.Errorf("%s: the reading must fit the annotation's 1024 bytes", c.name)
		}
	}
	if s := liveStatus("p", summary(feature("Failed", time.Time{}, strings.Repeat("x", 2000))), two, true, now); len(s.Message) > 400 {
		t.Errorf("a long failure message is clipped")
	}
}

// ReportStatus reads the management cluster and ConfigHub, and writes a
// reading only when it changes or the one ConfigHub holds has gone stale.
func TestReportStatus(t *testing.T) {
	profiles := `{"items":[
	  {"metadata":{"name":"kyverno-prod-eu"},"spec":{"validateHealths":[{"name":"deployments-kyverno"}],"policyRefs":[{"deploymentType":"Remote","remoteURL":{"url":"oci://oci.hub.confighub.com/space/sveltos-kyverno-prod-eu:latest"}}]}},
	  {"metadata":{"name":"hand-made"},"spec":{"policyRefs":[{"kind":"ConfigMap","name":"x","namespace":"default"}]}}]}`
	summaries := `{"items":[{"metadata":{"labels":{"projectsveltos.io/cluster-profile-name":"kyverno-prod-eu"}},"spec":{"clusterNamespace":"projectsveltos","clusterName":"prod-eu"},
	  "status":{"featureSummaries":[{"featureID":"Resources","status":"Provisioned","lastAppliedTime":"` + later.Format(time.RFC3339) + `"}]}}]}`
	releases := `[{"Release":{"ReleaseNum":1,"Published":true,"ManifestDigest":"sha256:one","CreatedAt":"` + published.Format(time.RFC3339Nano) + `"}}]`
	held := ""
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
		case all == "cub release list --space sveltos-kyverno-prod-eu -o json":
			return []byte(releases), nil
		case all == "cub space get sveltos-kyverno-prod-eu -o json":
			doc, _ := json.Marshal(map[string]any{"Space": map[string]any{"Annotations": map[string]string{LiveStatusAnnotation: held}}})
			return doc, nil
		}
		t.Errorf("unexpected: %s", all)
		return nil, errors.New("unexpected")
	}
	var writes []string
	now := later.Add(time.Minute)
	opts := StatusOptions{Context: "mgmt", Refresh: 10 * time.Minute, Now: func() time.Time { return now },
		Write: func(space string, patch []byte) error {
			var p struct{ Annotations map[string]string }
			if err := json.Unmarshal(patch, &p); err != nil {
				t.Fatal(err)
			}
			held = p.Annotations[LiveStatusAnnotation]
			writes = append(writes, space+" "+held)
			return nil
		}}

	reports, err := ReportStatus(run, opts)
	if err != nil || len(reports) != 1 || !reports[0].Wrote || reports[0].Cluster != "prod-eu" {
		t.Fatalf("one delivery profile, reported and written; a profile not from ConfigHub is left alone: %+v %v", reports, err)
	}
	if !strings.Contains(writes[0], `"syncStatus":"Synced"`) || !strings.Contains(writes[0], `"healthStatus":"Healthy"`) || !strings.Contains(writes[0], `"revision":"sha256:one"`) {
		t.Errorf("the reading written: %s", writes[0])
	}

	now = now.Add(time.Minute)
	reports, _ = ReportStatus(run, opts)
	if reports[0].Wrote || reports[0].Why != "unchanged" || len(writes) != 1 {
		t.Errorf("the same reading a minute later is not written again: %+v", reports[0])
	}
	now = now.Add(15 * time.Minute)
	if reports, _ = ReportStatus(run, opts); !reports[0].Wrote {
		t.Errorf("an unchanged reading is written again once the one held is older than --refresh")
	}
	// The profile's ClusterHealthCheck sees a workload go down after the
	// release was applied, and Sveltos still says Provisioned.
	watching = `{"items":[{"metadata":{"name":"sveltos-kyverno","labels":{"` + ProfileLabel + `":"kyverno"}},"status":{"clusterCondition":[
	  {"clusterInfo":{"cluster":{"namespace":"projectsveltos","name":"prod-eu"}},"conditions":[{"type":"HealthCheck:workloads","name":"workloads","status":"False","lastTransitionTime":"` + later.Add(time.Minute).Format(time.RFC3339) + `",
	   "message":"Deployment: kyverno/kyverno-cleanup-controller status is Degraded  \nMessage: kyverno-cleanup-controller: 0 of 1 available  \n"}]},
	  {"clusterInfo":{"cluster":{"namespace":"projectsveltos","name":"prod-us"}},"conditions":[{"type":"HealthCheck:workloads","name":"workloads","status":"True"}]}]}}]}`
	reports, _ = ReportStatus(run, opts)
	if s := reports[0].Status; s.SyncStatus != "Synced" || s.HealthStatus != "Degraded" ||
		s.Message != "ClusterHealthCheck sveltos-kyverno: Deployment: kyverno/kyverno-cleanup-controller status is Degraded Message: kyverno-cleanup-controller: 0 of 1 available" {
		t.Errorf("a workload down after the release is Degraded, naming it, and the release still Synced: %+v", s)
	}

	opts.DryRun = true
	summaries = strings.Replace(summaries, `"Provisioned"`, `"Provisioning"`, 1)
	if reports, _ = ReportStatus(run, opts); reports[0].Wrote || reports[0].Why != "dry run" || reports[0].Status.SyncStatus != "OutOfSync" {
		t.Errorf("a dry run reports a changed reading, and writes nothing: %+v", reports[0])
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
	if s := cond("False", "", after).apply(LiveStatus{SyncStatus: "OutOfSync", HealthStatus: "Progressing"}, applied); s.HealthStatus != "Progressing" {
		t.Errorf("while a release is on its way, Sveltos's reading stands: %+v", s)
	}
	if s := cond("False", "", after).apply(LiveStatus{SyncStatus: "Synced", HealthStatus: "Healthy"}, applied); s.HealthStatus != "Degraded" || s.Message != "ClusterHealthCheck c: a workload is not healthy" {
		t.Errorf("a failing check with no message still says so: %+v", s)
	}
	if s := cond("False", "Deployment: kyverno/x status is Progressing Message: x: rolling out", after).apply(LiveStatus{SyncStatus: "Synced", HealthStatus: "Healthy"}, applied); s.HealthStatus != "Progressing" {
		t.Errorf("a workload rolling out is Progressing, not Degraded: %+v", s)
	}
	if s := cond("False", "old news", before).apply(LiveStatus{SyncStatus: "Synced", HealthStatus: "Healthy"}, applied); s.HealthStatus != "Healthy" {
		t.Errorf("a failure seen before the release was applied is stale: %+v", s)
	}
	if s := cond("True", "", after).apply(LiveStatus{SyncStatus: "Synced", HealthStatus: "Unknown"}, applied); s.HealthStatus != "Healthy" || s.Message != "watched by ClusterHealthCheck c" {
		t.Errorf("a profile without apply-time checks is healthy when its continuous check passes: %+v", s)
	}
	if s := (watch{check: "c"}).apply(LiveStatus{SyncStatus: "Synced", HealthStatus: "Unknown"}, applied); s.HealthStatus != "Unknown" {
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
