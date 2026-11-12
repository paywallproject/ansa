export type Status = 'active' | 'waiting' | 'pending' | 'closed' | 'spam'
export type Folder = 'unassigned' | 'mine' | 'mentioned' | 'assigned' | 'pending' | 'snoozed' | 'closed' | 'spam' | 'all'

export interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'agent'
  color: string
  signature: string
  notifyAssigned: boolean
  notifyReplies: boolean
  notifyMentions: boolean
  disabled: boolean
  /** The teammate's photo, or null to show initials. */
  avatarUrl: string | null
  /** Live chat: available to chat, or away. */
  chatStatus: 'online' | 'away'
  /** In the team list only: available for live chat right now (Available, with the app open). */
  chatAvailable?: boolean
  /** 'all': every mailbox (always so for admins). 'some': only mailboxIds. */
  mailboxAccess: 'all' | 'some'
  mailboxIds: number[]
  /** IANA time zone for Send later. Empty until first filled in from the browser. */
  timezone: string
  createdAt: number
}

export interface FolderCounts {
  unassigned: number
  mine: number
  assigned: number
  snoozed: number
  spam: number
  mentioned: number
}

export type AssignAfterReply = 'keep' | 'replier' | 'choose'

export interface Mailbox {
  id: number
  name: string
  email: string
  fromName: string
  color: string
  imapEnabled: boolean
  smtpConfigured: boolean
  syncStatus: 'idle' | 'connecting' | 'ok' | 'error'
  syncError: string | null
  lastSyncAt: number | null
  /** Who a conversation goes to after a reply: leave as is, the person replying, or picked in the composer. */
  assignAfterReply: AssignAfterReply
  /** Live chat is turned on for this mailbox. */
  chatEnabled: boolean
  counts: FolderCounts
  // Admin-only fields
  signature?: string
  smtpHost?: string
  smtpPort?: number
  smtpSecurity?: 'starttls' | 'ssl' | 'none'
  smtpUser?: string
  smtpPasswordSet?: boolean
  imapHost?: string
  imapPort?: number
  imapSecurity?: 'starttls' | 'ssl' | 'none'
  imapUser?: string
  imapPasswordSet?: boolean
  /** IMAP signs in with the SMTP username and password. */
  imapSameLogin?: boolean
  imapFolder?: string
  importExisting?: boolean
  autoReplyEnabled?: boolean
  autoReplyBody?: string
  /** Whether visitors see the chat as online right now. */
  chatOnline?: boolean
  /** The public id in the widget's embed code. Set the first time chat is turned on. */
  chatKey?: string | null
  chat?: ChatSettings
}

export interface ChatSettings {
  title: string
  greeting: string
  color: string
  /** Websites allowed to show the widget. Empty: any. */
  origins: string[]
  /** When the chat shows as online: while a teammate is available, during office hours, or always. */
  availability: ChatAvailability
  hours: OfficeHours
  awayMessage: string
  hideWhenAway: boolean
}

export type ChatAvailability = 'team' | 'hours' | 'always'

export interface OfficeHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[]
  start: string
  end: string
  timezone: string
}

export interface Tag {
  id: number
  name: string
  color: string
  count?: number
}

export interface Customer {
  id: number
  name: string
  email: string
  emails: string[]
  company: string
  title: string
  phone: string
  location: string
  notes: string
  createdAt: number
  updatedAt: number
  conversationCount?: number
  lastSeenAt?: number | null
}

export interface ConversationSummary {
  id: number
  mailboxId: number
  mailboxName: string
  subject: string
  status: Status
  preview: string
  source: string
  customer: { id: number; name: string; email: string; company: string }
  assignee: { id: number; name: string; color: string; avatarUrl: string | null } | null
  tags: Tag[]
  cc: string[]
  threadCount: number
  hasAttachments: boolean
  snoozedUntil: number | null
  waitingSince: number | null
  createdAt: number
  updatedAt: number
  lastCustomerAt: number | null
  lastAgentAt: number | null
  closedAt: number | null
}

export interface Attachment {
  id: number
  filename: string
  mime: string
  size: number
  inline?: boolean
  url: string
}

export type Author =
  | { kind: 'customer'; id: number; name: string; email: string }
  | { kind: 'user'; id: number; name: string; color: string; avatarUrl: string | null }
  | { kind: 'system'; name: string }

export interface Thread {
  id: number
  type: 'customer' | 'reply' | 'note' | 'event'
  author: Author
  bodyHtml: string
  hasQuoted: boolean
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  state: 'sent' | 'sending' | 'failed' | 'scheduled'
  sendAt: number | null
  error: string | null
  event: Record<string, any> | null
  via: string
  /** The email as it arrived is kept, for "Show original". */
  hasOriginal: boolean
  createdAt: number
  attachments: Attachment[]
}

export interface Conversation extends Omit<ConversationSummary, 'customer'> {
  customer: Customer
  threads: Thread[]
  previousConversations: { id: number; subject: string; status: Status; updatedAt: number }[]
  draft: { kind: 'reply' | 'note'; bodyHtml: string } | null
  /** Live chat only: true while the visitor has the chat open. Null for other conversations. */
  visitorOnline: boolean | null
  url: string
}

export interface Viewer {
  userId: number
  name: string
  color: string
  avatarUrl: string | null
  state: 'viewing' | 'replying'
}

export interface SavedReply {
  id: number
  name: string
  bodyHtml: string
  mailboxId: number | null
  updatedAt: number
}

export interface WorkflowCondition {
  field: 'subject' | 'body' | 'from' | 'to' | 'customer_name'
  op: 'contains' | 'not_contains' | 'is' | 'starts_with' | 'ends_with'
  value: string
}
export interface WorkflowAction {
  type: 'add_tag' | 'assign' | 'set_status' | 'add_note'
  value: string
}
export interface Workflow {
  id: number
  name: string
  mailboxId: number | null
  enabled: boolean
  trigger: 'new' | 'customer_reply' | 'any'
  match: 'all' | 'any'
  conditions: WorkflowCondition[]
  actions: WorkflowAction[]
  runCount: number
}

export interface ApiToken {
  id: number
  name: string
  prefix: string
  lastUsedAt: number | null
  createdAt: number
}

export interface ReportTotals {
  newConversations: number
  messagesReceived: number
  repliesSent: number
  customersHelped: number
  closed: number
  medianFirstResponseMs: number | null
  medianResolutionMs: number | null
  firstResponseBuckets: { label: string; count: number }[]
}

export interface Report {
  from: number
  to: number
  current: ReportTotals
  previous: ReportTotals
  days: { date: string; newConversations: number; repliesSent: number; closed: number }[]
  busiest: number[][]
  tags: { name: string; color: string; count: number }[]
  team: { id: number; name: string; color: string; avatarUrl: string | null; replies: number; closed: number; customers: number }[]
  open: { active: number; pending: number; unassigned: number }
}
