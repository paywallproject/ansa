/**
 * Events that apps can subscribe to. The conversation service announces them here;
 * the apps service listens. Keeping this in its own file avoids a circular import.
 */
export const APP_EVENTS = [
  'conversation.created',
  'conversation.customer_replied',
  'conversation.agent_replied',
  'conversation.note_added',
  'conversation.status_changed',
  'conversation.assigned',
  'conversation.tags_changed',
] as const
export type AppEvent = (typeof APP_EVENTS)[number]

export interface AppEventDetail {
  /** The message that caused the event, when there is one. */
  threadId?: number
  /** Extra facts about the change, for example { from: 'active', to: 'closed' }. */
  change?: Record<string, unknown>
  /** Imported old mail does not notify apps. */
  historical?: boolean
}

type Listener = (event: AppEvent, conversationId: number, detail: AppEventDetail) => void
const listeners: Listener[] = []

export function onAppEvent(listener: Listener) {
  listeners.push(listener)
}

/** Announce an event. Listeners run after the current work finishes, so they always see saved data. */
export function emitAppEvent(event: AppEvent, conversationId: number, detail: AppEventDetail = {}) {
  if (detail.historical || listeners.length === 0) return
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(event, conversationId, detail)
      } catch (err) {
        console.error('[apps]', err)
      }
    }
  })
}
