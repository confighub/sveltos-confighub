package onboard

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type outFile struct {
	rel  string
	data []byte
	mode os.FileMode
}

// WriteApply writes the plan, the files apply.sh reads, apply.sh itself, and
// handover.sh when profiles are live. It runs nothing.
func WriteApply(plan *Plan, dir string) (string, error) {
	if len(plan.Problems) > 0 {
		return "", fmt.Errorf("the plan has problems to fix first:\n  - %s", strings.Join(plan.Problems, "\n  - "))
	}
	write := func(rel string, data []byte, mode os.FileMode) error {
		path := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return os.WriteFile(path, data, mode)
	}
	// profiles.yaml keeps every profile as its owner wrote it, with the
	// ConfigMaps it names, so a joining cluster is planned from it and a
	// fresh cluster list alone.
	var sources []any
	for _, p := range plan.Profiles {
		for _, m := range p.Members {
			sources = append(sources, m.Source)
		}
		for _, d := range p.PolicyMaps {
			sources = append(sources, configMapSource(d))
		}
	}
	profilesYAML, err := EncodeYAML(sources...)
	if err != nil {
		return "", err
	}
	files := []outFile{
		{"plan.txt", []byte(RenderPlan(plan, true)), 0o644},
		{"profiles.yaml", profilesYAML, 0o644},
	}
	for _, p := range plan.Profiles {
		for _, u := range p.Units {
			data, err := u.Text()
			if err != nil {
				return "", err
			}
			files = append(files, outFile{p.Name + "/" + u.Slug + ".yaml", data, 0o644})
			if u.Chart != nil && u.Chart.Values != "" {
				files = append(files, outFile{valuesFile(p, u), []byte(u.Chart.Values), 0o644})
			}
		}
		files = append(files, outFile{p.Name + "/change-workflow.yaml", []byte(p.WorkflowText), 0o644})
	}
	if m := plan.Management; m != nil {
		for _, b := range m.ByProfile {
			docs := make([]any, len(b.Profiles))
			for i := range b.Profiles {
				docs[i] = b.Profiles[i]
			}
			data, err := EncodeYAML(docs...)
			if err != nil {
				return "", err
			}
			files = append(files, outFile{"management/" + b.Profile + ".yaml", data, 0o644})
			if len(b.Health) > 0 {
				health := make([]any, len(b.Health))
				for i := range b.Health {
					health[i] = b.Health[i]
				}
				data, err := EncodeYAML(health...)
				if err != nil {
					return "", err
				}
				files = append(files, outFile{"management/" + b.Profile + "-health.yaml", data, 0o644})
			}
		}
		if m.Root != nil {
			data, err := EncodeYAML(m.Root)
			if err != nil {
				return "", err
			}
			files = append(files, outFile{"management/root.yaml", data, 0o644})
			// One file per variant, so the record can take a variant's delivery
			// profile once that variant has a release.
			for _, b := range m.ByProfile {
				for i, space := range b.Spaces {
					data, err := EncodeYAML(b.Profiles[i])
					if err != nil {
						return "", err
					}
					files = append(files, outFile{"management/variants/" + space + ".yaml", data, 0o644})
				}
			}
		}
	}
	files = append(files, outFile{"apply.sh", []byte(ApplyScript(plan)), 0o755})
	if plan.Live {
		files = append(files, outFile{"handover.sh", []byte(HandoverScript(plan)), 0o755})
	}
	for _, f := range files {
		if err := write(f.rel, f.data, f.mode); err != nil {
			return "", err
		}
	}
	return filepath.Join(dir, "apply.sh"), nil
}
