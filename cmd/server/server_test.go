package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/appserver-go/appserver/platformenv"
	"github.com/appthrust/portal/cmd/server/internal/home"
	"github.com/stretchr/testify/require"
)

func portalEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{"PLATFORM_OIDC_ISSUER", "PLATFORM_OIDC_ISSUER_CA_PEM", "PORTAL_PUBLIC_URL", "PORTAL_RELEASE_VERSION", "PORTAL_SOURCE_REVISION", "PORTAL_ARTIFACT_DIGEST", "PORTAL_RELEASE_FILE"} {
		t.Setenv(key, "")
	}
}

func TestConfigProbesAndSPA(t *testing.T) {
	portalEnvironment(t)
	t.Setenv("PORTAL_PUBLIC_URL", "https://home.pj-test.example")
	static := t.TempDir()
	handler, err := newHandler(static, "https://dashboard.example/", "pj-test", nil, nil, nil)
	require.NoError(t, err)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/config", nil))
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.JSONEq(t, `{"projectId":"pj-test","publicUrl":"https://home.pj-test.example","dashboardUrl":"https://dashboard.example/dashboard/projects/pj-test/marketplace"}`, response.Body.String())
	for _, path := range []string{"/healthz", "/readyz"} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, response.Code, path)
		require.Equal(t, "ok\n", response.Body.String())
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	require.Equal(t, http.StatusNotFound, response.Code)
	require.NoError(t, os.WriteFile(filepath.Join(static, "index.html"), []byte("<html>Home</html>"), 0600))
	for _, path := range []string{"/", "/nested/route"} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, response.Code, path)
		require.Contains(t, response.Body.String(), "Home")
		require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
		require.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
	}
	for _, path := range []string{"/api/x", "/assets/missing.js"} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusNotFound, response.Code, path)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", nil))
	require.Equal(t, http.StatusMethodNotAllowed, response.Code)
	require.Equal(t, "GET, HEAD", response.Header().Get("Allow"))
}

func TestLauncherUsesViewerBearerAndPortalIdentity(t *testing.T) {
	portalEnvironment(t)
	const bearer = "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ2aWV3ZXIiLCJlbWFpbCI6InZpZXdlckBleGFtcGxlLnRlc3QifQ."
	var calls atomic.Int32
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, bearer, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/projects/pj-test":
			_, _ = w.Write([]byte(`{"id":"pj-test","name":"開発チーム"}`))
		case "/api/v1/projects/pj-test/app-installations":
			_, _ = w.Write([]byte(`{"data":[{"id":"portal","definitionId":"portal","phase":"Ready","url":"https://home.pj-test.example","display":{"icon":"layout-dashboard"}},{"id":"directory","definitionId":"directory","phase":"Degraded","url":"https://directory.pj-test.example","display":{"icon":"directory"},"dependents":["builder-console"]}],"meta":{"total":2}}`))
		case "/api/v1/application-stack-definitions":
			_, _ = w.Write([]byte(`{"data":[{"id":"portal","title":"Home","description":"All built-in apps"},{"id":"directory","title":"Directory","description":"People"}],"meta":{"total":2}}`))
		default:
			t.Errorf("unexpected Platform API path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer platform.Close()
	handler, err := newHandler(t.TempDir(), platform.URL, "pj-test", nil, nil, nil)
	require.NoError(t, err)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/launcher", nil))
	require.Equal(t, http.StatusUnauthorized, response.Code)
	var failure struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &failure))
	require.Equal(t, "unauthenticated", failure.Error)
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.Zero(t, calls.Load())
	request := httptest.NewRequest(http.MethodGet, "/launcher", nil)
	request.Header.Set("Authorization", bearer)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.Equal(t, "application/json", response.Header().Get("Content-Type"))
	var body launcher.Snapshot
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, launcher.Project{ID: "pj-test", Name: "開発チーム"}, body.Project)
	require.Equal(t, []launcher.Entry{
		{DefinitionID: "directory", Name: "Directory", Description: "People", Icon: "directory", URL: "https://directory.pj-test.example", Phase: "Degraded"},
		{DefinitionID: "portal", Name: "Home", Description: "All built-in apps", Icon: "layout-dashboard", URL: "https://home.pj-test.example", Phase: "Ready", Current: true},
	}, body.Entries)
	require.EqualValues(t, 3, calls.Load())
}

