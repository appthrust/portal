// Announcements (お知らせ) on the page: the home block (pinned and important
// first, five rows), the list of every announcement (`/announcements`; posters
// see scheduled and ended ones too, each labelled with its state) and one
// announcement (`/announcements/<id>`), which marks itself read on open.
import { CheckCheck, ChevronRight, PenLine, Pencil, Pin, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import {
  HOME_ROWS,
  failureOf,
  homeOrder,
  useAnnouncement,
  useAnnouncementPages,
  useDeleteAnnouncement,
  useHomeAnnouncements,
  useMarkAllRead,
  useMarkRead,
  type AnnouncementState,
  type AnnouncementSummary,
  type ApiFailure,
  type Category,
} from './announcements'
import { formatDateTime, formatShortDate } from './format'
import { useText, type Translate } from './i18n'
import { Markdown } from './markdown'
import { Link, navigate, paths } from './router'
import {
  BackLink,
  BUTTON_DANGER,
  BUTTON_GHOST,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  FailureNotice,
  NOTICE,
  PANEL,
  SectionHeading,
  useDocumentTitle,
} from './ui'

const CHIP = 'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs leading-4 font-medium'

const CATEGORY_CHIP: Record<Category, string> = {
  info: 'bg-stone-100 text-stone-700',
  important: 'bg-red-50 text-red-700 ring-1 ring-red-200 ring-inset',
  event: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 ring-inset',
}

export function CategoryChip({ category, t }: { category: Category; t: Translate }) {
  return (
    <span data-portal-category={category} className={`${CHIP} ${CATEGORY_CHIP[category]}`}>
      <span className="sr-only">{t('portal.news.category')}: </span>
      {t(`portal.news.category.${category}`)}
    </span>
  )
}

const STATE_LABEL: Record<AnnouncementState, string> = {
  scheduled: 'border-sky-200 bg-sky-50 text-sky-800',
  published: 'border-stone-200 bg-white text-stone-600',
  expired: 'border-stone-200 bg-stone-100 text-stone-500',
}

export function StateLabel({ state, t }: { state: AnnouncementState; t: Translate }) {
  return (
    <span data-portal-state={state} className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs leading-4 font-medium ${STATE_LABEL[state]}`}>
      <span className="sr-only">{t('portal.news.state')}: </span>
      {t(`portal.news.state.${state}`)}
    </span>
  )
}

function PinnedMark({ t }: { t: Translate }) {
  return (
    <span data-portal-pinned="" className="inline-flex shrink-0 items-center gap-0.5 text-xs text-stone-500">
      <Pin aria-hidden className="size-3.5" />
      {t('portal.news.pinned')}
    </span>
  )
}

function UnreadCount({ count, t }: { count: number; t: Translate }) {
  return (
    <span data-portal-unread-count={count} className="rounded-full bg-blue-600 px-2 py-0.5 text-xs leading-4 font-semibold text-white tabular-nums">
      {t('portal.news.unread', { count })}
    </span>
  )
}

/**
 * One announcement as a row: unread dot, category, pinned, title and date.
 * `detailed` adds the excerpt and the author (the list page) and the state label for posters.
 */
function AnnouncementRow({ item, detailed, showState, now }: { item: AnnouncementSummary; detailed: boolean; showState: boolean; now: Date }) {
  const { t, language } = useText()
  return (
    <li>
      <Link
        to={paths.announcement(item.id)}
        data-portal-announcement={item.id}
        data-portal-unread={item.read ? undefined : ''}
        className="group flex items-start gap-3 px-4 py-3 hover:bg-stone-50 focus-visible:-outline-offset-2"
      >
        <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${item.read ? 'bg-transparent' : 'bg-blue-600'}`} />
        <span className={`flex min-w-0 flex-1 flex-col gap-1 ${detailed ? '' : 'sm:flex-row sm:items-center sm:gap-3'}`}>
          <span className="flex flex-wrap items-center gap-2">
            <CategoryChip category={item.category} t={t} />
            {item.pinned ? <PinnedMark t={t} /> : null}
            {showState ? <StateLabel state={item.state} t={t} /> : null}
          </span>
          <span
            className={`min-w-0 text-[15px] leading-6 group-hover:underline group-hover:underline-offset-4 ${
              item.read ? 'text-stone-700' : 'font-semibold text-stone-900'
            } ${detailed ? '' : 'line-clamp-2 sm:line-clamp-none sm:truncate'}`}
          >
            {item.read ? null : <span className="sr-only">{t('portal.news.unreadMark')}: </span>}
            {item.title}
          </span>
          {detailed && item.excerpt ? <span className="line-clamp-2 text-sm leading-6 text-stone-500">{item.excerpt}</span> : null}
          {detailed ? <span className="text-xs text-stone-500">{t('portal.news.by', { name: item.author.name })}</span> : null}
        </span>
        <time dateTime={item.publishedAt} className="shrink-0 pt-0.5 text-xs leading-5 text-stone-500 tabular-nums">
          {formatShortDate(language, item.publishedAt, now)}
        </time>
      </Link>
    </li>
  )
}

