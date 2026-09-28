package onboard

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Live status: what Sveltos reports for each delivery profile, written where
// ConfigHub shows it. ConfigHub reads a deployment Space's
// confighub.com/live-status annotation, a small JSON document; its healthy
// gate passes on Synced, Succeeded and Healthy exactly, and a revision equal
// to a release's manifest digest lets it move that release's change order on
// by itself.

// LiveStatusAnnotation is the Space annotation ConfigHub reads.
const LiveStatusAnnotation = "confighub.com/live-status"

// LiveStatus is ConfigHub's live-status document.
type LiveStatus struct {
	Source         string `json:"source"`
	App            string `json:"app,omitempty"`
	SyncStatus     string `json:"syncStatus,omitempty"`
	HealthStatus   string `json:"healthStatus,omitempty"`
	OperationPhase string `json:"operationPhase,omitempty"`
	Revision       string `json:"revision,omitempty"`
	Message        string `json:"message,omitempty"`
	ObservedAt     string `json:"observedAt"`
}

// same says whether two reports say the same, whenever they were made.
func (s LiveStatus) same(o LiveStatus) bool {
	s.ObservedAt, o.ObservedAt = "", ""
	return s == o
}

// StatusReport is one delivery profile's reading.
type StatusReport struct {
	Profile, Cluster, Space string
	Status                  LiveStatus
	// Wrote says whether the reading was written to ConfigHub, and Why not.
	Wrote bool
	Why   string
}

// StatusOptions are how cub sveltos status runs.
type StatusOptions struct {
	// Context is the management cluster's kubectl context.
	Context string
	// DryRun reads and reports, and writes nothing.
	DryRun bool
	// Refresh writes an unchanged reading again once the one ConfigHub holds
	// is this old, so a reader can tell the reporter is still running.
	Refresh time.Duration
	Now     func() time.Time
}

// statusSource names the reporter to ConfigHub.
const statusSource = "sveltos"

var gatewaySpace = regexp.MustCompile(`^oci://[^/]+/space/([a-z0-9-]+):`)

type release struct {
	num       int
	digest    string
	createdAt time.Time
}

// ReportStatus reads every delivery profile on the management cluster, the
// ClusterSummary Sveltos keeps for it, and its variant's published releases,
// and writes each reading to the variant's Space.
func ReportStatus(run Runner, opts StatusOptions) ([]StatusReport, error) {
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	kubectl := func(args ...string) ([]byte, error) {
		if opts.Context != "" {
			args = append([]string{"--context", opts.Context}, args...)
		}
		return run("kubectl", args...)
	}
	out, err := kubectl("get", "clusterprofiles", "-o", "json")
	if err != nil {
		return nil, err
	}
	var profiles struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(out, &profiles); err != nil {
		return nil, err
	}
	out, err = kubectl("get", "clustersummaries", "-A", "-o", "json")
	if err != nil {
		return nil, err
	}
	var summaries struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(out, &summaries); err != nil {
		return nil, err
	}
	byProfile := map[string]map[string]any{}
	for _, s := range summaries.Items {
		name := str(obj(obj(s["metadata"])["labels"])["projectsveltos.io/cluster-profile-name"])
		byProfile[name] = s
	}

	var reports []StatusReport
	for _, p := range profiles.Items {
		name := str(obj(p["metadata"])["name"])
		space := ""
		for _, r := range list(obj(p["spec"])["policyRefs"]) {
			if m := gatewaySpace.FindStringSubmatch(str(obj(obj(r)["remoteURL"])["url"])); m != nil {
				space = m[1]
			}
		}
		if space == "" {
			continue // not delivered from ConfigHub
		}
		summary := byProfile[name]
		report := StatusReport{Profile: name, Space: space, Cluster: str(obj(summary["spec"])["clusterName"])}
		releases, err := publishedReleases(run, space)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", space, err)
		}
		checked := len(list(obj(p["spec"])["validateHealths"])) > 0
		report.Status = liveStatus(name, summary, releases, checked, now())
		if err := writeStatus(run, &report, opts, now()); err != nil {
			return nil, fmt.Errorf("%s: %w", space, err)
		}
		reports = append(reports, report)
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i].Space < reports[j].Space })
	return reports, nil
}

func publishedReleases(run Runner, space string) ([]release, error) {
	out, err := run("cub", "release", "list", "--space", space, "-o", "json")
	if err != nil {
		return nil, err
	}
	var rows []map[string]any
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, err
	}
	var releases []release
	for _, row := range rows {
		r := row
		if inner, ok := row["Release"].(map[string]any); ok {
			r = inner
		}
		if published, _ := r["Published"].(bool); !published {
			continue
		}
		created, err := time.Parse(time.RFC3339Nano, str(r["CreatedAt"]))
		if err != nil {
			continue
		}
		num, _ := r["ReleaseNum"].(float64)
		releases = append(releases, release{num: int(num), digest: str(r["ManifestDigest"]), createdAt: created})
	}
	sort.Slice(releases, func(i, j int) bool { return releases[i].num < releases[j].num })
	return releases, nil
}

