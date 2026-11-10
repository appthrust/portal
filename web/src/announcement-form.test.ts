import { createDashboardTranslator } from '@appthrust/platform-dashboard-i18n'
import { describe, expect, test } from 'bun:test'
import {
  createInput,
  formValuesOf,
  isScheduled,
  newFormValues,
  nextHourInput,
  patchInput,
  serverFieldErrors,
  validateForm,
  type FormErrors,
  type FormValues,
} from './announcement-form'
import type { Announcement } from './announcements'
import { catalogs } from './copy'
import { fromLocalInput, toLocalInput } from './format'

const now = new Date('2026-11-10T01:00:00Z')
const at = (iso: string) => toLocalInput(iso)
const values = (overrides: Partial<FormValues> = {}): FormValues => ({ ...newFormValues(), title: '全社会議', ...overrides })

describe('editor validation (design invariants)', () => {
  test('title is 1–120 characters after trimming, counted as people count them', () => {
    expect(validateForm(values({ title: '   ' }), now).title?.id).toBe('portal.editor.error.titleRequired')
    expect(validateForm(values({ title: 'あ'.repeat(120) }), now).title).toBeUndefined()
    expect(validateForm(values({ title: ` ${'あ'.repeat(120)} ` }), now).title).toBeUndefined()
    expect(validateForm(values({ title: 'あ'.repeat(121) }), now).title).toEqual({ id: 'portal.editor.error.titleTooLong', values: { max: 120 } })
    // One emoji is one character even though it is two UTF-16 units.
    expect(validateForm(values({ title: '🎉'.repeat(120) }), now).title).toBeUndefined()
  })

  test('the body is at most 20 KiB of UTF-8 and may be empty', () => {
    expect(validateForm(values({ body: '' }), now).body).toBeUndefined()
    expect(validateForm(values({ body: 'a'.repeat(20 * 1024) }), now).body).toBeUndefined()
    // 7,000 Japanese characters are 21,000 bytes.
    expect(validateForm(values({ body: 'あ'.repeat(7000) }), now).body?.id).toBe('portal.editor.error.bodyTooLong')
  })

  test('a scheduled publish needs a time; the end time must come after the publish time', () => {
    expect(validateForm(values({ publishMode: 'at', publishAt: '' }), now).publishAt?.id).toBe('portal.editor.error.publishAtRequired')
    const scheduled = values({ publishMode: 'at', publishAt: at('2026-11-12T00:00:00Z') })
    expect(validateForm({ ...scheduled, expiresAt: at('2026-11-12T00:00:00Z') }, now).expiresAt?.id).toBe('portal.editor.error.expiresBeforePublish')
    expect(validateForm({ ...scheduled, expiresAt: at('2026-11-13T00:00:00Z') }, now)).toEqual({})
    // Publishing now: the end time is compared with now.
    expect(validateForm(values({ expiresAt: at('2026-11-09T00:00:00Z') }), now).expiresAt).toBeDefined()
    expect(validateForm(values({ expiresAt: at('2026-11-11T00:00:00Z') }), now)).toEqual({})
  })

  test('the submit says 予約する only for a future publish time', () => {
    expect(isScheduled(values(), now)).toBe(false)
    expect(isScheduled(values({ publishMode: 'at', publishAt: at('2026-11-12T00:00:00Z') }), now)).toBe(true)
    expect(isScheduled(values({ publishMode: 'at', publishAt: at('2026-11-01T00:00:00Z') }), now)).toBe(false)
  })
})

