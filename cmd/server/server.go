package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/pending"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/appserver-go/appserver/platformenv"
	"github.com/appthrust/appserver-go/appserver/releaseidentity"
	"github.com/appthrust/portal/cmd/server/internal/announcements"
	"github.com/appthrust/portal/cmd/server/internal/home"
)

// parseOrigin validates the public URL before applying its HTTPS-only policy.
func parseOrigin(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") {
		return nil, errors.New("URL must be an origin without credentials, a path, query, or fragment")
	}
	return u, nil
}

// newHandler keeps the home, launcher, probes and SPA independent of the database.
func newHandler(staticDir, platformAPIURL, projectID string, authenticator *identity.Authenticator, catalog *launcher.Catalog, composer *home.Composer, notices http.Handler) (http.Handler, error) {
	upstream, err := platformenv.Validate(platformAPIURL, projectID)
	if err != nil {
		return nil, err
	}
	publicURL := os.Getenv("PORTAL_PUBLIC_URL")
	if publicURL != "" {
		origin, err := parseOrigin(publicURL)
		if err != nil || origin.Scheme != "https" || origin.Path != "" {
			return nil, errors.New("PORTAL_PUBLIC_URL must be an HTTPS origin without a path, query, or fragment")
		}
	}
	if authenticator == nil {
		authenticator, err = identity.New(identity.FromEnv("PORTAL"))
		if err != nil {
			return nil, err
		}
	}
	var platform *platformclient.Client
	if catalog == nil || composer == nil {
		platform = platformclient.New(upstream.String(), projectID, platformclient.WithHTTPClient(authenticator.HTTPClient()))
	}
	// The launcher marks this installation as current and the link resolver
	// reads this installation's links, so both need the definition the image
	// was published as.
	definition := os.Getenv("PORTAL_DEFINITION_ID")
	if definition == "" {
		definition = "portal"
	}
	if catalog == nil {
		catalog = launcher.NewCatalog(platform, definition)
	}
	if composer == nil {
		resolver := link.NewResolver(platform, definition, os.LookupEnv, nil)
		composer = home.New(catalog, resolver, link.NewClient(resolver, nil), nil)
	}
	if notices == nil {
		notices = announcements.Unavailable()
	}
	config := map[string]string{
		"projectId":    projectID,
		"publicUrl":    publicURL,
		"dashboardUrl": upstream.String() + "/dashboard/projects/" + projectID + "/marketplace",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, config)
	})
	mux.Handle("GET /launcher", launcher.NewHandler(catalog, authenticator.Authenticate))
	mux.Handle("GET /api/portal/v1/home", home.NewHandler(composer, authenticator.Authenticate))
	mux.Handle("/api/portal/v1/me", notices)
	mux.Handle("/api/portal/v1/announcements", notices)
	mux.Handle("/api/portal/v1/announcements/", notices)
	mux.Handle("GET /releasez", releaseidentity.NewHandler("PORTAL", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("UI release status unavailable\n"))
	}))
	for _, probe := range []string{"GET /healthz", "GET /readyz"} {
		mux.HandleFunc(probe, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("ok\n"))
		})
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveStatic(w, r, staticDir)
	})
	return mux, nil
}

func databaseURL() string {
	if dsn := os.Getenv("PORTAL_DATABASE_URL"); dsn != "" {
		return dsn
	}
	return os.Getenv("DATABASE_URL")
}

// announcementsHandler connects in the background without changing probe health.
func announcementsHandler(upstreamURL, projectID string, auth *identity.Authenticator) (*pending.Handler, func()) {
	handler := pending.Serve(announcements.Unavailable())
	dsn := databaseURL()
	if dsn == "" {
		return handler, func() {}
	}
	platform := platformclient.New(upstreamURL, projectID, platformclient.WithHTTPClient(auth.HTTPClient()))
	stop := pending.Connect("portal database", time.Second, func(ctx context.Context) (io.Closer, error) {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		database, err := announcements.Open(ctx, dsn)
		if err != nil {
			return nil, err
		}
		handler.Swap(announcements.New(database, auth.Authenticate, platform, time.Now))
		return database, nil
	})
	return handler, stop
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func serveStatic(w http.ResponseWriter, r *http.Request, root string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")))
	info, err := os.Stat(name)
	asset := strings.HasPrefix(r.URL.Path, "/assets/")
	if err != nil || !info.Mode().IsRegular() {
		if asset {
			http.NotFound(w, r)
			return
		}
		name = filepath.Join(root, "index.html")
	}
	file, err := os.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if filepath.Base(name) == "index.html" {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	} else if asset {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(w, r, filepath.Base(name), info.ModTime(), file)
}
