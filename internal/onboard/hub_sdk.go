package onboard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/confighub/sdk/core/cubapi"
	goclientnew "github.com/confighub/sdk/core/openapi/goclient-new"
	"github.com/google/uuid"
)

// SDKHub answers Hub through the ConfigHub SDK, as the user cub is logged in
// as: the context and token cub passes a plugin, or the active context.
type SDKHub struct {
	agent string

	mu   sync.Mutex
	conn *cubapi.Client
	// context is the name of the cub context this process connected as, when
	// it is known: the one cub passed, or the active one when run alone.
	context string
	stale   bool
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
// cub. It stays in the context it started in, on the same server.
func (h *SDKHub) Renew() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stale = h.conn != nil
}

func (h *SDKHub) client(ctx context.Context) (*cubapi.Client, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	opts := cubapi.ClientOptions{UserAgent: h.agent}
	if h.conn == nil {
		c, name, err := connect(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("connecting to ConfigHub: %w", err)
		}
		h.conn, h.context = c, name
		return c, nil
	}
	if h.stale {
		c, err := savedLogin(ctx, opts, h.context, h.conn.Server)
		if err != nil {
			return nil, fmt.Errorf("reading the saved login: %w", err)
		}
		if c != nil {
			h.conn = c
		}
		h.stale = false
	}
	return h.conn, nil
}

// connect is the first connection: as cub passed this plugin, or as the
// active context when run alone. It names the context it connected as.
func connect(ctx context.Context, opts cubapi.ClientOptions) (*cubapi.Client, string, error) {
	env, err := cubapi.LoadEnvironment(ctx)
	if err != nil {
		return nil, "", err
	}
	if env.HasCredentials() {
		c, err := cubapi.NewClientFromEnvironment(ctx, opts)
		return c, env.Context, err
	}
	// CUB_CONFIG names the directory the config is in, which is what
	// LoadConfig reads when it is given no path.
	store, err := cubapi.LoadConfig("")
	if err != nil {
		return nil, "", err
	}
	if env.Context != "" {
		if err := store.Use(env.Context); err != nil {
			return nil, "", err
		}
	}
	active, err := store.ActiveContext()
	if err != nil {
		return nil, "", err
	}
	c, err := cubapi.NewClientFromConfig(ctx, store, opts)
	return c, active.Name, err
}

