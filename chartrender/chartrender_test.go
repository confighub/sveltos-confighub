package chartrender

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExactVersion(t *testing.T) {
	for v, exact := range map[string]bool{
		"1.0.0": true, "v26.3.1": true, "1.2.3-rc.1": true, "1.2.3+build.5": true,
		"": false, "1.0": false, "1.0.x": false, "^1.0.0": false, "~1.2.3": false, ">=1.0.0": false, "latest": false,
	} {
		if ExactVersion(v) != exact {
			t.Errorf("ExactVersion(%q) = %v, want %v", v, !exact, exact)
		}
	}
}

func TestDropStrayLines(t *testing.T) {
	in := "apiVersion: v1\nkind: ServiceAccount\n---\n# Source: x/templates/svc.yaml\n" + StrayLine + "\napiVersion: v1\nkind: Service\nmetadata:\n  annotations:\n    note: '" + StrayLine + "'\n"
	want := "apiVersion: v1\nkind: ServiceAccount\n---\n# Source: x/templates/svc.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  annotations:\n    note: '" + StrayLine + "'\n"
	if got := string(DropStrayLines([]byte(in))); got != want {
		t.Errorf("only whole stray lines go, and the rest stays byte for byte:\n%s", got)
	}
	if !strings.Contains(Filter, "grep -vxF") || !strings.Contains(Filter, StrayLine) {
		t.Errorf("the recorded filter drops exactly the stray line: %s", Filter)
	}
}

func TestRenderRefusesWhatDoesNotRepeat(t *testing.T) {
	n := 0
	random := func(Chart) (Rendering, error) {
		n++
		return Rendering{Stdout: []byte("password: " + strings.Repeat("x", n) + "\n")}, nil
	}
	if _, err := Render(random, Chart{}); !errors.Is(err, ErrNotRepeatable) {
		t.Errorf("a chart that renders differently each time is refused, got %v", err)
	}
	steady := func(Chart) (Rendering, error) {
		return Rendering{
			Stdout: []byte("kind: Service\n" + StrayLine + "\nkind: Job\n"),
			Stderr: []byte("Dropped hook manifest: Job migrate (helm.sh/hook: post-upgrade)\nDropped hook manifest: Job certgen (helm.sh/hook: pre-install,pre-upgrade)\n"),
		}, nil
	}
	r, err := Render(steady, Chart{})
	if err != nil || string(r.Objects) != "kind: Service\nkind: Job\n" {
		t.Fatalf("a steady rendering comes back without the stray line: %q %v", r.Objects, err)
	}
	if len(r.Hooks) != 2 || r.Hooks[0].AtInstall() || !r.Hooks[1].AtInstall() || r.Hooks[1].String() != "Job certgen" {
		t.Errorf("the hooks left out are named, and which run at install: %+v", r.Hooks)
	}
}

func TestCommand(t *testing.T) {
	c := Chart{Release: "kyverno", Ref: "kyverno", Repo: "https://kyverno.github.io/kyverno", Version: "3.8.1", Namespace: "kyverno", Values: "a: 1", IncludeHooks: true}
	got := strings.Join(c.Command("values.yaml"), " ")
	want := "cub helm template kyverno kyverno --repo https://kyverno.github.io/kyverno --version 3.8.1 --namespace kyverno --create-namespace --include-hooks -f values.yaml"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
	if k := c.Key(); !strings.HasPrefix(k, "kyverno-3-8-1-") {
		t.Errorf("the key names the chart and version: %s", k)
	}
}

// fakeHelm puts a helm on the PATH that prints a hook only without --no-hooks,
// and a Namespace only when told to, as helm template does.
func fakeHelm(t *testing.T, withNamespace bool) {
	t.Helper()
	dir := t.TempDir()
	ns := ""
	if withNamespace {
		ns = "---\n# Source: c/templates/ns.yaml\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: apps\n"
	}
	script := "#!/usr/bin/env bash\n" +
		"printf '%s' '" + ns + "---\n# Source: c/templates/cm.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: apps\n'\n" +
		"case \" $* \" in *' --no-hooks '*) ;; *) printf '%s' '---\n# Source: c/templates/job.yaml\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: migrate\n  annotations:\n    helm.sh/hook: pre-install,pre-upgrade\n' ;; esac\n"
	if err := os.WriteFile(filepath.Join(dir, "helm"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestHelmLeavesHooksOutAndAddsTheNamespace(t *testing.T) {
	fakeHelm(t, false)
	c := Chart{Release: "app", Namespace: "apps", Ref: "oci://example.com/c", Version: "1.0.0"}
	r, err := Render(Helm, c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(r.Objects), NamespaceDoc("apps")+"---\n# Source: c/templates/cm.yaml") {
		t.Errorf("the Namespace goes first, then helm template's output:\n%s", r.Objects)
	}
	if strings.Contains(string(r.Objects), "kind: Job") {
		t.Errorf("the hook is left out:\n%s", r.Objects)
	}
	if len(r.Hooks) != 1 || r.Hooks[0].String() != "Job migrate" || !r.Hooks[0].AtInstall() {
		t.Errorf("hooks left out: %+v", r.Hooks)
	}
}

func TestHelmKeepsHooksWhenAskedAndTheChartsNamespace(t *testing.T) {
	fakeHelm(t, true)
	c := Chart{Release: "app", Namespace: "apps", Ref: "oci://example.com/c", Version: "1.0.0", IncludeHooks: true}
	r, err := Render(Helm, c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(string(r.Objects), NamespaceDoc("apps")) {
		t.Errorf("a chart that renders its Namespace gets no second one:\n%s", r.Objects)
	}
	if !strings.Contains(string(r.Objects), "kind: Job") || len(r.Hooks) != 0 {
		t.Errorf("kept hooks stay in the objects and are not reported as left out: %+v\n%s", r.Hooks, r.Objects)
	}
}

func TestHelmNeedsHelm(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if _, err := Helm(Chart{Release: "a", Namespace: "a", Ref: "a"}); err == nil || !strings.Contains(err.Error(), "needs Helm") {
		t.Errorf("without helm on the PATH: %v", err)
	}
}
