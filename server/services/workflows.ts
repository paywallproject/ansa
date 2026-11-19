import { all, get, run, parseJson } from '../db.ts'
import { addNote, updateConversation, type Actor, type Status } from './conversations.ts'

export interface Condition {
  field: 'subject' | 'body' | 'from' | 'to' | 'customer_name'
  op: 'contains' | 'not_contains' | 'is' | 'starts_with' | 'ends_with'
  value: string
}
export interface Action {
  type: 'add_tag' | 'assign' | 'set_status' | 'add_note' | 'move_mailbox'
  value: string
}
export interface WorkflowContext {
  subject: string
  body: string
  from: string
  to: string
  customer_name: string
}

function test(condition: Condition, ctx: WorkflowContext): boolean {
  const haystack = String(ctx[condition.field] ?? '').toLowerCase()
  const needle = String(condition.value ?? '').toLowerCase().trim()
  if (!needle) return false
  switch (condition.op) {
    case 'contains':
      return haystack.includes(needle)
    case 'not_contains':
      return !haystack.includes(needle)
    case 'is':
      return haystack.trim() === needle
    case 'starts_with':
      return haystack.trim().startsWith(needle)
    case 'ends_with':
      return haystack.trim().endsWith(needle)
    default:
      return false
  }
}

export function matches(match: string, conditions: Condition[], ctx: WorkflowContext): boolean {
  if (conditions.length === 0) return true
  return match === 'any' ? conditions.some((c) => test(c, ctx)) : conditions.every((c) => test(c, ctx))
}

/**
 * Run every enabled workflow for the conversation's mailbox against a new message. Errors in one workflow do not stop the rest.
 *
 * A "move to mailbox" action hands the conversation over: workflows scoped to the old mailbox stop, and the
 * new mailbox's own workflows run next. Each mailbox is visited once, so two workflows that move a conversation
 * back and forth cannot loop. Workflows for every mailbox run once, whichever mailbox the conversation ends up in.
 */
export function runWorkflows(conversationId: number, mailboxId: number, trigger: 'new' | 'customer_reply', ctx: WorkflowContext) {
  const actor: Actor = { userId: null, via: 'workflow' }
  const ran = new Set<number>()
  // The mailbox the conversation is in now: a reply to a conversation someone moved can still arrive
  // through the mailbox it started in.
  let current = get<{ mailbox_id: number }>('SELECT mailbox_id FROM conversations WHERE id = ?', conversationId)?.mailbox_id ?? mailboxId
  const visited = new Set<number>([current])
  for (;;) {
    const wf = all<any>(
      `SELECT * FROM workflows WHERE enabled = 1 AND (mailbox_id IS NULL OR mailbox_id = ?) AND (trigger = ? OR trigger = 'any') ORDER BY id`,
      current,
      trigger,
    ).find((w) => !ran.has(w.id))
    if (!wf) return
    ran.add(wf.id)
    try {
      if (!matches(wf.match, parseJson<Condition[]>(wf.conditions, []), ctx)) continue
      for (const action of parseJson<Action[]>(wf.actions, [])) {
        if (action.type === 'add_tag') updateConversation(conversationId, { addTags: [action.value] }, actor)
        else if (action.type === 'assign') updateConversation(conversationId, { assigneeId: Number(action.value) || null }, actor)
        else if (action.type === 'set_status') updateConversation(conversationId, { status: action.value as Status }, actor)
        else if (action.type === 'add_note') addNote(conversationId, { bodyHtml: `<p>${action.value.replace(/</g, '&lt;')}</p>` }, actor)
        else if (action.type === 'move_mailbox') {
          const target = Number(action.value)
          if (!target || visited.has(target)) continue
          updateConversation(conversationId, { mailboxId: target }, actor)
          visited.add(target)
          current = target
        }
      }
      run('UPDATE workflows SET run_count = run_count + 1 WHERE id = ?', wf.id)
    } catch (err) {
      console.error(`[workflow] "${wf.name}" failed on conversation ${conversationId}:`, (err as Error).message)
    }
  }
}
