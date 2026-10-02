package onboard

import (
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"
)

// Facts are collected from each cluster through the kubeconfig Sveltos
// reaches it with, stored on the Target of its name, and the kubeconfig file
// is removed afterwards.
func TestCollectFacts(t *testing.T) {
	kubeconfig := base64.StdEncoding.EncodeToString([]byte("apiVersion: v1\nkind: Config\n"))
	var collected []string
	var files []string
	run := func(name string, args ...string) ([]byte, error) {
		all := name + " " + strings.Join(args, " ")
		switch {
		case all == "kubectl --context mgmt get sveltosclusters -A -o json":
			return []byte(`{"items":[{"metadata":{"name":"eu-central-test1","namespace":"projectsveltos"}},{"metadata":{"name":"stray","namespace":"projectsveltos"}},{"metadata":{"name":"edge","namespace":"projectsveltos"}}]}`), nil
		case strings.HasPrefix(all, "kubectl --context mgmt get sveltoscluster -n projectsveltos eu-central-test1"):
			return []byte(`{"spec":{}}`), nil
		case strings.HasPrefix(all, "kubectl --context mgmt get sveltoscluster -n projectsveltos edge"):
			return []byte(`{"spec":{"pullMode":true}}`), nil
		case all == "kubectl --context mgmt get secret -n projectsveltos eu-central-test1-sveltos-kubeconfig -o json":
			return []byte(`{"data":{"kubeconfig":"` + kubeconfig + `"}}`), nil
		case strings.HasPrefix(all, "cub k8s collect --kubeconfig "):
			files = append(files, args[3])
			if _, err := os.Stat(args[3]); err != nil {
				t.Errorf("the kubeconfig is there while collecting: %v", err)
			}
			collected = append(collected, strings.Join(args[4:], " "))
			return []byte("Collected facts for eu-central-test1"), nil
		}
		t.Errorf("unexpected: %s", all)
		return nil, errors.New("unexpected")
	}
	hub := &fakeHub{t: t, targets: func(space string) ([]string, error) {
		if space != "mer-targets" {
			t.Errorf("the Targets are read from the Targets Space: %s", space)
		}
		return []string{"eu-central-test1", "edge"}, nil
	}}
	results, err := CollectFacts(run, hub, FactsOptions{Context: "mgmt", TargetsSpace: "mer-targets"})
	if err != nil || len(results) != 3 {
		t.Fatalf("%+v %v", results, err)
	}
	byCluster := map[string]FactsResult{}
	for _, r := range results {
		byCluster[r.Cluster] = r
	}
	if r := byCluster["projectsveltos/eu-central-test1"]; r.Skipped != "" || r.Target != "eu-central-test1" {
		t.Errorf("test1's facts are stored on its Target: %+v", r)
	}
	if len(collected) != 1 || collected[0] != "--cluster-name eu-central-test1 --space mer-targets eu-central-test1" {
		t.Errorf("one collection, onto the cluster's Target: %v", collected)
	}
	if r := byCluster["projectsveltos/stray"]; !strings.Contains(r.Skipped, "no Target stray in mer-targets") {
		t.Errorf("a cluster the plan made no Target for is skipped, and says why: %+v", r)
	}
	if r := byCluster["projectsveltos/edge"]; !strings.Contains(r.Skipped, "pull mode") {
		t.Errorf("a pull-mode cluster cannot be reached from the management cluster: %+v", r)
	}
	for _, f := range files {
		if _, err := os.Stat(f); err == nil {
			t.Errorf("the kubeconfig written for collecting is removed: %s", f)
		}
	}
}
