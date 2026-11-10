import { all, get, run, tx, now } from '../db.ts'

export class AppError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Length is checked first: the pattern is slow on very long strings and no real address exceeds 254. */
export const isEmail = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value.trim())
export const normEmail = (value: string) => value.trim().toLowerCase()

export interface Customer {
  id: number
  name: string
  email: string
  emails: string[]
  company: string
  title: string
  phone: string
  location: string
  notes: string
  createdAt: number
  updatedAt: number
  conversationCount?: number
  lastSeenAt?: number | null
}

export function serializeCustomer(row: any): Customer {
  const emails = all<{ email: string }>('SELECT email FROM customer_emails WHERE customer_id = ? ORDER BY email', row.id).map((e) => e.email)
  return {
    id: row.id,
    name: row.name || '',
    email: row.email,
    emails: emails.length ? [row.email, ...emails.filter((e) => e.toLowerCase() !== String(row.email).toLowerCase())] : [row.email],
    company: row.company,
    title: row.title,
    phone: row.phone,
    location: row.location,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conversationCount: row.conversation_count,
    lastSeenAt: row.last_seen_at,
  }
}

/** "jane.doe@acme.com" → "Jane Doe" when the sender gave no display name. */
function nameFromEmail(email: string): string {
  return email
    .split('@')[0]
    .replace(/\+.*$/, '')
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

export function findOrCreateCustomer(emailRaw: string, name?: string | null): { id: number; name: string; email: string } {
  if (!isEmail(emailRaw)) throw new AppError('A valid customer email address is required.')
  const email = normEmail(emailRaw)
  return tx(() => {
    const existing = get<{ id: number; name: string; email: string }>(
      'SELECT c.id, c.name, c.email FROM customer_emails e JOIN customers c ON c.id = e.customer_id WHERE e.email = ?',
      email,
    )
    if (existing) {
      const cleanName = name?.trim()
      if (cleanName && (!existing.name || existing.name === nameFromEmail(existing.email))) {
        run('UPDATE customers SET name = ?, updated_at = ? WHERE id = ?', cleanName, now(), existing.id)
        existing.name = cleanName
      }
      return existing
    }
    const finalName = name?.trim() || nameFromEmail(email)
    const ts = now()
    const { id } = run('INSERT INTO customers (name, email, created_at, updated_at) VALUES (?, ?, ?, ?)', finalName, email, ts, ts)
    run('INSERT INTO customer_emails (email, customer_id) VALUES (?, ?)', email, id)
    return { id, name: finalName, email }
  })
}

export function listCustomers(opts: { q?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const q = opts.q?.trim()
  const where = q ? `WHERE c.name LIKE ?1 OR c.email LIKE ?1 OR c.company LIKE ?1 OR c.id IN (SELECT customer_id FROM customer_emails WHERE email LIKE ?1)` : ''
  const params = q ? [`%${q.replace(/[%_]/g, '')}%`] : []
  const rows = all(
    `SELECT c.*, (SELECT COUNT(*) FROM conversations v WHERE v.customer_id = c.id) AS conversation_count,
            (SELECT MAX(last_customer_at) FROM conversations v WHERE v.customer_id = c.id) AS last_seen_at
     FROM customers c ${where} ORDER BY COALESCE(last_seen_at, c.created_at) DESC LIMIT ?2 OFFSET ?3`,
    ...(q ? params : [null]),
    limit,
    offset,
  )
  const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM customers c ${where}`, ...params)?.n ?? 0
  return { items: rows.map(serializeCustomer), total }
}

export function getCustomer(id: number): Customer {
  const row = get(
    `SELECT c.*, (SELECT COUNT(*) FROM conversations v WHERE v.customer_id = c.id) AS conversation_count,
            (SELECT MAX(last_customer_at) FROM conversations v WHERE v.customer_id = c.id) AS last_seen_at
     FROM customers c WHERE c.id = ?`,
    id,
  )
  if (!row) throw new AppError('Customer not found.', 404)
  return serializeCustomer(row)
}

export interface CustomerPatch {
  name?: string
  email?: string
  emails?: string[]
  company?: string
  title?: string
  phone?: string
  location?: string
  notes?: string
}

export function updateCustomer(id: number, patch: CustomerPatch): Customer {
  const current = getCustomer(id)
  tx(() => {
    const emails = patch.emails ?? (patch.email ? [patch.email, ...current.emails.slice(1)] : undefined)
    if (emails) {
      const clean = [...new Set(emails.map((e) => String(e)).filter(isEmail).map(normEmail))]
      if (clean.length === 0) throw new AppError('A customer needs at least one valid email address.')
      for (const email of clean) {
        const owner = get<{ customer_id: number }>('SELECT customer_id FROM customer_emails WHERE email = ?', email)
        if (owner && owner.customer_id !== id) throw new AppError(`${email} already belongs to another customer.`, 409)
      }
      run('DELETE FROM customer_emails WHERE customer_id = ?', id)
      for (const email of clean) run('INSERT INTO customer_emails (email, customer_id) VALUES (?, ?)', email, id)
      run('UPDATE customers SET email = ? WHERE id = ?', clean[0], id)
    }
    const fields: [keyof CustomerPatch, string][] = [
      ['name', 'name'],
      ['company', 'company'],
      ['title', 'title'],
      ['phone', 'phone'],
      ['location', 'location'],
      ['notes', 'notes'],
    ]
    for (const [key, column] of fields) {
      if (typeof patch[key] === 'string') run(`UPDATE customers SET ${column} = ? WHERE id = ?`, (patch[key] as string).trim().slice(0, 5000), id)
    }
    run('UPDATE customers SET updated_at = ? WHERE id = ?', now(), id)
  })
  return getCustomer(id)
}

export function createCustomer(input: CustomerPatch & { email: string }): Customer {
  if (!isEmail(input.email)) throw new AppError('Enter a valid email address.')
  if (get('SELECT 1 FROM customer_emails WHERE email = ?', normEmail(input.email))) throw new AppError('A customer with that email already exists.', 409)
  const created = findOrCreateCustomer(input.email, input.name)
  const { email: _email, ...rest } = input
  return updateCustomer(created.id, rest)
}
