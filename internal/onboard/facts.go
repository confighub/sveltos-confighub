package onboard

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FactsOptions say where the clusters and their Targets are.
type FactsOptions struct {
	// Context is the management cluster's kubectl context.
	Context string
	// TargetsSpace holds one Target per cluster, as apply made them.
	TargetsSpace string
	// KubeconfigDir holds <cluster>.kubeconfig for a cluster whose API server
	// only the management cluster reaches.
	KubeconfigDir string
	// DryRun prints the facts and stores nothing.
	DryRun bool
}

// FactsResult is one cluster's collection.
type FactsResult struct {
	Cluster, Target string
	// Output is what cub k8s collect printed; Skipped says why nothing was
	// collected.
	Output  string
	Skipped string
}

// CollectFacts stores each Sveltos cluster's facts (its Kubernetes version,
// CRDs, storage and ingress classes) on its Target, with cub k8s collect,
// reaching each cluster the way Sveltos does: through its kubeconfig Secret
// on the management cluster. ConfigHub then knows each destination.
func CollectFacts(run Runner, hub Hub, o FactsOptions) ([]FactsResult, error) {
	kubectl := func(args ...string) ([]byte, error) {
		if o.Context != "" {
			args = append([]string{"--context", o.Context}, args...)
		}
		return run("kubectl", args...)
	}
	out, err := kubectl("get", "sveltosclusters", "-A", "-o", "json")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []struct {
			Metadata struct{ Name, Namespace string }
		}
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	targets := map[string]bool{}
	if !o.DryRun {
		slugs, err := hub.TargetSlugs(o.TargetsSpace)
		if err != nil {
			return nil, fmt.Errorf("reading the Targets of %s: %w", o.TargetsSpace, err)
		}
		for _, s := range slugs {
			targets[s] = true
		}
	}
	counts := map[string]int{}
	for _, c := range list.Items {
		counts[c.Metadata.Name]++
	}
	var results []FactsResult
	for _, c := range list.Items {
		name, ns := c.Metadata.Name, c.Metadata.Namespace
		r := FactsResult{Cluster: ns + "/" + name, Target: Slug(name)}
		if counts[name] > 1 {
			r.Target = Slug(ns + "-" + name)
		}
		if !o.DryRun && !targets[r.Target] {
			r.Skipped = fmt.Sprintf("no Target %s in %s", r.Target, o.TargetsSpace)
			results = append(results, r)
			continue
		}
		path, temporary := "", false
		if o.KubeconfigDir != "" {
			if p := filepath.Join(o.KubeconfigDir, name+".kubeconfig"); fileExists(p) {
				path = p
			}
		}
		if path == "" {
			p, done, err := sveltosKubeconfig(kubectl, LiveCheck{Context: o.Context, Cluster: name, ClusterNamespace: ns, ClusterKind: "SveltosCluster"})
			if err != nil {
				return results, fmt.Errorf("%s: %w", r.Cluster, err)
			}
			if done.Skipped != "" {
				r.Skipped = done.Skipped
				results = append(results, r)
				continue
			}
			path, temporary = p, true
		}
		args := []string{"k8s", "collect", "--kubeconfig", path, "--cluster-name", name}
		if o.DryRun {
			args = append(args, "--dry-run")
		} else {
			args = append(args, "--space", o.TargetsSpace, r.Target)
		}
		out, err := run("cub", args...)
		if temporary {
			os.Remove(path)
		}
		if err != nil {
			r.Skipped = fmt.Sprintf("could not collect: %v. If the cluster's API server is at an address only the management cluster reaches, put a kubeconfig that reaches it at <dir>/%s.kubeconfig and pass --kubeconfigs <dir>", err, name)
		} else {
			r.Output = strings.TrimSpace(string(out))
		}
		results = append(results, r)
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Cluster < results[j].Cluster })
	return results, nil
}
