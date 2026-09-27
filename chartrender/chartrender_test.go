package chartrender

import (
	"errors"
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
