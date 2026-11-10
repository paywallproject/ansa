import { all, get } from '../db.ts'

const DAY = 86_400_000

export interface ReportOptions {
  from: number
  to: number
  mailboxId?: number
  /** Minutes to add to UTC to get the viewer's local time (e.g. 420 for UTC+7). */
  tzOffset?: number
}

const median = (values: number[]) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function totals(from: number, to: number, mailboxId?: number) {
  const mb = mailboxId ? 'AND c.mailbox_id = ?' : ''
  const p = (...base: number[]) => (mailboxId ? [...base, mailboxId] : base)
  const count = (sql: string, ...base: number[]) => get<{ n: number }>(sql, ...p(...base))?.n ?? 0
  const firstResponses = all<{ ms: number }>(
    `SELECT c.first_reply_at - c.created_at AS ms FROM conversations c
     WHERE c.first_reply_at >= ? AND c.first_reply_at < ? AND c.first_reply_at > c.created_at ${mb}`,
    ...p(from, to),
  ).map((r) => r.ms)
  const resolutions = all<{ ms: number }>(
    `SELECT c.closed_at - c.created_at AS ms FROM conversations c WHERE c.status = 'closed' AND c.closed_at >= ? AND c.closed_at < ? ${mb}`,
    ...p(from, to),
  ).map((r) => r.ms)
  return {
    newConversations: count(`SELECT COUNT(*) AS n FROM conversations c WHERE c.created_at >= ? AND c.created_at < ? AND c.status != 'spam' ${mb}`, from, to),
    messagesReceived: count(
      `SELECT COUNT(*) AS n FROM threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.type = 'customer' AND t.created_at >= ? AND t.created_at < ? AND c.status != 'spam' ${mb}`,
      from,
      to,
    ),
    repliesSent: count(
      `SELECT COUNT(*) AS n FROM threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.type = 'reply' AND t.via != 'auto' AND t.created_at >= ? AND t.created_at < ? ${mb}`,
      from,
      to,
    ),
    customersHelped: count(
      `SELECT COUNT(DISTINCT c.customer_id) AS n FROM threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.type = 'reply' AND t.via != 'auto' AND t.created_at >= ? AND t.created_at < ? ${mb}`,
      from,
      to,
    ),
    closed: count(`SELECT COUNT(*) AS n FROM conversations c WHERE c.status = 'closed' AND c.closed_at >= ? AND c.closed_at < ? ${mb}`, from, to),
    medianFirstResponseMs: median(firstResponses),
    medianResolutionMs: median(resolutions),
    firstResponseBuckets: [
      { label: 'Under 1 hour', count: firstResponses.filter((ms) => ms < 3_600_000).length },
      { label: '1–4 hours', count: firstResponses.filter((ms) => ms >= 3_600_000 && ms < 4 * 3_600_000).length },
      { label: '4–24 hours', count: firstResponses.filter((ms) => ms >= 4 * 3_600_000 && ms < DAY).length },
      { label: 'Over 1 day', count: firstResponses.filter((ms) => ms >= DAY).length },
    ],
  }
}

export function buildReport(opts: ReportOptions) {
  const { from, to, mailboxId } = opts
  const tz = (opts.tzOffset ?? 0) * 60_000
  const mb = mailboxId ? 'AND c.mailbox_id = ?' : ''
  const p = (...base: number[]) => (mailboxId ? [...base, mailboxId] : base)

  const dayKey = (ts: number) => Math.floor((ts + tz) / DAY)
  const days: { date: string; newConversations: number; repliesSent: number; closed: number }[] = []
  const index = new Map<number, number>()
  for (let key = dayKey(from); key <= dayKey(to - 1); key++) {
    index.set(key, days.length)
    days.push({ date: new Date(key * DAY).toISOString().slice(0, 10), newConversations: 0, repliesSent: 0, closed: 0 })
  }
  const bump = (ts: number, field: 'newConversations' | 'repliesSent' | 'closed') => {
    const i = index.get(dayKey(ts))
    if (i !== undefined) days[i][field]++
  }

  const created = all<{ ts: number }>(`SELECT c.created_at AS ts FROM conversations c WHERE c.created_at >= ? AND c.created_at < ? AND c.status != 'spam' ${mb}`, ...p(from, to))
  const busiest = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  for (const { ts } of created) {
    bump(ts, 'newConversations')
    const local = new Date(ts + tz)
    busiest[(local.getUTCDay() + 6) % 7][local.getUTCHours()]++
  }
  for (const { ts } of all<{ ts: number }>(
    `SELECT t.created_at AS ts FROM threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.type = 'reply' AND t.via != 'auto' AND t.created_at >= ? AND t.created_at < ? ${mb}`,
    ...p(from, to),
  ))
    bump(ts, 'repliesSent')
  for (const { ts } of all<{ ts: number }>(`SELECT c.closed_at AS ts FROM conversations c WHERE c.status = 'closed' AND c.closed_at >= ? AND c.closed_at < ? ${mb}`, ...p(from, to)))
    bump(ts, 'closed')

  const tags = all<{ name: string; color: string; count: number }>(
    `SELECT t.name, t.color, COUNT(*) AS count FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id JOIN conversations c ON c.id = ct.conversation_id
     WHERE c.created_at >= ? AND c.created_at < ? ${mb} GROUP BY t.id ORDER BY count DESC, t.name LIMIT 8`,
    ...p(from, to),
  )

  const team = all<any>(
    `SELECT u.id, u.name, u.color,
       (SELECT COUNT(*) FROM threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.user_id = u.id AND t.type = 'reply' AND t.created_at >= ?1 AND t.created_at < ?2 ${mailboxId ? 'AND c.mailbox_id = ?3' : ''}) AS replies,
       (SELECT COUNT(*) FROM conversations c WHERE c.closed_by = u.id AND c.status = 'closed' AND c.closed_at >= ?1 AND c.closed_at < ?2 ${mailboxId ? 'AND c.mailbox_id = ?3' : ''}) AS closed,
       (SELECT COUNT(DISTINCT c.customer_id) FROM threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.user_id = u.id AND t.type = 'reply' AND t.created_at >= ?1 AND t.created_at < ?2 ${mailboxId ? 'AND c.mailbox_id = ?3' : ''}) AS customers
     FROM users u WHERE u.disabled = 0 ORDER BY replies DESC, u.name`,
    ...p(from, to),
  ).map((u) => ({ id: u.id as number, name: u.name as string, color: u.color as string, replies: u.replies as number, closed: u.closed as number, customers: u.customers as number }))

  const open = get<{ active: number; pending: number; unassigned: number }>(
    `SELECT COALESCE(SUM(c.status = 'active'), 0) AS active, COALESCE(SUM(c.status = 'pending'), 0) AS pending,
            COALESCE(SUM(c.status = 'active' AND c.assignee_id IS NULL), 0) AS unassigned
     FROM conversations c WHERE 1 = 1 ${mb}`,
    ...p(),
  )!

  return {
    from,
    to,
    current: totals(from, to, mailboxId),
    previous: totals(from - (to - from), from, mailboxId),
    days,
    busiest,
    tags,
    team,
    open,
  }
}
