package onboard

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Live status: what Sveltos reports for each delivery profile, written where
// ConfigHub shows it. ConfigHub reads a deployment Space's
// confighub.com/live-status annotation, a small JSON document; its healthy
// gate passes on Synced, Succeeded and Healthy exactly, and a revision equal
// to a release's manifest digest lets it move that release's change order on
// by itself.

// LegacyLiveStatusAnnotation is the Space annotation ConfigHub read live
// status from before v0.8.2, and that this plugin wrote up to 0.13. Nothing
// reads it now, so one found on a Space is removed.
const LegacyLiveStatusAnnotation = "confighub.com/live-status"

// StatusReporter names this reporter on each Release it reports on.
const StatusReporter = "cub-sveltos"

// LiveStatus is what is recorded on a Release, where ConfigHub v0.8.2 and
// newer read live status. Sync, Health and Operation are ConfigHub's
// normalized words, which its gates read; ReporterSync keeps Sveltos's own
// beside them.
type LiveStatus struct {
	Reporter          string `json:"reporter"`
	DataSource        string `json:"dataSource,omitempty"`
	Sync              string `json:"sync"`
	Health            string `json:"health"`
	Operation         string `json:"operation,omitempty"`
	ReporterSync      string `json:"reporterSync,omitempty"`
	ReporterHealth    string `json:"reporterHealth,omitempty"`
	ReporterOperation string `json:"reporterOperation,omitempty"`
	Message           string `json:"message,omitempty"`
	ObservedAt        string `json:"observedAt"`
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
	// Release is the release the reading is recorded on: the Space's newest
	// published one, which is the one ConfigHub's Healthy gate reads. It is 0
	// when the Space has none.
	Release int
	// Running is the release Sveltos is taken to have applied, and Revision
	// its digest; 0 and empty when none can be named.
	Running  int
	Revision string
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

var gatewaySpace = regexp.MustCompile(`^oci://[^/]+/space/([a-z0-9-]+):`)

type release struct {
	num       int
	digest    string
	createdAt time.Time
	// live is what the release holds now, if a tool has reported on it.
	live *LiveStatus
}

// ReportStatus reads every delivery profile on the management cluster, the
// ClusterSummary Sveltos keeps for it, and its variant's published releases,
// and records each reading on the variant's newest published release.
//
// A Space that cannot be read or written is reported in the error, and the
// rest are still reported: one deleted Space must not freeze every reading
// after it.
func ReportStatus(run Runner, hub Hub, opts StatusOptions) ([]StatusReport, error) {
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
	watched, err := watchedHealth(kubectl)
	if err != nil {
		return nil, err
	}

	var reports []StatusReport
	var errs []string
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
		releases, err := publishedReleases(hub, space)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", space, oneLine(err)))
			continue
		}
		checked := len(list(obj(p["spec"])["validateHealths"])) > 0
		var running *release
		report.Status, running = liveStatus(name, summary, releases, checked, now())
		if running != nil {
			report.Running, report.Revision = running.num, running.digest
		}
		cluster := str(obj(summary["spec"])["clusterNamespace"]) + "/" + report.Cluster
		if w, ok := watched[watchingProfile(watched, name)][cluster]; ok {
			report.Status = w.apply(report.Status, appliedAt(summary))
		}
		if err := writeStatus(hub, &report, releases, opts, now()); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", space, oneLine(err)))
		}
		reports = append(reports, report)
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i].Space < reports[j].Space })
	if len(errs) > 0 {
		sort.Strings(errs)
		return reports, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return reports, nil
}

// oneLine is an error as one line: ConfigHub's own run over several, and each
// Space's goes in a list.
func oneLine(err error) string {
	return strings.Join(strings.Fields(err.Error()), " ")
}

func publishedReleases(hub Hub, space string) ([]release, error) {
	all, err := hub.Releases(space)
	if err != nil {
		return nil, err
	}
	var releases []release
	for _, r := range all {
		if !r.Published || r.CreatedAt.IsZero() {
			continue
		}
		releases = append(releases, release{num: r.Num, digest: r.Digest, createdAt: r.CreatedAt, live: r.Live})
	}
	sort.Slice(releases, func(i, j int) bool { return releases[i].num < releases[j].num })
	return releases, nil
}

// workloadGVKs are what a delivery would need health checks for.
var workloadGVKs = []string{"Deployment.v1.apps", "StatefulSet.v1.apps", "DaemonSet.v1.apps"}

