// The apps part of the home. **アプリ**: every installed app except Portal as a
// compact tile in the viewer's language (catalog `locales`, falling back to
// the served name/description). Then the employee-portal sections: one quiet
// line per provider that could not answer, then the sections exactly as the
// server ordered them (owner → group → project). Providers decide what a
// viewer sees and how it opens (employee-portal.md §3.5); this file only
// renders it.
import { iconFor } from '@appthrust/app-launcher'
import type { DashboardLanguage } from '@appthrust/platform-dashboard-i18n'
import { ArrowUpRight, CircleAlert, Lock } from 'lucide-react'
import { useId } from 'react'
import {
  installedAppText,
  isNavigable,
  matchesInstalledApp,
  tileApps,
  type AppEntry,
  type HomeResponse,
  type HomeSection,
  type HomeState,
  type InstalledApp,
} from './home'
import { useText, type Translate } from './i18n'
import { BUTTON_GHOST, FailureNotice, NOTICE, SectionHeading } from './ui'

const CARD = 'flex w-full min-w-0 flex-col rounded-xl border border-stone-200 bg-white p-4 text-stone-900'
const BADGE = 'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-4 font-medium [&_svg]:size-3'

/**
 * The **アプリ** block and the provider sections under it. The home request's
 * loading and failure states show once, under the **アプリ** heading.
 * `search` filters the tiles as typed; `q` is the settled search the sections were asked for.
 */
export function HomeApps({
  state,
  stale,
  search,
  q,
  dashboardUrl,
  onRetry,
}: {
  state: HomeState
  stale: boolean
  search: string
  q: string
  dashboardUrl: string
  onRetry: () => void
}) {
  const { t, language } = useText()
  const headingId = useId()
  return (
    <>
      <section aria-labelledby={headingId} data-portal-installed="" className="mt-10">
        <SectionHeading
          id={headingId}
          title={t('portal.apps.title')}
          actions={
            <a href={dashboardUrl} className={`${BUTTON_GHOST} -mr-2.5`}>
              {t('portal.apps.manage')}
              <ArrowUpRight aria-hidden />
            </a>
          }
        />
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-stone-500">
            {t('portal.apps.loading')}
          </p>
        ) : null}
        {state.status === 'denied' ? (
          <p role="alert" className={NOTICE}>
            {t('portal.apps.denied')}
          </p>
        ) : null}
        {state.status === 'unavailable' ? <FailureNotice message={t('portal.apps.unavailable')} retryLabel={t('portal.retry')} onRetry={onRetry} /> : null}
        {state.status === 'ready' ? <InstalledApps apps={state.home.installedApps} search={search} t={t} language={language} /> : null}
      </section>
      {state.status === 'ready' ? <ProviderSections home={state.home} stale={stale} q={q} t={t} language={language} /> : null}
    </>
  )
}

function InstalledApps({ apps, search, t, language }: { apps: InstalledApp[]; search: string; t: Translate; language: DashboardLanguage }) {
  const tiles = tileApps(apps)
  if (tiles.length === 0) {
    return <p className="text-sm text-stone-500">{t('portal.apps.installedEmpty')}</p>
  }
  const matching = tiles.filter((app) => matchesInstalledApp(app, search, language))
  if (matching.length === 0) {
    return (
      <p data-portal-installed-no-matches="" className="text-sm text-stone-500">
        {t('portal.apps.installedNoMatches')}
      </p>
    )
  }
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">
      {matching.map((app) => (
        <li key={app.definitionId} className="flex min-w-0">
          <AppTile app={app} t={t} language={language} />
        </li>
      ))}
    </ul>
  )
}

const TILE = 'flex w-full min-w-0 items-start gap-3 rounded-xl border border-stone-200 bg-white px-3 py-3 text-stone-900'

const PHASE_BADGE: Record<Exclude<InstalledApp['phase'], 'Ready'>, string> = {
  Pending: 'border-sky-200 bg-sky-50 text-sky-800',
  Installing: 'border-sky-200 bg-sky-50 text-sky-800',
  Upgrading: 'border-sky-200 bg-sky-50 text-sky-800',
  Degraded: 'border-amber-300 bg-amber-50 text-amber-900',
  Uninstalling: 'border-stone-200 bg-stone-100 text-stone-600',
}

// One box per app: icon, localized title (with a status badge when the app is not Ready), one-line tagline. No hostname.
function AppTile({ app, t, language }: { app: InstalledApp; t: Translate; language: DashboardLanguage }) {
  const Icon = iconFor(app.icon)
  const { title, tagline } = installedAppText(app, language)
  const content = (
    <>
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span data-portal-app-title="" className="min-w-0 truncate text-[15px] leading-5 font-medium">
            {title}
          </span>
          {app.phase === 'Ready' ? null : (
            <span data-portal-phase={app.phase} className={`${BADGE} ${PHASE_BADGE[app.phase]}`}>
              {t(`portal.apps.phase.${app.phase}`)}
            </span>
          )}
        </span>
        {tagline ? (
          <span data-portal-app-tagline="" className="mt-0.5 line-clamp-2 block text-xs leading-5 text-stone-500">
            {tagline}
          </span>
        ) : null}
      </span>
    </>
  )
  if (!isNavigable(app)) {
    return (
      <div aria-disabled="true" data-portal-app={app.definitionId} className={`${TILE} cursor-not-allowed opacity-60`}>
        {content}
      </div>
    )
  }
  return (
    <a
      href={app.url}
      data-portal-app={app.definitionId}
      className={`${TILE} shadow-xs transition-[border-color,box-shadow] hover:border-stone-300 hover:shadow-md`}
    >
      {content}
    </a>
  )
}

