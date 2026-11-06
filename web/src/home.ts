// `GET /api/portal/v1/home?q=` from cmd/portal-server: the Project, its
// installed apps (the `/launcher` entries; the wire key is
// portal-server's `builtinApps`) and the Launch Entries every
// `launcher.entries/v1` provider made for this viewer, grouped into sections
// (owner → group → project), plus one state per provider. The edge holds the
// session cookie; the SPA never handles a token. Like `/launcher`, freshness is
// bounded by the server-side cache only, so the client keeps nothing stale.
import { Entry as InstalledAppEntry, LauncherProject } from '@appthrust/app-launcher'
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
export type HomeResponse = { project: LauncherProject; installedApps: InstalledAppEntry[]; sections: HomeSection[]; sources: SourceState[] }
/** The body portal-server sends; it still names the installed apps `builtinApps`. */
export type HomeWireBody = Omit<HomeResponse, 'installedApps'> & { builtinApps: InstalledAppEntry[] }

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

/** Validates a home body; throws on any shape the page could not render faithfully. */
export function parseHome(value: unknown): HomeResponse {
  const body = record(value)
  const project = LauncherProject.safeParse(body.project)
  if (!project.success) throw new InvalidHome()
  const installedApps = list(body.builtinApps).map((item) => {
    const parsed = InstalledAppEntry.safeParse(item)
    if (!parsed.success) throw new InvalidHome()
    return parsed.data
  })
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
