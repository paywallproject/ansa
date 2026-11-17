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
  return { id, filename, mime, size: data.byteLength, url: attachmentUrl(id, filename) }
}

export function attachmentFile(id: number): { data: Uint8Array; filename: string; mime: string; size: number } | null {
  const row = get<any>('SELECT * FROM attachments WHERE id = ?', id)
  if (!row) return null
  const data = blobs.get(row.storage_key)
  if (!data) return null
  return { data, filename: row.filename, mime: row.mime, size: data.byteLength }
}

/** A file's link inside Ansa. A message body points at its images this way. */
export const attachmentUrl = (id: number, filename: string) => `/api/attachments/${id}/${encodeURIComponent(filename)}`

// An <img> whose src is one of our files, written relative or with the full app address.
const INLINE_IMG = /<img\b[^>]*?\ssrc\s*=\s*["'](?:https?:\/\/[^"'/]+)?\/api\/attachments\/(\d+)(?:[/?#][^"']*)?["'][^>]*>/gi

/** The ids of the files a body shows as images, in order, once each. */
export function inlineAttachmentIds(html: string): number[] {
  const ids = new Set<number>()
  for (const match of html.matchAll(INLINE_IMG)) ids.add(Number(match[1]))
  return [...ids]
}

/**
 * Prepare a sent message's body for email: an image of one of its own files becomes a cid: link to a part
 * of the message. Other images of ours need a login, so they cannot travel and are dropped.
 */
export function embedInlineImages(html: string, files: { id: number; cid: string }[]): string {
  const cids = new Map(files.map((f) => [f.id, f.cid]))
  return html.replace(INLINE_IMG, (tag, id: string) => {
    const cid = cids.get(Number(id))
    return cid ? tag.replace(/\ssrc\s*=\s*["'][^"']*["']/i, ` src="cid:${cid}"`) : ''
  })
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', html: 'text/html', json: 'application/json',
  xml: 'application/xml', zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
}
/** A file's type from its name, for uploads that do not say. */
export const mimeFromName = (filename: string) => MIME_BY_EXT[/\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** A copy of a stored file as a new, unsent upload: for putting a file from one message on another. */
export function copyAttachment(id: number, uploadedBy: number): StoredAttachment | null {
  const file = attachmentFile(id)
  return file ? storeAttachment(file.data, { filename: file.filename, mime: file.mime, uploadedBy }) : null
}

export function removeFiles(keys: string[]) {
  for (const key of keys) blobs.remove(key)
}
