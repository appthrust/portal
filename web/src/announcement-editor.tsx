// The poster's editor (`/announcements/new`, `/announcements/<id>/edit`):
// title, category, Markdown body with preview, pinned, publish time and an
// optional end time. Invalid fields are marked inline before anything is sent;
// a server `invalid` answer is shown on the field it names, in the viewer's language.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  createInput,
  FORM_FIELDS,
  formValuesOf,
  isScheduled,
  newFormValues,
  nextHourInput,
  patchInput,
  serverFieldErrors,
  titleLength,
  validateForm,
  type FieldError,
  type FormErrors,
  type FormField,
  type FormValues,
} from './announcement-form'
import { CATEGORIES, TITLE_MAX_LENGTH, failureOf, useAnnouncement, useSaveAnnouncement, type Announcement, type ApiFailure } from './announcements'
import { useText, type Translate } from './i18n'
import { Markdown } from './markdown'
import { Link, navigate, paths } from './router'
import { BackLink, BUTTON_PRIMARY, BUTTON_SECONDARY, FailureNotice, NOTICE, PANEL, useDocumentTitle } from './ui'

const INPUT =
  'w-full rounded-lg border border-stone-300 bg-white px-3 text-base text-stone-900 shadow-xs placeholder:text-stone-400 focus-visible:border-sky-600 focus-visible:outline-offset-0 aria-invalid:border-red-500 sm:text-sm'
const LABEL = 'block text-sm font-medium text-stone-900'
const HINT = 'mt-1 text-xs leading-5 text-stone-500'

/**
 * `id` absent = a new announcement. `canPost` is unknown (`undefined`) until `/me` answers;
 * `storeUnavailable` means `/me` answered that Portal has no database yet, so nobody can post.
 */
export function AnnouncementEditor({ id, canPost, storeUnavailable }: { id?: string; canPost: boolean | undefined; storeUnavailable: boolean }) {
  const { t } = useText()
  const heading = id === undefined ? t('portal.news.write') : t('portal.editor.editTitle')
  useDocumentTitle(heading, t('portal.title'))
  return (
    <div data-portal-editor="" className="max-w-3xl">
      <BackLink to={paths.announcements}>{t('portal.news.back')}</BackLink>
      <h1 className="mb-4 text-xl font-semibold tracking-tight text-stone-900">{heading}</h1>
      {storeUnavailable ? (
        <p data-portal-news-store-unavailable="" className="text-sm text-stone-500">
          {t('portal.news.storeUnavailable')}
        </p>
      ) : canPost === undefined ? (
        <p role="status" className="text-sm text-stone-500">
          {t('portal.loading')}
        </p>
      ) : !canPost ? (
        <p role="alert" className={NOTICE}>
          {t('portal.editor.notPoster')}
        </p>
      ) : id === undefined ? (
        <AnnouncementForm initial={newFormValues()} t={t} />
      ) : (
        <EditLoader id={id} t={t} />
      )}
    </div>
  )
}

function EditLoader({ id, t }: { id: string; t: Translate }) {
  const query = useAnnouncement(id)
  if (query.data) return <AnnouncementForm key={`${query.data.id}/${query.data.updatedAt}`} existing={query.data} initial={formValuesOf(query.data)} t={t} />
  if (query.error) {
    const failure = failureOf(query.error)
    if (failure.kind === 'notFound') {
      return (
        <p role="alert" className={NOTICE}>
          {t('portal.news.notFound')}
        </p>
      )
    }
    return <p className={NOTICE}>{saveFailureText(failure, t)}</p>
  }
  return (
    <p role="status" className="text-sm text-stone-500">
      {t('portal.news.loading')}
    </p>
  )
}

function saveFailureText(failure: ApiFailure, t: Translate): string {
  switch (failure.kind) {
    case 'invalid':
      return t('portal.editor.error.invalid')
    case 'denied':
      return t('portal.editor.error.denied')
    case 'notFound':
      return t('portal.editor.error.notFound')
    case 'storeUnavailable':
      return t('portal.news.storeUnavailable')
    case 'unavailable':
      return t('portal.editor.error.unavailable')
  }
}

function errorText(error: FieldError | undefined, t: Translate): string | undefined {
  return error ? t(error.id, error.values) : undefined
}

