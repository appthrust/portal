package announcements

import (
	"encoding/json"
	"errors"
	"html"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

type Category string

const (
	Info      Category = "info"
	Important Category = "important"
	Event     Category = "event"
)

type State string

const (
	Scheduled State = "scheduled"
	Published State = "published"
	Expired   State = "expired"
)

type Author struct {
	Subject string `json:"subject"`
	Name    string `json:"name"`
}

// Announcement is the stored aggregate; visibility and excerpts are derived.
type Announcement struct {
	ID          string
	Title       string
	Body        string
	Category    Category
	Pinned      bool
	PublishedAt time.Time
	ExpiresAt   *time.Time
	Author      Author
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Read        bool
}

type AnnouncementSummary struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Excerpt     string     `json:"excerpt"`
	Category    Category   `json:"category"`
	Pinned      bool       `json:"pinned"`
	State       State      `json:"state"`
	PublishedAt time.Time  `json:"publishedAt"`
	ExpiresAt   *time.Time `json:"expiresAt"`
	Author      Author     `json:"author"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	Read        bool       `json:"read"`
}

type Detail struct {
	AnnouncementSummary
	Body string `json:"body"`
}

type Page struct {
	Items       []AnnouncementSummary `json:"items"`
	NextCursor  string                `json:"nextCursor"`
	UnreadCount int                   `json:"unreadCount"`
}

func (a Announcement) Validate() error {
	length := utf8.RuneCountInString(strings.TrimSpace(a.Title))
	if length < 1 || length > 120 {
		return errors.New("title must contain 1–120 characters after trimming")
	}
	if len(a.Body) > 20<<10 {
		return errors.New("body must not exceed 20 KiB")
	}
	if a.Category != Info && a.Category != Important && a.Category != Event {
		return errors.New("category must be info, important, or event")
	}
	if a.PublishedAt.IsZero() {
		return errors.New("publishedAt must be set")
	}
	if a.ExpiresAt != nil && !a.ExpiresAt.After(a.PublishedAt) {
		return errors.New("expiresAt must be after publishedAt")
	}
	return nil
}

func (a Announcement) State(now time.Time) State {
	if a.PublishedAt.After(now) {
		return Scheduled
	}
	if a.ExpiresAt != nil && !a.ExpiresAt.After(now) {
		return Expired
	}
	return Published
}

func CanPost(role string, member bool) bool {
	return member && (role == "Admin" || role == "Editor")
}

func (a Announcement) Summary(now time.Time) AnnouncementSummary {
	return AnnouncementSummary{
		ID: a.ID, Title: a.Title, Excerpt: excerpt(a.Body), Category: a.Category,
		Pinned: a.Pinned, State: a.State(now), PublishedAt: a.PublishedAt,
		ExpiresAt: a.ExpiresAt, Author: a.Author, CreatedAt: a.CreatedAt,
		UpdatedAt: a.UpdatedAt, Read: a.Read,
	}
}

// Field distinguishes omitted properties from explicit JSON null, as in Tracker.
type Field[T any] struct {
	Present bool
	Value   *T
}

func (f *Field[T]) UnmarshalJSON(data []byte) error {
	f.Present = true
	return json.Unmarshal(data, &f.Value)
}

// Changes is shared by create and patch; only expiresAt accepts explicit null.
type Changes struct {
	Title       Field[string]    `json:"title"`
	Body        Field[string]    `json:"body"`
	Category    Field[Category]  `json:"category"`
	Pinned      Field[bool]      `json:"pinned"`
	PublishedAt Field[time.Time] `json:"publishedAt"`
	ExpiresAt   Field[time.Time] `json:"expiresAt"`
}

func (c Changes) apply(a Announcement) (Announcement, error) {
	for _, field := range []struct {
		name    string
		present bool
		null    bool
	}{
		{"title", c.Title.Present, c.Title.Value == nil},
		{"body", c.Body.Present, c.Body.Value == nil},
		{"category", c.Category.Present, c.Category.Value == nil},
		{"pinned", c.Pinned.Present, c.Pinned.Value == nil},
		{"publishedAt", c.PublishedAt.Present, c.PublishedAt.Value == nil},
	} {
		if field.present && field.null {
			return a, errors.New(field.name + " cannot be null")
		}
	}
	if c.Title.Present {
		a.Title = strings.TrimSpace(*c.Title.Value)
	}
	if c.Body.Present {
		a.Body = *c.Body.Value
	}
	if c.Category.Present {
		a.Category = *c.Category.Value
	}
	if c.Pinned.Present {
		a.Pinned = *c.Pinned.Value
	}
	if c.PublishedAt.Present {
		a.PublishedAt = c.PublishedAt.Value.UTC()
	}
	if c.ExpiresAt.Present {
		a.ExpiresAt = nil
		if c.ExpiresAt.Value != nil {
			expires := c.ExpiresAt.Value.UTC()
			a.ExpiresAt = &expires
		}
	}
	return a, a.Validate()
}

func (c Changes) create(author Author, now time.Time) (Announcement, error) {
	if !c.Title.Present || !c.Body.Present {
		return Announcement{}, errors.New("title and body are required")
	}
	return c.apply(Announcement{Category: Info, PublishedAt: now.UTC(), Author: author, CreatedAt: now.UTC(), UpdatedAt: now.UTC()})
}

var markdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

// excerpt walks Markdown text rather than deleting punctuation from prose.
// Whitespace is collapsed so block boundaries remain readable in a single line.
func excerpt(body string) string {
	source := []byte(body)
	document := markdown.Parser().Parse(text.NewReader(source))
	var out strings.Builder
	count, space := 0, false
	appendText := func(value string) {
		for _, r := range value {
			if count == 160 {
				return
			}
			if unicode.IsSpace(r) {
				space = count > 0
				continue
			}
			if space {
				out.WriteByte(' ')
				count++
				space = false
				if count == 160 {
					return
				}
			}
			out.WriteRune(r)
			count++
		}
	}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if count == 160 {
			return ast.WalkStop, nil
		}
		if !entering {
			if node.Type() == ast.TypeBlock {
				appendText(" ")
			}
			return ast.WalkContinue, nil
		}
		switch node := node.(type) {
		case *ast.Text:
			value := node.Text(source)
			if node.IsRaw() || node.Parent().Kind() == ast.KindCodeSpan {
				appendText(string(value))
			} else {
				appendText(html.UnescapeString(string(util.UnescapePunctuations(value))))
			}
			if node.SoftLineBreak() || node.HardLineBreak() {
				appendText(" ")
			}
		case *ast.String:
			appendText(string(node.Value))
		case *ast.AutoLink:
			appendText(string(node.Label(source)))
		case *ast.CodeBlock, *ast.FencedCodeBlock:
			for i := 0; i < node.Lines().Len() && count < 160; i++ {
				line := node.Lines().At(i)
				appendText(string(line.Value(source)))
			}
		case *ast.HTMLBlock, *ast.RawHTML:
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	return out.String()
}
