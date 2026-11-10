// The page's few routes over the History API. cmd/server answers every
// non-asset path with the SPA, so each route is also a real, shareable URL.
// Announcement ids are ULIDs, so `new` can never name one.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'announcements' }
  | { name: 'announcement'; id: string }
  | { name: 'newAnnouncement' }
  | { name: 'editAnnouncement'; id: string }
  | { name: 'notFound' }

export const paths = {
  home: '/',
  announcements: '/announcements',
  announcement: (id: string) => `/announcements/${encodeURIComponent(id)}`,
  newAnnouncement: '/announcements/new',
  editAnnouncement: (id: string) => `/announcements/${encodeURIComponent(id)}/edit`,
}

export function matchRoute(pathname: string): Route {
  let parts: string[]
  try {
    parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return { name: 'notFound' }
  }
  if (parts.length === 0) return { name: 'home' }
  if (parts[0] !== 'announcements') return { name: 'notFound' }
  if (parts.length === 1) return { name: 'announcements' }
  if (parts.length === 2) return parts[1] === 'new' ? { name: 'newAnnouncement' } : { name: 'announcement', id: parts[1] }
  if (parts.length === 3 && parts[2] === 'edit' && parts[1] !== 'new') return { name: 'editAnnouncement', id: parts[1] }
  return { name: 'notFound' }
}

const NAVIGATE_EVENT = 'portal:navigate'

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE_EVENT, onChange)
  }
}

/** The current path; `/` when rendered without a browser. */
export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/'
  )
}

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  if (to === window.location.pathname) return
  if (replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.scrollTo(0, 0)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

/** An in-app link: a plain left click navigates in place; modified clicks keep the browser's behaviour. */
export function Link({ to, onClick, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string }) {
  return (
    <a
      {...props}
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigate(to)
      }}
    />
  )
}
