import { describe, expect, test } from 'bun:test'
import {
  ApiError,
  applyRead,
  applyReadAll,
  createAnnouncement,
  deleteAnnouncement,
  failureOf,
  fetchAnnouncement,
  fetchAnnouncements,
  fetchMe,
  homeOrder,
  listPath,
  markAllRead,
  markRead,
  parsePage,
  parseSummary,
  shouldRetryApi,
  updateAnnouncement,
  type AnnouncementSummary,
  type ApiFetch,
  type ApiFailure,
} from './announcements'

const summary = (id: string, overrides: Partial<AnnouncementSummary> = {}): AnnouncementSummary => ({
  id,
  title: `Title ${id}`,
  excerpt: 'Excerpt',
  category: 'info',
  pinned: false,
  state: 'published',
  publishedAt: '2026-11-09T01:00:00Z',
  expiresAt: null,
  author: { subject: 'user-1', name: '佐藤 花子' },
  createdAt: '2026-11-09T00:00:00Z',
  updatedAt: '2026-11-09T00:00:00Z',
  read: false,
  ...overrides,
})

type Call = { input: string; init?: RequestInit }

function recorder(response: () => Response): { fetch: ApiFetch; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init })
      return response()
    },
  }
}

async function failure(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise
  } catch (error) {
    return failureOf(error)
  }
  throw new Error('expected the call to fail')
}

const respond = (status: number, body: unknown) => () => Response.json(body, { status })

describe('announcement parsing', () => {
  test('a page parses items, cursor and the unread count; a Go nil slice is no items', () => {
    const page = parsePage({ items: [summary('01A')], nextCursor: 'next', unreadCount: 3 })
    expect(page).toEqual({ items: [summary('01A')], nextCursor: 'next', unreadCount: 3 })
    expect(parsePage({ items: null, nextCursor: '', unreadCount: 0 }).items).toEqual([])
  })

  test('summaries reject shapes the page could not render faithfully', () => {
    const bad: Record<string, unknown>[] = [
      { category: 'urgent' },
      { state: 'draft' },
      { pinned: 'yes' },
      { publishedAt: 'yesterday' },
      { expiresAt: 'never' },
      { author: null },
      { read: undefined },
    ]
    for (const overrides of bad) expect(() => parseSummary({ ...summary('01A'), ...overrides })).toThrow()
    expect(parseSummary({ ...summary('01A'), expiresAt: '2026-12-01T00:00:00Z' }).expiresAt).toBe('2026-12-01T00:00:00Z')
  })

  test('a negative or fractional unread count is invalid', () => {
    expect(() => parsePage({ items: [], nextCursor: '', unreadCount: -1 })).toThrow()
    expect(() => parsePage({ items: [], nextCursor: '', unreadCount: 1.5 })).toThrow()
  })
})

