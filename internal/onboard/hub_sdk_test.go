package onboard

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/confighub/sdk/core/cubapi"
)

const (
	spaceID         = "11111111-1111-1111-1111-111111111111"
	orderID         = "33333333-3333-3333-3333-333333333333"
	unitID          = "44444444-4444-4444-4444-444444444444"
	revisionID      = "55555555-5555-5555-5555-555555555555"
	emptyRevisionID = "66666666-6666-6666-6666-666666666666"
	revisions       = "/api/space/" + spaceID + "/unit/" + unitID + "/revision"
)

// asked is one request ConfigHub received.
type asked struct {
	method, path, where, contentType, token, body string
	dryRun                                        bool
}

// hubServer stands in for ConfigHub's API, and records what it was asked.
func hubServer(t *testing.T) (*httptest.Server, *[]asked) {
	t.Helper()
	var got []asked
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = append(got, asked{method: r.Method, path: r.URL.Path, where: r.URL.Query().Get("where"), contentType: r.Header.Get("Content-Type"),
			token: strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), body: string(body), dryRun: r.URL.Query().Get("dry_run") == "true"})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/space":
			fmt.Fprintf(w, `[{"Space":{"SpaceID":%q,"Slug":"s"}}]`, spaceID)
		case r.Method == "POST" && r.URL.Path == "/api/space/"+spaceID+"/attestation":
			id := "22222222-2222-2222-2222-222222222222"
			if r.URL.Query().Get("dry_run") == "true" {
				id = "00000000-0000-0000-0000-000000000000"
			}
			fmt.Fprintf(w, `{"Attestation":{"AttestationID":%q},"Subjects":[{"UnitSlug":"u","RevisionNum":3}]}`, id)
		case r.Method == "PATCH" && r.URL.Path == "/api/space/"+spaceID:
			fmt.Fprintf(w, `{"SpaceID":%q,"Slug":"s"}`, spaceID)
		case r.Method == "GET" && r.URL.Path == "/api/release":
			fmt.Fprint(w, `[{"Release":{"SpaceSlug":"sveltos-b","Published":true}},{"Release":{"SpaceSlug":"sveltos-a","Published":true}},{"Release":{"SpaceSlug":"sveltos-a","Published":true}}]`)
		case r.Method == "GET" && r.URL.Path == "/api/attestation":
			fmt.Fprint(w, `[{"Attestation":{}},{"Attestation":{}}]`)
		case r.Method == "GET" && r.URL.Path == "/api/unit":
			fmt.Fprintf(w, `[{"Unit":{"UnitID":%q,"SpaceID":%q,"Slug":"u","SpaceSlug":"s","HeadRevisionNum":4,"LastReleasedRevisionNum":3}}]`, unitID, spaceID)
		case r.Method == "GET" && r.URL.Path == revisions:
			fmt.Fprintf(w, `[{"Revision":{"RevisionID":%q,"RevisionNum":3,"Tags":{"tag-a":""},"ValidationErrors":{"policies/vet":true}}},
			  {"Revision":{"RevisionID":%q,"RevisionNum":4,"Tags":{"tag-a":""}}}]`, revisionID, emptyRevisionID)
		case r.Method == "GET" && r.URL.Path == revisions+"/"+revisionID+"/data":
			w.Header().Set("Content-Type", "application/octet-stream")
			fmt.Fprint(w, "kind: ConfigMap\n")
		case r.Method == "GET" && r.URL.Path == revisions+"/"+emptyRevisionID+"/data":
			w.Header().Set("Content-Type", "application/octet-stream")
		default:
			fmt.Fprint(w, `[]`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

// asPlugin sets what cub passes a plugin: the server, the token it held when
// it started the plugin, the context's name, and the directory its config is
// in.
func asPlugin(t *testing.T, server, token, context string) (configDir string) {
	t.Helper()
	configDir = t.TempDir()
	t.Setenv("CUB_SERVER", server)
	t.Setenv("CUB_TOKEN", token)
	t.Setenv("CUB_CONTEXT", context)
	t.Setenv("CUB_CONFIG", configDir)
	return configDir
}

// saveLogin is what cub auth login leaves: a context with a token.
func saveLogin(t *testing.T, name, server, token string, current bool) {
	t.Helper()
	store, err := cubapi.LoadConfig("")
	if err != nil {
		t.Fatal(err)
	}
	c, err := store.CreateContext(name, server, "org", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTokenData(c, &cubapi.TokenData{AccessToken: token}); err != nil {
		t.Fatal(err)
	}
	if current {
		if err := store.SetCurrentContext(name); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveConfig(); err != nil {
		t.Fatal(err)
	}
}

func last(got *[]asked) asked { return (*got)[len(*got)-1] }

// A verdict is recorded against the change order, a rejection as a Fail, and
// a dry run records nothing.
func TestSDKHubAttest(t *testing.T) {
	srv, got := hubServer(t)
	asPlugin(t, srv.URL, "passed", "")
	h := NewHub("test")

	rec, err := h.Attest(HubAttestation{Space: "s", Type: "PolicyCheck", ChangeOrderID: orderID, Claims: map[string]string{"check.confighub.com/function": "vet"}, Reject: true, Note: "vet failed"}, false)
	if err != nil || rec.ID != "22222222-2222-2222-2222-222222222222" || len(rec.Subjects) != 1 || rec.Subjects[0] != (subject{UnitSlug: "u", RevisionNum: 3}) {
		t.Fatalf("a recorded verdict has an ID and names what it covers: %+v %v", rec, err)
	}
	var sent map[string]any
	q := last(got)
	if err := json.Unmarshal([]byte(q.body), &sent); err != nil {
		t.Fatal(err)
	}
	if q.method != "POST" || q.path != "/api/space/"+spaceID+"/attestation" || q.dryRun ||
		sent["Type"] != "PolicyCheck" || sent["ChangeOrderID"] != orderID || sent["Result"] != "Fail" || sent["Note"] != "vet failed" ||
		fmt.Sprint(sent["Claims"]) != "map[check.confighub.com/function:vet]" {
		t.Errorf("a rejection is a Fail of that type against the order, with its claim and note: %+v", q)
	}
	if _, set := sent["WhereUnit"]; set {
		t.Errorf("the order says which revisions are covered, not a unit filter: %s", q.body)
	}

	dry, err := h.Attest(HubAttestation{Space: "s", Type: "PolicyCheck", ChangeOrderID: orderID}, true)
	if err != nil || dry.ID != "" || len(dry.Subjects) != 1 {
		t.Errorf("a dry run names what would be covered and has no ID: %+v %v", dry, err)
	}
	q = last(got)
	_ = json.Unmarshal([]byte(q.body), &sent)
	if !q.dryRun || strings.Contains(q.body, `"Result"`) {
		t.Errorf("a dry run is asked as one, and a Pass leaves the result to the server: %+v", q)
	}
	if _, err := h.Attest(HubAttestation{Space: "s", Type: "PolicyCheck", ChangeOrderID: "not-an-id"}, true); err == nil {
		t.Errorf("a change order is named by its ID")
	}
}

// Live status is written as a merge patch, and the lists are asked for with
// the same expressions cub was given.
func TestSDKHubQueries(t *testing.T) {
	srv, got := hubServer(t)
	asPlugin(t, srv.URL, "passed", "")
	h := NewHub("test")

	if err := h.PatchSpace("s", []byte(`{"Annotations":{"a":"b"}}`)); err != nil {
		t.Fatal(err)
	}
	if q := last(got); q.method != "PATCH" || q.path != "/api/space/"+spaceID || q.contentType != "application/merge-patch+json" || q.body != `{"Annotations":{"a":"b"}}` {
		t.Errorf("a Space is patched with a merge patch, as given: %+v", q)
	}

	released, err := h.ReleasedSpaces("sveltos-")
	if err != nil || fmt.Sprint(released) != "[sveltos-a sveltos-b]" {
		t.Errorf("each Space with a published release, once, in order: %v %v", released, err)
	}
	if q := last(got); q.path != "/api/release" || q.where != "Published = true AND Space.Slug LIKE 'sveltos-%'" {
		t.Errorf("published releases of the plan's Spaces, across the organization: %+v", q)
	}

	n, err := h.AttestationCount(orderID)
	if err != nil || n != 2 {
		t.Errorf("the attestations that name the order: %d %v", n, err)
	}
	if q := last(got); q.path != "/api/attestation" || q.where != "ChangeOrderID = '"+orderID+"'" {
		t.Errorf("attestations are asked for by change order: %+v", q)
	}

	if _, err := h.TargetSlugs("s"); err != nil {
		t.Fatal(err)
	}
	if q := last(got); q.path != "/api/target" || q.where != "SpaceID = '"+spaceID+"'" {
		t.Errorf("the Targets of that Space: %+v", q)
	}
	if q := last(got); q.token != "passed" {
		t.Errorf("the plugin asks as the login cub passed it: %+v", q)
	}
}

// A unit's revisions carry their tags and whether a check failed on them, and
// a revision's configuration is read as it is stored.
func TestSDKHubRevisions(t *testing.T) {
	srv, got := hubServer(t)
	asPlugin(t, srv.URL, "passed", "")
	h := NewHub("test")

	u, err := h.Unit("s", "u")
	if err != nil || u != (HubUnit{Slug: "u", SpaceSlug: "s", Head: 4, Released: 3}) {
		t.Errorf("a unit with its head, its released revision and no upstream: %+v %v", u, err)
	}
	revs, err := h.Revisions("s", "u", "Tags ? 'tag-a'")
	if err != nil || len(revs) != 2 || !revs[0].Tags["tag-a"] || !revs[0].Failing || revs[1].Failing {
		t.Errorf("revisions with their tags, and the one a check failed on: %+v %v", revs, err)
	}
	if q := last(got); q.path != revisions || q.where != "Tags ? 'tag-a'" {
		t.Errorf("the unit's revisions, by the expression given: %+v", q)
	}
	// A tag that marks two revisions means the newer one.
	if n := taggedRevision(h, "s", "u", "tag-a"); n != 4 {
		t.Errorf("the newest revision a tag marks: %d", n)
	}

	data, err := h.RevisionData("s", "u", 3)
	if err != nil || string(data) != "kind: ConfigMap\n" {
		t.Errorf("a revision's configuration, as stored: %q %v", data, err)
	}
	if _, err := h.RevisionData("s", "u", 4); err == nil || !strings.Contains(err.Error(), "no config data for revision 4 of unit u") {
		t.Errorf("a revision with no configuration is an error, not an empty one: %v", err)
	}
	if _, err := h.RevisionData("s", "u", 9); err == nil || !strings.Contains(err.Error(), "revision 9 of u not found") {
		t.Errorf("a revision the unit does not have: %v", err)
	}
}

// A command that runs for days renews its login before each reading, from
// what cub auth login saved for the context it started in.
func TestRenewReadsTheSavedLogin(t *testing.T) {
	srv, got := hubServer(t)
	asPlugin(t, srv.URL, "expired", "work")
	saveLogin(t, "work", srv.URL, "renewed", false)
	saveLogin(t, "other", srv.URL, "someone-else", true)
	h := NewHub("test")

	token := func() string {
		t.Helper()
		if _, err := h.Spaces(""); err != nil {
			t.Fatal(err)
		}
		return last(got).token
	}
	if tok := token(); tok != "expired" {
		t.Errorf("the plugin starts with the token cub passed it: %s", tok)
	}
	if tok := token(); tok != "expired" {
		t.Errorf("between renewals the connection is kept: %s", tok)
	}
	h.Renew()
	if tok := token(); tok != "renewed" {
		t.Errorf("after Renew it asks as the login saved for the context it started in, not the active one: %s", tok)
	}
}

// Renewing never moves a running command to another server, and with no
// saved login it keeps the token it was started with.
func TestRenewStaysWhereItStarted(t *testing.T) {
	srv, got := hubServer(t)
	token := func(h *SDKHub) string {
		t.Helper()
		if _, err := h.Spaces(""); err != nil {
			t.Fatal(err)
		}
		return last(got).token
	}

	// No login is saved, as in a pipeline that passes only a token.
	asPlugin(t, srv.URL, "passed", "work")
	h := NewHub("test")
	token(h)
	h.Renew()
	if tok := token(h); tok != "passed" {
		t.Errorf("with no saved login the token passed is kept: %s", tok)
	}

	// The context now names another server.
	asPlugin(t, srv.URL, "passed", "work")
	saveLogin(t, "work", "https://elsewhere.example.com", "elsewhere", true)
	h = NewHub("test")
	token(h)
	h.Renew()
	if tok := token(h); tok != "passed" {
		t.Errorf("a saved login for another server is not used: %s", tok)
	}

	// Run alone, it connects as the active context, and stays in it when the
	// active context changes.
	dir := asPlugin(t, "", "", "")
	saveLogin(t, "work", srv.URL, "work-1", true)
	h = NewHub("test")
	if tok := token(h); tok != "work-1" {
		t.Fatalf("run alone, it asks as the active context in %s: %s", dir, tok)
	}
	saveLogin(t, "other", srv.URL, "other-1", true)
	h.Renew()
	if tok := token(h); tok != "work-1" {
		t.Errorf("a context switched to in another terminal does not move a running command: %s", tok)
	}
}
