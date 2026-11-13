/**
 * Slack: when an app's webhook URL is a Slack incoming webhook, Ansa sends a Slack message
 * instead of its own JSON. One line says what happened, with a link to the conversation, and a
 * card below shows the subject, the message and the customer, as Help Scout's Slack app does.
 */
import { htmlToText } from '../mail/html.ts'
import { statusLabel } from './workspace.ts'

const MAX_BODY = 700

export function isSlackWebhook(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'hooks.slack.com' || host.endsWith('.hooks.slack.com')
  } catch {
    return false
  }
}

/** Slack reads &, < and > as markup, so they are escaped everywhere text comes from a person. */
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const COLOR: Record<string, string> = { customer: '#8a8f98', agent: '#3b5bdb', note: '#e0a526', update: '#d0d4da' }

export interface SlackInput {
  event: string
  conversation: { id: number; url: string; subject: string; status: string; mailbox: { name: string }; assignee: { name: string } | null; tags: string[]; preview: string; threadCount: number }
  customer: { name: string; email: string }
  message?: { type: string; author: { name: string }; html: string }
  change?: Record<string, unknown>
}

/** The Slack message for an event, or null when it would repeat another message. */
export function slackMessage(input: SlackInput, subscribed: string[]): Record<string, unknown> | null {
  const { conversation: c, customer, message, change } = input
  const link = `<${c.url}|#${c.id}>`
  const author = esc(message?.author.name || 'Someone')

  // A conversation a teammate starts also announces itself as created; one message is enough.
  if ((input.event === 'conversation.agent_replied' || input.event === 'conversation.note_added') && c.threadCount <= 1 && subscribed.includes('conversation.created')) return null

  let lead: string
  let color = COLOR.update
  let showBody = true
  switch (input.event) {
    case 'ping':
      lead = `Ansa is connected to this channel. Here is how a new conversation will look: ${link}`
      color = COLOR.customer
      break
    case 'conversation.created':
      if (message && message.type !== 'customer') {
        lead = `${author} *started* a conversation ${link}`
        color = message.type === 'note' ? COLOR.note : COLOR.agent
      } else {
        lead = `A *new conversation* was created${c.assignee ? ` for ${esc(c.assignee.name)}` : ''} ${link}`
        color = COLOR.customer
      }
      break
    case 'conversation.customer_replied':
      lead = `A customer *replied* to a conversation ${link}`
      color = COLOR.customer
      break
    case 'conversation.agent_replied':
      lead = `${author} *replied* to a conversation ${link}`
      color = COLOR.agent
      break
    case 'conversation.note_added':
      lead = `${author} *added a note* to a conversation ${link}`
      color = COLOR.note
      break
    case 'conversation.status_changed':
      lead = `Conversation ${link} was marked *${esc(statusLabel(String(change?.to ?? c.status)))}*`
      showBody = false
      break
    case 'conversation.assigned':
      lead = change?.toName ? `Conversation ${link} was *assigned* to ${esc(String(change.toName))}` : `Conversation ${link} is now *unassigned*`
      showBody = false
      break
    case 'conversation.tags_changed': {
      const tags = Array.isArray(change?.to) ? (change.to as string[]) : c.tags
      lead = tags.length ? `Tags on conversation ${link} are now ${tags.map((t) => `\`${esc(t)}\``).join(' ')}` : `Tags were removed from conversation ${link}`
      showBody = false
      break
    }
    default:
      lead = `Conversation ${link} was updated`
      showBody = false
  }

  let body = ''
  if (showBody) {
    const text = message ? htmlToText(message.html) : c.preview
    const flat = text.replace(/\n{3,}/g, '\n\n').trim()
    body = flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1).trimEnd()}…` : flat
  }
  const who = customer.name && customer.name !== customer.email ? `${esc(customer.name)}\n${esc(customer.email)}` : esc(customer.email)

  return {
    text: lead,
    attachments: [
      {
        color,
        fallback: `${c.subject} (#${c.id})`,
        mrkdwn_in: ['text', 'fields'],
        text: [`*<${c.url}|${esc(c.subject || '(no subject)')}>*`, body && esc(body)].filter(Boolean).join('\n'),
        fields: [{ title: 'Customer', value: who, short: false }],
        footer: esc(c.mailbox.name),
      },
    ],
  }
}
