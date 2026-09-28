package onboard

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/confighub/sveltos-confighub/chartrender"
	"gopkg.in/yaml.v3"
)

func count(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func (p *Plan) variantCount() int {
	n := 0
	for _, pr := range p.Profiles {
		n += len(pr.Variants)
	}
	return n
}

// RenderPlan is what `cub sveltos plan` prints. Nextline says what to run next.
func RenderPlan(plan *Plan, next bool) string {
	var out []string
	variants := plan.variantCount()
	clusters := map[string]bool{}
	for _, p := range plan.Profiles {
		for _, v := range p.Variants {
			clusters[v.ClusterKey] = true
		}
	}
	inputs := 0
	width := 12
	for _, p := range plan.Profiles {
		inputs += len(p.Members)
		for _, v := range p.Variants {
			if len(v.Cluster) > width {
				width = len(v.Cluster)
			}
		}
	}
	what := count(len(plan.Profiles), "profile")
	if inputs != len(plan.Profiles) {
		what = fmt.Sprintf("%s made from %s", count(len(plan.Profiles), "component"), count(inputs, "profile"))
	}
	out = append(out,
		fmt.Sprintf("Onboarding plan: %s over %s, one variant per cluster per component (%s).",
			what, count(len(clusters), "cluster"), count(variants, "variant")),
		"Nothing has changed. This is what ConfigHub would hold.")
	for _, p := range plan.Profiles {
		out = append(out, "")
		var how []string
		if p.Selector != "" {
			how = append(how, "selects "+p.Selector)
		}
		if p.ClusterRefs > 0 {
			how = append(how, "names "+count(p.ClusterRefs, "cluster"))
		}
		out = append(out, fmt.Sprintf("%s  (%s)", p.Name, strings.Join(how, "; ")))
		out = append(out, fmt.Sprintf("  base     %s  holds what its charts and policies render to, and delivers to no cluster:", p.BaseSpace))
		uw := 0
		for _, u := range p.Units {
			if len(u.Slug) > uw {
				uw = len(u.Slug)
			}
		}
		for _, u := range p.Units {
			out = append(out, fmt.Sprintf("    unit   %-*s  %s: %s", uw, u.Slug, u.Source, u.Summary()))
		}
		for _, c := range p.Classes {
			differs := "the same as the base"
			if len(c.Departures) > 0 {
				differs = "differs from the base in " + describeDepartures(c.Departures)
			}
			from := ""
			if len(p.Members) > 1 {
				from = "from profile " + c.Member + "; "
			}
			out = append(out, fmt.Sprintf("  class    %-12s %s  %s%s", c.Value, c.Space, from, differs))
		}
		for _, stage := range p.Stages {
			out = append(out, "  stage "+stage)
			for _, v := range p.Variants {
				if v.Stage != stage {
					continue
				}
				out = append(out, fmt.Sprintf("    %-*s variant %s%s  ->  Target %s/%s", width, v.Cluster, v.Space, classNote(v), plan.TargetsSpace, v.Target))
			}
		}
	}
	if m := plan.Management; m != nil {
		n := 0
		for _, b := range m.ByProfile {
			n += len(b.Profiles)
		}
		out = append(out, "",
			fmt.Sprintf("Management cluster %s/%s", m.Namespace, m.Cluster),
			fmt.Sprintf("  record   %s  one delivery profile per variant (%d): each sends its variant's releases to its one cluster", m.Space, n))
	}
	if len(plan.Ungoverned) > 0 || len(plan.Skipped) > 0 {
		out = append(out, "", "Not onboarded")
		for _, c := range plan.Ungoverned {
			out = append(out, fmt.Sprintf("  cluster %s: no profile selects it", c.Name))
		}
		for _, s := range plan.Skipped {
			out = append(out, fmt.Sprintf("  profile %s: %s", s.Name, s.Reason))
		}
	}
	spaces := 1
	for _, p := range plan.Profiles {
		spaces += 1 + len(p.Classes) + len(p.Variants)
	}
	if plan.Management != nil {
		spaces++
	}
	var rollouts []string
	for _, p := range plan.Profiles {
		after := ""
		if len(p.Classes) > 0 {
			after = " after its class bases"
		}
		rollouts = append(rollouts, fmt.Sprintf("%s in %s%s", p.Name, count(len(p.Stages), "stage"), after))
	}
	out = append(out, "", "In ConfigHub",
		fmt.Sprintf("  %s in %s, one per cluster, on a server-hosted worker", count(len(plan.Targets), "Target"), plan.TargetsSpace),
		fmt.Sprintf("  %s, each one base, %s%s, 1 management record", count(len(plan.Profiles), "component"), classCount(plan), count(variants, "variant")),
		fmt.Sprintf("  %s and %s, one tying each unit of a class base or a variant to its upstream (check your organization's quotas for both first)", count(spaces, "Space"), count(plan.linkCount(), "Link")),
		fmt.Sprintf("  first rollout: %s; one approval per stage, one release per variant", strings.Join(rollouts, ", ")))
	for _, note := range plan.Notes {
		out = append(out, "", "Note: "+note)
	}
	if plan.Live {
		var live []string
		for _, p := range plan.Profiles {
			for _, m := range p.Members {
				if m.Live {
					live = append(live, m.Name)
				}
			}
		}
		out = append(out, "", fmt.Sprintf("Live on your management cluster: %s. Each delivery profile deploys the same objects to the same cluster. apply also writes handover.sh, which steps each live profile aside without removing anything, so the delivery profiles carry on alone; run it after apply.sh. See \"If your profiles are live\" in docs/user/onboard-your-sveltos-fleet.md.", strings.Join(live, ", ")))
	}
	if len(plan.Problems) > 0 {
		out = append(out, "", "Fix these before apply:")
		for _, p := range plan.Problems {
			out = append(out, "  - "+p)
		}
	} else if next {
		out = append(out, "", "Next: cub sveltos apply <the same input and options> --out <dir>, read <dir>/apply.sh, then run it.")
	}
	return strings.Join(out, "\n") + "\n"
}

func classNote(v Variant) string {
	if v.Class == "" {
		return ""
	}
	return " (class " + v.Class + ")"
}

// linkCount is the Links the plan makes: cub variant create ties each unit of
// a class base or a variant to its upstream's.
func (p *Plan) linkCount() int {
	n := 0
	for _, pr := range p.Profiles {
		n += len(pr.Units) * (len(pr.Classes) + len(pr.Variants))
	}
	return n
}

func classCount(plan *Plan) string {
	n := 0
	for _, p := range plan.Profiles {
		n += len(p.Classes)
	}
	if n == 0 {
		return ""
	}
	return count(n, "class base") + ", "
}

// The workflow's stage names: the class bases first when there are any.
func workflowStages(p Profile) []string {
	if len(p.Classes) == 0 {
		return p.Stages
	}
	return append([]string{basesStage}, p.Stages...)
}

var shellSafe = regexp.MustCompile(`^[A-Za-z0-9_./:=@-]+$`)

func q(value string) string {
	if shellSafe.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func line(words ...string) string {
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = q(w)
	}
	return strings.Join(quoted, " ")
}

type stageJSON struct {
	Name                 string   `json:"Name"`
	WhereSpace           string   `json:"WhereSpace"`
	Prerequisites        []string `json:"Prerequisites,omitempty"`
	ReleasePrerequisites []string `json:"ReleasePrerequisites,omitempty"`
}

// The workflow's stages as a patch, the same stages workflowText writes.
func stagesJSON(stages []string, bases bool) string {
	var out []stageJSON
	if bases {
		out = append(out, stageJSON{Name: basesStage, WhereSpace: fmt.Sprintf("Labels.Stage = '%s'", basesStage)})
	}
	for i, s := range stages {
		st := stageJSON{Name: s, WhereSpace: fmt.Sprintf("Labels.Stage = '%s'", s), ReleasePrerequisites: []string{"approval"}}
		if i > 0 {
			st.Prerequisites = []string{"Released"}
		}
		out = append(out, st)
	}
	data, _ := json.Marshal(map[string]any{"Stages": out})
	return string(data)
}

// ApplyScript is the one script apply writes: cub and kubectl steps to read,
// then run, and safe to run again.
func ApplyScript(plan *Plan) string {
	var names []string
	for _, p := range plan.Profiles {
		names = append(names, p.Name)
	}
	L := []string{
		"#!/usr/bin/env bash",
		fmt.Sprintf("# Onboard %s into ConfigHub: one variant per cluster per profile.", strings.Join(names, ", ")),
		"# Written by `cub sveltos apply`. Read it, then run it:",
		"#",
		"#   MGMT_CONTEXT=<kubectl context of your management cluster> bash apply.sh",
		"#",
		"# cub uses its current context; set CUB_CONTEXT to choose another.",
		"# Steps 1 to 4 only create records in ConfigHub: each base holds the objects",
		"# its charts and policies rendered to, in the files beside this script. Step 5",
		"# is the first release: each stage is promoted, approved, released. All of it",
		"# is safe to re-run, which is also how a cluster that joined since gets its",
		"# variants. Step 6 is the one change to your management cluster: a Secret",
		"# holding the gateway credential, and one delivery profile per variant.",
		"#",
		"# PROPOSE_ONLY=1 bash apply.sh approves nothing: a release waits for a",
		"# person to approve it in ConfigHub, and a delivery profile for its release.",
		"set -euo pipefail",
		`cd "$(dirname "$0")"`,
		`k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }`,
		`step() { printf '\n== %s\n' "$*"; }`,
		"# Re-running picks up where ConfigHub says each first release stands: a",
		"# finished change order is skipped, and a variant with nothing new is kept.",
		"# A cluster that joined since makes a new change order, which releases it.",
		`rolled_out() { [ "$(cub changeorder get --space "${1%/*}" "${1#*/}" -o jq=.ChangeOrder.Stage)" = Completed ]; }`,
		"# A class base takes its departures once, as a fresh clone (an empty",
		"# revision, then the clone), and they touch only their own fields and",
		"# objects. Later revisions are changes made in ConfigHub, which a re-run",
		"# leaves alone.",
		`fresh() { [ "$(cub unit get --space "$1" "$2" -o jq=.Unit.HeadRevisionNum)" -le 2 ] || { echo "$1/$2 already has its departures"; return 1; }; }`,
		"# A base unit holds every object of its file: a document lost on the way",
		"# shows as a different count. (ConfigHub may lay the YAML out its own way,",
		"# so the count is of objects, not bytes.) Later revisions, changes made in",
		"# ConfigHub since, are left alone.",
		"stored() {",
		`  [ "$(cub unit get --space "$1" "$2" -o jq=.Unit.HeadRevisionNum)" -le 2 ] || return 0`,
		`  local have want`,
		`  want=$(grep -c '^kind:' "$3" || true)`,
		`  have=$(cub unit data --space "$1" "$2" | grep -c '^kind:' || true)`,
		`  [ "$have" = "$want" ] || { echo "$1/$2 holds $have objects, but $3 has $want; compare them with: cub unit data --space $1 $2 | diff - $3" >&2; return 1; }`,
		"}",
		"# A variant must hold every unit of its base before it is released: Sveltos",
		"# removes from a cluster whatever a release no longer holds.",
		"holds() {",
		`  local n; n=$(cub unit list --space "$1" -o jq=length)`,
		`  [ "$n" -ge "$2" ] || { echo "$1 holds $n of its $2 units; run this script again" >&2; return 1; }`,
		"}",
		"# A cluster that joins in a stage the workflow does not have yet adds that",
		"# stage. Only the stages are patched, so approval settings made since stay.",
		`stages_are() { [ "$(cub changeworkflow get --space "$1" "$2" -o 'jq=[.ChangeWorkflow.Stages[].Name] | join(",")')" = "$3" ]; }`,
		"# A promotion takes each unit's change as one diff (--squash). Walked",
		"# revision by revision, it replays the functions a change was made with,",
		"# and a function run at the root then reaches a class's clusters although",
		"# the class base protected the field (measured on kind). Promoting a large",
		"# unit, a chart with its CRDs, can also outlast the request: cub reports no",
		"# response while the server finishes. A promotion is idempotent, so it is",
		"# asked again, and a change order with nothing left to promote has done it.",
		"promote() {",
		"  local out i",
		"  for i in 1 2 3; do",
		`    out=$(cub variant promote --change-order "$1" --target-stage "$2" --squash --quiet 2>&1 >/dev/null) && return 0`,
		`    case "$out" in *"nothing left to promote"*) return 0 ;; esac`,
		"    sleep 15",
		"  done",
		`  echo "$out" >&2; return 1`,
		"}",
		"publish() {",
		"  local out",
		`  holds "$1" "$3" || return 1`,
		`  out=$(cub release publish "$1" --revision "ChangeOrder:$2" --quiet 2>&1) && return 0`,
		`  case "$out" in`,
		`    *"no changes were made since :latest bundle"*) echo "$1 already released" ;;`,
		`    *"requires approval"*) [ -n "${PROPOSE_ONLY:-}" ] || { echo "$out" >&2; return 1; }; echo "$1 waits for approval"; waiting=$4 ;;`,
		`    *) echo "$out" >&2; return 1 ;;`,
		"  esac",
		"}",
		"# PROPOSE_ONLY=1 approves nothing. Each stage is promoted, and a release",
		"# waits in ConfigHub until a person approves it; run the script again to",
		"# publish what was approved. A stage with nothing new for its variants needs",
		"# no approval, so a joining cluster waits in its own stage only.",
		"# cub sveltos watch runs the script this way when a cluster joins.",
		`approve() { [ -n "${PROPOSE_ONLY:-}" ] || cub variant approve --change-order "$1" --stage "$2" --quiet; }`,
		`awaits() { [ -z "$waiting" ] || echo "$1 waits for approval in stage $waiting: cub variant approve --change-order $2 --stage $waiting"; }`,
		"# deliver <profile> <variant Spaces>: apply the profile's delivery profiles.",
		"# With PROPOSE_ONLY, only those whose variant has a release; the others",
		"# follow on the run after their release is approved.",
		"deliver() {",
		`  local file=management/$1.yaml s; shift`,
		`  [ -n "${PROPOSE_ONLY:-}" ] || { k apply -f "$file"; return; }`,
		`  for s in "$@"; do`,
		`    if [ "$(cub release list --space "$s" -o 'jq=[.[] | select(.Release.Published)] | length')" -gt 0 ]; then`,
		fmt.Sprintf(`      k apply -f "$file" -l "%s=$s"`, VariantLabel),
		"    else",
		`      echo "$s has no release yet, so its delivery profile waits"`,
		"    fi",
		"  done",
		"}",
		"",
		`step "0/6 Check before changing anything"`,
		`cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }`,
		`image=$(k get deployment addon-controller -n projectsveltos -o jsonpath='{.spec.template.spec.containers[0].image}')`,
		`version=${image##*:}`,
		fmt.Sprintf(`if [ "$(printf '%%s\n' %s "$version" | sort -V | head -1)" != %s ]; then`, MinimumSveltos, MinimumSveltos),
		fmt.Sprintf(`  echo "the management cluster runs addon-controller $version; ConfigHub's gateway serves gzipped layers, which Sveltos reads from %s"; exit 1`, MinimumSveltos),
		"fi",
		"",
		fmt.Sprintf(`step "1/6 One named Target per cluster, in %s"`, plan.TargetsSpace),
		line("cub", "space", "create", plan.TargetsSpace, "--allow-exists", "--quiet"),
		"# A server-hosted worker has no process behind it and no role in the",
		"# organization; it holds the Targets and is the credential Sveltos reads with.",
		line("cub", "worker", "create", "--space", plan.TargetsSpace, workerSlug, "--is-server-worker", "--org-role", "none", "--allow-exists", "--quiet"),
	}
	for _, t := range plan.Targets {
		L = append(L, line("cub", "target", "create", t.Target, "{}", workerSlug, "--space", plan.TargetsSpace, "--provider", "OCI", "--toolchain", "Any", "--allow-exists", "--quiet"))
	}
	L = append(L, "", `step "2/6 One component per profile: a base holding what its charts and policies render to, and a rollout workflow"`)
	for _, p := range plan.Profiles {
		L = append(L,
			line("cub", "component", "create", p.Component, "--allow-exists", "--quiet"),
			line("cub", "space", "create", p.BaseSpace, "--component", p.Component, "--label", "Component="+p.Component, "--label", "Role=base", "--allow-exists", "--quiet"))
		for _, u := range p.Units {
			if u.Chart != nil {
				L = append(L, "# "+u.Slug+" is rendered with: "+renderCommand(p, u))
			}
			L = append(L,
				line("cub", "unit", "create", "--space", p.BaseSpace, u.Slug, p.Name+"/"+u.Slug+".yaml", "--change-desc", fmt.Sprintf("Onboard %s: %s", p.Name, u.Source), "--allow-exists", "--quiet"),
				line("stored", p.BaseSpace, u.Slug, p.Name+"/"+u.Slug+".yaml"))
		}
		L = append(L,
			line("cub", "changeworkflow", "create", "--space", p.BaseSpace, workflowSlug, "--filename", p.Name+"/change-workflow.yaml", "--allow-exists", "--quiet"),
			fmt.Sprintf("stages_are %s %s %s || %s | %s", p.BaseSpace, workflowSlug, strings.Join(workflowStages(p), ","),
				line("echo", stagesJSON(p.Stages, len(p.Classes) > 0)), line("cub", "changeworkflow", "update", "--patch", "--space", p.BaseSpace, workflowSlug, "--from-stdin", "--quiet")))
	}
	L = append(L, "", `step "3/6 One variant per cluster, each holding what its base holds"`)
	for _, p := range plan.Profiles {
		for _, c := range p.Classes {
			L = append(L,
				line("cub", "variant", "create", "class-"+Slug(c.Value), p.BaseSpace, "--stage", basesStage, "--space-pattern", "template:"+c.Space, "--allow-exists", "--quiet"),
				line("holds", c.Space, fmt.Sprint(len(p.Units))))
			for _, u := range p.Units {
				var ds []Departure
				for _, d := range c.Departures {
					if d.Unit == u.Slug {
						ds = append(ds, d)
					}
				}
				if len(ds) == 0 {
					continue
				}
				L = append(L, "if "+line("fresh", c.Space, u.Slug)+"; then")
				// cub prints the mutations these make even with --quiet; a
				// failure still reaches stderr.
				for _, cmd := range departureCommands(c.Space, u.Slug, fmt.Sprintf("Class %s departs from the base", c.Value), ds) {
					L = append(L, "  "+line(cmd...)+" >/dev/null")
				}
				L = append(L, "fi")
			}
		}
		for _, v := range p.Variants {
			L = append(L,
				line("cub", "variant", "create", v.Cluster, v.Upstream, "--stage", v.Stage, "--space-pattern", "template:"+v.Space, "--target", plan.TargetsSpace+"/"+v.Target, "--space-label", "Role=deployment", "--space-label", "Cluster="+v.Cluster, "--allow-exists", "--quiet"),
				line("holds", v.Space, fmt.Sprint(len(p.Units))))
		}
	}
	if m := plan.Management; m != nil {
		L = append(L, "", `step "4/6 The management cluster's record: one delivery profile per variant"`,
			line("cub", "component", "create", m.Component, "--allow-exists", "--quiet"),
			line("cub", "space", "create", m.Space, "--component", m.Component, "--allow-exists", "--quiet"))
		for _, b := range m.ByProfile {
			L = append(L,
				line("cub", "unit", "create", "--space", m.Space, b.Unit, "management/"+b.Profile+".yaml", "--target", plan.TargetsSpace+"/"+m.Target, "--change-desc", fmt.Sprintf("The profiles that deliver each %s variant's releases to its cluster", b.Profile), "--allow-exists", "--quiet"),
				line("cub", "unit", "update", "--space", m.Space, b.Unit, "management/"+b.Profile+".yaml", "--change-desc", fmt.Sprintf("The delivery profiles for every %s variant this plan holds", b.Profile), "--quiet"))
		}
	}
	L = append(L, "", `step "5/6 Release each variant, stage by stage: promote, approve, publish"`)
	for _, p := range plan.Profiles {
		order := p.BaseSpace + "/" + p.ReleaseOrder
		var spaces []string
		for _, v := range p.Variants {
			spaces = append(spaces, v.Space)
		}
		description := p.Description
		if description == "" {
			description = "First release of " + strings.Join(spaces, ", ")
		}
		L = append(L,
			line("cub", "changeorder", "create", "--space", p.BaseSpace, p.ReleaseOrder, "--change-workflow", p.BaseSpace+"/"+workflowSlug, "--description", description, "--allow-exists", "--quiet"),
			"if rolled_out "+order+"; then",
			"  echo "+q(p.Name+": every variant in this plan is released"),
			"else",
			"  waiting=")
		if len(p.Classes) > 0 {
			L = append(L, "  "+line("promote", order, basesStage))
		}
		// Each stage after the first waits for the stage ahead to release, so
		// once a release waits for approval, the stages after it wait too.
		for i, stage := range p.Stages {
			indent := "  "
			if i > 0 {
				L = append(L, `  if [ -z "$waiting" ]; then`)
				indent = "    "
			}
			L = append(L,
				indent+line("promote", order, stage),
				indent+line("approve", order, stage))
			for _, v := range p.Variants {
				if v.Stage == stage {
					L = append(L, indent+line("publish", v.Space, order, fmt.Sprint(len(p.Units)), stage))
				}
			}
			if i > 0 {
				L = append(L, "  fi")
			}
		}
		L = append(L, "  "+line("awaits", p.Name, order), "fi")
	}
	if plan.Management != nil {
		worker := fmt.Sprintf("cub worker get --space %s %s", plan.TargetsSpace, workerSlug)
		L = append(L, "", `step "6/6 Point Sveltos at ConfigHub (your management cluster)"`,
			"# Sveltos reads the gateway as the Targets' server worker: a credential that",
			"# does not expire and can pull only the releases of those Targets. The ID and",
			"# secret go from cub into the Secret through file descriptors, never to disk,",
			"# the command line, or the terminal.",
			fmt.Sprintf(`k create secret generic %s --namespace %s --type %s \`, gatewaySecretName(plan.TargetsSpace), secretNamespace, secretType),
			fmt.Sprintf(`  --from-file=username=<(%s -o jq=.BridgeWorker.BridgeWorkerID | tr -d '\n') \`, worker),
			fmt.Sprintf(`  --from-file=password=<(%s --include-secret -o jq=.BridgeWorker.Secret | tr -d '\n') \`, worker),
			"  --dry-run=client -o yaml | k apply -f -")
		var live []string
		for _, p := range plan.Profiles {
			if p.Live {
				live = append(live, p.Name)
				continue
			}
			words := []string{"deliver", p.Name}
			for _, v := range p.Variants {
				words = append(words, v.Space)
			}
			L = append(L, line(words...))
		}
		L = append(L, "", "echo", `echo "Done. Sveltos delivers each variant's release to its cluster within a minute. Watch it with:"`, `echo "  kubectl get clustersummaries -A"`)
		if len(live) > 0 {
			L = append(L, "echo "+q(fmt.Sprintf("The delivery profiles of %s wait for handover.sh, which steps your live profiles aside first, so no object has two profiles managing it.", strings.Join(live, ", "))))
		}
	}
	return strings.Join(L, "\n") + "\n"
}

// HandoverScript hands each live profile's add-ons to the delivery profiles.
// Measured on kind with Sveltos v1.15.0: set to LeavePolicies and then deleted,
// a live profile leaves everything in place, and a delivery profile applied
// after it adopts what is there. Applied while the live profile still ran, a
// delivery profile found policyRefs objects in conflict, and a live profile
// with drift detection took its first write as drift and ran one more helm
// upgrade, hooks and all; so the live profiles leave first.
func HandoverScript(plan *Plan) string {
	var live []Profile
	var names []string
	for _, p := range plan.Profiles {
		if p.Live {
			live = append(live, p)
			for _, m := range p.Members {
				if m.Live {
					names = append(names, m.Name)
				}
			}
		}
	}
	L := []string{
		"#!/usr/bin/env bash",
		fmt.Sprintf("# Hand %s to the delivery profiles ConfigHub releases to,", strings.Join(names, ", ")),
		"# without reinstalling anything. Run it after apply.sh:",
		"#",
		"#   MGMT_CONTEXT=<kubectl context of your management cluster> bash handover.sh",
		"#",
		"# It sets each live profile to LeavePolicies, so deleting it leaves what it",
		"# deployed in place, and deletes it; a profile another depends on goes after",
		"# the one that depends on it. Then it applies the delivery profiles, which",
		"# adopt what is there. So no object ever has two profiles managing it.",
		"# Skipping LeavePolicies would uninstall the add-ons first.",
		"#",
		"# Before it changes anything, it checks that each live profile, and each",
		"# ConfigMap of policies, is still what was exported and planned, and still",
		"# reaches the clusters planned. If one has changed, what ConfigHub holds",
		"# may not be what runs, and the delivery profiles would change the",
		"# clusters to match it; so it stops, and asks for a fresh export.",
		"set -euo pipefail",
		`cd "$(dirname "$0")"`,
		`k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }`,
		`fail() { echo "handover.sh: $*" >&2; exit 1; }`,
		`again="export again, then plan and apply again"`,
		"# unchanged <profile> <uid> <generation>: the profile is as exported, or gone.",
		"# A run of this script that stopped after setting LeavePolicies leaves it",
		"# one generation on.",
		`unchanged() {`,
		`  local now uid gen leave`,
		`  now=$(k get clusterprofile "$1" -o jsonpath='{.metadata.uid} {.metadata.generation} {.spec.stopMatchingBehavior}' 2>/dev/null) || return 0`,
		`  read -r uid gen leave <<<"$now"`,
		`  [ "$uid" = "$2" ] || fail "$1 is not the profile you exported: it was deleted and made again; $again"`,
		`  [ "$gen" = "$3" ] && return 0`,
		`  [ "$gen" = "$(($3 + 1))" ] && [ "$leave" = LeavePolicies ] && return 0`,
		`  fail "$1 has changed since you exported it (generation $3, now $gen), so ConfigHub may not hold what it deploys; $again"`,
		`}`,
		"# reaches <profile> <clusters>: the profile reaches exactly the clusters planned, or is gone.",
		`reaches() {`,
		`  local now`,
		`  now=$(k get clusterprofile "$1" -o jsonpath='{range .status.matchingClusters[*]}{.kind}/{.namespace}/{.name}{"\n"}{end}' 2>/dev/null) || return 0`,
		`  now=$(sort <<<"$now" | sed '/^$/d' | paste -sd' ' -)`,
		`  [ "$now" = "$2" ] || fail "$1 reaches ${now:-no cluster} now, not the clusters planned ($2); $again"`,
		`}`,
		"# policies <namespace> <name> <resourceVersion>: the ConfigMap is as exported.",
		`policies() {`,
		`  local now`,
		`  now=$(k get configmap -n "$1" "$2" -o jsonpath='{.metadata.resourceVersion}' 2>/dev/null) || fail "ConfigMap $1/$2 is gone; $again"`,
		`  [ "$now" = "$3" ] || fail "ConfigMap $1/$2 has changed since you exported it, so ConfigHub holds other policies than the clusters run; $again"`,
		`}`,
		"# compare <cluster> <release> <space> <unit>: what ConfigHub released for the",
		"# variant is what Helm installed on its cluster. cub sveltos reads Helm's record",
		"# there through the cluster's kubeconfig Secret, as Sveltos reaches it.",
		"# CLUSTER_KUBECONFIGS, if set, is a directory of <cluster>.kubeconfig files for",
		"# clusters Sveltos reaches at an address only the management cluster can.",
		`compare() { ${SVELTOS:-cub sveltos} compare ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} ${CLUSTER_KUBECONFIGS:+--kubeconfig-dir "$CLUSTER_KUBECONFIGS"} --cluster "$1" --release "$2" --space "$3" --unit "$4" || differs=1; }`,
		`differs=`,
		fmt.Sprintf(`k get secret -n %s %s >/dev/null 2>&1 || fail "the gateway Secret is missing: run apply.sh first"`, secretNamespace, gatewaySecretName(plan.TargetsSpace)),
	}
	L = append(L, "", "echo "+q("== what was planned is what is live"))
	for _, p := range live {
		for _, m := range p.Members {
			if !m.Live {
				continue
			}
			if m.ManagedBy != "" {
				L = append(L, fmt.Sprintf("k get clusterprofile %s >/dev/null 2>&1 && fail %s", m.Name, q(fmt.Sprintf("%s is applied by %s, which would apply it again once deleted: set stopMatchingBehavior: LeavePolicies on it there, let that apply, then remove it there, and run handover.sh again", m.Name, m.ManagedBy))))
			}
			if m.UID != "" && m.Generation != "" {
				L = append(L, line("unchanged", m.Name, m.UID, m.Generation))
			}
			var keys []string
			for _, v := range p.Variants {
				if v.Member == m.Name {
					keys = append(keys, v.ClusterRef.Kind+"/"+v.ClusterRef.Namespace+"/"+v.ClusterRef.Name)
				}
			}
			sort.Strings(keys)
			L = append(L, line("reaches", m.Name, strings.Join(keys, " ")))
		}
		for _, d := range p.PolicyMaps {
			meta := obj(d.Value["metadata"])
			if rv := str(meta["resourceVersion"]); rv != "" {
				L = append(L, line("policies", str(meta["namespace"]), str(meta["name"]), rv))
			}
		}
	}
	var compares []string
	for _, p := range live {
		for _, m := range p.Members {
			if !m.Live {
				continue
			}
			first := true
			for _, v := range p.Variants {
				if v.Member != m.Name {
					continue
				}
				for _, u := range p.Units {
					if u.Chart == nil {
						continue
					}
					if patches := mapGet(mapGet(m.Source, "spec"), "patches"); first && patches != nil && len(patches.Content) > 0 {
						compares = append(compares, "# "+m.Name+" has patches, which Sveltos applied to what Helm installed and applies to what ConfigHub releases; a difference in a patched field is theirs.")
					}
					first = false
					ref := v.ClusterRef
					compares = append(compares, line("compare", ref.Kind+"/"+ref.Namespace+"/"+ref.Name, u.Chart.Namespace+"/"+u.Chart.Release, v.Space, u.Slug))
				}
			}
		}
	}
	if len(compares) > 0 {
		L = append(L, "", "echo "+q("== what ConfigHub releases is what Helm installed"))
		L = append(L, compares...)
		L = append(L, `[ -z "$differs" ] || [ "${ACCEPT_DIFFERENCES:-}" = yes ] || fail "what ConfigHub releases is not shown to be what Helm installed, as above, so the handover could change those clusters. Find out why first: a chart that branches on the cluster's Kubernetes version or APIs, or reads it with lookup, renders differently. To hand over anyway, and let the delivery profiles make any such changes: ACCEPT_DIFFERENCES=yes bash handover.sh"`)
	}
	type handover struct{ member Member }
	var pending []handover
	for _, p := range live {
		for _, m := range p.Members {
			if m.Live {
				pending = append(pending, handover{m})
			}
		}
	}
	// A live profile another live profile depends on cannot leave first:
	// Sveltos holds its deletion, Blocked, until the dependent is gone. So each
	// dependent is handed over before what it depends on.
	for len(pending) > 0 {
		next := 0
		for i, h := range pending {
			needed := false
			for _, other := range pending {
				if contains(dependsOnOf(other.member.Source), h.member.Name) {
					needed = true
				}
			}
			if !needed {
				next = i
				break
			}
		}
		h := pending[next]
		pending = append(pending[:next], pending[next+1:]...)
		m := h.member
		L = append(L, "",
			"echo "+q("== "+m.Name),
			fmt.Sprintf("if ! k get clusterprofile %s >/dev/null 2>&1; then", m.Name),
			"  echo "+q(m.Name+" is already gone"),
			"else",
			fmt.Sprintf(`  k patch clusterprofile %s --type merge -p '{"spec":{"stopMatchingBehavior":"LeavePolicies"}}'`, m.Name),
			"  sleep 20",
			fmt.Sprintf("  k delete clusterprofile %s --wait=true", m.Name),
			"fi")
	}
	L = append(L, "", "echo "+q("== the delivery profiles"))
	for _, p := range live {
		L = append(L, line("k", "apply", "-f", "management/"+p.Name+".yaml"))
	}
	for _, p := range live {
		var clusters []string
		for _, v := range p.Variants {
			clusters = append(clusters, v.Cluster)
		}
		for _, u := range p.Units {
			if u.Chart == nil {
				continue
			}
			L = append(L, "echo "+q(fmt.Sprintf("Helm still records release %s on %s, though ConfigHub manages its objects now, so a helm uninstall there would remove them. Remove the record, which leaves the objects, on each of those clusters: kubectl -n %s delete secret -l owner=helm,name=%s", u.Chart.Release, strings.Join(clusters, ", "), u.Chart.Namespace, u.Chart.Release)))
		}
		for _, key := range p.Policies {
			ns, name, _ := strings.Cut(key, "/")
			L = append(L, "echo "+q(fmt.Sprintf("ConfigMap %s is no longer read; ConfigHub holds its objects. Delete it when you are ready: kubectl delete configmap -n %s %s", key, ns, name)))
		}
	}
	L = append(L, "", "echo",
		`echo "Done. Each delivery profile reports Provisioned within a minute:"`,
		`echo "  kubectl get clustersummaries -A"`)
	return strings.Join(L, "\n") + "\n"
}

// dependsOnOf is the profiles a profile names in dependsOn.
func dependsOnOf(source *yaml.Node) []string {
	var out []string
	if deps := mapGet(mapGet(source, "spec"), "dependsOn"); deps != nil {
		for _, d := range deps.Content {
			out = append(out, d.Value)
		}
	}
	return out
}

// renderCommand is the cub helm template command a chart unit was rendered
// with, reading its values from the file apply writes beside it. Rendering the
// next version the same way is how a chart upgrade starts.
func renderCommand(p Profile, u Unit) string {
	values := ""
	if u.Chart.Values != "" {
		values = valuesFile(p, u)
	}
	return line(u.Chart.Command(values)...) + " | " + chartrender.Filter
}

// valuesFile is where apply writes a chart's values.
func valuesFile(p Profile, u Unit) string { return p.Name + "/" + u.Slug + ".values.yaml" }

// departureCommands are the cub commands that make a class base's departures
// in one unit: its fields in one set-yq, each object it adds or removes, then
// the protection of its fields, so a later change at the root keeps them.
func departureCommands(space, unit, desc string, ds []Departure) [][]string {
	var cmds [][]string
	var edits, shown, protect []string
	for _, d := range ds {
		switch {
		case d.Adds:
			cmds = append(cmds, []string{"cub", "function", "set", "--space", space, "--unit", unit, "--change-desc", desc + ": " + d.Shown, "--quiet", "--", "upsert-resource", d.Object, d.ResourceType, d.ResourceName})
		case d.Deletes:
			cmds = append(cmds, []string{"cub", "function", "set", "--space", space, "--unit", unit, "--change-desc", desc + ": " + d.Shown, "--quiet", "--", "delete-resource", d.ResourceType, d.ResourceName})
		default:
			edits = append(edits, d.Edit)
			shown = append(shown, d.Shown)
			if !d.Removed {
				protect = append(protect, "--protect", d.Resource+":"+d.Path)
			}
		}
	}
	if len(edits) > 0 {
		cmds = append([][]string{{"cub", "function", "set", "--space", space, "--unit", unit, "--change-desc", desc + ": " + strings.Join(shown, ", "), "--quiet", "--", "set-yq", strings.Join(edits, " | ")}}, cmds...)
	}
	if len(protect) > 0 {
		cmds = append(cmds, append(append([]string{"cub", "unit", "set-protection", "--space", space, unit}, protect...), "--quiet"))
	}
	return cmds
}
