import { launcherQueryKey } from '@appthrust/app-launcher'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ApiError,
  announcementKey,
  announcementPagesKey,
  homeAnnouncementsKey,
  meQueryKey,
  type Announcement,
  type AnnouncementPage,
  type AnnouncementSummary,
  type ApiFailure,
  type Me,
} from './announcements'
import { App, PortalPage } from './app'
import { configQuery, type PortalConfig } from './config'
import { mockHome, mockHomeBody, mockMember, mockPoster } from './dev/mock-portal'
import { dayPart } from './format'
import { HomeError, homeQueryKey, parseHome, type HomeResponse, type HomeState, type InstalledApp } from './home'
import { HomeApps } from './home-apps'
import { I18nProvider } from './i18n'
import type { Route } from './router'

const config: PortalConfig = {
  projectId: 'pj-test',
  publicUrl: 'https://home.pj-test.example.test',
  dashboardUrl: 'https://dashboard.example.test/dashboard/projects/pj-test/marketplace',
}

const project = { id: 'pj-test', name: 'app-console-proof' }
const HOME: Route = { name: 'home' }

const installed = (definitionId: string, name: string, overrides: Partial<InstalledApp> = {}): InstalledApp => ({
  definitionId,
  name,
  description: `${name} description`,
  icon: definitionId,
  url: `https://${definitionId}.pj-test.example.test`,
  phase: 'Ready',
  current: false,
  ...overrides,
})

const summary = (id: string, overrides: Partial<AnnouncementSummary> = {}): AnnouncementSummary => ({
  id,
  title: `お知らせ ${id}`,
  excerpt: `${id} の抜粋`,
  category: 'info',
  pinned: false,
  state: 'published',
  publishedAt: '2026-11-09T01:00:00Z',
  expiresAt: null,
  author: { subject: 'user-somu', name: '総務部 田中' },
  createdAt: '2026-11-09T00:00:00Z',
  updatedAt: '2026-11-09T00:00:00Z',
  read: true,
  ...overrides,
})

const page = (items: AnnouncementSummary[], unreadCount = items.filter((item) => !item.read).length): AnnouncementPage => ({ items, nextCursor: '', unreadCount })

type Seed = (client: QueryClient) => void

/** A query that already failed with `failure`, as the page would see it after the request. */
function seedFailure(client: QueryClient, queryKey: QueryKey, failure: ApiFailure) {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({ status: 'error', error: new ApiError(failure), errorUpdatedAt: 1, fetchStatus: 'idle', data: undefined })
}

const seedMe = (me: Me): Seed => (client) => client.setQueryData(meQueryKey, me)
const seedNews = (news: AnnouncementPage): Seed => (client) => client.setQueryData(homeAnnouncementsKey, news)
const seedHome =
  (home: HomeResponse = mockHome()): Seed =>
  (client) => {
    client.setQueryData(launcherQueryKey, { project, entries: home.installedApps })
    client.setQueryData(homeQueryKey(''), home)
  }

function render(seeds: Seed[], node = <PortalPage config={config} route={HOME} />, language: 'ja' | 'en' = 'ja') {
  // Failed queries stay failed while rendering instead of refetching on mount.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } })
  for (const seed of seeds) seed(client)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider language={language}>{node}</I18nProvider>
    </QueryClientProvider>
  )
}

const ready = (me: Me = mockMember, news = page([summary('01A')])) => [seedHome(), seedMe(me), seedNews(news)]

