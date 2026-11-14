import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { all, get } from './db.ts'
import { config } from './config.ts'
import type { User } from './auth.ts'
import { htmlToText, textToHtml } from './mail/html.ts'
import {
  addNote,
  addReply,
  createConversation,
  folderCounts,
  getConversation,
  listConversations,
  saveDraft,
  sendScheduledNow,
  cancelScheduled,
  updateConversation,
  type Actor,
  type ConversationSummary,
} from './services/conversations.ts'
import { getCustomer, listCustomers, updateCustomer } from './services/customers.ts'
import { buildReport } from './services/reports.ts'
import { publish } from './events.ts'
import { assertConversation, assertMailbox, assertThread, canSeeMailbox, scopeOf } from './services/access.ts'
import { attachmentFile } from './services/attachments.ts'
import { AppError } from './services/customers.ts'

const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : null)
const toHtml = (body: string) => (/<(p|br|div|ul|ol|strong|em|a)\b[^>]*>/i.test(body) ? body : textToHtml(body))
// The reply box writes a blank line as an empty paragraph (paragraphs there have no gap between them),
// so a draft needs one between its paragraphs to look the way it will be sent.
const toDraftHtml = (body: string) => toHtml(body).replace(/<\/p>\s*<p(?=[\s>])/gi, '</p><p></p><p')

const brief = (c: ConversationSummary) => ({
  id: c.id,
  subject: c.subject,
  status: c.status,
  mailbox: c.mailboxName,
  mailbox_id: c.mailboxId,
  customer: { id: c.customer.id, name: c.customer.name, email: c.customer.email },
  assignee: c.assignee ? { id: c.assignee.id, name: c.assignee.name } : null,
  tags: c.tags.map((t) => t.name),
  preview: c.preview,
  messages: c.threadCount,
  waiting_since: iso(c.waitingSince),
  snoozed_until: iso(c.snoozedUntil),
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
  url: `${config.appUrl}/c/${c.id}`,
})

function detail(id: number, mailboxIds: number[] | null, userId: number) {
  const c = getConversation(id, { mailboxIds, userId })
  return {
    ...brief(c),
    customer: {
      id: c.customer.id,
      name: c.customer.name,
      email: c.customer.email,
      company: c.customer.company || undefined,
      notes: c.customer.notes || undefined,
    },
    cc: c.cc,
    thread: c.threads.map((t) =>
      t.type === 'event'
        ? { type: 'event', at: iso(t.createdAt), by: t.author.name, event: t.event }
        : {
            id: t.id,
            type: t.type === 'customer' ? 'customer_message' : t.type === 'reply' ? 'agent_reply' : 'internal_note',
            from: t.author.name,
            at: iso(t.createdAt),
            delivery: t.type === 'reply' ? t.state : undefined,
            // A scheduled reply: when it goes out, or held because the customer wrote first.
            send_at: t.state === 'scheduled' ? iso(t.sendAt) : undefined,
            held: t.state === 'scheduled' && t.event?.held ? true : undefined,
            only_if_no_reply: t.state === 'scheduled' && t.event?.ifNoReply ? true : undefined,
            error: t.error || undefined,
            text: htmlToText(t.bodyHtml),
            attachments: t.attachments.length
              ? t.attachments.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, inline: a.inline || undefined }))
              : undefined,
          },
    ),
    other_conversations_from_customer: c.previousConversations.map((p) => ({ id: p.id, subject: p.subject, status: p.status })),
    // Your unsent draft on this conversation (from the web app or draft_reply), if any.
    your_draft: c.draft ? { kind: c.draft.kind, text: htmlToText(c.draft.bodyHtml) } : null,
  }
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })
const fail = (err: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true })
const safe =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args))
    } catch (err) {
      return fail(err)
    }
  }

