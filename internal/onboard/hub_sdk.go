package onboard

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"sync"

	"github.com/confighub/sdk/core/cubapi"
	goclientnew "github.com/confighub/sdk/core/openapi/goclient-new"
	"github.com/google/uuid"
)

// SDKHub answers Hub through the ConfigHub SDK, as the user cub is logged in
// as: the context and token cub passes a plugin, or the active context.
type SDKHub struct {
	agent string

	mu      sync.Mutex
	conn    *cubapi.Client
	renewed bool
}

// NewHub is the Hub the commands use. It connects on first use, so a command
// that asks ConfigHub nothing needs no login.
func NewHub(version string) *SDKHub {
	return &SDKHub{agent: "cub-sveltos/" + version}
}

// Renew makes the next question read the login cub has saved, in place of the
// token this process was started with. A command that runs for days calls it
// before each reading: a token expires, and cub auth login in another
// terminal then reaches the running command, as it did when each reading ran
// cub.
func (h *SDKHub) Renew() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.conn, h.renewed = nil, true
}

func (h *SDKHub) client(ctx context.Context) (*cubapi.Client, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conn != nil {
		return h.conn, nil
	}
	opts := cubapi.ClientOptions{UserAgent: h.agent}
	var c *cubapi.Client
	var err error
	if h.renewed {
		c, err = savedLogin(ctx, opts)
	}
	if c == nil {
		// What cub passed this plugin, or the saved login when run alone.
		c, err = cubapi.ResolveClient(ctx, opts)
	}
	if err != nil {
		return nil, fmt.Errorf("connecting to ConfigHub: %w", err)
	}
	h.conn = c
	return c, nil
}

// savedLogin is the login cub has saved for the context this process runs
// in, or nil when there is none, as in a pipeline that passes only a token.
func savedLogin(ctx context.Context, opts cubapi.ClientOptions) (*cubapi.Client, error) {
	env, err := cubapi.LoadEnvironment(ctx)
	if err != nil {
		return nil, err
	}
	store, err := cubapi.LoadConfig(env.Config)
	if err != nil {
		return nil, err
	}
	if env.Context != "" {
		if err := store.Use(env.Context); err != nil {
			return nil, err
		}
	}
	c, err := cubapi.NewClientFromConfig(ctx, store, opts)
	if err != nil {
		return nil, err
	}
	// A saved login for another server is not this process's login.
	if env.Server != "" && !cubapi.SameServer(env.Server, c.Server) {
		return nil, nil
	}
	return c, nil
}

func (h *SDKHub) resolveSpace(ctx context.Context, c *cubapi.Client, space string) (*goclientnew.Space, error) {
	s, err := cubapi.ResolveSpace(ctx, c, cubapi.ParseRef(space), cubapi.ResolveOpts{})
	if err != nil {
		return nil, err
	}
	if s.Space == nil {
		return nil, fmt.Errorf("space %s not found", space)
	}
	return s.Space, nil
}

func (h *SDKHub) resolveUnit(ctx context.Context, c *cubapi.Client, space, unit string) (*goclientnew.ExtendedUnit, error) {
	u, err := cubapi.ResolveUnit(ctx, c, cubapi.NewRef(space, unit), cubapi.ResolveOpts{})
	if err != nil {
		return nil, err
	}
	if u.Unit == nil {
		return nil, fmt.Errorf("unit %s not found in space %s", unit, space)
	}
	return u, nil
}

func hubSpace(s *goclientnew.Space) HubSpace {
	return HubSpace{ID: s.SpaceID.String(), Slug: s.Slug, Labels: s.Labels, Annotations: s.Annotations}
}

func hubUnit(e *goclientnew.ExtendedUnit) HubUnit {
	u := e.Unit
	out := HubUnit{Slug: u.Slug, SpaceSlug: u.SpaceSlug, Head: int(u.HeadRevisionNum), Released: int(u.LastReleasedRevisionNum)}
	if out.SpaceSlug == "" && e.Space != nil {
		out.SpaceSlug = e.Space.Slug
	}
	if u.UpstreamSpaceID != nil && u.UpstreamUnitID != nil {
		out.UpstreamSpaceID, out.UpstreamUnitID = u.UpstreamSpaceID.String(), u.UpstreamUnitID.String()
	}
	return out
}

func (h *SDKHub) Spaces(where string) ([]HubSpace, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	spaces, err := cubapi.ListSpaces(ctx, c, cubapi.NewWhere(where), cubapi.ListOpts{})
	if err != nil {
		return nil, err
	}
	var out []HubSpace
	for _, s := range spaces {
		if s.Space != nil {
			out = append(out, hubSpace(s.Space))
		}
	}
	return out, nil
}

func (h *SDKHub) Space(space string) (HubSpace, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return HubSpace{}, err
	}
	s, err := h.resolveSpace(ctx, c, space)
	if err != nil {
		return HubSpace{}, err
	}
	return hubSpace(s), nil
}

