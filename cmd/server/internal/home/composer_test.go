package home

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/launcherentries"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/stretchr/testify/require"
)

const (
	projectPath     = "/api/v1/projects/pj-test"
	builtinAppsPath = projectPath + "/app-installations"
	definitionsPath = "/api/v1/application-stack-definitions"
	bindingPath     = builtinAppsPath + "/portal"
)

type platformFixture struct {
	calls         atomic.Int32
	failurePath   string
	failureStatus int
}

func newTestComposer(t *testing.T, links []platformclient.AppInstallationLink, now func() time.Time) (*Composer, *platformFixture) {
	t.Helper()
	fixture := &platformFixture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.calls.Add(1)
		if r.URL.Query().Has("q") {
			t.Error("provider query reached the Platform API")
		}
		if r.URL.Path == fixture.failurePath {
			w.WriteHeader(fixture.failureStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case projectPath:
			_ = json.NewEncoder(w).Encode(platformclient.Project{ID: "pj-test", Name: r.Header.Get("Authorization")})
		case builtinAppsPath:
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []platformclient.AppInstallation{
				{DefinitionID: "portal", Phase: "Ready", URL: "https://custom.example/home", Display: platformclient.AppInstallationDisplay{Icon: "home"}},
			}})
		case definitionsPath:
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []platformclient.ApplicationStackDefinition{
				{ID: "portal", Title: "Home"},
			}})
		case bindingPath:
			_ = json.NewEncoder(w).Encode(platformclient.AppInstallation{DefinitionID: "portal", Links: links})
		default:
			t.Errorf("unexpected Platform API path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	platform := platformclient.New(server.URL, "pj-test")
	catalog := launcher.NewCatalog(platform, "portal")
	resolver := link.NewResolver(platform, "portal", nil, nil)
	return New(catalog, resolver, link.NewClient(resolver, nil), now), fixture
}

func provider(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/launcher/entries" {
			t.Errorf("provider request = %s %s", r.Method, r.URL.Path)
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func binding(definition, origin string, state link.State) platformclient.AppInstallationLink {
	return platformclient.AppInstallationLink{
		DefinitionID: definition, State: string(state), InternalURL: origin,
		Capabilities: []string{launcherentries.Capability},
	}
}

func TestComposerPartialProviderFailure(t *testing.T) {
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			const bearer = "bearer viewer-verbatim"
			var started atomic.Int32
			bothStarted := make(chan struct{})
			awaitBoth := func(r *http.Request) bool {
				if r.Header.Get("Authorization") != bearer {
					t.Error("provider did not receive the viewer bearer verbatim")
				}
				if started.Add(1) == 2 {
					close(bothStarted)
				}
				select {
				case <-bothStarted:
					return true
				case <-r.Context().Done():
					t.Error("provider requests did not fan out concurrently")
					return false
				}
			}
			entry := launcherentries.Entry{ID: "app", Name: "App", Relation: launcherentries.Owner, State: launcherentries.Ready, URL: "https://custom.example/app", Tags: []string{}}
			ready := provider(t, func(w http.ResponseWriter, r *http.Request) {
				if awaitBoth(r) {
					_ = json.NewEncoder(w).Encode(launcherentries.EntryList{Items: []launcherentries.Entry{entry}})
				}
			})
			failed := provider(t, func(w http.ResponseWriter, r *http.Request) {
				if awaitBoth(r) {
					http.Error(w, "private provider response", status)
				}
			})
			composer, _ := newTestComposer(t, []platformclient.AppInstallationLink{
				binding("zulu", failed.URL, link.StateReady), binding("alpha", ready.URL, link.StateReady),
			}, nil)
			page, err := composer.Home(context.Background(), "viewer", bearer, "")
			require.NoError(t, err)
			require.Equal(t, launcher.Project{ID: "pj-test", Name: bearer}, page.Project)
			require.Equal(t, []launcher.Entry{{DefinitionID: "portal", Name: "Home", Icon: "home", URL: "https://custom.example/home", Phase: "Ready", Current: true}}, page.AppInstallations)
			require.Equal(t, []Source{{DefinitionID: "alpha", State: "ready"}, {DefinitionID: "zulu", State: "unavailable"}}, page.Sources)
			require.Equal(t, []Section{{Relation: launcherentries.Owner, Entries: []Entry{{Entry: entry, SourceDefinitionID: "alpha"}}}}, page.Sections)
			require.EqualValues(t, 2, started.Load())
		})
	}
}

