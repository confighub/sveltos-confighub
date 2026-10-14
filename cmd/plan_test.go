package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
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

// The tests plan with no login, as a user without an account does: never as
// whoever runs them is logged in.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "cub-config")
	if err != nil {
		panic(err)
	}
	os.Setenv("CUB_CONFIG", dir)
	for _, v := range []string{"CUB_SERVER", "CUB_TOKEN", "CUB_CONTEXT"} {
		os.Unsetenv(v)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// Without a login, the profiles fetch from ConfigHub's hosted registry;
// --gateway names another, and plain HTTP marks each remoteURL plainHTTP.
func TestApplyGateway(t *testing.T) {
	profileOf := func(args ...string) string {
		t.Helper()
		out := t.TempDir()
		c := newRoot()
		c.SetArgs(append([]string{"apply", "-", "--out", out}, args...))
		c.SetIn(strings.NewReader(jsonPlanInput))
		c.SetOut(&bytes.Buffer{})
		if err := c.Execute(); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(out, "management", "app.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if s := profileOf(); !strings.Contains(s, "url: oci://oci.hub.confighub.com/space/sveltos-app-prod:latest") || strings.Contains(s, "plainHTTP") {
		t.Errorf("with no login, the hosted registry:\n%s", s)
	}
	if s := profileOf("--gateway", "http://host.docker.internal:9093"); !strings.Contains(s, "url: oci://host.docker.internal:9093/space/sveltos-app-prod:latest") || !strings.Contains(s, "plainHTTP: true") {
		t.Errorf("--gateway over plain HTTP:\n%s", s)
	}
	c := newRoot()
	c.SetArgs([]string{"plan", "-", "--gateway", "oci://nowhere"})
	c.SetIn(strings.NewReader(jsonPlanInput))
	c.SetOut(&bytes.Buffer{})
	if err := c.Execute(); err == nil || !strings.Contains(err.Error(), "--gateway") {
		t.Errorf("a gateway that is not host[:port] or http://host:port is refused: %v", err)
	}
}
