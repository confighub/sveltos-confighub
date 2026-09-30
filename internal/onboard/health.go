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

// workload names the objects of one kind in one namespace that units deliver.
type workload struct{ kind, namespace string }

// deliveredWorkloads are the Deployments, StatefulSets and DaemonSets units
// hold, by kind and namespace, leaving out Helm hooks.
func deliveredWorkloads(units []Unit) ([]workload, map[workload][]string) {
	names := map[workload][]string{}
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
			k := workload{o.Kind, ns}
			if !contains(names[k], o.Name) {
				names[k] = append(names[k], o.Name)
			}
		}
	}
	keys := make([]workload, 0, len(names))
	for k := range names {
		sort.Strings(names[k])
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].namespace != keys[j].namespace {
			return keys[i].namespace < keys[j].namespace
		}
		return keys[i].kind < keys[j].kind
	})
	return keys, names
}

// healthChecks are the validateHealths entries for the workloads units hold:
// one per kind and namespace, naming the objects.
func healthChecks(units []Unit) []*yaml.Node {
	keys, names := deliveredWorkloads(units)
	var out []*yaml.Node
	for _, k := range keys {
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

// ProfileLabel names, on a profile's continuous health check, the profile it
// watches.
const ProfileLabel = "sveltos.confighub.com/profile"

// liveKinds judge a workload at any time, not only when Sveltos deploys it:
// Progressing while it rolls out, Degraded once it has rolled out and too few
// of its pods are available.
var liveKinds = map[string]string{
	"Deployment": `local want = obj.spec.replicas or 1
        local st = obj.status or {}
        if (st.observedGeneration or 0) < (obj.metadata.generation or 0) or (st.updatedReplicas or 0) < want then
          status, message = "Progressing", obj.metadata.name .. ": rolling out"
        elseif (st.availableReplicas or 0) < want then
          status, message = "Degraded", obj.metadata.name .. ": " .. (st.availableReplicas or 0) .. " of " .. want .. " available"
        end`,
	"StatefulSet": `local want = obj.spec.replicas or 1
        local st = obj.status or {}
        if (st.observedGeneration or 0) < (obj.metadata.generation or 0) or (st.updatedReplicas or 0) < want then
          status, message = "Progressing", obj.metadata.name .. ": rolling out"
        elseif (st.readyReplicas or 0) < want then
          status, message = "Degraded", obj.metadata.name .. ": " .. (st.readyReplicas or 0) .. " of " .. want .. " ready"
        end`,
	"DaemonSet": `local st = obj.status or {}
        local want = st.desiredNumberScheduled or 0
        if (st.observedGeneration or 0) < (obj.metadata.generation or 0) or (st.updatedNumberScheduled or 0) < want then
          status, message = "Progressing", obj.metadata.name .. ": rolling out"
        elseif (st.numberAvailable or 0) < want then
          status, message = "Degraded", obj.metadata.name .. ": " .. (st.numberAvailable or 0) .. " of " .. want .. " available"
        end`,
}

// continuousHealth is a profile's continuous health check: a HealthCheck
// that judges the workloads its charts deliver, named one by one, and a
// ClusterHealthCheck that runs it on the profile's clusters and reports each
// cluster's condition, which cub sveltos status reads. Sveltos runs a delivery
// profile's validateHealths only when it deploys; this keeps watching.
//
// A ClusterHealthCheck selects clusters by label only. The profile's own
// selector is used, with every class of a component; a profile that names its
// clusters by clusterRefs is checked on every cluster Sveltos manages, and a
// cluster without the named workloads passes.
func continuousHealth(p Profile) []*yaml.Node {
	keys, names := deliveredWorkloads(p.Units)
	if len(keys) == 0 {
		return nil
	}
	name := p.Component
	labels := mapping(scalar(ProfileLabel), scalar(p.Name))
	var selectors []*yaml.Node
	var delivered, branches strings.Builder
	kinds := map[string]bool{}
	for _, k := range keys {
		sel := mapping(scalar("group"), scalar("apps"), scalar("version"), scalar("v1"), scalar("kind"), scalar(k.kind))
		if k.namespace != "" {
			sel.Content = append(sel.Content, scalar("namespace"), scalar(k.namespace))
		}
		selectors = append(selectors, sel)
		ns := k.namespace
		if ns == "" {
			ns = "default" // an object with no namespace is created in default
		}
		for _, n := range names[k] {
			fmt.Fprintf(&delivered, "    [%q] = true,\n", k.kind+"/"+ns+"/"+n)
		}
		kinds[k.kind] = true
	}
	first := true
	for _, kind := range []string{"Deployment", "StatefulSet", "DaemonSet"} {
		if !kinds[kind] {
			continue
		}
		word := "elseif"
		if first {
			word, first = "if", false
		}
		fmt.Fprintf(&branches, "      %s obj.kind == %q then\n        %s\n", word, kind, liveKinds[kind])
	}
	script := fmt.Sprintf(`function evaluate()
  local hs = {}
  hs.resources = {}
  local delivered = {
%s  }
  for _, obj in ipairs(resources) do
    if delivered[obj.kind .. "/" .. (obj.metadata.namespace or "") .. "/" .. obj.metadata.name] then
      local status, message = "Healthy", ""
%s      end
      table.insert(hs.resources, {resource = obj, status = status, message = message})
    end
  end
  return hs
end
`, delivered.String(), branches.String())
	check := mapping(
		scalar("apiVersion"), scalar("lib.projectsveltos.io/v1beta1"),
		scalar("kind"), scalar("HealthCheck"),
		scalar("metadata"), mapping(scalar("name"), scalar(name), scalar("labels"), labels),
		scalar("spec"), mapping(
			scalar("resourceSelectors"), seq(selectors...),
			scalar("evaluateHealth"), &yaml.Node{Kind: yaml.ScalarNode, Style: yaml.LiteralStyle, Value: script}))
	clusters := p.Clusters
	if len(clusters) == 0 {
		clusters = map[string]any{"matchExpressions": []any{map[string]any{"key": "projectsveltos.io/k8s-version", "operator": "Exists"}}}
	}
	watch := mapping(
		scalar("apiVersion"), scalar("lib.projectsveltos.io/v1beta1"),
		scalar("kind"), scalar("ClusterHealthCheck"),
		scalar("metadata"), mapping(scalar("name"), scalar(name), scalar("labels"), deepCopy(labels)),
		scalar("spec"), mapping(
			scalar("clusterSelector"), nodeOf(clusters),
			scalar("livenessChecks"), seq(mapping(
				scalar("name"), scalar("workloads"),
				scalar("type"), scalar("HealthCheck"),
				scalar("livenessSourceRef"), mapping(
					scalar("apiVersion"), scalar("lib.projectsveltos.io/v1beta1"),
					scalar("kind"), scalar("HealthCheck"),
					scalar("name"), scalar(name)))),
			scalar("notifications"), seq(mapping(scalar("name"), scalar("events"), scalar("type"), scalar("KubernetesEvent")))))
	return []*yaml.Node{check, watch}
}

// nodeOf is a value as a YAML node.
func nodeOf(v any) *yaml.Node {
	var doc yaml.Node
	data, _ := yaml.Marshal(v)
	if err := yaml.Unmarshal(data, &doc); err != nil || len(doc.Content) == 0 {
		return mapping()
	}
	return doc.Content[0]
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
