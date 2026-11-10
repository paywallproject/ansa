const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const full = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const withYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** Compact time for lists: "now", "12m", "3h", "Tue", "Mar 4", "Mar 4, 2025". */
export function shortTime(ts: number, now = Date.now()): string {
  const diff = now - ts
  if (diff < MIN) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  return new Date(ts).getFullYear() === new Date(now).getFullYear() ? monthDay.format(ts) : withYear.format(ts)
}

/** Relative time for sentences: "Just now", "3h ago", "Mar 4". */
export function ago(ts: number, now = Date.now()): string {
  const short = shortTime(ts, now)
  if (short === 'now') return 'Just now'
  return now - ts < 7 * DAY ? `${short} ago` : short
}

/** Friendly time for message headers: "2:14 PM", "Yesterday 2:14 PM", "Mar 4, 2:14 PM". */
export function messageTime(ts: number, now = Date.now()): string {
  const date = new Date(ts)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ts >= startOfToday) return time.format(date)
  if (ts >= startOfToday - DAY) return `Yesterday ${time.format(date)}`
  const sameYear = date.getFullYear() === today.getFullYear()
  return `${(sameYear ? monthDay : withYear).format(date)}, ${time.format(date)}`
}

export const fullTime = (ts: number) => full.format(ts)
export const dateOnly = (ts: number) => withYear.format(ts)

/** "42 min", "3.5 hr", "2.1 days" */
export function duration(ms: number | null): string {
  if (ms === null) return '–'
  if (ms < MIN) return '< 1 min'
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`
  if (ms < DAY) return `${trim(ms / HOUR)} hr`
  return `${trim(ms / DAY)} days`
}
const trim = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ''))

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?'

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#0d9488', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#059669', '#2563eb', '#c2410c']
export const colorFor = (seed: string) => AVATAR_COLORS[[...seed].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length]

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

export const STATUS_LABEL: Record<string, string> = { active: 'Active', pending: 'Pending', closed: 'Closed', spam: 'Spam' }
