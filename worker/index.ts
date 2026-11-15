/**
 * Cloudflare Workers platform. The whole app runs inside one Durable Object:
 * its built-in SQLite database holds the data and the attachments, and its alarm
 * checks the mailboxes for new email. The web app is served as static assets.
 */
import { DurableObject } from 'cloudflare:workers'
import crypto from 'node:crypto'
import { config } from '../server/config.ts'
import { initDb, get } from '../server/db.ts'
import { initBlobs } from '../server/blobs.ts'
import { createApp, pauseTimers, prepareData, startTimers } from '../server/app.ts'
import { pruneSessions } from '../server/auth.ts'
import { pollAllMailboxes } from '../server/mail/imap.ts'
import { dispatchScheduled, nextScheduledAt, wakeSnoozed } from '../server/services/conversations.ts'
import { importIsRunning, importStep } from '../server/services/import-helpscout.ts'
import { findSnapshot, pruneSnapshots, restoreDatabase, restoreFilesStep, snapshot, uploadFiles } from './backup.ts'
import { Spaces, type SpacesEnv } from './spaces.ts'

interface Env extends SpacesEnv {
  /** Restore from a backup in Spaces: "latest", or the start of a snapshot's name such as "20261114". Done once per value. */
  RESTORE_FROM?: string
  /** The hour (UTC) after which the nightly database snapshot is taken. Default 7, about 2 or 3 am in New York. */
  BACKUP_HOUR_UTC?: string
  ANSA: DurableObjectNamespace
  /** Which upload of the code is running. The Worker and the Durable Object can briefly differ after a deploy. */
  CF_VERSION_METADATA?: { id: string; timestamp: string }
}

/** When the running code was uploaded, as a number. 0 when unknown (local development). */
const codeStamp = (env: Env) => Date.parse(env.CF_VERSION_METADATA?.timestamp || '') || 0
const CODE_HEADER = 'x-ansa-code'

