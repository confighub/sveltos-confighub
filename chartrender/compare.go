package chartrender

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Comparison is how the objects stored to replace a Helm release compare with
// the objects Helm installed for it.
type Comparison struct {
	// Same is how many objects both hold, identically.
	Same int
	// Differences are what taking over from Helm would change on the cluster.
	Differences []string
	// Notes are gaps that are expected, and why.
	Notes []string
}

// Compare compares a release's manifest, the objects Helm installed and
// recorded, with the objects stored to replace it. A rendering that matches
// what runs changes nothing when it takes over; one that differs, because the
// chart branched on the cluster's Kubernetes version or APIs, or read the
// cluster with lookup, or the values moved on, would change the cluster.
//
// Helm keeps some objects out of the manifest, so these are notes, not
// differences: hooks kept as plain objects, the release's own Namespace, and
// a chart's crds/ directory.
func Compare(manifest, stored []byte, releaseNamespace string) (Comparison, error) {
	installed, err := objectsIn(manifest)
	if err != nil {
		return Comparison{}, fmt.Errorf("reading the release manifest: %w", err)
	}
	held, err := objectsIn(stored)
	if err != nil {
		return Comparison{}, fmt.Errorf("reading what is stored: %w", err)
	}
	var c Comparison
	matched := map[string]bool{}
	find := func(o object) (object, bool) {
		for _, ns := range []string{o.namespace, releaseNamespace, ""} {
			if h, ok := held[o.keyIn(ns)]; ok && !matched[h.key()] {
				if ns == o.namespace || o.namespace == "" || h.namespace == "" {
					return h, true
				}
			}
		}
		return object{}, false
	}
	for _, k := range sortedKeys(installed) {
		o := installed[k]
		h, ok := find(o)
		if !ok {
			c.Differences = append(c.Differences, fmt.Sprintf("%s: Helm installed it, and what is stored lacks it, so it would stay on the cluster, managed by nothing", o))
			continue
		}
		matched[h.key()] = true
		a, b := withoutNulls(withoutNamespace(o.value)), withoutNulls(withoutNamespace(h.value))
		if reflect.DeepEqual(a, b) {
			c.Same++
			continue
		}
		var paths []string
		diffPaths("", a, b, &paths)
		c.Differences = append(c.Differences, fmt.Sprintf("%s: %s", o, strings.Join(paths, "; ")))
	}
	for _, k := range sortedKeys(held) {
		h := held[k]
		if matched[k] {
			continue
		}
		switch {
		case h.hook:
			c.Notes = append(c.Notes, fmt.Sprintf("%s is a hook kept as a plain object; Helm keeps hooks out of the manifest", h))
		case h.kind == "Namespace" && h.name == releaseNamespace:
			c.Notes = append(c.Notes, fmt.Sprintf("%s is the release's Namespace, which Helm makes outside the manifest", h))
		case h.kind == "CustomResourceDefinition":
			c.Notes = append(c.Notes, fmt.Sprintf("%s is a CRD Helm installs from the chart's crds/ directory, outside the manifest, so it is not compared", h))
		default:
			c.Differences = append(c.Differences, fmt.Sprintf("%s: stored, and Helm did not install it, so it would be added to the cluster", h))
		}
	}
	return c, nil
}

type object struct {
	apiVersion, kind, namespace, name string
	hook                              bool
	value                             map[string]any
}

func (o object) keyIn(namespace string) string {
	return o.apiVersion + "|" + o.kind + "|" + namespace + "|" + o.name
}

func (o object) key() string { return o.keyIn(o.namespace) }

func (o object) String() string {
	if o.namespace == "" {
		return o.kind + " " + o.name
	}
	return o.kind + " " + o.namespace + "/" + o.name
}

