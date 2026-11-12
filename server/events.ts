/** In-process event bus that feeds the browser over Server-Sent Events, plus viewer presence. */

export type AppEvent =
  | { type: 'conversation'; id: number; mailboxId: number; reason: string; actorId?: number | null }
  | { type: 'presence'; conversationId: number; viewers: Viewer[] }
  | { type: 'mailbox'; id: number }
  | { type: 'refresh'; scope: string }
  | { type: 'visitor'; conversationId: number; online: boolean }

export interface Viewer {
  userId: number
  name: string
  color: string
  avatarUrl: string | null
  state: 'viewing' | 'replying'
}

type Listener = (event: AppEvent) => void
const listeners = new Set<Listener>()

export function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publish(event: AppEvent) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      /* a broken stream must not stop the others */
    }
  }
}

interface PresenceEntry extends Viewer {
  seenAt: number
}
const presence = new Map<number, Map<number, PresenceEntry>>()
const PRESENCE_TTL = 45_000

export function viewersOf(conversationId: number): Viewer[] {
  const entries = presence.get(conversationId)
  if (!entries) return []
  return [...entries.values()].map(({ seenAt: _seenAt, ...viewer }) => viewer)
}

export function touchPresence(conversationId: number, viewer: Viewer) {
  let entries = presence.get(conversationId)
  if (!entries) presence.set(conversationId, (entries = new Map()))
  const before = entries.get(viewer.userId)
  entries.set(viewer.userId, { ...viewer, seenAt: Date.now() })
  if (!before || before.state !== viewer.state) publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
}

export function leavePresence(conversationId: number, userId: number) {
  const entries = presence.get(conversationId)
  if (!entries?.delete(userId)) return
  if (entries.size === 0) presence.delete(conversationId)
  publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
}

/** Forget viewers who stopped sending heartbeats. The platform calls this every few seconds. */
export function prunePresence() {
  const cutoff = Date.now() - PRESENCE_TTL
  for (const [conversationId, entries] of presence) {
    let changed = false
    for (const [userId, entry] of entries) {
      if (entry.seenAt < cutoff) {
        entries.delete(userId)
        changed = true
      }
    }
    if (entries.size === 0) presence.delete(conversationId)
    if (changed) publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
  }
}

// ---------------------------------------------------------------------------------------------
// Teammates with the app open
// ---------------------------------------------------------------------------------------------

/**
 * When each teammate's browser last talked to us. The web app sends a heartbeat every minute, even from a
 * background tab, so a teammate with the app open anywhere counts as here. Closing it makes them away.
 */
const agentSeenAt = new Map<number, number>()
const AGENT_TTL = 3 * 60_000

export function markAgentSeen(userId: number) {
  agentSeenAt.set(userId, Date.now())
}

export function agentActive(userId: number): boolean {
  const seen = agentSeenAt.get(userId)
  return seen !== undefined && Date.now() - seen < AGENT_TTL
}

// ---------------------------------------------------------------------------------------------
// Live chat visitors
// ---------------------------------------------------------------------------------------------

/** Open widget streams per chat conversation, and when the last one closed. */
const visitorStreams = new Map<number, number>()
const visitorLeftAt = new Map<number, number>()
/** Moving between pages of a website drops the stream for a moment. Count the visitor as present meanwhile. */
const VISITOR_GRACE = 20_000

export function visitorConnected(conversationId: number) {
  const count = (visitorStreams.get(conversationId) ?? 0) + 1
  visitorStreams.set(conversationId, count)
  visitorLeftAt.delete(conversationId)
  if (count === 1) publish({ type: 'visitor', conversationId, online: true })
}

export function visitorDisconnected(conversationId: number) {
  const count = (visitorStreams.get(conversationId) ?? 1) - 1
  if (count > 0) return void visitorStreams.set(conversationId, count)
  visitorStreams.delete(conversationId)
  visitorLeftAt.set(conversationId, Date.now())
}

/** True while the visitor has the chat open, or left only seconds ago. Replies then go to the chat, not by email. */
export function visitorOnline(conversationId: number): boolean {
  if (visitorStreams.has(conversationId)) return true
  const left = visitorLeftAt.get(conversationId)
  return left !== undefined && Date.now() - left < VISITOR_GRACE
}

/** Announce visitors whose grace period ran out. Runs with prunePresence. */
export function pruneVisitors() {
  for (const [conversationId, left] of visitorLeftAt) {
    if (Date.now() - left < VISITOR_GRACE) continue
    visitorLeftAt.delete(conversationId)
    publish({ type: 'visitor', conversationId, online: false })
  }
}
