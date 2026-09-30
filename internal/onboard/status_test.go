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
	summaries := `{"items":[{"metadata":{"labels":{"projectsveltos.io/cluster-profile-name":"kyverno-prod-eu"}},"spec":{"clusterName":"prod-eu"},
	  "status":{"featureSummaries":[{"featureID":"Resources","status":"Provisioned","lastAppliedTime":"` + later.Format(time.RFC3339) + `"}]}}]}`
	releases := `[{"Release":{"ReleaseNum":1,"Published":true,"ManifestDigest":"sha256:one","CreatedAt":"` + published.Format(time.RFC3339Nano) + `"}}]`
	held := ""
	run := func(name string, args ...string) ([]byte, error) {
		all := name + " " + strings.Join(args, " ")
		switch {
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
	opts.DryRun = true
	summaries = strings.Replace(summaries, `"Provisioned"`, `"Provisioning"`, 1)
	if reports, _ = ReportStatus(run, opts); reports[0].Wrote || reports[0].Why != "dry run" || reports[0].Status.SyncStatus != "OutOfSync" {
		t.Errorf("a dry run reports a changed reading, and writes nothing: %+v", reports[0])
	}
}
