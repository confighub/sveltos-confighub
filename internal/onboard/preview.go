package onboard

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

const PreviewAPIVersion = "confighub.com/plugin-preview/v1"

type Preview struct {
	APIVersion   string          `json:"apiVersion"`
	Kind         string          `json:"kind"`
	Producer     PreviewProducer `json:"producer"`
	ExportedAt   string          `json:"exportedAt"`
	Scope        PreviewScope    `json:"scope"`
	Capabilities []string        `json:"capabilities"`
	Inventory    PreviewGraph    `json:"inventory"`
	Proposal     PreviewGraph    `json:"proposal"`
	Issues       []PreviewIssue  `json:"issues"`
}

type PreviewProducer struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}
type PreviewScope struct {
	Description string `json:"description"`
}
type PreviewGraph struct {
	Nodes []PreviewNode `json:"nodes"`
	Edges []PreviewEdge `json:"edges"`
}
type PreviewNode struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"`
	Details   map[string]string `json:"details,omitempty"`
	Hub       *PreviewHub       `json:"hub,omitempty"`
}
type PreviewHub struct {
	SpaceSlug    string `json:"spaceSlug,omitempty"`
	UnitSlug     string `json:"unitSlug,omitempty"`
	TargetSlug   string `json:"targetSlug,omitempty"`
	TargetsSpace string `json:"targetsSpace,omitempty"`
}
type PreviewEdge struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Relation string `json:"relation"`
}
type PreviewIssue struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
}

// BuildPreview produces the bounded v1 summary. It includes only supported input
// identities and planner-derived proposal data; it never copies object bodies.
func BuildPreview(docs []Doc, plan *Plan, exportedAt time.Time, producerVersion string, opts Options) ([]byte, error) {
	if plan == nil {
		return nil, fmt.Errorf("preview needs a plan")
	}
	if producerVersion == "" {
		producerVersion = "dev"
	}
	p := Preview{APIVersion: PreviewAPIVersion, Kind: "PluginPreview", Producer: PreviewProducer{Name: "sveltos-confighub", Version: producerVersion}, ExportedAt: exportedAt.UTC().Format(time.RFC3339), Scope: PreviewScope{Description: "Supplied Sveltos ClusterProfiles, clusters, and referenced ConfigMaps; not exhaustive live discovery."}, Capabilities: []string{"preview"}, Issues: []PreviewIssue{}}
	p.Inventory.Nodes, p.Inventory.Edges = inventoryPreview(docs, plan, opts, &p.Issues)
	p.Proposal.Nodes, p.Proposal.Edges = proposalPreview(plan)
	if p.Inventory.Nodes == nil {
		p.Inventory.Nodes = []PreviewNode{}
	}
	if p.Inventory.Edges == nil {
		p.Inventory.Edges = []PreviewEdge{}
	}
	if p.Proposal.Nodes == nil {
		p.Proposal.Nodes = []PreviewNode{}
	}
	if p.Proposal.Edges == nil {
		p.Proposal.Edges = []PreviewEdge{}
	}
	for _, note := range plan.Notes {
		p.Issues = append(p.Issues, PreviewIssue{Severity: "warning", Code: "planner_note", Message: note})
	}
	for _, problem := range plan.Problems {
		p.Issues = append(p.Issues, PreviewIssue{Severity: "error", Code: "planning_problem", Message: problem})
	}
	sort.Slice(p.Issues, func(i, j int) bool {
		if p.Issues[i].Code != p.Issues[j].Code {
			return p.Issues[i].Code < p.Issues[j].Code
		}
		if p.Issues[i].Severity != p.Issues[j].Severity {
			return p.Issues[i].Severity < p.Issues[j].Severity
		}
		return p.Issues[i].Message < p.Issues[j].Message
	})
	return json.MarshalIndent(p, "", "  ")
}