func TestReleaseMetadataAndFileFallback(t *testing.T) {
	for _, mode := range []string{"environment", "file", "missing", "unreadable"} {
		t.Run(mode, func(t *testing.T) {
			portalEnvironment(t)
			stamp := `{"releaseVersion":"release","artifactDigest":"digest"}`
			switch mode {
			case "environment":
				for key, value := range map[string]string{"PORTAL_RELEASE_VERSION": "release", "PORTAL_SOURCE_REVISION": "", "PORTAL_ARTIFACT_DIGEST": "digest"} {
					t.Setenv(key, value)
				}
				t.Setenv("PORTAL_RELEASE_FILE", filepath.Join(t.TempDir(), "missing.json"))
			case "file":
				file := filepath.Join(t.TempDir(), "release.json")
				require.NoError(t, os.WriteFile(file, []byte(stamp), 0600))
				t.Setenv("PORTAL_RELEASE_FILE", file)
				t.Setenv("PORTAL_RELEASE_VERSION", "incomplete")
			case "unreadable":
				t.Setenv("PORTAL_RELEASE_FILE", filepath.Join(t.TempDir(), "missing.json"))
			}
			handler, err := newHandler(t.TempDir(), "http://127.0.0.1:1", "pj-test", nil, nil, nil)
			require.NoError(t, err)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/releasez", nil))
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			if mode == "environment" || mode == "file" {
				require.Equal(t, http.StatusOK, response.Code)
				require.JSONEq(t, stamp, response.Body.String())
			} else {
				require.Equal(t, http.StatusServiceUnavailable, response.Code)
				require.Equal(t, "UI release status unavailable\n", response.Body.String())
			}
		})
	}
}

func TestInvalidEnvironmentRejected(t *testing.T) {
	portalEnvironment(t)
	for _, project := range []string{"", "UPPER", "a/b", "-project", "project-", strings.Repeat("a", 64)} {
		_, err := newHandler(t.TempDir(), "https://dashboard.example", project, nil, nil, nil)
		require.ErrorContains(t, err, "PLATFORM_PROJECT_ID must be a non-empty DNS label")
	}
	for _, upstream := range []string{"", "http://dashboard.example", "https://user:pass@dashboard.example", "https://dashboard.example/path", "https://dashboard.example?query=1", "https://dashboard.example?", "https://dashboard.example#fragment", "https://dashboard.example#"} {
		_, err := newHandler(t.TempDir(), upstream, "pj-test", nil, nil, nil)
		require.ErrorContains(t, err, "PLATFORM_API_URL must be an HTTPS origin", upstream)
	}
	for _, upstream := range []string{"https://dashboard.example", "https://dashboard.example/", "http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"} {
		_, err := newHandler(t.TempDir(), upstream, "pj-test", nil, nil, nil)
		require.NoError(t, err, upstream)
	}
	for _, public := range []string{"http://localhost:8080", "https://home.example/", "https://home.example/path", "https://home.example#", "https://user@home.example"} {
		t.Setenv("PORTAL_PUBLIC_URL", public)
		_, err := newHandler(t.TempDir(), "https://dashboard.example", "pj-test", nil, nil, nil)
		require.ErrorContains(t, err, "PORTAL_PUBLIC_URL must be an HTTPS origin", public)
	}
	t.Setenv("PORTAL_PUBLIC_URL", "")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "invalid PEM")
	_, err := newHandler(t.TempDir(), "https://dashboard.example", "pj-test", nil, nil, nil)
	require.Error(t, err)
}

