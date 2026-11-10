// `GET /api/portal/v1/home?q=` from cmd/server: the Project, its installed
// apps (the `/launcher` entries plus the catalog's per-language display text;
// the wire key is `builtinApps`) and the Launch Entries every
// `launcher.entries/v1` provider made for this viewer, grouped into sections
// (owner → group → project), plus one state per provider. The edge holds the
// session cookie; the SPA never handles a token. Like `/launcher`, freshness is
// bounded by the server-side cache only, so the client keeps nothing stale.
import { LauncherProject } from '@appthrust/app-launcher'
import type { DashboardLanguage } from '@appthrust/platform-dashboard-i18n'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

export type EntryState = 'ready' | 'preparing' | 'restricted'
export type Relation = 'owner' | 'group' | 'project'
export type GroupRef = { id: string; name: string; path: string }

/** A Launch Entry (contract `launcher.entries/v1`) plus the provider it came from. */
export type AppEntry = {
  id: string
  name: string
  description: string
  icon: string
  url?: string
  detailUrl?: string
  state: EntryState
  relation: Relation
  group?: GroupRef
  tags: string[]
  sourceDefinitionId: string
}

export type HomeSection = { relation: Relation; group: GroupRef | null; entries: AppEntry[] }
export type SourceState = { definitionId: string; state: 'ready' | 'absent' | 'unavailable' }

/** Catalog display text for one language; a field the catalog does not localize is absent. */
export type AppLocale = { title?: string; tagline?: string }
/**
 * An installed app's phase as the tiles show it. The Platform read model reports `Pending`,
 * `Ready`, `NeedsConfiguration`, `Degraded` and `UpdateAvailable` and may add more:
 * `NeedsConfiguration` shows as `Degraded`; `UpdateAvailable` and any phase Portal does
 * not know leave the app usable and show as `Ready`.
 */
export type InstalledPhase = 'Pending' | 'Installing' | 'Ready' | 'Upgrading' | 'Degraded' | 'Uninstalling'
/**
 * An installed app: the `/launcher` entry fields plus the catalog's `locales` keyed by language (`ja`, `en`)
 * and its catalog category id (`collaborate`, `assist`, `build`, …), which may be absent.
 */
export type InstalledApp = {
  definitionId: string
  name: string
  description: string
  icon: string
  url: string
  phase: InstalledPhase
  current: boolean
  dependencyOf?: string
  locales?: Record<string, AppLocale>
  category?: string
}

export type HomeResponse = { project: LauncherProject; installedApps: InstalledApp[]; sections: HomeSection[]; sources: SourceState[] }
/** The body cmd/server sends; it names the installed apps `builtinApps`. */
export type HomeWireBody = Omit<HomeResponse, 'installedApps'> & { builtinApps: InstalledApp[] }

export type HomeState =
  | { status: 'loading' }
  | { status: 'ready'; home: HomeResponse }
  | { status: 'denied'; httpStatus: 401 | 403 }
  | { status: 'unavailable' }

type FailedState = Extract<HomeState, { status: 'denied' } | { status: 'unavailable' }>

/** A `/api/portal/v1/home` request that ended in a non-ready state. */
export class HomeError extends Error {
  readonly state: FailedState

  constructor(state: FailedState) {
    super(state.status === 'denied' ? `home denied (${state.httpStatus})` : 'home unavailable')
    this.name = 'HomeError'
    this.state = state
  }
}

const ENTRY_STATES: readonly string[] = ['ready', 'preparing', 'restricted'] satisfies EntryState[]
const RELATIONS: readonly string[] = ['owner', 'group', 'project'] satisfies Relation[]
const SOURCE_STATES: readonly string[] = ['ready', 'absent', 'unavailable'] satisfies SourceState['state'][]
const INSTALLED_PHASES: readonly string[] = ['Pending', 'Installing', 'Ready', 'Upgrading', 'Degraded', 'Uninstalling'] satisfies InstalledPhase[]
const PLATFORM_PHASES: Readonly<Record<string, InstalledPhase>> = { NeedsConfiguration: 'Degraded', UpdateAvailable: 'Ready' }

class InvalidHome extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidHome()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidHome()
  return value
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : text(value)
}

/** Go encodes a nil slice as `null`; both mean "none". */
function list(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new InvalidHome()
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): T {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new InvalidHome()
  return value as T
}

function parseGroup(value: unknown): GroupRef | undefined {
  if (value === null || value === undefined) return undefined
  const group = record(value)
  return { id: text(group.id), name: text(group.name), path: text(group.path) }
}

