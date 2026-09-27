package onboard

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
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
		out = append(out, fmt.Sprintf("  base     %s  reaches no cluster: clusterRefs is empty", p.BaseSpace))
		for _, pm := range p.Policies {
			out = append(out, fmt.Sprintf("  policy   ConfigMap %s/%s  held in ConfigHub as unit %s; each variant gets its own copy", pm.Namespace, pm.Name, pm.Unit))
		}
		for _, c := range p.Classes {
			differs := "the same as the base"
			if len(c.Departures) > 0 {
				differs = "differs from the base in " + strings.Join(c.Departures, ", ")
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
				out = append(out,
					fmt.Sprintf("    %-*s variant %s%s  ->  Target %s/%s", width, v.Cluster, v.Space, classNote(v), plan.TargetsSpace, v.Target),
					fmt.Sprintf("    %-*s differs from the base in %s", width, "", strings.Join(v.Departures, ", ")))
				for i, vp := range v.Policies {
					out = append(out, fmt.Sprintf("    %-*s reads ConfigMap %s/%s", width, "", p.Policies[i].Namespace, vp.Name))
				}
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
			fmt.Sprintf("  record   %s  one bootstrap profile per variant (%d), fetching its release from the gateway", m.Space, n))
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
		fmt.Sprintf("  %s and %s, one tying each variant to its base (check your organization's quotas for both first)", count(spaces, "Space"), count(variants+classTotal(plan), "Link")),
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
		out = append(out, "", fmt.Sprintf("Live on your management cluster: %s. Each variant's profile deploys the same add-ons to the same cluster, and Sveltos lets one profile manage a release at a time, so the per-cluster profiles wait until the live one steps aside. apply also writes takeover.sh, which hands each release over without reinstalling it; run it after apply.sh. See \"If your profiles are live\" in docs/user/onboard-your-sveltos-fleet.md.", strings.Join(live, ", ")))
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

func classTotal(plan *Plan) int {
	n := 0
	for _, p := range plan.Profiles {
		n += len(p.Classes)
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
		"# Steps 1 to 4 only create records in ConfigHub. Step 5 is the first release:",
		"# each stage is promoted, approved, released. All of it is safe to re-run,",
		"# which is also how a cluster that joined since gets its variants.",
		"# Step 6 is the one change to your management cluster: a Secret holding the",
		"# gateway credential, and one bootstrap profile per variant.",
		"set -euo pipefail",
		`cd "$(dirname "$0")"`,
		`k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }`,
		`step() { printf '\n== %s\n' "$*"; }`,
		"# Re-running picks up where ConfigHub says each first release stands: a",
		"# finished change order is skipped, and a variant with nothing new is kept.",
		"# A cluster that joined since makes a new change order, which releases it.",
		`rolled_out() { [ "$(cub changeorder get --space "${1%/*}" "${1#*/}" -o jq=.ChangeOrder.Stage)" = Completed ]; }`,
		"# A variant takes its departures once, as a fresh clone (an empty revision,",
		"# then the clone), and they touch only their own fields, so the clone keeps",
		"# everything the base holds today. Later revisions are changes made in",
		"# ConfigHub, which a re-run leaves alone.",
		"depart() {",
		`  if [ "$(cub unit get --space "$1" "$2" -o jq=.Unit.HeadRevisionNum)" -le 2 ]; then`,
		`    cub function set --space "$1" --unit "$2" --change-desc "$4" --quiet -- set-yq "$3"`,
		"  else",
		`    echo "$1/$2 already has its departures"`,
		"  fi",
		"}",
		"# A cluster that joins in a stage the workflow does not have yet adds that",
		"# stage. Only the stages are patched, so approval settings made since stay.",
		`stages_are() { [ "$(cub changeworkflow get --space "$1" "$2" -o 'jq=[.ChangeWorkflow.Stages[].Name] | join(",")')" = "$3" ]; }`,
		"publish() {",
		"  local out",
		`  out=$(cub release publish "$1" --revision "ChangeOrder:$2" --quiet 2>&1) && return 0`,
		`  case "$out" in *"no changes were made since :latest bundle"*) echo "$1 already released" ;; *) echo "$out" >&2; return 1 ;; esac`,
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
		line("cub", "worker", "create", "--space", plan.TargetsSpace, workerSlug, "--filename", "worker.json", "--allow-exists", "--quiet"),
	}
	for _, t := range plan.Targets {
		L = append(L, line("cub", "target", "create", t.Target, "{}", workerSlug, "--space", plan.TargetsSpace, "--provider", "OCI", "--toolchain", "Any", "--allow-exists", "--quiet"))
	}
	L = append(L, "", `step "2/6 One component, one base and one rollout workflow per profile"`)
	for _, p := range plan.Profiles {
		L = append(L,
			line("cub", "component", "create", p.Component, "--allow-exists", "--quiet"),
			line("cub", "space", "create", p.BaseSpace, "--component", p.Component, "--label", "Component="+p.Component, "--label", "Role=base", "--allow-exists", "--quiet"),
			line("cub", "unit", "create", "--space", p.BaseSpace, unitSlug, p.Name+"/base.yaml", "--change-desc", fmt.Sprintf("Onboard %s from its ClusterProfile: the shared base", p.Name), "--allow-exists", "--quiet"))
		for _, pm := range p.Policies {
			L = append(L, line("cub", "unit", "create", "--space", p.BaseSpace, pm.Unit, p.Name+"/"+pm.Unit+".yaml", "--change-desc", fmt.Sprintf("Onboard the policies %s reads from ConfigMap %s/%s", p.Name, pm.Namespace, pm.Name), "--allow-exists", "--quiet"))
		}
		L = append(L,
			line("cub", "changeworkflow", "create", "--space", p.BaseSpace, workflowSlug, "--filename", p.Name+"/change-workflow.yaml", "--allow-exists", "--quiet"),
			fmt.Sprintf("stages_are %s %s %s || %s | %s", p.BaseSpace, workflowSlug, strings.Join(workflowStages(p), ","),
				line("echo", stagesJSON(p.Stages, len(p.Classes) > 0)), line("cub", "changeworkflow", "update", "--patch", "--space", p.BaseSpace, workflowSlug, "--from-stdin", "--quiet")))
	}
	L = append(L, "", `step "3/6 One variant per cluster, addressed to that cluster alone"`)
	for _, p := range plan.Profiles {
		for _, c := range p.Classes {
			L = append(L, line("cub", "variant", "create", "class-"+Slug(c.Value), p.BaseSpace, "--stage", basesStage, "--space-pattern", "template:"+c.Space, "--allow-exists", "--quiet"))
			if len(c.Departures) > 0 {
				L = append(L, line("depart", c.Space, unitSlug, c.DepartExpression, fmt.Sprintf("Class %s departs from the base: %s", c.Value, strings.Join(c.Departures, ", "))))
			}
		}
		for _, v := range p.Variants {
			L = append(L,
				line("cub", "variant", "create", v.Cluster, v.Upstream, "--stage", v.Stage, "--space-pattern", "template:"+v.Space, "--target", plan.TargetsSpace+"/"+v.Target, "--space-label", "Role=deployment", "--space-label", "Cluster="+v.Cluster, "--allow-exists", "--quiet"),
				line("depart", v.Space, unitSlug, v.DepartExpression, fmt.Sprintf("Depart from the base for %s: %s", v.Cluster, strings.Join(v.Departures, ", "))))
			for _, vp := range v.Policies {
				L = append(L, line("depart", v.Space, vp.Unit, vp.DepartExpression, fmt.Sprintf("%s's own copy of the policies: %s", v.Cluster, vp.Name)))
			}
		}
	}
	if m := plan.Management; m != nil {
		L = append(L, "", `step "4/6 The management cluster's record: its bootstrap profiles"`,
			line("cub", "component", "create", m.Component, "--allow-exists", "--quiet"),
			line("cub", "space", "create", m.Space, "--component", m.Component, "--allow-exists", "--quiet"))
		for _, b := range m.ByProfile {
			L = append(L,
				line("cub", "unit", "create", "--space", m.Space, b.Unit, "management/"+b.Profile+".yaml", "--target", plan.TargetsSpace+"/"+m.Target, "--change-desc", fmt.Sprintf("The bootstrap profiles that point Sveltos at each %s variant's releases", b.Profile), "--allow-exists", "--quiet"),
				line("cub", "unit", "update", "--space", m.Space, b.Unit, "management/"+b.Profile+".yaml", "--change-desc", fmt.Sprintf("The bootstrap profiles for every %s variant this plan holds", b.Profile), "--quiet"))
		}
	}
	L = append(L, "", `step "5/6 Release each variant, stage by stage: promote, approve, publish"`)
	for _, p := range plan.Profiles {
		order := p.BaseSpace + "/" + p.ReleaseOrder
		var spaces []string
		for _, v := range p.Variants {
			spaces = append(spaces, v.Space)
		}
		L = append(L,
			line("cub", "changeorder", "create", "--space", p.BaseSpace, p.ReleaseOrder, "--change-workflow", p.BaseSpace+"/"+workflowSlug, "--description", "First release of "+strings.Join(spaces, ", "), "--allow-exists", "--quiet"),
			"if rolled_out "+order+"; then",
			"  echo "+q(p.Name+": every variant in this plan is released"),
			"else")
		if len(p.Classes) > 0 {
			L = append(L, "  "+line("cub", "variant", "promote", "--change-order", order, "--target-stage", basesStage, "--quiet"))
		}
		for _, stage := range p.Stages {
			L = append(L,
				"  "+line("cub", "variant", "promote", "--change-order", order, "--target-stage", stage, "--quiet"),
				"  "+line("cub", "variant", "approve", "--change-order", order, "--stage", stage, "--quiet"))
			for _, v := range p.Variants {
				if v.Stage == stage {
					L = append(L, "  "+line("publish", v.Space, order))
				}
			}
		}
		L = append(L, "fi")
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
			"  --dry-run=client -o yaml | k apply -f -",
			"k apply -f management/",
			"",
			"echo",
			`echo "Done. Sveltos fetches each variant's release within a minute. Watch it with:"`,
			`echo "  kubectl get clustersummaries -A"`)
	}
	return strings.Join(L, "\n") + "\n"
}

