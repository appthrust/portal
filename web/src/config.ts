// `GET /config` from cmd/portal-server: the project this portal belongs to, its
// own public URL, and the Dashboard's Marketplace (the empty grid links there).
import { queryOptions } from '@tanstack/react-query'

export type PortalConfig = { projectId: string; publicUrl: string; dashboardUrl: string }

export function parseConfig(value: unknown): PortalConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid portal config')
  const config = value as Record<string, unknown>
  for (const key of ['projectId', 'publicUrl', 'dashboardUrl']) {
    if (typeof config[key] !== 'string' || config[key] === '') throw new Error(`Invalid portal config: ${key}`)
  }
  return { projectId: config.projectId as string, publicUrl: config.publicUrl as string, dashboardUrl: config.dashboardUrl as string }
}

export const configQuery = queryOptions({
  queryKey: ['portal', 'config'],
  queryFn: async ({ signal }) => {
    const response = await fetch('/config', { headers: { accept: 'application/json' }, signal })
    if (!response.ok) throw new Error(`portal config ${response.status}`)
    return parseConfig(await response.json())
  },
  // The config is fixed for the pod's lifetime.
  staleTime: Number.POSITIVE_INFINITY,
})
