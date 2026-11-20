import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every test file gets its own throwaway database. Set before the app modules load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-access-test-'))
process.env.MAIL_DISABLED = '1'

await import('../platform-node.ts')
const { migrate, run, get, all } = await import('../db.ts')
const { createApp } = await import('../app.ts')
const { sha256, encrypt } = await import('../crypto.ts')
const conversations = await import('../services/conversations.ts')
const chat = await import('../services/chat.ts')
const events = await import('../events.ts')

let sales = 0
let billing = 0
let adminId = 0
let agentId = 0
let inSales = 0
let inBilling = 0
const app = createApp()

const tokenFor = (userId: number) => {
  const token = `ansa_test_${userId}`
  run('INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, 1)', userId, 't', sha256(token), 'ansa_test')
  return token
}
let adminToken = ''
let agentToken = ''
const call = async (token: string, method: string, url: string, body?: unknown) => {
  const res = await app.request(`/api${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, data: (await res.json()) as any }
}

before(() => {
  migrate()
  sales = run(`INSERT INTO mailboxes (name, email, created_at) VALUES ('Sales', 'sales@acme.test', 1)`).id
  billing = run(`INSERT INTO mailboxes (name, email, created_at) VALUES ('Billing', 'billing@acme.test', 1)`).id
  adminId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Ada Admin', 'ada@acme.test', 'x', 'admin', 1)`).id
  agentId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Sam Sales', 'sam@acme.test', 'x', 'agent', 1)`).id
  adminToken = tokenFor(adminId)
  agentToken = tokenFor(agentId)
  const system = { userId: null, via: 'email' as const }
  inSales = conversations.createConversation({ mailboxId: sales, customerEmail: 'pat@example.com', subject: 'Quote please', bodyHtml: '<p>Hi</p>', kind: 'customer' }, system).id
  inBilling = conversations.createConversation({ mailboxId: billing, customerEmail: 'pat@example.com', subject: 'Refund please', bodyHtml: '<p>Hi</p>', kind: 'customer' }, system).id
})

test('every teammate sees every mailbox until an admin limits them', async () => {
  const { data } = await call(agentToken, 'GET', '/mailboxes')
  assert.equal(data.mailboxes.length, 2)
  const me = await call(agentToken, 'GET', '/me')
  assert.equal(me.data.user.mailboxAccess, 'all')
})

test('an admin limits a teammate to some mailboxes', async () => {
  const { status, data } = await call(adminToken, 'PATCH', `/users/${agentId}`, { mailboxAccess: 'some', mailboxIds: [sales, 9999] })
  assert.equal(status, 200)
  assert.equal(data.user.mailboxAccess, 'some')
  assert.deepEqual(data.user.mailboxIds, [sales], 'unknown mailboxes are dropped')
})

test('a limited teammate sees only their mailboxes, everywhere', async () => {
  assert.deepEqual((await call(agentToken, 'GET', '/mailboxes')).data.mailboxes.map((m: any) => m.name), ['Sales'])
  assert.deepEqual((await call(agentToken, 'GET', '/conversations')).data.items.map((c: any) => c.id), [inSales])
  // Search cannot reach around it.
  assert.equal((await call(agentToken, 'GET', '/conversations?q=refund')).data.total, 0)
  assert.equal((await call(agentToken, 'GET', `/conversations?q=${inBilling}`)).data.total, 0)

  // The other mailbox's conversation does not exist for them, whatever they try.
  assert.equal((await call(agentToken, 'GET', `/conversations/${inBilling}`)).status, 404)
  assert.equal((await call(agentToken, 'POST', `/conversations/${inBilling}/reply`, { bodyHtml: '<p>x</p>' })).status, 404)
  assert.equal((await call(agentToken, 'POST', `/conversations/${inBilling}/note`, { bodyHtml: '<p>x</p>' })).status, 404)
  assert.equal((await call(agentToken, 'PATCH', `/conversations/${inBilling}`, { status: 'closed' })).status, 404)
  assert.equal((await call(agentToken, 'DELETE', `/conversations/${inBilling}`)).status, 404)
  assert.equal((await call(agentToken, 'POST', '/conversations/bulk', { ids: [inSales, inBilling], patch: { status: 'closed' } })).status, 404)
  assert.equal((await call(agentToken, 'POST', `/conversations/${inSales}/merge`, { intoId: inBilling })).status, 404)
  const billingThread = get<{ id: number }>('SELECT id FROM threads WHERE conversation_id = ?', inBilling)!.id
  assert.equal((await call(agentToken, 'GET', `/threads/${billingThread}/full`)).status, 404)
  // Nor can they move their conversation into a mailbox they cannot see, or start one there.
  assert.equal((await call(agentToken, 'PATCH', `/conversations/${inSales}`, { mailboxId: billing })).status, 404)
  assert.equal((await call(agentToken, 'POST', '/conversations', { mailboxId: billing, customerEmail: 'a@b.co', subject: 's', bodyHtml: '<p>x</p>', kind: 'note' })).status, 404)

  // The customer's history beside a conversation leaves out the other mailbox.
  const own = await call(agentToken, 'GET', `/conversations/${inSales}`)
  assert.equal(own.status, 200)
  assert.deepEqual(own.data.conversation.previousConversations, [])
  const customerId = own.data.conversation.customer.id
  assert.deepEqual((await call(agentToken, 'GET', `/customers/${customerId}`)).data.conversations.map((c: any) => c.id), [inSales])

  // Reports count only their mailboxes.
  assert.equal((await call(agentToken, 'GET', '/reports')).data.current.newConversations, 1)
  assert.equal((await call(adminToken, 'GET', '/reports')).data.current.newConversations, 2)
  assert.equal((await call(agentToken, 'GET', `/reports?mailbox=${billing}`)).status, 404)
})

