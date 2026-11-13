import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Every test file gets its own throwaway database. Set before the app modules load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-test-'))
delete process.env.MAIL_DISABLED

await import('../platform-node.ts')
const { migrate, run, get } = await import('../db.ts')
const { config } = await import('../config.ts')
const { encrypt } = await import('../crypto.ts')
const { pollAllMailboxes, stopAllMailboxes } = await import('../mail/imap.ts')

// A mail server that says hello and then never answers again.
const sockets = new Set<net.Socket>()
const silent = net.createServer((socket) => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.write('* OK IMAP4rev1 ready\r\n')
})

let mailboxId = 0
before(async () => {
  migrate()
  config.imapPollOnly = true
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const { port } = silent.address() as net.AddressInfo
  mailboxId = run(
    `INSERT INTO mailboxes (name, email, imap_enabled, imap_host, imap_port, imap_security, imap_user, imap_pass_enc, sync_status, created_at)
     VALUES ('Support', 'support@acme.test', 1, '127.0.0.1', ?, 'none', 'support@acme.test', ?, 'ok', 1)`,
    port,
    encrypt('secret'),
  ).id
})

after(async () => {
  await stopAllMailboxes()
  for (const socket of sockets) socket.destroy()
  silent.close()
})

test('a mail check that never returns is stopped, so the next check can run', async () => {
  const started = Date.now()
  await pollAllMailboxes(300)
  assert.ok(Date.now() - started < 5000, 'the check gave up on time')
  const mailbox = get<{ sync_status: string; sync_error: string }>('SELECT sync_status, sync_error FROM mailboxes WHERE id = ?', mailboxId)!
  assert.equal(mailbox.sync_status, 'error')
  assert.match(mailbox.sync_error, /stopped answering/)

  // The next check starts afresh instead of waiting behind the stuck one.
  const again = Date.now()
  await pollAllMailboxes(300)
  assert.ok(Date.now() - again < 5000)
})