describe('server invalid answers in the viewer language', () => {
  const ja = createDashboardTranslator('ja', catalogs)
  const shown = (errors: FormErrors | undefined) =>
    Object.fromEntries(Object.entries(errors ?? {}).map(([field, error]) => [field, ja.t(error.id, error.values)]))

  test('each cmd/server validation reason lands on its field in Japanese', () => {
    const scheduled = values({ publishMode: 'at', publishAt: at('2026-11-12T00:00:00Z') })
    expect(shown(serverFieldErrors('title must contain 1–120 characters after trimming', scheduled))).toEqual({ title: 'タイトルは1〜120文字で入力してください。' })
    expect(shown(serverFieldErrors('body must not exceed 20 KiB', scheduled))).toEqual({ body: '本文が長すぎます。20KB 以内にしてください。' })
    expect(shown(serverFieldErrors('category must be info, important, or event', scheduled))).toEqual({ category: '種類を選び直してください。' })
    expect(shown(serverFieldErrors('publishedAt must be set', scheduled))).toEqual({ publishAt: '公開日時を指定してください。' })
    expect(shown(serverFieldErrors('expiresAt must be after publishedAt', scheduled))).toEqual({ expiresAt: '掲載終了日時は、公開日時より後にしてください。' })
  })

  test('any other reason is left to the generic Japanese message, never echoed', () => {
    for (const message of ['Request body contains invalid or unknown fields', 'A referenced resource or value is invalid', '']) {
      expect(serverFieldErrors(message, values())).toBeUndefined()
    }
    // Publishing now shows no publish-time field to mark.
    expect(serverFieldErrors('publishedAt must be set', values())).toBeUndefined()
    expect(ja.t('portal.editor.error.invalid')).toBe('お知らせを保存できませんでした。入力内容を確認してください。')
  })
})

describe('editor request bodies', () => {
  test('create sends the trimmed title and leaves "now" and an empty end time to the server defaults', () => {
    expect(createInput(values({ title: '  全社会議  ', body: '本文', category: 'event', pinned: true }))).toEqual({
      title: '全社会議',
      body: '本文',
      category: 'event',
      pinned: true,
    })
    const scheduled = createInput(values({ publishMode: 'at', publishAt: at('2026-11-12T00:00:00Z'), expiresAt: at('2026-11-13T00:00:00Z') }))
    expect(scheduled.publishedAt).toBe('2026-11-12T00:00:00.000Z')
    expect(scheduled.expiresAt).toBe('2026-11-13T00:00:00.000Z')
  })

  test('edit starts from the announcement and patches only what changed; clearing the end time sends null', () => {
    const announcement: Announcement = {
      id: '01A',
      title: '全社会議',
      excerpt: '',
      body: '本文',
      category: 'info',
      pinned: false,
      state: 'published',
      publishedAt: '2026-11-09T00:00:00Z',
      expiresAt: '2026-11-20T00:00:00Z',
      author: { subject: 's', name: 'n' },
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-09T00:00:00Z',
      read: true,
    }
    const initial = formValuesOf(announcement)
    expect(initial).toMatchObject({ publishMode: 'at', publishAt: at(announcement.publishedAt), expiresAt: at('2026-11-20T00:00:00Z') })
    expect(patchInput(initial, initial, now)).toEqual({})
    expect(patchInput({ ...initial, pinned: true, expiresAt: '' }, initial, now)).toEqual({ pinned: true, expiresAt: null })
    expect(patchInput({ ...initial, publishMode: 'now' }, initial, now)).toEqual({ publishedAt: now.toISOString() })
    expect(patchInput({ ...initial, title: ' 全社会議（変更） ' }, initial, now)).toEqual({ title: '全社会議（変更）' })
  })

  test('local datetime values round-trip to RFC 3339 UTC; the next full hour seeds a scheduled time', () => {
    expect(fromLocalInput(toLocalInput('2026-11-12T03:30:00Z'))).toBe('2026-11-12T03:30:00.000Z')
    expect(fromLocalInput('')).toBeUndefined()
    expect(fromLocalInput('not a date')).toBeUndefined()
    const next = new Date(fromLocalInput(nextHourInput(new Date('2026-11-10T01:20:00Z'))) ?? '')
    expect(next.getMinutes()).toBe(0)
    expect(next.getTime() - Date.parse('2026-11-10T01:20:00Z')).toBeGreaterThan(0)
    expect(next.getTime() - Date.parse('2026-11-10T01:20:00Z')).toBeLessThanOrEqual(60 * 60 * 1000)
  })
})