test('a conversation can only be assigned to someone who can see its mailbox', async () => {
  const refused = await call(adminToken, 'PATCH', `/conversations/${inBilling}`, { assigneeId: agentId })
  assert.equal(refused.status, 400)
  assert.match(refused.data.error, /Sam Sales does not have access to this mailbox/)
  assert.equal((await call(adminToken, 'PATCH', `/conversations/${inSales}`, { assigneeId: agentId })).status, 200)

  // Moving it to a mailbox they cannot see lets go of it.
  await call(adminToken, 'PATCH', `/conversations/${inSales}`, { mailboxId: billing })
  assert.equal(get('SELECT assignee_id FROM conversations WHERE id = ?', inSales).assignee_id, null)
  await call(adminToken, 'PATCH', `/conversations/${inSales}`, { mailboxId: sales, assigneeId: agentId })
  assert.equal(get('SELECT assignee_id FROM conversations WHERE id = ?', inSales).assignee_id, agentId)

  // Taking a mailbox away unassigns their conversations in it.
  await call(adminToken, 'PATCH', `/users/${agentId}`, { mailboxAccess: 'some', mailboxIds: [billing] })
  assert.equal(get('SELECT assignee_id FROM conversations WHERE id = ?', inSales).assignee_id, null)
  await call(adminToken, 'PATCH', `/users/${agentId}`, { mailboxAccess: 'some', mailboxIds: [sales] })
})

test('admins always see every mailbox', async () => {
  run(`UPDATE users SET all_mailboxes = 0 WHERE id = ?`, adminId)
  assert.equal((await call(adminToken, 'GET', '/mailboxes')).data.mailboxes.length, 2)
  run(`UPDATE users SET all_mailboxes = 1 WHERE id = ?`, adminId)
})

test('live chat counts only teammates who can see the mailbox', () => {
  run(`UPDATE users SET chat_status = 'away' WHERE id = ?`, adminId)
  events.markAgentSeen(agentId)
  assert.deepEqual(chat.availableTeammates(sales), [agentId])
  assert.deepEqual(chat.availableTeammates(billing), [])
  run(`UPDATE users SET chat_status = 'online' WHERE id = ?`, adminId)
})

test('the mailbox form knows when IMAP signs in with the SMTP login', async () => {
  const pass = encrypt('s3cret')
  run(`UPDATE mailboxes SET smtp_user = 'support@acme.test', smtp_pass_enc = ?, imap_user = 'support@acme.test ', imap_pass_enc = ? WHERE id = ?`, pass, encrypt('s3cret'), sales)
  run(`UPDATE mailboxes SET smtp_user = 'support@acme.test', smtp_pass_enc = ?, imap_user = 'support@acme.test', imap_pass_enc = ? WHERE id = ?`, pass, encrypt('other'), billing)
  const boxes = (await call(adminToken, 'GET', '/mailboxes')).data.mailboxes
  assert.equal(boxes.find((m: any) => m.id === sales).imapSameLogin, true, 'same login, password encrypted separately')
  assert.equal(boxes.find((m: any) => m.id === billing).imapSameLogin, false, 'different password')
})

test('MCP: an assistant sees only the mailboxes of the teammate whose token it uses', async () => {
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await res.text()
    const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    return json.result as { isError?: boolean; content: { text: string }[] }
  }
  const denied = await tool('get_conversation', { id: inBilling })
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /not found/)
  const listed = JSON.parse((await tool('list_conversations', {})).content[0].text)
  assert.deepEqual(listed.conversations.map((c: any) => c.id), [inSales])
  const boxes = JSON.parse((await tool('list_mailboxes', {})).content[0].text)
  assert.deepEqual(boxes.map((m: any) => m.name), ['Sales'])
})

test('usernames that differ only in case are different logins', async () => {
  const pass = encrypt('s3cret')
  run(`UPDATE mailboxes SET smtp_user = 'Support@acme.test', smtp_pass_enc = ?, imap_user = 'support@acme.test', imap_pass_enc = ? WHERE id = ?`, pass, pass, sales)
  const boxes = (await call(adminToken, 'GET', '/mailboxes')).data.mailboxes
  assert.equal(boxes.find((m: any) => m.id === sales).imapSameLogin, false)
})