/** An ISO 8601 time in the future, for send later. */
function futureTime(value: string, field: string): number {
  const at = Date.parse(value)
  if (Number.isNaN(at)) throw new Error(`${field} must be an ISO 8601 date and time with a UTC offset, such as 2026-11-20T09:00:00-05:00.`)
  // addReply sends at once when the time is seconds away; an assistant asking to schedule never means "now".
  if (at <= Date.now() + 60_000) throw new Error(`${field} must be at least a minute in the future.`)
  return at
}

const TEXT_MIME = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-ndjson)\b)|\+(json|xml)\b/i
/** Images the assistant can look at directly. */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Larger files are not put in the tool result; the assistant gets a link to download them with its token. */
const MAX_INLINE_BYTES = 10 * 1024 * 1024

const STATUS = z.enum(['active', 'waiting', 'pending', 'closed', 'spam'])

function buildServer(user: User) {
  const actor: Actor = { userId: user.id, via: 'mcp' }
  // The assistant sees exactly the mailboxes its teammate sees.
  const scope = scopeOf(user)
  const mine = (id: number) => {
    assertConversation(user, id)
    return id
  }
  const server = new McpServer(
    { name: 'ansa', version: '1.0.0' },
    {
      instructions:
        `Ansa is a shared inbox for customer support. You act as ${user.name} (${user.email}). ` +
        'A conversation is one email thread with a customer. Its status is active (needs a reply), pending (waiting on the customer), closed or spam. ' +
        'reply_to_conversation sends a real email to the customer, so draft carefully and confirm with the user before sending unless told otherwise. ' +
        'add_note is internal and safe: customers never see notes. ' +
        'draft_reply is also safe: it writes a reply into the user\'s own draft for them to review and send from Ansa, and sends nothing. ' +
        'Prefer it when the user wants to check a reply first. ' +
        'To send a reply later, give reply_to_conversation a send_at time; list_scheduled_replies, cancel_scheduled_reply and send_scheduled_reply_now manage those. ' +
        'get_attachment downloads a file attached to a message.',
    },
  )

  server.registerTool(
    'list_mailboxes',
    { title: 'List mailboxes', description: 'List the shared mailboxes with the count of conversations that need attention in each folder.', annotations: { readOnlyHint: true } },
    safe(() => {
      const counts = folderCounts(user.id)
      return all<any>('SELECT id, name, email FROM mailboxes ORDER BY name').filter((m) => canSeeMailbox(user, m.id)).map((m) => {
        const c = counts.find((x) => x.mailboxId === m.id)
        return { id: m.id, name: m.name, email: m.email, needs_attention: { unassigned: c?.unassigned ?? 0, mine: c?.mine ?? 0, assigned: c?.assigned ?? 0 } }
      })
    }),
  )

  server.registerTool(
    'list_conversations',
    {
      title: 'List or search conversations',
      description:
        'List conversations, newest activity first. Filter by mailbox, folder, status, assignee, tag or customer, or search the full text of subjects, messages and customer names with `query`. ' +
        'Folders: unassigned, mine, assigned, snoozed, closed, spam, open (active + pending), all.',
      inputSchema: {
        mailbox_id: z.number().int().optional(),
        folder: z.enum(['unassigned', 'mine', 'mentioned', 'assigned', 'pending', 'snoozed', 'closed', 'spam', 'open', 'all']).optional(),
        status: STATUS.optional(),
        assignee_id: z.number().int().optional().describe('Teammate id from list_team'),
        tag: z.string().optional(),
        customer_id: z.number().int().optional(),
        query: z.string().optional().describe('Full-text search. A number finds that conversation id.'),
        sort: z.enum(['recent', 'oldest', 'waiting']).optional().describe('waiting = longest-waiting customer first'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe((a) => {
      const result = listConversations({
        mailboxId: a.mailbox_id,
        folder: a.folder,
        status: a.status,
        assigneeId: a.assignee_id,
        tag: a.tag,
        customerId: a.customer_id,
        q: a.query,
        sort: a.sort,
        limit: a.limit ?? 25,
        offset: a.offset,
        me: user.id,
        mailboxIds: scope,
      })
      return { total: result.total, offset: result.offset, conversations: result.items.map(brief) }
    }),
  )

  server.registerTool(
    'get_conversation',
    {
      title: 'Read a conversation',
      description: 'Get one conversation with every customer message, agent reply and internal note as plain text, plus the customer profile.',
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => detail(mine(a.id), scope, user.id)),
  )

  server.registerTool(
    'reply_to_conversation',
    {
      title: 'Send a reply to the customer',
      description:
        'Email a reply to the customer on an existing conversation. This sends real email. `body` is plain text (blank lines separate paragraphs) or simple HTML. ' +
        'The signature is added automatically. `status` is what the conversation becomes after sending (default closed; a customer reply reopens it). ' +
        '`assignee_id` is who it is assigned to afterwards (null: unassigned); leave it out to follow the mailbox\'s setting. ' +
        'Send later: pass `send_at` to schedule the reply instead of sending it now; with `only_if_no_reply` it is held back if the customer writes first. ' +
        'Until then it shows in the conversation as scheduled and can be cancelled with cancel_scheduled_reply.',
      inputSchema: {
        id: z.number().int(),
        body: z.string().min(1),
        status: z.enum(['active', 'waiting', 'pending', 'closed']).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        assignee_id: z.number().int().nullable().optional(),
        send_at: z
          .string()
          .optional()
          .describe('ISO 8601 time to send it, with a UTC offset (e.g. 2026-11-20T09:00:00-05:00). At least a minute ahead, within a year. Leave out to send now.'),
        only_if_no_reply: z.boolean().optional().describe('With send_at: do not send if the customer writes before then (a follow-up)'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    safe((a) => {
      const sendAt = a.send_at === undefined ? undefined : futureTime(a.send_at, 'send_at')
      if (a.only_if_no_reply && sendAt === undefined) throw new Error('only_if_no_reply needs a send_at time.')
      const replyId = addReply(
        mine(a.id),
        { bodyHtml: toHtml(a.body), status: a.status, cc: a.cc, bcc: a.bcc, assigneeId: a.assignee_id, sendAt, ifNoReply: a.only_if_no_reply },
        actor,
      )
      if (sendAt === undefined) return { sent: true, reply_id: replyId, conversation: brief(getConversation(a.id)) }
      return {
        sent: false,
        scheduled: true,
        reply_id: replyId,
        send_at: iso(sendAt),
        only_if_no_reply: !!a.only_if_no_reply,
        note: 'Nothing was sent yet. The conversation keeps its status until the reply goes out.',
        conversation: brief(getConversation(a.id)),
      }
    }),
  )

  server.registerTool(
    'list_scheduled_replies',
    {
      title: 'List scheduled replies',
      description:
        'Replies waiting to be sent later, soonest first. A held reply was to go only if the customer stayed quiet, and they wrote first: it will not send unless sent by hand.',
      inputSchema: { mine_only: z.boolean().optional().describe('Only replies you scheduled. Default false') },
      annotations: { readOnlyHint: true },
    },
    safe((a) =>
      all<any>(
        `SELECT t.id, t.conversation_id, t.send_at, t.event, t.body_text, u.name AS author, c.subject, c.mailbox_id, cu.name AS customer_name, cu.email AS customer_email
           FROM threads t JOIN conversations c ON c.id = t.conversation_id JOIN customers cu ON cu.id = c.customer_id LEFT JOIN users u ON u.id = t.user_id
          WHERE t.type = 'reply' AND t.state = 'scheduled' ${a.mine_only ? 'AND t.user_id = ?' : ''}
          ORDER BY t.send_at IS NULL, t.send_at`,
        ...(a.mine_only ? [user.id] : []),
      )
        .filter((t) => canSeeMailbox(user, t.mailbox_id))
        .map((t) => {
          let event: Record<string, any> = {}
          try {
            event = JSON.parse(t.event || '{}')
          } catch {}
          return {
            reply_id: t.id,
            conversation_id: t.conversation_id,
            subject: t.subject,
            customer: { name: t.customer_name, email: t.customer_email },
            by: t.author,
            send_at: iso(t.send_at),
            held: !!event.held,
            only_if_no_reply: !!event.ifNoReply,
            status_after: event.status ?? 'closed',
            text: t.body_text,
            url: `${config.appUrl}/c/${t.conversation_id}`,
          }
        }),
    ),
  )

  server.registerTool(
    'cancel_scheduled_reply',
    {
      title: 'Cancel a scheduled reply',
      description:
        "Take back a reply that is waiting to be sent. Its text goes back into its writer's draft on the conversation (unless they already have one there); its attachments are removed.",
      inputSchema: { reply_id: z.number().int().describe("From list_scheduled_replies, or a scheduled reply's id in get_conversation") },
      annotations: { destructiveHint: true },
    },
    safe((a) => {
      assertThread(user, a.reply_id)
      cancelScheduled(a.reply_id, actor)
      return { cancelled: true }
    }),
  )

  server.registerTool(
    'send_scheduled_reply_now',
    {
      title: 'Send a scheduled reply now',
      description: 'Send a reply that is waiting to be sent, without waiting for its time. This sends real email.',
      inputSchema: { reply_id: z.number().int() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    safe((a) => {
      assertThread(user, a.reply_id)
      sendScheduledNow(a.reply_id, actor)
      return { sent: true }
    }),
  )

  server.registerTool(
    'get_attachment',
    {
      title: 'Download an attachment',
      description:
        "Get a file attached to a message (ids are in get_conversation, under each message's attachments). " +
        'Images come back as images you can see, text files as text, and other files (PDF, Word, zip…) as base64 data. ' +
        `Files over ${MAX_INLINE_BYTES / 1048576} MB, or with as_link, come back as a download_url instead: fetch it with the same Authorization: Bearer token this server uses.`,
      inputSchema: {
        id: z.number().int(),
        as_link: z.boolean().optional().describe('Only return the details and download link, not the file'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        // A file belongs to its message's mailbox. One not sent yet belongs to whoever uploaded it (as in the REST API).
        const owner = get<{ thread_id: number | null; uploaded_by: number | null }>('SELECT thread_id, uploaded_by FROM attachments WHERE id = ?', a.id)
        if (!owner) throw new AppError('File not found.', 404)
        if (owner.thread_id) assertThread(user, owner.thread_id)
        else if (owner.uploaded_by !== user.id && user.mailboxAccess !== 'all') throw new AppError('File not found.', 404)
        const file = attachmentFile(a.id)
        if (!file) throw new AppError('File not found.', 404)
        const info = {
          id: a.id,
          filename: file.filename,
          mime: file.mime,
          size: file.size,
          conversation_id: owner.thread_id ? (get<{ conversation_id: number }>('SELECT conversation_id FROM threads WHERE id = ?', owner.thread_id)?.conversation_id ?? null) : null,
          download_url: `${config.appUrl}/api/attachments/${a.id}/${encodeURIComponent(file.filename)}?download`,
        }
        if (a.as_link || file.size > MAX_INLINE_BYTES) {
          const note = a.as_link ? undefined : 'Too large to return here. Download it from download_url with your token.'
          return ok({ ...info, note })
        }
        const head = ok(info).content[0]
        const uri = info.download_url
        if (IMAGE_MIME.has(file.mime)) return { content: [head, { type: 'image' as const, data: Buffer.from(file.data).toString('base64'), mimeType: file.mime }] }
        if (TEXT_MIME.test(file.mime)) return { content: [head, { type: 'resource' as const, resource: { uri, mimeType: file.mime, text: new TextDecoder().decode(file.data) } }] }
        return { content: [head, { type: 'resource' as const, resource: { uri, mimeType: file.mime, blob: Buffer.from(file.data).toString('base64') } }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'draft_reply',
    {
      title: 'Draft a reply for review',
      description:
        "Write a reply into the user's draft on a conversation, without sending anything. It shows in the conversation in Ansa as a draft " +
        'with an Edit button, ready to review and send. It replaces any draft they already had there (get_conversation shows it as your_draft). ' +
        '`body` is plain text (blank lines separate paragraphs) or simple HTML; the signature is added when it is sent. `kind` "note" drafts an internal note instead.',
      inputSchema: {
        id: z.number().int(),
        body: z.string().min(1),
        kind: z.enum(['reply', 'note']).optional().describe('Default reply'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    safe((a) => {
      const id = mine(a.id)
      saveDraft(id, user.id, a.kind ?? 'reply', toDraftHtml(a.body))
      // An open conversation shows the draft at once (its reply box picks up a draft that appears while empty).
      const c = getConversation(id)
      publish({ type: 'conversation', id, mailboxId: c.mailboxId, reason: 'draft', actorId: user.id })
      return { drafted: true, kind: a.kind ?? 'reply', url: c.url, note: 'Nothing was sent. The user can review and send it from Ansa.' }
    }),
  )

  server.registerTool(
    'add_note',
    {
      title: 'Add an internal note',
      description: 'Add a private note to a conversation for the team. The customer never sees it. Good for summaries, findings and suggested replies.',
      inputSchema: { id: z.number().int(), body: z.string().min(1) },
      annotations: { destructiveHint: false },
    },
    safe((a) => {
      addNote(mine(a.id), { bodyHtml: toHtml(a.body) }, actor)
      return { saved: true, conversation: brief(getConversation(a.id)) }
    }),
  )

  server.registerTool(
    'update_conversation',
    {
      title: 'Update a conversation',
      description: 'Change status, assignee, tags or subject, or snooze a conversation. Only the fields you pass change.',
      inputSchema: {
        id: z.number().int(),
        status: STATUS.optional(),
        assignee_id: z.number().int().nullable().optional().describe('Teammate id, or null to unassign'),
        add_tags: z.array(z.string()).optional(),
        remove_tags: z.array(z.string()).optional(),
        subject: z.string().optional(),
        snooze_until: z.string().nullable().optional().describe('ISO 8601 time to bring it back, or null to cancel a snooze'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    safe((a) => {
      const snoozedUntil = a.snooze_until === undefined ? undefined : a.snooze_until === null ? null : Date.parse(a.snooze_until)
      if (typeof snoozedUntil === 'number' && Number.isNaN(snoozedUntil)) throw new Error('snooze_until must be an ISO 8601 date and time.')
      return brief(
        updateConversation(mine(a.id), { status: a.status, assigneeId: a.assignee_id, addTags: a.add_tags, removeTags: a.remove_tags, subject: a.subject, snoozedUntil }, actor),
      )
    }),
  )

  server.registerTool(
    'create_conversation',
    {
      title: 'Start a conversation',
      description:
        'Create a conversation. kind "email" sends a new email to the customer. kind "customer_message" logs a message received from the customer by another channel. kind "note" logs an internal note (a call, a chat) without emailing anyone.',
      inputSchema: {
        mailbox_id: z.number().int(),
        customer_email: z.string(),
        customer_name: z.string().optional(),
        subject: z.string().min(1),
        body: z.string().min(1),
        kind: z.enum(['email', 'customer_message', 'note']),
        tags: z.array(z.string()).optional(),
        assignee_id: z.number().int().nullable().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    safe((a) => {
      assertMailbox(user, a.mailbox_id)
      const kind = a.kind === 'email' ? 'reply' : a.kind === 'customer_message' ? 'customer' : 'note'
      const created = createConversation(
        {
          mailboxId: a.mailbox_id,
          customerEmail: a.customer_email,
          customerName: a.customer_name,
          subject: a.subject,
          bodyHtml: toHtml(a.body),
          kind,
          tags: a.tags,
          assigneeId: a.assignee_id === undefined ? (kind === 'reply' ? user.id : null) : a.assignee_id,
        },
        actor,
      )
      return brief(getConversation(created.id))
    }),
  )

  server.registerTool(
    'list_customers',
    {
      title: 'Find customers',
      description: 'Search customers by name, email or company.',
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => {
      const result = listCustomers({ q: a.query, limit: a.limit ?? 25, offset: a.offset })
      return {
        total: result.total,
        customers: result.items.map((c) => ({ id: c.id, name: c.name, email: c.email, company: c.company || undefined, conversations: c.conversationCount, last_seen: iso(c.lastSeenAt) })),
      }
    }),
  )

  server.registerTool(
    'get_customer',
    {
      title: 'Read a customer profile',
      description: 'Get a customer profile and their recent conversations.',
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => ({ ...getCustomer(a.id), createdAt: undefined, updatedAt: undefined, conversations: listConversations({ customerId: a.id, limit: 25, mailboxIds: scope }).items.map(brief) })),
  )

  server.registerTool(
    'update_customer',
    {
      title: 'Update a customer profile',
      description: 'Edit profile fields on a customer. Only the fields you pass change.',
      inputSchema: {
        id: z.number().int(),
        name: z.string().optional(),
        company: z.string().optional(),
        title: z.string().optional(),
        phone: z.string().optional(),
        location: z.string().optional(),
        notes: z.string().optional().describe('Background notes shown beside every conversation with this customer'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    safe(({ id, ...patch }) => updateCustomer(id, patch)),
  )

  server.registerTool(
    'list_saved_replies',
    { title: 'List saved replies', description: 'Reusable reply templates the team has written. Use them as a starting point for replies.', annotations: { readOnlyHint: true } },
    safe(() => all<any>('SELECT id, name, body_html, mailbox_id FROM saved_replies ORDER BY name').filter((r) => r.mailbox_id === null || canSeeMailbox(user, r.mailbox_id)).map((r) => ({ id: r.id, name: r.name, text: htmlToText(r.body_html) }))),
  )

  server.registerTool(
    'list_tags',
    { title: 'List tags', description: 'Every tag with how many conversations carry it.', annotations: { readOnlyHint: true } },
    safe(() => all('SELECT t.name, (SELECT COUNT(*) FROM conversation_tags ct WHERE ct.tag_id = t.id) AS conversations FROM tags t ORDER BY t.name')),
  )

  server.registerTool(
    'list_team',
    { title: 'List teammates', description: 'The people who can be assigned conversations.', annotations: { readOnlyHint: true } },
    safe(() => all<any>('SELECT id, name, email, role FROM users WHERE disabled = 0 ORDER BY name').map((u) => ({ ...u, is_me: u.id === user.id }))),
  )

  server.registerTool(
    'get_report',
    {
      title: 'Support report',
      description: 'Support metrics for the last N days: volume, replies, response and resolution times, busiest tags and per-teammate activity, with the previous period for comparison.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Default 30'), mailbox_id: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => {
      const to = Date.now()
      if (a.mailbox_id) assertMailbox(user, a.mailbox_id)
      const report = buildReport({ from: to - (a.days ?? 30) * 86_400_000, to, mailboxId: a.mailbox_id, mailboxIds: scope })
      const minutes = (ms: number | null) => (ms === null ? null : Math.round(ms / 60_000))
      const shape = (t: typeof report.current) => ({
        new_conversations: t.newConversations,
        messages_received: t.messagesReceived,
        replies_sent: t.repliesSent,
        customers_helped: t.customersHelped,
        closed: t.closed,
        median_first_response_minutes: minutes(t.medianFirstResponseMs),
        median_resolution_minutes: minutes(t.medianResolutionMs),
      })
      return { period_days: a.days ?? 30, current: shape(report.current), previous_period: shape(report.previous), open_now: report.open, top_tags: report.tags.map((t) => ({ tag: t.name, conversations: t.count })), team: report.team }
    }),
  )

  return server
}

/** Stateless Streamable HTTP endpoint: one fresh server per request, authenticated by an API token. */
export async function handleMcp(request: Request, user: User): Promise<Response> {
  const server = buildServer(user)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    if (request.method !== 'GET') setTimeout(() => void server.close().catch(() => {}), 1000)
  }
}
