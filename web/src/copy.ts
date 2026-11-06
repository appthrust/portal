// All portal wording, as a dashboard-i18n catalog: the English source is the
// `defaultMessage`, Japanese (the audience's default) is `translations.ja`.
// The card grid and the app switcher carry their own wording
// (@appthrust/app-launcher); this catalog covers the page around them and
// the app sections from `GET /api/portal/v1/home`.
import { defineDashboardMessages } from '@appthrust/platform-dashboard-i18n'

export const portalMessages = defineDashboardMessages({
  'portal.title': { defaultMessage: 'Home', translations: { ja: 'ホーム' } },
  'portal.subtitle': { defaultMessage: 'Apps installed in this project', translations: { ja: 'このプロジェクトにインストール済みのアプリ' } },
  'portal.subtitle.project': { defaultMessage: 'Apps installed in {name}', translations: { ja: '{name} にインストール済みのアプリ' } },
  'portal.project': { defaultMessage: 'Project', translations: { ja: 'プロジェクト' } },
  'portal.manage': { defaultMessage: 'Manage apps', translations: { ja: 'アプリを管理' } },
  'portal.language': { defaultMessage: 'Display language', translations: { ja: '表示言語' } },
  'portal.language.ja': { defaultMessage: '日本語', translations: { ja: '日本語' } },
  'portal.language.en': { defaultMessage: 'English', translations: { ja: 'English' } },
  'portal.skipToMain': { defaultMessage: 'Skip to main content', translations: { ja: '本文へ移動' } },
  'portal.loading': { defaultMessage: 'Loading…', translations: { ja: '読み込んでいます…' } },
  'portal.configFailed': {
    defaultMessage: "Couldn't load this project's portal settings. Try again in a moment.",
    translations: { ja: 'このプロジェクトのポータル設定を読み込めませんでした。少し待ってからもう一度お試しください。' },
  },
  'portal.retry': { defaultMessage: 'Try again', translations: { ja: 'もう一度読み込む' } },
  'portal.search.label': { defaultMessage: 'Search apps', translations: { ja: 'アプリを検索' } },
  'portal.search.placeholder': { defaultMessage: 'Find an app', translations: { ja: 'アプリを探す' } },
  'portal.apps.owner': { defaultMessage: 'My apps', translations: { ja: '自分のアプリ' } },
  'portal.apps.group': { defaultMessage: '{name} apps', translations: { ja: '{name} のアプリ' } },
  'portal.apps.groupUnnamed': { defaultMessage: 'Department apps', translations: { ja: '部署のアプリ' } },
  'portal.apps.project': { defaultMessage: 'Company apps', translations: { ja: '社内のアプリ' } },
  'portal.apps.open': { defaultMessage: 'Open', translations: { ja: '開く' } },
  'portal.apps.newTab': { defaultMessage: '(opens in a new tab)', translations: { ja: '（新しいタブで開きます）' } },
  'portal.apps.preparing': { defaultMessage: 'Preparing', translations: { ja: '準備中' } },
  'portal.apps.restricted': { defaultMessage: 'Access required', translations: { ja: '申請が必要' } },
  'portal.apps.details': { defaultMessage: 'Details', translations: { ja: '詳しく見る' } },
  'portal.apps.tags': { defaultMessage: 'Tags', translations: { ja: 'タグ' } },
  'portal.apps.empty': { defaultMessage: 'No apps registered yet', translations: { ja: 'まだアプリが登録されていません' } },
  'portal.apps.noMatches': { defaultMessage: 'No matches', translations: { ja: '見つかりません' } },
  'portal.apps.sourceUnavailable': {
    defaultMessage: "Couldn't load apps from {name}",
    translations: { ja: 'アプリ一覧を取得できませんでした（{name}）' },
  },
  'portal.apps.loading': { defaultMessage: 'Loading apps…', translations: { ja: 'アプリを読み込んでいます…' } },
  'portal.apps.denied': {
    defaultMessage: "This account can't list this project's apps.",
    translations: { ja: 'このアカウントではこのプロジェクトのアプリを一覧できません。' },
  },
  'portal.apps.unavailable': {
    defaultMessage: 'The app list is temporarily unavailable.',
    translations: { ja: 'アプリの一覧に一時的につながりません。' },
  },
})

export const catalogs = [portalMessages] as const

export type MessageId = keyof typeof portalMessages
