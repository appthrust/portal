# Portal as an intranet home: announcements and a Japanese-first page

Status: design (2026-11-10). First target: Project `pj-a167a047c8d3` on the
Craftsman estate (`https://home.pj-a167a047c8d3.platform.craftsman-software.com`).

## Problem

Observed on the first target (installed version `0.2.0`):

- The page mixes Japanese and English. Portal's own wording is Japanese, but
  every app card shows the catalog's single English `description` (for example
  "Project AI gateway: routes chat completions to…") and a monospace hostname.
  The catalog already publishes `locales.{ja,en}.{title,tagline}` for 15 of 17
  definitions (`GET /api/v1/application-stack-definitions`), and
  `appserver-go v0.3.0` already forwards them as `launcher.Entry.Locales`;
  `@appthrust/app-launcher@0.1.0`'s `LauncherGrid` ignores them.
- The page is an app list, not a company portal: nothing tells a person what
  is new, and nobody in the organisation can publish a notice.

## Scope

In scope:

- **Announcements** (お知らせ) written by the organisation's own people and
  shown at the top of the home.
- A Japanese-first home: greeting, announcements, apps as localized tiles,
  then the provider sections that exist today.

Out of scope: comments or reactions, per-group targeting, attachments and
images, e-mail or chat notification, AppThrust product news (that is the
`appthrust-news` app; Portal does not aggregate it).

## Domain model

| Entity | Owner (sole writer) | Lifecycle | Invariants |
| --- | --- | --- | --- |
| **Announcement** | Portal; written through the API by a poster | created, edited, deleted (hard delete) | `title` 1–120 characters after trimming; `body` Markdown, at most 20 KiB; `category ∈ {info, important, event}`; `publishedAt` is always set (defaults to creation time); `expiresAt`, when set, is after `publishedAt`. |
| **Read mark** | the viewer, for themselves only | upserted on open; deleted with its announcement | one row per (announcement, subject). |

Visibility is derived, never stored: an announcement is `scheduled` while
`publishedAt > now`, `expired` once `expiresAt <= now`, otherwise `published`.
One installation is one Project, so rows carry no tenant column beyond the
installation's own database.

Apps on the home stay provider-owned: installed apps come from the Platform
read model, launch entries from `launcher.entries/v1` providers. Portal adds
no app data of its own.

## Authorization

| Action | Who |
| --- | --- |
| Read `published` announcements, mark as read | any signed-in user |
| Read `scheduled` and `expired` announcements; create, edit, delete | Project member whose role is `Admin` or `Editor` (`platformclient.Access`) |

No role is stored in Portal. The decision is a pure function
(`announcements.CanPost(role string, member bool) bool`), table-tested.
Access keys (`Principal.Kind == "key"`) are rejected, as on the home route.

Both catalog entries request `access.tokenClaims: [groups]`. Portal asks the
Platform API with the viewer's own token, and a Project role granted through a
group is matched on the token's `groups` claim; without it a member who has
access only through a group is refused `project.read` and sees no apps
(observed on Craftsman, 2026-11-10).

## API (`/api/portal/v1`)

`GET /home` is unchanged. New routes use the SDK `httpx` envelope. Times are
RFC 3339 UTC. While the database is unreachable or not configured every route
below answers `503 portal_store_unavailable`; the home, launcher, probes and
SPA keep serving.

```ts
type Category = 'info' | 'important' | 'event'
type State = 'scheduled' | 'published' | 'expired'
type Author = { subject: string; name: string }          // name snapshot taken at write time
type AnnouncementSummary = {
  id: string                 // ULID
  title: string
  excerpt: string            // plain text, first 160 characters of the body with Markdown syntax stripped
  category: Category
  pinned: boolean
  state: State
  publishedAt: string
  expiresAt: string | null
  author: Author
  createdAt: string
  updatedAt: string
  read: boolean              // the caller's read mark
}
type Announcement = AnnouncementSummary & { body: string }
```

