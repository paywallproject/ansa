import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every test file gets its own throwaway database. Set before the app modules load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-test-'))
process.env.MAIL_DISABLED = '1'

await import('../platform-node.ts')
const html = await import('../mail/html.ts')
const { migrate, run, get, all } = await import('../db.ts')
const { ingestRaw } = await import('../mail/ingest.ts')
const conversations = await import('../services/conversations.ts')
const { matches } = await import('../services/workflows.ts')
const { hashPassword, verifyPassword, encrypt, decrypt } = await import('../crypto.ts')

let mailboxId = 0
let agentId = 0
before(() => {
  migrate()
  mailboxId = run(`INSERT INTO mailboxes (name, email, auto_reply_enabled, auto_reply_body, created_at) VALUES ('Support', 'support@acme.test', 1, 'Hi {{customer.firstName}}, we got your message.', 1)`).id
  agentId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Agent', 'agent@acme.test', 'x', 'admin', 1)`).id
})

const eml = (headers: Record<string, string>, body: string, type = 'text/plain') =>
  [...Object.entries({ 'MIME-Version': '1.0', 'Content-Type': `${type}; charset=utf-8`, ...headers }).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n')

test('cleanHtml removes scripts, handlers and unsafe links', () => {
  const out = html.cleanHtml('<p onclick="x()">Hi <a href="javascript:alert(1)">a</a><script>bad()</script><img src="x" onerror="y()"><iframe src="//evil"></iframe></p><style>p{}</style>')
  assert.ok(!/script|onclick|onerror|javascript:|iframe|style/i.test(out), out)
  assert.ok(out.includes('Hi'))
})

test('cleanHtml makes links open safely in a new tab', () => {
  assert.match(html.cleanHtml('<a href="https://example.com">x</a>'), /target="_blank" rel="noopener noreferrer nofollow"/)
})

test('stripQuotedHtml trims Gmail, Apple Mail and Outlook quotes', () => {
  assert.equal(html.stripQuotedHtml('<div>Thanks!</div><div class="gmail_quote"><blockquote>old</blockquote></div>'), '<div>Thanks!</div>')
  const apple = html.stripQuotedHtml('<div>Sounds good</div><div>On Nov 3, 2026, at 10:00, Sam &lt;s@x.com&gt; wrote:</div><blockquote type="cite">old</blockquote>')
  assert.ok(apple && apple.includes('Sounds good') && !apple.includes('wrote') && !apple.includes('old'), String(apple))
  const outlook = html.stripQuotedHtml('<p>Yes please</p><div id="divRplyFwdMsg"><b>From:</b> Support</div><p>old</p>')
  assert.ok(outlook && !outlook.includes('old'))
})

test('stripQuotedHtml leaves a message alone when nothing or everything would be removed', () => {
  assert.equal(html.stripQuotedHtml('<p>No quote here</p>'), null)
  assert.equal(html.stripQuotedHtml('<div class="gmail_quote">only a forward</div>'), null)
})

test('stripQuotedText trims "On … wrote:" and trailing > lines', () => {
  assert.equal(html.stripQuotedText('Works now.\n\nOn Tue, 3 Nov 2026 at 10:00, Sam <s@x.com> wrote:\n> old\n> text'), 'Works now.')
  assert.equal(html.stripQuotedText('Works now.\n\n> old\n> text\n'), 'Works now.')
  assert.equal(html.stripQuotedText('Just one line'), null)
})

test('textToHtml escapes, links and keeps paragraphs; htmlToText reverses it', () => {
  const out = html.textToHtml('Hi <b>\nsee https://example.com/a?b=1.\n\nBye')
  assert.equal(out, '<p>Hi &lt;b&gt;<br>see <a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a?b=1</a>.</p><p>Bye</p>')
  assert.equal(html.htmlToText('<p>Hi &amp; bye</p><ul><li>one</li><li>two</li></ul>'), 'Hi & bye\n\n- one\n- two')
})

test('passwords hash and verify; secrets encrypt and decrypt', () => {
  const hash = hashPassword('correct horse')
  assert.ok(verifyPassword('correct horse', hash))
  assert.ok(!verifyPassword('wrong', hash))
  const sealed = encrypt('app-password')
  assert.notEqual(sealed, 'app-password')
  assert.equal(decrypt(sealed), 'app-password')
  assert.equal(decrypt('garbage'), '')
})

test('workflow conditions match all or any', () => {
  const ctx = { subject: 'Refund please', body: 'I want my money back', from: 'a@globex.test', to: '', customer_name: 'Al' }
  assert.ok(matches('all', [{ field: 'subject', op: 'contains', value: 'refund' }, { field: 'from', op: 'ends_with', value: '@globex.test' }], ctx))
  assert.ok(!matches('all', [{ field: 'subject', op: 'contains', value: 'refund' }, { field: 'body', op: 'contains', value: 'invoice' }], ctx))
  assert.ok(matches('any', [{ field: 'subject', op: 'is', value: 'nope' }, { field: 'body', op: 'contains', value: 'money' }], ctx))
})

test('incoming email creates a conversation, auto-replies once, and runs workflows', async () => {
  run(`INSERT INTO workflows (name, trigger, match, conditions, actions, created_at) VALUES ('Tag refunds', 'new', 'all', ?, ?, 1)`, JSON.stringify([{ field: 'subject', op: 'contains', value: 'refund' }]), JSON.stringify([{ type: 'add_tag', value: 'refund' }, { type: 'assign', value: String(agentId) }]))
  const result = await ingestRaw(mailboxId, eml({ From: 'Jane Doe <jane@customer.test>', To: 'support@acme.test', Subject: 'Refund for order 7', 'Message-ID': '<m1@customer.test>' }, 'Please refund order 7.'))
  assert.ok(result?.created)
  const conv = conversations.getConversation(result.conversationId)
  assert.equal(conv.subject, 'Refund for order 7')
  assert.equal(conv.customer.name, 'Jane Doe')
  assert.deepEqual(conv.tags.map((t) => t.name), ['refund'])
  assert.equal(conv.assignee?.id, agentId)
  assert.equal(conv.status, 'active', 'an auto reply does not change the status')
  const auto = conv.threads.find((t) => t.type === 'reply')
  assert.ok(auto?.bodyHtml.includes('Hi Jane, we got your message.'))
  assert.ok(conv.waitingSince, 'the customer is still waiting for a real answer')

  assert.equal(await ingestRaw(mailboxId, eml({ From: 'jane@customer.test', Subject: 'Refund for order 7', 'Message-ID': '<m1@customer.test>' }, 'dup')), null, 'the same Message-ID is imported once')
})

test('a reply threads by In-Reply-To or References, reopens the conversation and trims the quote', async () => {
  const first = await ingestRaw(mailboxId, eml({ From: 'Sam <sam@customer.test>', Subject: 'Login broken', 'Message-ID': '<s1@customer.test>' }, 'I cannot log in.'))
  const id = first!.conversationId
  conversations.addReply(id, { bodyHtml: '<p>Try again now.</p>', status: 'closed' }, { userId: agentId, via: 'web' })
  const ours = get<{ message_id: string }>(`SELECT message_id FROM threads WHERE conversation_id = ? AND type = 'reply' AND via = 'web'`, id)!
  assert.equal(conversations.getSummary(id).status, 'closed')

  const second = await ingestRaw(mailboxId, eml({ From: 'Sam <sam@customer.test>', Subject: 'Re: Login broken', 'Message-ID': '<s2@customer.test>', References: `<unrelated@x> ${ours.message_id}` }, 'Works, thanks!\n\nOn Tue, Nov 3, 2026 at 10:00 Support wrote:\n> Try again now.'))
  assert.equal(second?.conversationId, id)
  assert.equal(second?.created, false)
  const conv = conversations.getConversation(id)
  assert.equal(conv.status, 'active')
  const last = conv.threads.filter((t) => t.type === 'customer').at(-1)!
  assert.equal(last.bodyHtml, '<p>Works, thanks!</p>')
  assert.ok(last.hasQuoted)
  assert.match(conversations.getQuotedHtml(last.id), /Try again now/)
})

test('our own mail, notifications and automated senders are handled safely', async () => {
  assert.equal(await ingestRaw(mailboxId, eml({ From: 'support@acme.test', Subject: 'loop', 'Message-ID': '<own@x>' }, 'x')), null)
  const before = all(`SELECT id FROM threads WHERE type = 'reply' AND via = 'auto'`).length
  const bounce = await ingestRaw(mailboxId, eml({ From: 'MAILER-DAEMON@mx.test', Subject: 'Undeliverable', 'Message-ID': '<b1@x>', 'Auto-Submitted': 'auto-replied' }, 'bounce'))
  assert.ok(bounce?.created)
  assert.equal(all(`SELECT id FROM threads WHERE type = 'reply' AND via = 'auto'`).length, before, 'never auto-reply to automated mail')
})

test('search, folders, snooze and merge behave', async () => {
  const a = conversations.createConversation({ mailboxId, customerEmail: 'kim@customer.test', subject: 'Zebra printer jams', bodyHtml: '<p>The zebra printer jams daily.</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const b = conversations.createConversation({ mailboxId, customerEmail: 'kim@customer.test', subject: 'Printer again', bodyHtml: '<p>Still jammed.</p>', kind: 'customer' }, { userId: null, via: 'email' })
  assert.deepEqual(conversations.listConversations({ q: 'zebra jam' }).items.map((c) => c.id), [a.id], 'full-text search with a prefix on the last word')
  assert.deepEqual(conversations.listConversations({ q: `#${b.id}` }).items.map((c) => c.id), [b.id])
  assert.equal(conversations.listConversations({ q: '"\'; DROP' }).items.length, 0)

  conversations.updateConversation(a.id, { snoozedUntil: Date.now() + 60_000 }, { userId: agentId, via: 'web' })
  assert.ok(!conversations.listConversations({ mailboxId, folder: 'unassigned' }).items.some((c) => c.id === a.id))
  assert.ok(conversations.listConversations({ mailboxId, folder: 'snoozed' }).items.some((c) => c.id === a.id))
  run('UPDATE conversations SET snoozed_until = 1 WHERE id = ?', a.id)
  conversations.wakeSnoozed()
  assert.equal(conversations.getSummary(a.id).snoozedUntil, null)

  const merged = conversations.mergeConversations(b.id, a.id, { userId: agentId, via: 'web' })
  assert.equal(merged.threadCount, 2)
  assert.throws(() => conversations.getSummary(b.id), /not found/)
  assert.deepEqual(conversations.listConversations({ q: 'still jammed' }).items.map((c) => c.id), [a.id])
})

test('inline images are served from our own URLs and other files become attachments', async () => {
  const boundary = 'BOUND'
  const raw = [
    'From: Pat <pat@customer.test>',
    'Subject: Screenshot',
    'Message-ID: <img1@customer.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>See <img src="cid:shot1"></p>',
    `--${boundary}`,
    'Content-Type: image/png; name="shot.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <shot1>',
    'Content-Disposition: inline; filename="shot.png"',
    '',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    `--${boundary}--`,
  ].join('\r\n')
  const result = await ingestRaw(mailboxId, raw)
  const thread = conversations.getConversation(result!.conversationId).threads[0]
  assert.match(thread.bodyHtml, /<img src="\/api\/attachments\/\d+\/shot\.png"/)
  assert.equal(thread.attachments[0].inline, true)
})

test('hostile HTML cannot stall quote stripping', () => {
  const started = Date.now()
  assert.equal(html.stripQuotedHtml('<div '.repeat(200_000)), null)
  assert.equal(html.stripQuotedHtml(`<p>Hi</p>${'<div class="x" '.repeat(100_000)}<div class="gmail_quote">old</div>`)?.includes('old'), false)
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`)
})

test('Reply-To names the customer when a form sends from its own address', async () => {
  const result = await ingestRaw(mailboxId, eml({ From: 'Website <support@acme.test>', 'Reply-To': 'Lee Wong <lee@customer.test>', Subject: 'Contact form', 'Message-ID': '<form1@acme.test>' }, 'Please call me.'))
  assert.ok(result?.created)
  const conv = conversations.getConversation(result.conversationId)
  assert.equal(conv.customer.email, 'lee@customer.test')
  assert.equal(conv.customer.name, 'Lee Wong')
})

test('a follow-up still threads after the conversation moved to another mailbox', async () => {
  const other = run(`INSERT INTO mailboxes (name, email, created_at) VALUES ('Billing', 'billing@acme.test', 1)`).id
  const first = await ingestRaw(mailboxId, eml({ From: 'Ana <ana@customer.test>', Subject: 'Invoice', 'Message-ID': '<a1@customer.test>' }, 'Where is my invoice?'))
  conversations.updateConversation(first!.conversationId, { mailboxId: other }, { userId: agentId, via: 'web' })
  const second = await ingestRaw(mailboxId, eml({ From: 'Ana <ana@customer.test>', Subject: 'Re: Invoice', 'Message-ID': '<a2@customer.test>', 'In-Reply-To': '<a1@customer.test>' }, 'Any news?'))
  assert.equal(second?.conversationId, first!.conversationId)
  assert.equal(conversations.getSummary(first!.conversationId).mailboxId, other)
})

test('a spoofed Date header does not backdate live mail, and bad input is rejected', async () => {
  const result = await ingestRaw(mailboxId, eml({ From: 'Old <old@customer.test>', Subject: 'Dated', 'Message-ID': '<d1@customer.test>', Date: 'Mon, 1 Jan 2001 10:00:00 +0000' }, 'hello'))
  assert.ok(Date.now() - conversations.getSummary(result!.conversationId).createdAt < 5000)
  assert.throws(() => conversations.createConversation({ mailboxId, customerEmail: 'x@customer.test', subject: 's', bodyHtml: '<p>b</p>', kind: 'note', status: 'archived' as never }, { userId: agentId, via: 'api' }), /Status must be/)
  assert.throws(() => conversations.createConversation({ mailboxId, customerEmail: 'x@customer.test', subject: 's', bodyHtml: '<p>b</p>', kind: 'note', assigneeId: 9999 }, { userId: agentId, via: 'api' }), /teammate/)
})

test('a customer reply releases a conversation from a deactivated teammate', async () => {
  const gone = run(`INSERT INTO users (name, email, password_hash, role, disabled, created_at) VALUES ('Gone', 'gone@acme.test', 'x', 'agent', 0, 1)`).id
  const created = conversations.createConversation({ mailboxId, customerEmail: 'zed@customer.test', subject: 'Old ticket', bodyHtml: '<p>Help</p>', kind: 'customer', assigneeId: gone }, { userId: null, via: 'email' })
  run('UPDATE users SET disabled = 1 WHERE id = ?', gone)
  const customerId = conversations.getSummary(created.id).customer.id
  conversations.addCustomerMessage(created.id, { customerId, bodyHtml: '<p>Still broken</p>' })
  assert.equal(conversations.getSummary(created.id).assignee, null)
})

test('apps: static sidebar fills placeholders safely, webhooks are signed', async () => {
  const http = await import('node:http')
  const crypto = await import('node:crypto')
  const apps = await import('../services/apps.ts')
  const received: { event: string; signature: string; body: string }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ event: String(req.headers['x-ansa-event']), signature: String(req.headers['x-ansa-signature']), body })
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  try {
    apps.createApp({ name: 'Links', sidebarMode: 'static', sidebarContent: '[Admin](https://admin.test/u?email={{customer.email|url}})\n\nHello {{customer.name}}' })
    const hook = apps.createApp({ name: 'Hook', webhookUrl: `http://127.0.0.1:${port}/hook`, events: ['conversation.created', 'conversation.status_changed'] })
    assert.throws(() => apps.createApp({ name: 'Bad', webhookUrl: 'ftp://x', events: ['conversation.created'] }))

    const { id } = conversations.createConversation(
      { mailboxId, customerEmail: 'eve+x@apps.test', customerName: 'Eve <script>alert(1)</script>', subject: 'Apps', bodyHtml: '<p>Hi</p>', kind: 'customer' },
      { userId: null, via: 'email' },
    )
    conversations.updateConversation(id, { status: 'closed' }, { userId: agentId, via: 'web' })

    const panels = await apps.sidebarsFor(id)
    const links = panels.find((p) => p.name === 'Links')!
    assert.ok(links.html.includes('href="https://admin.test/u?email=eve%2Bx%40apps.test"'), links.html)
    assert.ok(links.html.includes('>Admin</a>'), links.html)
    assert.ok(!links.html.includes('<script'), 'customer data cannot inject markup')

    for (let i = 0; i < 40 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(received.map((r) => r.event).sort(), ['conversation.created', 'conversation.status_changed'])
    for (const r of received) {
      assert.equal(r.signature, 'sha256=' + crypto.createHmac('sha256', hook.secret).update(r.body).digest('hex'))
      assert.equal(JSON.parse(r.body).customer.email, 'eve+x@apps.test')
    }
    assert.deepEqual(JSON.parse(received.find((r) => r.event === 'conversation.status_changed')!.body).change.to, 'closed')
    assert.equal(apps.listDeliveries(hook.id).filter((d) => d.ok).length, 2)
  } finally {
    server.close()
  }
})

test('help desk notification emails keep only the newest message', () => {
  const item = (who: string, verb: string, body: string) =>
    `<tr><td><table><tr><td><table><tr><td><h3 style="margin:0"><span><strong>${who}</strong> ${verb}</span></h3></td><td><div>Nov 10, 10:15pm</div></td></tr><tr><td colspan="2">&nbsp;</td></tr><tr><td colspan="2" style="padding:0"><div>${body}</div></td></tr></table></td></tr></table></td></tr>`
  const mail = `<table><tr><td><table><tr><td><p>-- Please reply above this line --</p></td></tr></table><table><tr><td><p><strong>Jane Doe</strong> replied to conversation <a href="https://desk.test/conversation/7">#7</a></p></td></tr>${item('Jane Doe', 'replied', '<div>Newest message</div><table><tr><td>a cell</td></tr></table>')}<tr><td><table><tr><td><table><tr><td><div>Sam assigned to you</div></td><td><div>Nov 8</div></td></tr></table></td></tr></table></td></tr>${item('Sam Agent', 'added a note', 'Older note')}${item('Jane Doe', 'started the conversation', 'First message')}<tr><td><p><a href="https://desk.test/users/notifications/7">Notification Settings</a></p></td></tr></table></td></tr></table>`
  const out = html.stripHelpdeskNotification(mail)!
  const text = html.htmlToText(out)
  assert.ok(text.includes('Newest message') && text.includes('a cell'), text)
  assert.ok(!/Older note|First message|assigned to you|Notification Settings|reply above/.test(text), text)
  // A single message still ends at the footer.
  const single = html.htmlToText(html.stripHelpdeskNotification(mail.replace(item('Sam Agent', 'added a note', 'Older note'), '').replace(item('Jane Doe', 'started the conversation', 'First message'), '').replace(/<tr><td><table><tr><td><table><tr><td><div>Sam assigned.*?<\/table><\/td><\/tr><\/table><\/td><\/tr>/, ''))!)
  assert.ok(single.includes('Newest message') && !single.includes('Notification Settings'), single)
  // Ordinary mail is left alone, even when it mentions the marker phrase.
  assert.equal(html.stripHelpdeskNotification('<p>Please reply above this line</p><p>Hello</p>'), null)
  assert.equal(html.stripHelpdeskNotification('<h3><strong>Jane</strong> replied</h3><p>Hello</p>'), null)
})
