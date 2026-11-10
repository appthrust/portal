// Shared page primitives: button and notice styles and the section heading
// row, so every block on the page reads with one hierarchy.
import { ChevronLeft } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link } from './router'

/** The tab title: the page's own title first, then the portal name. */
export function useDocumentTitle(...parts: string[]) {
  const title = parts.filter(Boolean).join(' | ')
  useEffect(() => {
    document.title = title
  }, [title])
}

const BUTTON_BASE =
  'inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0'

export const BUTTON_PRIMARY = `${BUTTON_BASE} bg-blue-600 text-white shadow-xs hover:bg-blue-700`
export const BUTTON_SECONDARY = `${BUTTON_BASE} border border-stone-300 bg-white text-stone-800 shadow-xs hover:bg-stone-50`
export const BUTTON_DANGER = `${BUTTON_BASE} bg-red-600 text-white shadow-xs hover:bg-red-700`
/** Quiet text button for secondary actions in headers and section rows. */
export const BUTTON_GHOST =
  'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-stone-600 hover:bg-stone-100 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0'

export const NOTICE = 'rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700'
export const PANEL = 'overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xs'

/** A block heading (`h2`) with optional trailing actions; `meta` sits right after the title. */
export function SectionHeading({ id, title, meta, actions }: { id: string; title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id={id} className="text-base font-semibold tracking-tight text-stone-900">
        {title}
      </h2>
      {meta}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-1">{actions}</div> : null}
    </div>
  )
}

/** A failed request: the message and, when it can help, a retry button. */
export function FailureNotice({ message, retryLabel, onRetry }: { message: string; retryLabel?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-3 ${NOTICE}`}>
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && retryLabel ? (
        <button type="button" onClick={onRetry} className={BUTTON_SECONDARY}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  )
}

/** The quiet "back" link above a sub-page's heading. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={`${BUTTON_GHOST} -ml-2.5 mb-3`}>
      <ChevronLeft aria-hidden />
      {children}
    </Link>
  )
}
