import { describe, expect, jest, test } from 'bun:test'
import { mockHome, mockHomeBody } from './dev/mock-portal'
import {
  HomeError,
  SEARCH_DEBOUNCE_MS,
  createDebouncer,
  fetchHome,
  groupInstalledApps,
  homePath,
  homeQueryKey,
  homeRetryLimit,
  homeStateOf,
  installedAppText,
  isNavigable,
  matchesInstalledApp,
  parseHome,
  shouldRetryHome,
  tileApps,
  type AppGroupId,
  type HomeFetch,
  type HomeState,
  type InstalledApp,
} from './home'

async function stateFor(fetchImpl: HomeFetch, q = ''): Promise<HomeState> {
  try {
    return homeStateOf(await fetchHome(fetchImpl, q), null)
  } catch (error) {
    return homeStateOf(undefined, error)
  }
}

const respond = (status: number, body: unknown = { error: 'x', message: 'x' }): HomeFetch => async () => Response.json(body, { status })

describe('home request', () => {
  test('a blank search asks for the plain home; a search sends q, trimmed and encoded', () => {
    expect(homePath('')).toBe('/api/portal/v1/home')
    expect(homePath('   ')).toBe('/api/portal/v1/home')
    expect(homePath(' 経費 & co ')).toBe('/api/portal/v1/home?q=%E7%B5%8C%E8%B2%BB+%26+co')
  })

  test('the query key is one entry per search as sent', () => {
    expect(homeQueryKey('')).toEqual(['portal', 'home', ''])
    expect(homeQueryKey(' deal ')).toEqual(['portal', 'home', 'deal'])
  })

  test('fetchHome is a same-origin, uncached GET of the path for q', async () => {
    const seen: Array<{ input: string; init?: RequestInit }> = []
    const state = await stateFor(async (input, init) => {
      seen.push({ input, init })
      return Response.json(mockHomeBody('deal'))
    }, 'deal')
    expect(state.status).toBe('ready')
    expect(seen).toHaveLength(1)
    expect(seen[0].input).toBe('/api/portal/v1/home?q=deal')
    expect(seen[0].init?.credentials).toBe('same-origin')
    expect(seen[0].init?.cache).toBe('no-store')
  })
})

describe('home state', () => {
  test('401 and 403 are denied with their status', async () => {
    expect(await stateFor(respond(401))).toEqual({ status: 'denied', httpStatus: 401 })
    expect(await stateFor(respond(403))).toEqual({ status: 'denied', httpStatus: 403 })
  })

  test('503, other failures, network errors and invalid bodies are unavailable', async () => {
    expect(await stateFor(respond(503))).toEqual({ status: 'unavailable' })
    expect(await stateFor(respond(400))).toEqual({ status: 'unavailable' })
    expect(await stateFor(respond(200, { ...mockHomeBody(), sections: [{ relation: 'team', group: null, entries: [] }] }))).toEqual({
      status: 'unavailable',
    })
    expect(await stateFor(async () => new Response('<html>', { status: 200 }))).toEqual({ status: 'unavailable' })
    expect(
      await stateFor(async () => {
        throw new TypeError('network down')
      })
    ).toEqual({ status: 'unavailable' })
  })

  test('the latest failure wins over older data; nothing yet is loading', () => {
    expect(homeStateOf(undefined, null)).toEqual({ status: 'loading' })
    expect(homeStateOf(mockHome(), new Error('boom'))).toEqual({ status: 'unavailable' })
  })

  test('unavailable retries like /launcher; denied never retries', () => {
    const unavailable = new HomeError({ status: 'unavailable' })
    expect(shouldRetryHome(0, unavailable)).toBe(true)
    expect(shouldRetryHome(homeRetryLimit - 1, unavailable)).toBe(true)
    expect(shouldRetryHome(homeRetryLimit, unavailable)).toBe(false)
    expect(shouldRetryHome(0, new HomeError({ status: 'denied', httpStatus: 401 }))).toBe(false)
  })

  test('Go nil slices and omitted optional fields parse as empty / absent', () => {
    const home = parseHome({
      project: { id: 'pj-x', name: '' },
      builtinApps: null,
      sources: null,
      sections: [
        {
          relation: 'project',
          group: null,
          entries: [{ id: 'a', name: 'A', description: '', icon: '', state: 'preparing', relation: 'project', tags: null, sourceDefinitionId: 'c' }],
        },
      ],
    })
    expect(home.installedApps).toEqual([])
    expect(home.sources).toEqual([])
    expect(home.sections[0].entries[0]).toEqual({
      id: 'a',
      name: 'A',
      description: '',
      icon: '',
      state: 'preparing',
      relation: 'project',
      tags: [],
      sourceDefinitionId: 'c',
    })
  })
})

