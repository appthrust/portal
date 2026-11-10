import { LauncherResponse } from '@appthrust/app-launcher'
import { describe, expect, test } from 'bun:test'
import { parseAnnouncement, parseMe, parsePage } from '../announcements'
import { parseConfig } from '../config'
import { parseHome } from '../home'
import { createPortalMock, excerptOf, mockConfig, mockMember, mockPoster, type MockOptions } from './mock-portal'

const NOW = new Date('2026-11-10T01:00:00Z')

function client(options: MockOptions = {}) {
  const routes = createPortalMock({ now: () => NOW, ...options })
  const call = (method: string, path: string, body?: unknown) =>
    routes(
      new Request(`http://127.0.0.1${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
      })
    )
  return {
    call,
    get: (path: string) => call('GET', path),
    page: async (path = '/api/portal/v1/announcements') => parsePage(await (await call('GET', path))?.json()),
  }
}

describe('portal mock server: home', () => {
  test('GET /config answers the cmd/server shape', async () => {
    const response = await client().get('/config')
    expect(response?.status).toBe(200)
    expect(parseConfig(await response?.json())).toEqual(mockConfig)
  })

  test('GET /launcher answers the shared fixture with the project, portal marked as installed', async () => {
    const response = await client().get('/launcher')
    expect(response?.status).toBe(200)
    const body = LauncherResponse.parse(await response?.json())
    expect(body.project).toEqual({ id: 'pj-mock', name: 'app-console-proof' })
    expect(body.entries.filter((item) => item.current).map((item) => item.definitionId)).toEqual(['portal'])
    expect(body.entries.map((item) => item.phase)).toEqual(expect.arrayContaining(['Degraded', 'Upgrading']))
  })

  test('GET /api/portal/v1/home answers three sections, one ready and one unavailable source, and localized installed apps', async () => {
    const home = parseHome(await (await client().get('/api/portal/v1/home'))?.json())
    expect(home.sections.map((section) => [section.relation, section.group?.name ?? null, section.entries.length])).toEqual([
      ['owner', null, 2],
      ['group', 'Sales', 3],
      ['project', null, 4],
    ])
    expect(home.sources).toEqual([
      { definitionId: 'builder-console', state: 'ready' },
      { definitionId: 'tool-builder', state: 'unavailable' },
    ])
    expect(home.installedApps.filter((app) => app.locales).length).toBeGreaterThan(0)
    expect(home.installedApps.filter((app) => !app.locales).length).toBeGreaterThan(0)
  })

  test('GET /api/portal/v1/home?q= keeps entries whose name matches and drops emptied sections', async () => {
    const home = parseHome(await (await client().get('/api/portal/v1/home?q=DEAL'))?.json())
    expect(home.sections.map((section) => section.entries.map((entry) => entry.id))).toEqual([['deal-pipeline']])
  })

  test('anything else is left to the server 404', async () => {
    expect(await client().get('/api/anything')).toBeUndefined()
    expect(await client().call('POST', '/config')).toBeUndefined()
  })
})

describe('portal mock server: announcements', () => {
  test('GET /me names the viewer and whether they can post', async () => {
    expect(parseMe(await (await client().get('/api/portal/v1/me'))?.json())).toEqual(mockPoster)
    expect(parseMe(await (await client({ role: 'viewer' }).get('/api/portal/v1/me'))?.json())).toEqual(mockMember)
  })

  test('the published list is pinned first, then newest first, with an unread count over every published one', async () => {
    const page = await client({ role: 'viewer' }).page()
    expect(page.items.every((item) => item.state === 'published')).toBe(true)
    expect(page.items[0].pinned).toBe(true)
    const rest = page.items.slice(1).map((item) => Date.parse(item.publishedAt))
    expect(rest).toEqual([...rest].sort((a, b) => b - a))
    expect(page.items.some((item) => item.category === 'important')).toBe(true)
    expect(page.unreadCount).toBe(page.items.filter((item) => !item.read).length)
    expect(page.nextCursor).toBe('')
  })

  test('posters list scope=all with scheduled and expired ones; members get 403', async () => {
    const all = await client().page('/api/portal/v1/announcements?scope=all')
    expect(new Set(all.items.map((item) => item.state))).toEqual(new Set(['published', 'scheduled', 'expired']))
    expect((await client({ role: 'viewer' }).get('/api/portal/v1/announcements?scope=all'))?.status).toBe(403)
  })

  test('limit and cursor page through the list; bad parameters are invalid', async () => {
    const mock = client()
    const first = await mock.page('/api/portal/v1/announcements?scope=all&limit=4')
    expect(first.items).toHaveLength(4)
    const second = await mock.page(`/api/portal/v1/announcements?scope=all&limit=4&cursor=${first.nextCursor}`)
    expect(second.items[0].id).not.toBe(first.items[0].id)
    expect((await mock.get('/api/portal/v1/announcements?limit=51'))?.status).toBe(400)
  })

  test('opening marks read and lowers the unread count; read-all clears it', async () => {
    const mock = client({ role: 'viewer' })
    const before = await mock.page()
    const unread = before.items.find((item) => !item.read)
    if (!unread) throw new Error('the seed has unread announcements')
    expect((await mock.call('PUT', `/api/portal/v1/announcements/${unread.id}/read`))?.status).toBe(204)
    expect((await mock.page()).unreadCount).toBe(before.unreadCount - 1)
    expect((await mock.call('POST', '/api/portal/v1/announcements/read-all'))?.status).toBe(204)
    expect((await mock.page()).unreadCount).toBe(0)
  })

  test('members cannot see, read or write anything but published ones', async () => {
    const all = await client().page('/api/portal/v1/announcements?scope=all')
    const scheduled = all.items.find((item) => item.state === 'scheduled')
    if (!scheduled) throw new Error('the seed has a scheduled announcement')
    const member = client({ role: 'viewer' })
    expect((await member.get(`/api/portal/v1/announcements/${scheduled.id}`))?.status).toBe(404)
    expect((await member.call('PUT', `/api/portal/v1/announcements/${scheduled.id}/read`))?.status).toBe(404)
    expect((await member.call('POST', '/api/portal/v1/announcements', { title: 'x', body: '' }))?.status).toBe(403)
    expect((await member.call('DELETE', `/api/portal/v1/announcements/${scheduled.id}`))?.status).toBe(403)
  })

  test('posters create, edit and delete; invariants and unknown fields are rejected as invalid', async () => {
    const mock = client()
    const created = await mock.call('POST', '/api/portal/v1/announcements', { title: '  全社会議  ', body: '## 日時\n\n12月5日' })
    expect(created?.status).toBe(201)
    const announcement = parseAnnouncement(await created?.json())
    expect(announcement).toMatchObject({ title: '全社会議', category: 'info', pinned: false, state: 'published', expiresAt: null, excerpt: '日時 12月5日' })
    expect(announcement.publishedAt).toBe(NOW.toISOString())

    const patched = await mock.call('PATCH', `/api/portal/v1/announcements/${announcement.id}`, { pinned: true, expiresAt: '2026-12-01T00:00:00Z' })
    expect(parseAnnouncement(await patched?.json())).toMatchObject({ pinned: true, expiresAt: '2026-12-01T00:00:00.000Z' })
    const cleared = await mock.call('PATCH', `/api/portal/v1/announcements/${announcement.id}`, { expiresAt: null })
    expect(parseAnnouncement(await cleared?.json()).expiresAt).toBeNull()

    for (const body of [{ title: ' ', body: '' }, { title: 'あ'.repeat(121), body: '' }, { title: 'x', body: 'あ'.repeat(7000) }, { title: 'x', body: '', category: 'urgent' }]) {
      expect((await mock.call('POST', '/api/portal/v1/announcements', body))?.status).toBe(400)
    }
    const backwards = { title: 'x', body: '', publishedAt: '2026-11-12T00:00:00Z', expiresAt: '2026-11-11T00:00:00Z' }
    expect((await mock.call('POST', '/api/portal/v1/announcements', backwards))?.status).toBe(400)
    const unknown = await mock.call('PATCH', `/api/portal/v1/announcements/${announcement.id}`, { color: 'red' })
    expect(unknown?.status).toBe(400)
    expect(await unknown?.json()).toEqual({ error: 'invalid', message: 'Request body contains invalid or unknown fields' })

    expect((await mock.call('DELETE', `/api/portal/v1/announcements/${announcement.id}`))?.status).toBe(204)
    expect((await mock.get(`/api/portal/v1/announcements/${announcement.id}`))?.status).toBe(404)
  })

  test('without its store every announcement route and /me answers 503 portal_store_unavailable; the home keeps working', async () => {
    const mock = client({ store: 'down' })
    for (const [method, path] of [
      ['GET', '/api/portal/v1/me'],
      ['GET', '/api/portal/v1/announcements'],
      ['POST', '/api/portal/v1/announcements/read-all'],
      ['GET', '/api/portal/v1/announcements/01A'],
    ]) {
      const response = await mock.call(method, path)
      expect(response?.status).toBe(503)
      expect(await response?.json()).toMatchObject({ error: 'portal_store_unavailable' })
    }
    expect((await mock.get('/api/portal/v1/home'))?.status).toBe(200)
  })

  test('the excerpt is plain text without Markdown syntax, at most 160 characters', () => {
    expect(excerptOf('# 見出し\n\n- **太字** と [リンク](https://x.example)\n\n| a |\n| --- |')).toBe('見出し 太字 と リンク a')
    expect([...excerptOf('あ'.repeat(200))]).toHaveLength(160)
  })
})
