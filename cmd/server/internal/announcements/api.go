package announcements

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/platformclient"
)

// Repository exposes aggregate operations, keeping PATCH and read marks atomic.
type Repository interface {
	Check(context.Context) error
	List(context.Context, string, ListOptions, time.Time) (Page, error)
	Get(context.Context, string, string) (Announcement, error)
	Create(context.Context, Changes, Author, time.Time) (Announcement, error)
	Patch(context.Context, string, string, Changes, time.Time) (Announcement, error)
	Delete(context.Context, string) error
	MarkRead(context.Context, string, string, bool, time.Time) error
	MarkAllRead(context.Context, string, time.Time) error
}

type AccessClient interface {
	Access(context.Context, string, string) (platformclient.ProjectAccess, error)
}

// Names resolves the caller's Directory profile name from their bearer. It
// returns "" when Directory is not installed, has no profile for the caller,
// or does not answer; a name is never a reason to fail a request.
type Names interface {
	DisplayName(ctx context.Context, bearer string) string
}

type api struct {
	store        Repository
	authenticate launcher.AuthenticateFunc
	platform     AccessClient
	names        Names
	now          func() time.Time
	mux          *http.ServeMux
}

type request struct {
	w       http.ResponseWriter
	r       *http.Request
	bearer  string
	author  Author
	canPost bool
	now     time.Time
}

type endpoint func(*request) (any, int, error)

func New(database Repository, authenticate launcher.AuthenticateFunc, platform AccessClient, names Names, now func() time.Time) http.Handler {
	if now == nil {
		now = time.Now
	}
	a := &api{store: database, authenticate: authenticate, platform: platform, names: names, now: now, mux: http.NewServeMux()}
	a.route("GET /api/portal/v1/me", false, a.me)
	a.route("GET /api/portal/v1/announcements", false, a.list)
	a.route("GET /api/portal/v1/announcements/{id}", false, a.get)
	a.route("POST /api/portal/v1/announcements", true, a.create)
	a.route("PATCH /api/portal/v1/announcements/{id}", true, a.patch)
	a.route("DELETE /api/portal/v1/announcements/{id}", true, a.delete)
	a.route("PUT /api/portal/v1/announcements/{id}/read", false, a.read)
	a.route("POST /api/portal/v1/announcements/read-all", false, a.readAll)
	return a
}

func Unavailable() http.Handler { return New(nil, nil, nil, nil, nil) }

// displayName is the caller's Directory profile name, or "".
func (a *api) displayName(s *request) string {
	if a.names == nil {
		return ""
	}
	return a.names.DisplayName(s.r.Context(), s.bearer)
}

func (a *api) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a.mux.ServeHTTP(w, r)
}

func storeUnavailable() error {
	return httpx.Fail(503, "portal_store_unavailable", "The portal database is not available")
}

func storeError(err error) error {
	var response *httpx.Error
	if errors.As(err, &response) {
		return err
	}
	return storeUnavailable()
}

func (a *api) route(pattern string, poster bool, fn endpoint) {
	a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if a.store == nil {
			httpx.WriteError(w, storeUnavailable(), "portal")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		header := r.Header.Get("Authorization")
		if header == "" {
			httpx.WriteError(w, httpx.Fail(401, "unauthenticated", "A bearer token is required"), "portal")
			return
		}
		claims, bearer, err := a.authenticate(ctx, header)
		if err != nil {
			failure := httpx.Fail(401, "unauthenticated", "A valid bearer token is required")
			if errors.Is(err, identity.ErrUnavailable) {
				failure = httpx.Fail(503, "identity_unavailable", "Identity verification is unavailable")
			}
			httpx.WriteError(w, failure, "portal")
			return
		}
		if claims.Principal.Kind == "key" {
			httpx.WriteError(w, httpx.Forbidden(), "portal")
			return
		}
		access, err := a.platform.Access(ctx, claims.Principal.Subject, bearer)
		if err != nil {
			httpx.WriteError(w, httpx.Fail(503, "identity_unavailable", "The platform role is temporarily unavailable"), "portal")
			return
		}
		s := &request{w: w, r: r, bearer: bearer, author: Author{Subject: claims.Principal.Subject, Name: claims.Name},
			canPost: CanPost(access.Role, !access.NotMember), now: a.now().UTC()}
		if s.author.Name == "" {
			s.author.Name = s.author.Subject
		}
		if poster && !s.canPost {
			httpx.WriteError(w, httpx.Forbidden(), "portal")
			return
		}
		body, status, err := fn(s)
		if err != nil {
			httpx.WriteError(w, storeError(err), "portal")
			return
		}
		if status == http.StatusNoContent {
			w.WriteHeader(status)
			return
		}
		httpx.WriteJSON(w, status, body)
	})
}

