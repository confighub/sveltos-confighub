package onboard

import (
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// policyUnitsOf reads the ConfigMaps a profile names in policyRefs into one
// unit each, holding the objects the ConfigMap carries, so the policy text is
// reviewed and staged like everything else. Each must be in the input. A
// Secret, or an entry fetched from elsewhere, stays on the delivery profile as
// it is, named in carried.
func policyUnitsOf(profile string, spec map[string]any, configMaps map[string]Doc) (units []Unit, policies, carried, problems []string) {
	seen := map[string]bool{}
	for _, r := range list(spec["policyRefs"]) {
		ref := obj(r)
		kind, ns, name := str(ref["kind"]), str(ref["namespace"]), str(ref["name"])
		switch {
		case name == "":
			carried = append(carried, "a policyRefs entry fetched from "+str(obj(ref["remoteURL"])["url"]))
			continue
		case kind == "Secret":
			carried = append(carried, fmt.Sprintf("Secret %s/%s", ns, name))
			continue
		case kind != "ConfigMap":
			continue
		case str(ref["deploymentType"]) == "Local":
			problems = append(problems, fmt.Sprintf("%s deploys ConfigMap %s's objects to the management cluster (deploymentType Local); this version onboards what is deployed to the clusters a profile selects", profile, name))
			continue
		case ns == "":
			problems = append(problems, fmt.Sprintf("%s names ConfigMap %s in policyRefs without a namespace, so each cluster reads its own copy from its cluster's namespace; this version onboards ConfigMaps named with a namespace", profile, name))
			continue
		}
		key := ns + "/" + name
		if seen[key] {
			continue
		}
		seen[key] = true
		d, ok := configMaps[key]
		if !ok {
			problems = append(problems, fmt.Sprintf("%s names ConfigMap %s in policyRefs, which is not in the input; save it with kubectl get configmap -n %s %s -o yaml > %s.yaml and pass that file too", profile, key, ns, name, name))
			continue
		}
		annotations := obj(obj(d.Value["metadata"])["annotations"])
		if _, templated := annotations["projectsveltos.io/template"]; templated {
			problems = append(problems, fmt.Sprintf("%s reads ConfigMap %s, a Sveltos template instantiated for each cluster; this version onboards policies that are the same for every cluster", profile, key))
			continue
		}
		var objects []Object
		data := mapGet(d.Node, "data")
		for i := 0; data != nil && i+1 < len(data.Content); i += 2 {
			found, err := objectsOf([]byte(data.Content[i+1].Value))
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s: ConfigMap %s key %s is not YAML Sveltos can deploy: %v", profile, key, data.Content[i].Value, err))
				continue
			}
			objects = append(objects, found...)
		}
		if len(objects) == 0 {
			problems = append(problems, fmt.Sprintf("%s: ConfigMap %s holds no objects", profile, key))
			continue
		}
		units = append(units, Unit{Slug: Slug(name), Source: "ConfigMap " + key, Objects: objects})
		policies = append(policies, key)
	}
	sort.Strings(carried)
	return units, policies, carried, problems
}

// VariantLabel names, on each delivery profile, the variant Space whose
// releases it delivers.
const VariantLabel = "sveltos.confighub.com/variant"