func TestComposerAbsentBindingsAreNotCalled(t *testing.T) {
	var calls atomic.Int32
	server := provider(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	})
	unrelated := binding("unrelated", server.URL, link.StateReady)
	unrelated.Capabilities = []string{"other/v1"}
	composer, _ := newTestComposer(t, []platformclient.AppInstallationLink{
		binding("unsupported", server.URL, link.StateUnsupported),
		binding("installing", server.URL, link.StateInstalling),
		binding("absent", server.URL, link.StateAbsent), unrelated,
	}, nil)
	page, err := composer.Home(context.Background(), "viewer", "Bearer viewer", "")
	require.NoError(t, err)
	require.Equal(t, []Source{
		{DefinitionID: "absent", State: "absent"},
		{DefinitionID: "installing", State: "absent"},
		{DefinitionID: "unsupported", State: "absent"},
	}, page.Sources)
	require.NotNil(t, page.Sections)
	require.Empty(t, page.Sections)
	require.Zero(t, calls.Load())
}

func TestComposerSectionAndEntryOrdering(t *testing.T) {
	groupA := &launcherentries.GroupRef{ID: "z-id", Name: "Engineering", Path: "/company/engineering"}
	groupZ := &launcherentries.GroupRef{ID: "a-id", Name: "Sales", Path: "/company/sales"}
	item := func(id, name string, relation launcherentries.EntryRelation, group *launcherentries.GroupRef) launcherentries.Entry {
		return launcherentries.Entry{ID: id, Name: name, Relation: relation, Group: group, State: launcherentries.Preparing, Tags: []string{"internal"}}
	}
	alphaItems := []launcherentries.Entry{
		item("project-z", "Zulu", launcherentries.Project, nil),
		item("sales-z", "Zulu", launcherentries.Group, groupZ),
		item("owner-b", "Same", launcherentries.Owner, groupZ),
		item("engineering-z", "Zulu", launcherentries.Group, groupA),
		item("project-a", "Alpha", launcherentries.Project, nil),
		item("sales-a", "Alpha", launcherentries.Group, groupZ),
		item("owner-a", "Same", launcherentries.Owner, nil),
		item("engineering-a", "Alpha", launcherentries.Group, groupA),
		item("owner-first", "Alpha", launcherentries.Owner, nil),
	}
	alphaItems[4].State = launcherentries.Restricted
	alphaItems[4].DetailURL = "https://console.example/apps/restricted"
	betaItems := []launcherentries.Entry{
		item("owner-a", "Same", launcherentries.Owner, nil),
		item("engineering-b", "Beta", launcherentries.Group, groupA),
	}
	alpha := provider(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(launcherentries.EntryList{Items: alphaItems})
	})
	beta := provider(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(launcherentries.EntryList{Items: betaItems})
	})
	composer, _ := newTestComposer(t, []platformclient.AppInstallationLink{
		binding("beta", beta.URL, link.StateReady), binding("alpha", alpha.URL, link.StateReady),
	}, nil)
	page, err := composer.Home(context.Background(), "viewer", "Bearer viewer", "")
	require.NoError(t, err)
	require.Len(t, page.Sections, 4)
	wrap := func(entry launcherentries.Entry, source string) Entry {
		return Entry{Entry: entry, SourceDefinitionID: source}
	}
	require.Equal(t, []Section{
		{Relation: launcherentries.Owner, Entries: []Entry{wrap(alphaItems[8], "alpha"), wrap(alphaItems[6], "alpha"), wrap(alphaItems[2], "alpha"), wrap(betaItems[0], "beta")}},
		{Relation: launcherentries.Group, Group: groupA, Entries: []Entry{wrap(alphaItems[7], "alpha"), wrap(betaItems[1], "beta"), wrap(alphaItems[3], "alpha")}},
		{Relation: launcherentries.Group, Group: groupZ, Entries: []Entry{wrap(alphaItems[5], "alpha"), wrap(alphaItems[1], "alpha")}},
		{Relation: launcherentries.Project, Entries: []Entry{wrap(alphaItems[4], "alpha"), wrap(alphaItems[0], "alpha")}},
	}, page.Sections)
}

func TestComposerQueryForwardedWithoutCaching(t *testing.T) {
	var calls atomic.Int32
	queries := make(chan string, 3)
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		queries <- r.URL.Query().Get("q")
		_ = json.NewEncoder(w).Encode(launcherentries.EntryList{Items: []launcherentries.Entry{
			{ID: fmt.Sprint(calls.Load()), Name: "Provider result", Relation: launcherentries.Owner, State: launcherentries.Preparing, Tags: []string{}},
		}})
	})
	composer, _ := newTestComposer(t, []platformclient.AppInstallationLink{binding("alpha", server.URL, link.StateReady)}, nil)
	const query = "  社内 & apps+?  "
	for _, tc := range []struct {
		query string
		id    string
	}{
		{"", "1"}, {query, "2"}, {query, "3"}, {"", "1"},
	} {
		page, err := composer.Home(context.Background(), "viewer", "Bearer viewer", tc.query)
		require.NoError(t, err)
		require.Equal(t, tc.id, page.Sections[0].Entries[0].ID)
		require.Len(t, page.AppInstallations, 1, "built-in apps must not be filtered by provider queries")
		require.Equal(t, "Home", page.AppInstallations[0].Name)
	}
	require.EqualValues(t, 3, calls.Load())
	require.Equal(t, "", <-queries)
	require.Equal(t, query, <-queries)
	require.Equal(t, query, <-queries)
}

