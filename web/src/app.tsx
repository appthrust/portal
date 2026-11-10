// The portal: an intranet home under a header carrying the same app switcher
// every installed app shows. Routes (src/router.tsx): `/` home,
// `/announcements` all announcements, `/announcements/<id>` one, plus the
// poster's editor. The home reads, top to bottom: greeting (`/me`) with
// today's date and the app search box, お知らせ, アプリ (installed apps from
// `/api/portal/v1/home`), then the `launcher.entries/v1` provider sections.
// The Project display name comes with `/launcher`.
import { AppSwitcher, projectDisplayName, useLauncher, type LauncherProject } from '@appthrust/app-launcher'
import { useQuery } from '@tanstack/react-query'
import { House, Languages, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnnouncementEditor } from './announcement-editor'
import { AnnouncementDetail, AnnouncementsBlock, AnnouncementsPage } from './announcement-views'
import { failureOf, useMe } from './announcements'
import { configQuery, type PortalConfig } from './config'
import { dayPart, formatToday, localDateValue } from './format'
import { useDebouncedValue, useHome } from './home'
import { HomeApps } from './home-apps'
import { setLanguage, useText } from './i18n'
import { Link, matchRoute, paths, usePathname, type Route } from './router'
import { BackLink, BUTTON_GHOST, useDocumentTitle } from './ui'

/** The server rejects longer searches (`invalid_query`). */
const SEARCH_MAX_LENGTH = 128

/** `project` is known once `/launcher` answers; until then the header shows no project at all (never the raw id). */
function Shell({ project, children }: { project?: LauncherProject; children: ReactNode }) {
  const { t, language } = useText()
  const other = language === 'ja' ? 'en' : 'ja'
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 min-h-10 content-center rounded-md bg-white px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('portal.skipToMain')}
      </a>
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-3 sm:px-6">
          <span className="flex min-w-0 items-center gap-2.5">
            <Link to={paths.home} className="flex shrink-0 items-center gap-2.5 rounded-md">
              <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-white">
                <House className="size-4" />
              </span>
              <span className="text-[15px] font-semibold tracking-tight text-stone-900">{t('portal.title')}</span>
            </Link>
            {project ? (
              <>
                <span aria-hidden className="shrink-0 text-stone-300">
                  /
                </span>
                <span data-portal-project="" title={project.id} className="min-w-0 truncate text-[15px] text-stone-600">
                  <span className="sr-only">{t('portal.project')}: </span>
                  {projectDisplayName(project)}
                </span>
              </>
            ) : null}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <AppSwitcher language={language} />
            <button
              type="button"
              className={BUTTON_GHOST}
              aria-label={`${t('portal.language')}: ${t(`portal.language.${other}`)}`}
              onClick={() => setLanguage(other)}
            >
              <Languages aria-hidden />
              <span lang={other} className="hidden sm:inline">
                {t(`portal.language.${other}`)}
              </span>
            </button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 py-6 focus:outline-none sm:px-6 md:py-8">
        {children}
      </main>
    </div>
  )
}

function Greeting({ name, now, search, onSearch }: { name: string | undefined; now: Date; search: string; onSearch: (value: string) => void }) {
  const { t, language } = useText()
  const searchId = useId()
  const part = dayPart(now)
  const greeting = name?.trim() ? t(`portal.greeting.${part}`, { name: name.trim() }) : t(`portal.greeting.${part}.anonymous`)
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm text-stone-500">
          <time dateTime={localDateValue(now)}>{formatToday(language, now)}</time>
        </p>
        <h1 data-portal-greeting="" className="mt-1 text-xl leading-tight font-semibold tracking-tight text-pretty text-stone-900 sm:text-2xl">
          {greeting}
        </h1>
      </div>
      <div role="search" className="relative w-full sm:w-72 sm:shrink-0">
        <label htmlFor={searchId} className="sr-only">
          {t('portal.search.label')}
        </label>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          maxLength={SEARCH_MAX_LENGTH}
          placeholder={t('portal.search.placeholder')}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-11 w-full rounded-lg border border-stone-300 bg-white pr-3 pl-9 text-base text-stone-900 shadow-xs placeholder:text-stone-400 focus-visible:border-sky-600 focus-visible:outline-offset-0 sm:text-sm"
        />
      </div>
    </div>
  )
}

function HomePage({ config, name, canPost, now }: { config: PortalConfig; name: string | undefined; canPost: boolean; now: Date }) {
  const { t } = useText()
  useDocumentTitle(t('portal.title'))
  const [search, setSearch] = useState('')
  // App tiles filter as you type; the provider sections re-query once typing pauses.
  const q = useDebouncedValue(search.trim())
  const home = useHome(q)
  return (
    <>
      <Greeting name={name} now={now} search={search} onSearch={setSearch} />
      <AnnouncementsBlock canPost={canPost} now={now} />
      <HomeApps state={home.state} stale={home.stale} search={search} q={q} dashboardUrl={config.dashboardUrl} onRetry={home.refetch} />
    </>
  )
}

function NotFoundPage() {
  const { t } = useText()
  useDocumentTitle(t('portal.notFound.title'), t('portal.title'))
  return (
    <div>
      <BackLink to={paths.home}>{t('portal.backHome')}</BackLink>
      <h1 className="text-xl font-semibold tracking-tight text-stone-900">{t('portal.notFound.title')}</h1>
      <p className="mt-2 text-stone-600">{t('portal.notFound.body')}</p>
    </div>
  )
}

/** The page once `/config` is known; exported as the test seam for composition. */
export function PortalPage({ config, route }: { config: PortalConfig; route: Route }) {
  const launcher = useLauncher()
  const project = launcher.status === 'ready' ? launcher.project : undefined
  const me = useMe()
  // Unknown until `/me` answers; a failed `/me` (store not ready, network) means "cannot post".
  const canPost = me.data ? me.data.canPost : me.isError ? false : undefined
  const storeUnavailable = !me.data && me.isError && failureOf(me.error).kind === 'storeUnavailable'
  const now = new Date()
  return (
    <Shell project={project}>
      {route.name === 'home' ? <HomePage config={config} name={me.data?.name} canPost={canPost === true} now={now} /> : null}
      {route.name === 'announcements' ? <AnnouncementsPage canPost={canPost} now={now} /> : null}
      {route.name === 'announcement' ? <AnnouncementDetail id={route.id} canPost={canPost === true} /> : null}
      {route.name === 'newAnnouncement' ? <AnnouncementEditor canPost={canPost} storeUnavailable={storeUnavailable} /> : null}
      {route.name === 'editAnnouncement' ? <AnnouncementEditor id={route.id} canPost={canPost} storeUnavailable={storeUnavailable} /> : null}
      {route.name === 'notFound' ? <NotFoundPage /> : null}
    </Shell>
  )
}

export function App() {
  const { t } = useText()
  const config = useQuery(configQuery)
  const pathname = usePathname()
  // After an in-app navigation, move focus to the new page so screen readers start there; the first load keeps the browser's focus.
  const lastPath = useRef(pathname)
  useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname
    document.getElementById('main')?.focus()
  }, [pathname])
  if (config.data) return <PortalPage config={config.data} route={matchRoute(pathname)} />
  return (
    <Shell>
      {config.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">
          <p className="min-w-0 flex-1">{t('portal.configFailed')}</p>
          <button
            type="button"
            className="min-h-9 rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-800 hover:bg-red-100"
            onClick={() => void config.refetch()}
          >
            {t('portal.retry')}
          </button>
        </div>
      ) : (
        <p role="status" className="text-stone-500">
          {t('portal.loading')}
        </p>
      )}
    </Shell>
  )
}
