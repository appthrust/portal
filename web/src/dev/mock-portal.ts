// Dev-only portal contract (design/README.md "API"), in memory:
// `GET /config` as cmd/server answers it, `GET /launcher` from the shared
// fixture (@appthrust/app-launcher), `GET /api/portal/v1/home?q=` composed
// from that fixture (with catalog `locales` on some apps) plus Launch Entries
// one provider (Builder Console) made for the viewer, with a second provider
// (Internal Tool Builder) down, and every announcement route with read marks
// per viewer. `role` switches between a poster (Admin/Editor) and a plain
// member; `store: 'down'` answers every announcement route and `/me` with
// `503 portal_store_unavailable`, as a Portal without its database does. Like
// the edge-fronted server it needs no token: the dev proxy never forwards one.
import { createMockLauncherHandler, mockLauncherEntries, mockLauncherProject } from '@appthrust/app-launcher'
import {
  BODY_MAX_BYTES,
  CATEGORIES,
  LIST_LIMIT_MAX,
  TITLE_MAX_LENGTH,
  type Announcement,
  type AnnouncementState,
  type AnnouncementSummary,
  type Author,
  type Category,
  type Me,
} from '../announcements'
import type { PortalConfig } from '../config'
import type { AppEntry, AppLocale, GroupRef, HomeResponse, HomeSection, HomeWireBody, InstalledApp } from '../home'

export const mockConfig: PortalConfig = {
  projectId: mockLauncherProject.id,
  publicUrl: `https://home.${mockLauncherProject.id}.appthrust.ink`,
  dashboardUrl: `https://dashboard.appthrust.ink/dashboard/projects/${mockLauncherProject.id}/marketplace`,
}

const launcherEntries = mockLauncherEntries('portal')
const launcher = createMockLauncherHandler(launcherEntries, mockLauncherProject)

// Catalog display text as `GET /api/v1/application-stack-definitions` publishes it: most apps
// localize both fields in both languages, Knowledge only its Japanese tagline, Memo nothing.
const LOCALES: Record<string, Record<string, AppLocale>> = {
  'builder-console': {
    ja: { title: 'ビルダーコンソール', tagline: 'クラスターを意識せずに、アプリを作ってリリースできます。' },
    en: { title: 'Builder Console', tagline: 'Build and release apps without touching clusters.' },
  },
  directory: {
    ja: { title: 'ディレクトリ', tagline: 'この組織のメンバー、グループ、プロフィール。' },
    en: { title: 'Directory', tagline: 'People, groups and profiles of this organisation.' },
  },
  portal: { ja: { title: 'ホーム', tagline: '社内のお知らせとアプリをひとつに。' }, en: { title: 'Home', tagline: 'Company news and apps in one place.' } },
  'tool-builder': {
    ja: { title: '社内ツールビルダー', tagline: 'プロジェクトのデータでテーブル、フォーム、ダッシュボードを作れます。' },
    en: { title: 'Internal Tool Builder', tagline: 'Tables, forms and dashboards on your project data.' },
  },
  knowledge: { ja: { tagline: 'Notion や esa、手元の資料をまとめて検索し、質問できます。' } },
}

// The launcher fixture plus an app the Platform read model still reports as `Pending` (observed for `llm`);
// it is not in `/launcher`, whose shared schema does not know that phase.
export const mockInstalledApps: InstalledApp[] = [
  ...launcherEntries.map((entry) => (LOCALES[entry.definitionId] ? { ...entry, locales: LOCALES[entry.definitionId] } : entry)),
  {
    definitionId: 'llm',
    name: 'LLM Gateway',
    description: 'One endpoint for the language models this Project may use.',
    icon: 'sparkles',
    url: 'https://llm.pj-mock.appthrust.ink',
    phase: 'Pending',
    current: false,
    locales: { ja: { title: 'LLM ゲートウェイ', tagline: 'このプロジェクトで使える言語モデルを、ひとつの窓口から呼び出せます。' } },
  },
]

const SALES: GroupRef = { id: 'grp-sales', name: 'Sales', path: 'Acme/Sales' }
const CONSOLE = 'https://console.pj-mock.appthrust.ink'

