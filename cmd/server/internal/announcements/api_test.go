package announcements

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/oklog/ulid/v2"
	"github.com/stretchr/testify/require"
)

type fakeStore struct {
	items map[string]Announcement
	reads map[string]map[string]bool
	err   error
}

func newFakeStore() *fakeStore {
	return &fakeStore{items: map[string]Announcement{}, reads: map[string]map[string]bool{}}
}

func (f *fakeStore) Check(context.Context) error { return f.err }

func (f *fakeStore) List(_ context.Context, subject string, options ListOptions, now time.Time) (Page, error) {
	page := Page{Items: []AnnouncementSummary{}}
	if f.err != nil {
		return page, f.err
	}
	items := []Announcement{}
	for _, item := range f.items {
		item.Read = f.reads[subject][item.ID]
		if item.State(now) == Published && !item.Read {
			page.UnreadCount++
		}
		if options.Scope == "all" || item.State(now) == Published {
			items = append(items, item)
		}
	}
	slices.SortFunc(items, func(a, b Announcement) int {
		if a.Pinned != b.Pinned {
			if a.Pinned {
				return -1
			}
			return 1
		}
		if !a.PublishedAt.Equal(b.PublishedAt) {
			return b.PublishedAt.Compare(a.PublishedAt)
		}
		return strings.Compare(b.ID, a.ID)
	})
	c, err := decodeCursor(options)
	if err != nil {
		return page, err
	}
	if c != nil {
		for i, item := range items {
			if item.ID == c.ID {
				items = items[i+1:]
				break
			}
		}
	}
	if len(items) > options.Limit {
		page.NextCursor = encodeCursor(items[options.Limit-1], options.Scope)
		items = items[:options.Limit]
	}
	for _, item := range items {
		page.Items = append(page.Items, item.Summary(now))
	}
	return page, nil
}

func (f *fakeStore) Get(_ context.Context, id, subject string) (Announcement, error) {
	if f.err != nil {
		return Announcement{}, f.err
	}
	item, found := f.items[id]
	if !found {
		return item, httpx.NotFound()
	}
	item.Read = f.reads[subject][id]
	return item, nil
}

func (f *fakeStore) Create(_ context.Context, changes Changes, author Author, now time.Time) (Announcement, error) {
	if f.err != nil {
		return Announcement{}, f.err
	}
	item, err := changes.create(author, now)
	if err != nil {
		return item, invalid(err.Error())
	}
	item.ID = ulid.Make().String()
	f.items[item.ID] = item
	return item, nil
}

func (f *fakeStore) Patch(ctx context.Context, id, subject string, changes Changes, now time.Time) (Announcement, error) {
	item, err := f.Get(ctx, id, subject)
	if err != nil {
		return item, err
	}
	item, err = changes.apply(item)
	if err != nil {
		return item, invalid(err.Error())
	}
	item.UpdatedAt = now
	f.items[id] = item
	return item, nil
}

func (f *fakeStore) Delete(ctx context.Context, id string) error {
	if _, err := f.Get(ctx, id, ""); err != nil {
		return err
	}
	delete(f.items, id)
	for _, marks := range f.reads {
		delete(marks, id)
	}
	return nil
}

func (f *fakeStore) MarkRead(ctx context.Context, id, subject string, canPost bool, now time.Time) error {
	item, err := f.Get(ctx, id, subject)
	if err != nil {
		return err
	}
	if !canPost && item.State(now) != Published {
		return httpx.NotFound()
	}
	if f.reads[subject] == nil {
		f.reads[subject] = map[string]bool{}
	}
	f.reads[subject][id] = true
	return nil
}

func (f *fakeStore) MarkAllRead(ctx context.Context, subject string, now time.Time) error {
	if f.err != nil {
		return f.err
	}
	for id, item := range f.items {
		if item.State(now) == Published {
			if err := f.MarkRead(ctx, id, subject, false, now); err != nil {
				return err
			}
		}
	}
	return nil
}

type fakeAccess struct {
	access  platformclient.ProjectAccess
	err     error
	subject string
	bearer  string
	calls   int
}

func (f *fakeAccess) Access(_ context.Context, subject, bearer string) (platformclient.ProjectAccess, error) {
	f.calls++
	f.subject, f.bearer = subject, bearer
	return f.access, f.err
}

type fixture struct {
	store   *fakeStore
	access  *fakeAccess
	claims  identity.Identity
	authErr error
	now     time.Time
	handler http.Handler
}

