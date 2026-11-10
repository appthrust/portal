// Announcements (お知らせ) and the viewer from cmd/server, under
// `/api/portal/v1` (design/README.md "API"): `GET /me`, the announcement list,
// one announcement, create/edit/delete for posters and the caller's read
// marks. Errors arrive in the SDK `httpx` envelope `{ error, message }`. While
// Portal's database is missing every route here answers
// `503 portal_store_unavailable`; the page keeps working without them.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'

export type Category = 'info' | 'important' | 'event'
export type AnnouncementState = 'scheduled' | 'published' | 'expired'
export type Scope = 'published' | 'all'
export type Author = { subject: string; name: string }

export type AnnouncementSummary = {
  id: string
  title: string
  excerpt: string
  category: Category
  pinned: boolean
  state: AnnouncementState
  publishedAt: string
  expiresAt: string | null
  author: Author
  createdAt: string
  updatedAt: string
  read: boolean
}
export type Announcement = AnnouncementSummary & { body: string }
export type AnnouncementPage = { items: AnnouncementSummary[]; nextCursor: string; unreadCount: number }
export type Me = { subject: string; name: string; canPost: boolean }

/** `POST /announcements`; omitted fields take the server defaults (`info`, not pinned, now, no end). */
export type AnnouncementInput = {
  title: string
  body: string
  category?: Category
  pinned?: boolean
  publishedAt?: string
  expiresAt?: string | null
}
/** `PATCH /announcements/{id}`: any subset of the POST fields; `expiresAt: null` clears the end time. */
export type AnnouncementPatch = Partial<AnnouncementInput>

export const CATEGORIES: readonly Category[] = ['info', 'important', 'event']
const STATES: readonly string[] = ['scheduled', 'published', 'expired'] satisfies AnnouncementState[]

/** Design invariants, mirrored for inline validation; the server stays the authority. */
export const TITLE_MAX_LENGTH = 120
export const BODY_MAX_BYTES = 20 * 1024
export const LIST_LIMIT_MAX = 50

export type ApiFailure =
  | { kind: 'denied'; httpStatus: 401 | 403 }
  | { kind: 'storeUnavailable' }
  | { kind: 'notFound' }
  | { kind: 'invalid'; message: string }
  | { kind: 'unavailable' }

/** A Portal API call that did not succeed, classified for the page. */
export class ApiError extends Error {
  readonly failure: ApiFailure

  constructor(failure: ApiFailure) {
    super(`portal api: ${failure.kind}`)
    this.name = 'ApiError'
    this.failure = failure
  }
}

export function failureOf(error: unknown): ApiFailure {
  return error instanceof ApiError ? error.failure : { kind: 'unavailable' }
}

class InvalidBody extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidBody()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidBody()
  return value
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidBody()
  return value
}

function time(value: unknown): string {
  const raw = text(value)
  if (Number.isNaN(Date.parse(raw))) throw new InvalidBody()
  return raw
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new InvalidBody()
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): T {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new InvalidBody()
  return value as T
}

export function parseMe(value: unknown): Me {
  const body = record(value)
  return { subject: text(body.subject), name: text(body.name), canPost: bool(body.canPost) }
}

export function parseSummary(value: unknown): AnnouncementSummary {
  const item = record(value)
  const author = record(item.author)
  return {
    id: text(item.id),
    title: text(item.title),
    excerpt: text(item.excerpt),
    category: oneOf<Category>(item.category, CATEGORIES),
    pinned: bool(item.pinned),
    state: oneOf<AnnouncementState>(item.state, STATES),
    publishedAt: time(item.publishedAt),
    expiresAt: item.expiresAt === null || item.expiresAt === undefined ? null : time(item.expiresAt),
    author: { subject: text(author.subject), name: text(author.name) },
    createdAt: time(item.createdAt),
    updatedAt: time(item.updatedAt),
    read: bool(item.read),
  }
}

export function parseAnnouncement(value: unknown): Announcement {
  return { ...parseSummary(value), body: text(record(value).body) }
}

export function parsePage(value: unknown): AnnouncementPage {
  const body = record(value)
  // Go encodes a nil slice as `null`.
  const items = body.items === null || body.items === undefined ? [] : body.items
  if (!Array.isArray(items)) throw new InvalidBody()
  return { items: items.map(parseSummary), nextCursor: text(body.nextCursor), unreadCount: count(body.unreadCount) }
}

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>

export const API_BASE = '/api/portal/v1'

