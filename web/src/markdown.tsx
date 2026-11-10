// Announcement bodies are Markdown as written; the server never renders HTML.
// Every render goes through marked (GFM, single line breaks kept) and then
// DOMPurify, so a body can never inject script, event handlers or
// `javascript:` URLs. Same pattern as Memo and AppThrust News.
import DOMPurify, { type WindowLike } from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

/** Markdown → sanitized HTML against `window`'s DOM (a test passes a jsdom window). */
export function createMarkdownRenderer(window: WindowLike & { location: { origin: string } }): (markdown: string) => string {
  const purify = DOMPurify(window)
  const origin = window.location.origin
  purify.addHook('afterSanitizeAttributes', (node) => {
    // Links to other sites open in a new tab without handing them `window.opener`; links into this portal stay in place.
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      const href = node.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href) && new URL(href).origin !== origin) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
    }
    if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy')
  })
  return (markdown) => purify.sanitize(marked.parse(markdown, { gfm: true, breaks: true, async: false }))
}

let browserRenderer: ((markdown: string) => string) | undefined

/** A rendered announcement body; empty when rendered without a browser DOM (static test rendering). */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => {
    if (typeof window === 'undefined') return ''
    browserRenderer ??= createMarkdownRenderer(window)
    return browserRenderer(source)
  }, [source])
  return <div className={`portal-prose ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
}
