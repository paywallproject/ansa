import { get } from '../db.ts'
import { config } from '../config.ts'
import { escapeHtml } from '../mail/html.ts'
import { sendMail, wrapEmailHtml, type MailboxRow } from '../mail/outbound.ts'

/** Emails to teammates. Failures are logged and never block the action that caused them. */
function send(conversationId: number, userId: number, flag: 'notify_assigned' | 'notify_replies', headline: (ctx: { subject: string; customer: string }) => string) {
  if (config.mailDisabled) return
  const user = get<any>(`SELECT name, email, ${flag} AS wants FROM users WHERE id = ? AND disabled = 0`, userId)
  const conv = get<any>(
    `SELECT c.id, c.subject, c.preview, c.mailbox_id, cu.name AS customer_name, cu.email AS customer_email
     FROM conversations c JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ?`,
    conversationId,
  )
  if (!user?.wants || !conv) return
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', conv.mailbox_id)
  if (!mailbox?.smtp_host || user.email.toLowerCase() === mailbox.email.toLowerCase()) return
  const subject = conv.subject || '(no subject)'
  const title = headline({ subject, customer: conv.customer_name || conv.customer_email })
  const url = `${config.appUrl}/c/${conv.id}`
  const html = wrapEmailHtml(
    `<p>${escapeHtml(title)}</p>
     <p style="margin: 12px 0; padding: 10px 14px; background: #f6f8fa; border-radius: 8px;"><strong>${escapeHtml(subject)}</strong><br><span style="color: #57606a;">${escapeHtml(conv.preview)}</span></p>
     <p><a href="${url}">Open conversation #${conv.id}</a></p>`,
  )
  sendMail(mailbox, {
    to: [user.email],
    subject: `[${mailbox.name}] ${title}`,
    html,
    fromName: `${mailbox.name} (Ansa)`,
    headers: { 'X-Ansa-Notification': '1', 'Auto-Submitted': 'auto-generated' },
  }).catch((err) => console.error('[notify] could not send:', (err as Error).message))
}

export function notifyAssigned(conversationId: number, userId: number, byUserId: number | null) {
  const by = byUserId ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', byUserId)?.name : null
  send(conversationId, userId, 'notify_assigned', ({ subject }) => `${by || 'A workflow'} assigned you "${subject}"`)
}

export function notifyCustomerReply(conversationId: number) {
  const conv = get<{ assignee_id: number | null }>('SELECT assignee_id FROM conversations WHERE id = ?', conversationId)
  if (conv?.assignee_id) send(conversationId, conv.assignee_id, 'notify_replies', ({ customer }) => `${customer} replied to your conversation`)
}