describe('home layout', () => {
  test('top to bottom: greeting with the search box, お知らせ, アプリ, then the provider sections', () => {
    const html = render(ready())
    const order = ['data-portal-greeting=', 'role="search"', 'data-portal-news=', 'data-portal-installed=', 'data-portal-section="owner"']
    const positions = order.map((marker) => html.indexOf(marker))
    expect(positions.every((position) => position > -1)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(html).toMatch(/<div role="search"[^>]*>.*<label for="([^"]+)"[^>]*>アプリを検索<\/label>.*<input id="\1" type="search"[^>]*maxLength="128"/)
  })

  test('the greeting names the viewer from /me and shows today in the viewer language', () => {
    const part = dayPart(new Date())
    const ja = render(ready())
    expect(ja).toContain({ morning: 'おはようございます、山田 太郎さん', day: 'こんにちは、山田 太郎さん', evening: 'こんばんは、山田 太郎さん' }[part])
    expect(ja).toContain(new Intl.DateTimeFormat('ja-JP', { dateStyle: 'full' }).format(new Date()))
    const en = render(ready(), <PortalPage config={config} route={HOME} />, 'en')
    expect(en).toContain({ morning: 'Good morning, 山田 太郎', day: 'Hello, 山田 太郎', evening: 'Good evening, 山田 太郎' }[part])
    expect(en).toContain(new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(new Date()))
  })

  test('without /me the greeting has no name', () => {
    const html = render([seedHome(), (client) => seedFailure(client, meQueryKey, { kind: 'storeUnavailable' })])
    expect(html).toMatch(/data-portal-greeting=""[^>]*>(おはようございます|こんにちは|こんばんは)<\/h1>/)
  })

  test('the header names the Project by its display name, with the id only in title', () => {
    const html = render(ready())
    expect(html).toMatch(/data-portal-project="" title="pj-test"[^>]*>.*app-console-proof<\/span>/)
    expect(html.replaceAll('title="pj-test"', '')).not.toContain('pj-test<')
    expect(html).toContain('<span class="sr-only">プロジェクト: </span>')
  })

  test('while /launcher is loading the header shows no project', () => {
    const html = render([seedMe(mockMember)])
    expect(html).not.toContain('data-portal-project')
    expect(html).not.toContain('title="pj-test"')
  })

  test('the app renders the page once /config is known and a loading line before', () => {
    const loading = render([], <App />)
    expect(loading).toContain('role="status"')
    expect(loading).not.toContain('data-portal-project')
    const shown = render([(client) => client.setQueryData(configQuery.queryKey, config), ...ready()], <App />)
    expect(shown).toContain('app-console-proof')
    expect(shown).toContain('data-portal-news=')
  })

  test('Japanese pages say プロジェクト and carry no English chrome', () => {
    const html = render(ready(mockPoster, page([summary('01A', { read: false })])))
    const visible = html.replace(/<[^>]+>/g, ' ')
    for (const english of ['Project', 'Announcements', 'Manage apps', 'View all', 'Write an announcement', 'unread', 'Mark all as read']) expect(visible).not.toContain(english)
  })
})

describe('installed app tiles', () => {
  const apps = [
    installed('portal', 'Home', { current: true }),
    installed('directory', 'Directory', { locales: { ja: { title: 'ディレクトリ', tagline: '社員名簿とグループ' }, en: { tagline: 'Everyone in the company.' } } }),
    installed('memo', 'Memo', { description: 'Write and share Markdown articles.' }),
    installed('tool-builder', 'Internal Tool Builder', { phase: 'Upgrading', locales: { ja: { title: '社内ツールビルダー' } } }),
    installed('knowledge', 'Knowledge', { phase: 'Uninstalling' }),
  ]
  const withApps = (home: HomeResponse = mockHome()) => seedHome({ ...home, installedApps: apps })

  test('tiles show the localized title and tagline, falling back per field; never the hostname or the portal itself', () => {
    const ja = render([withApps(), seedMe(mockMember), seedNews(page([]))])
    expect(ja).toMatch(/data-portal-app="directory"[^>]*>.*?ディレクトリ<\/span>.*?社員名簿とグループ<\/span>/)
    expect(ja).toMatch(/data-portal-app="memo"[^>]*>.*?Memo<\/span>.*?Write and share Markdown articles\.<\/span>/)
    expect(ja).not.toContain('data-portal-app="portal"')
    expect(ja).not.toContain('directory.pj-test.example.test<')
    const en = render([withApps(), seedMe(mockMember), seedNews(page([]))], <PortalPage config={config} route={HOME} />, 'en')
    expect(en).toMatch(/data-portal-app="directory"[^>]*>.*?Directory<\/span>.*?Everyone in the company\.<\/span>/)
    expect(en).toMatch(/data-portal-app="tool-builder"[^>]*>.*?Internal Tool Builder<\/span>/)
  })

  test('a tile opens its app in place; an app that is not Ready keeps a status badge; one being removed cannot be opened', () => {
    const ja = render([withApps(), seedMe(mockMember), seedNews(page([]))])
    expect(ja).toContain('<a href="https://directory.pj-test.example.test" data-portal-app="directory"')
    expect(ja).toMatch(/<a href="https:\/\/tools?-?[^"]*" data-portal-app="tool-builder"[^>]*>.*?data-portal-phase="Upgrading"[^>]*>更新中</)
    expect(ja).toMatch(/<div aria-disabled="true" data-portal-app="knowledge"[^>]*>.*?data-portal-phase="Uninstalling"[^>]*>削除中</)
    const en = render([withApps(), seedMe(mockMember), seedNews(page([]))], <PortalPage config={config} route={HOME} />, 'en')
    expect(en).toContain('>Updating</span>')
    expect(en).toContain('>Removing</span>')
  })

  test('a home body with a Pending app and with an unknown phase parses and shows the 準備中 / Setting up badge, still openable', () => {
    const wire = {
      ...mockHomeBody(),
      builtinApps: [
        { ...installed('llm', 'LLM Gateway'), phase: 'Pending' },
        { ...installed('vision', 'Vision'), phase: 'Migrating' },
      ],
    }
    const home = parseHome(wire)
    const ja = render([seedHome(home), seedMe(mockMember), seedNews(page([]))])
    for (const id of ['llm', 'vision']) {
      expect(ja).toMatch(new RegExp(`<a href="https://${id}\\.pj-test\\.example\\.test" data-portal-app="${id}"[^>]*>.*?data-portal-phase="Pending"[^>]*>準備中<`))
    }
    const en = render([seedHome(home), seedMe(mockMember), seedNews(page([]))], <PortalPage config={config} route={HOME} />, 'en')
    expect(en.match(/data-portal-phase="Pending"[^>]*>Setting up</g)).toHaveLength(2)
  })

  test('the アプリ block links to the Dashboard named by /config', () => {
    const html = render(ready())
    expect(html).toMatch(new RegExp(`<a href="${config.dashboardUrl}"[^>]*>アプリを管理`))
  })

  test('no other installed app is a quiet line, not an error', () => {
    const html = render([seedHome({ ...mockHome(), installedApps: [apps[0]] }), seedMe(mockMember), seedNews(page([]))])
    expect(html).toContain('インストール済みのアプリはまだありません。')
  })
})

