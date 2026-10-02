package onboard

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
)

// fakeHub stands in for ConfigHub. A test gives it the answers its code asks
// for; a question it gave no answer to fails the test.
type fakeHub struct {
	t            *testing.T
	spaces       func(where string) ([]HubSpace, error)
	space        func(space string) (HubSpace, error)
	patch        func(space string, patch []byte) error
	units        func(space string) ([]HubUnit, error)
	unit         func(space, unit string) (HubUnit, error)
	revisions    func(space, unit, where string) ([]HubRevision, error)
	data         func(space, unit string, revision int) ([]byte, error)
	tagID        func(space, tag string) (string, error)
	releases     func(space string) ([]HubRelease, error)
	released     func(prefix string) ([]string, error)
	order        func(space, order string) (HubChangeOrder, error)
	attest       func(a HubAttestation, dryRun bool) (HubAttested, error)
	attestations func(changeOrderID string) (int, error)
	targets      func(space string) ([]string, error)
}

var _ Hub = (*fakeHub)(nil)
var _ Hub = (*SDKHub)(nil)

func (h *fakeHub) unexpected(call string, args ...any) error {
	h.t.Helper()
	h.t.Errorf("unexpected: Hub.%s%v", call, args)
	return fmt.Errorf("unexpected Hub.%s", call)
}

func (h *fakeHub) Spaces(where string) ([]HubSpace, error) {
	if h.spaces == nil {
		return nil, h.unexpected("Spaces", where)
	}
	return h.spaces(where)
}

func (h *fakeHub) Space(space string) (HubSpace, error) {
	if h.space == nil {
		return HubSpace{}, h.unexpected("Space", space)
	}
	return h.space(space)
}

func (h *fakeHub) PatchSpace(space string, patch []byte) error {
	if h.patch == nil {
		return h.unexpected("PatchSpace", space)
	}
	return h.patch(space, patch)
}

func (h *fakeHub) Units(space string) ([]HubUnit, error) {
	if h.units == nil {
		return nil, h.unexpected("Units", space)
	}
	return h.units(space)
}

func (h *fakeHub) Unit(space, unit string) (HubUnit, error) {
	if h.unit == nil {
		return HubUnit{}, h.unexpected("Unit", space, unit)
	}
	return h.unit(space, unit)
}

func (h *fakeHub) Revisions(space, unit, where string) ([]HubRevision, error) {
	if h.revisions == nil {
		return nil, h.unexpected("Revisions", space, unit, where)
	}
	return h.revisions(space, unit, where)
}

func (h *fakeHub) RevisionData(space, unit string, revision int) ([]byte, error) {
	if h.data == nil {
		return nil, h.unexpected("RevisionData", space, unit, revision)
	}
	return h.data(space, unit, revision)
}

func (h *fakeHub) TagID(space, tag string) (string, error) {
	if h.tagID == nil {
		return "", h.unexpected("TagID", space, tag)
	}
	return h.tagID(space, tag)
}

func (h *fakeHub) Releases(space string) ([]HubRelease, error) {
	if h.releases == nil {
		return nil, h.unexpected("Releases", space)
	}
	return h.releases(space)
}

func (h *fakeHub) ReleasedSpaces(prefix string) ([]string, error) {
	if h.released == nil {
		return nil, h.unexpected("ReleasedSpaces", prefix)
	}
	return h.released(prefix)
}

func (h *fakeHub) ChangeOrder(space, order string) (HubChangeOrder, error) {
	if h.order == nil {
		return HubChangeOrder{}, h.unexpected("ChangeOrder", space, order)
	}
	return h.order(space, order)
}

func (h *fakeHub) Attest(a HubAttestation, dryRun bool) (HubAttested, error) {
	if h.attest == nil {
		return HubAttested{}, h.unexpected("Attest", a.Space, dryRun)
	}
	return h.attest(a, dryRun)
}

func (h *fakeHub) AttestationCount(changeOrderID string) (int, error) {
	if h.attestations == nil {
		return 0, h.unexpected("AttestationCount", changeOrderID)
	}
	return h.attestations(changeOrderID)
}

func (h *fakeHub) TargetSlugs(space string) ([]string, error) {
	if h.targets == nil {
		return nil, h.unexpected("TargetSlugs", space)
	}
	return h.targets(space)
}

// A command that runs for days renews its login before each reading. With no
// saved login, as in a pipeline that passes only a token, it keeps the token
// it was started with.
func TestRenewKeepsTheTokenPassedWhenNoLoginIsSaved(t *testing.T) {
	t.Setenv("CUB_SERVER", "https://hub.example.com")
	t.Setenv("CUB_TOKEN", "passed")
	t.Setenv("CUB_CONFIG", filepath.Join(t.TempDir(), "none", "config.yaml"))
	t.Setenv("CUB_CONTEXT", "")
	h := NewHub("test")
	first, err := h.client(context.Background())
	if err != nil || first.Server != "https://hub.example.com" {
		t.Fatalf("the plugin connects as cub passed it: %+v %v", first, err)
	}
	if again, _ := h.client(context.Background()); again != first {
		t.Errorf("one connection is kept between questions")
	}
	h.Renew()
	renewed, err := h.client(context.Background())
	if err != nil || renewed == first || renewed.Server != "https://hub.example.com" {
		t.Errorf("after Renew the connection is made again, to the same server: %+v %v", renewed, err)
	}
}