// liveStatus maps what Sveltos reports for a delivery profile onto ConfigHub's
// words, as a reading of the variant's newest published release: Sveltos
// fetches the variant's newest release each time it applies, so what it
// reports is about that one. It also names the release Sveltos is taken to
// have applied, when one can be named.
//
// Sveltos does not report which release it fetched, so the release a cluster
// runs is inferred: the latest one created before Sveltos last applied the
// profile. Releases created close together, or clocks that disagree, can make
// the inference wrong.
func liveStatus(profile string, summary map[string]any, releases []release, checked bool, now time.Time) (LiveStatus, *release) {
	s := LiveStatus{Reporter: StatusReporter, DataSource: profile, ObservedAt: now.UTC().Format(time.RFC3339)}
	features := list(obj(summary["status"])["featureSummaries"])
	if summary == nil || len(features) == 0 {
		s.Sync, s.Health = "Unknown", "Unknown"
		s.Message = "Sveltos has not deployed this profile yet"
		return s, nil
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
			s.Sync, s.Health, s.Operation, s.ReporterSync = "OutOfSync", "Degraded", "Failed", reporterWord(status)
			s.Message = clip(fmt.Sprintf("Sveltos: %s: %s", status, strings.TrimSpace(str(f["failureMessage"]))))
			return s, nil
		default:
			pending = status
		}
	}
	var running *release
	for i, r := range releases {
		if !applied.IsZero() && !r.createdAt.After(applied) {
			running = &releases[i]
		}
	}
	switch {
	case pending != "":
		s.Sync, s.Health, s.Operation, s.ReporterSync = "OutOfSync", "Progressing", "Running", reporterWord(pending)
		s.Message = clip("Sveltos: " + pending)
	case len(releases) == 0:
		s.Sync, s.Health, s.ReporterSync = "Unknown", "Unknown", "Provisioned"
		s.Message = "the variant has no published release"
	case running == nil || running.num != releases[len(releases)-1].num:
		latest := releases[len(releases)-1]
		s.Sync, s.Health, s.Operation, s.ReporterSync = "OutOfSync", "Progressing", "Running", "Provisioned"
		s.Message = fmt.Sprintf("release %d, created %s, not applied yet", latest.num, latest.createdAt.UTC().Format(time.RFC3339))
		if running != nil {
			s.Message += fmt.Sprintf("; the cluster runs release %d", running.num)
		}
	default:
		s.Sync, s.Operation, s.Health, s.ReporterSync = "Synced", "Succeeded", "Healthy", "Provisioned"
		s.Message = fmt.Sprintf("release %d applied", running.num)
		if !checked && deploysWorkloads(summary) {
			s.Health = "Unknown"
			s.Message += "; this delivery profile has no health checks, so Sveltos does not wait for its workloads"
		}
	}
	return s, running
}

// reporterWord is one of Sveltos's own words, short enough for the 64
// characters ConfigHub keeps of it.
func reporterWord(w string) string {
	if len(w) > 64 {
		return w[:64]
	}
	return w
}

// watch is what a profile's ClusterHealthCheck last said about one cluster.
type watch struct {
	check      string
	conditions []any
}

// watchedHealth reads the ClusterHealthChecks that watch profiles, by the
// profile they watch and the cluster, as <namespace>/<name>. A management
// cluster without Sveltos's health checks installed has none.
func watchedHealth(kubectl func(args ...string) ([]byte, error)) (map[string]map[string]watch, error) {
	out := map[string]map[string]watch{}
	data, err := kubectl("get", "clusterhealthchecks", "-o", "json")
	if err != nil {
		if strings.Contains(err.Error(), "doesn't have a resource type") {
			return out, nil
		}
		return nil, fmt.Errorf("reading the ClusterHealthChecks: %w", err)
	}
	var checks struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(data, &checks); err != nil {
		return nil, fmt.Errorf("reading the ClusterHealthChecks: %w", err)
	}
	for _, c := range checks.Items {
		profile := str(obj(obj(c["metadata"])["labels"])[ProfileLabel])
		if profile == "" {
			continue
		}
		for _, cc := range list(obj(c["status"])["clusterCondition"]) {
			ref := obj(obj(obj(cc)["clusterInfo"])["cluster"])
			if out[profile] == nil {
				out[profile] = map[string]watch{}
			}
			out[profile][str(ref["namespace"])+"/"+str(ref["name"])] = watch{check: str(obj(c["metadata"])["name"]), conditions: list(obj(cc)["conditions"])}
		}
	}
	return out, nil
}

// watchingProfile is the profile a delivery profile belongs to: delivery
// profiles are named <profile>-<cluster>, and the longest profile name that
// prefixes it is the one.
func watchingProfile(watched map[string]map[string]watch, deliveryProfile string) string {
	best := ""
	for p := range watched {
		if strings.HasPrefix(deliveryProfile, p+"-") && len(p) > len(best) {
			best = p
		}
	}
	return best
}

