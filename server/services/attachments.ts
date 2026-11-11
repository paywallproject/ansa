import crypto from 'node:crypto'
import { get, run, now } from '../db.ts'
import { blobs } from '../blobs.ts'

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
  const key = `${dir}/${crypto.randomBytes(16).toString('hex')}`
  blobs.put(key, data)
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

export function attachmentFile(id: number): { data: Uint8Array; filename: string; mime: string; size: number } | null {
  const row = get<any>('SELECT * FROM attachments WHERE id = ?', id)
  if (!row) return null
  const data = blobs.get(row.storage_key)
  if (!data) return null
  return { data, filename: row.filename, mime: row.mime, size: data.byteLength }
}

export function removeFiles(keys: string[]) {
  for (const key of keys) blobs.remove(key)
}
