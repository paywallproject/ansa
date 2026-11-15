/**
 * Backups to DigitalOcean Spaces, and restoring from them, on Cloudflare.
 *
 * Two kinds of object, under the backup folder:
 *   db/<time>.ndjson.gz   a snapshot of the database without attachment bytes, taken nightly
 *   attachments/<key>     each attachment, avatar, logo and original email, uploaded once soon after it arrives
 *
 * A snapshot is gzipped JSON lines: a header (with the key that decrypts saved mail passwords), then for each
 * table its CREATE statement and its rows, then the indexes and triggers, then an end line with the row count.
 * Sign-in sessions are left out, so after a restore everyone signs in again.
 */
import { Buffer } from 'node:buffer'
import { blobs } from '../server/blobs.ts'
import type { Spaces } from './spaces.ts'

type Storage = DurableObjectState['storage']
type Sql = Storage['sql']

const FORMAT = 1
/** Tables that are not part of a snapshot. Attachment bytes go up one by one instead. */
const SKIP = new Set(['_blobs', '_backup_blobs'])
/** Tables saved without their rows. */
const NO_ROWS = new Set(['sessions'])
/** Durable Object storage values that belong to the install, not to one run of it. */
const KV_KEYS = ['secret', 'appUrl']

const SNAPSHOTS = 'db/'
const FILES = 'attachments/'

interface SchemaObject {
  type: string
  name: string
  sql: string
}

