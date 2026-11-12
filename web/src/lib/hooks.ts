import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { brand, type Workspace } from './workspace'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { Mailbox, SavedReply, Tag, User, Viewer } from './types'

export interface Session {
  user: User
  appUrl: string
  workspace: Workspace
  refresh: () => void
}
export const SessionContext = createContext<Session | null>(null)
export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside provider')
  return session
}

export const useMailboxes = () => useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/mailboxes').then((r) => r.mailboxes), staleTime: 15_000 })
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: User[] }>('/users').then((r) => r.users), staleTime: 60_000 })
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => api.get<{ tags: Tag[] }>('/tags').then((r) => r.tags), staleTime: 30_000 })
export const useSavedReplies = () =>
  useQuery({ queryKey: ['saved-replies'], queryFn: () => api.get<{ savedReplies: SavedReply[] }>('/saved-replies').then((r) => r.savedReplies), staleTime: 60_000 })

/** Keep lists and open conversations fresh from the server's event stream. */
export function useLiveEvents() {
  const client = useQueryClient()
  useEffect(() => {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let pending: ReturnType<typeof setTimeout> | undefined
    const refreshLists = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = undefined
        void client.invalidateQueries({ queryKey: ['conversations'] })
        void client.invalidateQueries({ queryKey: ['mailboxes'] })
      }, 150)
    }
    const connect = () => {
      if (closed || source || document.visibilityState === 'hidden') return
      source = new EventSource('/api/events')
      source.onmessage = (message) => {
        let event: any
        try {
          event = JSON.parse(message.data)
        } catch {
          return
        }
        if (event.type === 'conversation') {
          refreshLists()
          void client.invalidateQueries({ queryKey: ['conversation', event.id] })
          if (event.reason === 'created' || event.reason === 'customer_reply') window.dispatchEvent(new CustomEvent('ansa:incoming', { detail: event }))
        } else if (event.type === 'presence') {
          client.setQueryData(['presence', event.conversationId], event.viewers as Viewer[])
        } else if (event.type === 'mailbox') {
          void client.invalidateQueries({ queryKey: ['mailboxes'] })
        } else if (event.type === 'refresh' && event.scope === 'workspace') {
          // An admin changed branding or features: reload them for everyone who is signed in.
          void client.invalidateQueries({ queryKey: ['bootstrap'] })
        } else if (event.type === 'refresh' && event.scope === 'users') {
          // A teammate changed their photo: it shows in lists, conversations and the top bar.
          void client.invalidateQueries({ queryKey: ['users'] })
          void client.invalidateQueries({ queryKey: ['bootstrap'] })
          refreshLists()
          void client.invalidateQueries({ queryKey: ['conversation'] })
        } else if (event.type === 'visitor') {
          // A live chat visitor opened or left the chat.
          void client.invalidateQueries({ queryKey: ['conversation', event.conversationId] })
        } else if (event.type === 'hello') {
          refreshLists()
        }
      }
      source.onerror = () => {
        disconnect()
        if (!closed) retry = setTimeout(connect, 4000)
      }
    }
    const disconnect = () => {
      source?.close()
      source = null
      clearTimeout(retry)
    }
    // A hidden tab gives its connection back. Browsers allow only six per site over plain HTTP,
    // so many open tabs would otherwise starve each other. Reconnecting refreshes everything.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') disconnect()
      else {
        connect()
        void client.invalidateQueries({ queryKey: ['conversation'] })
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', disconnect)
    window.addEventListener('pageshow', connect)
    connect()
    return () => {
      closed = true
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', disconnect)
      window.removeEventListener('pageshow', connect)
      source?.close()
      clearTimeout(retry)
      clearTimeout(pending)
    }
  }, [client])
}

/**
 * Tell the server every minute that this teammate has the app open, so live chat can count them as
 * available. Background tabs keep doing it (browsers slow timers to about once a minute, which is enough).
 */
export function useHeartbeat() {
  useEffect(() => {
    const beat = () => void api.post('/me/heartbeat').catch(() => {})
    beat()
    const timer = setInterval(beat, 60_000)
    return () => clearInterval(timer)
  }, [])
}

/** The first time someone opens the app, their time zone starts as this browser's. They can change it on Profile. */
export function useInitialTimezone() {
  const { user, refresh } = useSession()
  useEffect(() => {
    if (user.timezone) return
    let zone = 'UTC'
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      /* keep UTC */
    }
    void api.patch('/me', { timezone: zone }).then(refresh, () => {})
  }, [user.timezone]) // eslint-disable-line react-hooks/exhaustive-deps
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * The first key of a two-key shortcut such as "s c", while we wait for the second. Shared by every useHotkeys,
 * so the second key goes to the sequence and not to a one-key shortcut elsewhere ("c" is New conversation).
 */
let sequenceStart: { key: string; at: number } | null = null
const SEQUENCE_MS = 1500

/**
 * Global keyboard shortcuts. Keys: "j", "?", "mod+k", "mod+enter", "escape", and sequences such as "s c"
 * (press S, then C). Plain keys are ignored while the user types in a field or a dialog is open.
 */
export function useHotkeys(bindings: Record<string, (event: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(bindings)
  ref.current = bindings
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
      const combo = `${mod ? 'mod+' : ''}${key}`
      const blocked = !mod && key !== 'escape' && (isTyping(e.target) || e.altKey || !!document.querySelector('[role=dialog]'))

      // The second key of a sequence. Whatever it is, it does nothing else.
      const started = sequenceStart
      if (started && !mod && Date.now() - started.at < SEQUENCE_MS) {
        const handler = blocked ? undefined : ref.current[`${started.key} ${key}`]
        if (handler) {
          sequenceStart = null
          e.preventDefault()
          handler(e)
        } else {
          // Another shortcut set may own it; once this key press is over, the sequence ends either way.
          setTimeout(() => {
            if (sequenceStart === started) sequenceStart = null
          }, 0)
        }
        return
      }

      // The first key of a sequence: wait for the second.
      if (!mod && !blocked && Object.keys(ref.current).some((k) => k.startsWith(`${key} `))) {
        sequenceStart = { key, at: Date.now() }
        e.preventDefault()
        return
      }

      const handler = ref.current[combo]
      if (!handler || blocked) return
      handler(e)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled])
}

export type Theme = 'system' | 'light' | 'dark'
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('ansa-theme') as Theme) || 'system'
    } catch {
      return 'system'
    }
  })
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light'
    }
    apply()
    try {
      localStorage.setItem('ansa-theme', theme)
    } catch {
      /* private mode */
    }
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme]
}

export function useLocalState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  return [
    value,
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* private mode */
      }
    },
  ]
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function useDocumentTitle(title: string) {
  const name = brand()
  useEffect(() => {
    document.title = title ? `${title} · ${name}` : name
  }, [title, name])
}
