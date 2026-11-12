import path from 'node:path'

const env = (name: string): string | undefined => (typeof process !== 'undefined' ? process.env?.[name] : undefined)

const dataDir = path.resolve(env('DATA_DIR') || './data')
const port = Number(env('PORT') || 3000)
/**
 * An address left over from an example file, such as https://help.example.com. Deploy to Cloudflare offers
 * the values in .env.example, so this can arrive as a real setting. It is treated as not set: on Cloudflare
 * Ansa then learns its address from the one people sign in on.
 */
export function isPlaceholderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /(^|\.)example\.(com|org|net)$/.test(host) || /\.(example|test|invalid)$/.test(host) || host === 'your-domain'
  } catch {
    return true
  }
}

const rawUrl = (env('APP_URL') || '').trim().replace(/\/+$/, '')
const configuredUrl = rawUrl && !isPlaceholderUrl(rawUrl) ? rawUrl : ''
if (rawUrl && !configuredUrl) console.warn(`[config] APP_URL is "${rawUrl}", an example address. Ignoring it: set APP_URL to the address people use to open Ansa.`)

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