const app = (id: string, name: string, description: string, icon: string, tags: string[], rest: Partial<AppEntry> = {}): AppEntry => ({
  id,
  name,
  description,
  icon,
  url: `https://${id}.pj-mock.appthrust.ink`,
  state: 'ready',
  relation: 'project',
  tags,
  sourceDefinitionId: 'builder-console',
  ...rest,
})

// Sections in server order (owner → group by path → project), entries by name.
const SECTIONS: readonly HomeSection[] = [
  {
    relation: 'owner',
    group: null,
    entries: [
      app('expense', 'Expense Claims', 'Snap a receipt, file the claim and get it approved on the spot.', 'layout-dashboard', ['Finance', 'Workflow'], {
        relation: 'owner',
      }),
      app('travel', 'Travel Requests', 'Book and approve business trips in one form.', 'globe', ['General affairs'], {
        relation: 'owner',
        state: 'preparing',
        url: undefined,
      }),
    ],
  },
  {
    relation: 'group',
    group: SALES,
    entries: [
      app('deal-pipeline', 'Deal Pipeline', 'Every open deal by stage, owner and expected close date.', 'database', ['CRM'], {
        relation: 'group',
        group: SALES,
      }),
      app('quote-maker', 'Quote Maker', 'Quotes from the price list, as PDFs your customers can sign.', 'receipt', ['CRM', 'Documents'], {
        relation: 'group',
        group: SALES,
      }),
      app('sales-dashboard', 'Sales Dashboard', 'Revenue by region and month, refreshed every morning.', 'layout-dashboard', ['Reporting'], {
        relation: 'group',
        group: SALES,
        state: 'restricted',
        url: undefined,
        detailUrl: `${CONSOLE}/apps/sales-dashboard`,
      }),
    ],
  },
  {
    relation: 'project',
    group: null,
    entries: [
      app('asset-register', 'Asset Register', 'Laptops, phones and licences: who has what.', 'database', ['IT']),
      app('company-faq', 'Company FAQ', 'Answers to the questions everyone asks in their first month.', 'knowledge', []),
      app('room-booking', 'Meeting Rooms', 'Find a free room and book it for your next meeting.', 'globe', ['General affairs']),
      app('timesheets', 'Timesheets', 'Log hours per project; your manager signs off weekly.', 'terminal', ['HR', 'Workflow']),
    ],
  },
]

/** The mock home: provider entries whose name contains `q` (case-insensitive); empty sections are dropped. */
export function mockHome(q = ''): HomeResponse {
  const needle = q.trim().toLowerCase()
  const sections = SECTIONS.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => entry.name.toLowerCase().includes(needle)),
  })).filter((section) => section.entries.length > 0)
  return {
    project: mockLauncherProject,
    installedApps: mockInstalledApps,
    sections,
    sources: [
      { definitionId: 'builder-console', state: 'ready' },
      { definitionId: 'tool-builder', state: 'unavailable' },
    ],
  }
}

/** `mockHome` as cmd/server sends it (installed apps under the wire key `builtinApps`). */
export function mockHomeBody(q = ''): HomeWireBody {
  const { installedApps, ...rest } = mockHome(q)
  return { ...rest, builtinApps: installedApps }
}

export const mockPoster: Me = { subject: 'user-hanako', name: '佐藤 花子', canPost: true }
export const mockMember: Me = { subject: 'user-taro', name: '山田 太郎', canPost: false }

type StoredAnnouncement = Omit<Announcement, 'state' | 'read' | 'excerpt'>

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID for `time`; `seed` stands in for the random part so seeded ids are stable. */
function ulid(time: number, seed: number): string {
  let head = ''
  for (let rest = time, i = 0; i < 10; i += 1, rest = Math.floor(rest / 32)) head = CROCKFORD[rest % 32] + head
  let tail = ''
  for (let rest = seed, i = 0; i < 16; i += 1, rest = Math.floor(rest / 32)) tail = CROCKFORD[rest % 32] + tail
  return head + tail
}

/** Plain text of a Markdown body, first 160 characters, as the server's excerpt. */
export function excerptOf(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[\s|:-]*-[\s|:-]*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [...plain].slice(0, 160).join('')
}

