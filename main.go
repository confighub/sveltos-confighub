// Command sveltos-confighub is `cub sveltos`, published as a cub CLI plugin:
//
//	cub plugin install confighub/sveltos-confighub
//	cub sveltos plan my-fleet.yaml --stage-label env --stages staging,prod
//
// It wraps what a Sveltos user does to onboard their fleet. The recorded
// chapters and their proof runners stay npm scripts: they need the source tree
// and only ever run in this repository or its CI.
package main

import (
	"fmt"
	"os"

	"github.com/confighub/sdk/core/plugin"

	"github.com/confighub/sveltos-confighub/cmd"
)

func main() {
	// cub runs this binary with the hook environment set when it installs or
	// upgrades the plugin; HandleHook writes cub-plugin.yaml, so the manifest
	// can never drift from the commands the binary implements.
	manifest := plugin.Manifest{
		Name:    "sveltos",
		Version: cmd.Version(),
		Commands: []plugin.Command{{
			Name:    "sveltos",
			Summary: "Onboard a Sveltos fleet into ConfigHub, one variant per cluster",
		}},
	}
	if handled, err := plugin.HandleHook(manifest); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	cmd.Execute()
}