test('a failed connection test says which username and which password it tried', async () => {
  // Nothing listens on port 1, so the login never happens; the message must still not claim one did.
  const res = await call(adminToken, 'POST', '/mailboxes/test', { id: sales, kind: 'imap', imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', imapUser: 'x@acme.test', copySmtpPassword: true })
  assert.equal(res.data.ok, false)
  assert.doesNotMatch(res.data.message, /Tried/)
})

test('a blank mail username means the mailbox address once there is a password', async () => {
  const { loginUser, smtpOf } = await import('../mail/outbound.ts')
  assert.equal(loginUser('', true, 'support@acme.test'), 'support@acme.test')
  assert.equal(loginUser('  ', true, 'support@acme.test'), 'support@acme.test')
  assert.equal(loginUser('', false, 'support@acme.test'), '', 'a relay with no login stays without one')
  assert.equal(loginUser('me@other.test', true, 'support@acme.test'), 'me@other.test')
  run(`UPDATE mailboxes SET smtp_user = '', smtp_pass_enc = ? WHERE id = ?`, encrypt('pw'), sales)
  assert.equal(smtpOf(get('SELECT * FROM mailboxes WHERE id = ?', sales)!).user, 'sales@acme.test')
})

test('pending conversations sink below the ones waiting on us, whatever the sort', async () => {
  const system = { userId: null, via: 'email' as const }
  const older = conversations.createConversation({ mailboxId: sales, customerEmail: 'a@example.com', subject: 'Older, active', bodyHtml: '<p>1</p>', kind: 'customer', createdAt: 1_000 }, system).id
  const newer = conversations.createConversation({ mailboxId: sales, customerEmail: 'b@example.com', subject: 'Newer, pending', bodyHtml: '<p>2</p>', kind: 'customer' }, system).id
  conversations.updateConversation(newer, { status: 'pending' }, { userId: adminId, via: 'web' })
  for (const sort of ['recent', 'oldest', 'waiting'] as const) {
    const ids = conversations.listConversations({ mailboxId: sales, folder: 'open', sort }).items.map((c) => c.id)
    assert.ok(ids.indexOf(older) < ids.indexOf(newer), `${sort}: ${ids}`)
    assert.equal(ids[ids.length - 1], newer, sort)
  }
})

test('each teammate keeps a time zone, and only a real one', async () => {
  assert.equal((await call(agentToken, 'GET', '/me')).data.user.timezone, '')
  assert.equal((await call(agentToken, 'PATCH', '/me', { timezone: 'America/Chicago' })).data.user.timezone, 'America/Chicago')
  const bad = await call(agentToken, 'PATCH', '/me', { timezone: 'Moon/Base' })
  assert.equal(bad.status, 400)
  assert.match(bad.data.error, /not a time zone/)
  assert.equal((await call(agentToken, 'GET', '/me')).data.user.timezone, 'America/Chicago')
})

test('show original: the email as it arrived, its plain text and headers, kept until the conversation is deleted', async () => {
  const { ingestRaw } = await import('../mail/ingest.ts')
  const { blobs } = await import('../blobs.ts')
  const raw = [
    'Return-Path: <bounce+123@mail.example.com>',
    'Received: by 2002:a05:6000:1:b0:1 with SMTP id x; Fri, 13 Nov 2026 17:40:26 +0000',
    'Authentication-Results: mx.acme.test; dkim=pass header.i=@example.com header.s=s1; spf=pass smtp.mailfrom=bounce+123@mail.example.com; dmarc=pass header.from=example.com',
    'Received: from mail.example.com (mail.example.com [192.0.2.1]) by mx.acme.test with ESMTPS id abc (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384); Fri, 13 Nov 2026 17:40:25 +0000',
    'Authentication-Results: forged.test; dkim=pass header.d=bank.test',
    'From: Messy Sender <messy@example.com>',
    'To: sales@acme.test',
    'Subject: A very messy email',
    'Message-ID: <messy-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The clean plain text version.',
    '--b',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><head><title>Hidden</title><style>.x{color:red}</style><script>alert(1)</script></head><body bgcolor="#eee"><table width="600"><tr><td style="color:blue" onclick="alert(1)"><font size=1>The <b>messy</b> HTML version</font><a href="javascript:alert(1)">x</a><iframe src="https://evil.test"></iframe></td></tr></table></body></html>',
    '--b--',
    '',
  ].join('\r\n')
  const result = await ingestRaw(sales, raw)
  const thread = get<{ id: number; raw_key: string; conversation_id: number }>('SELECT id, raw_key, conversation_id FROM threads WHERE message_id = ?', '<messy-1@example.com>')!
  assert.ok(result && thread.raw_key)

  const conv = (await call(adminToken, 'GET', `/conversations/${thread.conversation_id}`)).data.conversation
  assert.equal(conv.threads[0].hasOriginal, true)
  const original = (await call(adminToken, 'GET', `/threads/${thread.id}/original`)).data
  assert.equal(original.available, true)
  assert.equal(original.text, 'The clean plain text version.')
  assert.match(original.source, /<font size=1>The <b>messy<\/b>/)
  assert.equal(original.headers.find((h: any) => h.name === 'Subject').value, 'A very messy email')
  // The email as designed: its layout and styles kept, nothing that runs or embeds another page.
  assert.match(original.html, /<style>\.x\{color:red\}<\/style>/)
  assert.match(original.html, /<div bgcolor="#eee"><table width="600"><tr><td style="color:blue">/)
  assert.doesNotMatch(original.html, /script|onclick|javascript|iframe|Hidden/)
  // Where it came from, from the headers your own server added (not the lower, forged one).
  assert.deepEqual(original.details, {
    mailedBy: 'mail.example.com',
    signedBy: ['example.com'],
    tls: true,
    checks: [{ name: 'SPF', result: 'pass' }, { name: 'DKIM', result: 'pass' }, { name: 'DMARC', result: 'pass' }],
  })

  const eml = await app.request(`/api/threads/${thread.id}/original.eml`, { headers: { Authorization: `Bearer ${adminToken}` } })
  assert.equal(eml.headers.get('content-type'), 'message/rfc822')
  assert.equal(await eml.text(), raw)

  // Someone without the mailbox cannot read it.
  await call(adminToken, 'PATCH', `/users/${agentId}`, { mailboxAccess: 'some', mailboxIds: [billing] })
  assert.equal((await call(agentToken, 'GET', `/threads/${thread.id}/original`)).status, 404)
  await call(adminToken, 'PATCH', `/users/${agentId}`, { mailboxAccess: 'some', mailboxIds: [sales] })

  // Deleting the conversation removes the kept original too.
  await call(adminToken, 'DELETE', `/conversations/${thread.conversation_id}`)
  await new Promise((resolve) => setTimeout(resolve, 100)) // files on disk are removed in the background
  assert.equal(blobs.get(thread.raw_key), null)

  // Older mail without an original still shows its text.
  const older = (await call(adminToken, 'GET', `/threads/${get<{ id: number }>('SELECT id FROM threads WHERE conversation_id = ?', inSales)!.id}/original`)).data
  assert.equal(older.available, false)
  assert.equal(typeof older.text, 'string')
  assert.equal(typeof older.html, 'string')
  assert.equal(older.details, null)
})

test('a new email can be sent later: it waits as pending, then goes out like any scheduled reply', async () => {
  const sendAt = Date.now() + 3_600_000
  const res = await call(adminToken, 'POST', '/conversations', { mailboxId: sales, customerEmail: 'later@example.com', subject: 'Following up', bodyHtml: '<p>See you next week</p>', kind: 'reply', sendAt })
  assert.equal(res.status, 201)
  const conv = res.data.conversation
  assert.equal(conv.status, 'pending')
  assert.equal(conv.preview, 'See you next week')
  assert.equal(conv.threads[0].state, 'scheduled')
  assert.equal(conv.threads[0].sendAt, sendAt)

  const realNow = Date.now
  Date.now = () => sendAt + 1000
  try {
    await conversations.dispatchScheduled()
  } finally {
    Date.now = realNow
  }
  const sent = conversations.getConversation(conv.id)
  assert.equal(sent.threads[0].state, 'sent')
  // Once it has gone out, a new email needs nothing more from us: it is closed until the customer answers.
  assert.equal(sent.status, 'closed')
})

test('the conversation list can see who is viewing what, in mailboxes you can see', async () => {
  const salesConv = conversations.createConversation({ mailboxId: sales, customerEmail: 'p1@example.com', subject: 'S', bodyHtml: '<p>x</p>', kind: 'customer' }, { userId: null, via: 'email' }).id
  const billingConv = conversations.createConversation({ mailboxId: billing, customerEmail: 'p2@example.com', subject: 'B', bodyHtml: '<p>x</p>', kind: 'customer' }, { userId: null, via: 'email' }).id
  await call(adminToken, 'POST', `/conversations/${salesConv}/presence`, { state: 'replying' })
  await call(adminToken, 'POST', `/conversations/${billingConv}/presence`, { state: 'viewing' })

  const forAdmin = (await call(adminToken, 'GET', '/presence')).data.presence
  assert.ok(forAdmin.some((p: any) => p.conversationId === salesConv && p.viewers[0].state === 'replying' && p.viewers[0].name === 'Ada Admin'))
  assert.ok(forAdmin.some((p: any) => p.conversationId === billingConv))

  // The agent sees only Sales.
  const forAgent = (await call(agentToken, 'GET', '/presence')).data.presence.map((p: any) => p.conversationId)
  assert.ok(forAgent.includes(salesConv))
  assert.ok(!forAgent.includes(billingConv))

  await call(adminToken, 'DELETE', `/conversations/${salesConv}/presence`)
  assert.ok(!(await call(adminToken, 'GET', '/presence')).data.presence.some((p: any) => p.conversationId === salesConv))
})

test('a new email is closed once sent', async () => {
  const res = await call(adminToken, 'POST', '/conversations', { mailboxId: sales, customerEmail: 'now@example.com', subject: 'Hello', bodyHtml: '<p>Hi</p>', kind: 'reply' })
  assert.equal(res.data.conversation.status, 'closed')
})

test('open tracking: a signed image marks a reply viewed, once enough time has passed', async () => {
  const opens = await import('../services/opens.ts')
  const { saveWorkspace } = await import('../services/workspace.ts')
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'open@example.com', subject: 'Track me', bodyHtml: '<p>Hi</p>', kind: 'reply' }, { userId: adminId, via: 'web' })
  const token = opens.openToken(conv.threadId)
  assert.match(opens.openPixel(conv.threadId), new RegExp(`/api/o/${token}\\.gif`))

  // Right after sending, a load is a mail scanner, not a person.
  let res = await app.request(`/api/o/${token}.gif`)
  assert.equal(res.headers.get('content-type'), 'image/gif')
  assert.equal(get('SELECT opened_at FROM threads WHERE id = ?', conv.threadId).opened_at, null)

  const realNow = Date.now
  Date.now = () => realNow() + 60_000
  try {
    await app.request(`/api/o/${token}.gif`)
    await app.request(`/api/o/${token}.gif`)
    // A forged token for the same reply changes nothing, and still answers with an image.
    res = await app.request(`/api/o/${conv.threadId}.AAAAAAAAAAAAAAAAAAAAAA.gif`)
    assert.equal(res.status, 200)
  } finally {
    Date.now = realNow
  }
  const thread = conversations.getConversation(conv.id).threads.find((t) => t.id === conv.threadId)!
  assert.ok(thread.openedAt)
  assert.equal(thread.openCount, 2)

  saveWorkspace({ trackOpens: false })
  assert.equal(opens.openPixel(conv.threadId), '')
  saveWorkspace({ trackOpens: true })
})

