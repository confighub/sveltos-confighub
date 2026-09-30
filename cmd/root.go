// Package cmd is the `cub sveltos` command tree.
package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/confighub/sveltos-confighub/internal/onboard"
)

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

// Version is the plugin's version, set at release build time.
func Version() string { return version }

type planFlags struct {
	prefix       string
	stageLabel   string
	stages       string
	management   string
	profiles     string
	classLabel   string
	includeHooks string
	policy       string
	require      string
}

func (f *planFlags) register(c *cobra.Command) {
	c.Flags().StringVar(&f.prefix, "prefix", "sveltos", "prefix for everything created in ConfigHub")
	c.Flags().StringVar(&f.stageLabel, "stage-label", "", "roll out in stages by the value of this cluster label")
	c.Flags().StringVar(&f.stages, "stages", "", "the stages in order, comma-separated (with --stage-label)")
	c.Flags().StringVar(&f.management, "management", "", "the management cluster as <namespace>/<name>, if it is not mgmt/mgmt")
	c.Flags().StringVar(&f.profiles, "profiles", "", "onboard only these profiles, comma-separated")
	c.Flags().StringVar(&f.classLabel, "class-label", "", "add a class base per value of this cluster label between each base and its clusters")
	c.Flags().StringVar(&f.includeHooks, "include-hooks", "", "keep these charts' Helm hook manifests as plain objects, comma-separated release names or all")
	c.Flags().StringVar(&f.policy, "policy", "", "a trigger Filter, <space>/<filter>, whose Triggers every base and variant runs; a change that fails one is not promoted or released")
	c.Flags().StringVar(&f.require, "require", "", "attestation types each stage's release also waits for, comma-separated, such as PolicyCheck")
}

func split(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func (f *planFlags) options() onboard.Options {
	return onboard.Options{
		Prefix:       f.prefix,
		StageLabel:   f.stageLabel,
		Stages:       split(f.stages),
		Management:   f.management,
		Profiles:     split(f.profiles),
		ClassLabel:   f.classLabel,
		IncludeHooks: split(f.includeHooks),
		Gates:        onboard.Gates{Policy: f.policy, Require: split(f.require)},
	}
}

func readInputs(stdin io.Reader, inputs []string) ([]onboard.Doc, error) {
	var docs []onboard.Doc
	for _, in := range inputs {
		var data []byte
		var err error
		if in == "-" {
			data, err = io.ReadAll(stdin)
		} else {
			data, err = os.ReadFile(in)
		}
		if err != nil {
			return nil, err
		}
		parsed, err := onboard.ParseDocs(data)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", in, err)
		}
		docs = append(docs, parsed...)
	}
	return docs, nil
}

// errProblems makes the command exit non-zero after it has printed the plan.
type errProblems struct{}