const installed = (definitionId: string, overrides: Partial<InstalledApp> = {}): InstalledApp => ({
  definitionId,
  name: 'Directory',
  description: 'People, groups and profiles of this organisation.',
  icon: 'directory',
  url: `https://${definitionId}.pj-x.example.test`,
  phase: 'Ready',
  current: false,
  ...overrides,
})

const wireApp = (extra: Record<string, unknown>) => ({
  project: { id: 'pj-x', name: 'x' },
  builtinApps: [{ ...installed('directory'), ...extra }],
  sections: [],
  sources: [],
})

describe('installed app locales', () => {
  test('the home parser keeps the catalog locales of each installed app', () => {
    const home = parseHome(
      wireApp({ locales: { ja: { title: 'ディレクトリ', tagline: 'この組織のメンバー。' }, en: { title: 'Directory' }, fr: {} } })
    )
    expect(home.installedApps[0].locales).toEqual({ ja: { title: 'ディレクトリ', tagline: 'この組織のメンバー。' }, en: { title: 'Directory' }, fr: {} })
    expect(home.installedApps[0].definitionId).toBe('directory')
  })

  test('absent or null locales parse as no locales; blank fields count as not localized', () => {
    expect(parseHome(wireApp({})).installedApps[0]).not.toHaveProperty('locales')
    expect(parseHome(wireApp({ locales: null })).installedApps[0]).not.toHaveProperty('locales')
    expect(parseHome(wireApp({ locales: { ja: { title: '  ', tagline: null } } })).installedApps[0].locales).toEqual({ ja: {} })
  })

  test('a locales shape the page cannot trust makes the home unavailable', async () => {
    for (const locales of [[], 'ja', { ja: 'ディレクトリ' }, { ja: { title: 1 } }]) {
      expect(() => parseHome(wireApp({ locales }))).toThrow()
      expect(await stateFor(async () => Response.json(wireApp({ locales })))).toEqual({ status: 'unavailable' })
    }
  })

  test('tile text is the localized title and tagline, each falling back on its own to name and description', () => {
    const app = installed('directory', { locales: { ja: { title: 'ディレクトリ' }, en: { tagline: 'Everyone in the company.' } } })
    expect(installedAppText(app, 'ja')).toEqual({ title: 'ディレクトリ', tagline: 'People, groups and profiles of this organisation.' })
    expect(installedAppText(app, 'en')).toEqual({ title: 'Directory', tagline: 'Everyone in the company.' })
    expect(installedAppText(installed('memo', { name: 'Memo', description: 'Notes.' }), 'ja')).toEqual({ title: 'Memo', tagline: 'Notes.' })
  })

  test('tiles leave out the current app (the portal) and keep server order', () => {
    const apps = [installed('b'), installed('portal', { current: true }), installed('a')]
    expect(tileApps(apps).map((app) => app.definitionId)).toEqual(['b', 'a'])
  })

  test('only an app being removed cannot be opened', () => {
    const phases: InstalledApp['phase'][] = ['Pending', 'Installing', 'Ready', 'Upgrading', 'Degraded']
    for (const phase of phases) expect(isNavigable(installed('x', { phase }))).toBe(true)
    expect(isNavigable(installed('x', { phase: 'Uninstalling' }))).toBe(false)
  })

  test('a Pending app or a phase Portal does not know parses as Pending instead of failing the home', () => {
    expect(parseHome(wireApp({ phase: 'Pending' })).installedApps[0].phase).toBe('Pending')
    expect(parseHome(wireApp({ phase: 'UpdateAvailable' })).installedApps[0].phase).toBe('Ready')
    expect(parseHome(wireApp({ phase: 'NeedsConfiguration' })).installedApps[0].phase).toBe('Degraded')
    expect(parseHome(wireApp({ phase: 'Migrating' })).installedApps[0].phase).toBe('Ready')
    expect(parseHome(wireApp({ phase: 'Degraded', dependencyOf: 'builder-console' })).installedApps[0]).toMatchObject({ phase: 'Degraded', dependencyOf: 'builder-console' })
  })

  test('an installed app missing a required field still makes the home unavailable', () => {
    for (const broken of [{ phase: 1 }, { current: 'no' }, { url: undefined }, { name: null }]) {
      expect(() => parseHome(wireApp(broken))).toThrow()
    }
  })

  test('search matches the shown title or tagline, or the catalog name, case-insensitively', () => {
    const app = installed('directory', { locales: { ja: { title: 'ディレクトリ', tagline: '社員名簿とグループ' } } })
    expect(matchesInstalledApp(app, '  ', 'ja')).toBe(true)
    expect(matchesInstalledApp(app, 'ディレクトリ', 'ja')).toBe(true)
    expect(matchesInstalledApp(app, '名簿', 'ja')).toBe(true)
    expect(matchesInstalledApp(app, 'DIRECTORY', 'ja')).toBe(true)
    // The English description is not what a Japanese viewer sees, so it does not match.
    expect(matchesInstalledApp(app, 'profiles', 'ja')).toBe(false)
    expect(matchesInstalledApp(app, 'profiles', 'en')).toBe(true)
  })

  test('the mock home serves apps with and without locales', () => {
    const apps = parseHome(mockHomeBody()).installedApps
    expect(apps.find((app) => app.definitionId === 'directory')?.locales?.ja?.title).toBe('ディレクトリ')
    expect(apps.find((app) => app.definitionId === 'knowledge')?.locales).toEqual({ ja: { tagline: expect.any(String) } })
    expect(apps.find((app) => app.definitionId === 'memo')).not.toHaveProperty('locales')
    expect(apps.find((app) => app.definitionId === 'llm')?.phase).toBe('Pending')
  })

  test('the mock home seeds every purpose group and one app without a category', () => {
    const apps = tileApps(parseHome(mockHomeBody()).installedApps)
    expect(groupInstalledApps(apps).map((group) => group.id)).toEqual(['everyday', 'ai', 'manage'])
    expect(apps.filter((app) => app.category === undefined).map((app) => app.definitionId)).toEqual(['vision'])
  })
})