func (h *SDKHub) PatchSpace(space string, patch []byte) error {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return err
	}
	s, err := h.resolveSpace(ctx, c, space)
	if err != nil {
		return err
	}
	res, err := c.API.PatchSpaceWithBodyWithResponse(ctx, s.SpaceID, &goclientnew.PatchSpaceParams{}, "application/merge-patch+json", bytes.NewReader(patch))
	if cubapi.IsAPIError(err, res) {
		return cubapi.InterpretErrorGeneric(err, res)
	}
	return nil
}

func (h *SDKHub) Units(space string) ([]HubUnit, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	s, err := h.resolveSpace(ctx, c, space)
	if err != nil {
		return nil, err
	}
	units, err := cubapi.ListUnits(ctx, c, cubapi.Where{}.SpaceID(s.SpaceID), cubapi.ListOpts{})
	if err != nil {
		return nil, err
	}
	var out []HubUnit
	for _, u := range units {
		if u.Unit == nil {
			continue
		}
		one := hubUnit(u)
		if one.SpaceSlug == "" {
			one.SpaceSlug = s.Slug
		}
		out = append(out, one)
	}
	return out, nil
}

func (h *SDKHub) Unit(space, unit string) (HubUnit, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return HubUnit{}, err
	}
	u, err := h.resolveUnit(ctx, c, space, unit)
	if err != nil {
		return HubUnit{}, err
	}
	out := hubUnit(u)
	if out.SpaceSlug == "" {
		// A unit named by its Space's ID: read the slug from the Space.
		s, err := cubapi.ResolveSpace(ctx, c, cubapi.RefFromID(u.Unit.SpaceID), cubapi.ResolveOpts{})
		if err != nil {
			return HubUnit{}, err
		}
		if s.Space != nil {
			out.SpaceSlug = s.Space.Slug
		}
	}
	return out, nil
}

func (h *SDKHub) revisions(ctx context.Context, c *cubapi.Client, u *goclientnew.Unit, where string) ([]goclientnew.ExtendedRevision, error) {
	params := &goclientnew.ListExtendedRevisionsParams{}
	if where != "" {
		params.Where = &where
	}
	res, err := c.API.ListExtendedRevisionsWithResponse(ctx, u.SpaceID, u.UnitID, params)
	if cubapi.IsAPIError(err, res) {
		return nil, cubapi.InterpretErrorGeneric(err, res)
	}
	if res.JSON200 == nil {
		return nil, nil
	}
	return *res.JSON200, nil
}

func (h *SDKHub) Revisions(space, unit, where string) ([]HubRevision, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	u, err := h.resolveUnit(ctx, c, space, unit)
	if err != nil {
		return nil, err
	}
	revs, err := h.revisions(ctx, c, u.Unit, where)
	if err != nil {
		return nil, err
	}
	var out []HubRevision
	for _, r := range revs {
		if r.Revision == nil {
			continue
		}
		one := HubRevision{Num: int(r.Revision.RevisionNum), Tags: map[string]bool{}, Failing: len(r.Revision.ValidationErrors) > 0}
		for id := range r.Revision.Tags {
			one.Tags[id] = true
		}
		out = append(out, one)
	}
	return out, nil
}

func (h *SDKHub) RevisionData(space, unit string, revision int) ([]byte, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	u, err := h.resolveUnit(ctx, c, space, unit)
	if err != nil {
		return nil, err
	}
	revs, err := h.revisions(ctx, c, u.Unit, "RevisionNum = "+strconv.Itoa(revision))
	if err != nil {
		return nil, err
	}
	for _, r := range revs {
		if r.Revision == nil || int(r.Revision.RevisionNum) != revision {
			continue
		}
		// The body is the configuration itself, not a JSON envelope.
		res, err := c.API.DownloadRevisionDataWithResponse(ctx, u.Unit.SpaceID, u.Unit.UnitID, r.Revision.RevisionID)
		if err != nil {
			return nil, err
		}
		if res.StatusCode() != http.StatusOK {
			if apiErr := cubapi.InterpretErrorGeneric(nil, res); apiErr != nil {
				return nil, apiErr
			}
			return nil, fmt.Errorf("reading revision %d of %s: %s", revision, unit, res.Status())
		}
		return res.Body, nil
	}
	return nil, fmt.Errorf("revision %d of %s not found in space %s", revision, unit, space)
}

func (h *SDKHub) TagID(space, tag string) (string, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return "", err
	}
	t, err := cubapi.ResolveTag(ctx, c, cubapi.NewRef(space, tag), cubapi.ResolveOpts{})
	if err != nil {
		return "", err
	}
	if t.Tag == nil {
		return "", fmt.Errorf("tag %s not found in space %s", tag, space)
	}
	return t.Tag.TagID.String(), nil
}