function parseAppEntry(value: unknown): AppEntry {
  const entry = record(value)
  const url = optionalText(entry.url)
  const detailUrl = optionalText(entry.detailUrl)
  const group = parseGroup(entry.group)
  return {
    id: text(entry.id),
    name: text(entry.name),
    description: text(entry.description),
    icon: text(entry.icon),
    ...(url ? { url } : {}),
    ...(detailUrl ? { detailUrl } : {}),
    state: oneOf<EntryState>(entry.state, ENTRY_STATES),
    relation: oneOf<Relation>(entry.relation, RELATIONS),
    ...(group ? { group } : {}),
    tags: list(entry.tags).map(text),
    sourceDefinitionId: text(entry.sourceDefinitionId),
  }
}

/** Go omits empty locale fields; a blank one means "not localized" either way. */
function localeText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const trimmed = text(value).trim()
  return trimmed === '' ? undefined : trimmed
}

function parseLocales(value: unknown): Record<string, AppLocale> | undefined {
  if (value === undefined || value === null) return undefined
  const locales: Record<string, AppLocale> = {}
  for (const [language, raw] of Object.entries(record(value))) {
    const locale = record(raw)
    const title = localeText(locale.title)
    const tagline = localeText(locale.tagline)
    locales[language] = { ...(title ? { title } : {}), ...(tagline ? { tagline } : {}) }
  }
  return locales
}

/**
 * Portal's own reading of an installed app, not the launcher package's strict `Entry` schema:
 * that schema rejects phases it does not list (`Pending`), and one such app must not take the home down.
 */
function parseInstalledApp(value: unknown): InstalledApp {
  const app = record(value)
  if (typeof app.current !== 'boolean') throw new InvalidHome()
  const phase = text(app.phase)
  const dependencyOf = optionalText(app.dependencyOf)
  const locales = parseLocales(app.locales)
  const category = typeof app.category === 'string' && app.category.trim() !== '' ? app.category.trim() : undefined
  return {
    definitionId: text(app.definitionId),
    name: text(app.name),
    description: text(app.description),
    icon: text(app.icon),
    url: text(app.url),
    phase: INSTALLED_PHASES.includes(phase) ? (phase as InstalledPhase) : (PLATFORM_PHASES[phase] ?? 'Ready'),
    current: app.current,
    ...(dependencyOf ? { dependencyOf } : {}),
    ...(locales ? { locales } : {}),
    ...(category ? { category } : {}),
  }
}

/** Validates a home body; throws on any shape the page could not render faithfully. */
export function parseHome(value: unknown): HomeResponse {
  const body = record(value)
  const project = LauncherProject.safeParse(body.project)
  if (!project.success) throw new InvalidHome()
  const installedApps = list(body.builtinApps).map(parseInstalledApp)
  const sections = list(body.sections).map((item): HomeSection => {
    const section = record(item)
    return {
      relation: oneOf<Relation>(section.relation, RELATIONS),
      group: parseGroup(section.group) ?? null,
      entries: list(section.entries).map(parseAppEntry),
    }
  })
  const sources = list(body.sources).map((item): SourceState => {
    const source = record(item)
    return { definitionId: text(source.definitionId), state: oneOf<SourceState['state']>(source.state, SOURCE_STATES) }
  })
  return { project: project.data, installedApps, sections, sources }
}

/**
 * What an app tile shows in `language`: the catalog's localized title and
 * tagline, each falling back on its own to the served `name` / `description`.
 */
export function installedAppText(app: InstalledApp, language: DashboardLanguage): { title: string; tagline: string } {
  const locale = app.locales?.[language]
  return { title: locale?.title ?? app.name, tagline: locale?.tagline ?? app.description }
}

/** Only an app being removed cannot be opened; every other phase navigates (same rule as `@appthrust/app-launcher`). */
export function isNavigable(app: InstalledApp): boolean {
  return app.phase !== 'Uninstalling'
}

/** Tile search: a case-insensitive substring of the shown title or tagline, or of the catalog name. Blank matches all. */
export function matchesInstalledApp(app: InstalledApp, query: string, language: DashboardLanguage): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  const { title, tagline } = installedAppText(app, language)
  return [title, tagline, app.name].some((value) => value.toLowerCase().includes(needle))
}

/** The tiles: every installed app except the page's own (the portal itself), in server order. */
export function tileApps(apps: readonly InstalledApp[]): InstalledApp[] {
  return apps.filter((app) => !app.current)
}

/** The purpose groups of the アプリ block, in page order (design/README.md, UI item 4). */
export type AppGroupId = 'everyday' | 'ai' | 'manage'
/** One purpose group: its apps in server order; a `collapsed` group starts closed behind a disclosure. */
export type AppGroup = { id: AppGroupId; collapsed: boolean; apps: InstalledApp[] }