const DAY = 24 * 60 * 60 * 1000
const HANAKO: Author = { subject: mockPoster.subject, name: mockPoster.name }
const SOMU: Author = { subject: 'user-somu', name: '総務部 田中' }

function seedAnnouncements(now: number): StoredAnnouncement[] {
  const seed = (
    n: number,
    title: string,
    body: string,
    category: Category,
    publishedOffset: number,
    rest: { pinned?: boolean; expiresOffset?: number; author?: Author } = {}
  ): StoredAnnouncement => {
    const publishedAt = new Date(now + publishedOffset).toISOString()
    return {
      id: ulid(now + publishedOffset, n),
      title,
      body,
      category,
      pinned: rest.pinned ?? false,
      publishedAt,
      expiresAt: rest.expiresOffset === undefined ? null : new Date(now + rest.expiresOffset).toISOString(),
      author: rest.author ?? SOMU,
      createdAt: new Date(now + Math.min(publishedOffset, 0) - DAY).toISOString(),
      updatedAt: new Date(now + Math.min(publishedOffset, 0) - DAY).toISOString(),
    }
  }
  return [
    seed(
      1,
      '年末年始休業のお知らせ',
      '年末年始は下記のとおり休業します。\n\n- **休業期間**：12月27日（土）〜1月4日（日）\n- 1月5日（月）から通常どおり営業します\n\n休業中の緊急連絡は、[総務部の連絡先一覧](https://directory.pj-mock.appthrust.ink/groups/somu)をご覧ください。',
      'info',
      -5 * DAY,
      { pinned: true, expiresOffset: 50 * DAY }
    ),
    seed(
      2,
      '11月15日（土）にネットワーク機器の入れ替えを行います',
      '## 作業日時\n\n11月15日（土）9:00〜18:00\n\n## 影響\n\n作業中は社内ネットワークと VPN が**断続的に使えなくなります**。前日までに必要なファイルを手元に保存しておいてください。\n\n> ご不明な点は情報システム部までお問い合わせください。',
      'important',
      -1 * DAY,
      { author: HANAKO }
    ),
    seed(3, '社内報 11月号を公開しました', '今月の特集は「新しいオフィスでの1か月」です。各部署の座席表も更新しています。', 'info', -2 * DAY),
    seed(
      4,
      '社内勉強会「はじめての生成 AI 活用」を開催します',
      '業務での生成 AI の使い方を、実例を交えて紹介します。\n\n| 日時 | 場所 |\n| --- | --- |\n| 11月20日（木）17:00〜18:00 | 大会議室とオンライン |\n\n参加申し込みは不要です。',
      'event',
      -3 * DAY
    ),
    seed(5, '健康診断の予約受付を開始しました', '今年度の健康診断の予約を受け付けています。11月末までに予約してください。', 'info', -7 * DAY),
    seed(6, '新しい経費精算アプリを導入しました', '12月から経費精算は新しいアプリで行います。使い方の説明会は11月中に開きます。', 'info', -12 * DAY),
    seed(7, 'オフィスの複合機を入れ替えました', '3階の複合機が新しくなりました。印刷には社員証でのログインが必要です。', 'info', -20 * DAY),
    seed(8, '冬季賞与の支給日について', '冬季賞与は12月10日（水）に支給します。明細は給与アプリで確認できます。', 'important', 2 * DAY, { author: HANAKO }),
    seed(9, '夏季休暇の取得について', '夏季休暇は7月から9月の間に3日間取得できます。', 'info', -90 * DAY, { expiresOffset: -60 * DAY }),
  ]
}

const CONTROL = { 'Cache-Control': 'private, no-store' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CONTROL })
const fail = (status: number, error: string, message: string) => json({ error, message }, status)
const noContent = () => new Response(null, { status: 204, headers: CONTROL })

const POST_FIELDS = ['title', 'body', 'category', 'pinned', 'publishedAt', 'expiresAt']
// cmd/server's wording for a body its JSON decoder rejects (wrong types, unknown fields).
const BAD_FIELDS = 'Request body contains invalid or unknown fields'