func TestComposerSubjectCacheAndExpiry(t *testing.T) {
	var calls atomic.Int32
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(launcherentries.EntryList{Items: []launcherentries.Entry{
			{ID: r.Header.Get("Authorization"), Name: "App", Relation: launcherentries.Owner, State: launcherentries.Preparing, Tags: []string{}},
		}})
	})
	start := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	now := start
	composer, platform := newTestComposer(t, []platformclient.AppInstallationLink{binding("alpha", server.URL, link.StateReady)}, func() time.Time { return now })
	for _, tc := range []struct {
		subject string
		bearer  string
		want    string
		elapsed time.Duration
		calls   int32
	}{
		{"A", "Bearer A", "Bearer A", 0, 1},
		{"B", "Bearer B", "Bearer B", 0, 2},
		{"A", "Bearer refreshed-A", "Bearer A", 60*time.Second - time.Nanosecond, 2},
		{"B", "Bearer refreshed-B", "Bearer B", 60*time.Second - time.Nanosecond, 2},
		{"A", "Bearer refreshed-A", "Bearer refreshed-A", 60 * time.Second, 3},
	} {
		now = start.Add(tc.elapsed)
		page, err := composer.Home(context.Background(), tc.subject, tc.bearer, "")
		require.NoError(t, err)
		require.Equal(t, tc.want, page.Sections[0].Entries[0].ID)
		require.Equal(t, "Bearer "+tc.subject, page.Project.Name)
		require.Equal(t, tc.calls, calls.Load())
	}
	require.EqualValues(t, 7, platform.calls.Load(), "the full Page cache must avoid catalog and resolver calls")
}

func TestComposerCachedPagesAreCallerOwned(t *testing.T) {
	group := &launcherentries.GroupRef{ID: "engineering", Name: "Engineering", Path: "/engineering"}
	server := provider(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(launcherentries.EntryList{Items: []launcherentries.Entry{
			{ID: "app", Name: "App", Relation: launcherentries.Group, Group: group, State: launcherentries.Preparing, Tags: []string{"tag"}},
		}})
	})
	composer, _ := newTestComposer(t, []platformclient.AppInstallationLink{binding("alpha", server.URL, link.StateReady)}, nil)
	for range 3 {
		page, err := composer.Home(context.Background(), "viewer", "Bearer viewer", "")
		require.NoError(t, err)
		require.Equal(t, "Home", page.AppInstallations[0].Name)
		require.Equal(t, "ready", page.Sources[0].State)
		require.Equal(t, "Engineering", page.Sections[0].Group.Name)
		require.Equal(t, "Engineering", page.Sections[0].Entries[0].Group.Name)
		require.Equal(t, "App", page.Sections[0].Entries[0].Name)
		require.Equal(t, []string{"tag"}, page.Sections[0].Entries[0].Tags)
		page.AppInstallations[0].Name = "caller mutation"
		page.Sources[0].State = "caller mutation"
		page.Sections[0].Group.Name = "caller mutation"
		page.Sections[0].Entries[0].Name = "caller mutation"
		page.Sections[0].Entries[0].Group.Name = "caller mutation"
		page.Sections[0].Entries[0].Tags[0] = "caller mutation"
	}
}

func TestComposerCacheEvictsOldestSubject(t *testing.T) {
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	composer, _ := newTestComposer(t, nil, func() time.Time { return now })
	for i := range maxSubjects {
		composer.cache[fmt.Sprint(i)] = cachedPage{expires: now.Add(time.Duration(i+1) * time.Second)}
	}
	_, err := composer.Home(context.Background(), "new-viewer", "Bearer viewer", "")
	require.NoError(t, err)
	require.Len(t, composer.cache, maxSubjects)
	require.NotContains(t, composer.cache, "0")
	require.Contains(t, composer.cache, "1")
	require.Contains(t, composer.cache, "new-viewer")
}

func authenticateViewer(_ context.Context, header string) (identity.Identity, string, error) {
	var viewer identity.Identity
	viewer.Principal.Kind = "user"
	viewer.Principal.Subject = strings.TrimPrefix(header, "Bearer ")
	return viewer, header, nil
}

