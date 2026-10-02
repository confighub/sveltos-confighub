package onboard

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// A policy source is a file, or policies held in ConfigHub, where each has
// revisions like any other configuration:
//
//	<space>/<unit>              the unit's head revision
//	<space>/<unit>@<n>          its revision n
//	<space>/<unit>@Tag:<tag>    the revision the tag marks
//	<space>                     every unit in the Space, at its head
//	<space>@Tag:<tag>           every unit the tag marks, at that revision
//
// A path that exists is read as a file.

// The annotations that make an object a test case rather than a policy: the
// stage whose policies it meets, and the verdict it expects there.
const (
	StageAnnotation  = "impact.confighub.com/stage"
	ExpectAnnotation = "impact.confighub.com/expect"
)

// sourced is objects read from policy sources, each knowing where it came
// from, as a file or as <space>/<unit>@<revision>.
type sourced struct {
	docs   []Doc
	from   map[string]string // objectKey -> source
	sorted []string          // each source of policies, in the order read
	tests  []string          // each source of test cases
}

func readSources(hub Hub, refs []string) (sourced, error) {
	s := sourced{from: map[string]string{}}
	for _, ref := range refs {
		if _, err := os.Stat(ref); err == nil {
			data, err := os.ReadFile(ref)
			if err != nil {
				return s, err
			}
			docs, err := ParseDocs(data)
			if err != nil {
				return s, fmt.Errorf("%s: %w", ref, err)
			}
			s.add(ref, docs)
			continue
		}
		units, err := resolveRef(hub, ref)
		if err != nil {
			return s, err
		}
		for _, u := range units {
			docs, err := revisionDocs(hub, u.space, u.unit, u.rev)
			if err != nil {
				return s, err
			}
			s.add(fmt.Sprintf("%s/%s@%d", u.space, u.unit, u.rev), docs)
		}
	}
	return s, nil
}

func (s *sourced) add(from string, docs []Doc) {
	policies, tests := false, false
	for _, d := range docs {
		s.docs = append(s.docs, d)
		s.from[objectKey(d.Value)] = from
		if isTest(d) {
			tests = true
		} else {
			policies = true
		}
	}
	if policies {
		s.sorted = append(s.sorted, from)
	}
	if tests {
		s.tests = append(s.tests, from)
	}
}

// policies are the objects that are not test cases.
func (s sourced) policies() []Doc {
	var out []Doc
	for _, d := range s.docs {
		if !isTest(d) {
			out = append(out, d)
		}
	}
	return out
}

// policy says where the ValidatingAdmissionPolicy of that name came from.
func (s sourced) policy(name string) string {
	if name == "" {
		return ""
	}
	return s.from["ValidatingAdmissionPolicy//"+name]
}

func isTest(d Doc) bool {
	_, ok := obj(obj(d.Value["metadata"])["annotations"])[ExpectAnnotation]
	return ok
}

type unitRev struct {
	space, unit string
	rev         int
}

// resolveRef names the unit revisions a ConfigHub policy source holds.
func resolveRef(hub Hub, ref string) ([]unitRev, error) {
	path, rev, _ := strings.Cut(ref, "@")
	space, unit, _ := strings.Cut(path, "/")
	if space == "" || strings.Contains(unit, "/") {
		return nil, fmt.Errorf("%s is neither a file nor <space>[/<unit>][@<revision>]", ref)
	}
	tag, tagged := strings.CutPrefix(rev, "Tag:")
	num := 0
	if rev != "" && !tagged {
		n, err := strconv.Atoi(rev)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("%s: a revision is a number or Tag:<tag>", ref)
		}
		num = n
	}
	var units []HubUnit
	if unit != "" {
		u, err := hub.Unit(space, unit)
		if err != nil {
			return nil, fmt.Errorf("%s is neither a file nor a unit in ConfigHub", ref)
		}
		units = []HubUnit{u}
	} else {
		var err error
		if units, err = unitsOf(hub, space); err != nil {
			return nil, err
		}
		if len(units) == 0 {
			return nil, fmt.Errorf("%s holds no units", space)
		}
	}
	tagID := ""
	if tagged {
		id, err := hub.TagID(space, tag)
		if err != nil {
			return nil, fmt.Errorf("%s: no tag %s in %s", ref, tag, space)
		}
		tagID = id
	}
	var out []unitRev
	for _, u := range units {
		r := unitRev{space: space, unit: u.Slug, rev: num}
		switch {
		case tagged:
			r.rev = taggedRevision(hub, space, u.Slug, tagID)
			if r.rev == 0 {
				if unit != "" {
					return nil, fmt.Errorf("%s: no revision of %s/%s is tagged %s", ref, space, u.Slug, tag)
				}
				continue // a unit the tag does not mark is not in the set
			}
		case num == 0:
			r.rev = u.Head
		}
		out = append(out, r)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no unit in %s has a revision tagged %s", ref, space, tag)
	}
	return out, nil
}

// taggedRevision is the revision of a unit a tag marks, or 0.
func taggedRevision(hub Hub, space, unit, tagID string) int {
	revs, err := hub.Revisions(space, unit, "Tags ? '"+tagID+"'")
	if err != nil {
		return 0
	}
	for _, r := range revs {
		if r.Tags[tagID] {
			return r.Num
		}
	}
	return 0
}

// testCase is an object with its impact annotations taken off, so the
// sandbox sees the object as it would be written.
func testCase(d Doc) (stage, expect string, v map[string]any) {
	v = map[string]any{}
	for k, val := range d.Value {
		v[k] = val
	}
	meta := map[string]any{}
	for k, val := range obj(d.Value["metadata"]) {
		meta[k] = val
	}
	notes := map[string]any{}
	for k, val := range obj(meta["annotations"]) {
		switch k {
		case StageAnnotation:
			stage = str(val)
		case ExpectAnnotation:
			expect = str(val)
		default:
			notes[k] = val
		}
	}
	delete(meta, "annotations")
	if len(notes) > 0 {
		meta["annotations"] = notes
	}
	v["metadata"] = meta
	return stage, expect, v
}
