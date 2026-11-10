import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { get, run, now } from '../db.ts'
import { config } from '../config.ts'

export interface StoredAttachment {
  id: number
  filename: string
  mime: string
  size: number
  url: string
}

const safeName = (name: string) => (name || 'attachment').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) || 'attachment'

export function storeAttachment(
  data: Uint8Array,
  meta: { filename: string; mime?: string; threadId?: number | null; contentId?: string | null; inline?: boolean; uploadedBy?: number | null },
): StoredAttachment {
  const date = new Date()
  const dir = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  fs.mkdirSync(path.join(config.attachmentsDir, dir), { recursive: true })
  const key = `${dir}/${crypto.randomBytes(16).toString('hex')}`
  fs.writeFileSync(path.join(config.attachmentsDir, key), data)
  const filename = safeName(meta.filename)
  const mime = meta.mime || 'application/octet-stream'
  const { id } = run(
    'INSERT INTO attachments (thread_id, filename, mime, size, storage_key, content_id, inline, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    meta.threadId ?? null,
    filename,
    mime,
    data.byteLength,
    key,
    meta.contentId ?? null,
    !!meta.inline,
    meta.uploadedBy ?? null,
    now(),
  )
  return { id, filename, mime, size: data.byteLength, url: `/api/attachments/${id}/${encodeURIComponent(filename)}` }
}

export function attachmentFile(id: number): { path: string; filename: string; mime: string; size: number } | null {
  const row = get<any>('SELECT * FROM attachments WHERE id = ?', id)
  if (!row) return null
  const file = path.join(config.attachmentsDir, row.storage_key)
  if (!file.startsWith(config.attachmentsDir) || !fs.existsSync(file)) return null
  return { path: file, filename: row.filename, mime: row.mime, size: row.size }
}

export function removeFiles(keys: string[]) {
  for (const key of keys) fs.rm(path.join(config.attachmentsDir, key), { force: true }, () => {})
}