/** The block body for a failed request: quiet for a missing store, an alert otherwise. */
function FailureBody({ failure, t, onRetry }: { failure: ApiFailure; t: Translate; onRetry: () => void }) {
  if (failure.kind === 'storeUnavailable') {
    return (
      <p data-portal-news-store-unavailable="" className="text-sm text-stone-500">
        {t('portal.news.storeUnavailable')}
      </p>
    )
  }
  if (failure.kind === 'denied') {
    return (
      <p role="alert" className={NOTICE}>
        {t('portal.news.denied')}
      </p>
    )
  }
  return <FailureNotice message={t('portal.news.unavailable')} retryLabel={t('portal.retry')} onRetry={onRetry} />
}

function MarkAllReadButton({ t }: { t: Translate }) {
  const markAll = useMarkAllRead()
  return (
    <>
      <button type="button" className={BUTTON_GHOST} disabled={markAll.isPending} onClick={() => markAll.mutate()}>
        <CheckCheck aria-hidden />
        {t('portal.news.markAllRead')}
      </button>
      {markAll.isError ? (
        <p role="alert" className="w-full text-right text-xs text-red-700">
          {t('portal.news.markAllReadFailed')}
        </p>
      ) : null}
    </>
  )
}

function WriteLink({ t }: { t: Translate }) {
  return (
    <Link to={paths.newAnnouncement} data-portal-write="" className={BUTTON_PRIMARY}>
      <PenLine aria-hidden />
      {t('portal.news.write')}
    </Link>
  )
}