// appliedAt is when Sveltos last applied every feature of a profile: the
// earliest of their last-applied times.
func appliedAt(summary map[string]any) time.Time {
	var applied time.Time
	for _, f := range list(obj(summary["status"])["featureSummaries"]) {
		t, err := time.Parse(time.RFC3339, str(obj(f)["lastAppliedTime"]))
		if err == nil && (applied.IsZero() || t.Before(applied)) {
			applied = t
		}
	}
	return applied
}

var spaces = regexp.MustCompile(`\s+`)

// apply lets the continuous check speak for health once the latest release is
// applied: Degraded, naming what failed, when a workload has stopped being
// healthy since, Progressing while one rolls out, and Healthy when Sveltos's
// apply-time checks were missing and the check passes. A failure the check
// saw before the release was applied is stale, since Sveltos's own checks
// passed at apply. While a release is on its way, Sveltos's reading stands.
func (w watch) apply(s LiveStatus, applied time.Time) LiveStatus {
	if s.Sync != "Synced" {
		return s
	}
	failing, passing := "", false
	for _, c := range w.conditions {
		c := obj(c)
		if !strings.HasPrefix(str(c["type"]), "HealthCheck") {
			continue
		}
		switch str(c["status"]) {
		case "True":
			passing = true
		case "False":
			if at, err := time.Parse(time.RFC3339, str(c["lastTransitionTime"])); err == nil && !applied.IsZero() && at.Before(applied) {
				continue
			}
			if failing == "" {
				failing = strings.TrimSpace(spaces.ReplaceAllString(str(c["message"]), " "))
				if failing == "" {
					failing = "a workload is not healthy"
				}
			}
		}
	}
	switch {
	case failing != "":
		s.Health = "Degraded"
		if strings.Contains(failing, "status is Progressing") && !strings.Contains(failing, "status is Degraded") {
			s.Health = "Progressing"
		}
		s.ReporterHealth = s.Health
		s.Message = clip(fmt.Sprintf("ClusterHealthCheck %s: %s", w.check, failing))
	case passing && s.Health == "Unknown":
		s.Health = "Healthy"
		s.ReporterHealth = s.Health
		s.Message = "watched by ClusterHealthCheck " + w.check
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

// clip keeps a message short enough to read in a list; ConfigHub allows 1024
// bytes.
func clip(s string) string {
	const most = 400
	if len(s) <= most {
		return s
	}
	// Cut on a character, not inside one: half a character reads back as a
	// different one, and the reading would never match what was written.
	cut := most - 3
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "..."
}

// writeStatus records a reading on the Space's newest published release,
// unless that release already holds the same one, recently enough.
//
// A reading another reporter wrote is left alone while it is fresher than
// --refresh, and for as long as it says the same: two reporters would
// overwrite each other. It is replaced only when it is both old and
// different.
func writeStatus(hub Hub, r *StatusReport, releases []release, opts StatusOptions, now time.Time) error {
	if len(releases) == 0 {
		r.Why = "no release"
		return nil
	}
	newest := releases[len(releases)-1]
	r.Release = newest.num
	held := newest.live
	fresh := false
	if held != nil {
		if at, err := time.Parse(time.RFC3339, held.ObservedAt); err == nil && now.Sub(at) < opts.Refresh {
			fresh = true
		}
	}
	if held != nil && held.Reporter != StatusReporter {
		same := held.Sync == r.Status.Sync && held.Health == r.Status.Health && held.Operation == r.Status.Operation
		if fresh || same {
			r.Why = "left to " + held.Reporter
			return nil
		}
	}
	if held != nil && held.same(r.Status) && fresh {
		r.Why = "unchanged"
		return nil
	}
	if opts.DryRun {
		r.Why = "dry run"
		return nil
	}
	if err := hub.SetLiveStatus(r.Space, newest.num, r.Status); err != nil {
		r.Why = "failed"
		if strings.Contains(err.Error(), "permission denied") {
			return fmt.Errorf("recording the live status of release %d, which takes EditChildren on the Space or on its Target: %w", newest.num, err)
		}
		return fmt.Errorf("recording the live status of release %d: %w", newest.num, err)
	}
	r.Wrote = true
	return dropLegacyStatus(hub, r.Space)
}

// dropLegacyStatus removes the reading an earlier version left on the Space,
// which nothing updates now and which would go on saying what was true then.
func dropLegacyStatus(hub Hub, space string) error {
	s, err := hub.Space(space)
	if err != nil {
		return fmt.Errorf("looking for the live status an earlier version left on the Space: %w", err)
	}
	if _, ok := s.Annotations[LegacyLiveStatusAnnotation]; !ok {
		return nil
	}
	patch, err := json.Marshal(map[string]any{"Annotations": map[string]any{LegacyLiveStatusAnnotation: nil}})
	if err != nil {
		return err
	}
	if err := hub.PatchSpace(space, patch); err != nil {
		return fmt.Errorf("removing the live status an earlier version left on the Space: %w", err)
	}
	return nil
}
