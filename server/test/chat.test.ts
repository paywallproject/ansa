import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every test file gets its own throwaway database. Set before the app modules load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-chat-test-'))
process.env.MAIL_DISABLED = '1'

await import('../platform-node.ts')
const { migrate, run, get } = await import('../db.ts')
const { createApp } = await import('../app.ts')
const conversations = await import('../services/conversations.ts')
const chat = await import('../services/chat.ts')
const events = await import('../events.ts')

let mailboxId = 0
let agentId = 0
let key = ''
const app = () => createApp()

before(() => {
  migrate()
  mailboxId = run(`INSERT INTO mailboxes (name, email, created_at) VALUES ('Support', 'support@acme.test', 1)`).id
  agentId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Dana Agent', 'dana@acme.test', 'x', 'admin', 1)`).id
  run('UPDATE mailboxes SET chat_enabled = 1 WHERE id = ?', mailboxId)
  key = chat.ensureChatKey(mailboxId)
})

test('a visitor starts a chat: a conversation with source "chat" and a token that finds it', () => {
  const mailbox = chat.chatMailbox(key)
  const { token, conversationId } = chat.startChat(mailbox, { name: 'Vera Visitor', email: 'vera@example.com', message: 'Hi!\nDoes the plan include SSO?' })
  const conv = conversations.getSummary(conversationId)
  assert.equal(conv.source, 'chat')
  assert.equal(conv.subject, 'Hi!')
  assert.equal(conv.customer.email, 'vera@example.com')
  assert.equal(chat.visitorFromToken(token)?.conversationId, conversationId)
  assert.equal(chat.visitorFromToken('not-a-token'), null)
  // Only the hash is stored.
  assert.equal(get('SELECT 1 FROM chat_visitors WHERE token_hash = ?', token), undefined)
})

test('start checks the name, email and message', () => {
  const mailbox = chat.chatMailbox(key)
  assert.throws(() => chat.startChat(mailbox, { name: '', email: 'a@b.co', message: 'x' }), /name/)
  assert.throws(() => chat.startChat(mailbox, { name: 'A', email: 'nope', message: 'x' }), /email/)
  assert.throws(() => chat.startChat(mailbox, { name: 'A', email: 'a@b.co', message: '   ' }), /message/)
  assert.throws(() => chat.startChat(mailbox, { name: 'A', email: 'a@b.co', message: 'x'.repeat(chat.CHAT_MAX_MESSAGE + 1) }), /characters/)
})

test('a turned-off chat is not available', () => {
  run('UPDATE mailboxes SET chat_enabled = 0 WHERE id = ?', mailboxId)
  assert.throws(() => chat.chatMailbox(key), /not available/)
  run('UPDATE mailboxes SET chat_enabled = 1 WHERE id = ?', mailboxId)
})

test('replies reach a present visitor in the chat, and go by email once they left', () => {
  const { token, conversationId } = chat.startChat(chat.chatMailbox(key), { name: 'Omar', email: 'omar@example.com', message: 'Hello' })
  const visitor = chat.visitorFromToken(token)!

  events.visitorConnected(conversationId)
  const live = conversations.addReply(conversationId, { bodyHtml: '<p>Hi Omar</p>', status: 'active' }, { userId: agentId, via: 'web' })
  assert.deepEqual(JSON.parse(get('SELECT event FROM threads WHERE id = ?', live).event), { status: 'active', channel: 'chat' })
  assert.equal(get('SELECT state FROM threads WHERE id = ?', live).state, 'sent')

  // A note never shows in the widget.
  conversations.addNote(conversationId, { bodyHtml: '<p>VIP customer</p>' }, { userId: agentId, via: 'web' })
  chat.postVisitorMessage(visitor, 'Thanks!')
  const transcript = chat.chatTranscript(visitor)
  assert.deepEqual(transcript.messages.map((m) => [m.from, m.html.replace(/<[^>]+>/g, '')]), [
    ['visitor', 'Hello'],
    ['team', 'Hi Omar'],
    ['visitor', 'Thanks!'],
  ])
  assert.equal(transcript.messages[1].name, 'Dana')

  // Gone, and past the short grace period for moving between pages.
  events.visitorDisconnected(conversationId)
  assert.equal(events.visitorOnline(conversationId), true)
  const realNow = Date.now
  Date.now = () => realNow() + 60_000
  try {
    assert.equal(events.visitorOnline(conversationId), false)
    const emailed = conversations.addReply(conversationId, { bodyHtml: '<p>Following up by email</p>', status: 'pending' }, { userId: agentId, via: 'web' })
    assert.equal(JSON.parse(get('SELECT event FROM threads WHERE id = ?', emailed).event).channel, 'email')
  } finally {
    Date.now = realNow
  }
})

