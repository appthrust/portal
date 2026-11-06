// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the portal contract (`/config`, `/launcher`, `/api/portal/v1/home`,
// ./mock-portal) on one port; Vite proxies those paths here (vite.config.ts).
import { portalRoutes } from './mock-portal'

const port = Number(process.env.PORTAL_MOCK_PORT ?? 5226)

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url)
    return portalRoutes(request) ?? Response.json({ error: 'not_found', message: `no mock for ${request.method} ${url.pathname}` }, { status: 404 })
  },
})

console.log(`portal mock API on http://${server.hostname}:${server.port}`)
