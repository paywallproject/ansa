import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const dataDir = path.resolve(process.env.DATA_DIR || './data')
fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true })

function loadSecret(): string {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) return process.env.APP_SECRET
  const file = path.join(dataDir, 'secret.key')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

const port = Number(process.env.PORT || 3000)

export const config = {
  port,
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  attachmentsDir: path.join(dataDir, 'attachments'),
  dbPath: path.join(dataDir, 'ansa.db'),
  /** Public URL of this install, used in links inside emails. No trailing slash. */
  appUrl: (process.env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  secret: loadSecret(),
  /** Seconds between IMAP polls when the server cannot IDLE. */
  imapPollSeconds: Number(process.env.IMAP_POLL_SECONDS || 60),
  maxAttachmentBytes: Number(process.env.MAX_ATTACHMENT_MB || 25) * 1024 * 1024,
  /** Set to "1" to disable all outgoing/incoming mail (used by the demo seed). */
  mailDisabled: process.env.MAIL_DISABLED === '1',
  isProd: process.env.NODE_ENV === 'production',
}