func newFixture() *fixture {
	f := &fixture{
		store: newFakeStore(), access: &fakeAccess{access: platformclient.ProjectAccess{Role: "Admin"}},
		claims: identity.Identity{Principal: accesskey.Principal{Subject: "author", Kind: "user"}, Name: "投稿者"}, now: testNow,
	}
	f.handler = New(f.store, func(_ context.Context, _ string) (identity.Identity, string, error) {
		return f.claims, "Bearer verified", f.authErr
	}, f.access, func() time.Time { return f.now })
	return f
}

func (f *fixture) request(method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/api/portal/v1"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer input")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func responseJSON[T any](t *testing.T, w *httptest.ResponseRecorder, status int) T {
	t.Helper()
	require.Equal(t, status, w.Code, w.Body.String())
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	var result T
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result), w.Body.String())
	return result
}

func assertFailure(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	failure := responseJSON[httpx.Error](t, w, status)
	require.Equal(t, code, failure.Code)
	require.NotEmpty(t, failure.Message)
}

func (f *fixture) create(t *testing.T, body string) Detail {
	t.Helper()
	return responseJSON[Detail](t, f.request("POST", "/announcements", body), 201)
}

func TestMeAndAuthorSnapshot(t *testing.T) {
	f := newFixture()
	w := f.request("GET", "/me", "")
	require.JSONEq(t, `{"subject":"author","name":"投稿者","canPost":true}`, w.Body.String())
	require.Equal(t, "author", f.access.subject)
	require.Equal(t, "Bearer verified", f.access.bearer)
	item := f.create(t, `{"title":" お知らせ　","body":"**本文**"}`)
	require.Equal(t, "お知らせ", item.Title)
	require.Equal(t, "本文", item.Excerpt)
	require.Equal(t, Info, item.Category)
	require.Equal(t, Published, item.State)
	require.Equal(t, testNow, item.PublishedAt)
	require.False(t, item.Pinned)
	require.False(t, item.Read)
	require.Nil(t, item.ExpiresAt)
	require.Equal(t, Author{Subject: "author", Name: "投稿者"}, item.Author)
	_, err := ulid.ParseStrict(item.ID)
	require.NoError(t, err)
	f.claims.Principal.Subject, f.claims.Name = "editor", "編集者"
	f.now = testNow.Add(time.Hour)
	updated := responseJSON[Detail](t, f.request("PATCH", "/announcements/"+item.ID, `{"body":"更新"}`), 200)
	require.Equal(t, item.Author, updated.Author)
	require.Equal(t, item.CreatedAt, updated.CreatedAt)
	require.Equal(t, f.now, updated.UpdatedAt)
	f.claims.Name = ""
	f.access.access = platformclient.ProjectAccess{Role: "Editor", NotMember: true}
	w = f.request("GET", "/me", "")
	require.JSONEq(t, `{"subject":"editor","name":"editor","canPost":false}`, w.Body.String())
	f.access.access.NotMember = false
	fallback := f.create(t, `{"title":"Fallback","body":""}`)
	require.Equal(t, "editor", fallback.Author.Name)
}

func TestAuthorization(t *testing.T) {
	f := newFixture()
	published := f.create(t, `{"title":"Published","body":""}`)
	scheduled := f.create(t, `{"title":"Scheduled","body":"","publishedAt":"2026-11-11T00:00:00Z"}`)
	expired := f.create(t, `{"title":"Expired","body":"","publishedAt":"2026-11-09T00:00:00Z","expiresAt":"2026-11-10T12:00:00Z"}`)
	for _, id := range []string{published.ID, scheduled.ID, expired.ID} {
		responseJSON[Detail](t, f.request("GET", "/announcements/"+id, ""), 200)
	}
	for _, access := range []platformclient.ProjectAccess{{Role: "Viewer"}, {Role: "Admin", NotMember: true}, {Role: "Editor", NotMember: true}} {
		f.access.access = access
		for _, request := range []struct{ method, path, body string }{
			{"POST", "/announcements", `{"title":"No","body":""}`},
			{"PATCH", "/announcements/" + published.ID, `{"title":"No"}`},
			{"DELETE", "/announcements/" + published.ID, ""},
			{"GET", "/announcements?scope=all", ""},
		} {
			assertFailure(t, f.request(request.method, request.path, request.body), 403, "forbidden")
		}
		for _, id := range []string{scheduled.ID, expired.ID, "missing"} {
			assertFailure(t, f.request("GET", "/announcements/"+id, ""), 404, "not_found")
			assertFailure(t, f.request("PUT", "/announcements/"+id+"/read", ""), 404, "not_found")
		}
		responseJSON[Detail](t, f.request("GET", "/announcements/"+published.ID, ""), 200)
	}
	f.claims.Principal.Kind = "key"
	calls := f.access.calls
	for _, path := range []string{"/me", "/announcements", "/announcements/" + published.ID} {
		assertFailure(t, f.request("GET", path, ""), 403, "forbidden")
	}
	require.Equal(t, calls, f.access.calls)
}

