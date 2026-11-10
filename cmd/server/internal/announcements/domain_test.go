package announcements

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var testNow = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

func field[T any](value T) Field[T] { return Field[T]{Present: true, Value: &value} }

func validAnnouncement() Announcement {
	return Announcement{Title: "お知らせ", Body: "本文", Category: Info, PublishedAt: testNow}
}

func TestValidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Announcement)
		valid  bool
	}{
		{"valid", func(a *Announcement) {}, true},
		{"empty title", func(a *Announcement) { a.Title = "" }, false},
		{"blank title", func(a *Announcement) { a.Title = " \t\n　" }, false},
		{"one rune", func(a *Announcement) { a.Title = " 日 " }, true},
		{"120 runes", func(a *Announcement) { a.Title = " " + strings.Repeat("日", 120) + " " }, true},
		{"121 runes", func(a *Announcement) { a.Title = strings.Repeat("日", 121) }, false},
		{"empty body", func(a *Announcement) { a.Body = "" }, true},
		{"20 KiB", func(a *Announcement) { a.Body = strings.Repeat("a", 20<<10) }, true},
		{"20 KiB plus one", func(a *Announcement) { a.Body = strings.Repeat("a", (20<<10)+1) }, false},
		{"body byte limit", func(a *Announcement) { a.Body = strings.Repeat("日", 7000) }, false},
		{"important", func(a *Announcement) { a.Category = Important }, true},
		{"event", func(a *Announcement) { a.Category = Event }, true},
		{"empty category", func(a *Announcement) { a.Category = "" }, false},
		{"unknown category", func(a *Announcement) { a.Category = "urgent" }, false},
		{"unset publication", func(a *Announcement) { a.PublishedAt = time.Time{} }, false},
		{"expiry before", func(a *Announcement) { v := testNow.Add(-time.Nanosecond); a.ExpiresAt = &v }, false},
		{"expiry equal", func(a *Announcement) { a.ExpiresAt = &a.PublishedAt }, false},
		{"expiry after", func(a *Announcement) { v := testNow.Add(time.Nanosecond); a.ExpiresAt = &v }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := validAnnouncement()
			tc.change(&a)
			if tc.valid {
				require.NoError(t, a.Validate())
			} else {
				require.Error(t, a.Validate())
			}
		})
	}
}

func TestState(t *testing.T) {
	a := validAnnouncement()
	expires := testNow.Add(time.Hour)
	a.ExpiresAt = &expires
	for _, tc := range []struct {
		now  time.Time
		want State
	}{
		{testNow.Add(-time.Nanosecond), Scheduled},
		{testNow, Published},
		{testNow.Add(time.Nanosecond), Published},
		{expires.Add(-time.Nanosecond), Published},
		{expires, Expired},
		{expires.Add(time.Nanosecond), Expired},
	} {
		t.Run(tc.now.Format(time.RFC3339Nano), func(t *testing.T) { require.Equal(t, tc.want, a.State(tc.now)) })
	}
	a.ExpiresAt = nil
	require.Equal(t, Published, a.State(expires.Add(24*time.Hour)))
}

func TestCanPost(t *testing.T) {
	for _, role := range []string{"Admin", "Editor", "Viewer", "admin", "", "Owner"} {
		for _, member := range []bool{false, true} {
			require.Equal(t, member && (role == "Admin" || role == "Editor"), CanPost(role, member), "%s member=%v", role, member)
		}
	}
}

func TestExcerpt(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"empty", "", ""},
		{"formatting", "# 見出し\n\n**重要**な _お知らせ_ と ~~旧情報~~", "見出し 重要な お知らせ と 旧情報"},
		{"links", "[社内](https://example.com) ![図](image.png) <https://example.com>", "社内 図 https://example.com"},
		{"reference", "[社内][home]\n\n[home]: https://example.com", "社内"},
		{"lists", "> 引用\n\n- 一\n- 二\n\n1. 三", "引用 一 二 三"},
		{"code", "`a_b`\n\n```go\nvar a = 1\n```", "a_b var a = 1"},
		{"entities", "A &amp; B \\*literal\\* <b>bold</b>", "A & B *literal* bold"},
		{"whitespace", "one\n two\n\nthree", "one two three"},
		{"160 runes", strings.Repeat("日", 160), strings.Repeat("日", 160)},
		{"truncation", strings.Repeat("日", 161), strings.Repeat("日", 160)},
		{"syntax before truncation", "**" + strings.Repeat("日", 161) + "**", strings.Repeat("日", 160)},
	} {
		t.Run(tc.name, func(t *testing.T) { require.Equal(t, tc.want, excerpt(tc.body)) })
	}
}

func TestChanges(t *testing.T) {
	a, err := (Changes{Title: field("  お知らせ　"), Body: field("")}).create(Author{Subject: "author", Name: "Author"}, testNow)
	require.NoError(t, err)
	require.Equal(t, "お知らせ", a.Title)
	require.Equal(t, Info, a.Category)
	require.Equal(t, testNow, a.PublishedAt)
	require.Nil(t, a.ExpiresAt)
	expires := testNow.Add(time.Hour)
	a.ExpiresAt = &expires
	unchanged, err := (Changes{}).apply(a)
	require.NoError(t, err)
	require.Equal(t, &expires, unchanged.ExpiresAt)
	cleared, err := (Changes{ExpiresAt: Field[time.Time]{Present: true}}).apply(a)
	require.NoError(t, err)
	require.Nil(t, cleared.ExpiresAt)
	require.Equal(t, a.Author, cleared.Author)
}