const CHUNK = 1024 * 1024
const HOUR = 3_600_000

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** What everyone sees while a backup is restored. */
function restoringResponse(request: Request, error?: string) {
  const message = error ? `The restore stopped: ${error} It tries again every few minutes. Fix the setting, or remove RESTORE_FROM to cancel.` : 'Restoring from a backup. This page reloads when it is done.'
  const headers = { 'retry-after': '5', 'cache-control': 'no-store' }
  if (new URL(request.url).pathname.startsWith('/api/')) return Response.json({ error: message }, { status: 503, headers })
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Restoring</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 16px;color:#222"><p>${escapeHtml(message)}</p></body>`
  return new Response(html, { status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
}
const toBuffer = (value: unknown) => (value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value)

export class AnsaStore extends DurableObject<Env> {
  private app: ReturnType<typeof createApp>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const { sql, kv } = ctx.storage

    initDb({
      all: (query, params) => sql.exec(query, ...params.map(toBuffer)).toArray(),
      run: (query, params) => {
        sql.exec(query, ...params.map(toBuffer)).toArray()
        const row = sql.exec('SELECT last_insert_rowid() AS id, changes() AS changes').one()
        return { id: Number(row.id), changes: Number(row.changes) }
      },
      exec: (query) => void sql.exec(query).toArray(),
      transaction: (fn) => ctx.storage.transactionSync(fn),
    })

    sql.exec('CREATE TABLE IF NOT EXISTS _blobs (key TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, seq)) WITHOUT ROWID')
    initBlobs({
      put: (key, data) =>
        ctx.storage.transactionSync(() => {
          sql.exec('DELETE FROM _blobs WHERE key = ?', key)
          for (let seq = 0, at = 0; at < data.byteLength || seq === 0; seq++, at += CHUNK) {
            sql.exec('INSERT INTO _blobs (key, seq, data) VALUES (?, ?, ?)', key, seq, toBuffer(data.subarray(at, at + CHUNK)))
          }
        }),
      get: (key) => {
        const parts = sql.exec('SELECT data FROM _blobs WHERE key = ? ORDER BY seq', key).toArray().map((row) => new Uint8Array(row.data as ArrayBuffer))
        if (parts.length === 0) return null
        const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
        let at = 0
        for (const part of parts) {
          out.set(part, at)
          at += part.byteLength
        }
        return out
      },
      remove: (key) => void sql.exec('DELETE FROM _blobs WHERE key = ?', key),
    })

    if (!config.secret) {
      let secret = kv.get<string>('secret')
      if (!secret) {
        secret = crypto.randomBytes(32).toString('hex')
        kv.put('secret', secret)
      }
      config.secret = secret
    }
    if (!config.appUrlFixed) config.appUrl = kv.get<string>('appUrl') ?? config.appUrl
    config.imapPollOnly = true

    prepareData()
    startTimers()
    this.app = createApp()
  }

  /** Without APP_URL, links in emails use the address people actually sign in on. */
  private learnUrl(request: Request) {
    if (config.appUrlFixed) return
    const url = new URL(request.url)
    const known = this.ctx.storage.kv.get<string>('appUrl')
    if (known && !(request.method === 'POST' && url.pathname === '/api/login')) return
    if (known !== url.origin) this.ctx.storage.kv.put('appUrl', url.origin)
    config.appUrl = url.origin
  }

  async fetch(request: Request): Promise<Response> {
    // After a deploy, Cloudflare replaces this object only once no request is in flight. An open
    // browser tab holds a live-update stream, so the old code could stay for hours. When the Worker
    // in front says it runs newer code, restart now. Only on a read, which the Worker can repeat.
    const mine = codeStamp(this.env)
    const theirs = Number(request.headers.get(CODE_HEADER) || 0)
    if (mine && theirs > mine && (request.method === 'GET' || request.method === 'HEAD')) this.ctx.abort('A newer version was deployed.')

    if (this.restorePending()) {
      pauseTimers(true)
      const alarm = await this.ctx.storage.getAlarm()
      if (alarm === null) await this.ctx.storage.setAlarm(Date.now())
      const out = restoringResponse(request, this.ctx.storage.kv.get<string>('restoreError'))
      out.headers.set(CODE_HEADER, String(mine))
      return out
    }

    this.learnUrl(request)
    const response = await this.app.fetch(request)
    await this.scheduleAlarm()
    await this.watchdog()
    const out = new Response(response.body, response)
    out.headers.set(CODE_HEADER, String(mine))
    return out
  }

  private pollEveryMs = () => Math.max(10, config.imapPollSeconds) * 1000
  /** When mail was last checked. Kept in storage so a restart does not hide a long gap. */
  private lastPoll = () => this.ctx.storage.kv.get<number>('lastPollAt') ?? 0
  private polling: Promise<void> | null = null

  private hasMailToCheck = () => !config.mailDisabled && !!get(`SELECT 1 FROM mailboxes WHERE imap_enabled = 1 AND imap_host != '' LIMIT 1`)

  /** Check every mailbox once. Only one check runs at a time. */
  private checkMail(): Promise<void> {
    if (!this.polling) {
      this.ctx.storage.kv.put('lastPollAt', Date.now())
      this.polling = (async () => {
        wakeSnoozed()
        pruneSessions()
        await pollAllMailboxes()
      })().finally(() => {
        this.polling = null
      })
    }
    return this.polling
  }

  /**
   * The alarm can stop firing (a check that never returned held it up). When a visitor arrives and mail has not been
   * checked for three intervals, check now and set a fresh alarm, so mail never waits for someone to notice.
   */
  private async watchdog() {
    if (this.polling || importIsRunning() || !this.hasMailToCheck()) return
    if (Date.now() - this.lastPoll() < 3 * this.pollEveryMs()) return
    console.error('[watchdog] mail was not checked on schedule; checking now and resetting the alarm')
    this.ctx.waitUntil(this.checkMail().catch((err) => console.error('[watchdog]', err)))
    await this.ctx.storage.setAlarm(Date.now() + this.pollEveryMs())
  }

  /** The alarm is the only thing that wakes this object without a visitor, so keep one set while there is work. */
  private async scheduleAlarm() {
    // An import runs as a chain of short alarms: each one may only make a few dozen requests.
    if (importIsRunning()) {
      const current = await this.ctx.storage.getAlarm()
      if (current === null || current > Date.now() + 3000) await this.ctx.storage.setAlarm(Date.now() + 1000)
      return
    }
    // Attachments come back from a backup in short steps, like an import.
    if (this.ctx.storage.kv.get('fileRestore') !== undefined) {
      const current = await this.ctx.storage.getAlarm()
      if (current === null || current > Date.now() + 3000) await this.ctx.storage.setAlarm(Date.now() + 1000)
      return
    }
    // A scheduled reply goes out on time, not at the next mail check.
    const due = nextScheduledAt()
    if (due !== null) {
      const at = Math.max(Date.now() + 1000, due)
      const current = await this.ctx.storage.getAlarm()
      if (current === null || current > at) await this.ctx.storage.setAlarm(at)
    }
    const snoozed = get('SELECT 1 FROM conversations WHERE snoozed_until IS NOT NULL LIMIT 1')
    if (!this.hasMailToCheck() && !snoozed) return
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.pollEveryMs())
  }

  /** The RESTORE_FROM value still to restore, or null. */
  private restorePending(): string | null {
    const from = this.env.RESTORE_FROM?.trim()
    return from && this.ctx.storage.kv.get<string>('restoredFrom') !== from ? from : null
  }

  /**
   * Replace everything with a backup. A database that has users is first saved to Spaces as "-before-restore",
   * so a restore can itself be undone. When it is done the object restarts to load the restored data.
   */
  private async restore(from: string) {
    pauseTimers(true)
    const { kv } = this.ctx.storage
    const spaces = Spaces.from(this.env)
    try {
      if (!spaces) throw new Error('Backups are not set up. Add the SPACES_KEY, SPACES_SECRET, SPACES_BUCKET and SPACES_REGION secrets.')
      let state = kv.get<{ from: string; key: string; saved: boolean }>('restore')
      if (!state || state.from !== from) {
        state = { from, key: await findSnapshot(spaces, from), saved: false }
        kv.put('restore', state)
      }
      if (!state.saved) {
        let hasUsers = false
        try {
          hasUsers = !!get('SELECT 1 FROM users LIMIT 1')
        } catch {
          // No users table: nothing to keep.
        }
        if (hasUsers) {
          const before = await snapshot(this.ctx.storage, spaces, 'before-restore')
          console.log(`[restore] saved the current data first as ${before.key}`)
        }
        state = { ...state, saved: true }
        kv.put('restore', state)
      }
      console.log(`[restore] restoring ${state.key}`)
      const result = await restoreDatabase(this.ctx.storage, spaces, state.key)
      console.log(`[restore] ${result.rows} rows in ${result.tables} tables${result.skipped ? `, ${result.skipped} skipped` : ''}. Attachments follow.`)
      kv.put('restoredFrom', from)
      kv.put('fileRestore', '')
      kv.delete('restore')
      kv.delete('restoreError')
      await this.ctx.storage.setAlarm(Date.now() + 1000)
      await this.ctx.storage.sync()
    } catch (err) {
      const message = (err as Error).message
      console.error('[restore]', message)
      kv.put('restoreError', message)
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000)
      return
    }
    this.ctx.abort('Restored from a backup.')
  }

  private async restoreFiles() {
    const { kv } = this.ctx.storage
    const after = kv.get<string>('fileRestore')
    const spaces = Spaces.from(this.env)
    if (after === undefined) return
    if (!spaces) return void kv.delete('fileRestore')
    const step = await restoreFilesStep(this.ctx.storage, spaces, after, Date.now() + 20_000)
    if (step.after === null) {
      kv.delete('fileRestore')
      console.log('[restore] all attachments are back')
    } else kv.put('fileRestore', step.after)
  }

  private backingUp = false
  /**
   * Called every 15 minutes by the cron trigger: upload new attachments, and once a night take a database snapshot.
   * Does nothing until the SPACES_ secrets are set.
   */
  async backup(): Promise<string> {
    if (this.restorePending()) return 'A restore is in progress; no backup taken.'
    const spaces = Spaces.from(this.env)
    if (!spaces) return 'Backups are off: the SPACES_ secrets are not set.'
    if (this.backingUp) return 'A backup is already running.'
    this.backingUp = true
    const { kv } = this.ctx.storage
    const done: string[] = []
    try {
      const last = kv.get<number>('lastSnapshotAt') ?? 0
      const hour = Number(this.env.BACKUP_HOUR_UTC ?? 7)
      if (!last || (Date.now() - last > 20 * HOUR && new Date().getUTCHours() >= hour)) {
        const shot = await snapshot(this.ctx.storage, spaces)
        kv.put('lastSnapshotAt', Date.now())
        done.push(`Saved ${shot.key} (${shot.rows} rows, ${(shot.bytes / 1024 / 1024).toFixed(1)} MB).`)
        const removed = await pruneSnapshots(spaces)
        if (removed) done.push(`Removed ${removed} old snapshot${removed === 1 ? '' : 's'}.`)
      }
      const files = await uploadFiles(this.ctx.storage, spaces, Date.now() + 5 * 60_000)
      if (files.sent) done.push(`Uploaded ${files.sent} file${files.sent === 1 ? '' : 's'}.`)
      if (files.left) done.push(`${files.left} files still to upload.`)
      return done.join(' ') || 'Up to date.'
    } finally {
      this.backingUp = false
    }
  }

  async alarm() {
    const from = this.restorePending()
    if (from) return this.restore(from)
    try {
      await this.restoreFiles().catch((err) => console.error('[restore] attachments', err))
      // Each step on its own: one that fails must not stop the others, least of all the mail check.
      await importStep().catch((err) => console.error('[alarm] import', err))
      await dispatchScheduled().catch((err) => console.error('[alarm] send later', err))
      // Mail is checked on its own schedule, however often the alarm fires.
      if (Date.now() - this.lastPoll() >= this.pollEveryMs() - 500) await this.checkMail()
    } catch (err) {
      console.error('[alarm]', err)
    } finally {
      await this.scheduleAlarm()
    }
  }
}

