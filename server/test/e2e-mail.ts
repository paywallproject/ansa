/**
 * End-to-end mail check against a real SMTP + IMAP server (GreenMail in Docker).
 *
 *   docker run -d --rm --name greenmail -p 3025:3025 -p 3143:3143 \
 *     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' \
 *     greenmail/standalone:2.1.3
 *   npm run test:mail
 *   TEST_BASE_URL=http://localhost:8787 TEST_WAIT_MS=90000 npm run test:mail   (against `npm run dev:cf`, empty database)
 *
 * It starts Ansa on a throwaway data directory, then: customer email -> conversation,
 * agent reply -> customer's inbox, customer reply -> same conversation with the quote trimmed.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

const PORT = 3912
/** Set TEST_BASE_URL to check an instance that is already running (for example `wrangler dev`) instead of starting one. */
const EXTERNAL = process.env.TEST_BASE_URL
const BASE = EXTERNAL || `http://localhost:${PORT}`
const WAIT = Number(process.env.TEST_WAIT_MS || 30_000)
const HOST = process.env.TEST_MAIL_HOST || 'localhost'
const SMTP = { host: HOST, port: Number(process.env.TEST_SMTP_PORT || 3025) }
const IMAP = { host: HOST, port: Number(process.env.TEST_IMAP_PORT || 3143) }
const run = Date.now().toString(36)
const SUPPORT = `support-${run}@test.local`
const CUSTOMER = `jane-${run}@test.local`

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-e2e-'))
const server = EXTERNAL
  ? null
  : spawn('npx', ['tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, IMAP_POLL_SECONDS: '2', MAIL_DISABLED: '' },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
const cleanup = () => {
  server?.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

let cookie = ''
async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  const data = (await res.json()) as any
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data?.error}`)
  return data
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeout = WAIT): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

const customerSmtp = nodemailer.createTransport({ ...SMTP, secure: false, ignoreTLS: true })

const AGENT = `agent-${run}@test.local`
const customerInbox = () => inboxOf(CUSTOMER)
async function inboxOf(address: string) {
  const client = new ImapFlow({ ...IMAP, secure: false, auth: { user: address, pass: 'x' }, logger: false })
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  try {
    const out = []
    for await (const msg of client.fetch('1:*', { source: true })) out.push(await simpleParser(msg.source!))
    return out
  } finally {
    lock.release()
    await client.logout()
  }
}

const step = (text: string) => console.log(`\n✓ ${text}`)

try {
  await until('server start', async () => (await fetch(`${BASE}/healthz`)).ok)
  await call('POST', '/setup', { name: 'Test Agent', email: AGENT, password: 'password123' })

  const settings = {
    name: 'Support',
    email: SUPPORT,
    smtpHost: SMTP.host,
    smtpPort: SMTP.port,
    smtpSecurity: 'none',
    smtpUser: SUPPORT,
    smtpPassword: 'x',
    imapEnabled: true,
    imapHost: IMAP.host,
    imapPort: IMAP.port,
    imapSecurity: 'none',
    copySmtpPassword: true,
  }
  const smtpTest = await call('POST', '/mailboxes/test', { ...settings, kind: 'smtp' })
  assert.equal(smtpTest.ok, true, smtpTest.message)
  const imapTest = await call('POST', '/mailboxes/test', { ...settings, imapUser: SUPPORT, imapPassword: 'x', kind: 'imap' })
  assert.equal(imapTest.ok, true, imapTest.message)
  const bad = await call('POST', '/mailboxes/test', { ...settings, smtpPort: 1, kind: 'smtp' })
  assert.equal(bad.ok, false)
  step(`connection tests work (bad port says: "${bad.message}")`)

  const { mailbox } = await call('POST', '/mailboxes', settings)
  await until('IMAP connected', async () => (await call('GET', '/mailboxes')).mailboxes[0].syncStatus === 'ok')
  step('mailbox connected over IMAP')

  // 1. The customer writes in, with an attachment and an inline-looking HTML body.
  await customerSmtp.sendMail({
    from: { name: 'Jane Doe', address: CUSTOMER },
    to: SUPPORT,
    subject: 'Order 1042 arrived damaged',
    html: '<div>Hello,<br><br>My order <b>1042</b> arrived with a broken lid.<script>alert(1)</script></div>',
    attachments: [{ filename: 'photo.txt', content: 'pretend this is a photo' }],
  })
  const conv = await until('incoming email to become a conversation', async () => (await call('GET', `/conversations?mailbox=${mailbox.id}&folder=unassigned`)).items[0])
  assert.equal(conv.subject, 'Order 1042 arrived damaged')
  assert.equal(conv.customer.name, 'Jane Doe')
  assert.equal(conv.status, 'active')
  let detail = (await call('GET', `/conversations/${conv.id}`)).conversation
  assert.ok(!detail.threads[0].bodyHtml.includes('script'), 'script tags are removed')
  assert.equal(detail.threads[0].attachments[0].filename, 'photo.txt')
  const file = await fetch(`${BASE}${detail.threads[0].attachments[0].url}`, { headers: { Cookie: cookie } })
  assert.equal(await file.text(), 'pretend this is a photo')
  step('incoming email became a conversation, sanitized, with its attachment')

  // 2. The agent replies. The email must reach the customer and thread correctly.
  await call('POST', `/conversations/${conv.id}/reply`, { bodyHtml: '<p>Sorry about that, Jane. A replacement ships today.</p>', status: 'pending' })
  const reply = await until('reply to reach the customer inbox', async () => (await customerInbox())[0])
  assert.equal(reply.subject, 'Re: Order 1042 arrived damaged')
  assert.equal(reply.from?.value[0].address, SUPPORT)
  assert.ok(reply.inReplyTo, 'reply carries In-Reply-To')
  assert.ok(reply.text?.includes('A replacement ships today'))
  assert.ok(reply.html && reply.html.includes('gmail_quote'), 'reply quotes the customer message')
  detail = await until('reply marked sent', async () => {
    const c = (await call('GET', `/conversations/${conv.id}`)).conversation
    return c.threads.find((t: any) => t.type === 'reply')?.state === 'sent' ? c : null
  })
  assert.equal(detail.status, 'pending')
  assert.equal(detail.assignee.name, 'Test Agent')
  step('agent reply was delivered over SMTP with threading headers')

  // 3. The customer answers from a Gmail-style client. It must land in the same conversation, quote trimmed.
  await customerSmtp.sendMail({
    from: { name: 'Jane Doe', address: CUSTOMER },
    to: SUPPORT,
    subject: 'Re: Order 1042 arrived damaged',
    inReplyTo: reply.messageId,
    references: [reply.messageId!],
    html: `<div dir="ltr">Thank you, that is great news!</div><br><div class="gmail_quote"><div class="gmail_attr">On Tue, Support wrote:</div><blockquote class="gmail_quote">Sorry about that, Jane. A replacement ships today.</blockquote></div>`,
  })
  detail = await until('customer reply to join the conversation', async () => {
    const c = (await call('GET', `/conversations/${conv.id}`)).conversation
    return c.threads.filter((t: any) => t.type === 'customer').length === 2 ? c : null
  })
  const last = detail.threads[detail.threads.length - 1]
  assert.equal(detail.status, 'active', 'a customer reply reopens the conversation')
  assert.ok(last.bodyHtml.includes('great news') && !last.bodyHtml.includes('replacement ships'), 'quoted history is trimmed')
  assert.equal(last.hasQuoted, true)
  const all = (await call('GET', `/conversations?mailbox=${mailbox.id}&folder=all`)).items
  assert.equal(all.length, 1, 'no duplicate conversation was created')
  step('customer reply threaded into the same conversation with the quote trimmed')

  // 4. A send failure is reported on the message, not lost.
  await call('PATCH', `/mailboxes/${mailbox.id}`, { smtpPort: 1 })
  await call('POST', `/conversations/${conv.id}/reply`, { bodyHtml: '<p>This one cannot be delivered.</p>' })
  const failed = await until('failed reply to be flagged', async () => {
    const c = (await call('GET', `/conversations/${conv.id}`)).conversation
    return c.threads.find((t: any) => t.state === 'failed')
  })
  assert.ok(failed.error)
  await call('PATCH', `/mailboxes/${mailbox.id}`, { smtpPort: SMTP.port })
  await call('POST', `/threads/${failed.id}/retry`)
  await until('retry to succeed', async () => (await call('GET', `/conversations/${conv.id}`)).conversation.threads.every((t: any) => t.state === 'sent'))
  step(`failed send was flagged ("${failed.error}") and the retry delivered it`)

  // 5. The agent got a notification about the customer's reply, and answers it from their mail client.
  const notice = await until('notification to reach the agent', async () => (await inboxOf(AGENT)).find((m) => m.subject === `[Support #${conv.id}] Order 1042 arrived damaged`))
  assert.ok(notice.html && notice.html.includes('Please reply above this line') && notice.html.includes('great news'), 'notification carries the marker and the conversation')
  assert.ok(notice.html.includes(`Replying to this notification will email Jane Doe`))
  const quoted = `<div class="gmail_quote"><div class="gmail_attr">On Tue, Support (Ansa) wrote:</div><blockquote class="gmail_quote">${notice.html}</blockquote></div>`
  const before = (await customerInbox()).length

  // 5a. A reply from the wrong address is refused, and the agent is told.
  await customerSmtp.sendMail({ from: `stranger-${run}@test.local`, to: SUPPORT, subject: `Re: ${notice.subject}`, inReplyTo: notice.messageId, references: [notice.messageId!], html: `<div>Sneaky reply</div>${quoted}` })
  await until('rejection notice to reach the agent', async () => (await inboxOf(AGENT)).find((m) => /was not sent/.test(m.subject || '')))

  // 5b. The agent's own reply goes to the customer, without the quoted notification.
  await customerSmtp.sendMail({ from: { name: 'Test Agent', address: AGENT }, to: SUPPORT, subject: `Re: ${notice.subject}`, inReplyTo: notice.messageId, references: [notice.messageId!], html: `<div dir="ltr">Answered from my phone. The courier comes tomorrow.</div><br>${quoted}`, attachments: [{ filename: 'label.txt', content: 'shipping label' }] })
  const byEmail = await until('emailed reply to appear in the conversation', async () => {
    const c = (await call('GET', `/conversations/${conv.id}`)).conversation
    return c.threads.find((t: any) => t.type === 'reply' && t.via === 'email' && t.state === 'sent') ? c : null
  })
  const emailed = byEmail.threads.find((t: any) => t.type === 'reply' && t.via === 'email')
  assert.ok(emailed.bodyHtml.includes('courier comes tomorrow') && !/reply above|great news|Sneaky/.test(emailed.bodyHtml), emailed.bodyHtml)
  assert.equal(emailed.author.name, 'Test Agent')
  assert.equal(emailed.attachments[0]?.filename, 'label.txt')
  assert.equal(byEmail.status, 'pending')
  assert.ok(!byEmail.threads.some((t: any) => /Sneaky/.test(t.bodyHtml)), 'the stranger reply was not added')
  const delivered = await until('emailed reply to reach the customer', async () => {
    const all = await customerInbox()
    return all.length > before ? all[all.length - 1] : null
  })
  assert.ok(delivered.text?.includes('courier comes tomorrow') && !delivered.text.includes('reply above this line'))
  assert.equal(delivered.attachments[0]?.filename, 'label.txt')
  assert.equal((await call('GET', `/conversations?mailbox=${mailbox.id}&folder=all`)).items.length, 1, 'no stray conversation was created')
  step('agent replied to a notification by email; the customer got it, a stranger could not')

  console.log('\nAll mail checks passed.')
  cleanup()
  process.exit(0)
} catch (err) {
  console.error('\n✗', err)
  cleanup()
  process.exit(1)
}
