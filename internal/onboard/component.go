package onboard

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// memberDoc is one ClusterProfile a component is made from, and the class it
// pins, if any. The first is the root: the base holds what it renders to.
type memberDoc struct {
	name  string
	class string
	node  *yaml.Node
	value map[string]any
}

// componentRendering is what a component's sources render to.
type componentRendering struct {
	units []Unit
	// policies are the ConfigMaps whose objects the base holds, as
	// namespace/name, and policyMaps the ConfigMaps themselves.
	policies   []string
	policyMaps []Doc
	carried    []string
	// departures are what each pinned class holds differently from the root,
	// by class value.
	departures map[string][]Departure
	// root is the member whose rendering the base holds.
	root     int
	charts   int
	problems []string
	notes    []string
}

// renderComponent renders a component from its members and the ConfigMaps
// they name. Each member's charts are rendered with its own values. The root,
// whose rendering the base holds, is the member whose objects every other
// member also has, so the other classes depart by adding objects and changing
// fields, which a later change at the root cannot undo; failing that, the
// first. The policies are the root's.
func renderComponent(name string, members []memberDoc, configMaps map[string]Doc, keepHooks func(memberDoc, string) bool, rc *renderCache) componentRendering {
	var out componentRendering
	renders := make([][]Unit, len(members))
	for i, m := range members {
		charts, problems := chartsOf(m.name, obj(m.value["spec"]), func(release string) bool { return keepHooks(m, release) })
		out.problems = append(out.problems, problems...)
		units, problems := renderUnits(m.name, charts, rc)
		out.problems = append(out.problems, problems...)
		renders[i] = units
		if i == 0 {
			out.charts = len(charts)
		}
	}
	out.root = rootOf(renders)
	root := members[out.root]
	spec := obj(root.value["spec"])
	units := renders[out.root]
	policyUnits, policies, carried, problems := policyUnitsOf(root.name, spec, configMaps)
	out.problems = append(out.problems, problems...)
	for _, pu := range policyUnits {
		for _, u := range units {
			if u.Slug == pu.Slug {
				pu.Slug = Slug("configmap-" + pu.Slug)
			}
		}
		units = append(units, pu)
	}
	out.units, out.policies, out.carried = units, policies, carried
	for _, key := range policies {
		out.policyMaps = append(out.policyMaps, configMaps[key])
	}
	if out.charts == 0 && len(policyUnits) == 0 && len(out.problems) == 0 {
		out.problems = append(out.problems, fmt.Sprintf("%s has no Helm chart and no policy ConfigMap, so ConfigHub would hold nothing for it; onboard it with --profiles once it has", root.name))
	}
	if len(carried) > 0 {
		out.notes = append(out.notes, fmt.Sprintf("%s also reads %s; each delivery profile keeps reading them as before, and they stay out of ConfigHub.", name, strings.Join(carried, ", ")))
	}
	if len(list(spec["kustomizationRefs"])) > 0 {
		out.notes = append(out.notes, fmt.Sprintf("%s has kustomizationRefs; each delivery profile keeps them as they are, delivered by Sveltos from their sources, and their objects stay out of ConfigHub.", name))
	}
	if len(list(spec["patches"])) > 0 {
		out.notes = append(out.notes, fmt.Sprintf("%s has patches; each delivery profile keeps them, so Sveltos applies them on top of what ConfigHub releases.", name))
	}
	for _, u := range units {
		if u.Chart != nil && u.Chart.IncludeHooks {
			var notAtInstall []string
			for _, h := range keptHooks(u.Objects) {
				if !h.AtInstall() {
					notAtInstall = append(notAtInstall, h.String())
				}
			}
			if len(notAtInstall) > 0 {
				out.problems = append(out.problems, fmt.Sprintf("%s's chart %s has Helm hooks that are not for install (%s); kept as plain objects by --include-hooks, they would run at install too", root.name, u.Chart.Release, strings.Join(notAtInstall, ", ")))
			}
		}
		var install, other []string
		for _, h := range u.Hooks {
			if h.AtInstall() {
				install = append(install, h.String())
			} else {
				other = append(other, h.String())
			}
		}
		if len(install) > 0 {
			out.problems = append(out.problems, fmt.Sprintf("%s's chart %s runs Helm hooks when it installs (%s), and only Helm runs hooks, so a cluster installing it from what ConfigHub holds would lack what they make. Pass --include-hooks %s to hold its hooks as plain objects, which Sveltos applies with each release and, as it does for Helm, does not treat as drift once they are gone", root.name, u.Chart.Release, strings.Join(install, ", "), u.Chart.Release))
		}
		if len(other) > 0 {
			out.notes = append(out.notes, fmt.Sprintf("%s's chart %s has %s for upgrade, delete or test%s. They are left out, as cub helm leaves them out, because only Helm runs them.", root.name, u.Chart.Release, count(len(other), "Helm hook"), jobsAmong(u.Hooks)))
		}
	}
	out.departures = map[string][]Departure{}
	for i, m := range members {
		if i == out.root {
			continue
		}
		ms := obj(m.value["spec"])
		if !reflectEqual(ms["dependsOn"], spec["dependsOn"]) || !reflectEqual(ms["policyRefs"], spec["policyRefs"]) {
			out.problems = append(out.problems, fmt.Sprintf("%s and %s would be classes of one component but differ in dependsOn or policyRefs; onboard them without --class-label", root.name, m.name))
		}
		for _, mu := range renders[i] {
			for _, u := range units {
				if u.Slug == mu.Slug {
					out.departures[m.class] = append(out.departures[m.class], departuresOf(u, mu)...)
				}
			}
		}
	}
	return out
}