test('merging a chat into another conversation moves the visitor with it', () => {
  const a = chat.startChat(chat.chatMailbox(key), { name: 'Mia', email: 'mia@example.com', message: 'First' })
  const b = conversations.createConversation({ mailboxId, customerEmail: 'mia@example.com', subject: 'By email', bodyHtml: '<p>Email</p>', kind: 'customer' }, { userId: null, via: 'email' })
  conversations.mergeConversations(a.conversationId, b.id, { userId: agentId, via: 'web' })
  assert.equal(chat.visitorFromToken(a.token)?.conversationId, b.id)
  assert.equal(conversations.getSummary(b.id).source, 'chat')
})

test('chat settings: defaults, tidy origins, and reject a website address with a path', () => {
  const current = chat.CHAT_DEFAULTS
  const next = chat.cleanChatSettings({ title: '  Talk to us ', color: '#AABBCC', origins: 'https://Example.com/\nhttps://*.shop.example.com, http://localhost:8080' }, current)
  assert.equal(next.title, 'Talk to us')
  assert.equal(next.color, '#aabbcc')
  assert.deepEqual(next.origins, ['https://example.com', 'https://*.shop.example.com', 'http://localhost:8080'])
  assert.equal(chat.cleanChatSettings({ color: 'red' }, next).color, '#aabbcc')
  assert.throws(() => chat.cleanChatSettings({ origins: ['https://example.com/help'] }, current), /not a website address/)
})

test('HTTP: the widget, the frame and the visitor API work without signing in', async () => {
  const a = app()
  const script = await a.request(`/api/chat/widget.js?key=${key}`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type') || '', /javascript/)
  assert.match(await script.text(), /AnsaChat/)
  // A bad key answers with harmless script, so the website keeps working.
  assert.equal(await (await a.request('/api/chat/widget.js?key=nope')).text(), '/* This chat is not available. */')

  const frame = await a.request(`/api/chat/frame?key=${key}`)
  assert.equal(frame.status, 200)
  assert.equal(frame.headers.get('x-frame-options'), null)
  assert.match(frame.headers.get('content-security-policy') || '', /frame-ancestors \*/)
  const page = await frame.text()
  assert.match(page, /Chat with us/)
  assert.ok(!page.includes('</script><'), 'config JSON must not close its script tag early')

  // With a list of websites, only they may frame it.
  run(`UPDATE mailboxes SET chat_settings = '{"origins":["https://acme.test"]}' WHERE id = ?`, mailboxId)
  assert.match((await a.request(`/api/chat/frame?key=${key}`)).headers.get('content-security-policy') || '', /frame-ancestors https:\/\/acme\.test$/)
  run(`UPDATE mailboxes SET chat_settings = '{}' WHERE id = ?`, mailboxId)

  // The rest of the app still refuses to be framed.
  assert.equal((await a.request('/healthz')).headers.get('x-frame-options'), 'DENY')

  const started = await a.request('/api/chat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, name: 'Hana', email: 'hana@example.com', message: 'Is anyone there?' }) })
  assert.equal(started.status, 201)
  const { token, transcript } = (await started.json()) as { token: string; transcript: { messages: unknown[] } }
  assert.equal(transcript.messages.length, 1)

  const sent = await a.request('/api/chat/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ansa-Chat': token }, body: JSON.stringify({ message: '<b>bold?</b>' }) })
  assert.equal(sent.status, 201)
  const after = (await sent.json()) as { transcript: { messages: { html: string }[] } }
  // Visitor text is escaped, never taken as HTML.
  assert.match(after.transcript.messages[1].html, /&lt;b&gt;bold\?&lt;\/b&gt;/)

  assert.equal((await a.request('/api/chat/messages')).status, 401)
  assert.equal((await a.request('/api/chat/messages', { headers: { 'X-Ansa-Chat': 'wrong' } })).status, 401)
  // The signed-in API is still closed.
  assert.equal((await a.request('/api/conversations')).status, 401)
})

test('HTTP: a teammate photo is public once uploaded, and 404 before', async () => {
  const a = app()
  assert.equal((await a.request(`/api/avatars/${agentId}`)).status, 404)
  const { blobs } = await import('../blobs.ts')
  blobs.put('avatars/test', new Uint8Array([137, 80, 78, 71]))
  run(`UPDATE users SET avatar_key = 'avatars/test', avatar_mime = 'image/png', avatar_version = 5 WHERE id = ?`, agentId)
  const photo = await a.request(`/api/avatars/${agentId}`)
  assert.equal(photo.status, 200)
  assert.equal(photo.headers.get('content-type'), 'image/png')
  const { serializeUser } = await import('../auth.ts')
  assert.equal(serializeUser(get('SELECT * FROM users WHERE id = ?', agentId)).avatarUrl, `/api/avatars/${agentId}?v=5`)
})