export function listPath({ scope, limit, cursor }: { scope: Scope; limit?: number; cursor?: string }): string {
  const params = new URLSearchParams()
  if (scope !== 'published') params.set('scope', scope)
  if (limit !== undefined) params.set('limit', String(limit))
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return `${API_BASE}/announcements${query ? `?${query}` : ''}`
}

export const announcementPath = (id: string) => `${API_BASE}/announcements/${encodeURIComponent(id)}`

/** The `httpx` error envelope, or blanks when the body is not one. */
async function errorEnvelope(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = record(await response.json())
    return { code: typeof body.error === 'string' ? body.error : '', message: typeof body.message === 'string' ? body.message : '' }
  } catch {
    return { code: '', message: '' }
  }
}

/**
 * One same-origin, uncached call. 401/403 → denied; 503 `portal_store_unavailable`
 * → storeUnavailable; 404 → notFound; 400 → invalid with the server's message;
 * network failures, other statuses and unreadable bodies → unavailable.
 */
async function call<T>(fetchImpl: ApiFetch, path: string, parse: (body: unknown) => T, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    })
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new ApiError({ kind: 'unavailable' })
  }
  if (response.status === 401 || response.status === 403) throw new ApiError({ kind: 'denied', httpStatus: response.status })
  if (response.status === 404) throw new ApiError({ kind: 'notFound' })
  if (!response.ok) {
    const envelope = await errorEnvelope(response)
    if (response.status === 400) throw new ApiError({ kind: 'invalid', message: envelope.message })
    if (response.status === 503 && envelope.code === 'portal_store_unavailable') throw new ApiError({ kind: 'storeUnavailable' })
    throw new ApiError({ kind: 'unavailable' })
  }
  if (response.status === 204) return parse(undefined)
  try {
    return parse(await response.json())
  } catch {
    throw new ApiError({ kind: 'unavailable' })
  }
}

const noContent = () => undefined

export const fetchMe = (fetchImpl: ApiFetch, signal?: AbortSignal) => call(fetchImpl, `${API_BASE}/me`, parseMe, { signal })

export const fetchAnnouncements = (fetchImpl: ApiFetch, params: { scope: Scope; limit?: number; cursor?: string }, signal?: AbortSignal) =>
  call(fetchImpl, listPath(params), parsePage, { signal })

export const fetchAnnouncement = (fetchImpl: ApiFetch, id: string, signal?: AbortSignal) =>
  call(fetchImpl, announcementPath(id), parseAnnouncement, { signal })

export const createAnnouncement = (fetchImpl: ApiFetch, input: AnnouncementInput) =>
  call(fetchImpl, `${API_BASE}/announcements`, parseAnnouncement, { method: 'POST', body: JSON.stringify(input) })

export const updateAnnouncement = (fetchImpl: ApiFetch, id: string, patch: AnnouncementPatch) =>
  call(fetchImpl, announcementPath(id), parseAnnouncement, { method: 'PATCH', body: JSON.stringify(patch) })

export const deleteAnnouncement = (fetchImpl: ApiFetch, id: string) => call(fetchImpl, announcementPath(id), noContent, { method: 'DELETE' })

export const markRead = (fetchImpl: ApiFetch, id: string) => call(fetchImpl, `${announcementPath(id)}/read`, noContent, { method: 'PUT' })

export const markAllRead = (fetchImpl: ApiFetch) => call(fetchImpl, `${API_BASE}/announcements/read-all`, noContent, { method: 'POST' })

/** Same rule as the home: a transient failure is retried twice, 1.5 s apart; every classified answer is final. */
export const apiRetryLimit = 2
export const apiRetryDelayMs = 1500
export function shouldRetryApi(failureCount: number, error: unknown): boolean {
  return error instanceof ApiError && error.failure.kind === 'unavailable' && failureCount < apiRetryLimit
}

/**
 * The home block's order: pinned first, then `important`, then the rest, each
 * group keeping the server order (newest first).
 */
export function homeOrder(items: readonly AnnouncementSummary[]): AnnouncementSummary[] {
  const rank = (item: AnnouncementSummary) => (item.pinned ? 0 : item.category === 'important' ? 1 : 2)
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item)
}

/** How many rows the home block shows, and how many it asks for so pinned and important ones can rise. */
export const HOME_ROWS = 5
export const HOME_FETCH_LIMIT = 20
export const PAGE_LIMIT = 20

const browserFetch: ApiFetch = (input, init) => fetch(input, init)

