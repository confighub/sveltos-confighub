package onboard

import (
	"encoding/json"
	"strings"
	"testing"

	lua "github.com/yuin/gopher-lua"
)

// evaluate runs a health script the way Sveltos does: obj set to the
// object's content, evaluate() called, healthy and message read back.
func evaluate(t *testing.T, script, object string) (bool, string) {
	t.Helper()
	var content map[string]any
	if err := json.Unmarshal([]byte(object), &content); err != nil {
		t.Fatal(err)
	}
	l := lua.NewState()
	defer l.Close()
	if err := l.DoString(script); err != nil {
		t.Fatalf("the script does not load: %v\n%s", err, script)
	}
	obj := toLua(content)
	l.SetGlobal("obj", obj)
	if err := l.CallByParam(lua.P{Fn: l.GetGlobal("evaluate"), NRet: 1, Protect: true}, obj); err != nil {
		t.Fatalf("evaluate fails: %v", err)
	}
	result, ok := l.Get(-1).(*lua.LTable)
	if !ok {
		t.Fatalf("evaluate returns no table")
	}
	return lua.LVAsBool(result.RawGetString("healthy")), lua.LVAsString(result.RawGetString("message"))
}

func toLua(v any) lua.LValue {
	switch x := v.(type) {
	case map[string]any:
		t := &lua.LTable{}
		for k, e := range x {
			t.RawSetString(k, toLua(e))
		}
		return t
	case []any:
		t := &lua.LTable{}
		for _, e := range x {
			t.Append(toLua(e))
		}
		return t
	case float64:
		return lua.LNumber(x)
	case string:
		return lua.LString(x)
	case bool:
		return lua.LBool(x)
	}
	return lua.LNil
}

func TestHealthScripts(t *testing.T) {
	deploy := func(name string, gen, observed, replicas, updated, available int) string {
		return `{"metadata":{"name":"` + name + `","generation":` + itoa(gen) + `},"spec":{"replicas":` + itoa(replicas) +
			`},"status":{"observedGeneration":` + itoa(observed) + `,"updatedReplicas":` + itoa(updated) + `,"availableReplicas":` + itoa(available) + `}}`
	}
	d := healthScript("Deployment", []string{"kyverno-admission-controller", "kyverno-reports-controller"})
	for _, c := range []struct {
		name, object string
		healthy      bool
		message      string
	}{
		{"available", deploy("kyverno-admission-controller", 2, 2, 3, 3, 3), true, ""},
		{"short of replicas", deploy("kyverno-admission-controller", 2, 2, 3, 3, 1), false, "kyverno-admission-controller: 1 of 3 available"},
		{"rolling out", deploy("kyverno-admission-controller", 3, 2, 3, 3, 3), false, "kyverno-admission-controller: rolling out"},
		{"old pods still serving", deploy("kyverno-reports-controller", 2, 2, 3, 1, 3), false, "kyverno-reports-controller: 1 of 3 updated"},
		{"scaled to zero", deploy("kyverno-admission-controller", 1, 1, 0, 0, 0), true, ""},
		{"not delivered by this profile", deploy("someone-else", 2, 1, 3, 0, 0), true, ""},
	} {
		healthy, message := evaluate(t, d, c.object)
		if healthy != c.healthy || message != c.message {
			t.Errorf("Deployment %s: got %v %q, want %v %q", c.name, healthy, message, c.healthy, c.message)
		}
	}
	s := healthScript("StatefulSet", []string{"db"})
	if ok, msg := evaluate(t, s, `{"metadata":{"name":"db","generation":1},"spec":{"replicas":2},"status":{"observedGeneration":1,"updatedReplicas":2,"readyReplicas":1}}`); ok || msg != "db: 1 of 2 ready" {
		t.Errorf("StatefulSet short of ready replicas: %v %q", ok, msg)
	}
	ds := healthScript("DaemonSet", []string{"nvidia-device-plugin"})
	if ok, _ := evaluate(t, ds, `{"metadata":{"name":"nvidia-device-plugin","generation":1},"spec":{},"status":{"observedGeneration":1,"desiredNumberScheduled":0}}`); !ok {
		t.Errorf("a DaemonSet no node wants, like the GPU operator's on a node without GPUs, is healthy")
	}
	if ok, msg := evaluate(t, ds, `{"metadata":{"name":"nvidia-device-plugin","generation":1},"spec":{},"status":{"observedGeneration":1,"desiredNumberScheduled":3,"updatedNumberScheduled":3,"numberAvailable":2}}`); ok || msg != "nvidia-device-plugin: 2 of 3 available" {
		t.Errorf("DaemonSet short: %v %q", ok, msg)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// Every workload a chart delivers is checked, by name, in its namespace; the
// source's own checks come first, and a Helm-time check runs after Resources.
func TestDeliveryProfilesCheckHealth(t *testing.T) {
	plan := mustPlan(t, exampleDocs(t), exampleOpts)
	var kyverno string
	for _, set := range plan.Management.ByProfile {
		if set.Profile == "kyverno" {
			out, _ := EncodeYAML(set.Profiles[0])
			kyverno = string(out)
		}
	}
	for _, want := range []string{"validateHealths:", "name: deployments-kyverno", "featureID: Resources", "kind: Deployment", "namespace: kyverno", `["kyverno-admission-controller"] = true`} {
		if !strings.Contains(kyverno, want) {
			t.Errorf("kyverno's delivery profile should carry %q:\n%s", want, kyverno)
		}
	}
	source := parse(t, "apiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p}\nspec:\n  validateHealths:\n  - {name: mine, featureID: Helm, group: apps, version: v1, kind: Deployment, script: x}\n")[0].Node
	carried := carriedHealthChecks(source)
	if len(carried) != 1 || mapGet(carried[0], "featureID").Value != "Resources" {
		t.Errorf("a source's Helm-time check runs after the delivered Resources instead")
	}
}