describe('お知らせ block', () => {
  const items = [
    summary('a', { read: false }),
    summary('b'),
    summary('c', { category: 'important', read: false }),
    summary('d', { pinned: true }),
    summary('e', { category: 'event' }),
    summary('f'),
    summary('g'),
  ]

  test('pinned and important first, five rows with category, title, date and an unread mark, then すべて見る', () => {
    const html = render(ready(mockMember, page(items, 9)))
    const rows = [...html.matchAll(/data-portal-announcement="(\w+)"/g)].map((match) => match[1])
    expect(rows).toEqual(['d', 'c', 'a', 'b', 'e'])
    expect(html).toContain('href="/announcements/c"')
    expect(html).toMatch(/data-portal-announcement="c" data-portal-unread=""[^>]*>.*?data-portal-category="important"[^>]*><span class="sr-only">種類: <\/span>重要<\/span>/)
    expect(html).toMatch(/data-portal-announcement="d"[^>]*>.*?data-portal-pinned=""/)
    expect(html).toContain('<span class="sr-only">未読: </span>お知らせ c')
    expect(html).toContain('<time dateTime="2026-11-09T01:00:00Z"')
    expect(html).toMatch(/data-portal-unread-count="9"[^>]*>未読 9件</)
    expect(html).toMatch(/<a data-portal-view-all=""[^>]*href="\/announcements">すべて見る/)
  })

  test('only posters see お知らせを書く; すべて既読にする appears only with something unread', () => {
    const member = render(ready(mockMember, page(items)))
    expect(member).not.toContain('data-portal-write')
    expect(member).toContain('すべて既読にする')
    const poster = render(ready(mockPoster, page([summary('a')])))
    expect(poster).toMatch(/<a data-portal-write=""[^>]*href="\/announcements\/new">.*?お知らせを書く/)
    expect(poster).not.toContain('すべて既読にする')
    expect(poster).not.toContain('data-portal-unread-count')
  })

  test('no announcements is one line, inviting posters to write the first', () => {
    expect(render(ready(mockMember, page([])))).toContain('お知らせはまだありません。')
    expect(render(ready(mockPoster, page([])))).toContain('最初のお知らせを書いて')
  })

  test('without its store the block is one quiet line and the rest of the page still works', () => {
    const html = render([
      seedHome(),
      (client) => seedFailure(client, meQueryKey, { kind: 'storeUnavailable' }),
      (client) => seedFailure(client, homeAnnouncementsKey, { kind: 'storeUnavailable' }),
    ])
    expect(html).toMatch(/<p data-portal-news-store-unavailable=""[^>]*>お知らせはまだ利用できません。準備が整うと、ここに表示されます。<\/p>/)
    expect(html).not.toMatch(/data-portal-news=""[^]*role="alert"[^]*data-portal-installed/)
    expect(html).not.toContain('data-portal-write')
    expect(html).toContain('data-portal-app="directory"')
    expect(html).toContain('data-portal-section="owner"')
  })

  test('denied and network failures follow the home patterns', () => {
    const denied = render([seedHome(), seedMe(mockMember), (client) => seedFailure(client, homeAnnouncementsKey, { kind: 'denied', httpStatus: 403 })])
    expect(denied).toMatch(/<p role="alert"[^>]*>このアカウントではお知らせを表示できません。<\/p>/)
    const down = render([seedHome(), seedMe(mockMember), (client) => seedFailure(client, homeAnnouncementsKey, { kind: 'unavailable' })])
    expect(down).toContain('お知らせに一時的につながりません。')
    expect(down).toMatch(/お知らせに一時的につながりません。<\/span><button[^>]*>もう一度読み込む<\/button>/)
  })
})

