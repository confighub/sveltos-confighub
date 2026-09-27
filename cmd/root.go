// Package cmd is the `cub sveltos` command tree.
package cmd

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

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
}

func (f *planFlags) register(c *cobra.Command) {
	c.Flags().StringVar(&f.prefix, "prefix", "sveltos", "prefix for everything created in ConfigHub")
	c.Flags().StringVar(&f.stageLabel, "stage-label", "", "roll out in stages by the value of this cluster label")
	c.Flags().StringVar(&f.stages, "stages", "", "the stages in order, comma-separated (with --stage-label)")
	c.Flags().StringVar(&f.management, "management", "", "the management cluster as <namespace>/<name>, if it is not mgmt/mgmt")
	c.Flags().StringVar(&f.profiles, "profiles", "", "onboard only these profiles, comma-separated")
	c.Flags().StringVar(&f.classLabel, "class-label", "", "add a class base per value of this cluster label between each base and its clusters")
	c.Flags().StringVar(&f.includeHooks, "include-hooks", "", "keep these charts' Helm hook manifests as plain objects, comma-separated release names or all")
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

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print the plugin version",
		Run: func(c *cobra.Command, _ []string) {
			fmt.Fprintf(c.OutOrStdout(), "cub sveltos %s (%s, %s)\n", version, commit, date)
		},
	}

	root.AddCommand(plan, apply, compare, versionCmd)
	return root
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
