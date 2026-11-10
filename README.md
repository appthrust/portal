# Portal

Portal is the intranet home of a Project: announcements written by the
organisation's own people, the apps installed in the Project, and the entries
exposed by `launcher.entries/v1` providers, on one Japanese-first page.
A Go server serves the React SPA, `/config`, the authenticated `/launcher` and
`/api/portal/v1/*` routes, and `/healthz`, `/readyz`, and `/releasez`. Portal keeps
announcements and per-viewer read marks in its own PostgreSQL database and does
not proxy arbitrary Platform API requests. It is built and released
independently of the platform. The domain model, API and UI contract are in
[`design/README.md`](design/README.md).

## Source and layout

Imported from `appthrust/platform` commit
`0c59e6ab2ac02c62d4b08ba60ca1aa82da032f2e`:

- `cmd/portal-server/` → `cmd/server/`, including the home composer and server tests.
  Internal imports use `github.com/appthrust/portal`.
- `dashboard/packages/portal/` → `web/`, including the SPA, development mock, and tests.
- Neither source directory contained a README at the imported revision.

The public Go SDK is `github.com/appthrust/appserver-go v0.3.0`; no platform checkout,
module replacement, or private Go credential is required. The launcher and i18n
packages use the published `^0.1.0` GitHub Packages versions rather than workspace
packages. Tailwind scans the installed launcher package for its classes.

## Develop

Use Go 1.26 or newer and Bun 1.4.1 (the CI and image version).

```sh
go build ./... && go test ./... && go vet ./...
cd web
# GitHub Packages requires a token with read:packages access.
export NODE_AUTH_TOKEN="$(gh auth token)"
bun install --frozen-lockfile
bun run build:image
bun run typecheck
```

For local UI development, run `bun run mock` and `bun run dev` in separate terminals
in `web/`. The mock defaults to port 5226 and Vite to port 5228. To use a real server,
set `PORTAL_API_UPSTREAM` plus `PORTAL_DEV_BEARER` or `PORTAL_DEV_COOKIE_FILE` as
described in `web/vite.config.ts`.

Run the server with `go run ./cmd/server --static-dir web/dist`. Configure:

- `PLATFORM_API_URL`, `PLATFORM_PROJECT_ID`, and the platform OIDC identity settings.
  Without `PLATFORM_OIDC_ISSUER`, `--listen` must use a loopback host, such as
  `--listen 127.0.0.1:8080`.
- `PORTAL_PUBLIC_URL` for the HTTPS browser origin, without a trailing slash.
- `PORTAL_STATIC_DIR` or `--static-dir` to override `/srv/portal`.
- `PORTAL_DATABASE_URL`, falling back to `DATABASE_URL`, for announcements. Without
  a reachable database the announcement routes answer `503 portal_store_unavailable`
  and everything else keeps serving; the server never exits on a database failure.

Both probes return `ok` whether or not the database is reachable, because the home
does not need it. Unauthenticated launcher, home and announcement requests return 401;
unknown `/api/` paths and missing `/assets/` files return 404 rather than the SPA.
Project members with the `Admin` or `Editor` role may write announcements; every
signed-in user may read published ones.
`/releasez` uses `PORTAL_RELEASE_VERSION` and `PORTAL_ARTIFACT_DIGEST` supplied by the
catalog, with the shared release-file fallback; missing release identity returns
503 with `UI release status unavailable`.

Store tests run against PostgreSQL only when `BUILTIN_APPSERVER_TEST_DATABASE_URL`
is set; without it they are skipped.

Publisher renderer and mocked catalog API tests need no live services:

```sh
bun test hack/
```

Build the production image locally:

```sh
NODE_AUTH_TOKEN="$(gh auth token)" docker build --platform linux/amd64 \
  --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t portal-local .
```

The image builds the SPA natively, cross-compiles the Go binary, and uses a
non-root distroless final stage. The executable is `/portal-server`, static files
are in `/srv/portal`, and port 8080 is exposed. Npm credentials enter the build only
through a required BuildKit secret, never through build arguments or committed files.

## Catalog and release

`catalog/entry.yaml` preserves the complete spec read from
`ApplicationStackDefinition/portal` in `appthrust-ink-pmc001` on 2026-11-06, excluding
cluster-owned metadata. The served compatibility floor is `0.1.0`, stream `0.1`,
with its original immutable `ghcr.io/appthrust/platform/portal` image. No speculative
new-version image is committed.

**Do not change `spec.components`, `spec.connections`, `spec.valuesSchema` or
`spec.defaultValues` in the entry.** Installed platforms reject any such change to
an existing definition (`ApplicationStackDefinition "portal" components are
immutable`), and that rejection fails the whole catalog projection for every app,
not only Portal. `0.4.0` added a `postgresql` component and stopped catalog sync
until `0.4.1` restored the entry. Consequently no installation has a database
yet: the image serves the home and reports announcements as unavailable. The
storage path is an open decision in [`design/README.md`](design/README.md).

To release, push a SemVer tag such as `v0.4.2`.
The tag workflow:

1. Performs one multi-platform build on `ubuntu-24.04` for Linux amd64 and arm64,
   pushing `ghcr.io/appthrust/portal:<version>`.
2. Resolves and signs the image index digest with Cosign keyless signing.
3. Reads Cloud's persisted entry, merges its history with the committed floor,
   and appends the new version using `ghcr.io/appthrust/portal@sha256:<index-digest>`.
   The new version alone is default; earlier versions remain served. Reusing a
   version with different immutable images is rejected.
4. PUTs `/api/v1/catalog/entries/portal`, then POSTs `/api/v1/catalog/publish`.
   HTTP 202 with state `queued` means Cloud dispatched publication; HTTP 200 with
   state `snapshot` requires the workflow to dispatch the Cloud repository event
   using a short-lived GitHub App installation token.
5. Waits up to ten minutes for the signed catalog artifact to contain the exact
   Portal version and image digest. Dispatch alone is not publication success.

Publication commands used by the workflow:

```sh
bun hack/publish-entry.ts submit --version 0.2.0 --digest sha256:<image-index-digest>
bun hack/publish-entry.ts await --version 0.2.0 --digest sha256:<image-index-digest>
```

Writers are serialized by `portal-catalog-publish`; the workflow is guarded to
`appthrust/portal`. Required settings are repository secret `CLOUD_CATALOG_ADMIN_TOKEN`,
optional variable `CLOUD_API_URL` (default `https://api.appthrust.com`), and organization
secrets `APPTHRUST_GITHUB_ACTIONS_APP_ID` and `APPTHRUST_GITHUB_ACTIONS_APP_PRIVATE_KEY`.
The App must be installed on `appthrust/cloud` with Contents write permission.
GitHub Packages must grant this repository's `GITHUB_TOKEN` read access to
`@appthrust/app-launcher` and `@appthrust/platform-dashboard-i18n`. Make the GHCR image
public after its first publication.

`await` uses ORAS to verify the catalog index digest and Cosign to verify its signer:
`https://github.com/appthrust/cloud/.github/workflows/catalog-publish.yml@refs/heads/main`,
issued by `https://token.actions.githubusercontent.com`. It does not require the
Cloud admin token.

An existing installation moving from `ghcr.io/appthrust/platform/portal` requires an
explicit version update with `replaceRepository: true`. Subsequent `follow` updates
track the selected stream; `pinned` installations require explicit updates.

Migration authority:
[First-party app repositories](https://github.com/appthrust/platform/blob/main/design/platform/marketplace-apps/first-party-app-repositories.md).