describe('announcement pages', () => {
  const all = page([summary('a', { state: 'scheduled', publishedAt: '2026-12-01T00:00:00Z' }), summary('b', { read: false }), summary('c', { state: 'expired' })])

  test('posters list scope=all with every item state labelled', () => {
    const html = render([seedMe(mockPoster), (client) => client.setQueryData(announcementPagesKey('all'), { pages: [all], pageParams: [''] })], <PortalPage config={config} route={{ name: 'announcements' }} />)
    expect(html).toContain('<h1')
    expect(html).toMatch(/data-portal-state="scheduled"[^>]*><span class="sr-only">状態: <\/span>予約</)
    expect(html).toMatch(/data-portal-state="published"[^>]*><span class="sr-only">状態: <\/span>公開中</)
    expect(html).toMatch(/data-portal-state="expired"[^>]*><span class="sr-only">状態: <\/span>終了</)
    expect(html).toContain('予約中と掲載が終わったお知らせも表示しています。')
    expect(html).toContain('a の抜粋')
    expect(html).toContain('投稿者：総務部 田中')
    expect(html).toContain('data-portal-write')
  })

  test('members list published announcements without state labels', () => {
    const html = render(
      [seedMe(mockMember), (client) => client.setQueryData(announcementPagesKey('published'), { pages: [page([summary('b')])], pageParams: [''] })],
      <PortalPage config={config} route={{ name: 'announcements' }} />
    )
    expect(html).toContain('data-portal-announcement="b"')
    expect(html).not.toContain('data-portal-state')
    expect(html).not.toContain('data-portal-write')
  })

  const announcement: Announcement = {
    ...summary('01A', { title: 'ネットワーク機器の入れ替え', category: 'important', pinned: true, expiresAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-09T05:00:00Z' }),
    body: '## 作業日時\n\n11月15日',
  }
  const detail = (me: Me) => render([seedMe(me), (client) => client.setQueryData(announcementKey('01A'), announcement)], <PortalPage config={config} route={{ name: 'announcement', id: '01A' }} />)

  test('one announcement shows category, pinned, title, author and dates; only posters get edit and delete', () => {
    const member = detail(mockMember)
    expect(member).toMatch(/<h1 id="announcement-title"[^>]*>ネットワーク機器の入れ替え<\/h1>/)
    expect(member).toContain('重要')
    expect(member).toContain('data-portal-pinned')
    expect(member).toContain('投稿者：総務部 田中')
    expect(member).toMatch(/<time dateTime="2026-11-09T01:00:00Z">2026年11月9日 [\d:]+ 公開<\/time>/)
    expect(member).toMatch(/<time dateTime="2026-11-09T05:00:00Z">[^<]+ 更新<\/time>/)
    expect(member).toMatch(/<time dateTime="2026-11-20T00:00:00Z">[^<]+ まで掲載<\/time>/)
    expect(member).not.toContain('/edit"')
    expect(member).not.toContain('data-portal-state')
    const poster = detail(mockPoster)
    expect(poster).toContain('href="/announcements/01A/edit"')
    expect(poster).toContain('>削除</button>')
    expect(poster).toContain('data-portal-state="published"')
  })

  test('an announcement the viewer cannot see says so', () => {
    const html = render([seedMe(mockMember), (client) => seedFailure(client, announcementKey('gone'), { kind: 'notFound' })], <PortalPage config={config} route={{ name: 'announcement', id: 'gone' }} />)
    expect(html).toContain('このお知らせは表示できません。')
  })

  test('the editor is for posters: labelled fields for title, category, body, pinned, publish and end time', () => {
    const member = render([seedMe(mockMember)], <PortalPage config={config} route={{ name: 'newAnnouncement' }} />)
    expect(member).toContain('お知らせを投稿できるのは、プロジェクトの管理者と編集者だけです。')
    expect(member).not.toContain('<form')
    const poster = render([seedMe(mockPoster)], <PortalPage config={config} route={{ name: 'newAnnouncement' }} />)
    expect(poster).toMatch(/<label for="([^"]+)"[^>]*>タイトル<\/label>.*<input id="\1" type="text"/)
    expect(poster).toMatch(/<legend[^>]*>種類<\/legend>.*一般.*重要.*イベント/)
    expect(poster).toMatch(/<label for="([^"]+)"[^>]*>本文<\/label>.*<textarea id="\1"/)
    expect(poster).toContain('先頭に固定する')
    expect(poster).toContain('すぐに公開する')
    expect(poster).toMatch(/<label for="([^"]+)"[^>]*>掲載終了日時（任意）<\/label>.*<input id="\1" type="datetime-local"/)
    expect(poster).toMatch(/<button type="submit"[^>]*>公開する<\/button>/)
  })

  test('the editor loads the announcement it edits', () => {
    const html = render(
      [seedMe(mockPoster), (client) => client.setQueryData(announcementKey('01A'), announcement)],
      <PortalPage config={config} route={{ name: 'editAnnouncement', id: '01A' }} />
    )
    expect(html).toContain('お知らせを編集')
    expect(html).toContain('value="ネットワーク機器の入れ替え"')
    expect(html).toContain('## 作業日時')
    expect(html).toMatch(/<button type="submit"[^>]*>保存する<\/button>/)
  })

  test('an unknown path says the page does not exist', () => {
    expect(render([seedMe(mockMember)], <PortalPage config={config} route={{ name: 'notFound' }} />)).toContain('ページが見つかりません')
  })
})