// TakeoverScript hands each live profile's add-ons to the per-cluster profiles
// ConfigHub delivers. Measured on kind with Sveltos v1.15.0, for Helm charts and
// for plain resources through policyRefs: while the live profile manages them,
// each per-cluster profile waits and nothing changes. Set to LeavePolicies and
// then deleted, the live profile leaves everything in place, and each
// per-cluster profile takes it over within a minute, with the same Helm
// revisions, the same pods and the same objects.
func TakeoverScript(plan *Plan) string {
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
		fmt.Sprintf("# Hand %s to the per-cluster profiles ConfigHub delivers,", strings.Join(names, ", ")),
		"# without reinstalling anything. Run it after apply.sh:",
		"#",
		"#   MGMT_CONTEXT=<kubectl context of your management cluster> bash takeover.sh",
		"#",
		"# For each live profile it checks that every per-cluster profile has arrived,",
		"# sets the live profile to LeavePolicies so deleting it leaves its add-ons in",
		"# place, then deletes it. Each per-cluster profile then takes over the release",
		"# it was waiting for. Skipping LeavePolicies would uninstall the add-ons first.",
		"set -euo pipefail",
		`k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }`,
	}
	for _, p := range live {
		var perCluster []string
		for _, v := range p.Variants {
			perCluster = append(perCluster, v.ProfileName)
		}
		for _, m := range p.Members {
			if !m.Live {
				continue
			}
			L = append(L, "",
				"echo "+q("== "+m.Name),
				fmt.Sprintf("if ! k get clusterprofile %s >/dev/null 2>&1; then", m.Name),
				"  echo "+q(m.Name+" is already gone"),
				"else",
				fmt.Sprintf("  for profile in %s; do", strings.Join(perCluster, " ")),
				`    k get clusterprofile "$profile" >/dev/null 2>&1 || { echo "$profile has not arrived from ConfigHub yet: run apply.sh, wait a minute, run this again"; exit 1; }`,
				"  done",
				fmt.Sprintf(`  k patch clusterprofile %s --type merge -p '{"spec":{"stopMatchingBehavior":"LeavePolicies"}}'`, m.Name),
				"  sleep 20",
				fmt.Sprintf("  k delete clusterprofile %s --wait=true", m.Name),
				"fi")
		}
		for _, pm := range p.Policies {
			L = append(L, "echo "+q(fmt.Sprintf("ConfigMap %s/%s is no longer read; each variant reads its own copy. Delete it when you are ready: kubectl delete configmap -n %s %s", pm.Namespace, pm.Name, pm.Namespace, pm.Name)))
		}
	}
	L = append(L, "", "echo",
		`echo "Done. Each per-cluster profile reports Provisioned within a minute:"`,
		`echo "  kubectl get clustersummaries -A"`)
	return strings.Join(L, "\n") + "\n"
}
