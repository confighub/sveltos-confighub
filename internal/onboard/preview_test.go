package onboard

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const previewFixture = `apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: mgmt, namespace: mgmt}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: prod-a, namespace: fleet, labels: {env: prod}}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: app}
spec:
  clusterSelector: {matchLabels: {env: prod}}
  policyRefs: [{kind: ConfigMap, name: policies, namespace: default}]
---
apiVersion: v1
kind: ConfigMap
metadata: {name: policies, namespace: default}
data:
  policy.yaml: |
    apiVersion: v1
    kind: Secret
    metadata: {name: private}
    data: {token: super-secret}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: spare, namespace: fleet}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: spare-profile}
spec: {clusterSelector: {matchLabels: {env: dev}}}
`

func TestBuildPreviewStableAndBounded(t *testing.T) {
	docs, err := ParseDocs([]byte(previewFixture))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanFleet(docs, Options{Prefix: "demo", Profiles: []string{"app"}})
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 9, 30, 12, 34, 56, 0, time.UTC)
	one, err := BuildPreview(docs, plan, stamp, "1.2.3", Options{Profiles: []string{"app"}})
	if err != nil {
		t.Fatal(err)
	}
	for i, j := 0, len(docs)-1; i < j; i, j = i+1, j-1 {
		docs[i], docs[j] = docs[j], docs[i]
	}
	plan2, err := PlanFleet(docs, Options{Prefix: "demo", Profiles: []string{"app"}})
	if err != nil {
		t.Fatal(err)
	}
	two, err := BuildPreview(docs, plan2, stamp, "1.2.3", Options{Profiles: []string{"app"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(one) != string(two) {
		t.Fatalf("export changed with input order\n%s\n!=\n%s", one, two)
	}
	var got Preview
	if err := json.Unmarshal(one, &got); err != nil {
		t.Fatal(err)
	}
	if got.APIVersion != PreviewAPIVersion || got.Kind != "PluginPreview" || len(got.Capabilities) != 1 || got.Capabilities[0] != "preview" {
		t.Fatalf("bad contract header: %+v", got)
	}
	if !strings.Contains(string(one), "profile_filtered") || !strings.Contains(string(one), "cluster_unselected") {
		t.Fatalf("missing filtered/unselected issue: %s", one)
	}
	if strings.Contains(string(one), "super-secret") {
		t.Fatalf("raw ConfigMap content leaked: %s", one)
	}
}

func TestBuildPreviewProblemsAndPartialInventory(t *testing.T) {
	docs, err := ParseDocs([]byte(`apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: no-clusters}
spec: {clusterSelector: {matchLabels: {env: prod}}}`))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanFleet(docs, Options{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := BuildPreview(docs, plan, time.Unix(0, 0), "dev", Options{})
	if err != nil {
		t.Fatal(err)
	}
	var got Preview
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Inventory.Nodes) != 1 || len(got.Issues) == 0 {
		t.Fatalf("expected partial input inventory and planner problems: %+v", got)
	}
	if got.Inventory.Nodes[0].Details["disposition"] != "skipped: selects no cluster today, so there is nothing to govern yet" {
		t.Fatalf("unexpected disposition: %+v", got.Inventory.Nodes[0])
	}
	if got.Inventory.Edges == nil || got.Proposal.Edges == nil {
		t.Fatalf("empty graph arrays must be arrays: %s", b)
	}
}

func TestBuildPreviewSelectorSemantics(t *testing.T) {
	docs, err := ParseDocs([]byte(`apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: one, namespace: ns, labels: {env: prod, zone: east}}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: selector}
spec:
  clusterSelector:
    matchExpressions: [{key: env, operator: In, values: [prod]}]
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: explicit}
spec: {clusterRefs: [{apiVersion: lib.projectsveltos.io/v1beta1, kind: SveltosCluster, namespace: ns, name: one}]}`))
	if err != nil {
		t.Fatal(err)
	}
	plan := &Plan{TargetsSpace: "x-targets"}
	b, err := BuildPreview(docs, plan, time.Unix(0, 0), "dev", Options{})
	if err != nil {
		t.Fatal(err)
	}
	var got Preview
	_ = json.Unmarshal(b, &got)
	if len(got.Inventory.Edges) != 2 {
		t.Fatalf("selector and explicit reference should each produce a selects edge: %+v", got.Inventory.Edges)
	}
}

func TestBuildPreviewMissingNamespaceUsesPlannerIdentity(t *testing.T) {
	docs, err := ParseDocs([]byte(`apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: mgmt, namespace: mgmt}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: app, labels: {env: prod}}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: app-profile}
spec: {clusterSelector: {matchLabels: {env: prod}}, policyRefs: [{kind: ConfigMap, name: policies, namespace: default}]}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: policies, namespace: default}
data:
  object.yaml: |
    apiVersion: v1
    kind: ConfigMap
    metadata: {name: payload}
`))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanFleet(docs, Options{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := BuildPreview(docs, plan, time.Unix(0, 0), "dev", Options{})
	if err != nil {
		t.Fatal(err)
	}
	var got Preview
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, node := range got.Inventory.Nodes {
		if node.ID == "SveltosCluster:default/app" && node.Namespace == "default" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing namespace did not use the planner's default identity: %+v", got.Inventory.Nodes)
	}
}

func TestPreviewUsesPlannerUnionAndRecordedMatches(t *testing.T) {
	input := `apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: one, namespace: ns, labels: {env: prod}}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: two, namespace: ns}
---
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: union}
spec:
  clusterSelector: {matchLabels: {env: prod}}
  clusterRefs: [{kind: SveltosCluster, namespace: ns, name: two}]
`
	for _, recorded := range []bool{false, true} {
		data := input
		if recorded {
			data += "status:\n  matchingClusters: [{kind: SveltosCluster, namespace: ns, name: two}]\n"
		}
		docs, err := ParseDocs([]byte(data))
		if err != nil {
			t.Fatal(err)
		}
		b, err := BuildPreview(docs, &Plan{TargetsSpace: "targets", Notes: []string{"A planner limitation"}}, time.Unix(0, 0), "test", Options{})
		if err != nil {
			t.Fatal(err)
		}
		var p Preview
		if err = json.Unmarshal(b, &p); err != nil {
			t.Fatal(err)
		}
		expected := 2
		if recorded {
			expected = 1
		}
		if len(p.Inventory.Edges) != expected {
			t.Fatalf("recorded=%v: %+v", recorded, p.Inventory.Edges)
		}
		if recorded && p.Inventory.Edges[0].Relation != "records-match" {
			t.Fatal("must label recorded basis")
		}
		if !strings.Contains(string(b), "planner_note") || !strings.Contains(string(b), "selector") {
			t.Fatal("lost input evidence")
		}
	}
}

func TestPreviewProposalContainsManagementAndVariantUnits(t *testing.T) {
	docs, err := ParseDocs([]byte(previewFixture))
	if err != nil {
		t.Fatal(err)
	}
	p, err := PlanFleet(docs, Options{Profiles: []string{"app"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := BuildPreview(docs, p, time.Unix(0, 0), "test", Options{})
	if err != nil {
		t.Fatal(err)
	}
	var preview Preview
	if err = json.Unmarshal(b, &preview); err != nil {
		t.Fatal(err)
	}
	nodes := map[string]bool{}
	for _, n := range preview.Proposal.Nodes {
		nodes[n.ID] = true
	}
	if p.Management == nil || !nodes["space:"+p.Management.Space] {
		t.Fatal("missing management")
	}
	for _, profile := range p.Profiles {
		for _, v := range profile.Variants {
			for _, u := range profile.Units {
				if !nodes["unit:"+v.Space+"/"+u.Slug] {
					t.Fatal("missing variant unit")
				}
			}
		}
	}
	for _, e := range preview.Proposal.Edges {
		if !nodes[e.From] || !nodes[e.To] {
			t.Fatalf("dangling edge %+v", e)
		}
	}
}
