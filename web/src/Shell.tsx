import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  AlarmClock,
  Archive,
  ChartNoAxesColumn,
  ChevronsUpDown,
  Inbox,
  Keyboard,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Sun,
  TriangleAlert,
  UserRound,
  Users,
  UsersRound,
} from 'lucide-react'
import { api, qs } from './lib/api'
import { useDebounced, useHotkeys, useMailboxes, useSession, useTheme, type Theme } from './lib/hooks'
import type { ConversationSummary, Customer, Folder, Mailbox } from './lib/types'
import { Avatar, IconButton, Kbd, MenuDivider, MenuItem, MenuLabel, Modal, Popover, StatusBadge, cx } from './ui'
import { Logo } from './pages/Auth'
import { NewConversation, type ComposePrefill } from './inbox/NewConversation'

interface ShellActions {
  compose: (prefill?: ComposePrefill) => void
  openPalette: () => void
  openShortcuts: () => void
}
const ShellContext = createContext<ShellActions>({ compose: () => {}, openPalette: () => {}, openShortcuts: () => {} })
export const useShell = () => useContext(ShellContext)

export const FOLDERS: { id: Folder; label: string; icon: typeof Inbox; countKey?: 'unassigned' | 'mine' | 'assigned' | 'snoozed' | 'spam' }[] = [
  { id: 'unassigned', label: 'Unassigned', icon: Inbox, countKey: 'unassigned' },
  { id: 'mine', label: 'Mine', icon: UserRound, countKey: 'mine' },
  { id: 'assigned', label: 'Assigned', icon: Users, countKey: 'assigned' },
  { id: 'snoozed', label: 'Snoozed', icon: AlarmClock },
  { id: 'closed', label: 'Closed', icon: Archive },
  { id: 'spam', label: 'Spam', icon: ShieldAlert },
]

const navItem = (active: boolean) =>
  cx(
    'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
    active ? 'bg-accent-soft text-accent-fg' : 'text-fg-2 hover:bg-hover hover:text-fg [&>svg]:text-fg-3',
  )

