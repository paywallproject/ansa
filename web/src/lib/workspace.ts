/**
 * Workspace settings from the server: branding and optional features (Settings → Workspace).
 * They load with the app, before anything renders, so plain functions can read them.
 */
import { STATUS_LABEL } from './format'
import type { Status } from './types'

export interface Workspace {
  /** Empty means the default name. */
  brandName: string
  logoUrl: string | null
  mentions: boolean
  fourStatuses: boolean
}

const DEFAULT_NAME = 'Ansa'
let current: Workspace = { brandName: '', logoUrl: null, mentions: false, fourStatuses: false }
let defaultIcon: string | null = null

/** Call with fresh settings before rendering. Safe to call again with the same values. */
export function applyWorkspace(next: Workspace) {
  current = next
  Object.assign(
    STATUS_LABEL,
    next.fourStatuses ? { active: 'Active', waiting: 'Waiting on me', pending: 'Waiting on customer', closed: 'Closed' } : { active: 'Active', waiting: 'Active', pending: 'Pending', closed: 'Closed' },
  )
  // The browser tab icon follows the uploaded logo.
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon) {
    defaultIcon ??= icon.getAttribute('href')
    const href = next.logoUrl ?? defaultIcon
    if (href && icon.getAttribute('href') !== href) {
      icon.setAttribute('href', href)
      if (next.logoUrl) icon.removeAttribute('type')
      else icon.setAttribute('type', 'image/svg+xml')
    }
  }
}

export const workspace = () => current
/** The product name to show. */
export const brand = () => current.brandName || DEFAULT_NAME
/** The statuses a person can pick, in order. */
export const statusOptions = (): Status[] => (current.fourStatuses ? ['active', 'waiting', 'pending', 'closed'] : ['active', 'pending', 'closed'])
export const STATUS_DOT: Record<string, string> = { active: 'bg-ok', waiting: 'bg-accent', pending: 'bg-warn', closed: 'bg-fg-3', spam: 'bg-danger' }
