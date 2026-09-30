package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const jsonPlanInput = `apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: mgmt, namespace: mgmt}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata: {name: prod, namespace: fleet, labels: {env: prod}}
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
    kind: ConfigMap
    metadata: {name: held-object}
`

func TestPlanJSONFormatAndPlanningProblems(t *testing.T) {
	var stdout, stderr bytes.Buffer
	c := newRoot()
	c.SetArgs([]string{"plan", "-", "--format=json"})
	c.SetIn(strings.NewReader(jsonPlanInput))
	c.SetOut(&stdout)
	c.SetErr(&stderr)
	if err := c.Execute(); err != nil {
		t.Fatalf("plan: %v; stderr=%s", err, stderr.String())
	}
	var envelope map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("stdout is not only JSON: %v\n%s", err, stdout.String())
	}
	if envelope["apiVersion"] != "confighub.com/plugin-preview/v1" {
		t.Fatalf("wrong envelope: %v", envelope["apiVersion"])
	}
	stdout.Reset()
	c = newRoot()
	c.SetArgs([]string{"plan", "-", "--format=json"})
	c.SetIn(strings.NewReader(`apiVersion: v1
kind: ConfigMap
metadata: {name: unrelated}`))
	c.SetOut(&stdout)
	c.SetErr(&stderr)
	if err := c.Execute(); err == nil {
		t.Fatal("expected planning problem exit")
	}
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("planning problem did not preserve JSON stdout: %v\n%s", err, stdout.String())
	}
	if !strings.Contains(stdout.String(), `"severity": "error"`) {
		t.Fatalf("planning errors missing from envelope: %s", stdout.String())
	}
}

func TestPlanASCIIIsDefault(t *testing.T) {
	var stdout bytes.Buffer
	c := newRoot()
	c.SetArgs([]string{"plan", "-"})
	c.SetIn(strings.NewReader(jsonPlanInput))
	c.SetOut(&stdout)
	if err := c.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "Onboarding plan:") || strings.HasPrefix(strings.TrimSpace(stdout.String()), "{") {
		t.Fatalf("default output changed: %s", stdout.String())
	}
}
