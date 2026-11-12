/**
 * Open tracking, as Help Scout does: a reply carries a 1×1 image whose address names the reply. When the
 * customer's mail app loads it, the reply is marked as viewed. The address is signed, so nobody can mark
 * a reply they did not receive. Apple Mail's privacy protection loads images by itself, so a view is a
 * good sign, not proof. Workspace settings can turn it off.
 */
import crypto from 'node:crypto'
import { get, run, now } from '../db.ts'
import { config } from '../config.ts'
import { publish } from '../events.ts'
import { getWorkspace } from './workspace.ts'

/**
 * Security scanners (Microsoft Defender, Mimecast…) fetch images the moment a message arrives. A load this soon
 * after sending is taken for one, unless it comes through a webmail image proxy: Gmail and Yahoo fetch only when
 * the person opens the email, and then keep their own copy, so ignoring that first load would lose the open.
 */
const SCANNER_MS = 3_000
const OPEN_PROXIES = /GoogleImageProxy|ggpht\.com|YahooMailProxy/i

const sign = (threadId: number) => crypto.createHmac('sha256', config.secret).update(`open:${threadId}`).digest('base64url').slice(0, 22)

export const openToken = (threadId: number) => `${threadId}.${sign(threadId)}`

export function threadFromToken(token: string): number | null {
  const match = /^(\d+)\.([\w-]{22})(?:\.gif)?$/.exec(token)
  if (!match) return null
  const id = Number(match[1])
  const expected = sign(id)
  return expected.length === match[2].length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[2])) ? id : null
}

/** The image to add to an outgoing reply, or nothing when tracking is off. */
export function openPixel(threadId: number): string {
  if (!getWorkspace().trackOpens) return ''
  return `<img src="${config.appUrl}/api/o/${openToken(threadId)}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`
}

/** The customer's mail app loaded the image. The first view is kept; later ones are counted. */
export function recordOpen(threadId: number, userAgent = '') {
  const t = get<{ conversation_id: number; created_at: number; opened_at: number | null; type: string }>('SELECT conversation_id, created_at, opened_at, type FROM threads WHERE id = ?', threadId)
  if (!t || t.type !== 'reply') return
  if (now() - t.created_at < SCANNER_MS && !OPEN_PROXIES.test(userAgent)) {
    // Kept apart, so a reply that shows no view can still say its image was fetched.
    run('UPDATE threads SET open_scans = open_scans + 1 WHERE id = ?', threadId)
    return
  }
  run('UPDATE threads SET opened_at = COALESCE(opened_at, ?), open_count = open_count + 1 WHERE id = ?', now(), threadId)
  if (t.opened_at === null) {
    const mailboxId = get<{ mailbox_id: number }>('SELECT mailbox_id FROM conversations WHERE id = ?', t.conversation_id)?.mailbox_id
    if (mailboxId) publish({ type: 'conversation', id: t.conversation_id, mailboxId, reason: 'opened' })
  }
}

/** A transparent 1×1 GIF. */
export const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0))