test('open tracking: Gmail opening at once still counts; an early scanner is set apart', async () => {
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'gmail@example.com', subject: 'Quick open', bodyHtml: '<p>Hi</p>', kind: 'reply' }, { userId: adminId, via: 'web' })
  const { openToken } = await import('../services/opens.ts')
  const token = openToken(conv.threadId)
  // A security scanner, a second after sending.
  await app.request(`/api/o/${token}.gif`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; scanner)' } })
  let row = get('SELECT opened_at, open_count, open_scans FROM threads WHERE id = ?', conv.threadId)
  assert.equal(row.opened_at, null)
  assert.equal(row.open_scans, 1)
  // The customer opens it in Gmail straight away: Google's image proxy fetches it, and that is an open.
  await app.request(`/api/o/${token}.gif`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' } })
  row = get('SELECT opened_at, open_count FROM threads WHERE id = ?', conv.threadId)
  assert.ok(row.opened_at)
  assert.equal(row.open_count, 1)
})

test('open tracking: the image is in the email that goes out', async () => {
  const nodemailer = (await import('nodemailer')).default as any
  const { config } = await import('../config.ts')
  const { deliverThread } = await import('../mail/outbound.ts')
  const { openToken } = await import('../services/opens.ts')
  const sent: any[] = []
  const realCreate = nodemailer.createTransport
  nodemailer.createTransport = () => ({ sendMail: async (mail: any) => void sent.push(mail), close() {} })
  run(`UPDATE mailboxes SET smtp_host = 'smtp.acme.test' WHERE id = ?`, sales)
  config.mailDisabled = false
  try {
    const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'pixel@example.com', subject: 'Pixel', bodyHtml: '<p>Hello</p>', kind: 'reply', skipDelivery: true }, { userId: adminId, via: 'web' })
    await deliverThread(conv.threadId)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].html.includes(`${config.appUrl}/api/o/${openToken(conv.threadId)}.gif`), 'the open-tracking image is in the sent HTML')
    assert.ok(!sent[0].text.includes('/api/o/'), 'and not in the plain-text part')
  } finally {
    config.mailDisabled = true
    nodemailer.createTransport = realCreate
  }
})

test('an example APP_URL left from .env.example is not used for links', async () => {
  const { isPlaceholderUrl } = await import('../config.ts')
  for (const url of ['https://help.example.com', 'https://example.com', 'https://support.example.org/', 'http://ansa.test', 'https://your-domain', 'not a url']) assert.equal(isPlaceholderUrl(url), true, url)
  for (const url of ['https://help.newsletterglue.com', 'https://ansa.acme.workers.dev', 'http://localhost:3000', 'https://examples.com']) assert.equal(isPlaceholderUrl(url), false, url)
})

