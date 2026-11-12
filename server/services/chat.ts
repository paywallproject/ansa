/**
 * Live chat. A mailbox can turn on a chat widget for a website. A visitor gives their name and email,
 * and each chat becomes an ordinary conversation in that mailbox with source 'chat'. The visitor's
 * browser keeps a token for that conversation; only its hash is stored.
 *
 * Replies reach the visitor in the widget while it is open. After they leave, replies go by email.
 */
import { all, get, run, now, parseJson } from '../db.ts'
import { randomToken, sha256 } from '../crypto.ts'
import { avatarUrl } from '../auth.ts'
import { agentActive } from '../events.ts'
import { memberOf } from './access.ts'
import { textToHtml } from '../mail/html.ts'
import type { MailboxRow } from '../mail/outbound.ts'
import { addCustomerMessage, createConversation, getSummary } from './conversations.ts'
import { AppError, isEmail } from './customers.ts'
import { runWorkflows } from './workflows.ts'

/**
 * When the chat shows as online. 'team': while a teammate is available (set to Available, with the app open).
 * 'hours': during office hours. 'always': always online.
 */
export type ChatAvailability = 'team' | 'hours' | 'always'
export const CHAT_AVAILABILITY: ChatAvailability[] = ['team', 'hours', 'always']

export interface OfficeHours {
  /** Open days, 0 = Sunday to 6 = Saturday. */
  days: number[]
  /** "09:00". When end is before start, the hours run past midnight. */
  start: string
  end: string
  /** An IANA time zone, such as Europe/Berlin. */
  timezone: string
}

export interface ChatSettings {
  /** The heading at the top of the widget. */
  title: string
  /** The first message a visitor sees, before they write. */
  greeting: string
  /** The launcher and header color. */
  color: string
  /** Websites allowed to show the widget, such as https://example.com. Empty: any website. */
  origins: string[]
  availability: ChatAvailability
  hours: OfficeHours
  /** Shown instead of the greeting while the chat is away. Visitors can still leave a message. */
  awayMessage: string
  /** Hide the chat button while away. A visitor already in a chat still sees it. */
  hideWhenAway: boolean
}

export const CHAT_DEFAULTS: ChatSettings = {
  title: 'Chat with us',
  greeting: 'Hi there! Ask us anything. We usually reply within a few minutes.',
  color: '#5448e2',
  origins: [],
  availability: 'team',
  hours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'UTC' },
  awayMessage: "We're away right now. Leave a message and we'll reply by email.",
  hideWhenAway: false,
}

/** Longest message a visitor can send at once. */
export const CHAT_MAX_MESSAGE = 5000

/** An origin such as https://example.com, http://localhost:8080 or https://*.example.com. */
const ORIGIN = /^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i

export type ChatMailbox = MailboxRow & { chat_enabled: number; chat_key: string | null; chat_settings: string }

export const chatSettingsOf = (mailbox: Pick<ChatMailbox, 'chat_settings'>): ChatSettings => ({ ...CHAT_DEFAULTS, ...parseJson<Partial<ChatSettings>>(mailbox.chat_settings, {}) })

