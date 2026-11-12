import { useState } from 'react'
import { Button, Input, Modal, Select, cx } from '../ui'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MORNING = 8

const atHour = (date: Date, hour: number, minute = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute)
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes())

/**
 * Read a time someone typed: "8 am", "3 days", "2 hours", "tomorrow 2pm", "monday", "Aug 7 9:30".
 * A day without a time means 8:00 that morning. Returns null when it is not a time in the future.
 */
export function parseWhen(input: string, now = new Date()): Date | null {
  let text = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
  if (!text) return null

  const span = /^(?:in )?(\d{1,3}) ?(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/.exec(text)
  if (span) {
    const n = Number(span[1])
    const unit = span[2][0]
    if (unit === 'm') return new Date(now.getTime() + n * 60_000)
    if (unit === 'h') return new Date(now.getTime() + n * 3_600_000)
    return n > 0 ? atHour(addDays(now, unit === 'w' ? n * 7 : n), MORNING) : null
  }

  // Take the time of day out first; what is left names the day.
  let hour: number | null = null
  let minute = 0
  const clock = /(?:^| )(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)?$/.exec(text)
  if (clock && (clock[2] !== undefined || clock[3] !== undefined || /^(?:at )?\d{1,2}$/.test(text))) {
    hour = Number(clock[1])
    minute = Number(clock[2] ?? 0)
    if (clock[3]?.startsWith('p') && hour < 12) hour += 12
    if (clock[3]?.startsWith('a') && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return null
    text = text.slice(0, clock.index).trim()
  } else if (/ ?(morning)$/.test(text)) {
    hour = MORNING
    text = text.replace(/ ?morning$/, '')
  } else if (/ ?(afternoon)$/.test(text)) {
    hour = 14
    text = text.replace(/ ?afternoon$/, '')
  }

  let day: Date | null = null
  const weekday = DAYS.findIndex((d) => text.replace(/^next /, '').startsWith(d))
  const monthDay = /^([a-z]{3,9}) (\d{1,2})$/.exec(text) ?? /^(\d{1,2}) ([a-z]{3,9})$/.exec(text)
  if (!text || text === 'today') day = now
  else if (text === 'tomorrow' || text === 'tmr') day = addDays(now, 1)
  else if (weekday >= 0 && /^(next )?[a-z]+$/.test(text)) day = addDays(now, (weekday - now.getDay() + 7) % 7 || 7)
  else if (monthDay) {
    const [name, num] = /^\d/.test(monthDay[1]) ? [monthDay[2], monthDay[1]] : [monthDay[1], monthDay[2]]
    const month = MONTHS.indexOf(name.slice(0, 3))
    if (month < 0 || Number(num) < 1 || Number(num) > 31) return null
    day = new Date(now.getFullYear(), month, Number(num))
    if (atHour(day, 23, 59) < now) day = new Date(now.getFullYear() + 1, month, Number(num))
  } else return null

  let result = atHour(day, hour ?? MORNING, minute)
  // Only a time, and it has passed today: the same time tomorrow.
  if (result <= now && (!text || text === 'today') && hour !== null && !/today/.test(text)) result = addDays(result, 1)
  return result > now ? result : null
}

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const dateTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** "Fri, 8:00 AM" within a week, "Fri, Aug 7, 8:00 AM" further out. */
export const whenLabel = (ts: number, now = Date.now()) => (ts - now < 6 * 86_400_000 ? dayTime : dateTime).format(ts)

function presets(now = new Date()) {
  const tomorrow = addDays(now, 1)
  const monday = addDays(now, (1 - now.getDay() + 7) % 7 || 7)
  const list = [
    { label: 'Tomorrow morning', at: atHour(tomorrow, MORNING) },
    { label: 'Tomorrow afternoon', at: atHour(tomorrow, 14) },
  ]
  // When tomorrow is Monday, "Monday morning" would be the first row again.
  if (monday.getDate() !== tomorrow.getDate()) list.push({ label: 'Monday morning', at: atHour(monday, MORNING) })
  return list
}

export function SendLaterDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (sendAt: number, ifNoReply: boolean) => void }) {
  const [text, setText] = useState('')
  const [ifNoReply, setIfNoReply] = useState(true)
  const typed = text.trim() ? parseWhen(text) : null
  const pick = (at: Date) => {
    setText('')
    onPick(at.getTime(), ifNoReply)
  }
  return (
    <Modal open={open} onClose={onClose} title="Send later" width={440}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (typed) pick(typed)
        }}
      >
        <div className="flex gap-2">
          <Input autoFocus aria-label="When to send" placeholder="Try: 8 am, 3 days, Aug 7" value={text} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1" />
          <div className="w-36 shrink-0">
            <Select aria-label="Send condition" value={ifNoReply ? 'quiet' : 'always'} onChange={(e) => setIfNoReply(e.target.value === 'quiet')}>
              <option value="quiet">If no reply</option>
              <option value="always">Always</option>
            </Select>
          </div>
        </div>
        <p className="mt-2 text-xs text-fg-3">
          {ifNoReply ? 'If the customer writes before then, the reply is not sent. You can still send it yourself.' : 'The reply is sent at that time, whatever happens before.'}
        </p>
        <ul className="mt-3 flex flex-col gap-0.5">
          {text.trim() ? (
            <li>
              {typed ? (
                <Row label="Send at" hint={whenLabel(typed.getTime())} onClick={() => pick(typed)} primary />
              ) : (
                <p className="px-2.5 py-2 text-[13px] text-fg-3">Not a time yet. Try “tomorrow 2pm”, “monday”, “3 days” or “Aug 7”.</p>
              )}
            </li>
          ) : (
            presets().map((p, index) => (
              <li key={p.label}>
                <Row label={p.label} hint={whenLabel(p.at.getTime())} onClick={() => pick(p.at)} primary={index === 0} />
              </li>
            ))
          )}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!typed}>
            Schedule
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function Row({ label, hint, onClick, primary }: { label: string; hint: string; onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex h-9 w-full items-center justify-between rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-accent-soft', primary && 'bg-sunken')}>
      <span className="font-medium">{label}</span>
      <span className="text-fg-3 tabular-nums">{hint}</span>
    </button>
  )
}
