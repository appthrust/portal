// The portal's single page: one search box, every installed app of the
// project as a card (LauncherGrid), then the apps every `launcher.entries/v1`
// provider lists for this viewer (HomeApps), under a header carrying the same
// app switcher every installed app shows. No router: the page has one URL and reads
// `/config`, `/launcher` and `/api/portal/v1/home`; the Project display name
// comes with `/launcher`.
import { AppSwitcher, LauncherGrid, projectDisplayName, useLauncher, type LauncherProject } from '@appthrust/app-launcher'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, House, Languages, Search } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { configQuery, type PortalConfig } from './config'
import { useDebouncedValue, useHome } from './home'
import { HomeApps } from './home-apps'
import { setLanguage, useText } from './i18n'

/** The server rejects longer searches (`invalid_query`). */
const SEARCH_MAX_LENGTH = 128

const HEADER_BUTTON =
  'inline-flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 md:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0'

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
            <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-white">
              <House className="size-4" />
            </span>
            <span className="shrink-0 text-[15px] font-semibold tracking-tight text-stone-900">{t('portal.title')}</span>
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
              className={HEADER_BUTTON}
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

/** The page once `/config` is known; exported as the test seam for composition. */
export function PortalPage({ config }: { config: PortalConfig }) {
  const { t, language } = useText()
  const launcher = useLauncher()
  const project = launcher.status === 'ready' ? launcher.project : undefined
  const searchId = useId()
  const [search, setSearch] = useState('')
  // Installed app cards filter as you type; the app sections re-query once typing pauses.
  const q = useDebouncedValue(search.trim())
  const home = useHome(q)
  return (
    <Shell project={project}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-stone-900">{t('portal.title')}</h1>
          <p className="mt-1 text-stone-500">
            {project ? t('portal.subtitle.project', { name: projectDisplayName(project) }) : t('portal.subtitle')}
          </p>
        </div>
        <a href={config.dashboardUrl} className={`${HEADER_BUTTON} -mx-2.5`}>
          {t('portal.manage')}
          <ExternalLink aria-hidden />
        </a>
      </div>
      <div role="search" className="relative mb-6">
        <label htmlFor={searchId} className="sr-only">
          {t('portal.search.label')}
        </label>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxLength={SEARCH_MAX_LENGTH}
          placeholder={t('portal.search.placeholder')}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-11 w-full rounded-lg border border-stone-300 bg-white pr-3 pl-9 text-base text-stone-900 shadow-xs placeholder:text-stone-400 focus-visible:border-sky-600 focus-visible:outline-offset-0 sm:text-sm"
        />
      </div>
      <LauncherGrid dashboardUrl={config.dashboardUrl} language={language} search={search} />
      <HomeApps state={home.state} stale={home.stale} search={q} onRetry={home.refetch} />
    </Shell>
  )
}

export function App() {
  const { t } = useText()
  const config = useQuery(configQuery)
  if (config.data) return <PortalPage config={config.data} />
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