/** Check and tidy settings from the admin form. Unknown or blank fields keep their current value. */
export function cleanChatSettings(input: Record<string, unknown>, current: ChatSettings): ChatSettings {
  const text = (value: unknown, max: number, fallback: string) => (typeof value === 'string' ? value.trim().slice(0, max) || fallback : fallback)
  const next: ChatSettings = {
    title: text(input.title, 60, current.title),
    greeting: typeof input.greeting === 'string' ? input.greeting.trim().slice(0, 500) : current.greeting,
    color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : current.color,
    origins: current.origins,
    availability: CHAT_AVAILABILITY.includes(input.availability as ChatAvailability) ? (input.availability as ChatAvailability) : current.availability,
    hours: input.hours !== undefined ? cleanHours(input.hours) : current.hours,
    awayMessage: typeof input.awayMessage === 'string' ? input.awayMessage.trim().slice(0, 500) : current.awayMessage,
    hideWhenAway: typeof input.hideWhenAway === 'boolean' ? input.hideWhenAway : current.hideWhenAway,
  }
  if (input.origins !== undefined) {
    const list = Array.isArray(input.origins) ? input.origins : String(input.origins).split(/[\s,]+/)
    const origins = list.map((o) => String(o).trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean)
    const bad = origins.find((o) => !ORIGIN.test(o))
    if (bad) throw new AppError(`"${bad.slice(0, 80)}" is not a website address. Use the form https://example.com, without a path.`)
    next.origins = [...new Set(origins)].slice(0, 20)
  }
  return next
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function validTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function cleanHours(value: unknown): OfficeHours {
  const h = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const days = Array.isArray(h.days) ? [...new Set(h.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
  const start = String(h.start ?? '')
  const end = String(h.end ?? '')
  const timezone = String(h.timezone ?? '').trim()
  if (days.length === 0) throw new AppError('Pick at least one day for office hours.')
  if (!TIME.test(start) || !TIME.test(end)) throw new AppError('Enter office hours as times such as 09:00 and 17:00.')
  if (start === end) throw new AppError('Office hours must start and end at different times.')
  if (!timezone || !validTimezone(timezone)) throw new AppError(`"${timezone.slice(0, 60)}" is not a time zone. Use a name such as Europe/Berlin.`)
  return { days, start, end, timezone }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

/** True when `at` falls inside office hours, in the hours' own time zone. */
export function withinHours(hours: OfficeHours, at = Date.now()): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: hours.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  )
  const day = WEEKDAYS[parts.weekday]
  const now = Number(parts.hour) * 60 + Number(parts.minute)
  const start = minutes(hours.start)
  const end = minutes(hours.end)
  if (start < end) return hours.days.includes(day) && now >= start && now < end
  // Past midnight: the late part belongs to the day it started on.
  return (hours.days.includes(day) && now >= start) || (hours.days.includes((day + 6) % 7) && now < end)
}

/** Teammates who can answer this mailbox's chat right now: set to Available, with the app open, and access to the mailbox. */
export function availableTeammates(mailboxId: number): number[] {
  return all<{ id: number }>(`SELECT id FROM users WHERE disabled = 0 AND chat_status = 'online'`)
    .map((u) => u.id)
    .filter((id) => agentActive(id) && memberOf(id, mailboxId))
}

/** Is this mailbox's chat online right now? */
export function chatOnline(mailbox: Pick<ChatMailbox, 'id' | 'chat_settings'>, at = Date.now()): boolean {
  const s = chatSettingsOf(mailbox)
  if (s.availability === 'always') return true
  if (s.availability === 'hours') return withinHours(s.hours, at)
  return availableTeammates(mailbox.id).length > 0
}

/** What the widget shows about availability. */
export function chatStatus(mailbox: ChatMailbox) {
  const s = chatSettingsOf(mailbox)
  return { online: chatOnline(mailbox), hideWhenAway: s.hideWhenAway }
}

/** Give a mailbox its public chat key the first time chat is turned on. The key never changes after that. */
export function ensureChatKey(mailboxId: number): string {
  const row = get<{ chat_key: string | null }>('SELECT chat_key FROM mailboxes WHERE id = ?', mailboxId)
  if (row?.chat_key) return row.chat_key
  const key = randomToken(12)
  run('UPDATE mailboxes SET chat_key = ? WHERE id = ?', key, mailboxId)
  return key
}

/** The mailbox behind a widget key, while its chat is turned on. */
export function chatMailbox(key: string | undefined | null): ChatMailbox {
  const mailbox = key ? get<ChatMailbox>('SELECT * FROM mailboxes WHERE chat_key = ? AND chat_enabled = 1', key) : undefined
  if (!mailbox) throw new AppError('This chat is not available.', 404)
  return mailbox
}

/** Who the visitor sees in the widget header: teammates of this mailbox, available ones first, then those with a photo. */
function team(mailboxId: number) {
  const available = new Set(availableTeammates(mailboxId))
  return all<{ id: number; name: string; avatar_version: number | null }>('SELECT id, name, avatar_version FROM users WHERE disabled = 0 ORDER BY avatar_version IS NULL, id')
    .filter((u) => memberOf(u.id, mailboxId))
    .sort((a, b) => Number(available.has(b.id)) - Number(available.has(a.id)))
    .slice(0, 3)
    .map((u) => ({ name: u.name.split(' ')[0], avatarUrl: avatarUrl(u.id, u.avatar_version) }))
}

/** What the widget needs before the visitor writes. Public. */
export function publicChatConfig(mailbox: ChatMailbox) {
  const s = chatSettingsOf(mailbox)
  return { title: s.title, greeting: s.greeting, color: s.color, mailboxName: mailbox.name, team: team(mailbox.id), online: chatOnline(mailbox), awayMessage: s.awayMessage }
}

export interface Visitor {
  conversationId: number
  mailboxId: number
  customerId: number
}

/** The visitor behind a widget token, or null when it is unknown or its conversation is gone. */
export function visitorFromToken(token: string | undefined | null): Visitor | null {
  if (!token || token.length > 100) return null
  const row = get<{ conversation_id: number; mailbox_id: number; customer_id: number }>(
    `SELECT v.conversation_id, c.mailbox_id, c.customer_id FROM chat_visitors v JOIN conversations c ON c.id = v.conversation_id
     WHERE v.token_hash = ? AND c.status != 'spam'`,
    sha256(token),
  )
  if (!row) return null
  return { conversationId: row.conversation_id, mailboxId: row.mailbox_id, customerId: row.customer_id }
}

/** Remember when the visitor was last here. At most once a minute, so a busy chat does not write on every request. */
export function touchVisitor(token: string) {
  run('UPDATE chat_visitors SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?', now(), sha256(token), now() - 60_000)
}

const cleanMessage = (value: unknown) => {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  if (!text) throw new AppError('Write a message first.')
  if (text.length > CHAT_MAX_MESSAGE) throw new AppError(`Messages can be up to ${CHAT_MAX_MESSAGE} characters.`)
  return text
}

/** A subject for the conversation list: the start of the first line of the first message. */
function subjectFrom(text: string) {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? 'Live chat'
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line
}

/** A visitor starts a chat. Creates the conversation and returns the token their browser keeps. */
export function startChat(mailbox: ChatMailbox, input: { name: unknown; email: unknown; message: unknown }): { token: string; conversationId: number } {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : ''
  const email = typeof input.email === 'string' ? input.email.trim().slice(0, 200) : ''
  if (!name) throw new AppError('Enter your name.')
  if (!isEmail(email)) throw new AppError('Enter a valid email address, so we can reply if you leave.')
  const text = cleanMessage(input.message)
  const created = createConversation(
    { mailboxId: mailbox.id, customerEmail: email, customerName: name, subject: subjectFrom(text), bodyHtml: textToHtml(text), kind: 'customer', source: 'chat' },
    { userId: null, via: 'chat' },
  )
  const token = randomToken(24)
  run('INSERT INTO chat_visitors (token_hash, conversation_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', sha256(token), created.id, now(), now())
  const conv = getSummary(created.id)
  runWorkflows(created.id, mailbox.id, 'new', { subject: conv.subject, body: text, from: conv.customer.email, to: mailbox.email, customer_name: conv.customer.name })
  return { token, conversationId: created.id }
}

/** A visitor writes in a chat they already started. */
export function postVisitorMessage(visitor: Visitor, message: unknown): number {
  const text = cleanMessage(message)
  const conv = getSummary(visitor.conversationId)
  const threadId = addCustomerMessage(visitor.conversationId, { customerId: visitor.customerId, bodyHtml: textToHtml(text), bodyText: text, from: conv.customer.email, via: 'chat' })
  runWorkflows(visitor.conversationId, visitor.mailboxId, 'customer_reply', { subject: conv.subject, body: text, from: conv.customer.email, to: '', customer_name: conv.customer.name })
  return threadId
}

/**
 * The transcript the visitor sees: their messages and the team's replies, never notes or events.
 * Replies that are scheduled for later, still sending, or failed are left out until they are sent.
 */
export function chatTranscript(visitor: Visitor) {
  const conv = getSummary(visitor.conversationId)
  const threads = all<any>(
    `SELECT t.id, t.type, t.body_html, t.created_at, t.via, u.id AS user_id, u.name AS user_name, u.avatar_version
     FROM threads t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.conversation_id = ? AND (t.type = 'customer' OR (t.type = 'reply' AND t.state = 'sent' AND t.via != 'auto'))
     ORDER BY t.created_at, t.id`,
    visitor.conversationId,
  )
  return {
    status: conv.status === 'closed' ? 'closed' : 'open',
    messages: threads.map((t) => ({
      id: t.id as number,
      from: t.type === 'customer' ? ('visitor' as const) : ('team' as const),
      name: t.type === 'customer' ? conv.customer.name : ((t.user_name as string | null)?.split(' ')[0] ?? conv.mailboxName),
      avatarUrl: t.type === 'customer' ? null : avatarUrl(t.user_id, t.avatar_version),
      html: t.body_html as string,
      at: t.created_at as number,
    })),
  }
}
