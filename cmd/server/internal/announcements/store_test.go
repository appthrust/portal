package announcements

import (
	"database/sql"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

func TestTranslate(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{sql.ErrNoRows, 404, "not_found"},
		{&pq.Error{Code: "23505"}, 409, "conflict"},
		{&pq.Error{Code: "23503"}, 400, "invalid"},
		{&pq.Error{Code: "23514"}, 400, "invalid"},
	} {
		var result *httpx.Error
		require.ErrorAs(t, translate(tc.err), &result)
		require.Equal(t, tc.status, result.Status)
		require.Equal(t, tc.code, result.Code)
	}
	original := errors.New("connection unavailable")
	require.ErrorIs(t, translate(original), original)
	require.NoError(t, translate(nil))
}

func requireStoreError(t *testing.T, err error, status int) {
	t.Helper()
	var response *httpx.Error
	require.ErrorAs(t, err, &response)
	require.Equal(t, status, response.Status)
}

func TestStorePagingAndReadMarks(t *testing.T) {
	database, dsn := testutil.Database(t, Open)
	reopened, err := Open(t.Context(), dsn)
	require.NoError(t, err)
	require.NoError(t, reopened.Close())
	require.NoError(t, database.Check(t.Context()))
	empty, err := database.List(t.Context(), "viewer", ListOptions{Scope: "published", Limit: 20}, testNow)
	require.NoError(t, err)
	require.Equal(t, []AnnouncementSummary{}, empty.Items)
	require.Empty(t, empty.NextCursor)
	require.Zero(t, empty.UnreadCount)

	create := func(title string, pinned bool, published time.Time, expires *time.Time) Announcement {
		t.Helper()
		a, err := database.Create(t.Context(), Changes{
			Title: field(title), Body: field("**本文**"), Pinned: field(pinned), PublishedAt: field(published),
			ExpiresAt: Field[time.Time]{Present: true, Value: expires},
		}, Author{Subject: "author", Name: "Author"}, testNow)
		require.NoError(t, err)
		return a
	}
	pinned := create("Pinned", true, testNow.Add(-time.Hour), nil)
	first := create("Tie one", false, testNow, nil)
	second := create("Tie two", false, testNow, nil)
	old := create("Old", false, testNow.Add(-2*time.Hour), nil)
	scheduled := create("Scheduled", true, testNow.Add(time.Hour), nil)
	expired := create("Expired", true, testNow.Add(-time.Hour), &testNow)
	ties := []string{first.ID, second.ID}
	slices.Sort(ties)
	slices.Reverse(ties)
	want := []string{pinned.ID, ties[0], ties[1], old.ID}
	var ids []string
	options := ListOptions{Scope: "published", Limit: 1}
	for range len(want) {
		page, err := database.List(t.Context(), "viewer", options, testNow)
		require.NoError(t, err)
		require.Len(t, page.Items, 1)
		require.Equal(t, 4, page.UnreadCount)
		require.Equal(t, "本文", page.Items[0].Excerpt)
		require.Equal(t, Published, page.Items[0].State)
		ids = append(ids, page.Items[0].ID)
		options.Cursor = page.NextCursor
		if len(ids) < len(want) {
			require.NotEmpty(t, options.Cursor)
		} else {
			require.Empty(t, options.Cursor)
		}
	}
	require.Equal(t, want, ids)
	all, err := database.List(t.Context(), "viewer", ListOptions{Scope: "all", Limit: 50}, testNow)
	require.NoError(t, err)
	require.Len(t, all.Items, 6)
	require.Equal(t, 4, all.UnreadCount)
	for range 2 {
		require.NoError(t, database.MarkRead(t.Context(), pinned.ID, "viewer", false, testNow))
	}
	read, err := database.Get(t.Context(), pinned.ID, "viewer")
	require.NoError(t, err)
	require.True(t, read.Read)
	unread, err := database.Get(t.Context(), pinned.ID, "other")
	require.NoError(t, err)
	require.False(t, unread.Read)
	page, err := database.List(t.Context(), "viewer", ListOptions{Scope: "published", Limit: 1}, testNow)
	require.NoError(t, err)
	require.Equal(t, 3, page.UnreadCount)
	for _, id := range []string{scheduled.ID, expired.ID, "missing"} {
		requireStoreError(t, database.MarkRead(t.Context(), id, "viewer", false, testNow), 404)
	}
	require.NoError(t, database.MarkRead(t.Context(), scheduled.ID, "poster", true, testNow))
	for range 2 {
		require.NoError(t, database.MarkAllRead(t.Context(), "viewer", testNow))
	}
	page, err = database.List(t.Context(), "viewer", ListOptions{Scope: "published", Limit: 20}, testNow)
	require.NoError(t, err)
	require.Zero(t, page.UnreadCount)
	for _, id := range []string{scheduled.ID, expired.ID} {
		item, err := database.Get(t.Context(), id, "viewer")
		require.NoError(t, err)
		require.False(t, item.Read)
	}
	page, err = database.List(t.Context(), "viewer", ListOptions{Scope: "published", Limit: 20}, testNow.Add(time.Hour))
	require.NoError(t, err)
	require.Equal(t, 1, page.UnreadCount)
	page, err = database.List(t.Context(), "other", ListOptions{Scope: "published", Limit: 20}, testNow)
	require.NoError(t, err)
	require.Equal(t, 4, page.UnreadCount)
}