/** The install's own tables, views, indexes and triggers, oldest first. Full-text index internals are left out. */
function schema(sql: Sql): SchemaObject[] {
  const rows = sql
    .exec(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY rowid`)
    .toArray() as unknown as SchemaObject[]
  const virtual = rows.filter((r) => r.type === 'table' && /^CREATE\s+VIRTUAL/i.test(r.sql)).map((r) => r.name)
  return rows.filter((r) => !SKIP.has(r.name) && !virtual.some((v) => r.name.startsWith(`${v}_`)))
}

/** True when the table's rowid is not one of its columns, so a snapshot must carry it to keep row ids. */
function needsRowid(sql: Sql, table: SchemaObject) {
  if (/WITHOUT\s+ROWID/i.test(table.sql)) return false
  if (/^CREATE\s+VIRTUAL/i.test(table.sql)) return true
  const pk = sql.exec(`SELECT type FROM pragma_table_info(?) WHERE pk > 0`, table.name).toArray()
  return !(pk.length === 1 && String(pk[0].type).toUpperCase() === 'INTEGER')
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`
const encodeValue = (v: unknown) => (v instanceof ArrayBuffer ? { $b: Buffer.from(v).toString('base64') } : v)
const decodeValue = (v: unknown) => (v && typeof v === 'object' && '$b' in v ? new Uint8Array(Buffer.from((v as { $b: string }).$b, 'base64')).buffer : v)

export const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/**
 * Write a snapshot of the database to Spaces. Returns its key and size. Reads go in pages with uploads in
 * between, so rows written during the few seconds it takes may or may not be in it.
 */
export async function snapshot(storage: Storage, spaces: Spaces, note = ''): Promise<{ key: string; bytes: number; rows: number }> {
  const { sql, kv } = storage
  const key = `${SNAPSHOTS}${stamp()}${note ? `-${note}` : ''}.ndjson.gz`
  const gzip = new CompressionStream('gzip')
  const writer = gzip.writable.getWriter()
  const uploaded = spaces.upload(key, gzip.readable, 'application/gzip')
  // If the upload fails, stop writing instead of waiting forever on a stream nobody reads.
  uploaded.catch((err) => writer.abort(err).catch(() => {}))

  const encoder = new TextEncoder()
  let buffer = ''
  const line = async (value: unknown) => {
    buffer += JSON.stringify(value) + '\n'
    if (buffer.length >= 512 * 1024) {
      await writer.write(encoder.encode(buffer))
      buffer = ''
    }
  }

  let rows = 0
  try {
    const kvValues = Object.fromEntries(KV_KEYS.map((k) => [k, kv.get(k)]).filter(([, v]) => v !== undefined))
    await line({ ansa: 'backup', format: FORMAT, createdAt: new Date().toISOString(), kv: kvValues })
    const objects = schema(sql)
    for (const table of objects.filter((o) => o.type === 'table')) {
      const withRowid = needsRowid(sql, table)
      const columns = sql.exec(`SELECT name FROM pragma_table_info(?)`, table.name).toArray().map((r) => String(r.name))
      const all = withRowid ? ['rowid', ...columns] : columns
      await line({ table: table.name, sql: table.sql, columns: all })
      if (NO_ROWS.has(table.name)) continue
      const list = all.map(q).join(', ')
      if (/WITHOUT\s+ROWID/i.test(table.sql)) {
        // These tables are small lookups; read them in one go.
        for (const row of sql.exec(`SELECT ${list} FROM ${q(table.name)}`).raw()) {
          await line(row.map(encodeValue))
          rows++
        }
        continue
      }
      for (let after = Number.MIN_SAFE_INTEGER; ; ) {
        const page = [...sql.exec(`SELECT rowid, ${list} FROM ${q(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT 500`, after).raw()]
        if (page.length === 0) break
        for (const row of page) {
          await line(row.slice(1).map(encodeValue))
          rows++
        }
        after = Number(page[page.length - 1][0])
      }
    }
    for (const other of objects.filter((o) => o.type !== 'table')) await line({ [other.type]: other.name, sql: other.sql })
    await line({ end: true, rows })
    if (buffer) await writer.write(encoder.encode(buffer))
    await writer.close()
  } catch (err) {
    await writer.abort(err).catch(() => {})
    await uploaded.catch(() => {})
    throw err
  }
  const bytes = await uploaded
  return { key, bytes, rows }
}

/**
 * Keep every snapshot from the last 30 days, then the first of each month for a year, and always the newest three.
 */
export async function pruneSnapshots(spaces: Spaces, now = Date.now()) {
  const keys = (await spaces.listAll(SNAPSHOTS)).map((k) => k.key).sort()
  const keep = new Set(keys.slice(-3))
  const firstOfMonth = new Map<string, string>()
  for (const key of keys) {
    const month = key.slice(SNAPSHOTS.length, SNAPSHOTS.length + 6)
    if (!firstOfMonth.has(month)) firstOfMonth.set(month, key)
  }
  const day = 86_400_000
  let removed = 0
  for (const key of keys) {
    const at = parseStamp(key)
    if (keep.has(key) || at === null) continue
    const age = now - at
    if (age <= 30 * day) continue
    if (firstOfMonth.get(key.slice(SNAPSHOTS.length, SNAPSHOTS.length + 6)) === key && age <= 366 * day) continue
    await spaces.remove(key)
    removed++
  }
  return removed
}

function parseStamp(key: string): number | null {
  const m = key.slice(SNAPSHOTS.length).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}

/** The snapshot `from` names: "latest", a full key, or the start of one such as "20261114". */
export async function findSnapshot(spaces: Spaces, from: string): Promise<string> {
  const wanted = from.trim().replace(/^.*?db\//, '')
  const keys = (await spaces.listAll(SNAPSHOTS)).map((k) => k.key).sort()
  const match =
    wanted.toLowerCase() === 'latest'
      ? keys.filter((k) => !k.includes('-before-restore')).at(-1)
      : keys.filter((k) => k.slice(SNAPSHOTS.length).startsWith(wanted)).at(wanted.length >= 15 ? 0 : -1)
  if (!match) throw new Error(`No backup matches RESTORE_FROM="${from}" in ${spaces.where}${SNAPSHOTS}. ${keys.length ? `The newest is ${keys.at(-1)}.` : 'There are no backups there.'}`)
  return match
}

export function ensureBlobLog(sql: Sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS _backup_blobs (key TEXT PRIMARY KEY) WITHOUT ROWID')
}

/** Upload attachments that are not in Spaces yet, until `deadline`. Returns how many went up and how many are left. */
export async function uploadFiles(storage: Storage, spaces: Spaces, deadline: number): Promise<{ sent: number; left: number }> {
  const { sql } = storage
  ensureBlobLog(sql)
  const pending = () => sql.exec('SELECT key FROM _blobs WHERE seq = 0 AND key NOT IN (SELECT key FROM _backup_blobs) ORDER BY key LIMIT 48').toArray().map((r) => String(r.key))
  let sent = 0
  for (let keys = pending(); keys.length && Date.now() < deadline; keys = pending()) {
    await pool(keys, 6, async (key) => {
      const data = blobs.get(key)
      // Removed since it was listed: nothing to keep.
      if (data) await spaces.put(FILES + key, data)
      sql.exec('INSERT OR IGNORE INTO _backup_blobs (key) VALUES (?)', key)
      if (data) sent++
    })
  }
  const left = Number(sql.exec('SELECT COUNT(*) AS n FROM _blobs WHERE seq = 0 AND key NOT IN (SELECT key FROM _backup_blobs)').one().n)
  return { sent, left }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++])
    }),
  )
}

