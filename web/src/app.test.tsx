import { launcherQueryKey, type Entry } from '@appthrust/app-launcher'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { App, PortalPage } from './app'
import { configQuery, type PortalConfig } from './config'
import { mockHome } from './dev/mock-portal'
import { HomeError, homeQueryKey, type HomeResponse, type HomeState } from './home'
import { HomeApps } from './home-apps'
import { I18nProvider } from './i18n'

const config: PortalConfig = {
  projectId: 'pj-test',
  publicUrl: 'https://home.pj-test.example.test',
  dashboardUrl: 'https://dashboard.example.test/dashboard/projects/pj-test/marketplace',
}

const project = { id: 'pj-test', name: 'app-console-proof' }

const entry = (definitionId: string, name: string, overrides: Partial<Entry> = {}): Entry => ({
  definitionId,
  name,
  description: `${name} description`,
  icon: definitionId,
  url: `https://${definitionId}.pj-test.example.test`,
  phase: 'Ready',
  current: false,
  ...overrides,
})

function render(seed: (client: QueryClient) => void, node = <PortalPage config={config} />, language: 'ja' | 'en' = 'ja') {
  const client = new QueryClient()
  seed(client)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider language={language}>{node}</I18nProvider>
    </QueryClientProvider>
  )
}

describe('portal page', () => {
  test('lists every other installed app as a card and leaves the portal itself out', () => {
    const html = render((client) =>
      client.setQueryData(launcherQueryKey, {
        project,
        entries: [
          entry('portal', 'Portal', { current: true }),
          entry('directory', 'Directory', { dependencyOf: 'builder-console' }),
          entry('knowledge', 'Knowledge'),
        ],
      })
    )
    expect(html).toContain('<h1')
    expect(html).toContain('ホーム')
    expect(html).toContain('href="https://directory.pj-test.example.test"')
    expect(html).toContain('href="https://knowledge.pj-test.example.test"')
    expect(html).not.toContain('href="https://portal.pj-test.example.test"')
  })

  test('the header and subtitle name the Project by its display name, with the id only in title', () => {
    const html = render((client) => client.setQueryData(launcherQueryKey, { project, entries: [] }))
    expect(html).toMatch(/data-portal-project="" title="pj-test"[^>]*>.*app-console-proof<\/span>/)
    expect(html).toContain('app-console-proof にインストール済みのアプリ')
    expect(html.replaceAll('title="pj-test"', '')).not.toContain('pj-test<')
    const en = render((client) => client.setQueryData(launcherQueryKey, { project, entries: [] }), <PortalPage config={config} />, 'en')
    expect(en).toContain('Apps installed in app-console-proof')
  })

  test('a Project without a display name falls back to its id', () => {
    const html = render((client) => client.setQueryData(launcherQueryKey, { project: { id: 'pj-test', name: '' }, entries: [] }))
    expect(html).toMatch(/data-portal-project="" title="pj-test"[^>]*>.*pj-test<\/span>/)
    expect(html).toContain('pj-test にインストール済みのアプリ')
  })

  test('while /launcher is loading the header shows no project and the subtitle stays generic', () => {
    const html = render(() => {})
    expect(html).not.toContain('data-portal-project')
    // The id appears only inside the Marketplace URL, never as visible text.
    expect(html).not.toContain('pj-test<')
    expect(html).not.toContain('title="pj-test"')
    expect(html).toContain('このプロジェクトにインストール済みのアプリ')
  })

  test('catalog names and descriptions are translated in ja and not in en', () => {
    const seed = (client: QueryClient) =>
      client.setQueryData(launcherQueryKey, {
        project,
        entries: [
          entry('portal', 'Home', { current: true }),
          entry('tool-builder', 'Internal Tool Builder', { description: 'Tables, forms and dashboards on the data in this Project.' }),
        ],
      })
    const ja = render(seed)
    expect(ja).toContain('社内ツールビルダー')
    expect(ja).toContain('この Project のデータを使ったテーブル、フォーム、ダッシュボード。')
    const en = render(seed, <PortalPage config={config} />, 'en')
    expect(en).toContain('Internal Tool Builder')
    expect(en).toContain('Tables, forms and dashboards on the data in this Project.')
    expect(en).not.toContain('社内ツールビルダー')
  })

  test('the empty grid links to the Marketplace named by /config, not a built URL', () => {
    const html = render((client) => client.setQueryData(launcherQueryKey, { project, entries: [] }))
    // One link in the page heading, one in the grid's empty state.
    expect(html.split(`href="${config.dashboardUrl}"`).length - 1).toBe(2)
  })

  test('the app renders the page once /config is known and a loading line before', () => {
    const loading = render(() => {}, <App />)
    expect(loading).toContain('role="status"')
    expect(loading).not.toContain(config.dashboardUrl)
    expect(loading).not.toContain('data-portal-project')
    const ready = render((client) => {
      client.setQueryData(configQuery.queryKey, config)
      client.setQueryData(launcherQueryKey, { project, entries: [] })
    }, <App />)
    expect(ready).toContain('app-console-proof')
    expect(ready).toContain(`href="${config.dashboardUrl}"`)
  })
})

