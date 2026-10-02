package onboard

import "time"

// The plugin asks ConfigHub what it holds through the SDK, in this process,
// rather than by running cub and reading what it prints. Hub is everything it
// asks; the SDK-backed answer is in hub_sdk.go, and tests stand in for it.
//
// Three things still run cub, because each is a cub command the user could
// run themselves and not a question: the validating function a check names
// (cub function vet), a cluster's facts (cub k8s collect), and a chart's
// rendering (cub helm template). The scripts apply writes call cub too: they
// are for a person to read and run.

// Hub is what the plugin asks ConfigHub at run time. A space or unit is named
// by its slug, or by its ID.
type Hub interface {
	// Spaces are the Spaces a where expression selects; every Space when it
	// is empty.
	Spaces(where string) ([]HubSpace, error)
	Space(space string) (HubSpace, error)
	// PatchSpace merges a JSON merge patch into the Space.
	PatchSpace(space string, patch []byte) error

	Units(space string) ([]HubUnit, error)
	Unit(space, unit string) (HubUnit, error)
	// Revisions are a unit's revisions a where expression selects; all of
	// them when it is empty.
	Revisions(space, unit, where string) ([]HubRevision, error)
	// RevisionData is the unit's configuration at that revision.
	RevisionData(space, unit string, revision int) ([]byte, error)
	// TagID is the ID of a Space's tag.
	TagID(space, tag string) (string, error)

	// Releases lists the Space's releases, published or not.
	Releases(space string) ([]HubRelease, error)
	// ReleasedSpaces names the Spaces whose slug starts with prefix and that
	// have a published release.
	ReleasedSpaces(prefix string) ([]string, error)

	ChangeOrder(space, order string) (HubChangeOrder, error)
	// Attest records an attestation of what a change order marks in a Space.
	// With dryRun it records nothing and reports what would be covered.
	Attest(a HubAttestation, dryRun bool) (HubAttested, error)
	// AttestationCount is how many attestations name the change order.
	AttestationCount(changeOrderID string) (int, error)

	// TargetSlugs names the Targets of a Space.
	TargetSlugs(space string) ([]string, error)
}

// HubSpace is one Space.
type HubSpace struct {
	ID, Slug    string
	Labels      map[string]string
	Annotations map[string]string
}

// HubUnit is one Unit.
type HubUnit struct {
	Slug      string
	SpaceSlug string
	// Head is its newest revision, and Released the one last released.
	Head, Released int
	// The unit it was cloned from, when it has one.
	UpstreamSpaceID, UpstreamUnitID string
}

// HubRevision is one revision of a Unit.
type HubRevision struct {
	Num int
	// Tags are the IDs of the tags that mark it.
	Tags map[string]bool
	// Failing says a validating Trigger recorded an error on it.
	Failing bool
}

// HubRelease is one release of a Space.
type HubRelease struct {
	Num       int
	Digest    string
	Published bool
	CreatedAt time.Time
}

// HubChangeOrder is a change order, with the stages its workflow had when it
// was created.
type HubChangeOrder struct {
	ID string
	// InScope are the IDs of the Spaces the order covers.
	InScope []string
	Stages  []stageGate
}

// HubAttestation is a verdict on what a change order marks in one Space.
type HubAttestation struct {
	Space         string
	Type          string
	ChangeOrderID string
	Claims        map[string]string
	Reject        bool
	Note          string
}

// HubAttested is what an attestation covers, and its ID once recorded.
type HubAttested struct {
	ID       string
	Subjects []subject
}