func (h *SDKHub) Releases(space string) ([]HubRelease, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	s, err := h.resolveSpace(ctx, c, space)
	if err != nil {
		return nil, err
	}
	res, err := c.API.ListExtendedReleasesWithResponse(ctx, s.SpaceID, &goclientnew.ListExtendedReleasesParams{})
	if cubapi.IsAPIError(err, res) {
		return nil, cubapi.InterpretErrorGeneric(err, res)
	}
	var out []HubRelease
	if res.JSON200 == nil {
		return out, nil
	}
	for _, er := range *res.JSON200 {
		if r := er.Release; r != nil {
			out = append(out, HubRelease{Num: int(r.ReleaseNum), Digest: r.ManifestDigest, Published: r.Published, CreatedAt: r.CreatedAt})
		}
	}
	return out, nil
}

func (h *SDKHub) ReleasedSpaces(prefix string) ([]string, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	where := fmt.Sprintf("Published = true AND Space.Slug LIKE '%s%%'", prefix)
	include := "SpaceID"
	res, err := c.API.ListAllReleasesWithResponse(ctx, &goclientnew.ListAllReleasesParams{Where: &where, Include: &include})
	if cubapi.IsAPIError(err, res) {
		return nil, cubapi.InterpretErrorGeneric(err, res)
	}
	if res.JSON200 == nil {
		return nil, nil
	}
	seen := map[string]bool{}
	var unnamed []goclientnew.UUID
	for _, er := range *res.JSON200 {
		switch {
		case er.Space != nil && er.Space.Slug != "":
			seen[er.Space.Slug] = true
		case er.Release != nil:
			unnamed = append(unnamed, er.Release.SpaceID)
		}
	}
	if len(unnamed) > 0 {
		slugs, err := cubapi.SpaceSlugByID(ctx, c)
		if err != nil {
			return nil, err
		}
		for _, id := range unnamed {
			if slug := slugs[id]; slug != "" {
				seen[slug] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for slug := range seen {
		out = append(out, slug)
	}
	sort.Strings(out)
	return out, nil
}

func (h *SDKHub) ChangeOrder(space, order string) (HubChangeOrder, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return HubChangeOrder{}, err
	}
	e, err := cubapi.ResolveChangeOrder(ctx, c, cubapi.NewRef(space, order), cubapi.ResolveOpts{})
	if err != nil {
		return HubChangeOrder{}, err
	}
	if e.ChangeOrder == nil {
		return HubChangeOrder{}, fmt.Errorf("change order %s not found in space %s", order, space)
	}
	out := HubChangeOrder{ID: e.ChangeOrder.ChangeOrderID.String()}
	for _, id := range e.ChangeOrder.InScopeSpaceIDs {
		out.InScope = append(out.InScope, id.String())
	}
	if w := e.ChangeOrder.ChangeWorkflow; w != nil {
		for _, s := range w.Stages {
			out.Stages = append(out.Stages, stageGate{Name: s.Name, WhereSpace: s.WhereSpace, Prerequisites: s.Prerequisites, ReleasePrerequisites: s.ReleasePrerequisites})
		}
	}
	return out, nil
}

func (h *SDKHub) Attest(a HubAttestation, dryRun bool) (HubAttested, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return HubAttested{}, err
	}
	s, err := h.resolveSpace(ctx, c, a.Space)
	if err != nil {
		return HubAttested{}, err
	}
	order, err := uuid.Parse(a.ChangeOrderID)
	if err != nil {
		return HubAttested{}, fmt.Errorf("change order %s: %w", a.ChangeOrderID, err)
	}
	req := goclientnew.AttestationCreateRequest{Type: a.Type, Note: a.Note, Claims: a.Claims, ChangeOrderID: &order}
	if a.Reject {
		req.Result = "Fail"
	}
	res, err := cubapi.CreateAttestation(ctx, c, s.SpaceID, req, dryRun)
	if err != nil {
		return HubAttested{}, err
	}
	var out HubAttested
	for _, sub := range res.Subjects {
		out.Subjects = append(out.Subjects, subject{UnitSlug: sub.UnitSlug, RevisionNum: int(sub.RevisionNum)})
	}
	// A dry run answers with an attestation that has no ID.
	if res.Attestation != nil && res.Attestation.AttestationID != uuid.Nil {
		out.ID = res.Attestation.AttestationID.String()
	}
	return out, nil
}

func (h *SDKHub) AttestationCount(changeOrderID string) (int, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return 0, err
	}
	found, err := cubapi.ListAttestations(ctx, c, cubapi.NewWhere(fmt.Sprintf("ChangeOrderID = '%s'", changeOrderID)), cubapi.ListOpts{})
	if err != nil {
		return 0, err
	}
	return len(found), nil
}

func (h *SDKHub) TargetSlugs(space string) ([]string, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	s, err := h.resolveSpace(ctx, c, space)
	if err != nil {
		return nil, err
	}
	targets, err := cubapi.ListTargets(ctx, c, cubapi.Where{}.SpaceID(s.SpaceID), cubapi.ListOpts{})
	if err != nil {
		return nil, err
	}
	var slugs []string
	for _, t := range targets {
		if t.Target != nil {
			slugs = append(slugs, t.Target.Slug)
		}
	}
	return slugs, nil
}
