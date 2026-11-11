import path from 'node:path'

const env = (name: string): string | undefined => (typeof process !== 'undefined' ? process.env?.[name] : undefined)

const dataDir = path.resolve(env('DATA_DIR') || './data')
const port = Number(env('PORT') || 3000)
const configuredUrl = (env('APP_URL') || '').replace(/\/+$/, '')

/**
 * Settings from the environment. This module has no side effects: the platform module
 * (platform-node.ts or worker/) fills in `secret` and, when APP_URL is not set, `appUrl`.
 */
export const config = {
  port,
  host: env('HOST') || '0.0.0.0',
  dataDir,
  attachmentsDir: path.join(dataDir, 'attachments'),
  dbPath: path.join(dataDir, 'ansa.db'),
  /** Public URL of this install, used in links inside emails. No trailing slash. */
  appUrl: configuredUrl || `http://localhost:${port}`,
  /** True when APP_URL was set explicitly, so the platform must not guess it. */
  appUrlFixed: configuredUrl !== '',
  /** Key material for encrypting saved mail passwords. Set by the platform module at start. */
  secret: env('APP_SECRET') && env('APP_SECRET')!.length >= 16 ? env('APP_SECRET')! : '',
  /** Seconds between IMAP checks. */
  imapPollSeconds: Number(env('IMAP_POLL_SECONDS') || 60),
  /** True where long-lived connections are not possible: connect, fetch new mail, disconnect. */
  imapPollOnly: false,
  maxAttachmentBytes: Number(env('MAX_ATTACHMENT_MB') || 25) * 1024 * 1024,
  /** Set to "1" to disable all outgoing/incoming mail (used by the demo seed). */
  mailDisabled: env('MAIL_DISABLED') === '1',
  isProd: env('NODE_ENV') === 'production',
}
