package onboard

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// parityFinding is one variant's departures from the stage it must match:
// those a guard declares, with why, and those nothing declares.
type parityFinding struct {
	undeclared, declared []string
	// against is what it was compared with, as <space>/<unit>@<revision>.
	against []string
}

// paritySide is one unit of a variant of the stage to match, as it runs or
// will run under the change order.
type paritySide struct {
	space, unit string
	rev         int
	objects     []Object
}

// paritySpot is one place a variant departs from the stage it must match.
type paritySpot struct {
	resource string
	// path is the field as ConfigHub resolves it, which a guard names; empty
	// for an object one side has and the other does not.
	path  string
	shown string
}

// parityJudge compares each variant the change order marks revisions in with
// every variant of the stage it must match, unit by unit, and sorts what
// differs into declared and undeclared departures.
func parityJudge(hub Hub, co HubChangeOrder, opts CheckOptions, subjects map[string][]subject) (map[string]*parityFinding, error) {
	with := opts.Parity.With
	where := ""
	for _, s := range co.Stages {
		if s.Name == with {
			where = s.WhereSpace
		}
	}
	if where == "" {
		return nil, fmt.Errorf("change order %s has no stage %s to match", opts.ChangeOrder, with)
	}
	spaces, err := hub.Spaces(where)
	if err != nil {
		return nil, fmt.Errorf("reading the Spaces of stage %s: %w", with, err)
	}
	inScope := map[string]bool{}
	for _, id := range co.InScope {
		inScope[id] = true
	}
	var sides []paritySide
	for _, sp := range spaces {
		if !inScope[sp.ID] {
			continue
		}
		runs, err := parityRuns(hub, co, opts, sp.Slug)
		if err != nil {
			return nil, err
		}
		sides = append(sides, runs...)
	}
	if len(sides) == 0 {
		return nil, fmt.Errorf("stage %s has nothing to match: no variant of it in change order %s runs or will run a unit", with, opts.ChangeOrder)
	}
	sort.Slice(sides, func(i, j int) bool { return sides[i].space+"/"+sides[i].unit < sides[j].space+"/"+sides[j].unit })
	stageUnits := map[string]bool{}
	for _, w := range sides {
		stageUnits[w.unit] = true
	}

	out := map[string]*parityFinding{}
	for space, subs := range subjects {
		if len(subs) == 0 {
			continue
		}
		f := &parityFinding{}
		out[space] = f
		// Every unit the variant will run: what the order marks, and what it
		// last released where the order marks nothing.
		mine, err := parityRuns(hub, co, opts, space)
		if err != nil {
			return nil, err
		}
		have := map[string]bool{}
		for _, m := range mine {
			have[m.unit] = true
			rev := fmt.Sprintf("%s/%d", m.unit, m.rev)
			// The declarations are the unit's guards as they stand.
			u, err := hub.Unit(space, m.unit)
			if err != nil {
				return nil, fmt.Errorf("%s/%s: %w", space, m.unit, err)
			}
			judge := func(spots []paritySpot) {
				for _, d := range spots {
					line := rev + ": " + d.shown
					if why, ok := declaredBy(u.Guards, d, opts.Parity.DeclaredBy); ok {
						f.declared = append(f.declared, fmt.Sprintf("%s (%s=%s)", line, opts.Parity.DeclaredBy, why))
					} else {
						f.undeclared = append(f.undeclared, line+", and no guard "+opts.Parity.DeclaredBy+"=<why> declares it")
					}
				}
			}
			if !stageUnits[m.unit] {
				// A unit only this variant runs departs object by object, so a
				// guard on each object can declare it.
				judge(parityDepartures(nil, m.objects, "stage "+with))
				continue
			}
			for _, w := range sides {
				if w.unit != m.unit {
					continue
				}
				f.against = append(f.against, fmt.Sprintf("%s/%s@%d", w.space, w.unit, w.rev))
				judge(parityDepartures(w.objects, m.objects, w.space))
			}
		}
		for _, w := range sides {
			if !have[w.unit] {
				f.undeclared = append(f.undeclared, fmt.Sprintf("%s runs unit %s (revision %d), and this variant does not", w.space, w.unit, w.rev))
			}
		}
		sort.Strings(f.against)
	}
	return out, nil
}