const seedHome = (home: HomeResponse) => (client: QueryClient) => {
  client.setQueryData(launcherQueryKey, { project, entries: home.installedApps })
  client.setQueryData(homeQueryKey(''), home)
}

function renderApps(state: HomeState, search = '', language: 'ja' | 'en' = 'ja') {
  return render(() => {}, <HomeApps state={state} stale={false} search={search} onRetry={() => {}} />, language)
}

describe('portal home apps', () => {
  test('one search box sits above the installed app grid, labelled and capped at the server limit', () => {
    const html = render(seedHome(mockHome()))
    expect(html).toMatch(/<div role="search"[^>]*>.*<label for="([^"]+)"[^>]*>アプリを検索<\/label>.*<input id="\1" type="search"[^>]*maxLength="128"/)
    expect(html.indexOf('role="search"')).toBeLessThan(html.indexOf('data-launcher-entry='))
    expect(html.indexOf('data-launcher-entry=')).toBeLessThan(html.indexOf('data-portal-section='))
  })

  test('the page reads the plain home under the blank-search key and renders its sections in server order', () => {
    const html = render(seedHome(mockHome()))
    expect(html.match(/data-portal-section="(\w+)"/g)).toEqual([
      'data-portal-section="owner"',
      'data-portal-section="group"',
      'data-portal-section="project"',
    ])
    const owner = html.indexOf('>自分のアプリ</h2>')
    const group = html.indexOf('>Sales のアプリ</h2>')
    const company = html.indexOf('>社内のアプリ</h2>')
    expect(owner).toBeGreaterThan(-1)
    expect(owner).toBeLessThan(group)
    expect(group).toBeLessThan(company)
    // The group path is a muted subtitle under its heading.
    expect(html).toMatch(/>Sales のアプリ<\/h2><p title="Acme\/Sales"[^>]*>Acme\/Sales<\/p>/)
    const en = render(seedHome(mockHome()), <PortalPage config={config} />, 'en')
    expect(en).toContain('>My apps</h2>')
    expect(en).toContain('>Sales apps</h2>')
    expect(en).toContain('>Company apps</h2>')
  })

  test('a section with no entries is not rendered', () => {
    const home = mockHome()
    home.sections = home.sections.map((section) => (section.relation === 'group' ? { ...section, entries: [] } : section))
    const html = renderApps({ status: 'ready', home })
    expect(html).not.toContain('data-portal-section="group"')
    expect(html).not.toContain('Sales のアプリ')
    expect(html).toContain('自分のアプリ')
  })

  test('ready opens the app in a new tab, preparing is muted and inert, restricted only links to details', () => {
    const html = renderApps({ status: 'ready', home: mockHome() })
    expect(html).toMatch(
      /<a href="https:\/\/expense\.pj-mock\.appthrust\.ink" target="_blank" rel="noreferrer noopener" data-portal-entry="expense" data-portal-entry-state="ready"[^>]*>.*?開く<svg[^>]*>.*?<\/svg><span class="sr-only">（新しいタブで開きます）<\/span>.*?<\/a><\/li>/
    )
    const preparing = html.match(/<div aria-disabled="true" data-portal-entry="travel" data-portal-entry-state="preparing"[^>]*>.*?<\/div><\/li>/)?.[0] ?? ''
    expect(preparing).toContain('opacity-60')
    expect(preparing).toContain('data-portal-badge="preparing"')
    expect(preparing).toContain('準備中')
    expect(preparing).not.toContain('<a ')
    const restricted = html.match(/<div data-portal-entry="sales-dashboard" data-portal-entry-state="restricted"[^>]*>.*?<\/div><\/li>/)?.[0] ?? ''
    expect(restricted).toContain('申請が必要')
    expect(restricted.match(/<a /g)).toHaveLength(1)
    expect(restricted).toMatch(/<a href="https:\/\/console\.pj-mock\.appthrust\.ink\/apps\/sales-dashboard" target="_blank" rel="noreferrer noopener"[^>]*>詳しく見る/)
    expect(restricted).not.toContain('開く')
  })

  test('cards show tags as chips and fall back to the default icon for an unknown key', () => {
    const html = renderApps({ status: 'ready', home: mockHome() })
    const quote = html.match(/data-portal-entry="quote-maker".*?<\/a><\/li>/)?.[0] ?? ''
    expect(quote).toContain('lucide-puzzle')
    expect(quote).toMatch(/<ul aria-label="タグ"[^>]*><li[^>]*>CRM<\/li><li[^>]*>Documents<\/li><\/ul>/)
    expect(quote).toContain('line-clamp-2')
  })

  test('an unavailable provider gets one quiet line named after its app; absent says nothing', () => {
    const home = mockHome()
    home.sources = [...home.sources, { definitionId: 'knowledge', state: 'absent' }, { definitionId: 'not-installed', state: 'unavailable' }]
    const ja = renderApps({ status: 'ready', home })
    expect(ja).toContain('アプリ一覧を取得できませんでした（社内ツールビルダー）')
    expect(ja).toContain('アプリ一覧を取得できませんでした（not-installed）')
    expect(ja).not.toContain('data-portal-source-unavailable="knowledge"')
    expect(ja).not.toContain('data-portal-source-unavailable="builder-console"')
    // The sections that did arrive still render, after the notices.
    expect(ja.indexOf('data-portal-source-unavailable=')).toBeLessThan(ja.indexOf('data-portal-section='))
    expect(renderApps({ status: 'ready', home }, '', 'en')).toContain("Couldn&#x27;t load apps from Internal Tool Builder")
  })

  test('no sections with every provider ready is one empty line, worded for a search when there is one', () => {
    const home: HomeResponse = { ...mockHome(), sections: [], sources: [{ definitionId: 'builder-console', state: 'ready' }] }
    expect(renderApps({ status: 'ready', home })).toContain('まだアプリが登録されていません')
    expect(renderApps({ status: 'ready', home }, 'deal')).toContain('見つかりません')
    expect(renderApps({ status: 'ready', home }, 'deal', 'en')).toContain('No matches')
    expect(renderApps({ status: 'ready', home: { ...home, sources: [] } }, '', 'en')).toContain('No apps registered yet')
    // A provider that is down is not "nothing registered".
    const down: HomeResponse = { ...home, sources: [{ definitionId: 'builder-console', state: 'unavailable' }] }
    expect(renderApps({ status: 'ready', home: down })).not.toContain('data-portal-apps-empty')
  })

  test('loading, denied and unavailable homes mirror the launcher states', () => {
    expect(renderApps({ status: 'loading' })).toContain('role="status"')
    const denied = renderApps(new HomeError({ status: 'denied', httpStatus: 403 }).state)
    expect(denied).toContain('role="alert"')
    expect(denied).toContain('このアカウントではこのプロジェクトのアプリを一覧できません。')
    const unavailable = renderApps({ status: 'unavailable' })
    expect(unavailable).toContain('アプリの一覧に一時的につながりません。')
    expect(unavailable).toContain('もう一度読み込む')
  })

  test('no raw entry or group id is visible text', () => {
    const html = renderApps({ status: 'ready', home: mockHome() })
    expect(html).not.toContain('>grp-sales<')
    expect(html).not.toContain('>expense<')
    expect(html).not.toContain('>builder-console<')
  })
})