/** Read a gzipped JSON-lines object one line at a time. */
async function* lines(body: ReadableStream<Uint8Array>) {
  const reader = (body as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader()
  let rest = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) {
      rest += value
      let at: number
      while ((at = rest.indexOf('\n')) >= 0) {
        const text = rest.slice(0, at)
        rest = rest.slice(at + 1)
        if (text) yield JSON.parse(text) as unknown
      }
    }
    if (done) break
  }
  if (rest.trim()) yield JSON.parse(rest) as unknown
}

/**
 * Replace the database with a snapshot. Attachment bytes already here are kept; the rest come back afterwards
 * with restoreFilesStep. Rows that no longer fit (a snapshot taken while someone was writing) are skipped and counted.
 */
export async function restoreDatabase(storage: Storage, spaces: Spaces, key: string) {
  const { sql, kv } = storage
  const res = await spaces.get(key)
  if (!res?.body) throw new Error(`The backup ${key} is not in ${spaces.where}.`)

  try {
    sql.exec('PRAGMA foreign_keys = OFF')
  } catch {
    // Not allowed here: tables go in creation order, which is parents first.
  }

  let header: { kv?: Record<string, unknown> } | null = null
  let insert: { sql: string } | null = null
  let batch: unknown[][] = []
  let rows = 0
  let skipped = 0
  let tables = 0
  let ended = false
  const flush = () => {
    if (!insert || batch.length === 0) return
    const statement = insert.sql
    const pending = batch
    batch = []
    storage.transactionSync(() => {
      for (const row of pending) {
        try {
          sql.exec(statement, ...row.map(decodeValue))
          rows++
        } catch (err) {
          if (skipped++ < 5) console.error(`[restore] skipped a row: ${(err as Error).message}`)
        }
      }
    })
  }

  for await (const item of lines(res.body)) {
    if (!header) {
      const h = item as { ansa?: string; format?: number; kv?: Record<string, unknown> }
      if (h.ansa !== 'backup' || h.format !== FORMAT) throw new Error(`${key} is not an Ansa backup this version can read.`)
      header = h
      // Clear the way, newest tables first so nothing still points at a table being dropped.
      for (const object of schema(sql).reverse()) {
        if (object.type === 'table') sql.exec(`DROP TABLE IF EXISTS ${q(object.name)}`)
        else if (object.type === 'view') sql.exec(`DROP VIEW IF EXISTS ${q(object.name)}`)
      }
      continue
    }
    if (Array.isArray(item)) {
      if (!insert) throw new Error('The backup has a row before its table.')
      batch.push(item)
      if (batch.length >= 200) flush()
      continue
    }
    flush()
    const line = item as { table?: string; index?: string; trigger?: string; view?: string; sql?: string; columns?: string[]; end?: boolean; rows?: number }
    if (line.end) {
      ended = true
      break
    }
    if (line.table && line.sql && line.columns) {
      sql.exec(line.sql)
      insert = { sql: `INSERT INTO ${q(line.table)} (${line.columns.map(q).join(', ')}) VALUES (${line.columns.map(() => '?').join(', ')})` }
      tables++
    } else if (line.sql) {
      insert = null
      sql.exec(line.sql)
    }
  }
  flush()
  if (!ended) throw new Error(`The backup ${key} is cut short. Pick an earlier one.`)
  for (const [k, v] of Object.entries(header?.kv ?? {})) kv.put(k, v)
  // Files already uploaded stay uploaded: restored ones are marked as they come back.
  ensureBlobLog(sql)
  return { tables, rows, skipped }
}

/** Bring back attachment bytes after a database restore, until `deadline`. Returns where to carry on, or null when done. */
export async function restoreFilesStep(storage: Storage, spaces: Spaces, after: string, deadline: number): Promise<{ after: string | null; restored: number }> {
  const { sql } = storage
  ensureBlobLog(sql)
  let restored = 0
  for (;;) {
    const page = await spaces.list(FILES, after)
    for (let i = 0; i < page.keys.length; i += 12) {
      if (Date.now() >= deadline) return { after, restored }
      const chunk = page.keys.slice(i, i + 12)
      await pool(chunk, 6, async ({ key }) => {
        const local = key.slice(FILES.length)
        if (!local || sql.exec('SELECT 1 FROM _blobs WHERE key = ? AND seq = 0', local).toArray().length) return
        const res = await spaces.get(key)
        if (!res) return
        blobs.put(local, new Uint8Array(await res.arrayBuffer()))
        sql.exec('INSERT OR IGNORE INTO _backup_blobs (key) VALUES (?)', local)
        restored++
      })
      after = chunk[chunk.length - 1].key
    }
    if (!page.more || page.keys.length === 0) return { after: null, restored }
  }
}