// deliveryProfile is the one profile on the management cluster that sends a
// variant's releases to its cluster: addressed to that cluster alone, reading
// the variant's latest release from the ConfigHub gateway, and keeping every
// other setting of the profile it replaces, such as its syncMode.
func deliveryProfile(v Variant, source *yaml.Node, secretName string, keptHooks bool, checks []*yaml.Node) *yaml.Node {
	metadata := mapping(scalar("name"), scalar(v.ProfileName))
	// The profile's own labels, and the variant it delivers, so one cluster's
	// delivery profile can be applied alone: kubectl apply -l.
	labels := mapping()
	if own := mapGet(mapGet(source, "metadata"), "labels"); own != nil {
		for i := 0; i+1 < len(own.Content); i += 2 {
			if own.Content[i].Value != VariantLabel {
				labels.Content = append(labels.Content, deepCopy(own.Content[i]), deepCopy(own.Content[i+1]))
			}
		}
	}
	labels.Content = append(labels.Content, scalar(VariantLabel), scalar(v.Space))
	metadata.Content = append(metadata.Content, scalar("labels"), labels)
	ref := mapping(
		scalar("apiVersion"), scalar(v.ClusterRef.APIVersion),
		scalar("kind"), scalar(v.ClusterRef.Kind),
		scalar("namespace"), scalar(v.ClusterRef.Namespace),
		scalar("name"), scalar(v.ClusterRef.Name))
	spec := mapping(scalar("clusterRefs"), seq(ref))
	gateway := mapping(
		scalar("deploymentType"), scalar("Remote"),
		scalar("remoteURL"), mapping(
			scalar("url"), scalar(fmt.Sprintf("oci://%s/space/%s:%s", gatewayHost, v.Space, releaseTag)),
			scalar("interval"), scalar(fetchInterval),
			scalar("secretRef"), mapping(scalar("name"), scalar(secretName), scalar("namespace"), scalar(secretNamespace))))
	refs := seq(gateway)
	if s := mapGet(source, "spec"); s != nil {
		for i := 0; i+1 < len(s.Content); i += 2 {
			switch s.Content[i].Value {
			case "clusterSelector", "clusterRefs", "setRefs", "helmCharts", "dependsOn", "continueOnError", "validateHealths":
				continue
			case "policyRefs":
				for _, r := range s.Content[i+1].Content {
					var value map[string]any
					_ = r.Decode(&value)
					if str(value["kind"]) == "ConfigMap" && str(value["name"]) != "" {
						continue
					}
					refs.Content = append(refs.Content, deepCopy(r))
				}
				continue
			}
			spec.Content = append(spec.Content, deepCopy(s.Content[i]), deepCopy(s.Content[i+1]))
		}
	}
	// A release lists a chart's objects in the order cub helm template prints
	// them, which can put a custom resource before its CRD; by default Sveltos
	// stops at the first object that fails. Continuing, the CRD is applied in
	// the same pass and the custom resource on the retry: measured, a fresh
	// cluster took the GPU operator's ClusterPolicy two minutes later. A live
	// profile exported with kubectl says continueOnError: false by default, so
	// the profile's value cannot be told from a choice, and a delivery profile
	// always continues.
	spec.Content = append(spec.Content, scalar("continueOnError"), &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	if keptHooks {
		spec.Content = appendPatch(spec.Content, hookDriftPatch())
	}
	if len(v.DependsOn) > 0 {
		deps := seq()
		deps.Style = yaml.FlowStyle
		for _, d := range v.DependsOn {
			deps.Content = append(deps.Content, scalar(d))
		}
		spec.Content = append(spec.Content, scalar("dependsOn"), deps)
	}
	spec.Content = append(spec.Content, scalar("policyRefs"), refs)
	// Sveltos holds the feature out of Provisioned until every check passes,
	// so Provisioned means the delivered workloads are available: what cub
	// sveltos status reports as healthy. The source's own checks come first.
	all := carriedHealthChecks(source)
	for _, c := range checks {
		all = append(all, deepCopy(c))
	}
	if len(all) > 0 {
		spec.Content = append(spec.Content, scalar("validateHealths"), seq(all...))
	}
	return mapping(
		scalar("apiVersion"), scalar(profileAPIVersion),
		scalar("kind"), scalar("ClusterProfile"),
		scalar("metadata"), metadata,
		scalar("spec"), spec)
}

func seq(items ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: items}
}

// describeDepartures says what a class differs in, for the plan.
func describeDepartures(ds []Departure) string {
	var parts []string
	for _, d := range ds {
		s := d.Shown
		if d.Removed {
			s += " (removed; unprotected, a change to it at the root would bring it back)"
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, ", ")
}

// hookDriftPatch marks every Helm hook object Sveltos's way: a resource
// annotated projectsveltos.io/driftDetectionIgnore is not watched for drift.
// It is how Sveltos treats hooks when it runs Helm, whose drift detection
// watches a release's manifest and not its hooks: a hook Job that deletes
// itself when it finishes is not recreated, and runs again with the next
// release. Without it, measured on kind, Sveltos recreated such a Job ten
// times in a minute and a half.
func hookDriftPatch() *yaml.Node {
	patch := scalar("- op: add\n  path: /metadata/annotations/projectsveltos.io~1driftDetectionIgnore\n  value: ok\n")
	patch.Style = yaml.LiteralStyle
	return mapping(
		scalar("target"), mapping(scalar("annotationSelector"), scalar("helm.sh/hook")),
		scalar("patch"), patch)
}

// appendPatch adds a patch to a spec's patches, beside any the profile has.
func appendPatch(spec []*yaml.Node, patch *yaml.Node) []*yaml.Node {
	for i := 0; i+1 < len(spec); i += 2 {
		if spec[i].Value == "patches" {
			spec[i+1].Content = append(spec[i+1].Content, patch)
			return spec
		}
	}
	return append(spec, scalar("patches"), seq(patch))
}
