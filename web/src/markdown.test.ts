import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createMarkdownRenderer } from './markdown'

// DOMPurify's documented server-side DOM; the browser passes its own `window`.
const { window } = new JSDOM('', { url: 'https://home.pj-1.acme.example/announcements/01A' })
const render = createMarkdownRenderer(window as unknown as Parameters<typeof createMarkdownRenderer>[0])

describe('announcement Markdown', () => {
  test('renders GFM with line breaks and strips script, event handlers and javascript: URLs', () => {
    const html = render(['## 日時', '**太字** と `code`\n次の行', '| a | b |\n| --- | --- |\n| 1 | 2 |', '<script>alert(1)</script>', '<img src="x.png" onerror="alert(2)">', '[bad](javascript:alert(3))'].join('\n\n'))
    expect(html).toContain('<h2>日時</h2>')
    expect(html).toContain('<strong>太字</strong>')
    expect(html).toContain('<code>code</code><br>次の行')
    expect(html).toContain('<td>1</td>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('loading="lazy"')
  })

  test('other sites open in a new tab without the opener; links into the portal stay in place', () => {
    const external = render('[社内規程](https://example.com/rules)')
    expect(external).toContain('target="_blank"')
    expect(external).toContain('rel="noopener noreferrer"')
    const internal = render('[一覧](/announcements) と [ホーム](https://home.pj-1.acme.example/)')
    expect(internal).toContain('href="/announcements"')
    expect(internal).not.toContain('target=')
  })
})