// savedLogin is the login cub has saved for the context this process
// connected as. It is nil when there is none to use: no saved login at all,
// as in a pipeline that passes only a token; a context that is gone or
// logged out; or one that now names another server.
func savedLogin(ctx context.Context, opts cubapi.ClientOptions, name, server string) (*cubapi.Client, error) {
	store, err := cubapi.LoadConfig("")
	if err != nil {
		return nil, err
	}
	if name != "" {
		if err := store.Use(name); err != nil {
			return nil, nil
		}
	}
	active, err := store.ActiveContext()
	if err != nil || !cubapi.SameServer(active.Coordinate.ServerURL, server) {
		return nil, nil
	}
	c, err := cubapi.NewClientFromConfig(ctx, store, opts)
	if err != nil {
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
	if u.PathAnnotations != nil {
		for _, r := range *u.PathAnnotations {
			if r.Resource == nil {
				continue
			}
			res := r.Resource.ResourceType + ":" + r.Resource.ResourceName
			add := func(path string, a goclientnew.PathAnnotations) {
				for k, v := range a["Guard"] {
					if out.Guards == nil {
						out.Guards = map[string]map[string]map[string]string{}
					}
					if out.Guards[res] == nil {
						out.Guards[res] = map[string]map[string]string{}
					}
					if out.Guards[res][path] == nil {
						out.Guards[res][path] = map[string]string{}
					}
					out.Guards[res][path][k] = v
				}
			}
			if r.ResourceAnnotations != nil {
				add("", *r.ResourceAnnotations)
			}
			for path, a := range r.PathAnnotationMap {
				add(path, a)
			}
		}
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
			return nil, fmt.Errorf("reading revision %d of %s: %s", revision, unit, res.Status())
		}
		if len(res.Body) == 0 {
			return nil, fmt.Errorf("no config data for revision %d of unit %s", revision, unit)
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
	// Named fields only: a release's bundle is large, and none of it is
	// wanted here.
	fields := "ReleaseID,ReleaseNum,SpaceID,OrganizationID,Published,TargetID,ManifestDigest,CreatedAt,LiveStatus"
	res, err := c.API.ListExtendedReleasesWithResponse(ctx, s.SpaceID, &goclientnew.ListExtendedReleasesParams{Select: &fields})
	if cubapi.IsAPIError(err, res) {
		return nil, cubapi.InterpretErrorGeneric(err, res)
	}
	var out []HubRelease
	if res.JSON200 == nil {
		return out, nil
	}
	for _, er := range *res.JSON200 {
		r := er.Release
		if r == nil {
			continue
		}
		hr := HubRelease{Num: int(r.ReleaseNum), Digest: r.ManifestDigest, Published: r.Published, CreatedAt: r.CreatedAt}
		hr.Current = s.ReleaseTargetID != nil && r.TargetID != nil && *r.TargetID == *s.ReleaseTargetID
		if ls := r.LiveStatus; ls != nil {
			hr.Live = &LiveStatus{
				Reporter: ls.Reporter, DataSource: ls.DataSource,
				Sync: string(ls.Sync), Health: string(ls.Health), Operation: string(ls.Operation),
				ReporterSync: ls.ReporterSync, ReporterHealth: ls.ReporterHealth, ReporterOperation: ls.ReporterOperation,
				Message: ls.Message,
			}
			if !ls.ObservedAt.IsZero() {
				hr.Live.ObservedAt = ls.ObservedAt.UTC().Format(time.RFC3339)
			}
		}
		out = append(out, hr)
	}
	return out, nil
}

// SetLiveStatus records a reading on one release. Every field is sent, an
// empty one as null: a merge patch keeps what it does not name, and a word
// left over from the reading before would not be this reading's.
func (h *SDKHub) SetLiveStatus(space string, release int, st LiveStatus) error {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return err
	}
	s, err := h.resolveSpace(ctx, c, space)
	if err != nil {
		return err
	}
	where := "ReleaseNum = " + strconv.Itoa(release)
	only := "ReleaseID,ReleaseNum,SpaceID,OrganizationID"
	res, err := c.API.ListExtendedReleasesWithResponse(ctx, s.SpaceID, &goclientnew.ListExtendedReleasesParams{Where: &where, Select: &only})
	if cubapi.IsAPIError(err, res) {
		return cubapi.InterpretErrorGeneric(err, res)
	}
	var releaseID *goclientnew.UUID
	if res.JSON200 != nil {
		for _, er := range *res.JSON200 {
			if er.Release != nil && int(er.Release.ReleaseNum) == release {
				releaseID = &er.Release.ReleaseID
			}
		}
	}
	if releaseID == nil {
		return fmt.Errorf("release %d not found in space %s", release, space)
	}
	if _, err := time.Parse(time.RFC3339, st.ObservedAt); err != nil {
		return fmt.Errorf("the status names no time it was observed: %w", err)
	}
	fields := map[string]any{}
	for name, value := range map[string]string{
		"Reporter": st.Reporter, "DataSource": st.DataSource,
		"Sync": st.Sync, "Health": st.Health, "Operation": st.Operation,
		"ReporterSync": st.ReporterSync, "ReporterHealth": st.ReporterHealth, "ReporterOperation": st.ReporterOperation,
		"Message": st.Message, "ObservedAt": st.ObservedAt,
	} {
		if value == "" {
			fields[name] = nil
		} else {
			fields[name] = value
		}
	}
	patch, err := json.Marshal(map[string]any{"LiveStatus": fields})
	if err != nil {
		return err
	}
	pres, err := c.API.PatchReleaseWithBodyWithResponse(ctx, s.SpaceID, *releaseID, &goclientnew.PatchReleaseParams{}, "application/merge-patch+json", bytes.NewReader(patch))
	if cubapi.IsAPIError(err, pres) {
		return cubapi.InterpretErrorGeneric(err, pres)
	}
	return nil
}

func (h *SDKHub) ReleasedSpaces(prefix string) ([]string, error) {
	ctx := context.Background()
	c, err := h.client(ctx)
	if err != nil {
		return nil, err
	}
	where := fmt.Sprintf("Published = true AND Space.Slug LIKE '%s%%'", prefix)
	res, err := c.API.ListAllReleasesWithResponse(ctx, &goclientnew.ListAllReleasesParams{Where: &where})
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
		case er.Release != nil && er.Release.SpaceSlug != "":
			seen[er.Release.SpaceSlug] = true
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
