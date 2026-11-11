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
import { createApp, prepareData, startTimers } from '../server/app.ts'
import { pruneSessions } from '../server/auth.ts'
import { pollAllMailboxes } from '../server/mail/imap.ts'
import { wakeSnoozed } from '../server/services/conversations.ts'

interface Env {
  ANSA: DurableObjectNamespace
  /** Which upload of the code is running. The Worker and the Durable Object can briefly differ after a deploy. */
  CF_VERSION_METADATA?: { id: string; timestamp: string }
}

/** When the running code was uploaded, as a number. 0 when unknown (local development). */
const codeStamp = (env: Env) => Date.parse(env.CF_VERSION_METADATA?.timestamp || '') || 0
const CODE_HEADER = 'x-ansa-code'

const CHUNK = 1024 * 1024
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

    this.learnUrl(request)
    const response = await this.app.fetch(request)
    await this.scheduleAlarm()
    const out = new Response(response.body, response)
    out.headers.set(CODE_HEADER, String(mine))
    return out
  }

  /** The alarm is the only thing that wakes this object without a visitor, so keep one set while there is work. */
  private async scheduleAlarm() {
    const polling = !config.mailDisabled && get(`SELECT 1 FROM mailboxes WHERE imap_enabled = 1 AND imap_host != '' LIMIT 1`)
    const snoozed = get('SELECT 1 FROM conversations WHERE snoozed_until IS NOT NULL LIMIT 1')
    if (!polling && !snoozed) return
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + Math.max(10, config.imapPollSeconds) * 1000)
  }

  async alarm() {
    try {
      wakeSnoozed()
      pruneSessions()
      await pollAllMailboxes()
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
