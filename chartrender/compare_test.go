package chartrender

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"strings"
	"testing"
)

const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web%s
spec:
  replicas: %s
`

func TestCompare(t *testing.T) {
	manifest := "---\n# Source: web/templates/deployment.yaml\n" + strings.Replace(strings.Replace(deployment, "%s", "", 1), "%s", "3", 1) +
		"---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  ports: [{port: 80}]\n"
	// the same objects, as cub helm template printed them for the release's namespace
	stored := strings.Replace(strings.Replace(deployment, "%s", "\n  namespace: web\n  annotations: null", 1), "%s", "3", 1) +
		"---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: web\nspec:\n  ports: [{port: 80}]\n" +
		"---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: web\n" +
		"---\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: certgen\n  annotations: {helm.sh/hook: pre-install}\n" +
		"---\napiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: webs.example.com\n"
	c, err := Compare([]byte(manifest), []byte(stored), "web")
	if err != nil {
		t.Fatal(err)
	}
	if c.Same != 2 || len(c.Differences) != 0 || len(c.Notes) != 3 {
		t.Errorf("the same objects compare the same, and Helm's own gaps are notes: %+v", c)
	}

	changed := strings.Replace(stored, "replicas: 3", "replicas: 1", 1) + "---\napiVersion: monitoring.coreos.com/v1\nkind: ServiceMonitor\nmetadata:\n  name: web\n  namespace: web\n"
	withExtra := manifest + "---\napiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: web\n"
	c, err = Compare([]byte(withExtra), []byte(changed), "web")
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Join(c.Differences, "\n")
	for _, want := range []string{
		"Deployment web: spec.replicas is 3 on the cluster, 1 stored",
		"PodDisruptionBudget web: Helm installed it, and what is stored lacks it",
		"ServiceMonitor web/web: stored, and Helm did not install it, so it would be added",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("missing %q in:\n%s", want, all)
		}
	}
	if c.Same != 1 || len(c.Differences) != 3 {
		t.Errorf("one object the same, three differences: %+v", c)
	}
}

func TestReleaseManifest(t *testing.T) {
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	w.Write([]byte(`{"name":"web","manifest":"---\n# Source: web/templates/svc.yaml\napiVersion: v1\nkind: Service\n"}`))
	w.Close()
	helm := base64.StdEncoding.EncodeToString(gz.Bytes())
	api := base64.StdEncoding.EncodeToString([]byte(helm))
	got, err := ReleaseManifest(api)
	if err != nil || !strings.Contains(got, "kind: Service") {
		t.Errorf("the manifest comes out of the record: %q %v", got, err)
	}
	if _, err := ReleaseManifest("not base64!"); err == nil {
		t.Errorf("a record that is not a Helm release is an error")
	}
}
