import type { User } from './types'

/** Can this teammate see this mailbox? Admins and teammates with "all mailboxes" see every one. */
export const canSee = (user: Pick<User, 'mailboxAccess' | 'mailboxIds'>, mailboxId: number | undefined) =>
  mailboxId === undefined || user.mailboxAccess === 'all' || user.mailboxIds.includes(mailboxId)
