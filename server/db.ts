import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { config } from './config.ts'

export const db = new DatabaseSync(config.dbPath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')

type Param = string | number | bigint | null | undefined | boolean | Uint8Array
const cache = new Map<string, StatementSync>()

function stmt(sql: string): StatementSync {
  let s = cache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    cache.set(sql, s)
  }
  return s
}

const norm = (params: Param[]) =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as (string | number | bigint | null | Uint8Array)[]

export function all<T = any>(sql: string, ...params: Param[]): T[] {
  return stmt(sql).all(...norm(params)) as T[]
}
export function get<T = any>(sql: string, ...params: Param[]): T | undefined {
  return stmt(sql).get(...norm(params)) as T | undefined
}
export function run(sql: string, ...params: Param[]) {
  const r = stmt(sql).run(...norm(params))
  return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }
}

let depth = 0
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  depth++
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  } finally {
    depth--
  }
}

export const now = () => Date.now()

const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    color TEXT NOT NULL DEFAULT '#6366f1',
    signature TEXT NOT NULL DEFAULT '',
    notify_assigned INTEGER NOT NULL DEFAULT 1,
    notify_replies INTEGER NOT NULL DEFAULT 1,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE mailboxes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    from_name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#6366f1',
    signature TEXT NOT NULL DEFAULT '',
    smtp_host TEXT NOT NULL DEFAULT '',
    smtp_port INTEGER NOT NULL DEFAULT 587,
    smtp_security TEXT NOT NULL DEFAULT 'starttls',
    smtp_user TEXT NOT NULL DEFAULT '',
    smtp_pass_enc TEXT NOT NULL DEFAULT '',
    imap_enabled INTEGER NOT NULL DEFAULT 0,
    imap_host TEXT NOT NULL DEFAULT '',
    imap_port INTEGER NOT NULL DEFAULT 993,
    imap_security TEXT NOT NULL DEFAULT 'ssl',
    imap_user TEXT NOT NULL DEFAULT '',
    imap_pass_enc TEXT NOT NULL DEFAULT '',
    imap_folder TEXT NOT NULL DEFAULT 'INBOX',
    imap_uidvalidity TEXT,
    imap_last_uid INTEGER,
    import_existing INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'idle',
    sync_error TEXT,
    last_sync_at INTEGER,
    auto_reply_enabled INTEGER NOT NULL DEFAULT 0,
    auto_reply_subject TEXT NOT NULL DEFAULT '',
    auto_reply_body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL COLLATE NOCASE,
    company TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE customer_emails (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE INDEX customer_emails_customer ON customer_emails(customer_id);
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    preview TEXT NOT NULL DEFAULT '',
    cc TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'email',
    thread_count INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_customer_at INTEGER,
    last_agent_at INTEGER,
    first_reply_at INTEGER,
    waiting_since INTEGER,
    closed_at INTEGER,
    closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX conversations_folder ON conversations(mailbox_id, status, assignee_id, updated_at);
  CREATE INDEX conversations_customer ON conversations(customer_id, updated_at);
  CREATE INDEX conversations_created ON conversations(created_at);
  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    body_html TEXT NOT NULL DEFAULT '',
    body_full_html TEXT,
    body_text TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addrs TEXT NOT NULL DEFAULT '[]',
    cc TEXT NOT NULL DEFAULT '[]',
    bcc TEXT NOT NULL DEFAULT '[]',
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT,
    state TEXT NOT NULL DEFAULT 'sent',
    error TEXT,
    event TEXT,
    via TEXT NOT NULL DEFAULT 'web',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX threads_conversation ON threads(conversation_id, created_at);
  CREATE INDEX threads_message_id ON threads(message_id);
  CREATE INDEX threads_created ON threads(type, created_at);
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL,
    content_id TEXT,
    inline INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_thread ON attachments(thread_id);
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#64748b',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE conversation_tags (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, tag_id)
  );
  CREATE INDEX conversation_tags_tag ON conversation_tags(tag_id);
  CREATE TABLE saved_replies (
    id INTEGER PRIMARY KEY,
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    body_html TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE workflows (
    id INTEGER PRIMARY KEY,
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger TEXT NOT NULL DEFAULT 'new',
    match TEXT NOT NULL DEFAULT 'all',
    conditions TEXT NOT NULL DEFAULT '[]',
    actions TEXT NOT NULL DEFAULT '[]',
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE drafts (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'reply',
    body_html TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE search USING fts5(subject, body, customer, tokenize = 'porter unicode61 remove_diacritics 2');
  `,
]

export function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = (get<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM _migrations')?.n ?? 0)
  for (let i = applied; i < migrations.length; i++) {
    tx(() => {
      db.exec(migrations[i])
      run('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', i + 1, now())
    })
    console.log(`[db] applied migration ${i + 1}`)
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}
export function setSetting(key: string, value: unknown) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
}

export const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
