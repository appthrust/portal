import { LauncherResponse } from '@appthrust/app-launcher'
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config'
import { parseHome } from '../home'
import { mockConfig, portalRoutes } from './mock-portal'

const get = (path: string) => portalRoutes(new Request(`http://127.0.0.1${path}`))

describe('portal mock server', () => {
  test('GET /config answers the portal-server shape', async () => {
    const response = get('/config')
    expect(response?.status).toBe(200)
    expect(parseConfig(await response?.json())).toEqual(mockConfig)
  })

  test('GET /launcher answers the shared fixture with the project, portal marked as installed', async () => {
    const response = get('/launcher')
    expect(response?.status).toBe(200)
    const body = LauncherResponse.parse(await response?.json())
    expect(body.project).toEqual({ id: 'pj-mock', name: 'app-console-proof' })
    expect(body.entries.map((item) => item.definitionId)).toEqual(expect.arrayContaining(['portal', 'directory', 'knowledge', 'tool-builder', 'builder-console']))
    expect(body.entries.filter((item) => item.current).map((item) => item.definitionId)).toEqual(['portal'])
    expect(body.entries.map((item) => item.phase)).toEqual(expect.arrayContaining(['Degraded', 'Upgrading']))
  })

  test('GET /api/portal/v1/home answers three sections, one ready and one unavailable source', async () => {
    const response = get('/api/portal/v1/home')
    expect(response?.status).toBe(200)
    const home = parseHome(await response?.json())
    expect(home.sections.map((section) => [section.relation, section.group?.name ?? null, section.entries.length])).toEqual([
      ['owner', null, 2],
      ['group', 'Sales', 3],
      ['project', null, 4],
    ])
    const states = home.sections.flatMap((section) => section.entries.map((entry) => entry.state))
    expect(states.filter((state) => state === 'preparing')).toHaveLength(1)
    expect(states.filter((state) => state === 'restricted')).toHaveLength(1)
    expect(home.sources).toEqual([
      { definitionId: 'builder-console', state: 'ready' },
      { definitionId: 'tool-builder', state: 'unavailable' },
    ])
    expect(home.installedApps.map((app) => app.definitionId)).toContain('tool-builder')
  })

  test('GET /api/portal/v1/home?q= keeps entries whose name matches and drops emptied sections', async () => {
    const home = parseHome(await get('/api/portal/v1/home?q=DEAL')?.json())
    expect(home.sections.map((section) => section.entries.map((entry) => entry.id))).toEqual([['deal-pipeline']])
    const none = parseHome(await get('/api/portal/v1/home?q=nothing-like-this')?.json())
    expect(none.sections).toEqual([])
  })

  test('anything else is left to the server 404', () => {
    expect(get('/api/anything')).toBeUndefined()
    expect(portalRoutes(new Request('http://127.0.0.1/config', { method: 'POST' }))).toBeUndefined()
  })

  test('a config missing a field is rejected instead of rendering a broken link', () => {
    expect(() => parseConfig({ projectId: 'pj-x', publicUrl: 'https://home.pj-x.example.test' })).toThrow('dashboardUrl')
  })
})
