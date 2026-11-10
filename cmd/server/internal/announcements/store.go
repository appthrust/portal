package announcements

import (
	"context"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/lib/pq"
	"github.com/oklog/ulid/v2"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct{ *pgstore.Store }

func Open(ctx context.Context, dsn string) (*Store, error) {
	database, err := pgstore.Open(ctx, dsn, migrations, "portal_schema_migrations")
	if err != nil {
		return nil, err
	}
	return &Store{Store: database}, nil
}

func (s *Store) do(ctx context.Context, write bool, fn func(*pgstore.Tx) error) error {
	return translate(s.Store.Do(ctx, write, fn))
}

func invalid(message string) error { return httpx.Fail(400, "invalid", message) }

func translate(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return httpx.NotFound()
	}
	var pg *pq.Error
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return httpx.Conflict("This value is already in use")
		case "23503", "23514":
			return invalid("A referenced resource or value is invalid")
		}
	}
	return err
}

// Check keeps /me sensitive to an outage after the initial connection succeeds.
func (s *Store) Check(ctx context.Context) error {
	return s.do(ctx, false, func(tx *pgstore.Tx) error {
		var one int
		return tx.SQL.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
	})
}

type ListOptions struct {
	Scope  string
	Limit  int
	Cursor string
}

type cursor struct {
	Version     int       `json:"v"`
	Scope       string    `json:"scope"`
	Pinned      bool      `json:"pinned"`
	PublishedAt time.Time `json:"publishedAt"`
	ID          string    `json:"id"`
}

