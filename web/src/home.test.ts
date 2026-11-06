import { describe, expect, jest, test } from 'bun:test'
import { mockHome, mockHomeBody } from './dev/mock-portal'
import {
  HomeError,
  SEARCH_DEBOUNCE_MS,
  createDebouncer,
  fetchHome,
  homePath,
  homeQueryKey,
  homeRetryLimit,
  homeStateOf,
  parseHome,
  shouldRetryHome,
  type HomeFetch,
  type HomeState,
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