func (errProblems) Error() string { return "the plan has problems to fix first" }

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:   "sveltos",
		Short: "Onboard a Sveltos fleet into ConfigHub, one variant per cluster",
		Long: `Onboard a Sveltos fleet into ConfigHub from what Sveltos already knows.

  plan   reads ClusterProfiles and the SveltosClusters they select, either the
         YAML you wrote or 'kubectl get clusterprofiles,sveltosclusters -A -o yaml',
         and shows the fleet ConfigHub would govern: one base per profile holding
         the objects its Helm charts and policy ConfigMaps render to, and one
         variant per cluster it selects. Each chart is rendered with cub helm
         template, so plan needs the cub helm plugin and the chart repositories,
         but no account and no cluster. Nothing changes.

  apply  writes the plan as files, the rendered objects among them, beside one
         script of cub and kubectl steps, apply.sh, and handover.sh when the
         profiles are live. Nothing runs until you run the script. On the
         management cluster, one delivery profile per variant then sends that
         variant's releases to its one cluster.

  compare  compares what ConfigHub released for a variant with what Helm
         installed on its cluster. handover.sh runs it before anything
         changes.

  status reports what Sveltos delivered to each cluster as ConfigHub live
         status, which a workflow's Healthy prerequisite reads.

  watch  proposes variants for each cluster that joins, and releases them
         once a person approves them in ConfigHub.

  check  runs a policy check, such as Kyverno, on a change as it stands in a
         stage, and records the verdict as an attestation its release waits
         for (plan with --require PolicyCheck).

Guide: https://github.com/confighub/sveltos-confighub/blob/main/docs/user/onboard-your-sveltos-fleet.md`,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	var pf planFlags
	plan := &cobra.Command{
		Use:   "plan <input.yaml|-> [more inputs]",
		Short: "Show the fleet ConfigHub would govern; changes nothing",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			docs, err := readInputs(c.InOrStdin(), args)
			if err != nil {
				return err
			}
			p, err := onboard.PlanFleet(docs, pf.options())
			if err != nil {
				return err
			}
			fmt.Fprint(c.OutOrStdout(), onboard.RenderPlan(p, true))
			if len(p.Problems) > 0 {
				return errProblems{}
			}
			return nil
		},
	}
	pf.register(plan)

	var af planFlags
	var out string
	apply := &cobra.Command{
		Use:   "apply <input.yaml|-> [more inputs] --out <dir>",
		Short: "Write the plan's files and apply.sh to read and run; runs nothing",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if out == "" {
				return fmt.Errorf("apply needs --out <dir> for the files and the script it writes")
			}
			docs, err := readInputs(c.InOrStdin(), args)
			if err != nil {
				return err
			}
			p, err := onboard.PlanFleet(docs, af.options())
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			if len(p.Problems) > 0 {
				fmt.Fprint(w, onboard.RenderPlan(p, true))
				return errProblems{}
			}
			script, err := onboard.WriteApply(p, out)
			if err != nil {
				return err
			}
			shown := script
			if cwd, err := os.Getwd(); err == nil {
				if rel, err := filepath.Rel(cwd, script); err == nil {
					shown = rel
				}
			}
			fmt.Fprint(w, onboard.RenderPlan(p, false))
			fmt.Fprintf(w, "\nWrote %s and the files it reads. Read it, then run it:\n  MGMT_CONTEXT=<kubectl context of your management cluster> bash %s\n", shown, shown)
			if p.Live {
				fmt.Fprintf(w, "\nThen hand the live profiles over, without reinstalling anything:\n  MGMT_CONTEXT=<same context> bash %s\n", filepath.Join(filepath.Dir(shown), "handover.sh"))
			}
			return nil
		},
	}
	af.register(apply)
	apply.Flags().StringVar(&out, "out", "", "directory for the files and the script")

	var lc onboard.LiveCheck
	var cluster, release string
	compare := &cobra.Command{
		Use:   "compare --cluster <kind>/<namespace>/<name> --release <namespace>/<name> --space <variant space> --unit <unit>",
		Short: "Compare what ConfigHub released for a variant with what Helm installed on its cluster; handover.sh runs it",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			cp := strings.SplitN(cluster, "/", 3)
			rp := strings.SplitN(release, "/", 2)
			if len(cp) != 3 || len(rp) != 2 || lc.Space == "" || lc.Unit == "" {
				return fmt.Errorf("compare needs --cluster <kind>/<namespace>/<name>, --release <namespace>/<name>, --space and --unit")
			}
			lc.ClusterKind, lc.ClusterNamespace, lc.Cluster = cp[0], cp[1], cp[2]
			lc.ReleaseNamespace, lc.Release = rp[0], rp[1]
			r, err := onboard.CompareLive(onboard.Run, lc)
			if err != nil {
				return fmt.Errorf("%s %s: %w", lc.Cluster, lc.Release, err)
			}
			w := c.OutOrStdout()
			switch {
			case r.Skipped != "":
				fmt.Fprintf(w, "%s %s: not compared: %s\n", lc.Cluster, lc.Release, r.Skipped)
			case len(r.Comparison.Differences) == 0:
				fmt.Fprintf(w, "%s %s: ConfigHub releases what Helm installed, %d objects the same\n", lc.Cluster, lc.Release, r.Comparison.Same)
			default:
				fmt.Fprintf(w, "%s %s: ConfigHub releases something other than what Helm installed, so the handover would change the cluster:\n", lc.Cluster, lc.Release)
				for _, d := range r.Comparison.Differences {
					fmt.Fprintf(w, "  - %s\n", d)
				}
			}
			for _, n := range r.Comparison.Notes {
				fmt.Fprintf(w, "  (%s)\n", n)
			}
			if len(r.Comparison.Differences) > 0 {
				return errProblems{}
			}
			return nil
		},
	}
	compare.Flags().StringVar(&lc.Context, "context", "", "kubectl context of the management cluster")
	compare.Flags().StringVar(&lc.KubeconfigDir, "kubeconfig-dir", "", "a directory of <cluster>.kubeconfig files, for clusters Sveltos reaches at an address only the management cluster can")
	compare.Flags().StringVar(&cluster, "cluster", "", "the cluster, as <kind>/<namespace>/<name>")
	compare.Flags().StringVar(&release, "release", "", "the Helm release, as <namespace>/<name>")
	compare.Flags().StringVar(&lc.Space, "space", "", "the variant's Space")
	compare.Flags().StringVar(&lc.Unit, "unit", "", "the chart's unit")

	var so onboard.StatusOptions
	var watch bool
	var interval time.Duration
	status := &cobra.Command{
		Use:   "status",
		Short: "Report what Sveltos delivered to each cluster as ConfigHub live status",
		Long: `Report what Sveltos delivered to each cluster as ConfigHub live status.

For each delivery profile on the management cluster, it reads the ClusterSummary
Sveltos keeps and the variant's published releases, and writes the variant
Space's confighub.com/live-status: Synced and Healthy once Sveltos has applied
the latest release and its workloads were available, OutOfSync while a newer
release is on its way, Degraded when Sveltos reports a failure. ConfigHub's
healthy gate and its change orders read it.

Sveltos does not report which release it fetched, so the release is worked
out: the latest one created before Sveltos last applied the profile. Health is
what Sveltos checked when it applied.

It writes only when a reading changes, or when the one ConfigHub holds is older
than --refresh.`,
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			for {
				reports, err := onboard.ReportStatus(onboard.Run, so)
				if err != nil && !watch {
					return err
				}
				if err != nil {
					fmt.Fprintln(c.ErrOrStderr(), "Error:", err)
				} else {
					printStatus(c.OutOrStdout(), reports)
				}
				if !watch {
					return nil
				}
				time.Sleep(interval)
			}
		},
	}
	status.Flags().StringVar(&so.Context, "context", "", "kubectl context of the management cluster")
	status.Flags().BoolVar(&so.DryRun, "dry-run", false, "show what would be written, and write nothing")
	status.Flags().DurationVar(&so.Refresh, "refresh", 10*time.Minute, "write an unchanged reading again once the one ConfigHub holds is this old")
	status.Flags().BoolVar(&watch, "watch", false, "keep reporting")
	status.Flags().DurationVar(&interval, "interval", 30*time.Second, "how often to report, with --watch")

	var wf planFlags
	var wo onboard.WatchOptions
	var once bool
	var every time.Duration
	watchCmd := &cobra.Command{
		Use:   "watch <profiles.yaml> --out <dir> --context <management context> [the options you planned with]",
		Short: "Propose variants for each cluster that joins, and release them once a person approves",
		Long: `Propose variants for each cluster that joins, and release them once a person approves.

It reads the SveltosClusters on the management cluster every --interval, and
plans them against the profiles apply saved, with the options the fleet was
planned with. For each cluster a profile newly selects, it writes the plan to
--out again and runs its apply.sh with PROPOSE_ONLY=1: the cluster's variants
are made, and its release waits in ConfigHub for a person to approve it.

  cub variant approve --change-order <base>/<order> --stage <stage>

It approves nothing itself. On its next look after the approval, it runs
apply.sh again, which publishes the release and applies the cluster's delivery
profile, and Sveltos delivers. A cluster no profile selects gets nothing, and is
named. Each variant it proposes records why, in its Space's
sveltos.confighub.com/joined annotation and in the release order's description;
--out/watch.log keeps what each run of apply.sh printed.`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if wo.Out == "" {
				return fmt.Errorf("watch needs --out, the directory apply wrote for this fleet")
			}
			docs, err := readInputs(c.InOrStdin(), args)
			if err != nil {
				return err
			}
			wo.Profiles, wo.Plan = docs, wf.options()
			w := onboard.NewWatcher(onboard.Run, wo)
			out, errs := c.OutOrStdout(), c.ErrOrStderr()
			last, told := "", ""
			for {
				r, err := w.Once()
				stamp := time.Now().UTC().Format(time.RFC3339)
				if err != nil {
					if err.Error() != last {
						fmt.Fprintf(errs, "%s %v\n", stamp, err)
					}
					last = err.Error()
				} else {
					last = ""
				}
				printWatch(out, stamp, r)
				// Where the fleet stands, when that changes.
				if err == nil && !r.Ran {
					state := fmt.Sprintf("%d clusters selected, %d variants: nothing to propose", r.Clusters, r.Variants)
					if len(r.Waiting) > 0 {
						state = "waiting for approval in ConfigHub: " + strings.Join(r.Waiting, ", ")
					}
					if state != told {
						fmt.Fprintf(out, "%s %s\n", stamp, state)
					}
					told = state
				}
				if r.Ran {
					told = ""
					if lerr := appendLog(filepath.Join(wo.Out, "watch.log"), stamp, r); lerr != nil {
						fmt.Fprintln(errs, "Error:", lerr)
					}
				}
				if once {
					return err
				}
				time.Sleep(every)
			}
		},
	}
	wf.register(watchCmd)
	watchCmd.Flags().StringVar(&wo.Out, "out", "", "the directory apply wrote for this fleet")
	watchCmd.Flags().StringVar(&wo.Context, "context", "", "kubectl context of the management cluster")
	watchCmd.Flags().DurationVar(&every, "interval", time.Minute, "how often to look")
	watchCmd.Flags().BoolVar(&once, "once", false, "look once, and stop")

	var co onboard.CheckOptions
	var sandboxCheck onboard.SandboxCheck
	checkCmd := &cobra.Command{
		Use:   "check --change-order <base>/<order> --stage <stage> ([--worker <space>/<worker>] <function> [arguments...] | --sandbox-kubeconfig <file> --policy <source>...)",
		Short: "Check a change as it stands in a stage, and record the verdict as an attestation its release waits for",
		Long: `Check a change as it stands in a stage, and record the verdict as an attestation.

For each variant the change order has reached in the stage, it checks exactly
the revisions the order marks there, and records the verdict as an attestation
of --type (PolicyCheck by default): a Pass, or a rejection that holds the
release until it is revoked.

It checks with a validating function, such as vet-kyverno-server, or with the
same sandbox and policies as cub sveltos impact: each object the policies
match is submitted with a server-side dry run, in a namespace labelled with the
variant's stage. The attestation then names the policy revisions it was judged
by, so the change a preview showed is released under the policies it was
previewed against.

Plan with --require PolicyCheck and each stage's release waits for a Pass. Unlike
a Trigger, which ConfigHub stops running if its worker is gone long enough,
nothing releases a change this has not passed.

  cub sveltos check --change-order sveltos-kyverno-base/owner-label --stage prod \
    --worker platform-policies/kyverno-checker vet-kyverno-server

  cub sveltos check --change-order mer-kyverno-base/six-replicas --stage test \
    --sandbox-kubeconfig sandbox.kubeconfig --policy mer-policies@Tag:in-force`,
		Args: cobra.ArbitraryArgs,
		RunE: func(c *cobra.Command, args []string) error {
			co.Function = args
			if sandboxCheck.Kubeconfig != "" || sandboxCheck.Context != "" || len(sandboxCheck.Policies) > 0 {
				if len(args) > 0 {
					return fmt.Errorf("check with a function or with the sandbox, not both")
				}
				sandboxCheck.Exec = onboard.RunWithInput
				co.Sandbox = &sandboxCheck
			}
			results, err := onboard.Check(onboard.Run, co)
			w := c.OutOrStdout()
			failed := false
			for _, r := range results {
				switch {
				case r.Skipped != "":
					fmt.Fprintf(w, "%s: not checked: %s\n", r.Space, r.Skipped)
				case r.Passed:
					fmt.Fprintf(w, "%s: passed %s; recorded a Pass (%s)\n", r.Space, strings.Join(r.Revisions, ", "), r.Recorded)
				default:
					failed = true
					fmt.Fprintf(w, "%s: FAILED on %s; recorded a rejection (%s), which holds its release:\n", r.Space, strings.Join(r.Revisions, ", "), r.Recorded)
					for _, d := range r.Details {
						fmt.Fprintf(w, "  - %s\n", d)
					}
				}
			}
			if err != nil {
				return err
			}
			if failed {
				return errProblems{}
			}
			return nil
		},
	}
	checkCmd.Flags().StringVar(&co.ChangeOrder, "change-order", "", "the change order, as <base space>/<order>")
	checkCmd.Flags().StringVar(&co.Stage, "stage", "", "the stage whose variants to check")
	checkCmd.Flags().StringVar(&co.Type, "type", "PolicyCheck", "the attestation type to record, as planned with --require")
	checkCmd.Flags().StringVar(&co.Worker, "worker", "", "the worker that runs the function, as <space>/<worker>")
	checkCmd.Flags().StringVar(&sandboxCheck.Kubeconfig, "sandbox-kubeconfig", "", "kubeconfig of the sandbox API server, to check with policies instead of a function")
	checkCmd.Flags().StringVar(&sandboxCheck.Context, "sandbox-context", "", "context in that kubeconfig")
	checkCmd.Flags().StringArrayVar(&sandboxCheck.Policies, "policy", nil, "policies to judge by: a file, or <space>[/<unit>][@<revision>] in ConfigHub, such as mer-policies@Tag:in-force; repeat for more")
	checkCmd.Flags().StringVar(&sandboxCheck.StageLabel, "stage-label", "Stage", "the Space label that gives each variant's stage, which bindings select by")
	checkCmd.Flags().DurationVar(&sandboxCheck.Settle, "settle", 5*time.Second, "how long to give the sandbox after its policies change")

	var io_ onboard.ImpactOptions
	var impactJSON, impactAll bool
	impactCmd := &cobra.Command{
		Use:   "impact --sandbox-kubeconfig <file> --policy <source>... [--candidate <source>...] [--next] [--component <c>] [--corpus <space>...] [--tests <source>...]",
		Short: "Preview what a policy change, or the next promotion, would do to each cluster, before anything ships",
		Long: `Preview what a policy change, or the next promotion, would do to each cluster.

It evaluates each target twice in a sandbox: a disposable API server that holds
policies and nothing else. Once under the policies in force, once under the
candidate. Each object a policy matches is submitted with a server-side dry run,
so the verdicts are the API server's own, and nothing is created.

  --candidate   policy files that replace the objects of the same kind, namespace
                and name: a proposed policy change, evaluated against every
                configuration already running.
  --next        each target's running configuration against what its next
                promotion brings: a proposed change, evaluated against each
                target's own policies.
  --corpus      a Space whose revisions ConfigHub recorded as failing a policy.
                They show what a weaker policy would newly allow, which the
                running configurations cannot.
  --tests       known cases: objects annotated with the stage whose policies
                they meet (impact.confighub.com/stage) and the verdict they
                expect there (impact.confighub.com/expect: denied or allowed).
                A case the policies in force get wrong is reported, and so is
                a known-bad case a candidate admits.

A policy source is a file, or policies held in ConfigHub, each at a revision:
<space>/<unit> (its head), <space>/<unit>@<n>, <space>/<unit>@Tag:<tag>, or a
whole Space, <space> or <space>@Tag:<tag>. Each result names the policy
revision behind it.

Each object is newly denied, newly allowed, unchanged, or unknown when its
verdict needs what the configuration does not hold, such as the requesting
user. A ValidatingAdmissionPolicy does not evict what runs: newly denied means
the next create or update would be refused.`,
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			r, err := onboard.Impact(onboard.RunWithInput, io_)
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			if impactJSON {
				enc := json.NewEncoder(w)
				enc.SetIndent("", "  ")
				return enc.Encode(r)
			}
			fmt.Fprintf(w, "policies in force: %s\n", strings.Join(r.Policies, ", "))
			if len(r.Candidates) > 0 {
				fmt.Fprintf(w, "candidate:         %s\n", strings.Join(r.Candidates, ", "))
			}
			if len(r.Removed) > 0 {
				fmt.Fprintf(w, "note: removed %s from the sandbox. A deleted policy can leave the parameters other policies read stale until the sandbox's API server restarts; if a result looks wrong, restart it and run again.\n", strings.Join(r.Removed, ", "))
			}
			fmt.Fprintln(w)
			tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "TARGET\tSTAGE\tCONFIG\tOBJECT\tNOW\tTHEN\tVERDICT\tPOLICY\tWHY")
			counts, targets := map[string]int{}, 0
			for _, row := range r.Rows {
				if row.Expected == "" {
					counts[row.Verdict]++
					targets++
				}
				if row.Verdict == onboard.Unchanged && !impactAll && row.Expected == "" {
					continue
				}
				config := row.Config
				if row.Candidate != "" {
					config += " -> " + row.Candidate
				}
				verdict := row.Verdict
				if row.Expected != "" {
					verdict += " (expects " + row.Expected + ")"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", row.Target, row.Stage, config, row.Object, row.Current, row.Proposed, verdict, row.Policy, row.Why)
			}
			tw.Flush()
			fmt.Fprintln(w)
			if targets > 0 {
				fmt.Fprintf(w, "%d newly denied, %d newly allowed, %d unchanged, %d unknown\n", counts[onboard.NewlyDenied], counts[onboard.NewlyAllowed], counts[onboard.Unchanged], counts[onboard.Unknown])
			}
			if len(r.Tests) > 0 {
				if len(r.FailingNow) == 0 {
					fmt.Fprintf(w, "tests: all %d cases behave as expected under the policies in force\n", len(r.Rows)-targets)
				} else {
					fmt.Fprintln(w, "tests: the policies in force get these cases wrong:")
					for _, f := range r.FailingNow {
						fmt.Fprintf(w, "  - %s\n", f)
					}
				}
				if len(r.Candidates) > 0 {
					if len(r.FailingThen) == 0 {
						fmt.Fprintln(w, "tests: every case behaves as expected under the candidate too")
					} else {
						fmt.Fprintln(w, "tests: under the candidate, these cases no longer behave as expected:")
						for _, f := range r.FailingThen {
							fmt.Fprintf(w, "  - %s\n", f)
						}
					}
				}
			}
			return nil
		},
	}
	impactCmd.Flags().StringVar(&io_.SandboxKubeconfig, "sandbox-kubeconfig", "", "kubeconfig of the sandbox API server, which holds policies and nothing else")
	impactCmd.Flags().StringVar(&io_.SandboxContext, "sandbox-context", "", "context in that kubeconfig")
	impactCmd.Flags().StringVar(&io_.Component, "component", "", "the component whose cluster variants are the targets")
	impactCmd.Flags().StringVar(&io_.StageLabel, "stage-label", "Stage", "the Space label that gives each target's stage, which bindings select by")
	impactCmd.Flags().StringArrayVar(&io_.Policies, "policy", nil, "policies in force: a file, or <space>[/<unit>][@<revision>] in ConfigHub, such as mer-policies@Tag:in-force; repeat for more")
	impactCmd.Flags().StringArrayVar(&io_.Candidates, "candidate", nil, "candidate policies, as a file or <space>/<unit>[@<revision>]; repeat for more")
	impactCmd.Flags().StringArrayVar(&io_.Tests, "tests", nil, "known cases, as a file or <space>/<unit>[@<revision>]; repeat for more")
	impactCmd.Flags().BoolVar(&io_.Next, "next", false, "compare each target's running configuration with what its next promotion brings")
	impactCmd.Flags().StringArrayVar(&io_.Corpus, "corpus", nil, "a Space whose revisions recorded as failing a policy are evaluated too")
	impactCmd.Flags().DurationVar(&io_.Settle, "settle", 5*time.Second, "how long to give the sandbox after its policies change")
	impactCmd.Flags().BoolVar(&impactJSON, "json", false, "print the results as JSON, for an assistant to explain")
	impactCmd.Flags().BoolVar(&impactAll, "all", false, "list unchanged objects too")

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print the plugin version",
		Run: func(c *cobra.Command, _ []string) {
			fmt.Fprintf(c.OutOrStdout(), "cub sveltos %s (%s, %s)\n", version, commit, date)
		},
	}

	root.AddCommand(plan, apply, compare, status, watchCmd, checkCmd, impactCmd, versionCmd)
	return root
}