function Field({
  id,
  label,
  hint,
  error,
  trailing,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className={LABEL}>
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

const describedBy = (id: string, error: unknown, hint: boolean) => [error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined

function AnnouncementForm({ existing, initial, t }: { existing?: Announcement; initial: FormValues; t: Translate }) {
  const baseId = useId()
  const fieldId = (field: string) => `${baseId}-${field}`
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitted, setSubmitted] = useState(false)
  const [preview, setPreview] = useState(false)
  const save = useSaveAnnouncement()
  const summaryRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<FormField | null>(null)

  // Once a submit was attempted, fields re-validate as they change so a fixed error clears right away.
  const update = (patch: Partial<FormValues>) => {
    const next = { ...values, ...patch }
    setValues(next)
    if (submitted) setErrors(validateForm(next, new Date()))
  }

  useEffect(() => {
    const field = pendingFocus.current
    if (!field) return
    pendingFocus.current = null
    document.getElementById(fieldId(field))?.focus()
  })

  const submit = () => {
    const now = new Date()
    const found = validateForm(values, now)
    setSubmitted(true)
    setErrors(found)
    const first = FORM_FIELDS.find((field) => found[field])
    if (first) {
      if (first === 'body') setPreview(false)
      pendingFocus.current = first
      return
    }
    save.mutate(existing ? { id: existing.id, input: patchInput(values, initial, now) } : { input: createInput(values) }, {
      onSuccess: (saved) => navigate(paths.announcement(saved.id), { replace: true }),
      onError: (error) => {
        const failure = failureOf(error)
        const fromServer = failure.kind === 'invalid' ? serverFieldErrors(failure.message, values) : undefined
        if (!fromServer) return
        // A reason the form knows becomes that field's error; the generic save notice is not shown as well.
        setErrors(fromServer)
        pendingFocus.current = FORM_FIELDS.find((field) => fromServer[field]) ?? null
        if (fromServer.body) setPreview(false)
        save.reset()
      },
    })
  }

  useEffect(() => {
    if (save.isError) summaryRef.current?.focus()
  }, [save.isError])

  const now = new Date()
  const hasErrors = FORM_FIELDS.some((field) => errors[field])
  const submitLabel = save.isPending
    ? t('portal.editor.saving')
    : existing
      ? t('portal.editor.submitSave')
      : isScheduled(values, now)
        ? t('portal.editor.submitSchedule')
        : t('portal.editor.submitPublish')
  const saveFailure = save.error ? failureOf(save.error) : undefined
  const titleError = errorText(errors.title, t)
  const bodyError = errorText(errors.body, t)
  const publishError = errorText(errors.publishAt, t)
  const expiresError = errorText(errors.expiresAt, t)
  const categoryError = errorText(errors.category, t)
  const count = titleLength(values.title)

  return (
    <form
      noValidate
      className={`${PANEL} space-y-6 px-4 py-5 sm:px-6 sm:py-6`}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {hasErrors ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {t('portal.editor.error.summary')}
        </p>
      ) : null}

      <Field
        id={fieldId('title')}
        label={t('portal.editor.title')}
        error={titleError}
        trailing={
          <span className={`text-xs tabular-nums ${count > TITLE_MAX_LENGTH ? 'font-medium text-red-700' : 'text-stone-500'}`}>
            {t('portal.editor.titleCount', { count, max: TITLE_MAX_LENGTH })}
          </span>
        }
      >
        <input
          id={fieldId('title')}
          type="text"
          value={values.title}
          onChange={(event) => update({ title: event.target.value })}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={describedBy(fieldId('title'), titleError, false)}
          autoComplete="off"
          className={`${INPUT} h-11 text-[15px] font-medium`}
        />
      </Field>

      <fieldset aria-describedby={categoryError ? `${fieldId('category')}-error` : undefined}>
        <legend className={LABEL}>{t('portal.news.category')}</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {CATEGORIES.map((category, index) => (
            <label
              key={category}
              className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 text-sm text-stone-800 has-checked:border-blue-600 has-checked:bg-blue-50 has-checked:text-blue-900 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-sky-600 md:min-h-9"
            >
              <input
                id={index === 0 ? fieldId('category') : undefined}
                type="radio"
                name={fieldId('category')}
                value={category}
                checked={values.category === category}
                onChange={() => update({ category })}
                className="size-4 accent-blue-600 focus-visible:outline-none"
              />
              {t(`portal.news.category.${category}`)}
            </label>
          ))}
        </div>
        {categoryError ? (
          <p id={`${fieldId('category')}-error`} className="mt-1.5 text-sm text-red-700">
            {categoryError}
          </p>
        ) : null}
      </fieldset>

      <Field
        id={fieldId('body')}
        label={t('portal.editor.body')}
        error={bodyError}
        hint={preview ? undefined : t('portal.editor.bodyHint')}
        trailing={
          <span className="inline-flex rounded-lg bg-stone-100 p-0.5" role="group" aria-label={t('portal.editor.body')}>
            {(['write', 'preview'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={preview === (mode === 'preview')}
                onClick={() => setPreview(mode === 'preview')}
                className="min-h-8 rounded-md px-2.5 text-xs font-medium text-stone-600 aria-pressed:bg-white aria-pressed:text-stone-900 aria-pressed:shadow-xs"
              >
                {t(`portal.editor.tab.${mode}`)}
              </button>
            ))}
          </span>
        }
      >
        <textarea
          id={fieldId('body')}
          hidden={preview}
          value={values.body}
          onChange={(event) => update({ body: event.target.value })}
          rows={12}
          aria-invalid={bodyError ? true : undefined}
          aria-describedby={describedBy(fieldId('body'), bodyError, true)}
          className={`${INPUT} min-h-48 resize-y py-2.5 font-mono text-[13px] leading-6`}
        />
        {preview ? (
          <div data-portal-editor-preview="" className="min-h-48 rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
            {values.body.trim() ? <Markdown source={values.body} /> : <p className="text-sm text-stone-500">{t('portal.editor.previewEmpty')}</p>}
          </div>
        ) : null}
      </Field>

      <div>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={values.pinned}
            onChange={(event) => update({ pinned: event.target.checked })}
            aria-describedby={fieldId('pinned-hint')}
            className="mt-0.5 size-4 shrink-0 accent-blue-600"
          />
          <span>
            <span className={LABEL}>{t('portal.editor.pinned')}</span>
            <span id={fieldId('pinned-hint')} className={`block ${HINT}`}>
              {t('portal.editor.pinnedHint')}
            </span>
          </span>
        </label>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <fieldset>
          <legend className={LABEL}>{t('portal.editor.publish')}</legend>
          <div className="mt-1.5 flex flex-col gap-1">
            {(['now', 'at'] as const).map((mode) => (
              <label key={mode} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-stone-800">
                <input
                  type="radio"
                  name={fieldId('publish')}
                  value={mode}
                  checked={values.publishMode === mode}
                  onChange={() => update({ publishMode: mode, publishAt: mode === 'at' && values.publishAt === '' ? nextHourInput(new Date()) : values.publishAt })}
                  className="size-4 accent-blue-600"
                />
                {mode === 'now' ? t('portal.editor.publishNow') : t('portal.editor.publishAt')}
              </label>
            ))}
          </div>
          {values.publishMode === 'at' ? (
            <div className="mt-2">
              <label htmlFor={fieldId('publishAt')} className="sr-only">
                {t('portal.editor.publishAtLabel')}
              </label>
              <input
                id={fieldId('publishAt')}
                type="datetime-local"
                value={values.publishAt}
                onChange={(event) => update({ publishAt: event.target.value })}
                aria-invalid={publishError ? true : undefined}
                aria-describedby={describedBy(fieldId('publishAt'), publishError, false)}
                className={`${INPUT} h-11`}
              />
              {publishError ? (
                <p id={`${fieldId('publishAt')}-error`} className="mt-1.5 text-sm text-red-700">
                  {publishError}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <Field id={fieldId('expiresAt')} label={t('portal.editor.expires')} error={expiresError} hint={t('portal.editor.expiresHint')}>
          <input
            id={fieldId('expiresAt')}
            type="datetime-local"
            value={values.expiresAt}
            onChange={(event) => update({ expiresAt: event.target.value })}
            aria-invalid={expiresError ? true : undefined}
            aria-describedby={describedBy(fieldId('expiresAt'), expiresError, true)}
            className={`${INPUT} h-11`}
          />
        </Field>
      </div>

      {saveFailure ? (
        <div ref={summaryRef} tabIndex={-1} data-portal-save-error={saveFailure.kind} className="focus:outline-none">
          {saveFailure.kind === 'unavailable' ? (
            <FailureNotice message={saveFailureText(saveFailure, t)} />
          ) : (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p>{saveFailureText(saveFailure, t)}</p>
            </div>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-100 pt-5">
        <Link to={existing ? paths.announcement(existing.id) : paths.announcements} className={BUTTON_SECONDARY}>
          {t('portal.news.cancel')}
        </Link>
        <button type="submit" className={BUTTON_PRIMARY} disabled={save.isPending}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