func inventoryPreview(docs []Doc, plan *Plan, opts Options, issues *[]PreviewIssue) ([]PreviewNode, []PreviewEdge) {
	nodesByID := map[string]PreviewNode{}
	var edges []PreviewEdge
	clusters := map[string]Cluster{}
	profiles := map[string]map[string]any{}
	configMaps := map[string]bool{}
	for _, d := range docs {
		v := d.Value
		meta := obj(v["metadata"])
		name, ns := str(meta["name"]), str(meta["namespace"])
		if isClusterKind(v) && name != "" {
			c := clusterOf(v)
			clusters[c.Key] = c
			nodesByID[c.Key] = PreviewNode{ID: c.Key, Kind: c.Kind, Name: c.Name, Namespace: c.Namespace, Details: map[string]string{"identity": "supplied"}}
		}
		if str(v["kind"]) == "ClusterProfile" && name != "" {
			id := profileID(ns, name)
			profiles[id] = v
			nodesByID[id] = PreviewNode{ID: id, Kind: "ClusterProfile", Name: name, Namespace: namespaceIf(ns), Details: map[string]string{"disposition": "considered"}}
		}
		if str(v["kind"]) == "ConfigMap" && str(v["apiVersion"]) == "v1" && name != "" {
			configMaps[ns+"/"+name] = true
		}
	}
	clusterList := make([]Cluster, 0, len(clusters))
	for _, c := range clusters {
		clusterList = append(clusterList, c)
	}
	sort.Slice(clusterList, func(i, j int) bool { return clusterList[i].Key < clusterList[j].Key })
	wanted := map[string]bool{}
	for _, name := range opts.Profiles {
		wanted[name] = true
	}
	selectedByPlan, skippedByPlan, clusterGoverned := map[string]bool{}, map[string]string{}, map[string]bool{}
	for _, p := range plan.Profiles {
		for _, m := range p.Members {
			selectedByPlan[profileID("", m.Name)] = true
		}
		for _, v := range p.Variants {
			clusterGoverned[v.ClusterKey] = true
		}
	}
	for _, s := range plan.Skipped {
		skippedByPlan[profileID("", s.Name)] = s.Reason
	}
	for id, v := range profiles {
		meta, spec := obj(v["metadata"]), obj(v["spec"])
		name := str(meta["name"])
		node := nodesByID[id]
		disposition := "unselected"
		if len(wanted) > 0 && !wanted[name] {
			disposition = "filtered"
			*issues = append(*issues, PreviewIssue{Severity: "warning", Code: "profile_filtered", Message: "ClusterProfile " + name + " was excluded by --profiles and remains in supplied inventory."})
		} else if reason, ok := skippedByPlan[id]; ok {
			disposition = "skipped: " + reason
			*issues = append(*issues, PreviewIssue{Severity: "warning", Code: "profile_skipped", Message: "ClusterProfile " + name + " was skipped: " + reason})
		} else if selectedByPlan[id] {
			disposition = "planned"
		}
		node.Details["disposition"] = disposition
		nodesByID[id] = node
		if selector, ok := spec["clusterSelector"]; ok {
			encoded, _ := json.Marshal(selector)
			node.Details["selector"] = string(encoded)
		}
		if refs, ok := spec["clusterRefs"]; ok {
			encoded, _ := json.Marshal(refs)
			node.Details["clusterRefs"] = string(encoded)
		}
		res, err := resolveMatches(v, clusterList)
		if err != nil {
			*issues = append(*issues, PreviewIssue{Severity: "warning", Code: "selection_unreadable", Message: name + ": " + err.Error()})
		} else {
			relation := "selects"
			node.Details["selectionBasis"] = "selector and explicit references in supplied input"
			if res.fromStatus {
				relation = "records-match"
				node.Details["selectionBasis"] = "Sveltos status.matchingClusters in supplied input; not a fresh observation"
			}
			for _, c := range res.matched {
				edges = append(edges, PreviewEdge{From: id, To: c.Key, Relation: relation})
			}
			for _, missing := range res.missing {
				*issues = append(*issues, PreviewIssue{Severity: "warning", Code: "referenced_cluster_missing", Message: name + ": input does not include " + missing})
			}
		}
		nodesByID[id] = node
		for i, raw := range list(spec["helmCharts"]) {
			h := obj(raw)
			chartName := str(h["chartName"])
			release := str(h["releaseName"])
			chartID := fmt.Sprintf("helmchart:%s/%s:%d", name, release, i)
			label := release
			if label == "" {
				label = chartName
			}
			if label == "" {
				label = fmt.Sprintf("Unnamed chart %d", i+1)
			}
			details := map[string]string{}
			if chartName != "" {
				details["chart"] = chartName
			}
			if s := str(h["chartVersion"]); s != "" {
				details["version"] = s
			}
			details["disposition"] = disposition
			nodesByID[chartID] = PreviewNode{ID: chartID, Kind: "HelmChart", Name: label, Details: details}
			edges = append(edges, PreviewEdge{From: id, To: chartID, Relation: "contains"})
		}
		for _, raw := range list(spec["policyRefs"]) {
			r := obj(raw)
			if str(r["kind"]) != "ConfigMap" {
				continue
			}
			ns := str(r["namespace"])
			if ns == "" {
				continue
			}
			key := ns + "/" + str(r["name"])
			if !configMaps[key] {
				continue
			}
			cid := "configmap:" + key
			nodesByID[cid] = PreviewNode{ID: cid, Kind: "ConfigMap", Name: str(r["name"]), Namespace: ns, Details: map[string]string{"content": "not included"}}
			edges = append(edges, PreviewEdge{From: id, To: cid, Relation: "references"})
		}
	}
	for _, c := range clusters {
		if !clusterGoverned[c.Key] {
			*issues = append(*issues, PreviewIssue{Severity: "warning", Code: "cluster_unselected", Message: fmt.Sprintf("%s %s/%s is supplied but selected by no planned profile.", c.Kind, c.Namespace, c.Name)})
		}
	}
	nodes := make([]PreviewNode, 0, len(nodesByID))
	for _, n := range nodesByID {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	sortEdges(&edges)
	return nodes, edges
}

func namespaceIf(ns string) string { return ns }
func profileID(ns, name string) string {
	if ns == "" {
		return "clusterprofile:" + name
	}
	return "clusterprofile:" + ns + "/" + name
}

func proposalPreview(plan *Plan) ([]PreviewNode, []PreviewEdge) {
	nodes := map[string]PreviewNode{}
	var edges []PreviewEdge
	addSpace := func(slug string, details map[string]string) {
		nodes["space:"+slug] = PreviewNode{ID: "space:" + slug, Kind: "Space", Name: slug, Details: details, Hub: &PreviewHub{SpaceSlug: slug, TargetsSpace: plan.TargetsSpace}}
	}
	addSpace(plan.TargetsSpace, map[string]string{"role": "targets"})
	targetID := map[string]string{}
	for _, t := range plan.Targets {
		id := "target:" + t.Target
		targetID[t.Target] = id
		nodes[id] = PreviewNode{ID: id, Kind: "Target", Name: t.Target, Details: map[string]string{"cluster": t.Cluster}, Hub: &PreviewHub{TargetSlug: t.Target, TargetsSpace: plan.TargetsSpace}}
		edges = append(edges, PreviewEdge{From: "space:" + plan.TargetsSpace, To: id, Relation: "registers"})
	}
	for _, p := range plan.Profiles {
		addSpace(p.BaseSpace, map[string]string{"stage": "base", "sourceProfile": p.Name})
		for _, cl := range p.Classes {
			addSpace(cl.Space, map[string]string{"stage": "class", "sourceProfile": cl.Member})
			edges = append(edges, PreviewEdge{From: "space:" + cl.Space, To: "space:" + p.BaseSpace, Relation: "variantOf"})
		}
		for _, v := range p.Variants {
			d := map[string]string{"stage": v.Stage, "sourceProfile": v.Member, "clusterIdentity": v.ClusterKey}
			addSpace(v.Space, d)
			parent := v.Upstream
			edges = append(edges, PreviewEdge{From: "space:" + v.Space, To: "space:" + parent, Relation: "variantOf"})
			if tid := targetID[v.Target]; tid != "" {
				edges = append(edges, PreviewEdge{From: "space:" + v.Space, To: tid, Relation: "targets"})
			}
		}
		copies := map[string]string{p.BaseSpace: ""}
		for _, cl := range p.Classes {
			copies[cl.Space] = p.BaseSpace
		}
		for _, v := range p.Variants {
			copies[v.Space] = v.Upstream
		}
		for space, upstream := range copies {
			for _, u := range p.Units {
				id := "unit:" + space + "/" + u.Slug
				nodes[id] = PreviewNode{ID: id, Kind: "Unit", Name: u.Slug, Details: map[string]string{"source": safeUnitSource(u.Source)}, Hub: &PreviewHub{SpaceSlug: space, UnitSlug: u.Slug}}
				edges = append(edges, PreviewEdge{From: "space:" + space, To: id, Relation: "contains"})
				if upstream != "" {
					edges = append(edges, PreviewEdge{From: id, To: "unit:" + upstream + "/" + u.Slug, Relation: "variantOf"})
				}
			}
		}
	}
	if m := plan.Management; m != nil {
		addSpace(m.Space, map[string]string{"role": "management", "cluster": m.Cluster})
		if m.Root != nil && targetID[m.Target] != "" {
			edges = append(edges, PreviewEdge{From: "space:" + m.Space, To: targetID[m.Target], Relation: "targets"})
		}
		for _, delivery := range m.ByProfile {
			unitNames := []string{delivery.Unit}
			if len(delivery.Health) > 0 {
				unitNames = append(unitNames, healthUnit(delivery.Profile))
			}
			for _, name := range unitNames {
				id := "unit:" + m.Space + "/" + name
				nodes[id] = PreviewNode{ID: id, Kind: "Unit", Name: name, Details: map[string]string{"sourceProfile": delivery.Profile, "role": "management record"}, Hub: &PreviewHub{SpaceSlug: m.Space, UnitSlug: name}}
				edges = append(edges, PreviewEdge{From: "space:" + m.Space, To: id, Relation: "contains"})
			}
		}
	}
	// The targets Space contains destination records; variant Space targets edges are added above.
	ns := make([]PreviewNode, 0, len(nodes))
	for _, n := range nodes {
		ns = append(ns, n)
	}
	sort.Slice(ns, func(i, j int) bool { return ns[i].ID < ns[j].ID })
	sortEdges(&edges)
	return ns, edges
}

func safeUnitSource(s string) string {
	if strings.HasPrefix(s, "ConfigMap ") {
		return s
	}
	return "rendered chart"
}
func sortEdges(edges *[]PreviewEdge) {
	sort.Slice(*edges, func(i, j int) bool {
		a, b := (*edges)[i], (*edges)[j]
		if a.From != b.From {
			return a.From < b.From
		}
		if a.To != b.To {
			return a.To < b.To
		}
		return a.Relation < b.Relation
	})
	out := (*edges)[:0]
	for _, e := range *edges {
		if len(out) == 0 || out[len(out)-1] != e {
			out = append(out, e)
		}
	}
	*edges = out
}