// printWatch says what one look found and did.
func printWatch(w io.Writer, stamp string, r onboard.WatchReport) {
	for _, j := range r.Joins {
		labels := make([]string, 0, len(j.Labels))
		for k, v := range j.Labels {
			labels = append(labels, k+"="+v)
		}
		sort.Strings(labels)
		fmt.Fprintf(w, "%s %s joined %s (%s): proposed %s in stage %s\n", stamp, j.Cluster, j.Profile, strings.Join(labels, ", "), j.Space, j.Stage)
	}
	for _, c := range r.Unmatched {
		fmt.Fprintf(w, "%s %s: no profile selects it, so nothing is proposed\n", stamp, c)
	}
	for _, line := range strings.Split(string(r.Output), "\n") {
		created := strings.HasPrefix(line, "clusterprofile.config.projectsveltos.io/") && !strings.HasSuffix(line, " unchanged")
		if created || strings.Contains(line, "waits for approval in stage") || strings.Contains(line, "delivery profile waits") {
			fmt.Fprintf(w, "%s %s\n", stamp, line)
		}
	}
	for _, e := range r.Recorded {
		fmt.Fprintf(w, "%s could not record why: %s\n", stamp, e)
	}
}

// appendLog keeps what each run of apply.sh printed, with what it was run for.
func appendLog(path, stamp string, r onboard.WatchReport) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	fmt.Fprintf(f, "== %s PROPOSE_ONLY=1 bash apply.sh\n", stamp)
	for _, j := range r.Joins {
		doc, _ := json.Marshal(j)
		fmt.Fprintf(f, "joined: %s\n", doc)
	}
	for _, o := range r.Waiting {
		fmt.Fprintf(f, "release order: %s\n", o)
	}
	_, err = f.Write(r.Output)
	return err
}

// printStatus shows each delivery profile's reading, one line each.
func printStatus(w io.Writer, reports []onboard.StatusReport) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "CLUSTER\tSPACE\tSYNC\tHEALTH\tREVISION\tWRITTEN\tMESSAGE")
	for _, r := range reports {
		written := "yes"
		if !r.Wrote {
			written = r.Why
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", r.Cluster, r.Space, r.Status.SyncStatus, r.Status.HealthStatus,
			onboard.ShortDigest(r.Status.Revision), written, r.Status.Message)
	}
	tw.Flush()
}

// Execute runs the command tree and exits non-zero on failure.
func Execute() {
	if err := newRoot().Execute(); err != nil {
		if _, printed := err.(errProblems); !printed {
			fmt.Fprintln(os.Stderr, "Error:", err)
		}
		os.Exit(1)
	}
}
