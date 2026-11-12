import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { all, get, run, now } from './db.ts'
import { config } from './config.ts'
import { randomToken, sha256 } from './crypto.ts'
import { markAgentSeen } from './events.ts'

export interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'agent'
  color: string
  signature: string
  notifyAssigned: boolean
  notifyReplies: boolean
  notifyMentions: boolean
  disabled: boolean
  /** The teammate's photo, or null to show initials. Public, because the chat widget shows it. */
  avatarUrl: string | null
  /** Live chat: 'online' when available to chat, 'away' when not. */
  chatStatus: 'online' | 'away'
  /** 'all': every mailbox (always so for admins). 'some': only the mailboxes in mailboxIds. */
  mailboxAccess: 'all' | 'some'
  mailboxIds: number[]
  /** IANA time zone such as America/New_York. Empty: not chosen yet (the browser's is used). */
  timezone: string
  createdAt: number
}

export type Env = { Variables: { user: User; via: 'web' | 'api' } }

export function serializeUser(row: any): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    color: row.color,
    signature: row.signature,
    notifyAssigned: !!row.notify_assigned,
    notifyReplies: !!row.notify_replies,
    notifyMentions: row.notify_mentions === undefined ? true : !!row.notify_mentions,
    disabled: !!row.disabled,
    avatarUrl: avatarUrl(row.id, row.avatar_version),
    chatStatus: row.chat_status === 'away' ? 'away' : 'online',
    ...mailboxAccessOf(row),
    timezone: row.timezone ?? '',
    createdAt: row.created_at,
  }
}

/** Where a teammate's photo is served. The version changes with each upload, so the image can be cached for good. */
export const avatarUrl = (userId: number, version: number | null | undefined) => (version ? `/api/avatars/${userId}?v=${version}` : null)

function mailboxAccessOf(row: any): { mailboxAccess: 'all' | 'some'; mailboxIds: number[] } {
  if (row.role === 'admin' || row.all_mailboxes === undefined || row.all_mailboxes) return { mailboxAccess: 'all', mailboxIds: [] }
  return { mailboxAccess: 'some', mailboxIds: all<{ mailbox_id: number }>('SELECT mailbox_id FROM mailbox_users WHERE user_id = ? ORDER BY mailbox_id', row.id).map((r) => r.mailbox_id) }
}

const COOKIE = 'ansa_session'
const SESSION_DAYS = 30

export function startSession(c: Context, userId: number) {
  const token = randomToken()
  const ts = now()
  run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, ts, ts + SESSION_DAYS * 86_400_000)
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.appUrl.startsWith('https://'),
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  })
}

export function endSession(c: Context) {
  const token = getCookie(c, COOKIE)
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token))
  deleteCookie(c, COOKIE, { path: '/' })
}

export function userFromSession(c: Context): User | null {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  const row = get<any>(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0',
    sha256(token),
    now(),
  )
  return row ? serializeUser(row) : null
}

export function userFromBearer(header: string | undefined | null): User | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header || '')
  if (!match) return null
  const row = get<any>(
    'SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.disabled = 0',
    sha256(match[1]),
  )
  if (!row) return null
  run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id)
  return serializeUser(row)
}

/** Accepts a browser session or an API token. Browser writes must carry X-Requested-With (CSRF guard). */
export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const bearer = userFromBearer(c.req.header('authorization'))
  if (bearer) {
    c.set('user', bearer)
    c.set('via', 'api')
    return next()
  }
  const user = userFromSession(c)
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-requested-with') !== 'ansa') {
    return c.json({ error: 'Request blocked.' }, 403)
  }
  c.set('user', user)
  c.set('via', 'web')
  // A signed-in browser means this teammate has the app open: they can be counted as available for chat.
  markAgentSeen(user.id)
  return next()
}

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Only admins can do that.' }, 403)
  return next()
}

const attempts = new Map<string, { count: number; resetAt: number }>()
/** Returns false when this key has failed too often in the last 15 minutes. */
export function allowAttempt(key: string, max = 10): boolean {
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + 15 * 60_000 })
    return true
  }
  entry.count++
  return entry.count <= max
}
export const clearAttempts = (key: string) => attempts.delete(key)

/** Drop expired sessions and stale login counters. The platform calls this about once an hour. */
export function pruneSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', now())
  for (const [key, entry] of attempts) if (entry.resetAt < Date.now()) attempts.delete(key)
}

export const USER_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6']