describe('announcement requests', () => {
  test('the list path sends scope only when it is not the default, and limit/cursor when given', () => {
    expect(listPath({ scope: 'published' })).toBe('/api/portal/v1/announcements')
    expect(listPath({ scope: 'all', limit: 20, cursor: 'c/1' })).toBe('/api/portal/v1/announcements?scope=all&limit=20&cursor=c%2F1')
  })

  test('reads are same-origin, uncached GETs that accept JSON', async () => {
    const api = recorder(respond(200, { subject: 'user-1', name: '佐藤 花子', canPost: true }))
    expect(await fetchMe(api.fetch)).toEqual({ subject: 'user-1', name: '佐藤 花子', canPost: true })
    expect(api.calls[0].input).toBe('/api/portal/v1/me')
    expect(api.calls[0].init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
    expect(api.calls[0].init?.method).toBeUndefined()
  })

  test('writes send JSON bodies with the right method and path', async () => {
    const saved = { ...summary('01A'), body: '本文' }
    const api = recorder(respond(201, saved))
    await createAnnouncement(api.fetch, { title: 'お知らせ', body: '本文', category: 'event' })
    await updateAnnouncement(api.fetch, '01A', { expiresAt: null })
    expect(api.calls.map((call) => [call.init?.method, call.input, call.init?.body])).toEqual([
      ['POST', '/api/portal/v1/announcements', JSON.stringify({ title: 'お知らせ', body: '本文', category: 'event' })],
      ['PATCH', '/api/portal/v1/announcements/01A', JSON.stringify({ expiresAt: null })],
    ])
    expect(api.calls[0].init?.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' })
  })

  test('204 routes resolve without a body', async () => {
    const api = recorder(() => new Response(null, { status: 204 }))
    await deleteAnnouncement(api.fetch, '01A')
    await markRead(api.fetch, '01A')
    await markAllRead(api.fetch)
    expect(api.calls.map((call) => [call.init?.method, call.input])).toEqual([
      ['DELETE', '/api/portal/v1/announcements/01A'],
      ['PUT', '/api/portal/v1/announcements/01A/read'],
      ['POST', '/api/portal/v1/announcements/read-all'],
    ])
  })

  test('statuses map to page failures: denied, store unavailable, not found, invalid with the message, unavailable', async () => {
    const list = (status: number, body: unknown) => fetchAnnouncements(recorder(respond(status, body)).fetch, { scope: 'published' })
    expect(await failure(list(401, { error: 'unauthenticated', message: 'x' }))).toEqual({ kind: 'denied', httpStatus: 401 })
    expect(await failure(list(403, { error: 'forbidden', message: 'x' }))).toEqual({ kind: 'denied', httpStatus: 403 })
    expect(await failure(list(503, { error: 'portal_store_unavailable', message: 'x' }))).toEqual({ kind: 'storeUnavailable' })
    expect(await failure(list(503, { error: 'identity_unavailable', message: 'x' }))).toEqual({ kind: 'unavailable' })
    expect(await failure(list(500, 'oops'))).toEqual({ kind: 'unavailable' })
    expect(await failure(list(200, { items: 'nope' }))).toEqual({ kind: 'unavailable' })
    expect(await failure(fetchAnnouncement(recorder(respond(404, { error: 'not_found', message: 'x' })).fetch, '01A'))).toEqual({ kind: 'notFound' })
    const invalid = createAnnouncement(recorder(respond(400, { error: 'invalid', message: 'title must be 1-120 characters' })).fetch, { title: '', body: '' })
    expect(await failure(invalid)).toEqual({ kind: 'invalid', message: 'title must be 1-120 characters' })
    const offline: ApiFetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    expect(await failure(fetchMe(offline))).toEqual({ kind: 'unavailable' })
  })

  test('only transient failures are retried, twice', () => {
    expect(shouldRetryApi(0, new ApiError({ kind: 'unavailable' }))).toBe(true)
    expect(shouldRetryApi(2, new ApiError({ kind: 'unavailable' }))).toBe(false)
    expect(shouldRetryApi(0, new ApiError({ kind: 'storeUnavailable' }))).toBe(false)
    expect(shouldRetryApi(0, new ApiError({ kind: 'denied', httpStatus: 403 }))).toBe(false)
    expect(shouldRetryApi(0, new Error('other'))).toBe(false)
  })
})

describe('announcement display rules', () => {
  test('the home block puts pinned first, then important, each keeping the server order', () => {
    const items = [
      summary('a'),
      summary('b', { category: 'important' }),
      summary('c', { pinned: true }),
      summary('d'),
      summary('e', { category: 'important' }),
      summary('f', { pinned: true, category: 'important' }),
    ]
    expect(homeOrder(items).map((item) => item.id)).toEqual(['c', 'f', 'b', 'e', 'a', 'd'])
  })

  test('reading one marks it in cached lists and drops the unread count once, only for a published unread item', () => {
    const page = { items: [summary('a'), summary('b', { read: true }), summary('c', { state: 'scheduled' })], nextCursor: '', unreadCount: 2 }
    const read = applyRead(page, 'a')
    expect(read.items[0].read).toBe(true)
    expect(read.unreadCount).toBe(1)
    expect(applyRead(read, 'a')).toBe(read)
    expect(applyRead(page, 'b')).toBe(page)
    expect(applyRead(page, 'c').unreadCount).toBe(2)
    expect(applyRead(page, 'missing')).toBe(page)
  })

  test('read-all marks every published item and clears the count', () => {
    const page = { items: [summary('a'), summary('c', { state: 'scheduled' })], nextCursor: '', unreadCount: 5 }
    expect(applyReadAll(page)).toEqual({ items: [summary('a', { read: true }), summary('c', { state: 'scheduled' })], nextCursor: '', unreadCount: 0 })
  })
})
