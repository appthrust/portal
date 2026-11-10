// The announcement editor's values, validation and request bodies, kept pure
// so the design's invariants are table-tested: title 1–120 characters after
// trimming, body at most 20 KiB, `publishedAt` always set (now unless
// scheduled), `expiresAt` when set after `publishedAt`.
import {
  BODY_MAX_BYTES,
  TITLE_MAX_LENGTH,
  type Announcement,
  type AnnouncementInput,
  type AnnouncementPatch,
  type Category,
} from './announcements'
import type { MessageId } from './copy'
import { fromLocalInput, toLocalInput } from './format'

export type PublishMode = 'now' | 'at'

/** What the form holds; times are `datetime-local` values in the viewer's time zone. */
export type FormValues = {
  title: string
  body: string
  category: Category
  pinned: boolean
  publishMode: PublishMode
  publishAt: string
  expiresAt: string
}

export type FormField = 'title' | 'category' | 'body' | 'publishAt' | 'expiresAt'
export type FieldError = { id: MessageId; values?: Record<string, number> }
export type FormErrors = Partial<Record<FormField, FieldError>>

/** Field order for focusing the first invalid one. */
export const FORM_FIELDS: readonly FormField[] = ['title', 'category', 'body', 'publishAt', 'expiresAt']

// The validation reasons cmd/server sends in a `400 invalid` message (announcements/domain.go), by the field they concern.
const SERVER_REASONS: readonly { prefix: string; field: FormField; error: FieldError }[] = [
  { prefix: 'title must', field: 'title', error: { id: 'portal.editor.error.titleLength', values: { max: TITLE_MAX_LENGTH } } },
  { prefix: 'body must not exceed', field: 'body', error: { id: 'portal.editor.error.bodyTooLong' } },
  { prefix: 'category must', field: 'category', error: { id: 'portal.editor.error.categoryInvalid' } },
  { prefix: 'publishedAt must', field: 'publishAt', error: { id: 'portal.editor.error.publishAtRequired' } },
  { prefix: 'expiresAt must be after', field: 'expiresAt', error: { id: 'portal.editor.error.expiresBeforePublish' } },
]

/**
 * A server `invalid` message as a localized error on the field it concerns; `undefined` for any
 * other reason (the form then shows its generic message, never the server's English text).
 */
export function serverFieldErrors(message: string, values: FormValues): FormErrors | undefined {
  const reason = SERVER_REASONS.find((candidate) => message.startsWith(candidate.prefix))
  // Publishing now has no publish-time field to point at.
  if (!reason || (reason.field === 'publishAt' && values.publishMode === 'now')) return undefined
  return { [reason.field]: reason.error }
}

export function newFormValues(): FormValues {
  return { title: '', body: '', category: 'info', pinned: false, publishMode: 'now', publishAt: '', expiresAt: '' }
}

/** An existing announcement keeps its publish time unless the poster changes it. */
export function formValuesOf(announcement: Announcement): FormValues {
  return {
    title: announcement.title,
    body: announcement.body,
    category: announcement.category,
    pinned: announcement.pinned,
    publishMode: 'at',
    publishAt: toLocalInput(announcement.publishedAt),
    expiresAt: announcement.expiresAt ? toLocalInput(announcement.expiresAt) : '',
  }
}

/** The next full hour, as the starting value when a poster switches to a set publish time. */
export function nextHourInput(now: Date): string {
  const next = new Date(now)
  next.setMinutes(0, 0, 0)
  next.setHours(next.getHours() + 1)
  return toLocalInput(next.toISOString())
}

/** Characters as people count them (code points), after trimming. */
export function titleLength(title: string): number {
  return [...title.trim()].length
}

export function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length
}

/** The publish time the announcement will have: now, or the scheduled time (undefined when that is blank or invalid). */
function effectivePublish(values: FormValues, now: Date): number | undefined {
  if (values.publishMode === 'now') return now.getTime()
  const iso = fromLocalInput(values.publishAt)
  return iso === undefined ? undefined : Date.parse(iso)
}

export function validateForm(values: FormValues, now: Date): FormErrors {
  const errors: FormErrors = {}
  const length = titleLength(values.title)
  if (length === 0) errors.title = { id: 'portal.editor.error.titleRequired' }
  else if (length > TITLE_MAX_LENGTH) errors.title = { id: 'portal.editor.error.titleTooLong', values: { max: TITLE_MAX_LENGTH } }
  if (bodyBytes(values.body) > BODY_MAX_BYTES) errors.body = { id: 'portal.editor.error.bodyTooLong' }
  const publish = effectivePublish(values, now)
  if (publish === undefined) errors.publishAt = { id: 'portal.editor.error.publishAtRequired' }
  const expires = fromLocalInput(values.expiresAt)
  if (expires !== undefined && publish !== undefined && Date.parse(expires) <= publish) {
    errors.expiresAt = { id: 'portal.editor.error.expiresBeforePublish' }
  }
  return errors
}

/** True when the form would publish later than now (the submit button then says 予約する). */
export function isScheduled(values: FormValues, now: Date): boolean {
  const publish = effectivePublish(values, now)
  return publish !== undefined && publish > now.getTime()
}

/** `POST /announcements` for valid values; "now" leaves `publishedAt` to the server's clock. */
export function createInput(values: FormValues): AnnouncementInput {
  const publishedAt = values.publishMode === 'at' ? fromLocalInput(values.publishAt) : undefined
  const expiresAt = fromLocalInput(values.expiresAt)
  return {
    title: values.title.trim(),
    body: values.body,
    category: values.category,
    pinned: values.pinned,
    ...(publishedAt ? { publishedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

/** `PATCH /announcements/{id}` with only what changed; an emptied end time is sent as `null` to clear it. */
export function patchInput(values: FormValues, initial: FormValues, now: Date): AnnouncementPatch {
  const patch: AnnouncementPatch = {}
  if (values.title.trim() !== initial.title.trim()) patch.title = values.title.trim()
  if (values.body !== initial.body) patch.body = values.body
  if (values.category !== initial.category) patch.category = values.category
  if (values.pinned !== initial.pinned) patch.pinned = values.pinned
  if (values.publishMode === 'now') patch.publishedAt = now.toISOString()
  else if (values.publishAt !== initial.publishAt) patch.publishedAt = fromLocalInput(values.publishAt)
  if (values.expiresAt !== initial.expiresAt) patch.expiresAt = fromLocalInput(values.expiresAt) ?? null
  return patch
}