| Method & path | Request | Response |
| --- | --- | --- |
| `GET /me` | | `200 { subject, name, canPost }` |
| `GET /announcements?scope=&limit=&cursor=` | `scope=published` (default) or `all` (posters only, else 403); `limit` 1–50, default 20 | `200 { items: AnnouncementSummary[], nextCursor: string, unreadCount: number }`; order `pinned` first, then `publishedAt` descending, then `id` descending; `nextCursor` is `""` on the last page; `unreadCount` counts every unread `published` announcement, not only this page |
| `GET /announcements/{id}` | | `200 Announcement`; a non-poster gets 404 for anything not `published` |
| `POST /announcements` | `{ title, body, category?, pinned?, publishedAt?, expiresAt? }`; defaults `info`, `false`, now, `null` | `201 Announcement` |
| `PATCH /announcements/{id}` | any subset of the POST fields; `expiresAt: null` clears it; unknown fields are rejected | `200 Announcement` |
| `DELETE /announcements/{id}` | | `204` |
| `PUT /announcements/{id}/read` | | `204`, idempotent; 404 when the caller cannot see it |
| `POST /announcements/read-all` | | `204`; marks every currently `published` announcement |

Errors: `400 invalid`, `401 unauthenticated`, `403 forbidden`, `404 not_found`,
`503 identity_unavailable`, `503 portal_store_unavailable`. JSON bodies are at
most 64 KiB and must be `application/json`.

Names come from Directory. `intranet-portal` declares `directory` as an
automatically installed dependency (`PORTAL_DIRECTORY_URL`), and the server
reads the caller's own profile (`GET /api/directory/v1/me`) with the caller's
bearer, cached per bearer hash (5 minutes; 30 seconds when unknown) and
bounded to 3 seconds. `GET /me` returns that display name, or `""` when
Directory is not linked, has no profile, or does not answer; it never returns
the token's `name`, which is the identity provider's (for example
"reoring User") and not what colleagues know the person by.

The author is whoever created the announcement, snapshotted at creation as
the Directory name, falling back to the token's `name` claim and then the
subject. An edit keeps the author and moves only `updatedAt`.

## Server layout

```
cmd/server/
  main.go, server.go             env, pending.Serve/Swap, probes, /config, /releasez, static SPA
  internal/home/                 unchanged
  internal/announcements/
    domain.go                    types, validation, State(now), CanPost, excerpt; pure, table-tested
    store.go + migrations/*.sql  pgstore.Open(…, "portal_schema_migrations"); tables portal_announcement, portal_announcement_read
    api.go                       handlers, Unavailable()
```

Environment: `PORTAL_DATABASE_URL`, falling back to `DATABASE_URL`. A missing
or unreachable database never stops the process: `/readyz` reports ready
regardless, because the home does not need the database. Time is injected
(`now func() time.Time`).

## Catalog entries and storage

The server reads its database from `PORTAL_DATABASE_URL`/`DATABASE_URL`.
`0.4.0` declared a `postgresql` component and `database` connection in
`catalog/entry.yaml`; installed platforms reject any change to an existing
definition's components or connections
(`validateApplicationStackDefinitionRuntimeContractStable` in the operator's
admission), and the rejection failed the whole catalog projection on Craftsman
from 01:32Z to 02:02Z on 2026-11-10 until `0.4.1` restored the entry. The
`portal` definition's runtime contract therefore stays as imported and its
installations never have a database.

Decision (2026-11-10): a second definition, `intranet-portal`, declares the
database from its first version (`0.5.0`): components `web` and `database`
(`postgresql`, `CNPG`, `1Gi`), connection `database`, title "Portal", hostname
label `portal` so it can be installed next to `portal` (`home`) while a
Project moves over. Creating a definition passes admission (server dry-run on
Craftsman). Both definitions are published from this repository by the same
tag and run the same server. The platform derives every environment variable
from `releaseIdentityEnvPrefix` (`PORTAL` for both), so the definition id is
carried by the image: `PORTAL_DEFINITION_ID`, a build argument, read by the
launcher catalog and the link resolver.

Rejected:

