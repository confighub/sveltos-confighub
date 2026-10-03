package onboard

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Departure is one field a class base holds differently from the root base.
type Departure struct {
	Unit     string
	Resource string
	// Path is the field as ConfigHub resolves it, which set-protection takes.
	Path string
	// Shown is the object and field as a person reads them.
	Shown string
	// Edit is the set-yq expression that makes the change.
	Edit string
	// Removed is a field the class does not have. ConfigHub protects only
	// paths that exist, so a removal is not protected.
	Removed bool
	// Adds is a whole object the class has and the root does not, added with
	// upsert-resource; Deletes is one the root has and the class does not,
	// removed with delete-resource. Object is the added object as the JSON
	// ResourceList upsert-resource reads, the shape get-resources returns.
	Adds         bool
	Deletes      bool
	ResourceType string
	ResourceName string
	Object       string
}

// fieldPath is one field's address three ways: as a yq path, as ConfigHub's
// resolved path, and as shown in the plan.
type fieldPath struct {
	yq    string
	ch    string
	shown string
	// piped is true once the yq path has a select in it, after which a field
	// is reached with a pipe.
	piped bool
}

func (p fieldPath) key(k string) fieldPath {
	seg := "." + k
	if !plainKey.MatchString(k) {
		seg = "[" + jsonString(k) + "]"
	}
	if p.piped {
		seg = " | " + seg
		if !plainKey.MatchString(k) {
			seg = " | .[" + jsonString(k) + "]"
		}
	}
	return fieldPath{
		yq:    p.yq + seg,
		ch:    joinPath(p.ch, strings.NewReplacer("~", "~0", ".", "~1").Replace(k)),
		shown: joinPath(p.shown, k),
		piped: p.piped,
	}
}

func (p fieldPath) named(name string) fieldPath {
	return fieldPath{
		yq: p.yq + "[] | select(.name == " + jsonString(name) + ")",
		// ConfigHub escapes the dots in a merge key's value, as it does in a
		// key, so env.?name=a~1b is the variable a.b and not a field b of a.
		ch:    p.ch + ".?name=" + strings.ReplaceAll(name, ".", "~1"),
		shown: p.shown + "[" + name + "]",
		piped: true,
	}
}

func joinPath(parent, key string) string {
	if parent == "" {
		return key
	}
	return parent + "." + key
}

// namesOf returns the names of a list whose every entry is an object with a
// distinct name, the lists ConfigHub keys by name; otherwise nil.
func namesOf(l []any) []string {
	var names []string
	seen := map[string]bool{}
	for _, e := range l {
		name, ok := obj(e)["name"].(string)
		if !ok || name == "" || seen[name] {
			return nil
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// keyedByName is whether ConfigHub keys the list at this path by name. The
// lists Kubernetes merges by another field, though their entries may have a
// name, are compared whole, which is a path ConfigHub holds too.
func keyedByName(at fieldPath) bool {
	last := at.ch[strings.LastIndex(at.ch, ".")+1:]
	switch last {
	case "ports", "volumeMounts", "volumeDevices", "hostAliases":
		return false
	}
	return true
}

type fieldChange struct {
	at      fieldPath
	value   any
	removed bool
	// old is the value the field had before; nil when it was unset.
	old any
}

// fieldChanges are the fields that turn one object into another. A map is
// compared key by key, and a list ConfigHub keys by name entry by entry when
// both hold the same names; any other list that differs is changed whole,
// which is also how ConfigHub protects it.
func fieldChanges(from, to any, at fieldPath) []fieldChange {
	fm, fok := from.(map[string]any)
	tm, tok := to.(map[string]any)
	if fok && tok {
		keys := map[string]bool{}
		for k := range fm {
			keys[k] = true
		}
		for k := range tm {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		var out []fieldChange
		for _, k := range sorted {
			tv, inTo := tm[k]
			if !inTo {
				out = append(out, fieldChange{at: at.key(k), removed: true, old: fm[k]})
				continue
			}
			out = append(out, fieldChanges(fm[k], tv, at.key(k))...)
		}
		return out
	}
	fl, flok := from.([]any)
	tl, tlok := to.([]any)
	if flok && tlok {
		fn, tn := namesOf(fl), namesOf(tl)
		if fn != nil && tn != nil && strings.Join(fn, "\x00") == strings.Join(tn, "\x00") && keyedByName(at) {
			var out []fieldChange
			for i, name := range fn {
				out = append(out, fieldChanges(fl[i], tl[i], at.named(name))...)
			}
			return out
		}
	}
	if reflectEqual(from, to) {
		return nil
	}
	return []fieldChange{{at: at, value: to, old: from}}
}

// departuresOf are what a class's unit holds differently from the root's:
// objects only the class has or only the root has, and, object by object, the
// fields they hold differently.
func departuresOf(root, class Unit) []Departure {
	byID := map[string]Object{}
	for _, o := range root.Objects {
		byID[o.id()] = o
	}
	seen := map[string]bool{}
	var out []Departure
	for _, o := range class.Objects {
		seen[o.id()] = true
		r, ok := byID[o.id()]
		if !ok {
			text, _ := EncodeYAML(o.Node)
			list, _ := json.Marshal([]map[string]string{{
				"ResourceName":             o.Namespace + "/" + o.Name,
				"ResourceNameWithoutScope": o.Name,
				"ResourceType":             o.APIVersion + "/" + o.Kind,
				"ResourceCategory":         "Resource",
				"ResourceBody":             string(text),
			}})
			out = append(out, Departure{Unit: class.Slug, Resource: o.Resource(), Shown: "adds " + o.Shown(), Adds: true,
				ResourceType: o.APIVersion + "/" + o.Kind, ResourceName: o.Namespace + "/" + o.Name, Object: string(list)})
			continue
		}
		for _, fc := range fieldChanges(r.Value, o.Value, fieldPath{}) {
			d := Departure{Unit: class.Slug, Resource: o.Resource(), Path: fc.at.ch, Shown: o.Shown() + " " + fc.at.shown, Removed: fc.removed}
			if fc.removed {
				d.Edit = fmt.Sprintf("del(%s | %s)", o.Select(), fc.at.yq)
			} else {
				value, _ := json.Marshal(fc.value)
				d.Edit = fmt.Sprintf("(%s | %s) = %s", o.Select(), fc.at.yq, value)
			}
			out = append(out, d)
		}
	}
	for _, o := range root.Objects {
		if !seen[o.id()] {
			out = append(out, Departure{Unit: class.Slug, Resource: o.Resource(), Shown: "removes " + o.Shown(), Deletes: true,
				ResourceType: o.APIVersion + "/" + o.Kind, ResourceName: o.Namespace + "/" + o.Name})
		}
	}
	return out
}