/** True once this Worker instance has seen the Durable Object answer with code at least as new as its own. */
let objectIsCurrent = false

export default {
  /** Backups: see AnsaStore.backup. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      env.ANSA.get(env.ANSA.idFromName('main'))
        .backup()
        .then((result) => console.log(`[backup] ${result}`))
        .catch((err) => console.error('[backup] failed:', err)),
    )
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const mine = codeStamp(env)
    const object = () => env.ANSA.get(env.ANSA.idFromName('main'))
    const forward = () => {
      const headers = new Headers(request.headers)
      headers.set(CODE_HEADER, String(mine))
      return object().fetch(new Request(request, { headers }))
    }
    const isCurrent = (response: Response | null) => !mine || Number(response?.headers.get(CODE_HEADER) || 0) >= mine

    // Do not open a long-lived stream to an object that still runs old code: the stream is what keeps it old.
    // The browser retries the stream every few seconds, and by then the object has restarted.
    if (!objectIsCurrent && mine && new URL(request.url).pathname === '/api/events') {
      const probe = await object()
        .fetch(new Request(new URL('/healthz', request.url), { headers: { [CODE_HEADER]: String(mine) } }))
        .catch(() => null)
      if (isCurrent(probe)) objectIsCurrent = true
      else return new Response('Updating. Try again in a moment.', { status: 503, headers: { 'Retry-After': '3' } })
    }

    const safe = request.method === 'GET' || request.method === 'HEAD'
    try {
      const response = await forward()
      if (isCurrent(response)) objectIsCurrent = true
      return response
    } catch (err) {
      // The object restarted to load new code. A read can be repeated at once.
      if (!safe) throw err
      return forward()
    }
  },
}
