/**
 * Mailbox access. An admin sees every mailbox. Any other teammate sees every mailbox, or only the ones an
 * admin picked for them. A conversation, its messages, files and drafts belong to its mailbox: someone who
 * cannot see the mailbox cannot see or change them, and gets "not found" rather than "forbidden".
 */
import { get } from '../db.ts'
import type { User } from '../auth.ts'
import { AppError } from './customers.ts'

type Who = Pick<User, 'mailboxAccess' | 'mailboxIds'>

/** The mailboxes this teammate may see, or null for all of them. */
export const scopeOf = (user: Who): number[] | null => (user.mailboxAccess === 'all' ? null : user.mailboxIds)

export function canSeeMailbox(user: Who, mailboxId: number): boolean {
  const scope = scopeOf(user)
  return !scope || scope.includes(mailboxId)
}

export function assertMailbox(user: Who, mailboxId: number) {
  if (!canSeeMailbox(user, mailboxId)) throw new AppError('Mailbox not found.', 404)
}

/** Throws "not found" unless the teammate can see this conversation's mailbox. Returns the mailbox id. */
export function assertConversation(user: Who, conversationId: number): number {
  const row = get<{ mailbox_id: number }>('SELECT mailbox_id FROM conversations WHERE id = ?', conversationId)
  if (!row || !canSeeMailbox(user, row.mailbox_id)) throw new AppError('Conversation not found.', 404)
  return row.mailbox_id
}

export function assertThread(user: Who, threadId: number) {
  const row = get<{ conversation_id: number }>('SELECT conversation_id FROM threads WHERE id = ?', threadId)
  if (!row) throw new AppError('Message not found.', 404)
  assertConversation(user, row.conversation_id)
}

/** Can this teammate (by id) see this mailbox? For checks about someone other than the signed-in person. */
export function memberOf(userId: number, mailboxId: number): boolean {
  return !!get(
    `SELECT 1 FROM users u WHERE u.id = ? AND (u.role = 'admin' OR u.all_mailboxes = 1 OR EXISTS (SELECT 1 FROM mailbox_users mu WHERE mu.user_id = u.id AND mu.mailbox_id = ?))`,
    userId,
    mailboxId,
  )
}

/** SQL for "c.mailbox_id is one this teammate may see", with the ids written in. Empty when they see all. */
export function mailboxFilterSql(scope: number[] | null | undefined, column = 'c.mailbox_id'): string {
  if (!scope) return ''
  return scope.length ? `AND ${column} IN (${scope.map((id) => Math.trunc(id)).join(',')})` : 'AND 0'
}