func decodeCursor(options ListOptions) (*cursor, error) {
	if options.Scope != "published" && options.Scope != "all" {
		return nil, invalid("scope must be published or all")
	}
	if options.Limit < 1 || options.Limit > 50 {
		return nil, invalid("limit must be between 1 and 50")
	}
	if options.Cursor == "" {
		return nil, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(options.Cursor)
	if err != nil {
		return nil, invalid("cursor is invalid")
	}
	var c cursor
	if json.Unmarshal(data, &c) != nil || c.Version != 1 || c.Scope != options.Scope || c.PublishedAt.IsZero() {
		return nil, invalid("cursor is invalid")
	}
	if _, err := ulid.ParseStrict(c.ID); err != nil {
		return nil, invalid("cursor is invalid")
	}
	return &c, nil
}

func encodeCursor(a Announcement, scope string) string {
	data, _ := json.Marshal(cursor{Version: 1, Scope: scope, Pinned: a.Pinned, PublishedAt: a.PublishedAt, ID: a.ID})
	return base64.RawURLEncoding.EncodeToString(data)
}

const columns = `a.id, a.title, a.body, a.category, a.pinned, a.published_at, a.expires_at,
    a.author_subject, a.author_name, a.created_at, a.updated_at, (r.subject IS NOT NULL)`

const visible = `a.published_at <= $2 AND (a.expires_at IS NULL OR a.expires_at > $2)`

type scanner interface{ Scan(...any) error }

func scanAnnouncement(row scanner) (Announcement, error) {
	var a Announcement
	err := row.Scan(&a.ID, &a.Title, &a.Body, &a.Category, &a.Pinned, &a.PublishedAt, &a.ExpiresAt,
		&a.Author.Subject, &a.Author.Name, &a.CreatedAt, &a.UpdatedAt, &a.Read)
	a.PublishedAt = a.PublishedAt.UTC()
	a.CreatedAt = a.CreatedAt.UTC()
	a.UpdatedAt = a.UpdatedAt.UTC()
	if a.ExpiresAt != nil {
		value := a.ExpiresAt.UTC()
		a.ExpiresAt = &value
	}
	return a, err
}

func get(tx *pgstore.Tx, id, subject string) (Announcement, error) {
	return scanAnnouncement(tx.SQL.QueryRowContext(tx.Context, `SELECT `+columns+`
        FROM portal_announcement a LEFT JOIN portal_announcement_read r
        ON r.announcement_id = a.id AND r.subject = $1 WHERE a.id = $2`, subject, id))
}

func (s *Store) List(ctx context.Context, subject string, options ListOptions, now time.Time) (Page, error) {
	page := Page{Items: []AnnouncementSummary{}}
	c, err := decodeCursor(options)
	if err != nil {
		return page, err
	}
	err = s.do(ctx, false, func(tx *pgstore.Tx) error {
		if err := tx.SQL.QueryRowContext(ctx, `SELECT count(*) FROM portal_announcement a
            LEFT JOIN portal_announcement_read r ON r.announcement_id = a.id AND r.subject = $1
            WHERE `+visible+` AND r.subject IS NULL`, subject, now).Scan(&page.UnreadCount); err != nil {
			return err
		}
		args := []any{subject, now, options.Scope == "all"}
		query := `SELECT ` + columns + ` FROM portal_announcement a
            LEFT JOIN portal_announcement_read r ON r.announcement_id = a.id AND r.subject = $1
            WHERE ($3 OR (` + visible + `))`
		if c != nil {
			query += ` AND (a.pinned, a.published_at, a.id) < ($4, $5, $6)
                ORDER BY a.pinned DESC, a.published_at DESC, a.id DESC LIMIT $7`
			args = append(args, c.Pinned, c.PublishedAt, c.ID, options.Limit+1)
		} else {
			query += ` ORDER BY a.pinned DESC, a.published_at DESC, a.id DESC LIMIT $4`
			args = append(args, options.Limit+1)
		}
		rows, err := tx.SQL.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		var last Announcement
		for rows.Next() {
			a, err := scanAnnouncement(rows)
			if err != nil {
				return err
			}
			if len(page.Items) == options.Limit {
				page.NextCursor = encodeCursor(last, options.Scope)
				break
			}
			page.Items = append(page.Items, a.Summary(now))
			last = a
		}
		return rows.Err()
	})
	return page, err
}

func (s *Store) Get(ctx context.Context, id, subject string) (Announcement, error) {
	var a Announcement
	err := s.do(ctx, false, func(tx *pgstore.Tx) error {
		var err error
		a, err = get(tx, id, subject)
		return err
	})
	return a, err
}

func (s *Store) Create(ctx context.Context, changes Changes, author Author, now time.Time) (Announcement, error) {
	a, err := changes.create(author, now)
	if err != nil {
		return a, invalid(err.Error())
	}
	a.ID = ulid.Make().String()
	err = s.do(ctx, true, func(tx *pgstore.Tx) error {
		if err := tx.Exec(`INSERT INTO portal_announcement
            (id, title, body, category, pinned, published_at, expires_at, author_subject, author_name, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, a.ID, a.Title, a.Body, a.Category, a.Pinned,
			a.PublishedAt, a.ExpiresAt, a.Author.Subject, a.Author.Name, a.CreatedAt, a.UpdatedAt); err != nil {
			return err
		}
		var err error
		a, err = get(tx, a.ID, author.Subject)
		return err
	})
	return a, err
}

func (s *Store) Patch(ctx context.Context, id, subject string, changes Changes, now time.Time) (Announcement, error) {
	var a Announcement
	err := s.do(ctx, true, func(tx *pgstore.Tx) error {
		var err error
		a, err = get(tx, id, subject)
		if err != nil {
			return err
		}
		a, err = changes.apply(a)
		if err != nil {
			return invalid(err.Error())
		}
		if err := tx.Exec(`UPDATE portal_announcement SET title=$2, body=$3, category=$4, pinned=$5,
            published_at=$6, expires_at=$7, updated_at=$8 WHERE id=$1`, id, a.Title, a.Body, a.Category,
			a.Pinned, a.PublishedAt, a.ExpiresAt, now.UTC()); err != nil {
			return err
		}
		a, err = get(tx, id, subject)
		return err
	})
	return a, err
}

func (s *Store) Delete(ctx context.Context, id string) error {
	return s.do(ctx, true, func(tx *pgstore.Tx) error {
		var deleted string
		return tx.SQL.QueryRowContext(ctx, `DELETE FROM portal_announcement WHERE id=$1 RETURNING id`, id).Scan(&deleted)
	})
}

// MarkRead checks visibility in the same serialized transaction as the write.
func (s *Store) MarkRead(ctx context.Context, id, subject string, canPost bool, now time.Time) error {
	return s.do(ctx, true, func(tx *pgstore.Tx) error {
		a, err := get(tx, id, subject)
		if err != nil {
			return err
		}
		if !canPost && a.State(now) != Published {
			return httpx.NotFound()
		}
		return tx.Exec(`INSERT INTO portal_announcement_read (announcement_id, subject)
            VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, subject)
	})
}

func (s *Store) MarkAllRead(ctx context.Context, subject string, now time.Time) error {
	return s.do(ctx, true, func(tx *pgstore.Tx) error {
		return tx.Exec(`INSERT INTO portal_announcement_read (announcement_id, subject)
            SELECT a.id, $1 FROM portal_announcement a WHERE `+visible+` ON CONFLICT DO NOTHING`, subject, now)
	})
}