func TestAuthenticationFailures(t *testing.T) {
	f := newFixture()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/portal/v1/me", nil))
	assertFailure(t, w, 401, "unauthenticated")
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{errors.New("bad token"), 401, "unauthenticated"},
		{identity.ErrRawKeyNotAccepted, 401, "unauthenticated"},
		{identity.ErrUnavailable, 503, "identity_unavailable"},
	} {
		f.authErr = tc.err
		assertFailure(t, f.request("GET", "/me", ""), tc.status, tc.code)
	}
	f.authErr = nil
	f.access.err = errors.New("platform unavailable")
	assertFailure(t, f.request("GET", "/me", ""), 503, "identity_unavailable")
}

func TestInvalidRequests(t *testing.T) {
	f := newFixture()
	item := f.create(t, `{"title":"Existing","body":""}`)
	for _, body := range []string{
		`{}`, `{"title":"Missing body"}`, `{"body":"Missing title"}`, `{"title":" ","body":""}`,
		`{"title":"t","body":"","category":"urgent"}`, `{"title":"t","body":"","category":""}`,
		`{"title":"t","body":"","publishedAt":"bad"}`, `{"title":"t","body":"","publishedAt":"0001-01-01T00:00:00Z"}`,
		`{"title":"t","body":"","expiresAt":"2026-11-10T12:00:00Z"}`,
		`{"title":"t","body":"","unknown":1}`, `{"title":"t","body":"","pinned":"true"}`,
		`{"title":null,"body":""}`, `{"title":"t","body":null}`, `{"title":"t","body":"","category":null}`,
		`{"title":"t","body":"","pinned":null}`, `{"title":"t","body":"","publishedAt":null}`,
		`null`, `[]`, ``, `{`, `{"title":"t","body":""} {}`, `{"title":"t","body":""} garbage`,
		`{"title":"` + strings.Repeat("日", 121) + `","body":""}`,
		`{"title":"t","body":"` + strings.Repeat("a", (20<<10)+1) + `"}`,
		`{"title":"t","body":""}` + strings.Repeat(" ", 64<<10),
	} {
		assertFailure(t, f.request("POST", "/announcements", body), 400, "invalid")
	}
	for _, body := range []string{`{"title":null}`, `{"body":null}`, `{"category":null}`, `{"pinned":null}`, `{"publishedAt":null}`, `{"expiresAt":"bad"}`, `{"unknown":1}`, `{"title":""}`} {
		assertFailure(t, f.request("PATCH", "/announcements/"+item.ID, body), 400, "invalid")
	}
	for _, query := range []string{"scope=other", "limit=", "limit=0", "limit=51", "limit=no", "cursor=bad", "cursor=e30"} {
		assertFailure(t, f.request("GET", "/announcements?"+query, ""), 400, "invalid")
	}
	for _, mediaType := range []string{"", "text/plain", "application/json; broken"} {
		r := httptest.NewRequest("POST", "/api/portal/v1/announcements", strings.NewReader(`{"title":"t","body":""}`))
		r.Header.Set("Authorization", "Bearer input")
		r.Header.Set("Content-Type", mediaType)
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, r)
		assertFailure(t, w, 400, "invalid")
	}
	for _, id := range []string{"missing", "not-a-ulid"} {
		assertFailure(t, f.request("PATCH", "/announcements/"+id, `{}`), 404, "not_found")
		assertFailure(t, f.request("DELETE", "/announcements/"+id, ""), 404, "not_found")
	}
}

func TestPatchExpiryAndUTC(t *testing.T) {
	f := newFixture()
	item := f.create(t, `{"title":"Time","body":"","publishedAt":"2026-11-10T20:00:00+09:00","expiresAt":"2026-11-12T00:00:00+09:00"}`)
	require.Equal(t, time.UTC, item.PublishedAt.Location())
	require.Equal(t, time.UTC, item.ExpiresAt.Location())
	updated := responseJSON[Detail](t, f.request("PATCH", "/announcements/"+item.ID, `{"pinned":true,"category":"event"}`), 200)
	require.Equal(t, item.ExpiresAt, updated.ExpiresAt)
	require.True(t, updated.Pinned)
	require.Equal(t, Event, updated.Category)
	updated = responseJSON[Detail](t, f.request("PATCH", "/announcements/"+item.ID, `{"expiresAt":null}`), 200)
	require.Nil(t, updated.ExpiresAt)
	updated = responseJSON[Detail](t, f.request("PATCH", "/announcements/"+item.ID, `{"expiresAt":"2026-11-13T00:00:00Z"}`), 200)
	require.NotNil(t, updated.ExpiresAt)
	assertFailure(t, f.request("PATCH", "/announcements/"+item.ID, `{"publishedAt":"2026-11-14T00:00:00Z"}`), 400, "invalid")
}