test('MCP draft_reply: writes the teammate\'s own draft, sends nothing, and get_conversation shows it', async () => {
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'draftme@example.com', subject: 'Draft please', bodyHtml: '<p>Hi</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await res.text()
    const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    return json.result as { isError?: boolean; content: { text: string }[] }
  }
  const threadsBefore = get<{ n: number }>('SELECT COUNT(*) AS n FROM threads WHERE conversation_id = ?', conv.id)!.n
  const drafted = await tool('draft_reply', { id: conv.id, body: 'Thanks for writing in!\n\nWe will look into it.' })
  assert.equal(drafted.isError, undefined)
  assert.equal(JSON.parse(drafted.content[0].text).drafted, true)
  // Nothing was sent or added to the conversation.
  assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM threads WHERE conversation_id = ?', conv.id)!.n, threadsBefore)
  // The teammate sees it in the app as their draft, and the assistant can read it back.
  const inApp = (await call(agentToken, 'GET', `/conversations/${conv.id}`)).data.conversation.draft
  assert.equal(inApp.kind, 'reply')
  assert.match(inApp.bodyHtml, /Thanks for writing in!/)
  const detail = JSON.parse((await tool('get_conversation', { id: conv.id })).content[0].text)
  assert.match(detail.your_draft.text, /We will look into it/)
  // Not someone else's draft, and not in a mailbox the teammate cannot see.
  assert.equal((await call(adminToken, 'GET', `/conversations/${conv.id}`)).data.conversation.draft, null)
  const billingConv = conversations.createConversation({ mailboxId: billing, customerEmail: 'x@example.com', subject: 'B', bodyHtml: '<p>x</p>', kind: 'customer' }, { userId: null, via: 'email' })
  assert.equal((await tool('draft_reply', { id: billingConv.id, body: 'nope' })).isError, true)
})

test('a note can be deleted by its author or an admin, and only a note', async () => {
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'notes@example.com', subject: 'Notes', bodyHtml: '<p>Hi</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const byAgent = conversations.addNote(conv.id, { bodyHtml: '<p>Agent note</p>' }, { userId: agentId, via: 'web' })
  const byAdmin = conversations.addNote(conv.id, { bodyHtml: '<p>Admin note</p>' }, { userId: adminId, via: 'web' })
  const customerThread = get<{ id: number }>(`SELECT id FROM threads WHERE conversation_id = ? AND type = 'customer'`, conv.id)!.id
  const count = () => get<{ thread_count: number }>('SELECT thread_count FROM conversations WHERE id = ?', conv.id)!.thread_count

  // Not someone else's note, unless you are an admin; never a customer message.
  assert.equal((await call(agentToken, 'DELETE', `/threads/${byAdmin}`)).status, 403)
  assert.equal((await call(adminToken, 'DELETE', `/threads/${customerThread}`)).status, 400)

  const before = count()
  assert.equal((await call(agentToken, 'DELETE', `/threads/${byAgent}`)).status, 200)
  assert.equal(get('SELECT 1 FROM threads WHERE id = ?', byAgent), undefined)
  assert.equal(count(), before - 1)
  assert.equal((await call(adminToken, 'DELETE', `/threads/${byAdmin}`)).status, 200)
  assert.equal(count(), before - 2)
})

test('a reply can be undone for a few seconds, which puts the conversation back as it was', async () => {
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'undo@example.com', subject: 'Undo', bodyHtml: '<p>Help?</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const state = () => get<any>('SELECT status, assignee_id, thread_count, preview, waiting_since, first_reply_at FROM conversations WHERE id = ?', conv.id)
  const before = state()
  const sent = await call(agentToken, 'POST', `/conversations/${conv.id}/reply`, { bodyHtml: '<p>Oops, wrong customer</p>', status: 'closed', undoable: true, assigneeId: adminId })
  assert.equal(sent.status, 201)
  const threadId = sent.data.threadId
  // The conversation shows it at once; the email waits.
  assert.equal(state().status, 'closed')
  assert.equal(state().assignee_id, adminId)
  const shown = sent.data.conversation.threads.find((t: any) => t.id === threadId)
  assert.equal(shown.state, 'sending')
  assert.equal(typeof shown.undoUntil, 'number')
  assert.equal(get<any>('SELECT state FROM threads WHERE id = ?', threadId).state, 'scheduled')

  // Only its writer can undo it.
  assert.equal((await call(adminToken, 'POST', `/threads/${threadId}/undo`)).status, 403)
  assert.equal((await call(agentToken, 'POST', `/threads/${threadId}/undo`)).status, 200)
  assert.deepEqual(state(), before)
  assert.equal(get('SELECT 1 FROM threads WHERE id = ?', threadId), undefined)
  // The assignment it made is gone from the timeline, and the text is back in the writer's draft.
  assert.equal(get(`SELECT 1 FROM threads WHERE conversation_id = ? AND type = 'event'`, conv.id), undefined)
  assert.match(get<any>('SELECT body_html FROM drafts WHERE conversation_id = ? AND user_id = ?', conv.id, agentId).body_html, /wrong customer/)

  // Once the window has passed, it goes out like any reply, and can no longer be undone.
  const again = (await call(agentToken, 'POST', `/conversations/${conv.id}/reply`, { bodyHtml: '<p>The right answer</p>', status: 'closed', undoable: true })).data.threadId
  run('UPDATE threads SET send_at = ? WHERE id = ?', Date.now() - 1, again)
  await conversations.dispatchScheduled()
  const out = get<any>('SELECT state, event FROM threads WHERE id = ?', again)
  assert.notEqual(out.state, 'scheduled')
  assert.equal(JSON.parse(out.event).undo, undefined)
  assert.equal(state().status, 'closed')
  assert.equal(state().thread_count, before.thread_count + 1)
  assert.equal((await call(agentToken, 'POST', `/threads/${again}/undo`)).status, 400)
})