// parityRuns are the units a Space runs, or will run under the change order:
// each at the revision the order marks, or at its last release.
func parityRuns(hub Hub, co HubChangeOrder, opts CheckOptions, space string) ([]paritySide, error) {
	dry, err := hub.Attest(HubAttestation{Space: space, Type: opts.Type, ChangeOrderID: co.ID}, true)
	if err != nil {
		return nil, fmt.Errorf("%s: reading what the change order marks: %w", space, err)
	}
	marked := map[string]int{}
	for _, s := range dry.Subjects {
		marked[s.UnitSlug] = s.RevisionNum
	}
	units, err := unitsOf(hub, space)
	if err != nil {
		return nil, err
	}
	var out []paritySide
	for _, u := range units {
		rev, ok := marked[u.Slug]
		if !ok {
			rev = u.Released
		}
		if rev == 0 {
			continue
		}
		data, err := hub.RevisionData(space, u.Slug, rev)
		if err != nil {
			return nil, fmt.Errorf("%s/%s revision %d: %w", space, u.Slug, rev, err)
		}
		objects, err := objectsOf(data)
		if err != nil {
			return nil, fmt.Errorf("%s/%s revision %d: %w", space, u.Slug, rev, err)
		}
		out = append(out, paritySide{space: space, unit: u.Slug, rev: rev, objects: objects})
	}
	return out, nil
}

// parityDepartures are where here departs from with: objects only one of them
// holds, and, object by object, each field they hold differently.
func parityDepartures(with, here []Object, withName string) []paritySpot {
	byID := map[string]Object{}
	for _, o := range with {
		byID[o.id()] = o
	}
	seen := map[string]bool{}
	var out []paritySpot
	for _, o := range here {
		seen[o.id()] = true
		w, ok := byID[o.id()]
		if !ok {
			out = append(out, paritySpot{resource: o.Resource(), shown: fmt.Sprintf("%s is here and not in %s", o.Shown(), withName)})
			continue
		}
		var changes []fieldChange
		for _, fc := range fieldChanges(w.Value, o.Value, fieldPath{}) {
			changes = append(changes, leafChanges(fc)...)
		}
		secret := o.Kind == "Secret"
		for _, fc := range changes {
			out = append(out, paritySpot{resource: o.Resource(), path: fc.at.ch,
				shown: fmt.Sprintf("%s %s is %s here and %s in %s", o.Shown(), fc.at.shown, shownValue(fc.value, fc.removed, secret), shownValue(fc.old, fc.old == nil, secret), withName)})
		}
	}
	for _, o := range with {
		if !seen[o.id()] {
			out = append(out, paritySpot{resource: o.Resource(), shown: fmt.Sprintf("%s is in %s and not here", o.Shown(), withName)})
		}
	}
	return out
}

// leafChanges splits a change to a whole map that one side does not have into
// a change to each field it holds, so a guard on one field declares just that.
func leafChanges(fc fieldChange) []fieldChange {
	split := func(m map[string]any, one func(k string) fieldChange) []fieldChange {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var out []fieldChange
		for _, k := range keys {
			out = append(out, leafChanges(one(k))...)
		}
		return out
	}
	if m, ok := fc.value.(map[string]any); ok && fc.old == nil && len(m) > 0 {
		return split(m, func(k string) fieldChange { return fieldChange{at: fc.at.key(k), value: m[k]} })
	}
	if m, ok := fc.old.(map[string]any); ok && fc.removed && len(m) > 0 {
		return split(m, func(k string) fieldChange { return fieldChange{at: fc.at.key(k), removed: true, old: m[k]} })
	}
	return []fieldChange{fc}
}

// shownValue is a value as the check prints it and records it in the
// attestation: a Secret's values are never shown, only that they differ.
func shownValue(v any, unset, secret bool) string {
	if unset {
		return "unset"
	}
	if secret {
		return "set (a Secret's value, not shown)"
	}
	var b strings.Builder
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	r := []rune(strings.TrimSpace(b.String()))
	if len(r) > 60 {
		r = append(r[:57], []rune("...")...)
	}
	return string(r)
}

// declaredBy finds the guard that declares a departure, as ConfigHub reads
// the guards in force at a path: its own, then each ancestor's, then the
// object's, the nearest naming the key saying why.
func declaredBy(guards map[string]map[string]map[string]string, d paritySpot, key string) (string, bool) {
	paths := guards[d.resource]
	for p := d.path; p != ""; {
		if why, ok := paths[p][key]; ok {
			return why, true
		}
		// Dots inside a segment are escaped, so a dot ends one.
		i := strings.LastIndex(p, ".")
		if i < 0 {
			break
		}
		p = p[:i]
	}
	why, ok := paths[""][key]
	return why, ok
}