func TestReadMarksAndUnreadCount(t *testing.T) {
	f := newFixture()
	pinned := f.create(t, `{"title":"Pinned","body":"","pinned":true,"publishedAt":"2026-11-09T00:00:00Z"}`)
	other := f.create(t, `{"title":"Other","body":""}`)
	scheduled := f.create(t, `{"title":"Future","body":"","publishedAt":"2026-11-11T00:00:00Z"}`)
	f.create(t, `{"title":"Expired","body":"","publishedAt":"2026-11-09T00:00:00Z","expiresAt":"2026-11-10T12:00:00Z"}`)
	page := responseJSON[Page](t, f.request("GET", "/announcements?limit=1", ""), 200)
	require.Equal(t, 2, page.UnreadCount)
	require.Len(t, page.Items, 1)
	require.Equal(t, pinned.ID, page.Items[0].ID)
	require.NotEmpty(t, page.NextCursor)
	var raw map[string]any
	require.NoError(t, json.Unmarshal(f.request("GET", "/announcements", "").Body.Bytes(), &raw))
	require.NotContains(t, raw["items"].([]any)[0].(map[string]any), "body")
	last := responseJSON[Page](t, f.request("GET", "/announcements?limit=1&cursor="+page.NextCursor, ""), 200)
	require.Equal(t, other.ID, last.Items[0].ID)
	require.Empty(t, last.NextCursor)
	require.Equal(t, 2, last.UnreadCount)
	for range 2 {
		w := f.request("PUT", "/announcements/"+pinned.ID+"/read", "")
		require.Equal(t, 204, w.Code)
		require.Empty(t, w.Body.String())
		require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	}
	read := responseJSON[Detail](t, f.request("GET", "/announcements/"+pinned.ID, ""), 200)
	require.True(t, read.Read)
	page = responseJSON[Page](t, f.request("GET", "/announcements", ""), 200)
	require.Equal(t, 1, page.UnreadCount)
	f.claims.Principal.Subject = "other-viewer"
	f.access.access = platformclient.ProjectAccess{Role: "Viewer"}
	page = responseJSON[Page](t, f.request("GET", "/announcements", ""), 200)
	require.Equal(t, 2, page.UnreadCount)
	for range 2 {
		require.Equal(t, 204, f.request("POST", "/announcements/read-all", "").Code)
	}
	page = responseJSON[Page](t, f.request("GET", "/announcements", ""), 200)
	require.Zero(t, page.UnreadCount)
	f.now = testNow.Add(24 * time.Hour)
	page = responseJSON[Page](t, f.request("GET", "/announcements", ""), 200)
	require.Equal(t, 1, page.UnreadCount)
	f.access.access.Role = "Editor"
	all := responseJSON[Page](t, f.request("GET", "/announcements?scope=all", ""), 200)
	require.Len(t, all.Items, 4)
	require.Equal(t, 1, all.UnreadCount)
	require.Equal(t, 204, f.request("DELETE", "/announcements/"+scheduled.ID, "").Code)
	assertFailure(t, f.request("GET", "/announcements/"+scheduled.ID, ""), 404, "not_found")
}

func TestUnavailableRoutes(t *testing.T) {
	for _, runtime := range []bool{false, true} {
		f := newFixture()
		if runtime {
			f.store.err = errors.New("database disconnected")
		} else {
			f.handler = Unavailable()
		}
		for _, request := range []struct{ method, path, body string }{
			{"GET", "/me", ""}, {"GET", "/announcements", ""}, {"GET", "/announcements/id", ""},
			{"POST", "/announcements", `{"title":"t","body":""}`}, {"PATCH", "/announcements/id", `{}`},
			{"DELETE", "/announcements/id", ""}, {"PUT", "/announcements/id/read", ""}, {"POST", "/announcements/read-all", ""},
		} {
			assertFailure(t, f.request(request.method, request.path, request.body), 503, "portal_store_unavailable")
		}
		for _, path := range []string{"/other", "/announcements/id/other", "/me/other"} {
			require.Equal(t, 404, f.request("GET", path, "").Code)
		}
	}
}

func TestJSONBodySizeBoundary(t *testing.T) {
	f := newFixture()
	body := `{"title":"Boundary","body":""}`
	body += strings.Repeat(" ", (64<<10)-len(body))
	r := httptest.NewRequest("POST", "/api/portal/v1/announcements", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer input")
	r.Header.Set("Content-Type", "application/json; charset=utf-8")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	responseJSON[Detail](t, w, 201)
	assertFailure(t, f.request("POST", "/announcements", body+" "), 400, "invalid")
}