func decode(s *request) (Changes, error) {
	var changes Changes
	mediaType, _, err := mime.ParseMediaType(s.r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return changes, invalid("Content-Type must be application/json")
	}
	body, err := io.ReadAll(http.MaxBytesReader(s.w, s.r.Body, 64<<10))
	if err != nil {
		return changes, invalid("Request body exceeds the size limit")
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return changes, invalid("Request body must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&changes) != nil {
		return changes, invalid("Request body contains invalid or unknown fields")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return changes, invalid("Request body must contain one JSON object")
	}
	return changes, nil
}

// me names the caller by their Directory profile only: the token's name is
// the identity provider's and is not what colleagues know them by.
func (a *api) me(s *request) (any, int, error) {
	if err := a.store.Check(s.r.Context()); err != nil {
		return nil, 0, err
	}
	return struct {
		Subject string `json:"subject"`
		Name    string `json:"name"`
		CanPost bool   `json:"canPost"`
	}{s.author.Subject, a.displayName(s), s.canPost}, http.StatusOK, nil
}

func (a *api) list(s *request) (any, int, error) {
	query := s.r.URL.Query()
	options := ListOptions{Scope: query.Get("scope"), Limit: 20, Cursor: query.Get("cursor")}
	if options.Scope == "" {
		options.Scope = "published"
	}
	if options.Scope == "all" && !s.canPost {
		return nil, 0, httpx.Forbidden()
	}
	if query.Has("limit") {
		limit, err := strconv.Atoi(query.Get("limit"))
		if err != nil {
			return nil, 0, invalid("limit must be between 1 and 50")
		}
		options.Limit = limit
	}
	if _, err := decodeCursor(options); err != nil {
		return nil, 0, err
	}
	page, err := a.store.List(s.r.Context(), s.author.Subject, options, s.now)
	return page, http.StatusOK, err
}

func (a *api) get(s *request) (any, int, error) {
	item, err := a.store.Get(s.r.Context(), s.r.PathValue("id"), s.author.Subject)
	if err != nil {
		return nil, 0, err
	}
	if !s.canPost && item.State(s.now) != Published {
		return nil, 0, httpx.NotFound()
	}
	return Detail{AnnouncementSummary: item.Summary(s.now), Body: item.Body}, http.StatusOK, nil
}

func (a *api) create(s *request) (any, int, error) {
	changes, err := decode(s)
	if err != nil {
		return nil, 0, err
	}
	// The author snapshot prefers the Directory name and falls back to the token's.
	author := s.author
	if name := a.displayName(s); name != "" {
		author.Name = name
	}
	item, err := a.store.Create(s.r.Context(), changes, author, s.now)
	if err != nil {
		return nil, 0, err
	}
	return Detail{AnnouncementSummary: item.Summary(s.now), Body: item.Body}, http.StatusCreated, nil
}

func (a *api) patch(s *request) (any, int, error) {
	changes, err := decode(s)
	if err != nil {
		return nil, 0, err
	}
	item, err := a.store.Patch(s.r.Context(), s.r.PathValue("id"), s.author.Subject, changes, s.now)
	if err != nil {
		return nil, 0, err
	}
	return Detail{AnnouncementSummary: item.Summary(s.now), Body: item.Body}, http.StatusOK, nil
}

func (a *api) delete(s *request) (any, int, error) {
	return nil, http.StatusNoContent, a.store.Delete(s.r.Context(), s.r.PathValue("id"))
}

func (a *api) read(s *request) (any, int, error) {
	return nil, http.StatusNoContent, a.store.MarkRead(s.r.Context(), s.r.PathValue("id"), s.author.Subject, s.canPost, s.now)
}

func (a *api) readAll(s *request) (any, int, error) {
	return nil, http.StatusNoContent, a.store.MarkAllRead(s.r.Context(), s.author.Subject, s.now)
}