/** Home: the newest announcements, pinned and important first, five rows, then a link to all of them. */
export function AnnouncementsBlock({ canPost, now }: { canPost: boolean; now: Date }) {
  const { t } = useText()
  const headingId = useId()
  const query = useHomeAnnouncements()
  const failure = query.error ? failureOf(query.error) : undefined
  const page = failure ? undefined : query.data
  const unread = page?.unreadCount ?? 0
  const rows = page ? homeOrder(page.items).slice(0, HOME_ROWS) : []
  return (
    <section aria-labelledby={headingId} data-portal-news="" className="mt-8">
      <SectionHeading
        id={headingId}
        title={t('portal.news.title')}
        meta={unread > 0 ? <UnreadCount count={unread} t={t} /> : null}
        actions={
          page ? (
            <>
              {unread > 0 ? <MarkAllReadButton t={t} /> : null}
              {canPost ? <WriteLink t={t} /> : null}
            </>
          ) : null
        }
      />
      {failure ? <FailureBody failure={failure} t={t} onRetry={() => void query.refetch()} /> : null}
      {!failure && !page ? (
        <p role="status" className="text-sm text-stone-500">
          {t('portal.news.loading')}
        </p>
      ) : null}
      {page ? (
        <div className={PANEL}>
          {rows.length === 0 ? (
            <p data-portal-news-empty="" className="px-4 py-6 text-sm text-stone-500">
              {canPost ? t('portal.news.emptyPoster') : t('portal.news.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {rows.map((item) => (
                <AnnouncementRow key={item.id} item={item} detailed={false} showState={false} now={now} />
              ))}
            </ul>
          )}
          {rows.length > 0 || canPost ? (
            <Link
              to={paths.announcements}
              data-portal-view-all=""
              className="flex min-h-11 items-center justify-end gap-1 border-t border-stone-100 px-4 text-sm font-medium text-blue-700 hover:bg-stone-50 hover:text-blue-800 focus-visible:-outline-offset-2"
            >
              {t('portal.news.viewAll')}
              <ChevronRight aria-hidden className="size-4" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/**
 * `/announcements`: every announcement a page at a time. `canPost` is unknown
 * (`undefined`) until `/me` answers; posters then list `scope=all`.
 */
export function AnnouncementsPage({ canPost, now }: { canPost: boolean | undefined; now: Date }) {
  const { t } = useText()
  useDocumentTitle(t('portal.news.title'), t('portal.title'))
  const poster = canPost === true
  const query = useAnnouncementPages(poster ? 'all' : 'published', canPost !== undefined)
  const failure = query.error && !query.data ? failureOf(query.error) : undefined
  const pages = query.data?.pages ?? []
  const items = pages.flatMap((page) => page.items)
  const unread = pages[0]?.unreadCount ?? 0
  return (
    <div data-portal-news-page="" className="max-w-3xl">
      <BackLink to={paths.home}>{t('portal.backHome')}</BackLink>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-stone-900">{t('portal.news.title')}</h1>
        {unread > 0 ? <UnreadCount count={unread} t={t} /> : null}
        {query.data ? (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {unread > 0 ? <MarkAllReadButton t={t} /> : null}
            {poster ? <WriteLink t={t} /> : null}
          </div>
        ) : null}
      </div>
      {poster && query.data ? <p className="mb-3 text-sm text-stone-500">{t('portal.news.posterScope')}</p> : null}
      {failure ? <FailureBody failure={failure} t={t} onRetry={() => void query.refetch()} /> : null}
      {!failure && !query.data ? (
        <p role="status" className="text-sm text-stone-500">
          {t('portal.news.loading')}
        </p>
      ) : null}
      {query.data ? (
        items.length === 0 ? (
          <p data-portal-news-empty="" className={NOTICE}>
            {poster ? t('portal.news.emptyPoster') : t('portal.news.empty')}
          </p>
        ) : (
          <div className={PANEL}>
            <ul className="divide-y divide-stone-100">
              {items.map((item) => (
                <AnnouncementRow key={item.id} item={item} detailed showState={poster} now={now} />
              ))}
            </ul>
          </div>
        )
      ) : null}
      {query.hasNextPage ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          <button type="button" className={BUTTON_SECONDARY} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? t('portal.loading') : t('portal.news.loadMore')}
          </button>
          {query.isFetchNextPageError ? (
            <p role="alert" className="text-sm text-red-700">
              {t('portal.news.loadMoreFailed')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** `/announcements/<id>`: the announcement, rendered Markdown, read on open; posters can edit or delete it. */
export function AnnouncementDetail({ id, canPost }: { id: string; canPost: boolean }) {
  const { t, language } = useText()
  const query = useAnnouncement(id)
  const { mutate: markAsRead } = useMarkRead()
  const marked = useRef<string | null>(null)
  const item = query.data
  useDocumentTitle(item?.title ?? '', t('portal.news.title'), t('portal.title'))
  useEffect(() => {
    if (!item || item.read || marked.current === item.id) return
    marked.current = item.id
    markAsRead(item.id)
  }, [item, markAsRead])

  const failure = query.error && !item ? failureOf(query.error) : undefined
  return (
    <div data-portal-news-detail="" className="max-w-3xl">
      <BackLink to={paths.announcements}>{t('portal.news.back')}</BackLink>
      {failure?.kind === 'notFound' ? (
        <p role="alert" className={NOTICE}>
          {t('portal.news.notFound')}
        </p>
      ) : failure ? (
        <FailureBody failure={failure} t={t} onRetry={() => void query.refetch()} />
      ) : null}
      {!failure && !item ? (
        <p role="status" className="text-sm text-stone-500">
          {t('portal.news.loading')}
        </p>
      ) : null}
      {item ? (
        <article aria-labelledby="announcement-title" className={`${PANEL} px-5 py-6 sm:px-8 sm:py-8`}>
          <div className="flex flex-wrap items-center gap-2">
            <CategoryChip category={item.category} t={t} />
            {item.pinned ? <PinnedMark t={t} /> : null}
            {canPost ? <StateLabel state={item.state} t={t} /> : null}
          </div>
          <h1 id="announcement-title" className="mt-3 text-2xl leading-snug font-bold tracking-tight text-pretty text-stone-900">
            {item.title}
          </h1>
          <p data-portal-news-meta="" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-500">
            <span>{t('portal.news.by', { name: item.author.name })}</span>
            <time dateTime={item.publishedAt}>
              {t(item.state === 'scheduled' ? 'portal.news.publishesOn' : 'portal.news.publishedOn', { date: formatDateTime(language, item.publishedAt) })}
            </time>
            {item.updatedAt !== item.createdAt ? (
              <time dateTime={item.updatedAt}>{t('portal.news.updatedOn', { date: formatDateTime(language, item.updatedAt) })}</time>
            ) : null}
            {item.expiresAt ? (
              <time dateTime={item.expiresAt}>
                {t(item.state === 'expired' ? 'portal.news.endedOn' : 'portal.news.shownUntil', { date: formatDateTime(language, item.expiresAt) })}
              </time>
            ) : null}
          </p>
          {item.body.trim() ? <Markdown source={item.body} className="mt-6 border-t border-stone-100 pt-6" /> : null}
          {canPost ? <PosterActions id={item.id} t={t} /> : null}
        </article>
      ) : null}
    </div>
  )
}

function PosterActions({ id, t }: { id: string; t: Translate }) {
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteAnnouncement()
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])
  return (
    <div className="mt-8 border-t border-stone-100 pt-5">
      {confirming ? (
        <div role="group" aria-labelledby={`delete-${id}`} className="flex flex-wrap items-center gap-3 rounded-lg bg-red-50 px-4 py-3">
          <p id={`delete-${id}`} className="min-w-0 flex-1 text-sm text-red-900">
            {t('portal.news.deleteConfirm')}
          </p>
          <div className="flex gap-2">
            <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirming(false)} disabled={remove.isPending}>
              {t('portal.news.cancel')}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={BUTTON_DANGER}
              disabled={remove.isPending}
              onClick={() => remove.mutate(id, { onSuccess: () => navigate(paths.announcements, { replace: true }) })}
            >
              {remove.isPending ? t('portal.news.deleting') : t('portal.news.deleteConfirmAction')}
            </button>
          </div>
          {remove.isError ? (
            <p role="alert" className="w-full text-sm text-red-700">
              {t('portal.news.deleteFailed')}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Link to={paths.editAnnouncement(id)} className={BUTTON_SECONDARY}>
            <Pencil aria-hidden />
            {t('portal.news.edit')}
          </Link>
          <button type="button" className={`${BUTTON_GHOST} text-red-700 hover:bg-red-50 hover:text-red-800`} onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden />
            {t('portal.news.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