function renderApps(state: HomeState, search = '', language: 'ja' | 'en' = 'ja') {
  return render([], <HomeApps state={state} stale={false} search={search} q={search} dashboardUrl={config.dashboardUrl} onRetry={() => {}} />, language)
}

describe('provider sections', () => {
  test('the sections render in server order, after the アプリ block', () => {
    const html = renderApps({ status: 'ready', home: mockHome() })
    expect(html.match(/data-portal-section="(\w+)"/g)).toEqual([
      'data-portal-section="owner"',
      'data-portal-section="group"',
      'data-portal-section="project"',
    ])
    const owner = html.indexOf('>自分のアプリ</h2>')
    const group = html.indexOf('>Sales のアプリ</h2>')
    const company = html.indexOf('>社内のアプリ</h2>')
    expect(html.indexOf('data-portal-installed=')).toBeLessThan(owner)
    expect(owner).toBeLessThan(group)
    expect(group).toBeLessThan(company)
    // The group path is a muted subtitle under its heading.
    expect(html).toMatch(/>Sales のアプリ<\/h2><p title="Acme\/Sales"[^>]*>Acme\/Sales<\/p>/)
    const en = renderApps({ status: 'ready', home: mockHome() }, '', 'en')
    expect(en).toContain('>My apps</h2>')
    expect(en).toContain('>Sales apps</h2>')
    expect(en).toContain('>Company apps</h2>')
  })

  test('a section with no entries is not rendered', () => {
    const home = mockHome()
    home.sections = home.sections.map((section) => (section.relation === 'group' ? { ...section, entries: [] } : section))
    const html = renderApps({ status: 'ready', home })
    expect(html).not.toContain('data-portal-section="group"')
    expect(html).toContain('自分のアプリ')
  })

  test('ready opens the app in a new tab, preparing is muted and inert, restricted only links to details', () => {
    const html = renderApps({ status: 'ready', home: mockHome() })
    expect(html).toMatch(
      /<a href="https:\/\/expense\.pj-mock\.appthrust\.ink" target="_blank" rel="noreferrer noopener" data-portal-entry="expense" data-portal-entry-state="ready"[^>]*>.*?開く<svg[^>]*>.*?<\/svg><span class="sr-only">（新しいタブで開きます）<\/span>.*?<\/a><\/li>/
    )
    const preparing = html.match(/<div aria-disabled="true" data-portal-entry="travel" data-portal-entry-state="preparing"[^>]*>.*?<\/div><\/li>/)?.[0] ?? ''
    expect(preparing).toContain('opacity-60')
    expect(preparing).toContain('準備中')
    expect(preparing).not.toContain('<a ')
    const restricted = html.match(/<div data-portal-entry="sales-dashboard" data-portal-entry-state="restricted"[^>]*>.*?<\/div><\/li>/)?.[0] ?? ''
    expect(restricted).toContain('申請が必要')
    expect(restricted.match(/<a /g)).toHaveLength(1)
    expect(restricted).toMatch(/<a href="https:\/\/console\.pj-mock\.appthrust\.ink\/apps\/sales-dashboard" target="_blank" rel="noreferrer noopener"[^>]*>詳しく見る/)
  })

  test('cards show tags as chips and fall back to the default icon for an unknown key', () => {
    const html = renderApps({ status: 'ready', home: mockHome() })
    const quote = html.match(/data-portal-entry="quote-maker".*?<\/a><\/li>/)?.[0] ?? ''
    expect(quote).toContain('lucide-puzzle')
    expect(quote).toMatch(/<ul aria-label="タグ"[^>]*><li[^>]*>CRM<\/li><li[^>]*>Documents<\/li><\/ul>/)
  })

  test('an unavailable provider gets one quiet line named by its localized app title; absent says nothing', () => {
    const home = mockHome()
    home.sources = [...home.sources, { definitionId: 'knowledge', state: 'absent' }, { definitionId: 'not-installed', state: 'unavailable' }]
    const ja = renderApps({ status: 'ready', home })
    expect(ja).toContain('アプリ一覧を取得できませんでした（社内ツールビルダー）')
    expect(ja).toContain('アプリ一覧を取得できませんでした（not-installed）')
    expect(ja).not.toContain('data-portal-source-unavailable="knowledge"')
    expect(ja.indexOf('data-portal-source-unavailable=')).toBeLessThan(ja.indexOf('data-portal-section='))
    expect(renderApps({ status: 'ready', home }, '', 'en')).toContain("Couldn&#x27;t load apps from Internal Tool Builder")
  })

  test('no sections with every provider ready is one empty line, worded for a search when there is one', () => {
    const home: HomeResponse = { ...mockHome(), sections: [], sources: [{ definitionId: 'builder-console', state: 'ready' }] }
    expect(renderApps({ status: 'ready', home })).toContain('まだアプリが登録されていません')
    expect(renderApps({ status: 'ready', home }, 'deal')).toContain('見つかりません')
    expect(renderApps({ status: 'ready', home }, 'deal', 'en')).toContain('No matches')
    const down: HomeResponse = { ...home, sources: [{ definitionId: 'builder-console', state: 'unavailable' }] }
    expect(renderApps({ status: 'ready', home: down })).not.toContain('data-portal-apps-empty')
  })

  test('a search with no matching tile says so in the アプリ block', () => {
    expect(renderApps({ status: 'ready', home: mockHome() }, 'zzz')).toContain('一致するアプリはありません。')
  })

  test('loading, denied and unavailable homes show once, under the アプリ heading', () => {
    expect(renderApps({ status: 'loading' })).toContain('role="status"')
    const denied = renderApps(new HomeError({ status: 'denied', httpStatus: 403 }).state)
    expect(denied).toContain('role="alert"')
    expect(denied).toContain('このアカウントではこのプロジェクトのアプリを一覧できません。')
    expect(denied).not.toContain('data-portal-apps=')
    const unavailable = renderApps({ status: 'unavailable' })
    expect(unavailable.match(/アプリの一覧に一時的につながりません。/g)).toHaveLength(1)
    expect(unavailable).toContain('もう一度読み込む')
  })

  test('no raw entry or group id is visible text', () => {
    const html = renderApps({ status: 'ready', home: mockHome() })
    expect(html).not.toContain('>grp-sales<')
    expect(html).not.toContain('>expense<')
    expect(html).not.toContain('>builder-console<')
  })
})