func objectsIn(data []byte) (map[string]object, error) {
	out := map[string]object{}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var v map[string]any
		err := dec.Decode(&v)
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		meta, _ := v["metadata"].(map[string]any)
		o := object{apiVersion: text(v["apiVersion"]), kind: text(v["kind"]), namespace: text(meta["namespace"]), name: text(meta["name"]), value: v}
		if o.kind == "" || o.name == "" {
			continue
		}
		annotations, _ := meta["annotations"].(map[string]any)
		_, o.hook = annotations["helm.sh/hook"]
		out[o.key()] = o
	}
}

func text(v any) string {
	s, _ := v.(string)
	return s
}

func sortedKeys(m map[string]object) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// withoutNamespace drops metadata.namespace, which a chart may leave to the
// release: a rendering and a manifest agree on it by where they are keyed.
func withoutNamespace(v map[string]any) map[string]any {
	meta, ok := v["metadata"].(map[string]any)
	if !ok {
		return v
	}
	m := make(map[string]any, len(meta))
	for k, x := range meta {
		if k != "namespace" {
			m[k] = x
		}
	}
	out := make(map[string]any, len(v))
	for k, x := range v {
		out[k] = x
	}
	out["metadata"] = m
	return out
}

// withoutNulls drops keys whose value is null, which Kubernetes reads as
// unset: cub helm template prints resources.limits: null where Helm's record
// leaves limits out.
func withoutNulls(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			if e != nil {
				out[k] = withoutNulls(e)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = withoutNulls(e)
		}
		return out
	}
	return v
}

// diffPaths names where two values differ, at most a few, with both values.
func diffPaths(path string, a, b any, out *[]string) {
	const most = 4
	if len(*out) >= most {
		return
	}
	am, aok := a.(map[string]any)
	bm, bok := b.(map[string]any)
	if aok && bok {
		keys := map[string]bool{}
		for k := range am {
			keys[k] = true
		}
		for k := range bm {
			keys[k] = true
		}
		var sorted []string
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			p := k
			if path != "" {
				p = path + "." + k
			}
			if !reflect.DeepEqual(am[k], bm[k]) {
				diffPaths(p, am[k], bm[k], out)
			}
		}
		return
	}
	al, alok := a.([]any)
	bl, blok := b.([]any)
	if alok && blok && len(al) == len(bl) {
		for i := range al {
			if !reflect.DeepEqual(al[i], bl[i]) {
				diffPaths(fmt.Sprintf("%s[%d]", path, i), al[i], bl[i], out)
			}
		}
		return
	}
	*out = append(*out, fmt.Sprintf("%s is %s on the cluster, %s stored", path, shown(a), shown(b)))
}

func shown(v any) string {
	if v == nil {
		return "absent"
	}
	switch v.(type) {
	case map[string]any, []any:
		return "a different " + map[bool]string{true: "map", false: "list"}[isMap(v)]
	}
	s := fmt.Sprint(v)
	if len(s) > 40 {
		s = s[:37] + "..."
	}
	return s
}

func isMap(v any) bool {
	_, ok := v.(map[string]any)
	return ok
}

// ReleaseManifest reads the manifest out of a Helm release record: the value
// of a release Secret's data.release as the Kubernetes API returns it, which
// is base64 of Helm's own base64 of gzipped JSON.
func ReleaseManifest(data string) (string, error) {
	outer, err := base64.StdEncoding.DecodeString(strings.TrimSpace(data))
	if err != nil {
		return "", fmt.Errorf("the release record is not base64: %w", err)
	}
	inner, err := base64.StdEncoding.DecodeString(string(outer))
	if err != nil {
		return "", fmt.Errorf("the release record is not Helm's base64: %w", err)
	}
	if bytes.HasPrefix(inner, []byte{0x1f, 0x8b}) {
		r, err := gzip.NewReader(bytes.NewReader(inner))
		if err != nil {
			return "", err
		}
		if inner, err = io.ReadAll(r); err != nil {
			return "", err
		}
	}
	var release struct {
		Manifest string `json:"manifest"`
	}
	if err := json.Unmarshal(inner, &release); err != nil {
		return "", fmt.Errorf("the release record is not Helm's JSON: %w", err)
	}
	return release.Manifest, nil
}