const GROUP_OF_CATEGORY: Readonly<Record<string, AppGroupId>> = { collaborate: 'everyday', assist: 'ai' }

/**
 * Sorts apps into the purpose groups by catalog category: `collaborate` → everyday work,
 * `assist` → AI, any other category or none → build and manage (collapsed). Groups keep
 * page order and server order within; a group with no app is left out.
 */
export function groupInstalledApps(apps: readonly InstalledApp[]): AppGroup[] {
  const groups: AppGroup[] = [
    { id: 'everyday', collapsed: false, apps: [] },
    { id: 'ai', collapsed: false, apps: [] },
    { id: 'manage', collapsed: true, apps: [] },
  ]
  for (const app of apps) {
    const id = app.category !== undefined && Object.hasOwn(GROUP_OF_CATEGORY, app.category) ? GROUP_OF_CATEGORY[app.category] : 'manage'
    groups.find((group) => group.id === id)?.apps.push(app)
  }
  return groups.filter((group) => group.apps.length > 0)
}

/** One cache entry per search; the key carries `q` exactly as sent (trimmed, blank = no search). */
export const homeQueryKey = (q: string) => ['portal', 'home', q.trim()] as const

/** `/api/portal/v1/home`, with `q` only when there is something to search for. */
export function homePath(q: string): string {
  const search = q.trim()
  return search === '' ? '/api/portal/v1/home' : `/api/portal/v1/home?${new URLSearchParams({ q: search })}`
}

export type HomeFetch = (input: string, init?: RequestInit) => Promise<Response>

const unavailable = () => new HomeError({ status: 'unavailable' })

/** Fetches and validates the home: 401/403 → denied; network, 4xx/5xx or an invalid body → unavailable. */
export async function fetchHome(fetchImpl: HomeFetch, q: string, signal?: AbortSignal): Promise<HomeResponse> {
  let response: Response
  try {
    response = await fetchImpl(homePath(q), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw unavailable()
  }
  if (response.status === 401 || response.status === 403) {
    throw new HomeError({ status: 'denied', httpStatus: response.status })
  }
  if (!response.ok) throw unavailable()
  try {
    return parseHome(await response.json())
  } catch {
    throw unavailable()
  }
}

/** Same rule as `/launcher`: a cold server's 503 is retried twice, 1.5 s apart; `denied` is final. */
export const homeRetryLimit = 2
export const homeRetryDelayMs = 1500
export function shouldRetryHome(failureCount: number, error: unknown): boolean {
  return error instanceof HomeError && error.state.status === 'unavailable' && failureCount < homeRetryLimit
}

/** Maps a query snapshot to the home state; the latest failure wins over older data. */
export function homeStateOf(data: HomeResponse | undefined, error: unknown): HomeState {
  if (error) return error instanceof HomeError ? error.state : { status: 'unavailable' }
  if (data) return { status: 'ready', home: data }
  return { status: 'loading' }
}

/**
 * The home for search `q`. While a new search is in flight the previous answer
 * stays on screen (`stale: true`) instead of flashing a loading line.
 */
export function useHome(q: string): { state: HomeState; stale: boolean; refetch: () => void } {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: homeQueryKey(q),
    queryFn: ({ signal }) => fetchHome((input, init) => fetch(input, init), q, signal),
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    retry: shouldRetryHome,
    retryDelay: homeRetryDelayMs,
  })
  const refetch = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: homeQueryKey(q), exact: true })
  }, [queryClient, q])
  return { state: homeStateOf(query.data, query.error), stale: query.isPlaceholderData, refetch }
}

/** How long the search box waits for typing to pause before re-querying the home. */
export const SEARCH_DEBOUNCE_MS = 300

/** Calls `apply` with the last pushed value once `delayMs` passes without another push. */
export function createDebouncer<T>(apply: (value: T) => void, delayMs = SEARCH_DEBOUNCE_MS): { push: (value: T) => void; cancel: () => void } {
  let cancelPending = () => {}
  return {
    push(value) {
      cancelPending()
      const timer = setTimeout(() => apply(value), delayMs)
      cancelPending = () => clearTimeout(timer)
    },
    cancel: () => cancelPending(),
  }
}

/** `value` once it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value)
  const debouncer = useMemo(() => createDebouncer(setSettled, delayMs), [delayMs])
  useEffect(() => debouncer.push(value), [debouncer, value])
  useEffect(() => debouncer.cancel, [debouncer])
  return settled
}
