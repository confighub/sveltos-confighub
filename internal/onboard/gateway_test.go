package onboard

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseGateway(t *testing.T) {
	for in, want := range map[string]Gateway{
		"oci.example.com":                   {Host: "oci.example.com"},
		"oci.example.com:8443":              {Host: "oci.example.com:8443"},
		"https://oci.example.com":           {Host: "oci.example.com"},
		"http://host.docker.internal:9093":  {Host: "host.docker.internal:9093", PlainHTTP: true},
		"http://host.docker.internal:9093/": {Host: "host.docker.internal:9093", PlainHTTP: true},
		"[fd00::1]:5000":                    {Host: "[fd00::1]:5000"},
	} {
		got, err := ParseGateway(in)
		if err != nil || got != want {
			t.Errorf("ParseGateway(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, in := range []string{"", "oci://oci.example.com", "http://", "oci.example.com/space", "http://h:9093/space/x", "h:port", "h:70000"} {
		if g, err := ParseGateway(in); err == nil {
			t.Errorf("ParseGateway(%q) = %+v, want an error", in, g)
		}
	}
}

func TestResolveGateway(t *testing.T) {
	never := func() (*Registry, error) { t.Fatal("--gateway given, so ConfigHub is not asked"); return nil, nil }
	if g, err := ResolveGateway("http://host.docker.internal:9093", never); err != nil || g != (Gateway{Host: "host.docker.internal:9093", PlainHTTP: true}) {
		t.Errorf("--gateway: %+v, %v", g, err)
	}
	advertises := func(r *Registry, err error) func() (*Registry, error) {
		return func() (*Registry, error) { return r, err }
	}
	for name, c := range map[string]struct {
		registry *Registry
		want     Gateway
	}{
		"no login, so no account":    {nil, Gateway{Host: DefaultGatewayHost}},
		"hosted, at 443":             {&Registry{Server: "https://hub.confighub.com", Host: "oci.hub.confighub.com", Port: "443"}, Gateway{Host: "oci.hub.confighub.com"}},
		"another port":               {&Registry{Server: "https://hub.example.com", Host: "oci.example.com", Port: "8443"}, Gateway{Host: "oci.example.com:8443"}},
		"plain HTTP like its server": {&Registry{Server: "http://confighub.internal:9090", Host: "confighub.internal", Port: "9093"}, Gateway{Host: "confighub.internal:9093", PlainHTTP: true}},
	} {
		g, err := ResolveGateway("", advertises(c.registry, nil))
		if err != nil || g != c.want {
			t.Errorf("%s: %+v, %v; want %+v", name, g, err, c.want)
		}
	}
	for _, host := range []string{"127.0.0.1", "localhost", "::1", "hub.localhost"} {
		_, err := ResolveGateway("", advertises(&Registry{Server: "http://127.0.0.1:9090", Host: host, Port: "9093"}, nil))
		if err == nil || !strings.Contains(err.Error(), "--gateway http://host.docker.internal:9093") {
			t.Errorf("a loopback registry (%s) cannot be reached from the clusters, and the error shows what to pass: %v", host, err)
		}
	}
	if _, err := ResolveGateway("", advertises(nil, errors.New("connection refused"))); err == nil || !strings.Contains(err.Error(), "--gateway") {
		t.Errorf("a login whose server cannot be asked is an error naming --gateway, not the hosted registry: %v", err)
	}
	if _, err := ResolveGateway("", advertises(&Registry{Server: "https://hub.example.com"}, nil)); err == nil {
		t.Errorf("a server that names no registry is an error")
	}
}

// Every profile the plan writes fetches from its gateway, over plain HTTP
// when the gateway says so, and a profile that fetches from it is recognised
// as ConfigHub's own.
func TestPlanGateway(t *testing.T) {
	opts := exampleOpts
	opts.ManagementRelease = true
	opts.Gateway = Gateway{Host: "host.docker.internal:9093", PlainHTTP: true}
	plan := mustPlan(t, exampleDocs(t), opts)
	if plan.Gateway != opts.Gateway {
		t.Fatalf("the plan holds its gateway: %+v", plan.Gateway)
	}
	dir := t.TempDir()
	if _, err := WriteApply(plan, dir); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"management/root.yaml", "management/variants/sveltos-kyverno-staging-eu.yaml"} {
		data, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			t.Fatal(err)
		}
		s := string(data)
		if strings.Contains(s, DefaultGatewayHost) || !strings.Contains(s, "url: oci://host.docker.internal:9093/space/") || !strings.Contains(s, "plainHTTP: true") {
			t.Errorf("%s fetches from the plan's gateway over plain HTTP:\n%s", rel, s)
		}
	}
	script, _ := os.ReadFile(filepath.Join(dir, "apply.sh"))
	if !strings.Contains(string(script), "oci://host.docker.internal:9093/space/<space>:latest") {
		t.Errorf("apply.sh names the gateway")
	}

	tls := exampleOpts
	tls.Gateway = Gateway{Host: "oci.example.com"}
	for _, set := range mustPlan(t, exampleDocs(t), tls).Management.ByProfile {
		for _, p := range set.Profiles {
			if s := yamlText(t, p); strings.Contains(s, "plainHTTP") || !strings.Contains(s, "url: oci://oci.example.com/space/") {
				t.Errorf("a TLS gateway's profile has no plainHTTP:\n%s", s)
			}
		}
	}

	delivered := mgmt + cluster("a", "projectsveltos", "env", "prod") + `apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata: {name: p-a}
spec:
  clusterRefs: [{kind: SveltosCluster, namespace: projectsveltos, name: a}]
  policyRefs: [{deploymentType: Remote, remoteURL: {url: "oci://host.docker.internal:9093/space/sveltos-p-a:latest", plainHTTP: true}}]
`
	local := mustPlan(t, parse(t, delivered), Options{Gateway: opts.Gateway})
	if len(local.Profiles) != 0 || !strings.Contains(strings.Join(local.Notes, " "), "already come from ConfigHub") {
		t.Errorf("a profile that fetches from the plan's gateway is ConfigHub's already: %v %v", local.Profiles, local.Notes)
	}
	hosted := mustPlan(t, parse(t, delivered), Options{})
	if len(hosted.Profiles) != 1 {
		t.Errorf("one that fetches from another registry is not")
	}
}

func yamlText(t *testing.T, n any) string {
	t.Helper()
	out, err := EncodeYAML(n)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}