function ProviderSections({ home, stale, q, t, language }: { home: HomeResponse; stale: boolean; q: string; t: Translate; language: DashboardLanguage }) {
  const unavailable = home.sources.filter((source) => source.state === 'unavailable')
  const sections = home.sections.filter((section) => section.entries.length > 0)
  const empty = sections.length === 0 && home.sources.every((source) => source.state === 'ready')
  return (
    <div data-portal-apps="" aria-busy={stale} className={stale ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      {unavailable.length > 0 ? (
        <ul className="mt-6 space-y-1">
          {unavailable.map((source) => {
            const installed = home.installedApps.find((item) => item.definitionId === source.definitionId)
            const name = installed ? installedAppText(installed, language).title : source.definitionId
            return (
              <li
                key={source.definitionId}
                data-portal-source-unavailable={source.definitionId}
                className="flex items-start gap-1.5 text-sm text-stone-500"
              >
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-stone-400" />
                <span>{t('portal.apps.sourceUnavailable', { name })}</span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {sections.map((section) => (
        <AppSection key={`${section.relation}/${section.group?.id ?? ''}`} section={section} t={t} />
      ))}
      {empty ? (
        <p data-portal-apps-empty="" className="mt-8 text-sm text-stone-500">
          {q.trim() === '' ? t('portal.apps.empty') : t('portal.apps.noMatches')}
        </p>
      ) : null}
    </div>
  )
}

function sectionHeading(section: HomeSection, t: Translate): string {
  if (section.relation === 'owner') return t('portal.apps.owner')
  if (section.relation === 'project') return t('portal.apps.project')
  return section.group ? t('portal.apps.group', { name: section.group.name }) : t('portal.apps.groupUnnamed')
}

function AppSection({ section, t }: { section: HomeSection; t: Translate }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-portal-section={section.relation} className="mt-8">
      <div className="mb-3 min-w-0">
        <h2 id={headingId} className="text-base font-semibold tracking-tight text-stone-900">
          {sectionHeading(section, t)}
        </h2>
        {section.relation === 'group' && section.group ? (
          <p title={section.group.path} className="mt-0.5 truncate text-xs text-stone-500">
            {section.group.path}
          </p>
        ) : null}
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {section.entries.map((entry) => (
          <li key={`${entry.sourceDefinitionId}/${entry.id}`} className="flex min-w-0">
            <AppCard entry={entry} t={t} />
          </li>
        ))}
      </ul>
    </section>
  )
}

// Same anatomy as the installed app cards (one box, icon tile, two-line description,
// footer row) with a lighter tile, so apps read as a different kind of thing.
function AppCard({ entry, t }: { entry: AppEntry; t: Translate }) {
  const Icon = iconFor(entry.icon)
  const openUrl = entry.state === 'ready' ? entry.url : undefined
  const body = (
    <>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-blue-100 ring-inset">
          <Icon aria-hidden className="size-5" />
        </span>
        <h3 title={entry.name} className="min-w-0 flex-1 truncate text-[15px] leading-5 font-medium">
          {entry.name}
        </h3>
      </div>
      {entry.description ? <p className="mt-3 line-clamp-2 text-xs leading-5 text-stone-500">{entry.description}</p> : null}
      {entry.tags.length > 0 ? (
        <ul aria-label={t('portal.apps.tags')} className="mt-3 flex flex-wrap gap-1">
          {entry.tags.map((tag) => (
            <li key={tag} className="rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] leading-4 text-stone-600">
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
      {/* min-h-9 = pt-3 + a 24px row, so footers line up across cards. */}
      <div className="mt-auto flex min-h-9 items-center gap-2 pt-3">
        {entry.state === 'preparing' ? (
          <span data-portal-badge="preparing" className={`${BADGE} border-sky-200 bg-sky-50 text-sky-800`}>
            {t('portal.apps.preparing')}
          </span>
        ) : null}
        {entry.state === 'restricted' ? (
          <span data-portal-badge="restricted" className={`${BADGE} border-amber-300 bg-amber-50 text-amber-900`}>
            <Lock aria-hidden />
            {t('portal.apps.restricted')}
          </span>
        ) : null}
        <span className="flex-1" />
        {openUrl ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-stone-600 group-hover:text-blue-700">
            {t('portal.apps.open')}
            <ArrowUpRight aria-hidden className="size-3.5" />
            <span className="sr-only">{t('portal.apps.newTab')}</span>
          </span>
        ) : null}
        {entry.state === 'restricted' && entry.detailUrl ? (
          <a
            href={entry.detailUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="-my-1 inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium text-stone-700 underline-offset-4 hover:bg-stone-100 hover:text-stone-900 hover:underline"
          >
            {t('portal.apps.details')}
            <ArrowUpRight aria-hidden className="size-3.5" />
            <span className="sr-only">{t('portal.apps.newTab')}</span>
          </a>
        ) : null}
      </div>
    </>
  )
  if (openUrl) {
    return (
      <a
        href={openUrl}
        target="_blank"
        rel="noreferrer noopener"
        data-portal-entry={entry.id}
        data-portal-entry-state="ready"
        className={`${CARD} group shadow-xs transition-[border-color,box-shadow] hover:border-stone-300 hover:shadow-md`}
      >
        {body}
      </a>
    )
  }
  if (entry.state === 'restricted') {
    return (
      <div data-portal-entry={entry.id} data-portal-entry-state="restricted" className={CARD}>
        {body}
      </div>
    )
  }
  return (
    <div aria-disabled="true" data-portal-entry={entry.id} data-portal-entry-state="preparing" className={`${CARD} cursor-not-allowed opacity-60`}>
      {body}
    </div>
  )
}
