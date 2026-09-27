package onboard

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type workerEntity struct {
	Slug         string `json:"Slug"`
	OrgRole      string `json:"OrgRole"`
	ProvidedInfo struct {
		IsServerWorker   bool `json:"IsServerWorker"`
		BridgeWorkerInfo struct {
			SupportedConfigTypes []struct {
				ProviderType  string `json:"ProviderType"`
				ToolchainType string `json:"ToolchainType"`
			} `json:"SupportedConfigTypes"`
		} `json:"BridgeWorkerInfo"`
	} `json:"ProvidedInfo"`
}

// The Targets' worker: hosted by ConfigHub, with no process behind it and no
// role in the organization, able to hold OCI Targets.
func workerJSON() []byte {
	var w workerEntity
	w.Slug = workerSlug
	w.OrgRole = "none"
	w.ProvidedInfo.IsServerWorker = true
	w.ProvidedInfo.BridgeWorkerInfo.SupportedConfigTypes = []struct {
		ProviderType  string `json:"ProviderType"`
		ToolchainType string `json:"ToolchainType"`
	}{{ProviderType: "OCI", ToolchainType: "Any"}}
	out, _ := json.MarshalIndent(w, "", "  ")
	return append(out, '\n')
}

type outFile struct {
	rel  string
	data []byte
	mode os.FileMode
}

// WriteApply writes the plan, the files apply.sh reads, apply.sh itself, and
// takeover.sh when profiles are live. It runs nothing.
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
	var sources []any
	for _, p := range plan.Profiles {
		for _, m := range p.Members {
			sources = append(sources, m.Source)
		}
	}
	profilesYAML, err := EncodeYAML(sources...)
	if err != nil {
		return "", err
	}
	files := []outFile{
		{"plan.txt", []byte(RenderPlan(plan, true)), 0o644},
		{"worker.json", workerJSON(), 0o644},
		{"profiles.yaml", profilesYAML, 0o644},
	}
	for _, p := range plan.Profiles {
		// The base is stored as YAML: ConfigHub lines each variant up with its
		// base by the stored document, and a JSON base would not line up.
		base, err := EncodeYAML(p.Base)
		if err != nil {
			return "", err
		}
		files = append(files,
			outFile{p.Name + "/base.yaml", base, 0o644},
			outFile{p.Name + "/change-workflow.yaml", []byte(p.WorkflowText), 0o644})
		for _, pm := range p.Policies {
			data, err := EncodeYAML(pm.Base)
			if err != nil {
				return "", err
			}
			files = append(files, outFile{p.Name + "/" + pm.Unit + ".yaml", data, 0o644})
		}
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
		}
	}
	files = append(files, outFile{"apply.sh", []byte(ApplyScript(plan)), 0o755})
	if plan.Live {
		files = append(files, outFile{"takeover.sh", []byte(TakeoverScript(plan)), 0o755})
	}
	for _, f := range files {
		if err := write(f.rel, f.data, f.mode); err != nil {
			return "", err
		}
	}
	return filepath.Join(dir, "apply.sh"), nil
}

// VariantValue is the variant's document as ConfigHub will hold it after its
// departures: the base with its own name, its cluster, and its dependencies.
func VariantValue(p Profile, v Variant) (map[string]any, error) {
	data, err := yaml.Marshal(p.BaseValue)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := yaml.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	obj(out["metadata"])["name"] = v.ProfileName
	spec := obj(out["spec"])
	spec["clusterRefs"] = []any{map[string]any{"apiVersion": v.ClusterRef.APIVersion, "kind": v.ClusterRef.Kind, "namespace": v.ClusterRef.Namespace, "name": v.ClusterRef.Name}}
	for i, vp := range v.Policies {
		for _, r := range list(spec["policyRefs"]) {
			ref := obj(r)
			if str(ref["kind"]) == "ConfigMap" && str(ref["namespace"]) == p.Policies[i].Namespace && str(ref["name"]) == p.Policies[i].Name {
				ref["name"] = vp.Name
			}
		}
	}
	if len(v.DependsOn) > 0 {
		deps := make([]any, len(v.DependsOn))
		for i, d := range v.DependsOn {
			deps[i] = d
		}
		spec["dependsOn"] = deps
	}
	return out, nil
}
