import { describe, expect, mock, test } from 'bun:test'
import { YAML } from 'bun'
import { catalogContainsRelease, renderEntry, submitEntry } from './publish-entry'

const template = await Bun.file(new URL('../catalog/entry.yaml', import.meta.url)).text()
const digest = `sha256:${'a'.repeat(64)}`
const nextDigest = `sha256:${'b'.repeat(64)}`

describe('renderEntry', () => {
  test('keeps the seed floor and appends the public app image with the only default', () => {
    const entry = renderEntry(template, '0.2.0', digest)
    expect(entry.slug).toBe('portal')
    expect(entry.display).toEqual({ category: 'collaborate', icon: 'home' })
    expect(entry.updatePolicy).toEqual({ default: 'pinned', allowed: ['pinned', 'follow'] })
    expect(entry.publishedAt).toBeNull()
    expect(entry.versions).toHaveLength(2)
    expect(entry.versions[0]).toMatchObject({ name: '0.1.0', stream: '0.1', default: false, served: true })
    expect(entry.versions[0]!.images.web).toStartWith('ghcr.io/appthrust/platform/portal@sha256:')
    expect(entry.versions[1]).toEqual({ name: '0.2.0', images: { web: `ghcr.io/appthrust/portal@${digest}` }, stream: '0.2', default: true, served: true })
    const definition = YAML.parse(entry.definitionYAML) as { spec: { versions: unknown; releaseIdentityEnvPrefix: string } }
    expect(definition.spec.versions).toEqual(entry.versions)
    expect(definition.spec.releaseIdentityEnvPrefix).toBe('PORTAL')
  })

  test('merges persisted history on subsequent tags without mutating it', () => {
    const previous = renderEntry(template, '0.2.0', digest)
    previous.publishedAt = '2026-11-06T00:00:00Z'
    const entry = renderEntry(template, '0.2.1', nextDigest, previous)
    expect(entry.versions.map(version => version.name)).toEqual(['0.1.0', '0.2.0', '0.2.1'])
    expect(entry.versions.filter(version => version.default).map(version => version.name)).toEqual(['0.2.1'])
    expect(entry.versions.every(version => version.served)).toBe(true)
    expect(entry.versions[1]!.images.web).toBe(`ghcr.io/appthrust/portal@${digest}`)
    expect(entry.publishedAt).toBe(previous.publishedAt)
    expect(previous.versions[1]!.default).toBe(true)
  })

  test('repeating an immutable release does not duplicate it', () => {
    const previous = renderEntry(template, '0.2.0', digest)
    expect(renderEntry(template, '0.2.0', digest, previous)).toEqual(previous)
  })

  test('refuses to replace the floor or an existing image digest', () => {
    expect(() => renderEntry(template, '0.1.0', digest)).toThrow('version 0.1.0 already has different immutable images')
    const previous = renderEntry(template, '0.2.0', digest)
    expect(() => renderEntry(template, '0.2.0', nextDigest, previous)).toThrow('version 0.2.0 already has different immutable images')
  })

  test('rejects malformed release coordinates before publication', () => {
    for (const version of ['v0.2.0', '0.2', '01.2.3', '0.2.0+build', '0.2.0-01']) {
      expect(() => renderEntry(template, version, digest)).toThrow('version must be SemVer')
    }
    for (const invalid of ['latest', `sha256:${'0'.repeat(64)}`, `sha256:${'G'.repeat(64)}`]) {
      expect(() => renderEntry(template, '0.2.0', invalid)).toThrow('digest must be a non-placeholder')
    }
  })
})

test('catalog readback requires the exact slug, version and image digest', () => {
  const entry = renderEntry(template, '0.2.0', digest)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [entry] }, 'portal', '0.2.0', digest)).toBe(true)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [entry] }, 'portal', '0.2.0', nextDigest)).toBe(false)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [entry] }, 'portal', '0.2.1', digest)).toBe(false)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [entry] }, 'intranet-portal', '0.2.0', digest)).toBe(false)
  expect(catalogContainsRelease({ entries: [entry] }, 'portal', '0.2.0', digest)).toBe(false)
})