describe('app groups', () => {
  test('the parser keeps a catalog category; absent, blank or non-string reads as none', () => {
    expect(parseHome(wireApp({ category: 'collaborate' })).installedApps[0].category).toBe('collaborate')
    for (const category of [undefined, null, '', '  ', 3, { id: 'assist' }]) {
      expect(parseHome(wireApp({ category })).installedApps[0]).not.toHaveProperty('category')
    }
  })

  const ids = (apps: InstalledApp[]) => groupInstalledApps(apps).map((group) => [group.id, group.apps.map((app) => app.definitionId)])

  test('each category lands in its group; any other category or none is build and manage', () => {
    const cases: Array<[string | undefined, AppGroupId]> = [
      ['collaborate', 'everyday'],
      ['assist', 'ai'],
      ['build', 'manage'],
      ['develop', 'manage'],
      ['observe', 'manage'],
      ['toString', 'manage'],
      [undefined, 'manage'],
    ]
    for (const [category, group] of cases) {
      expect(groupInstalledApps([installed('x', { category })])[0].id, String(category)).toBe(group)
    }
  })

  test('groups come in page order with server order inside; empty groups are left out', () => {
    const apps = [
      installed('tool-builder', { category: 'develop' }),
      installed('directory', { category: 'collaborate' }),
      installed('vision'),
      installed('memo', { category: 'collaborate' }),
      installed('llm', { category: 'assist' }),
    ]
    expect(ids(apps)).toEqual([
      ['everyday', ['directory', 'memo']],
      ['ai', ['llm']],
      ['manage', ['tool-builder', 'vision']],
    ])
    expect(ids(apps.filter((app) => app.category !== 'assist')).map(([id]) => id)).toEqual(['everyday', 'manage'])
  })

  test('one group with apps is one group; no apps is no group', () => {
    expect(ids([installed('llm', { category: 'assist' }), installed('knowledge', { category: 'assist' })])).toEqual([['ai', ['llm', 'knowledge']]])
    expect(ids([])).toEqual([])
  })
})

describe('search debounce', () => {
  test('only the last value is applied, once typing pauses for 300 ms', () => {
    jest.useFakeTimers()
    try {
      const applied: string[] = []
      const debouncer = createDebouncer((value: string) => applied.push(value))
      expect(SEARCH_DEBOUNCE_MS).toBe(300)
      debouncer.push('d')
      jest.advanceTimersByTime(200)
      debouncer.push('de')
      jest.advanceTimersByTime(200)
      debouncer.push('deal')
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1)
      expect(applied).toEqual([])
      jest.advanceTimersByTime(1)
      expect(applied).toEqual(['deal'])
    } finally {
      jest.useRealTimers()
    }
  })

  test('cancel drops a pending value', () => {
    jest.useFakeTimers()
    try {
      const applied: string[] = []
      const debouncer = createDebouncer((value: string) => applied.push(value))
      debouncer.push('deal')
      debouncer.cancel()
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
      expect(applied).toEqual([])
    } finally {
      jest.useRealTimers()
    }
  })
})
