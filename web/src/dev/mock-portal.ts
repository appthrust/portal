// Dev-only portal contract: `GET /config` as cmd/portal-server answers it,
// `GET /launcher` (project + entries) from the shared fixture
// (@appthrust/app-launcher), and `GET /api/portal/v1/home?q=` composed from
// that fixture plus Launch Entries one provider (Builder Console) made for the
// viewer, with a second provider (Internal Tool Builder) down. Like the
// edge-fronted server it needs no token here: the dev proxy never forwards one.
import { createMockLauncherHandler, mockLauncherEntries, mockLauncherProject } from '@appthrust/app-launcher'
import type { PortalConfig } from '../config'
import type { AppEntry, GroupRef, HomeResponse, HomeSection, HomeWireBody } from '../home'

export const mockConfig: PortalConfig = {
  projectId: mockLauncherProject.id,
  publicUrl: `https://home.${mockLauncherProject.id}.appthrust.ink`,
  dashboardUrl: `https://dashboard.appthrust.ink/dashboard/projects/${mockLauncherProject.id}/marketplace`,
}

const launcherEntries = mockLauncherEntries('portal')
const launcher = createMockLauncherHandler(launcherEntries, mockLauncherProject)

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
    installedApps: launcherEntries,
    sections,
    sources: [
      { definitionId: 'builder-console', state: 'ready' },
      { definitionId: 'tool-builder', state: 'unavailable' },
    ],
  }
}

/** `mockHome` as portal-server sends it (installed apps under the wire key `builtinApps`). */
export function mockHomeBody(q = ''): HomeWireBody {
  const { installedApps, ...rest } = mockHome(q)
  return { ...rest, builtinApps: installedApps }
}

/** Answers the portal routes; `undefined` for anything else (the server turns that into 404). */
export function portalRoutes(request: Request): Response | undefined {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/config') return Response.json(mockConfig)
  if (request.method === 'GET' && url.pathname === '/api/portal/v1/home') {
    return Response.json(mockHomeBody(url.searchParams.get('q') ?? ''), { headers: { 'Cache-Control': 'private, no-store' } })
  }
  return launcher(request)
}