test('a note can be edited by its author only, and reacted to with an emoji', async () => {
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'edits@example.com', subject: 'Edits', bodyHtml: '<p>Hi</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const note = conversations.addNote(conv.id, { bodyHtml: '<p>Frist draft</p>' }, { userId: agentId, via: 'web' })
  const customerThread = get<{ id: number }>(`SELECT id FROM threads WHERE conversation_id = ? AND type = 'customer'`, conv.id)!.id
  const thread = async () => (await call(agentToken, 'GET', `/conversations/${conv.id}`)).data.conversation.threads.find((t: any) => t.id === note)

  // Only the author, not even an admin; never a customer message; never blank.
  assert.equal((await call(adminToken, 'PATCH', `/threads/${note}`, { bodyHtml: '<p>Mine now</p>' })).status, 403)
  assert.equal((await call(adminToken, 'PATCH', `/threads/${customerThread}`, { bodyHtml: '<p>x</p>' })).status, 400)
  assert.equal((await call(agentToken, 'PATCH', `/threads/${note}`, { bodyHtml: '<p> </p>' })).status, 400)
  assert.equal((await thread()).editedAt, null)

  assert.equal((await call(agentToken, 'PATCH', `/threads/${note}`, { bodyHtml: '<p>First draft</p>' })).status, 200)
  const edited = await thread()
  assert.match(edited.bodyHtml, /First draft/)
  assert.equal(typeof edited.editedAt, 'number')
  // The inbox and search follow the new text.
  assert.equal(get<{ note_preview: string }>('SELECT note_preview FROM conversations WHERE id = ?', conv.id)!.note_preview, 'First draft')

  // Reactions: one of each emoji per teammate, and tapping again takes it back.
  assert.equal((await call(agentToken, 'POST', `/threads/${note}/reactions`, { emoji: '👍' })).data.on, true)
  assert.equal((await call(adminToken, 'POST', `/threads/${note}/reactions`, { emoji: '👍' })).data.on, true)
  assert.equal((await call(adminToken, 'POST', `/threads/${note}/reactions`, { emoji: '🎉' })).data.on, true)
  let reactions = (await thread()).reactions
  assert.deepEqual(reactions.map((r: any) => [r.emoji, r.users.length]), [['👍', 2], ['🎉', 1]])
  assert.equal((await call(adminToken, 'POST', `/threads/${note}/reactions`, { emoji: '👍' })).data.on, false)
  reactions = (await thread()).reactions
  assert.deepEqual(reactions.map((r: any) => [r.emoji, r.users.map((u: any) => u.id)]), [['👍', [agentId]], ['🎉', [adminId]]])
  // Text is not an emoji, and customer messages take no reactions.
  assert.equal((await call(agentToken, 'POST', `/threads/${note}/reactions`, { emoji: 'lol' })).status, 400)
  assert.equal((await call(agentToken, 'POST', `/threads/${note}/reactions`, { emoji: '<b>' })).status, 400)
  assert.equal((await call(agentToken, 'POST', `/threads/${customerThread}/reactions`, { emoji: '👍' })).status, 400)
  // Flags, skin tones and joined emoji are fine.
  assert.equal((await call(agentToken, 'POST', `/threads/${note}/reactions`, { emoji: '👍🏽' })).status, 200)
  assert.equal((await call(agentToken, 'POST', `/threads/${note}/reactions`, { emoji: '🇹🇭' })).status, 200)
  assert.equal((await call(agentToken, 'POST', `/threads/${note}/reactions`, { emoji: '❤️' })).status, 200)

  // Deleting the note takes its reactions with it.
  assert.equal((await call(agentToken, 'DELETE', `/threads/${note}`)).status, 200)
  assert.equal(get('SELECT 1 FROM reactions WHERE thread_id = ?', note), undefined)
})

test('the inbox shows the newest note until someone writes again, and the note before it when it is deleted', async () => {
  const { addNote, deleteNote } = await import('../services/conversations.ts')
  const { ingestRaw } = await import('../mail/ingest.ts')
  const raw = (id: string, body: string, subject = 'Note preview') => ['From: Nora <nora@example.com>', 'To: sales@acme.test', `Subject: ${subject}`, `Message-ID: <${id}@example.com>`, ...(id === 'np-2' ? ['In-Reply-To: <np-1@example.com>'] : []), '', body, ''].join('\r\n')
  const first = await ingestRaw(sales, raw('np-1', 'Hello there'))
  const conversationId = first!.conversationId
  const summary = async () => (await call(adminToken, 'GET', `/conversations?mailboxId=${sales}&folder=all`)).data.conversations?.find((c: any) => c.id === conversationId) ?? (await call(adminToken, 'GET', `/conversations/${conversationId}`)).data.conversation
  const actor = { userId: null, via: 'api' } as any
  assert.equal((await summary()).notePreview, '')
  const one = addNote(conversationId, { bodyHtml: '<p>First   note</p>' }, actor)
  addNote(conversationId, { bodyHtml: '<p>Second note</p>' }, actor)
  assert.equal((await summary()).notePreview, 'Second note')
  assert.equal((await summary()).preview, 'Hello there')
  // Assigning it or changing its status afterwards keeps the note showing.
  await call(adminToken, 'PATCH', `/conversations/${conversationId}`, { assigneeId: adminId })
  assert.equal((await summary()).notePreview, 'Second note')
  // Deleting the newest note shows the one before it, even with an event after it.
  const second = get<{ id: number }>(`SELECT id FROM threads WHERE conversation_id = ? AND type = 'note' ORDER BY id DESC LIMIT 1`, conversationId)!.id
  deleteNote(second, actor, true)
  assert.equal((await summary()).notePreview, 'First note')
  // The customer writes again: the inbox goes back to the message.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await ingestRaw(sales, raw('np-2', 'One more thing', 'Re: Note preview'))
  assert.equal((await summary()).notePreview, '')
  assert.equal(one > 0, true)
})