test('office hours follow their own time zone, and can run past midnight', () => {
  // Wednesday 2026-11-11 15:30 UTC is 10:30 in New York and 00:30 the next day in Tokyo.
  const at = Date.UTC(2026, 10, 11, 15, 30)
  const weekdays = [1, 2, 3, 4, 5]
  assert.equal(chat.withinHours({ days: weekdays, start: '09:00', end: '17:00', timezone: 'America/New_York' }, at), true)
  assert.equal(chat.withinHours({ days: weekdays, start: '09:00', end: '17:00', timezone: 'Asia/Tokyo' }, at), false)
  // 22:00–02:00 on Wednesdays: in Tokyo it is 00:30 on Thursday, still part of Wednesday's shift.
  assert.equal(chat.withinHours({ days: [3], start: '22:00', end: '02:00', timezone: 'Asia/Tokyo' }, at), true)
  assert.equal(chat.withinHours({ days: [4], start: '22:00', end: '02:00', timezone: 'Asia/Tokyo' }, at), false)
  // Weekend in New York.
  assert.equal(chat.withinHours({ days: weekdays, start: '09:00', end: '17:00', timezone: 'America/New_York' }, Date.UTC(2026, 10, 14, 15, 30)), false)
})

test('office hours settings are checked', () => {
  const base = chat.CHAT_DEFAULTS
  const ok = chat.cleanChatSettings({ availability: 'hours', hours: { days: [5, 1, 1], start: '08:30', end: '18:00', timezone: 'Europe/Berlin' } }, base)
  assert.deepEqual(ok.hours, { days: [1, 5], start: '08:30', end: '18:00', timezone: 'Europe/Berlin' })
  assert.equal(ok.availability, 'hours')
  assert.throws(() => chat.cleanChatSettings({ hours: { days: [], start: '09:00', end: '17:00', timezone: 'UTC' } }, base), /at least one day/)
  assert.throws(() => chat.cleanChatSettings({ hours: { days: [1], start: '9am', end: '17:00', timezone: 'UTC' } }, base), /times/)
  assert.throws(() => chat.cleanChatSettings({ hours: { days: [1], start: '09:00', end: '17:00', timezone: 'Mars/Olympus' } }, base), /time zone/)
  assert.equal(chat.cleanChatSettings({ availability: 'sometimes' }, base).availability, 'team')
})

test('online status: a teammate must be Available and have the app open; or office hours; or always', () => {
  const row = (settings: object) => ({ id: mailboxId, chat_settings: JSON.stringify(settings) })
  run(`UPDATE users SET chat_status = 'online'`)
  const realNow = Date.now
  try {
    // Nobody has the app open yet in this test process… unless an earlier request marked them. Move the clock past that.
    Date.now = () => realNow() + 10 * 60_000
    assert.equal(chat.chatOnline(row({ availability: 'team' })), false)
    events.markAgentSeen(agentId)
    assert.equal(chat.chatOnline(row({ availability: 'team' })), true)
    run(`UPDATE users SET chat_status = 'away' WHERE id = ?`, agentId)
    assert.equal(chat.chatOnline(row({ availability: 'team' })), false)
    run(`UPDATE users SET chat_status = 'online' WHERE id = ?`, agentId)
    // The app closed: after three minutes without a heartbeat they no longer count.
    Date.now = () => realNow() + 14 * 60_000
    assert.equal(chat.chatOnline(row({ availability: 'team' })), false)
    assert.equal(chat.chatOnline(row({ availability: 'always' })), true)
    const allWeek = { days: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' }
    assert.equal(chat.chatOnline(row({ availability: 'hours', hours: { ...allWeek, start: '00:00', end: '23:59' } }), Date.UTC(2026, 0, 1, 12)), true)
    assert.equal(chat.chatOnline(row({ availability: 'hours', hours: { ...allWeek, start: '13:00', end: '14:00' } }), Date.UTC(2026, 0, 1, 12)), false)
  } finally {
    Date.now = realNow
  }
})

test('HTTP: the status endpoint is readable from any website', async () => {
  run(`UPDATE mailboxes SET chat_settings = '{"availability":"always","hideWhenAway":true}' WHERE id = ?`, mailboxId)
  const res = await createApp().request(`/api/chat/status?key=${key}`)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await res.json(), { online: true, hideWhenAway: true, available: true })
  const missing = await createApp().request('/api/chat/status?key=nope')
  assert.equal(((await missing.json()) as { available: boolean }).available, false)
  run(`UPDATE mailboxes SET chat_settings = '{}' WHERE id = ?`, mailboxId)
})

test('conversation events say they are live chat, so browsers can notify about chats', () => {
  const seen: any[] = []
  const stop = events.subscribe((e) => void seen.push(e))
  try {
    const { conversationId } = chat.startChat(chat.chatMailbox(key), { name: 'Nia', email: 'nia@example.com', message: 'Hello?' })
    const created = seen.find((e) => e.type === 'conversation' && e.id === conversationId && e.reason === 'created')
    assert.equal(created?.source, 'chat')
  } finally {
    stop()
  }
})
