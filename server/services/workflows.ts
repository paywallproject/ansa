import { all, run, parseJson } from '../db.ts'
import { addNote, updateConversation, type Actor, type Status } from './conversations.ts'

export interface Condition {
  field: 'subject' | 'body' | 'from' | 'to' | 'customer_name'
  op: 'contains' | 'not_contains' | 'is' | 'starts_with' | 'ends_with'
  value: string
}
export interface Action {
  type: 'add_tag' | 'assign' | 'set_status' | 'add_note'
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

/** Run every enabled workflow for this mailbox against a new message. Errors in one workflow do not stop the rest. */
export function runWorkflows(conversationId: number, mailboxId: number, trigger: 'new' | 'customer_reply', ctx: WorkflowContext) {
  const workflows = all<any>(
    `SELECT * FROM workflows WHERE enabled = 1 AND (mailbox_id IS NULL OR mailbox_id = ?) AND (trigger = ? OR trigger = 'any') ORDER BY id`,
    mailboxId,
    trigger,
  )
  const actor: Actor = { userId: null, via: 'workflow' }
  for (const wf of workflows) {
    try {
      if (!matches(wf.match, parseJson<Condition[]>(wf.conditions, []), ctx)) continue
      for (const action of parseJson<Action[]>(wf.actions, [])) {
        if (action.type === 'add_tag') updateConversation(conversationId, { addTags: [action.value] }, actor)
        else if (action.type === 'assign') updateConversation(conversationId, { assigneeId: Number(action.value) || null }, actor)
        else if (action.type === 'set_status') updateConversation(conversationId, { status: action.value as Status }, actor)
        else if (action.type === 'add_note') addNote(conversationId, { bodyHtml: `<p>${action.value.replace(/</g, '&lt;')}</p>` }, actor)
      }
      run('UPDATE workflows SET run_count = run_count + 1 WHERE id = ?', wf.id)
    } catch (err) {
      console.error(`[workflow] "${wf.name}" failed on conversation ${conversationId}:`, (err as Error).message)
    }
  }
}