test('MCP: replies scheduled for later, and attachments downloaded', async () => {
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await res.text()
    const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    return json.result as { isError?: boolean; content: any[] }
  }
  const { storeAttachment } = await import('../services/attachments.ts')
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'later@example.com', subject: 'Later', bodyHtml: '<p>Hi</p>', kind: 'customer' }, { userId: null, via: 'email' })

  // A time in the past, or without a date, is refused rather than sent at once.
  assert.equal((await tool('reply_to_conversation', { id: conv.id, body: 'x', send_at: '2020-01-01T00:00:00Z' })).isError, true)
  assert.equal((await tool('reply_to_conversation', { id: conv.id, body: 'x', send_at: 'tomorrow' })).isError, true)

  const at = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const scheduled = JSON.parse((await tool('reply_to_conversation', { id: conv.id, body: 'Following up!', send_at: at, only_if_no_reply: true })).content[0].text)
  assert.equal(scheduled.scheduled, true)
  assert.equal(scheduled.send_at, at)
  assert.equal(get<{ state: string }>('SELECT state FROM threads WHERE id = ?', scheduled.reply_id)!.state, 'scheduled')
  assert.equal(scheduled.conversation.status, 'active', 'status waits until it is sent')

  const listed = JSON.parse((await tool('list_scheduled_replies', {})).content[0].text)
  const mine = listed.find((r: any) => r.reply_id === scheduled.reply_id)
  assert.equal(mine.only_if_no_reply, true)
  assert.equal(mine.text, 'Following up!')
  const detail = JSON.parse((await tool('get_conversation', { id: conv.id })).content[0].text)
  assert.equal(detail.thread.find((t: any) => t.id === scheduled.reply_id).send_at, at)

  assert.equal(JSON.parse((await tool('cancel_scheduled_reply', { reply_id: scheduled.reply_id })).content[0].text).cancelled, true)
  assert.equal(get('SELECT 1 FROM threads WHERE id = ?', scheduled.reply_id), undefined)
  const again = JSON.parse((await tool('reply_to_conversation', { id: conv.id, body: 'Now then', send_at: at })).content[0].text)
  assert.equal(JSON.parse((await tool('send_scheduled_reply_now', { reply_id: again.reply_id })).content[0].text).sent, true)
  assert.equal(get<{ state: string }>('SELECT state FROM threads WHERE id = ?', again.reply_id)!.state, 'sent')

  // Attachments: ids in get_conversation; images as images, text as text, anything else as base64.
  const threadId = get<{ id: number }>(`SELECT id FROM threads WHERE conversation_id = ? AND type = 'customer'`, conv.id)!.id
  const png = storeAttachment(new Uint8Array([137, 80, 78, 71]), { filename: 'shot.png', mime: 'image/png', threadId })
  const txt = storeAttachment(new TextEncoder().encode('error log'), { filename: 'log.txt', mime: 'text/plain', threadId })
  const pdf = storeAttachment(new Uint8Array([37, 80, 68, 70]), { filename: 'invoice.pdf', mime: 'application/pdf', threadId })
  const listedFiles = JSON.parse((await tool('get_conversation', { id: conv.id })).content[0].text).thread.find((t: any) => t.id === threadId).attachments
  assert.deepEqual(listedFiles.map((f: any) => f.id), [png.id, txt.id, pdf.id])
  const image = await tool('get_attachment', { id: png.id })
  assert.equal(image.content[1].type, 'image')
  assert.equal(image.content[1].data, Buffer.from([137, 80, 78, 71]).toString('base64'))
  assert.equal((await tool('get_attachment', { id: txt.id })).content[1].resource.text, 'error log')
  assert.equal((await tool('get_attachment', { id: pdf.id })).content[1].resource.blob, Buffer.from([37, 80, 68, 70]).toString('base64'))
  const link = await tool('get_attachment', { id: pdf.id, as_link: true })
  assert.equal(link.content.length, 1)
  assert.match(JSON.parse(link.content[0].text).download_url, /\/api\/attachments\/\d+\/invoice\.pdf\?download$/)

  // Not a file from a mailbox the teammate cannot see.
  const billingConv = conversations.createConversation({ mailboxId: billing, customerEmail: 'y@example.com', subject: 'B', bodyHtml: '<p>x</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const hidden = storeAttachment(new Uint8Array([1]), { filename: 'secret.bin', threadId: get<{ id: number }>('SELECT id FROM threads WHERE conversation_id = ?', billingConv.id)!.id })
  assert.equal((await tool('get_attachment', { id: hidden.id })).isError, true)
})