export type MockOptions = { role?: 'poster' | 'viewer'; store?: 'up' | 'down'; now?: () => Date }

/**
 * The whole portal API in memory. Answers `undefined` for anything it does not
 * serve (the server turns that into 404). Each call keeps its own announcements and read marks.
 */
export function createPortalMock({ role = 'poster', store = 'up', now = () => new Date() }: MockOptions = {}) {
  const viewer = role === 'poster' ? mockPoster : mockMember
  const announcements = seedAnnouncements(now().getTime())
  // Everyone has read the older notices; the viewer has not read the newest ones.
  const reads = new Map<string, Set<string>>([[viewer.subject, new Set(announcements.slice(4).map((item) => item.id))]])
  let sequence = 100

  const readSet = () => {
    let set = reads.get(viewer.subject)
    if (!set) reads.set(viewer.subject, (set = new Set()))
    return set
  }
  const stateOf = (item: StoredAnnouncement, at: number): AnnouncementState => {
    if (Date.parse(item.publishedAt) > at) return 'scheduled'
    if (item.expiresAt !== null && Date.parse(item.expiresAt) <= at) return 'expired'
    return 'published'
  }
  const present = (item: StoredAnnouncement, at: number): Announcement => ({
    ...item,
    excerpt: excerptOf(item.body),
    state: stateOf(item, at),
    read: readSet().has(item.id),
  })
  const summary = ({ body: _body, ...rest }: Announcement): AnnouncementSummary => rest
  const visible = (item: StoredAnnouncement, at: number) => viewer.canPost || stateOf(item, at) === 'published'
  const ordered = () =>
    [...announcements].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    )

  /** Validates POST/PATCH fields onto `base`; a message for the first problem, else the merged announcement. */
  const apply = (base: StoredAnnouncement, fields: Record<string, unknown>): StoredAnnouncement | string => {
    const unknown = Object.keys(fields).find((key) => !POST_FIELDS.includes(key))
    if (unknown) return BAD_FIELDS
    const next = { ...base }
    if ('title' in fields) {
      if (typeof fields.title !== 'string') return BAD_FIELDS
      next.title = fields.title.trim()
    }
    if ([...next.title].length < 1 || [...next.title].length > TITLE_MAX_LENGTH) return `title must contain 1–${TITLE_MAX_LENGTH} characters after trimming`
    if ('body' in fields) {
      if (typeof fields.body !== 'string') return BAD_FIELDS
      next.body = fields.body
    }
    if (new TextEncoder().encode(next.body).length > BODY_MAX_BYTES) return 'body must not exceed 20 KiB'
    if ('category' in fields) {
      if (typeof fields.category !== 'string' || !CATEGORIES.includes(fields.category as Category)) return 'category must be info, important, or event'
      next.category = fields.category as Category
    }
    if ('pinned' in fields) {
      if (typeof fields.pinned !== 'boolean') return BAD_FIELDS
      next.pinned = fields.pinned
    }
    if ('publishedAt' in fields) {
      if (typeof fields.publishedAt !== 'string' || Number.isNaN(Date.parse(fields.publishedAt))) return BAD_FIELDS
      next.publishedAt = new Date(fields.publishedAt).toISOString()
    }
    if ('expiresAt' in fields) {
      if (fields.expiresAt === null) next.expiresAt = null
      else if (typeof fields.expiresAt !== 'string' || Number.isNaN(Date.parse(fields.expiresAt))) return BAD_FIELDS
      else next.expiresAt = new Date(fields.expiresAt).toISOString()
    }
    if (next.expiresAt !== null && Date.parse(next.expiresAt) <= Date.parse(next.publishedAt)) return 'expiresAt must be after publishedAt'
    return next
  }

  const readJson = async (request: Request): Promise<Record<string, unknown> | Response> => {
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return fail(400, 'invalid', 'body must be application/json')
    try {
      const body: unknown = await request.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid', 'body must be a JSON object')
      return body as Record<string, unknown>
    } catch {
      return fail(400, 'invalid', 'body must be valid JSON')
    }
  }

  async function announcementRoutes(request: Request, url: URL): Promise<Response | undefined> {
    const at = now().getTime()
    const path = url.pathname.slice('/api/portal/v1'.length)
    const method = request.method
    if (path === '/me' && method === 'GET') return json(viewer)
    if (path === '/announcements' && method === 'GET') {
      const scope = url.searchParams.get('scope') ?? 'published'
      if (scope !== 'published' && scope !== 'all') return fail(400, 'invalid', 'scope must be published or all')
      if (scope === 'all' && !viewer.canPost) return fail(403, 'forbidden', 'You do not have permission for this action')
      const limit = Number(url.searchParams.get('limit') ?? 20)
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return fail(400, 'invalid', `limit must be 1-${LIST_LIMIT_MAX}`)
      const offset = Number(url.searchParams.get('cursor') || 0)
      if (!Number.isInteger(offset) || offset < 0) return fail(400, 'invalid', 'cursor is not valid')
      const matching = ordered().filter((item) => scope === 'all' || stateOf(item, at) === 'published')
      const page = matching.slice(offset, offset + limit)
      const unreadCount = announcements.filter((item) => stateOf(item, at) === 'published' && !readSet().has(item.id)).length
      return json({
        items: page.map((item) => summary(present(item, at))),
        nextCursor: offset + limit < matching.length ? String(offset + limit) : '',
        unreadCount,
      })
    }
    if (path === '/announcements' && method === 'POST') {
      if (!viewer.canPost) return fail(403, 'forbidden', 'You do not have permission for this action')
      const body = await readJson(request)
      if (body instanceof Response) return body
      if (typeof body.title !== 'string' || typeof body.body !== 'string') return fail(400, 'invalid', 'title and body are required')
      const created = new Date(at).toISOString()
      sequence += 1
      const base: StoredAnnouncement = {
        id: ulid(at, sequence),
        title: '',
        body: '',
        category: 'info',
        pinned: false,
        publishedAt: created,
        expiresAt: null,
        author: { subject: viewer.subject, name: viewer.name },
        createdAt: created,
        updatedAt: created,
      }
      const result = apply(base, body)
      if (typeof result === 'string') return fail(400, 'invalid', result)
      announcements.push(result)
      return json(present(result, at), 201)
    }
    if (path === '/announcements/read-all' && method === 'POST') {
      for (const item of announcements) if (stateOf(item, at) === 'published') readSet().add(item.id)
      return noContent()
    }
    const match = /^\/announcements\/([^/]+)(\/read)?$/.exec(path)
    if (!match) return undefined
    const id = decodeURIComponent(match[1])
    const index = announcements.findIndex((item) => item.id === id)
    const item = index === -1 ? undefined : announcements[index]
    if (match[2]) {
      if (method !== 'PUT') return undefined
      if (!item || !visible(item, at)) return fail(404, 'not_found', 'The requested resource was not found')
      readSet().add(id)
      return noContent()
    }
    if (method === 'GET') {
      if (!item || !visible(item, at)) return fail(404, 'not_found', 'The requested resource was not found')
      return json(present(item, at))
    }
    if (method !== 'PATCH' && method !== 'DELETE') return undefined
    if (!viewer.canPost) return fail(403, 'forbidden', 'You do not have permission for this action')
    if (!item) return fail(404, 'not_found', 'The requested resource was not found')
    if (method === 'DELETE') {
      announcements.splice(index, 1)
      for (const set of reads.values()) set.delete(id)
      return noContent()
    }
    const body = await readJson(request)
    if (body instanceof Response) return body
    const result = apply(item, body)
    if (typeof result === 'string') return fail(400, 'invalid', result)
    const updated = { ...result, updatedAt: new Date(at).toISOString() }
    announcements[index] = updated
    return json(present(updated, at))
  }

  return async function portalRoutes(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/config') return json(mockConfig)
    if (request.method === 'GET' && url.pathname === '/api/portal/v1/home') return json(mockHomeBody(url.searchParams.get('q') ?? ''))
    if (url.pathname === '/api/portal/v1/me' || url.pathname.startsWith('/api/portal/v1/announcements')) {
      if (store === 'down') return fail(503, 'portal_store_unavailable', 'Announcements are not available yet')
      return announcementRoutes(request, url)
    }
    return launcher(request)
  }
}
