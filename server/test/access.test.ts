import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every test file gets its own throwaway database. Set before the app modules load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-access-test-'))
process.env.MAIL_DISABLED = '1'

await import('../platform-node.ts')
const { migrate, run, get } = await import('../db.ts')
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
    '<table><tr><td><font size=1>The <b>messy</b> HTML version</font></td></tr></table>',
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
})