test('MCP: files uploaded, attached and shown in the body, on replies, notes and drafts', async () => {
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await res.text()
    const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    const result = json.result as { isError?: boolean; content: any[] }
    return { ...result, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) }
  }
  const { storeAttachment } = await import('../services/attachments.ts')
  const conv = conversations.createConversation({ mailboxId: sales, customerEmail: 'files@example.com', subject: 'Files', bodyHtml: '<p>Hi</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const customerThread = get<{ id: number }>(`SELECT id FROM threads WHERE conversation_id = ? AND type = 'customer'`, conv.id)!.id
  const theirs = storeAttachment(new Uint8Array([9, 9]), { filename: 'their-screenshot.png', mime: 'image/png', threadId: customerThread })

  // Upload: as base64 or as text. The type follows the name.
  const png = (await tool('upload_attachment', { filename: 'steps.png', content_base64: Buffer.from([137, 80, 78, 71]).toString('base64') })).data
  assert.equal(png.mime, 'image/png')
  assert.equal(png.embed, `<img src="attachment:${png.id}" alt="steps.png">`)
  const csv = (await tool('upload_attachment', { filename: 'report.csv', text: 'a,b\n1,2' })).data
  assert.deepEqual([csv.mime, csv.size, csv.embed], ['text/csv', 7, undefined])
  assert.equal((await tool('upload_attachment', { filename: 'x.txt' })).isError, true)

  // A reply in plain text with an image on its own line, a file attached, and the customer's file sent back.
  const reply = (await tool('reply_to_conversation', { id: conv.id, body: `Here is how:\n\n${png.embed}\n\nThanks`, attachment_ids: [csv.id, theirs.id] })).data
  assert.equal(reply.sent, true)
  const thread = get<{ body_html: string }>('SELECT body_html FROM threads WHERE id = ?', reply.reply_id)!
  assert.match(thread.body_html, new RegExp(`<p><img src="/api/attachments/${png.id}/steps.png" alt="steps.png" /></p>`))
  const files = all<any>('SELECT id, filename, inline FROM attachments WHERE thread_id = ? ORDER BY id', reply.reply_id)
  assert.deepEqual(files.map((f: any) => [f.filename, f.inline]), [['steps.png', 1], ['report.csv', 0], ['their-screenshot.png', 0]])
  assert.notEqual(files[2].id, theirs.id, "the customer's file is copied, and stays on their message")
  assert.equal(get<{ thread_id: number }>('SELECT thread_id FROM attachments WHERE id = ?', theirs.id)!.thread_id, customerThread)

  // In the email: the image is a part of the message, linked by cid; the other files are plain attachments.
  const nodemailer = (await import('nodemailer')).default as any
  const { config } = await import('../config.ts')
  const { deliverThread } = await import('../mail/outbound.ts')
  const sent: any[] = []
  const realCreate = nodemailer.createTransport
  nodemailer.createTransport = () => ({ sendMail: async (mail: any) => void sent.push(mail), close() {} })
  run(`UPDATE mailboxes SET smtp_host = 'smtp.acme.test' WHERE id = ?`, sales)
  config.mailDisabled = false
  try {
    await deliverThread(reply.reply_id)
  } finally {
    config.mailDisabled = true
    nodemailer.createTransport = realCreate
  }
  const cid = `ansa-${png.id}@acme.test`
  assert.ok(sent[0].html.includes(`<img src="cid:${cid}"`), 'the image points at its part')
  assert.ok(!sent[0].html.includes('/api/attachments/'), 'no link that needs a login')
  assert.deepEqual(sent[0].attachments.map((a: any) => [a.filename, a.cid]), [['steps.png', cid], ['report.csv', undefined], ['their-screenshot.png', undefined]])

  // Used files cannot be claimed again by id; an upload goes on one message only, so a second use copies it.
  const note = (await tool('add_note', { id: conv.id, body: `<p>Sent them this:</p><img src="attachment:${png.id}">` })).data
  assert.equal(note.saved, true)
  const noteImage = get<any>(`SELECT a.id, a.inline FROM attachments a JOIN threads t ON t.id = a.thread_id WHERE t.conversation_id = ? AND t.type = 'note'`, conv.id)
  assert.deepEqual([noteImage.inline, noteImage.id !== png.id], [1, true])

  // Not a file that is not an image in the body, not someone else's upload, not a file in a mailbox the teammate cannot see.
  assert.match((await tool('add_note', { id: conv.id, body: `<img src="attachment:${csv.id}">` })).data, /not an image/)
  const adminUpload = storeAttachment(new Uint8Array([1]), { filename: 'admin.pdf', mime: 'application/pdf', uploadedBy: adminId })
  assert.match((await tool('add_note', { id: conv.id, body: 'x', attachment_ids: [adminUpload.id] })).data, /not found/)
  const billingConv = conversations.createConversation({ mailboxId: billing, customerEmail: 'z@example.com', subject: 'B', bodyHtml: '<p>x</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const hidden = storeAttachment(new Uint8Array([1]), { filename: 'secret.pdf', threadId: get<{ id: number }>('SELECT id FROM threads WHERE conversation_id = ?', billingConv.id)!.id })
  assert.equal((await tool('add_note', { id: conv.id, body: 'x', attachment_ids: [hidden.id] })).isError, true)

  // A draft keeps its image and its files; the app shows them, and sending it from the app sends them.
  const shot = (await tool('upload_attachment', { filename: 'shot.jpg', content_base64: Buffer.from([255, 216]).toString('base64') })).data
  const doc = (await tool('upload_attachment', { filename: 'guide.pdf', content_base64: Buffer.from([37, 80]).toString('base64') })).data
  const drafted = (await tool('draft_reply', { id: conv.id, body: `Look:\n\n${shot.embed}`, attachment_ids: [doc.id] })).data
  assert.deepEqual([drafted.images, drafted.attachments.map((f: any) => f.filename)], [1, ['guide.pdf']])
  // Revising the text keeps its files.
  await tool('draft_reply', { id: conv.id, body: `Look at this:\n\n${shot.embed}` })
  const draft = (await call(agentToken, 'GET', `/conversations/${conv.id}`)).data.conversation.draft
  assert.deepEqual(draft.attachments.map((f: any) => f.id), [doc.id])
  assert.match(draft.bodyHtml, new RegExp(`/api/attachments/${shot.id}/shot.jpg`))
  assert.deepEqual((await tool('get_conversation', { id: conv.id })).data.your_draft.attachments.map((f: any) => f.filename), ['guide.pdf'])
  const fromApp = await call(agentToken, 'POST', `/conversations/${conv.id}/reply`, { bodyHtml: draft.bodyHtml, attachmentIds: draft.attachments.map((f: any) => f.id) })
  assert.equal(fromApp.status, 201)
  const last = fromApp.data.conversation.threads.at(-1)
  assert.deepEqual(last.attachments.map((f: any) => [f.filename, f.inline]), [['shot.jpg', true], ['guide.pdf', false]])
  assert.equal(fromApp.data.conversation.draft, null)

  // Taken back from Send later, a reply's files return to the draft with its text.
  const later = await tool('upload_attachment', { filename: 'later.txt', text: 'soon' })
  const at = new Date(Date.now() + 86_400_000).toISOString()
  const scheduled = (await tool('reply_to_conversation', { id: conv.id, body: 'Later', send_at: at, attachment_ids: [later.data.id] })).data
  await tool('cancel_scheduled_reply', { reply_id: scheduled.reply_id })
  assert.deepEqual((await call(agentToken, 'GET', `/conversations/${conv.id}`)).data.conversation.draft.attachments.map((f: any) => f.filename), ['later.txt'])
  // Discarding it removes the files from the draft.
  await call(agentToken, 'PUT', `/conversations/${conv.id}/draft`, { kind: 'reply', bodyHtml: '', attachmentIds: [] })
  assert.equal((await call(agentToken, 'GET', `/conversations/${conv.id}`)).data.conversation.draft, null)
})
