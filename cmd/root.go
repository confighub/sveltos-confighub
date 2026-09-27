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
	prefix     string
	stageLabel string
	stages     string
	management string
	profiles   string
	classLabel string
}

func (f *planFlags) register(c *cobra.Command) {
	c.Flags().StringVar(&f.prefix, "prefix", "sveltos", "prefix for everything created in ConfigHub")
	c.Flags().StringVar(&f.stageLabel, "stage-label", "", "roll out in stages by the value of this cluster label")
	c.Flags().StringVar(&f.stages, "stages", "", "the stages in order, comma-separated (with --stage-label)")
	c.Flags().StringVar(&f.management, "management", "", "the management cluster as <namespace>/<name>, if it is not mgmt/mgmt")
	c.Flags().StringVar(&f.profiles, "profiles", "", "onboard only these profiles, comma-separated")
	c.Flags().StringVar(&f.classLabel, "class-label", "", "add a class base per value of this cluster label between each base and its clusters")
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
		Prefix:     f.prefix,
		StageLabel: f.stageLabel,
		Stages:     split(f.stages),
		Management: f.management,
		Profiles:   split(f.profiles),
		ClassLabel: f.classLabel,
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
         and shows the fleet ConfigHub would govern: one base per profile, and one
         variant per cluster it selects, addressed to that one cluster. Offline:
         no account, no cluster, nothing changes.

  apply  writes the plan as files beside one script of cub and kubectl steps,
         apply.sh, and takeover.sh when the profiles are live. Nothing runs until
         you run the script.

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
				fmt.Fprintf(w, "\nThen hand the live profiles over, without reinstalling anything:\n  MGMT_CONTEXT=<same context> bash %s\n", filepath.Join(filepath.Dir(shown), "takeover.sh"))
			}
			return nil
		},
	}
	af.register(apply)
	apply.Flags().StringVar(&out, "out", "", "directory for the files and the script")

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print the plugin version",
		Run: func(c *cobra.Command, _ []string) {
			fmt.Fprintf(c.OutOrStdout(), "cub sveltos %s (%s, %s)\n", version, commit, date)
		},
	}

	root.AddCommand(plan, apply, versionCmd)
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