func TestStoreMutationsAndConstraints(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	author := Author{Subject: "author", Name: "Author"}
	expires := testNow.Add(time.Hour)
	item, err := database.Create(t.Context(), Changes{Title: field("  Original "), Body: field("Body"), ExpiresAt: field(expires)}, author, testNow)
	require.NoError(t, err)
	require.Equal(t, "Original", item.Title)
	require.Equal(t, Info, item.Category)
	require.Equal(t, time.UTC, item.PublishedAt.Location())
	require.NoError(t, database.MarkRead(t.Context(), item.ID, "viewer", false, testNow))
	updated, err := database.Patch(t.Context(), item.ID, "editor", Changes{Title: field("Edited"), Pinned: field(true)}, testNow.Add(time.Minute))
	require.NoError(t, err)
	require.Equal(t, author, updated.Author)
	require.Equal(t, item.CreatedAt, updated.CreatedAt)
	require.Equal(t, testNow.Add(time.Minute), updated.UpdatedAt)
	require.Equal(t, &expires, updated.ExpiresAt)
	_, err = database.Patch(t.Context(), item.ID, "editor", Changes{PublishedAt: field(expires)}, testNow)
	requireStoreError(t, err, 400)
	unchanged, err := database.Get(t.Context(), item.ID, "viewer")
	require.NoError(t, err)
	require.Equal(t, updated.PublishedAt, unchanged.PublishedAt)
	require.True(t, unchanged.Read)
	updated, err = database.Patch(t.Context(), item.ID, "editor", Changes{ExpiresAt: Field[time.Time]{Present: true}, Category: field(Event), Body: field("Updated")}, testNow.Add(2*time.Minute))
	require.NoError(t, err)
	require.Nil(t, updated.ExpiresAt)
	require.Equal(t, Event, updated.Category)
	require.Equal(t, "Updated", updated.Body)
	_, err = database.Create(t.Context(), Changes{Title: field(""), Body: field("")}, author, testNow)
	requireStoreError(t, err, 400)
	require.NoError(t, database.Delete(t.Context(), item.ID))
	_, err = database.Get(t.Context(), item.ID, "viewer")
	requireStoreError(t, err, 404)
	requireStoreError(t, database.Delete(t.Context(), item.ID), 404)
	_, err = database.Patch(t.Context(), item.ID, "editor", Changes{}, testNow)
	requireStoreError(t, err, 404)
	require.NoError(t, database.do(t.Context(), false, func(tx *pgstore.Tx) error {
		var count int
		err := tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM portal_announcement_read WHERE announcement_id=$1`, item.ID).Scan(&count)
		require.Zero(t, count)
		return err
	}))
	requireStoreError(t, database.do(t.Context(), true, func(tx *pgstore.Tx) error {
		return tx.Exec(`INSERT INTO portal_announcement_read (announcement_id, subject) VALUES ($1, $2)`, item.ID, "viewer")
	}), 400)
	item, err = database.Create(t.Context(), Changes{Title: field("Constraint"), Body: field("")}, author, testNow)
	require.NoError(t, err)
	for _, query := range []string{
		`UPDATE portal_announcement SET title='' WHERE id=$1`,
		`UPDATE portal_announcement SET body=repeat('a', 20481) WHERE id=$1`,
		`UPDATE portal_announcement SET category='other' WHERE id=$1`,
		`UPDATE portal_announcement SET expires_at=published_at WHERE id=$1`,
	} {
		requireStoreError(t, database.do(t.Context(), true, func(tx *pgstore.Tx) error { return tx.Exec(query, item.ID) }), 400)
	}
}

func TestCursorValidation(t *testing.T) {
	item := validAnnouncement()
	item.ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	encoded := encodeCursor(item, "published")
	decoded, err := decodeCursor(ListOptions{Scope: "published", Limit: 20, Cursor: encoded})
	require.NoError(t, err)
	require.Equal(t, item.ID, decoded.ID)
	require.Equal(t, item.PublishedAt, decoded.PublishedAt)
	for _, options := range []ListOptions{
		{Scope: "all", Limit: 20, Cursor: encoded},
		{Scope: "published", Limit: 0},
		{Scope: "published", Limit: 51},
		{Scope: "other", Limit: 20},
		{Scope: "published", Limit: 20, Cursor: "broken"},
		{Scope: "published", Limit: 20, Cursor: "e30"},
	} {
		_, err := decodeCursor(options)
		requireStoreError(t, err, 400)
	}
}
