/**
 * Time zones. Each teammate picks one on their profile (filled in from the browser to start), and
 * Send later reads and shows times in it, so "tomorrow 8 am" means 8 am where they work.
 *
 * Times inside a zone are handled as "wall" dates: Date objects whose UTC fields hold the clock in that zone.
 * Arithmetic on them (add a day, set the hour) never trips over the browser's own zone or its DST changes.
 */
import { useSession } from './hooks'

export const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export const allZones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

export function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return !!zone
  } catch {
    return false
  }
}

/** The signed-in teammate's zone: their choice, or this browser's until they make one. */
export function useZone(): string {
  const { user } = useSession()
  return user.timezone && validZone(user.timezone) ? user.timezone : browserZone()
}

const partsCache = new Map<string, Intl.DateTimeFormat>()
function parts(ts: number, zone: string) {
  let format = partsCache.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    partsCache.set(zone, format)
  }
  const p = Object.fromEntries(format.formatToParts(ts).map((x) => [x.type, Number(x.value)]))
  return { year: p.year, month: p.month - 1, day: p.day, hour: p.hour, minute: p.minute, second: p.second }
}

/** The clock in `zone` at this instant, as a wall date. */
export function toWall(ts: number, zone: string): Date {
  const p = parts(ts, zone)
  return new Date(Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second))
}

/** The instant when the clock in `zone` shows this wall date. A time skipped by a DST change moves forward. */
export function fromWall(wall: Date, zone: string): number {
  const target = wall.getTime()
  // The zone's offset is what the wall clock reads minus the real time. Two rounds settle it across a DST change.
  let guess = target
  for (let i = 0; i < 2; i++) guess = target - (toWall(guess, zone).getTime() - guess)
  return guess
}

/** "Fri, 8:00 AM EST" within a week, "Fri, Aug 7, 8:00 AM EDT" further out, in the given zone. */
export function zonedLabel(ts: number, zone: string, now = Date.now()): string {
  const near = ts - now < 6 * 86_400_000
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: 'short',
    ...(near ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(ts)
}
