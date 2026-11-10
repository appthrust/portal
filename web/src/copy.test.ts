import { describe, expect, test } from 'bun:test'
import { portalMessages } from './copy'

const messages = Object.entries(portalMessages)

describe('portal wording', () => {
  test('every message has Japanese, and English placeholders survive translation', () => {
    for (const [id, message] of messages) {
      const ja: string | undefined = message.translations.ja
      expect(ja, id).toBeString()
      const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      expect(placeholders(ja ?? ''), id).toEqual(placeholders(message.defaultMessage))
    }
  })

  test('each English source belongs to one id (the dashboard-i18n runtime rejects duplicates)', () => {
    const seen = new Map<string, string>()
    for (const [id, message] of messages) {
      expect(seen.get(message.defaultMessage), `${id} repeats ${seen.get(message.defaultMessage)}`).toBeUndefined()
      seen.set(message.defaultMessage, id)
    }
  })

  test('Japanese says プロジェクト and keeps English only for product names', () => {
    const allowed = /Markdown|KB|English/g
    for (const [id, message] of messages) {
      const ja = (message.translations.ja ?? '').replace(allowed, '').replace(/\{\w+\}/g, '')
      expect(ja, id).not.toMatch(/[A-Za-z]{2,}/)
    }
  })
})
