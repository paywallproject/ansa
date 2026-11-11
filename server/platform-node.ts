/**
 * Node.js platform: SQLite file, attachments on disk, secret key file.
 * Import this module first, before anything that touches the database.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { config } from './config.ts'
import { initDb, type SqlValue } from './db.ts'
import { initBlobs } from './blobs.ts'

fs.mkdirSync(config.attachmentsDir, { recursive: true })

if (!config.secret) {
  const file = path.join(config.dataDir, 'secret.key')
  if (fs.existsSync(file)) config.secret = fs.readFileSync(file, 'utf8').trim()
  else {
    config.secret = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(file, config.secret, { mode: 0o600 })
  }
}

const db = new DatabaseSync(config.dbPath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')

const cache = new Map<string, StatementSync>()
function stmt(sql: string): StatementSync {
  let s = cache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    cache.set(sql, s)
  }
  return s
}
type Bind = Exclude<SqlValue, never>[]

initDb({
  all: (sql, params) => stmt(sql).all(...(params as Bind)) as any[],
  run: (sql, params) => {
    const r = stmt(sql).run(...(params as Bind))
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }
  },
  exec: (sql) => db.exec(sql),
  transaction: (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
})

const fileOf = (key: string) => {
  const file = path.join(config.attachmentsDir, key)
  return file.startsWith(config.attachmentsDir) ? file : null
}
initBlobs({
  put: (key, data) => {
    const file = fileOf(key)
    if (!file) throw new Error('Bad file key.')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  },
  get: (key) => {
    const file = fileOf(key)
    return file && fs.existsSync(file) ? fs.readFileSync(file) : null
  },
  remove: (key) => {
    const file = fileOf(key)
    if (file) fs.rm(file, { force: true }, () => {})
  },
})