describe('intranet-portal entry', () => {
  const intranet = Bun.file(new URL('../catalog/intranet-portal/entry.yaml', import.meta.url)).text()

  test('has no floor: its first release is its only version and declares the announcements database', async () => {
    const entry = renderEntry(await intranet, '0.5.0', digest)
    expect(entry.slug).toBe('intranet-portal')
    expect(entry.versions).toEqual([{ name: '0.5.0', images: { web: `ghcr.io/appthrust/portal@${digest}` }, stream: '0.5', default: true, served: true }])
    const definition = YAML.parse(entry.definitionYAML) as { spec: { components: Array<{ id: string }>; connections: unknown; publish: { hostnameLabel: string } } }
    expect(definition.spec.components.map(component => component.id)).toEqual(['web', 'database'])
    expect(definition.spec.connections).toEqual([{ from: 'web', name: 'database', to: 'database' }])
    expect(definition.spec.publish.hostnameLabel).toBe('portal')
  })

  test('is stored under its own slug and never merges the portal entry', async () => {
    const urls: string[] = []
    const fetcher = mock(async (url: string, init: RequestInit) => {
      urls.push(`${init.method} ${url}`)
      if (url.endsWith('/entries')) return Response.json({ data: [renderEntry(template, '0.2.0', digest)] })
      if (url.endsWith('/entries/intranet-portal')) {
        expect((JSON.parse(init.body as string) as { versions: unknown[] }).versions).toHaveLength(1)
        return Response.json({})
      }
      return Response.json({ id: 'snapshot', state: 'snapshot' })
    })
    await submitEntry(await intranet, '0.5.0', nextDigest, 'https://catalog.example', 'admin-token', fetcher)
    expect(urls).toEqual(['GET https://catalog.example/api/v1/catalog/entries', 'PUT https://catalog.example/api/v1/catalog/entries/intranet-portal', 'POST https://catalog.example/api/v1/catalog/publish'])
  })

  test('a template with another name is rejected', () => {
    expect(() => renderEntry(template.replace('name: portal', 'name: contacts'), '0.2.0', digest)).toThrow('template must be an ApplicationStackDefinition named portal or intranet-portal')
  })
})

describe('submitEntry', () => {
  for (const [status, state] of [[202, 'queued'], [200, 'snapshot']] as const) {
    test(`returns the ${state} snapshot without polling when publication returns ${status}`, async () => {
      const fetcher = mock(async (url: string, init: RequestInit) => {
        expect(init.headers).toEqual({ authorization: 'Bearer admin-token', 'content-type': 'application/json' })
        if (url.endsWith('/entries')) {
          expect(init.method).toBe('GET')
          return Response.json({ data: [] })
        }
        if (url.endsWith('/entries/portal')) {
          expect(init.method).toBe('PUT')
          expect(JSON.parse(init.body as string)).toEqual(renderEntry(template, '0.2.0', digest))
          return Response.json({})
        }
        expect(url).toBe('https://catalog.example/api/v1/catalog/publish')
        expect(init.method).toBe('POST')
        return Response.json({ id: 'immutable-snapshot', state }, { status })
      })
      expect(await submitEntry(template, '0.2.0', digest, 'https://catalog.example', 'admin-token', fetcher))
        .toEqual({ id: 'immutable-snapshot', state })
      expect(fetcher).toHaveBeenCalledTimes(3)
    })
  }

  for (const [status, publication] of [
    [200, { id: 'snapshot', state: 'queued' }],
    [202, { id: 'snapshot', state: 'snapshot' }],
    [200, { state: 'snapshot' }],
    [200, { id: 'snapshot\nstate=queued', state: 'snapshot' }],
    [202, { id: 'snapshot', state: 'complete' }],
    [500, { error: 'dispatch failed' }],
  ] as const) {
    test(`rejects invalid publication response ${status} ${JSON.stringify(publication)}`, async () => {
      const fetcher = mock(async (url: string) => {
        if (url.endsWith('/entries')) return Response.json({ data: [] })
        if (url.endsWith('/entries/portal')) return Response.json({})
        return Response.json(publication, { status })
      })
      await expect(submitEntry(template, '0.2.0', digest, 'https://catalog.example', 'admin-token', fetcher))
        .rejects.toThrow(status === 500 ? 'POST /catalog/publish failed (500)' : 'catalog publish response must contain')
      expect(fetcher).toHaveBeenCalledTimes(3)
    })
  }
})