// workloadGVKs are what a delivery would need health checks for.
var workloadGVKs = []string{"Deployment.v1.apps", "StatefulSet.v1.apps", "DaemonSet.v1.apps"}

// liveStatus maps what Sveltos reports for a delivery profile onto ConfigHub's
// words. A feature applied after a release was published applied that
// release: Sveltos fetches the variant's release each time it applies.
func liveStatus(profile string, summary map[string]any, releases []release, checked bool, now time.Time) LiveStatus {
	s := LiveStatus{Source: statusSource, App: profile, ObservedAt: now.UTC().Format(time.RFC3339)}
	features := list(obj(summary["status"])["featureSummaries"])
	if summary == nil || len(features) == 0 {
		s.SyncStatus, s.HealthStatus = "Unknown", "Unknown"
		s.Message = "Sveltos has not deployed this profile yet"
		return s
	}
	var applied time.Time
	pending := ""
	for _, f := range features {
		f := obj(f)
		switch status := str(f["status"]); status {
		case "Provisioned":
			t, err := time.Parse(time.RFC3339, str(f["lastAppliedTime"]))
			if err == nil && (applied.IsZero() || t.Before(applied)) {
				applied = t
			}
		case "Failed", "FailedNonRetriable":
			s.SyncStatus, s.HealthStatus, s.OperationPhase = "OutOfSync", "Degraded", "Failed"
			s.Message = clip(fmt.Sprintf("Sveltos: %s: %s", status, strings.TrimSpace(str(f["failureMessage"]))))
			return s
		default:
			pending = status
		}
	}
	running := -1
	for i, r := range releases {
		if !applied.IsZero() && !r.createdAt.After(applied) {
			running = i
		}
	}
	if running >= 0 {
		s.Revision = releases[running].digest
	}
	switch {
	case pending != "":
		s.SyncStatus, s.HealthStatus, s.OperationPhase = "OutOfSync", "Progressing", "Running"
		s.Message = "Sveltos: " + pending
	case len(releases) == 0:
		s.SyncStatus, s.HealthStatus = "Unknown", "Unknown"
		s.Message = "the variant has no published release"
	case running < len(releases)-1:
		latest := releases[len(releases)-1]
		s.SyncStatus, s.HealthStatus, s.OperationPhase = "OutOfSync", "Progressing", "Running"
		s.Message = fmt.Sprintf("release %d, published %s, not applied yet", latest.num, latest.createdAt.UTC().Format(time.RFC3339))
	default:
		s.SyncStatus, s.OperationPhase, s.HealthStatus = "Synced", "Succeeded", "Healthy"
		if !checked && deploysWorkloads(summary) {
			s.HealthStatus = "Unknown"
			s.Message = "applied; this delivery profile has no health checks, so Sveltos does not wait for its workloads"
		}
	}
	return s
}

func deploysWorkloads(summary map[string]any) bool {
	for _, d := range list(obj(summary["status"])["deployedGVKs"]) {
		for _, g := range list(obj(d)["deployedGroupVersionKind"]) {
			if contains(workloadGVKs, str(g)) {
				return true
			}
		}
	}
	return false
}

// clip keeps a message short enough for the annotation's 1024 bytes.
func clip(s string) string {
	const most = 400
	if len(s) > most {
		return s[:most-3] + "..."
	}
	return s
}

// writeStatus writes a reading to the Space unless ConfigHub already holds
// the same one, recently enough.
func writeStatus(run Runner, r *StatusReport, opts StatusOptions, now time.Time) error {
	out, err := run("cub", "space", "get", r.Space, "-o", "json")
	if err != nil {
		return err
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		return err
	}
	space := obj(got["Space"])
	if len(space) == 0 {
		space = got
	}
	var held LiveStatus
	if text := str(obj(space["Annotations"])[LiveStatusAnnotation]); text != "" && json.Unmarshal([]byte(text), &held) == nil && held.same(r.Status) {
		if at, err := time.Parse(time.RFC3339, held.ObservedAt); err == nil && now.Sub(at) < opts.Refresh {
			r.Why = "unchanged"
			return nil
		}
	}
	if opts.DryRun {
		r.Why = "dry run"
		return nil
	}
	doc, err := json.Marshal(r.Status)
	if err != nil {
		return err
	}
	patch, err := json.Marshal(map[string]any{"Annotations": map[string]string{LiveStatusAnnotation: string(doc)}})
	if err != nil {
		return err
	}
	if _, err := runStdin(run, patch, "cub", "space", "update", "--patch", r.Space, "--from-stdin", "--quiet"); err != nil {
		return err
	}
	r.Wrote = true
	return nil
}

// runStdin runs a command with input, through the runner: the runner takes
// the input as a first argument "<stdin>" followed by the text, which Run
// turns back into standard input.
func runStdin(run Runner, input []byte, name string, args ...string) ([]byte, error) {
	return run(name, append([]string{stdinMarker, string(input)}, args...)...)
}

const stdinMarker = "\x00stdin"

// ShortDigest is a digest as a person reads it.
func ShortDigest(d string) string {
	if i := strings.Index(d, ":"); i >= 0 && len(d) > i+13 {
		return d[:i+13]
	}
	return d
}

var _ = strconv.Itoa