func TestHandlerPlatformErrors(t *testing.T) {
	for _, path := range []string{projectPath, builtinAppsPath, definitionsPath, bindingPath} {
		for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusServiceUnavailable} {
			t.Run(path+"/"+http.StatusText(status), func(t *testing.T) {
				composer, fixture := newTestComposer(t, nil, nil)
				fixture.failurePath, fixture.failureStatus = path, status
				request := httptest.NewRequest(http.MethodGet, "/api/portal/v1/home", nil)
				request.Header.Set("Authorization", "Bearer viewer")
				for range 2 {
					response := httptest.NewRecorder()
					NewHandler(composer, authenticateViewer).ServeHTTP(response, request)
					require.Equal(t, status, response.Code)
					code := "forbidden"
					if status == http.StatusServiceUnavailable {
						code = "portal_unavailable"
					} else {
						require.Contains(t, response.Body.String(), `"message":"You do not have permission to list this Project's built-in apps"`)
					}
					require.Contains(t, response.Body.String(), `"error":"`+code+`"`)
				}
			})
		}
	}
}

func TestHandlerAuthenticationAndQueryFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		header string
		kind   string
		query  string
		err    error
		status int
		code   string
	}{
		{name: "method", method: http.MethodPost, status: 405, code: "method_not_allowed"},
		{name: "missing bearer", status: 401, code: "unauthenticated"},
		{name: "invalid bearer", header: "Bearer viewer", err: errors.New("invalid"), status: 401, code: "unauthenticated"},
		{name: "identity unavailable", header: "Bearer viewer", err: fmt.Errorf("wrapped: %w", identity.ErrUnavailable), status: 503, code: "identity_unavailable"},
		{name: "raw key", header: "Bearer viewer", err: identity.ErrRawKeyNotAccepted, status: 401, code: "raw_key_not_accepted"},
		{name: "key principal", header: "Bearer viewer", kind: "key", status: 403, code: "key_not_permitted"},
		{name: "long query", header: "Bearer viewer", query: strings.Repeat("社", 129), status: 400, code: "invalid_query"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			method := tc.method
			if method == "" {
				method = http.MethodGet
			}
			authenticate := func(ctx context.Context, header string) (identity.Identity, string, error) {
				if tc.header == "" {
					t.Error("authentication must not run before method and bearer checks")
				}
				viewer, bearer, _ := authenticateViewer(ctx, header)
				if tc.kind != "" {
					viewer.Principal.Kind = tc.kind
				}
				return viewer, bearer, tc.err
			}
			request := httptest.NewRequest(method, "/api/portal/v1/home?q="+url.QueryEscape(tc.query), nil)
			request.Header.Set("Authorization", tc.header)
			response := httptest.NewRecorder()
			NewHandler(nil, authenticate).ServeHTTP(response, request)
			require.Equal(t, tc.status, response.Code)
			require.Contains(t, response.Body.String(), `"error":"`+tc.code+`"`)
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			require.Equal(t, "application/json", response.Header().Get("Content-Type"))
			if tc.status == http.StatusMethodNotAllowed {
				require.Equal(t, "GET", response.Header().Get("Allow"))
			}
		})
	}
}

func TestHandlerSuccessWireShapeAndUnicodeQuery(t *testing.T) {
	const bearer = "bearer authenticated-verbatim"
	query := strings.Repeat("社", 128)
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != query || r.Header.Get("Authorization") != bearer {
			t.Error("handler changed the query or authenticated bearer")
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"app","name":"App","description":"Internal","icon":"app","relation":"owner","state":"preparing","tags":[]}]}`))
	})
	composer, _ := newTestComposer(t, []platformclient.AppInstallationLink{binding("alpha", server.URL, link.StateReady)}, nil)
	authenticate := func(ctx context.Context, header string) (identity.Identity, string, error) {
		viewer, _, err := authenticateViewer(ctx, header)
		return viewer, bearer, err
	}
	request := httptest.NewRequest(http.MethodGet, "/api/portal/v1/home?q="+url.QueryEscape(query), nil)
	request.Header.Set("Authorization", "Bearer viewer")
	response := httptest.NewRecorder()
	NewHandler(composer, authenticate).ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
	require.Equal(t, "application/json", response.Header().Get("Content-Type"))
	require.JSONEq(t, `{"project":{"id":"pj-test","name":"bearer authenticated-verbatim"},"builtinApps":[{"definitionId":"portal","name":"Home","description":"","icon":"home","url":"https://custom.example/home","phase":"Ready","current":true}],"sections":[{"relation":"owner","group":null,"entries":[{"id":"app","name":"App","description":"Internal","icon":"app","relation":"owner","state":"preparing","tags":[],"sourceDefinitionId":"alpha"}]}],"sources":[{"definitionId":"alpha","state":"ready"}]}`, response.Body.String())
}