- A separate announcements app that Portal reaches through a capability link.
  It keeps Portal a pure composer, but a new repository cannot publish without
  the catalog token and the dispatch key being granted to it, and it adds a
  provider contract and a second UI for one aggregate.
- A platform change that admits additive components on a definition update.
  It needs a platform release delivered to every estate before any app can
  rely on it.

Open: retiring the `portal` entry (which sets its versions `served: false` on
every estate) once its installations have moved.

## UI

One page, Japanese by default (`appthrust-language` cookie, as today), English
complete. Routes: `/` home, `/announcements` all announcements,
`/announcements/<id>` one announcement, `/announcements/new` and
`/announcements/<id>/edit` the editor. The server already answers every
non-asset path with the SPA.

Home, top to bottom:

1. Header: portal name, Project name, app switcher, language.
2. Greeting for the time of day with the viewer's Directory name (`GET /me`;
   no name when it is `""`), today's date, and the app search box.
3. **お知らせ**: pinned and `important` first, each row with category, title,
   date and an unread mark; five rows, then "すべて見る". Posters see
   "お知らせを書く". Selecting a row opens the announcement and marks it read.
4. **アプリ**: every installed app except Portal as a launcher tile — a large
   icon on a per-app colour, the localized title, and the localized tagline
   clamped to one line (full text as the tile's tooltip). Tiles are grouped
   by purpose, from the optional `builtinApps[].category` (the catalog's
   category id, forwarded by `appserver-go`):

   | Group, in order | Categories |
   | --- | --- |
   | 仕事で使う / For everyday work | `collaborate` |
   | AI を使う / AI | `assist` |
   | つくる・管理する / Build and manage | `build`, `develop`, any other or none |

   Every group is open under a plain heading. A group with no app is not
   rendered; when only one group has apps its heading is omitted. Search
   filters across all groups. Text comes from `builtinApps[].locales[language]`; a field the
   catalog does not localize falls back to `name`/`description`. No hostname.
   An app that is not `Ready` keeps a status badge in the viewer's language.
   The read model's phase set is open and never fails the page: `Pending`
   renders as 準備中, `NeedsConfiguration` as 要確認, and `UpdateAvailable` or
   any phase Portal does not know as a usable app without a badge.
5. Provider sections (自分のアプリ / 部署のアプリ / 社内のアプリ), unchanged in
   behaviour.

The editor (create and edit) is a form with title, category, body (Markdown
with preview), pinned, publish time and optional end time. Posters reach
`scheduled` and `expired` announcements from the list page (`scope=all`), each
labelled with its state. Markdown is rendered with `marked` and sanitized with
`dompurify`, as Memo and AppThrust News do.

`@appthrust/app-launcher`'s `LauncherGrid` and its strict `Entry` schema are no
longer used; `AppSwitcher` and `iconFor` still are. The installed-app tiles
read `GET /api/portal/v1/home` (`builtinApps`), which carries `locales`.

## Verification

- `go vet ./... && go test ./...`: domain tables (validation, state, `CanPost`,
  excerpt), API tests over a fake store, store tests against Postgres when the
  SDK test database variable is set.
- `bun run typecheck && bun test src && bun run build:image` in `web/`; the mock
  server implements every route above.
- Local two-process run: server on loopback without an issuer plus a local
  Postgres; create, edit, schedule, expire, read marks through the SPA.
- After publication: `/releasez` on the first target reports the new version;
  a signed-in Admin posts one announcement and a second account sees it unread.

## Alternatives considered

- **Consume announcements from a capability** (`launcher.entries/v1` style
  provider): no provider exists, and a notice board with no owner app is the
  gap being filled. Portal owning its announcements is one aggregate, one
  writer.
- **Reuse `appthrust-news`**: its content is AppThrust's product news embedded
  in the image, global to every Project and not writable by the organisation.
- **Read marks in the browser** (as AppThrust News does): an unread mark that
  resets per device is noise on a page people open every day from several
  devices.
- **Translate catalog text in a client table** (`appCatalogCopyJa`): the
  catalog already publishes locales; a second table drifts.
