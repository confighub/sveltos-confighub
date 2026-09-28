package onboard

import (
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// A delivery profile's health checks. Sveltos runs a profile's validateHealths
// after it deploys and keeps the feature out of Provisioned until every check
// passes, so with them Provisioned means applied and running. cub sveltos
// status reads exactly that.
//
// A check selects every object of its kind in its namespace, including ones
// this profile did not deliver, so each script names the objects it is for
// and passes any other.

// workloadKinds are the kinds whose health is whether their pods are available.
var workloadKinds = map[string]string{
	"Deployment": `local want = obj.spec.replicas or 1
    local status = obj.status or {}
    if (status.observedGeneration or 0) < (obj.metadata.generation or 0) then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": rolling out"
    elseif (status.updatedReplicas or 0) < want then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": " .. (status.updatedReplicas or 0) .. " of " .. want .. " updated"
    elseif (status.availableReplicas or 0) < want then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": " .. (status.availableReplicas or 0) .. " of " .. want .. " available"
    end`,
	"StatefulSet": `local want = obj.spec.replicas or 1
    local status = obj.status or {}
    if (status.observedGeneration or 0) < (obj.metadata.generation or 0) then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": rolling out"
    elseif (status.updatedReplicas or 0) < want then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": " .. (status.updatedReplicas or 0) .. " of " .. want .. " updated"
    elseif (status.readyReplicas or 0) < want then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": " .. (status.readyReplicas or 0) .. " of " .. want .. " ready"
    end`,
	"DaemonSet": `local status = obj.status or {}
    local want = status.desiredNumberScheduled or 0
    if (status.observedGeneration or 0) < (obj.metadata.generation or 0) then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": rolling out"
    elseif (status.updatedNumberScheduled or 0) < want then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": " .. (status.updatedNumberScheduled or 0) .. " of " .. want .. " updated"
    elseif (status.numberAvailable or 0) < want then
      hs.healthy = false
      hs.message = obj.metadata.name .. ": " .. (status.numberAvailable or 0) .. " of " .. want .. " available"
    end`,
}

// healthChecks are the validateHealths entries for the workloads units hold:
// one per kind and namespace, naming the objects.
func healthChecks(units []Unit) []*yaml.Node {
	type key struct{ kind, namespace string }
	names := map[key][]string{}
	for _, u := range units {
		for _, o := range u.Objects {
			if _, ok := workloadKinds[o.Kind]; !ok || !strings.HasPrefix(o.APIVersion, "apps/") {
				continue
			}
			if _, hook := obj(obj(o.Value["metadata"])["annotations"])["helm.sh/hook"]; hook {
				continue
			}
			ns := o.Namespace
			if ns == "" && u.Chart != nil {
				ns = u.Chart.Namespace
			}
			k := key{o.Kind, ns}
			if !contains(names[k], o.Name) {
				names[k] = append(names[k], o.Name)
			}
		}
	}
	keys := make([]key, 0, len(names))
	for k := range names {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].namespace != keys[j].namespace {
			return keys[i].namespace < keys[j].namespace
		}
		return keys[i].kind < keys[j].kind
	})
	var out []*yaml.Node
	for _, k := range keys {
		sort.Strings(names[k])
		check := mapping(
			scalar("name"), scalar(strings.ToLower(k.kind)+"s-"+Slug(k.namespace)),
			scalar("featureID"), scalar("Resources"),
			scalar("group"), scalar("apps"),
			scalar("version"), scalar("v1"),
			scalar("kind"), scalar(k.kind))
		if k.namespace != "" {
			check.Content = append(check.Content, scalar("namespace"), scalar(k.namespace))
		}
		script := &yaml.Node{Kind: yaml.ScalarNode, Style: yaml.LiteralStyle, Value: healthScript(k.kind, names[k])}
		check.Content = append(check.Content, scalar("script"), script)
		out = append(out, check)
	}
	return out
}

// healthScript is the Lua Sveltos runs on each object of a kind: healthy
// unless it is one of names and its pods are not all available.
func healthScript(kind string, names []string) string {
	var set strings.Builder
	for i, n := range names {
		if i > 0 {
			set.WriteString(", ")
		}
		fmt.Fprintf(&set, "[%q] = true", n)
	}
	return fmt.Sprintf(`function evaluate()
  hs = {}
  hs.healthy = true
  hs.message = ""
  local delivered = { %s }
  if delivered[obj.metadata.name] then
    %s
  end
  return hs
end
`, set.String(), workloadKinds[kind])
}

// carriedHealthChecks are a source profile's own validateHealths. A check the
// source ran after its Helm charts runs after the delivered objects instead,
// since the delivery profile deploys them as Resources.
func carriedHealthChecks(source *yaml.Node) []*yaml.Node {
	var out []*yaml.Node
	checks := mapGet(mapGet(source, "spec"), "validateHealths")
	if checks == nil {
		return nil
	}
	for _, c := range checks.Content {
		c = deepCopy(c)
		if f := mapGet(c, "featureID"); f != nil && f.Value == "Helm" {
			f.Value = "Resources"
		}
		out = append(out, c)
	}
	return out
}