export const meQueryKey = ['portal', 'me'] as const
export const homeAnnouncementsKey = ['portal', 'announcements', 'home'] as const
export const announcementPagesKey = (scope: Scope) => ['portal', 'announcements', 'pages', scope] as const
export const announcementKey = (id: string) => ['portal', 'announcements', 'item', id] as const
const announcementsRoot = ['portal', 'announcements'] as const

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: ({ signal }) => fetchMe(browserFetch, signal),
    staleTime: 5 * 60_000,
    retry: shouldRetryApi,
    retryDelay: apiRetryDelayMs,
  })
}

/** The newest published announcements for the home block (and the viewer's unread count). */
export function useHomeAnnouncements() {
  return useQuery({
    queryKey: homeAnnouncementsKey,
    queryFn: ({ signal }) => fetchAnnouncements(browserFetch, { scope: 'published', limit: HOME_FETCH_LIMIT }, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: shouldRetryApi,
    retryDelay: apiRetryDelayMs,
  })
}

/** Every announcement in `scope`, a page at a time. */
export function useAnnouncementPages(scope: Scope, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: announcementPagesKey(scope),
    queryFn: ({ signal, pageParam }) => fetchAnnouncements(browserFetch, { scope, limit: PAGE_LIMIT, cursor: pageParam }, signal),
    initialPageParam: '',
    getNextPageParam: (last) => (last.nextCursor === '' ? undefined : last.nextCursor),
    enabled,
    staleTime: 0,
    retry: shouldRetryApi,
    retryDelay: apiRetryDelayMs,
  })
}

export function useAnnouncement(id: string) {
  return useQuery({
    queryKey: announcementKey(id),
    queryFn: ({ signal }) => fetchAnnouncement(browserFetch, id, signal),
    staleTime: 0,
    retry: shouldRetryApi,
    retryDelay: apiRetryDelayMs,
  })
}

type Pages = InfiniteData<AnnouncementPage, string>

function updateSummaries(client: QueryClient, update: (page: AnnouncementPage) => AnnouncementPage) {
  client.setQueryData<AnnouncementPage>(homeAnnouncementsKey, (page) => (page ? update(page) : page))
  client.setQueriesData<Pages>({ queryKey: [...announcementsRoot, 'pages'] }, (data) => (data ? { ...data, pages: data.pages.map(update) } : data))
}

/** The cached lists with `id` read; the unread count drops once when the item was an unread published one. */
export function applyRead(page: AnnouncementPage, id: string): AnnouncementPage {
  const target = page.items.find((item) => item.id === id)
  if (!target || target.read) return page
  return {
    ...page,
    items: page.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
    unreadCount: target.state === 'published' ? Math.max(0, page.unreadCount - 1) : page.unreadCount,
  }
}

/** The cached lists with every published announcement read and nothing unread. */
export function applyReadAll(page: AnnouncementPage): AnnouncementPage {
  return { ...page, items: page.items.map((item) => (item.state === 'published' ? { ...item, read: true } : item)), unreadCount: 0 }
}

/** Marks one announcement read for the caller and updates every cached list and count. */
export function useMarkRead() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => markRead(browserFetch, id),
    onSuccess: (_, id) => {
      updateSummaries(client, (page) => applyRead(page, id))
      client.setQueryData<Announcement>(announcementKey(id), (item) => (item ? { ...item, read: true } : item))
      // Counts cover announcements no cached page holds; the server has the exact number.
      void client.invalidateQueries({ queryKey: homeAnnouncementsKey })
      void client.invalidateQueries({ queryKey: [...announcementsRoot, 'pages'] })
    },
  })
}

export function useMarkAllRead() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => markAllRead(browserFetch),
    onSuccess: () => {
      updateSummaries(client, applyReadAll)
      void client.invalidateQueries({ queryKey: announcementsRoot })
    },
  })
}

export function useSaveAnnouncement() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (request: { id?: string; input: AnnouncementInput | AnnouncementPatch }) =>
      request.id === undefined
        ? createAnnouncement(browserFetch, request.input as AnnouncementInput)
        : updateAnnouncement(browserFetch, request.id, request.input),
    onSuccess: (saved) => {
      client.setQueryData(announcementKey(saved.id), saved)
      void client.invalidateQueries({ queryKey: announcementsRoot, predicate: (query) => query.queryKey[2] !== 'item' })
    },
  })
}

export function useDeleteAnnouncement() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteAnnouncement(browserFetch, id),
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: announcementKey(id) })
      void client.invalidateQueries({ queryKey: announcementsRoot })
    },
  })
}
