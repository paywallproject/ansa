import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight, ChartNoAxesColumn } from 'lucide-react'
import { api, qs } from '../lib/api'
import { duration, plural } from '../lib/format'
import { useDocumentTitle, useLocalState, useMailboxes } from '../lib/hooks'
import type { Report } from '../lib/types'
import { Avatar, Card, EmptyState, PageHeader, Select, Spinner, cx } from '../ui'

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
]
const dayLabel = (iso: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))

export function ReportsPage() {
  useDocumentTitle('Reports')
  const mailboxes = useMailboxes()
  const [days, setDays] = useLocalState('ansa-report-days', 30)
  const [mailboxId, setMailboxId] = useState<number | ''>('')
  // Whole local days: the range ends at the next local midnight.
  const range = useMemo(() => {
    const now = new Date()
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    return { to, from: to - days * 86_400_000 }
  }, [days])
  const report = useQuery({
    queryKey: ['report', range, mailboxId],
    queryFn: () => api.get<Report>(`/reports${qs({ ...range, mailbox: mailboxId, tz: -new Date().getTimezoneOffset() })}`),
  })
  const r = report.data

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
        <PageHeader
          title="Reports"
          description="How much email comes in and how fast your team answers it."
          action={
            <div className="flex gap-2">
              {(mailboxes.data?.length ?? 0) > 1 && (
                <Select aria-label="Mailbox" className="w-auto" value={mailboxId} onChange={(e) => setMailboxId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">All mailboxes</option>
                  {mailboxes.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              )}
              <Select aria-label="Date range" className="w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {RANGES.map((x) => (
                  <option key={x.days} value={x.days}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </div>
          }
        />
        {report.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-5" />
          </div>
        ) : report.isError || !r ? (
          <Card>
            <EmptyState title="Could not load the report" body={(report.error as Error)?.message} />
          </Card>
        ) : r.current.newConversations + r.current.repliesSent + r.previous.newConversations === 0 ? (
          <Card>
            <EmptyState icon={<ChartNoAxesColumn />} title="No activity in this period" body="Numbers appear here once customers write in and your team replies." />
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="New conversations" value={r.current.newConversations} previous={r.previous.newConversations} />
              <Stat label="Replies sent" value={r.current.repliesSent} previous={r.previous.repliesSent} />
              <Stat label="Customers helped" value={r.current.customersHelped} previous={r.previous.customersHelped} />
              <Stat label="Conversations closed" value={r.current.closed} previous={r.previous.closed} />
              <Stat label="First response time" hint="Median" value={r.current.medianFirstResponseMs} previous={r.previous.medianFirstResponseMs} format={duration} lowerIsBetter />
              <Stat label="Time to close" hint="Median" value={r.current.medianResolutionMs} previous={r.previous.medianResolutionMs} format={duration} lowerIsBetter />
              <Stat label="Open right now" value={r.open.active + r.open.pending} hint={`${r.open.active} active, ${r.open.pending} pending`} />
              <Stat label="Unassigned right now" value={r.open.unassigned} />
            </div>

            <Panel title="Volume" description="New conversations and replies sent each day.">
              <VolumeChart days={r.days} />
            </Panel>

            <div className="grid gap-5 lg:grid-cols-2">
              <Panel title="First response time" description="How long customers waited for the first reply.">
                <Bars rows={r.current.firstResponseBuckets.map((b) => ({ label: b.label, value: b.count }))} unit="conversation" empty="No first replies in this period." />
              </Panel>
              <Panel title="Top tags" description="Tags on conversations started in this period.">
                <Bars rows={r.tags.map((t) => ({ label: t.name, value: t.count }))} unit="conversation" empty="No tagged conversations in this period." />
              </Panel>
            </div>

            <Panel title="Busiest times" description="When new conversations arrive, in your local time.">
              <Heatmap grid={r.busiest} />
            </Panel>

            <Panel title="Team" description="Activity per teammate in this period.">
              <div className="-mx-5 -mb-5 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-y border-line text-xs text-fg-3">
                      <th scope="col" className="px-5 py-2 font-medium">
                        Teammate
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Replies sent
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Customers helped
                      </th>
                      <th scope="col" className="px-5 py-2 text-right font-medium">
                        Closed
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.team.map((u) => (
                      <tr key={u.id}>
                        <td className="px-5 py-2.5">
                          <span className="flex items-center gap-2.5">
                            <Avatar name={u.name} color={u.color} src={u.avatarUrl} size={24} />
                            <span className="font-medium">{u.name}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{u.replies}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{u.customers}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{u.closed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}

function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mb-4 text-[13px] text-fg-3">{description}</p>
      {children}
    </Card>
  )
}

function Stat({ label, value, previous, hint, format, lowerIsBetter }: { label: string; value: number | null; previous?: number | null; hint?: string; format?: (v: number | null) => string; lowerIsBetter?: boolean }) {
  const shown = format ? format(value) : (value ?? 0).toLocaleString()
  let delta: ReactNode = null
  if (previous !== undefined && previous !== null && value !== null && previous > 0 && value !== previous) {
    const change = Math.round(((value - previous) / previous) * 100)
    const up = change > 0
    const good = lowerIsBetter ? !up : up
    const Icon = up ? ArrowUpRight : ArrowDownRight
    delta = (
      <span className={cx('inline-flex items-center gap-0.5 text-xs font-medium', good ? 'text-ok' : 'text-danger')} title="Compared with the previous period">
        <Icon className="size-3.5" aria-hidden />
        {Math.abs(change)}%<span className="sr-only"> {up ? 'more' : 'less'} than the previous period</span>
      </span>
    )
  }
  return (
    <Card className="px-4 py-3.5">
      <p className="truncate text-[13px] text-fg-2">{label}</p>
      <p className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{shown}</span>
        {delta}
      </p>
      {hint && <p className="mt-0.5 truncate text-xs text-fg-3">{hint}</p>}
    </Card>
  )
}

// ---------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------

/** Top of the y-axis: four equal whole-number steps that cover the data. */
const niceMax = (max: number) => {
  const raw = Math.max(1, max) / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw) ?? raw
  return Math.max(1, Math.ceil(step)) * 4
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

const SERIES = [
  { key: 'newConversations', label: 'New conversations', color: 'var(--viz-1)' },
  { key: 'repliesSent', label: 'Replies sent', color: 'var(--viz-2)' },
] as const

function VolumeChart({ days }: { days: Report['days'] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const height = 240
  const pad = { top: 12, right: 12, bottom: 24, left: 32 }
  const innerW = Math.max(10, width - pad.left - pad.right)
  const innerH = height - pad.top - pad.bottom
  const max = niceMax(Math.max(1, ...days.flatMap((d) => [d.newConversations, d.repliesSent])))
  const x = (i: number) => pad.left + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW)
  const y = (v: number) => pad.top + innerH - (v / max) * innerH
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(max * t)).filter((v, i, a) => a.indexOf(v) === i)
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(innerW / 64))))
  const active = hover === null ? null : days[hover]

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-[13px] text-fg-2">
            <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Line chart of new conversations and replies sent per day over ${plural(days.length, 'day')}. The same numbers follow in a table.`}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const ratio = (e.clientX - rect.left - pad.left) / innerW
              setHover(Math.min(days.length - 1, Math.max(0, Math.round(ratio * (days.length - 1)))))
            }}
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={pad.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--fg-3)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {t}
                </text>
              </g>
            ))}
            {days.map((d, i) =>
              i % labelEvery === 0 ? (
                <text key={d.date} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--fg-3)">
                  {dayLabel(d.date)}
                </text>
              ) : null,
            )}
            {active && hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--line-strong)" strokeWidth={1} />}
            {SERIES.map((s) => (
              <g key={s.key}>
                <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={days.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')} />
                {days.length === 1 && <circle cx={x(0)} cy={y(days[0][s.key])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />}
                {active && hover !== null && <circle cx={x(hover)} cy={y(active[s.key])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />}
              </g>
            ))}
          </svg>
        )}
        {active && hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-44 rounded-lg bg-surface px-3 py-2 text-xs shadow-pop"
            style={{ left: Math.min(Math.max(0, x(hover) + (x(hover) > width / 2 ? -188 : 12)), width - 176) }}
          >
            <p className="mb-1 font-medium">{dayLabel(active.date)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center gap-1.5 text-fg-2">
                <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />
                <span className="flex-1">{s.label}</span>
                <span className="font-medium text-fg tabular-nums">{active[s.key]}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Volume per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">New conversations</th>
            <th scope="col">Replies sent</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{dayLabel(d.date)}</th>
              <td>{d.newConversations}</td>
              <td>{d.repliesSent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Horizontal bars for a ranked or bucketed count. One hue: the bars encode magnitude only. */
function Bars({ rows, unit, empty }: { rows: { label: string; value: number }[]; unit: string; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (rows.length === 0 || rows.every((r) => r.value === 0)) return <p className="py-6 text-center text-[13px] text-fg-3">{empty}</p>
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,7.5rem)_1fr_2.5rem] items-center gap-3 text-[13px]" title={`${row.label}: ${plural(row.value, unit)}`}>
          <span className="truncate text-fg-2">{row.label}</span>
          <span className="h-2.5 rounded-r bg-sunken">
            <span className="block h-full rounded-r" style={{ width: `${(row.value / max) * 100}%`, minWidth: row.value ? 3 : 0, background: 'var(--viz-1)' }} />
          </span>
          <span className="text-right font-medium tabular-nums">{row.value}</span>
        </li>
      ))}
    </ul>
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hourLabel = (h: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2024, 0, 1, h))

function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat())
  const [tip, setTip] = useState<{ day: number; hour: number } | null>(null)
  const steps = [0, 1, 2, 3, 4]
  const level = (v: number) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)))
  const fill = (lv: number) => (lv === 0 ? 'var(--sunken)' : `color-mix(in oklab, var(--viz-1) ${lv * 25}%, var(--sunken))`)
  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5" role="table" aria-label="New conversations by weekday and hour">
            {grid.map((row, day) => (
              <div key={day} role="row" className="contents">
                <span role="rowheader" className="flex items-center text-xs text-fg-3">
                  {WEEKDAYS[day]}
                </span>
                {row.map((value, hour) => (
                  <span
                    key={hour}
                    role="cell"
                    tabIndex={value ? 0 : -1}
                    aria-label={`${WEEKDAYS[day]} ${hourLabel(hour)}: ${plural(value, 'conversation')}`}
                    onMouseEnter={() => setTip({ day, hour })}
                    onMouseLeave={() => setTip(null)}
                    onFocus={() => setTip({ day, hour })}
                    onBlur={() => setTip(null)}
                    className="h-5 rounded-[3px] outline-offset-1"
                    style={{ background: fill(level(value)) }}
                  />
                ))}
              </div>
            ))}
            <span />
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="pt-1 text-center text-[11px] text-fg-3">
                {hour % 3 === 0 ? hourLabel(hour).replace(/\s/g, '').toLowerCase() : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-3">
        <p role="status" className="min-h-4 text-fg-2">
          {tip ? `${WEEKDAYS[tip.day]} ${hourLabel(tip.hour)}: ${plural(grid[tip.day][tip.hour], 'new conversation')}` : 'Point at a square to see its count.'}
        </p>
        <p className="flex items-center gap-1.5">
          Fewer
          {steps.map((s) => (
            <span key={s} className="size-3 rounded-[3px]" style={{ background: fill(s) }} aria-hidden />
          ))}
          More
        </p>
      </div>
    </div>
  )
}