// rootOf picks the rendering every other one contains, object for object:
// the fewest objects among those, and the first when none contains the rest.
func rootOf(renders [][]Unit) int {
	ids := make([]map[string]bool, len(renders))
	for i, units := range renders {
		ids[i] = map[string]bool{}
		for _, u := range units {
			for _, o := range u.Objects {
				ids[i][u.Slug+"|"+o.id()] = true
			}
		}
	}
	best := -1
	for i := range renders {
		inAll := true
		for j := range renders {
			for id := range ids[i] {
				if !ids[j][id] {
					inAll = false
				}
			}
		}
		if inAll && (best < 0 || len(ids[i]) < len(ids[best])) {
			best = i
		}
	}
	if best < 0 {
		return 0
	}
	return best
}

// configMapSource is a policy ConfigMap as profiles.yaml keeps it, so the fleet
// can be planned again from that file alone: its name, namespace, labels,
// annotations and content, and none of what the API server wrote back.
func configMapSource(d Doc) *yaml.Node {
	meta := obj(d.Value["metadata"])
	metadata := mapping(scalar("name"), scalar(str(meta["name"])), scalar("namespace"), scalar(str(meta["namespace"])))
	for _, key := range []string{"labels", "annotations"} {
		if n := mapGet(mapGet(d.Node, "metadata"), key); n != nil && len(n.Content) > 0 {
			kept := mapping()
			for i := 0; i+1 < len(n.Content); i += 2 {
				if n.Content[i].Value == "kubectl.kubernetes.io/last-applied-configuration" {
					continue
				}
				kept.Content = append(kept.Content, deepCopy(n.Content[i]), deepCopy(n.Content[i+1]))
			}
			if len(kept.Content) > 0 {
				metadata.Content = append(metadata.Content, scalar(key), kept)
			}
		}
	}
	out := mapping(scalar("apiVersion"), scalar("v1"), scalar("kind"), scalar("ConfigMap"), scalar("metadata"), metadata)
	for _, key := range []string{"data", "binaryData"} {
		if n := mapGet(d.Node, key); n != nil {
			out.Content = append(out.Content, scalar(key), deepCopy(n))
		}
	}
	return out
}