function Sidebar({ mailboxes, onNavigate }: { mailboxes: Mailbox[]; onNavigate?: () => void }) {
  const { user, refresh } = useSession()
  const shell = useShell()
  const navigate = useNavigate()
  const [theme, setTheme] = useTheme()
  const themes: { id: Theme; label: string; icon: ReactNode }[] = [
    { id: 'light', label: 'Light', icon: <Sun /> },
    { id: 'dark', label: 'Dark', icon: <Moon /> },
    { id: 'system', label: 'Match system', icon: <Monitor /> },
  ]
  const signOut = async () => {
    await api.post('/logout')
    refresh()
  }

  return (
    <div className="flex h-full w-60 flex-col bg-canvas">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <Logo size={26} />
        <span className="text-[15px] font-semibold tracking-tight">Ansa</span>
      </div>

      <div className="flex flex-col gap-1.5 px-3">
        <button
          type="button"
          onClick={shell.openPalette}
          className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-fg-3 shadow-card transition-colors hover:text-fg"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 text-left">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button
          type="button"
          onClick={() => shell.compose()}
          disabled={mailboxes.length === 0}
          className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <SquarePen className="size-4 text-fg-3" aria-hidden />
          New conversation
        </button>
      </div>

      <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Mailboxes">
        {mailboxes.map((mailbox) => (
          <div key={mailbox.id} className="mb-4">
            <div className="mb-1 flex h-7 items-center gap-2 px-2.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: mailbox.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-fg-3">{mailbox.name}</span>
              {mailbox.syncStatus === 'error' && (
                <NavLink to={`/settings/mailboxes/${mailbox.id}`} onClick={onNavigate} title={`Cannot fetch mail: ${mailbox.syncError ?? 'unknown error'}`} aria-label="Mailbox connection problem">
                  <TriangleAlert className="size-3.5 text-warn" />
                </NavLink>
              )}
            </div>
            <ul className="flex flex-col gap-px">
              {FOLDERS.map((folder) => {
                const count = folder.countKey ? mailbox.counts[folder.countKey] : 0
                const showCount = count > 0 && folder.id !== 'spam'
                return (
                  <li key={folder.id}>
                    <NavLink to={`/m/${mailbox.id}/${folder.id}`} onClick={onNavigate} className={({ isActive }) => navItem(isActive)}>
                      <folder.icon aria-hidden />
                      <span className="flex-1">{folder.label}</span>
                      {showCount && <span className="text-xs font-semibold tabular-nums">{count}</span>}
                    </NavLink>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex shrink-0 flex-col gap-px border-t border-line px-3 py-2">
        <NavLink to="/customers" onClick={onNavigate} className={({ isActive }) => navItem(isActive)}>
          <UsersRound aria-hidden />
          Customers
        </NavLink>
        <NavLink to="/reports" onClick={onNavigate} className={({ isActive }) => navItem(isActive)}>
          <ChartNoAxesColumn aria-hidden />
          Reports
        </NavLink>
        <NavLink to="/settings" onClick={onNavigate} className={({ isActive }) => navItem(isActive)}>
          <Settings aria-hidden />
          Settings
        </NavLink>
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <Popover
          side="top"
          width={224}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-hover">
              <Avatar name={user.name} color={user.color} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{user.name}</span>
                <span className="block truncate text-xs text-fg-3">{user.email}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-fg-3" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<UserRound />}
                onSelect={() => {
                  close()
                  onNavigate?.()
                  navigate('/settings/profile')
                }}
              >
                Your profile
              </MenuItem>
              <MenuItem
                icon={<Keyboard />}
                hint={<Kbd>?</Kbd>}
                onSelect={() => {
                  close()
                  shell.openShortcuts()
                }}
              >
                Keyboard shortcuts
              </MenuItem>
              <MenuDivider />
              <MenuLabel>Theme</MenuLabel>
              {themes.map((t) => (
                <MenuItem key={t.id} icon={t.icon} checked={theme === t.id} onSelect={() => setTheme(t.id)}>
                  {t.label}
                </MenuItem>
              ))}
              <MenuDivider />
              <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
                Sign out
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
    </div>
  )
}

export function Shell() {
  const mailboxes = useMailboxes()
  const list = useMemo(() => mailboxes.data ?? [], [mailboxes.data])
  const [compose, setCompose] = useState<ComposePrefill | null>(null)
  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const location = useLocation()
  useEffect(() => setDrawer(false), [location.pathname])

  const actions = useMemo<ShellActions>(
    () => ({ compose: (prefill) => setCompose(prefill ?? {}), openPalette: () => setPalette(true), openShortcuts: () => setShortcuts(true) }),
    [],
  )

  useHotkeys({
    'mod+k': (e) => {
      e.preventDefault()
      setPalette((open) => !open)
    },
    '/': (e) => {
      e.preventDefault()
      setPalette(true)
    },
    c: (e) => {
      if (list.length === 0) return
      e.preventDefault()
      setCompose({})
    },
    '?': () => setShortcuts(true),
  })

  return (
    <ShellContext.Provider value={actions}>
      <div className="flex h-full">
        <aside className="hidden shrink-0 border-r border-line md:block">
          <Sidebar mailboxes={list} />
        </aside>
        {drawer && (
          <div className="animate-fade fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setDrawer(false)}>
            <aside className="h-full w-60 border-r border-line shadow-pop" onClick={(e) => e.stopPropagation()}>
              <Sidebar mailboxes={list} onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 md:hidden">
            <IconButton label="Open menu" onClick={() => setDrawer(true)}>
              <MenuIcon className="size-5" />
            </IconButton>
            <Logo size={22} />
            <span className="flex-1 text-sm font-semibold">Ansa</span>
            <IconButton label="Search" onClick={() => setPalette(true)}>
              <Search className="size-4.5" />
            </IconButton>
            <IconButton label="New conversation" onClick={() => setCompose({})} disabled={list.length === 0}>
              <SquarePen className="size-4.5" />
            </IconButton>
          </header>
          <main className="min-h-0 flex-1 bg-surface">
            <Outlet />
          </main>
        </div>
      </div>
      {compose && <NewConversation prefill={compose} mailboxes={list} onClose={() => setCompose(null)} />}
      {palette && <CommandPalette mailboxes={list} onClose={() => setPalette(false)} />}
      <ShortcutsHelp open={shortcuts} onClose={() => setShortcuts(false)} />
    </ShellContext.Provider>
  )
}

// ---------------------------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------------------------

const ITEM =
  'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-fg data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-fg [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-3'
const GROUP = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3'

function CommandPalette({ mailboxes, onClose }: { mailboxes: Mailbox[]; onClose: () => void }) {
  const navigate = useNavigate()
  const shell = useShell()
  const [, setTheme] = useTheme()
  const [query, setQuery] = useState('')
  const term = useDebounced(query.trim(), 180)
  const conversations = useQuery({
    queryKey: ['palette', 'conversations', term],
    queryFn: () => api.get<{ items: ConversationSummary[] }>(`/conversations${qs({ q: term, limit: 6 })}`).then((r) => r.items),
    enabled: term.length > 1,
  })
  const customers = useQuery({
    queryKey: ['palette', 'customers', term],
    queryFn: () => api.get<{ items: Customer[] }>(`/customers${qs({ q: term, limit: 4 })}`).then((r) => r.items),
    enabled: term.length > 1,
  })
  const go = (path: string) => {
    onClose()
    navigate(path)
  }
  const lower = query.trim().toLowerCase()
  const shows = (label: string) => !lower || label.toLowerCase().includes(lower)

  const pages = [
    ...mailboxes.flatMap((m) => FOLDERS.map((f) => ({ label: `${m.name}: ${f.label}`, icon: <f.icon />, path: `/m/${m.id}/${f.id}` }))),
    { label: 'Customers', icon: <UsersRound />, path: '/customers' },
    { label: 'Reports', icon: <ChartNoAxesColumn />, path: '/reports' },
    { label: 'Settings', icon: <Settings />, path: '/settings' },
  ].filter((p) => shows(p.label))
  const commands = [
    { label: 'New conversation', icon: <SquarePen />, run: () => shell.compose() },
    { label: 'Use light theme', icon: <Sun />, run: () => setTheme('light') },
    { label: 'Use dark theme', icon: <Moon />, run: () => setTheme('dark') },
    { label: 'Keyboard shortcuts', icon: <Keyboard />, run: () => shell.openShortcuts() },
  ].filter((c) => shows(c.label))

  return (
    <div className="animate-fade fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Command
        label="Search and commands"
        shouldFilter={false}
        loop
        className="animate-pop w-full max-w-xl overflow-hidden rounded-2xl bg-surface shadow-pop"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-fg-3" aria-hidden />
          <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Search conversations, customers and pages" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-3" />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-sm text-fg-3">{conversations.isFetching ? 'Searching…' : 'Nothing matches that search.'}</Command.Empty>
          {term.length > 1 && (
            <Command.Group heading="Conversations" className={GROUP}>
              {conversations.data?.map((c) => (
                <Command.Item key={c.id} value={`conversation-${c.id}`} onSelect={() => go(`/c/${c.id}`)} className={cx(ITEM, 'h-auto py-1.5')}>
                  <Inbox />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.subject}</span>
                    <span className="block truncate text-xs text-fg-3">
                      {c.customer.name} · {c.preview}
                    </span>
                  </span>
                  <StatusBadge status={c.status} />
                </Command.Item>
              ))}
              <Command.Item value="search-all" onSelect={() => go(`/search${qs({ q: query.trim() })}`)} className={ITEM}>
                <Search />
                <span>
                  Search all conversations for <span className="font-medium">“{query.trim()}”</span>
                </span>
              </Command.Item>
            </Command.Group>
          )}
          {term.length > 1 && !!customers.data?.length && (
            <Command.Group heading="Customers" className={GROUP}>
              {customers.data.map((c) => (
                <Command.Item key={c.id} value={`customer-${c.id}`} onSelect={() => go(`/customers/${c.id}`)} className={ITEM}>
                  <Avatar name={c.name || c.email} size={20} />
                  <span className="truncate">{c.name || c.email}</span>
                  <span className="truncate text-xs text-fg-3">{c.email}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {commands.length > 0 && (
            <Command.Group heading="Actions" className={GROUP}>
              {commands.map((c) => (
                <Command.Item
                  key={c.label}
                  value={c.label}
                  onSelect={() => {
                    onClose()
                    c.run()
                  }}
                  className={ITEM}
                >
                  {c.icon}
                  {c.label}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {pages.length > 0 && (
            <Command.Group heading="Go to" className={GROUP}>
              {pages.map((p) => (
                <Command.Item key={p.path} value={p.path} onSelect={() => go(p.path)} className={ITEM}>
                  {p.icon}
                  {p.label}
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  )
}

const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: 'Anywhere',
    items: [
      [['⌘', 'K'], 'Search and commands'],
      [['C'], 'New conversation'],
      [['?'], 'Show this list'],
    ],
  },
  {
    group: 'Conversation list',
    items: [
      [['J'], 'Next conversation'],
      [['K'], 'Previous conversation'],
      [['Esc'], 'Back to the list'],
    ],
  },
  {
    group: 'Open conversation',
    items: [
      [['R'], 'Reply'],
      [['N'], 'Add a note'],
      [['A'], 'Assign to me'],
      [['E'], 'Close conversation'],
      [['⌘', 'Enter'], 'Send'],
    ],
  },
]

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width={440}>
      <div className="flex flex-col gap-5">
        {SHORTCUTS.map((section) => (
          <section key={section.group}>
            <h3 className="mb-1.5 text-xs font-medium text-fg-3">{section.group}</h3>
            <dl className="flex flex-col">
              {section.items.map(([keys, label]) => (
                <div key={label} className="flex h-8 items-center justify-between border-b border-line last:border-0">
                  <dt className="text-[13px]">{label}</dt>
                  <dd className="flex gap-1">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}