func TestTrustedClaimsRequireLoopbackListen(t *testing.T) {
	for _, listen := range []string{"127.0.0.1:8080", "localhost:8080", "[::1]:8080"} {
		require.NoError(t, platformenv.ValidateIdentityListen(listen, ""), listen)
	}
	for _, listen := range []string{":8080", "0.0.0.0:8080", "[::]:8080", "192.0.2.1:8080", "invalid"} {
		require.EqualError(t, platformenv.ValidateIdentityListen(listen, ""), "PLATFORM_OIDC_ISSUER is required unless --listen uses a loopback host", listen)
	}
	require.NoError(t, platformenv.ValidateIdentityListen(":8080", "https://identity.example/realms/platform"))
}

func TestHomeRoutePreservesAPICatchAll(t *testing.T) {
	portalEnvironment(t)
	const bearer = "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ2aWV3ZXIiLCJlbWFpbCI6InZpZXdlckBleGFtcGxlLnRlc3QifQ."
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, bearer, r.Header.Get("Authorization"))
		require.Equal(t, "/launcher/entries", r.URL.Path)
		require.Equal(t, "app", r.URL.Query().Get("q"))
		_, _ = w.Write([]byte(`{"items":[{"id":"app","name":"App","description":"","icon":"app","relation":"owner","state":"preparing","tags":[]}]}`))
	}))
	defer provider.Close()
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, bearer, r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/api/v1/projects/pj-test":
			_, _ = w.Write([]byte(`{"id":"pj-test","name":"Project"}`))
		case "/api/v1/projects/pj-test/app-installations":
			_, _ = w.Write([]byte(`{"data":[{"definitionId":"portal","phase":"Ready","url":"https://custom.example/home","display":{"icon":"layout-dashboard"}}]}`))
		case "/api/v1/application-stack-definitions":
			_, _ = w.Write([]byte(`{"data":[{"id":"portal","title":"Home"}]}`))
		case "/api/v1/projects/pj-test/app-installations/portal":
			_ = json.NewEncoder(w).Encode(platformclient.AppInstallation{DefinitionID: "portal", Links: []platformclient.AppInstallationLink{
				{DefinitionID: "provider", Capabilities: []string{"launcher.entries/v1"}, State: "Ready", InternalURL: provider.URL},
			}})
		default:
			t.Errorf("unexpected Platform API path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer platform.Close()
	for _, injected := range []bool{false, true} {
		name := "production wiring"
		if injected {
			name = "injected composer"
		}
		t.Run(name, func(t *testing.T) {
			var catalog *launcher.Catalog
			var composer *home.Composer
			upstream := platform.URL
			if injected {
				client := platformclient.New(platform.URL, "pj-test")
				catalog = launcher.NewCatalog(client, "portal")
				resolver := link.NewResolver(client, "portal", nil, nil)
				composer = home.New(catalog, resolver, link.NewClient(resolver, nil), nil)
				upstream = "http://127.0.0.1:1"
			}
			handler, err := newHandler(t.TempDir(), upstream, "pj-test", nil, catalog, composer)
			require.NoError(t, err)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/portal/v1/home", nil))
			require.Equal(t, http.StatusUnauthorized, response.Code)
			request := httptest.NewRequest(http.MethodGet, "/api/portal/v1/home?q=app", nil)
			request.Header.Set("Authorization", bearer)
			response = httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			require.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
			var page home.Page
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
			require.Equal(t, launcher.Project{ID: "pj-test", Name: "Project"}, page.Project)
			require.Len(t, page.AppInstallations, 1)
			require.Equal(t, "Home", page.AppInstallations[0].Name)
			require.Len(t, page.Sections, 1)
			require.Len(t, page.Sections[0].Entries, 1)
			require.Equal(t, "provider", page.Sections[0].Entries[0].SourceDefinitionID)
			require.Equal(t, []home.Source{{DefinitionID: "provider", State: "ready"}}, page.Sources)
			for _, path := range []string{"/api/other", "/api/portal/v1/other"} {
				response = httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
				require.Equal(t, http.StatusNotFound, response.Code, path)
			}
		})
	}
}
