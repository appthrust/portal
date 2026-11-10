// Dates in the viewer's language (Intl.DateTimeFormat, local time zone) and the
// conversions between the API's RFC 3339 UTC times and `<input type="datetime-local">`.
import { dashboardLocale, type DashboardLanguage } from '@appthrust/platform-dashboard-i18n'

/** Today on the greeting: "2026年11月10日火曜日" / "Tuesday, November 10, 2026". */
export function formatToday(language: DashboardLanguage, now: Date): string {
  return new Intl.DateTimeFormat(dashboardLocale(language), { dateStyle: 'full' }).format(now)
}

/** A list row's date: month and day, with the year only when it is not this year. */
export function formatShortDate(language: DashboardLanguage, iso: string, now: Date): string {
  const date = new Date(iso)
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(dashboardLocale(language), options).format(date)
}

/** A full date and time: "2026年11月10日 9:30" / "November 10, 2026 at 9:30 AM". */
export function formatDateTime(language: DashboardLanguage, iso: string): string {
  return new Intl.DateTimeFormat(dashboardLocale(language), { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso))
}

export type DayPart = 'morning' | 'day' | 'evening'

/** Morning until 11:00, day until 18:00, evening after. */
export function dayPart(now: Date): DayPart {
  const hour = now.getHours()
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 18) return 'day'
  return 'evening'
}

const pad = (value: number) => String(value).padStart(2, '0')

/** A date as `YYYY-MM-DD` in the viewer's time zone, for `<time dateTime>`. */
export function localDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** An RFC 3339 time as a `datetime-local` value in the viewer's time zone, to the minute. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A `datetime-local` value (viewer's time zone) as RFC 3339 UTC; `undefined` when blank or not a date. */
export function fromLocalInput(value: string): string | undefined {
  if (value.trim() === '') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
