// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the portal contract (`/config`, `/launcher`, `/api/portal/v1/*`,
// ./mock-portal) on one port; Vite proxies those paths here (vite.config.ts).
// PORTAL_MOCK_ROLE=viewer signs in as a member who cannot post (default: a
// poster); PORTAL_MOCK_STORE=down answers announcements as a Portal without
// its database does. Announcements live in memory until the process stops.
import { createPortalMock } from './mock-portal'

const port = Number(process.env.PORTAL_MOCK_PORT ?? 5226)
const role = process.env.PORTAL_MOCK_ROLE === 'viewer' ? 'viewer' : 'poster'
const store = process.env.PORTAL_MOCK_STORE === 'down' ? 'down' : 'up'
const portalRoutes = createPortalMock({ role, store })

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    return (
      (await portalRoutes(request)) ?? Response.json({ error: 'not_found', message: `no mock for ${request.method} ${url.pathname}` }, { status: 404 })
    )
  },
})

console.log(`portal mock API on http://${server.hostname}:${server.port} (role: ${role}, store: ${store})`)
