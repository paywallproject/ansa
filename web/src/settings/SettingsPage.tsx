import { useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Building, Download, KeyRound, Mail, Plus, Puzzle, Tag as TagIcon, Trash2, UserRound, Users, Workflow as WorkflowIcon } from 'lucide-react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useDocumentTitle, useMailboxes, useSession, useTags, useUsers } from '../lib/hooks'
import type { Tag, User } from '../lib/types'
import { Avatar, Banner, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Popover, Select, Spinner, Switch, cx, useFeedback } from '../ui'
import { RichField } from '../inbox/Editor'
import { MailboxesSettings } from './Mailboxes'
import { SavedRepliesSettings, WorkflowsSettings } from './Automation'
import { ApiSettings } from './ApiMcp'
import { AppsSettings } from './Apps'
import { WorkspaceSettings } from './Workspace'
import { ImportSettings } from './Import'
import { workspace } from '../lib/workspace'
import { PhotoPicker } from './PhotoPicker'
import { allZones, browserZone, validZone } from '../lib/timezone'
import { badgeEnabled, badgeSupported, runningAsApp, setBadgeEnabled } from '../lib/badge'
import { notifyEnabled, notifySupported, setNotifyEnabled, showNotification } from '../lib/notify'

const NAV: { to: string; label: string; icon: ReactNode; admin?: boolean }[] = [
  { to: 'profile', label: 'Profile', icon: <UserRound /> },
  { to: 'mailboxes', label: 'Mailboxes', icon: <Mail />, admin: true },
  { to: 'team', label: 'Team', icon: <Users /> },
  { to: 'tags', label: 'Tags', icon: <TagIcon /> },
  { to: 'saved-replies', label: 'Saved replies', icon: <Bookmark /> },
  { to: 'workflows', label: 'Workflows', icon: <WorkflowIcon />, admin: true },
  { to: 'apps', label: 'Apps', icon: <Puzzle />, admin: true },
  { to: 'workspace', label: 'Workspace', icon: <Building />, admin: true },
  { to: 'import', label: 'Import', icon: <Download />, admin: true },
  { to: 'api', label: 'API & MCP', icon: <KeyRound /> },
]

export function SettingsPage() {
  useDocumentTitle('Settings')
  const { user } = useSession()
  const admin = user.role === 'admin'
  const items = NAV.filter((n) => !n.admin || admin)
  return (
    <div className="flex h-full flex-col bg-canvas md:flex-row">
      <nav aria-label="Settings" className="shrink-0 border-line bg-surface md:w-52 md:border-r md:p-3">
        <h2 className="hidden px-2.5 pt-2 pb-2 text-[15px] font-semibold md:block">Settings</h2>
        <ul className="flex gap-1 overflow-x-auto border-b border-line p-2 md:flex-col md:gap-px md:overflow-visible md:border-0 md:p-0">
          {items.map((item) => (
            <li key={item.to} className="shrink-0">
              <NavLink
                to={`/settings/${item.to}`}
                className={({ isActive }) =>
                  cx(
                    'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
                    isActive ? 'bg-accent-soft text-accent-fg' : 'text-fg-2 hover:bg-hover hover:text-fg [&>svg]:text-fg-3',
                  )
                }
              >
                {item.icon}
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
          <Routes>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<ProfileSettings />} />
            {admin && <Route path="mailboxes" element={<MailboxesSettings />} />}
            {admin && <Route path="mailboxes/:mailboxId" element={<MailboxesSettings />} />}
            <Route path="team" element={<TeamSettings />} />
            <Route path="tags" element={<TagsSettings />} />
            <Route path="saved-replies" element={<SavedRepliesSettings />} />
            {admin && <Route path="workflows" element={<WorkflowsSettings />} />}
            {admin && <Route path="apps" element={<AppsSettings />} />}
            {admin && <Route path="workspace" element={<WorkspaceSettings />} />}
            {admin && <Route path="import" element={<ImportSettings />} />}
            <Route path="api" element={<ApiSettings />} />
            <Route path="*" element={<Navigate to="profile" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

function ProfileSettings() {
  const { user, refresh } = useSession()
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    signature: user.signature,
    notifyAssigned: user.notifyAssigned,
    notifyReplies: user.notifyReplies,
    notifyMentions: user.notifyMentions,
    timezone: user.timezone || browserZone(),
  })
  const zones = allZones()
  const here = browserZone()
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' })
  const [error, setError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => api.patch('/me', form),
    onSuccess: () => {
      refresh()
      toast('Profile saved')
    },
    onError: (err: Error) => setError(err.message),
  })
  const changePassword = useMutation({
    mutationFn: () => api.patch('/me', passwords),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '' })
      toast('Password changed')
    },
    onError: (err: Error) => setPasswordError(err.message),
  })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Profile" description="Your photo, name, signature and notifications." />
      <Card className="p-5">
        <h2 className="mb-4 text-[15px] font-semibold">Photo</h2>
        <PhotoPicker
          user={user}
          path="/me/avatar"
          onChange={() => {
            refresh()
            void client.invalidateQueries({ queryKey: ['users'] })
          }}
        />
      </Card>
      <Card className="p-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            save.mutate()
          }}
        >
          {error && <Banner kind="danger">{error}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Email" hint="You sign in with this address.">
              {(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
            </Field>
          </div>
          <Field
            label="Time zone"
            hint={
              <>
                Send later suggests and shows times in this zone.{' '}
                {form.timezone !== here && (
                  <button type="button" className="underline hover:text-fg" onClick={() => setForm({ ...form, timezone: here })}>
                    Use this browser's ({here.replace(/_/g, ' ')})
                  </button>
                )}
              </>
            }
            error={form.timezone && !validZone(form.timezone) ? 'Pick a time zone from the list, such as America/New_York.' : null}
          >
            {(id) => (
              <>
                <Input id={id} list={`${id}-zones`} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="America/New_York" className="max-w-sm" />
                <datalist id={`${id}-zones`}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Personal signature" hint="Added under your replies. Leave it empty to use the mailbox signature.">
            {(id) => <RichField id={id} value={form.signature} onChange={(signature) => setForm((f) => ({ ...f, signature }))} placeholder={`${user.name.split(' ')[0]}, Customer Support`} minHeight={72} />}
          </Field>
          <div className="flex flex-col gap-3">
            <h3 className="text-[13px] font-medium">Email me when</h3>
            <Switch checked={form.notifyAssigned} onChange={(v) => setForm({ ...form, notifyAssigned: v })} label="A teammate assigns me a conversation" />
            <Switch checked={form.notifyReplies} onChange={(v) => setForm({ ...form, notifyReplies: v })} label="A customer replies to my conversation" />
            <Switch checked={form.notifyMentions} onChange={(v) => setForm({ ...form, notifyMentions: v })} label="A teammate mentions me in a note" />
          </div>
          {/* Only an installed app has an icon to put a count on; in a browser tab the switch would do nothing. */}
          {(notifySupported() || runningAsApp()) && <DeviceSettings />}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      </Card>
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">Password</h2>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setPasswordError(null)
            changePassword.mutate()
          }}
        >
          {passwordError && <Banner kind="danger">{passwordError}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current password">
              {(id) => <Input id={id} type="password" autoComplete="current-password" required value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} />}
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} />}
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={changePassword.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}

/** The red count on the app icon, for this device. Saved at once, apart from the form above. */
/** Settings kept in this browser: chat notifications everywhere, the icon count in the installed app. Saved at once. */
function DeviceSettings() {
  const { toast } = useFeedback()
  const [notify, setNotify] = useState(notifyEnabled)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[13px] font-medium">On this device</h3>
      {notifySupported() && (
        <Switch
          checked={notify}
          disabled={busy}
          onChange={async (next) => {
            setBusy(true)
            const result = await setNotifyEnabled(next)
            setBusy(false)
            if (result.ok) setNotify(next)
            else toast(result.message ?? 'Could not change that.', { kind: 'error' })
          }}
          label="Notify me about live chats"
          description="A banner when a chat starts, and when a visitor writes in a chat that is unassigned or yours. Saved at once, for this browser. It works while the app is open, in a background tab too."
        />
      )}
      {notifySupported() && notify && (
        <div className="ml-12 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={async () => {
              const shown = await showNotification('Live chat notifications are on', 'This is how a new chat will look.', '/settings/profile', 'ansa-test', true)
              if (!shown) toast('The browser would not show it. Check that notifications are allowed for this site.', { kind: 'error' })
            }}
          >
            Send a test notification
          </Button>
          <p className="min-w-56 flex-1 text-xs text-fg-3">Nothing appears? On a Mac, check System Settings → Notifications → your browser, and that Focus or Do Not Disturb is off.</p>
        </div>
      )}
      {runningAsApp() && <AppBadgeSwitch />}
    </div>
  )
}

function AppBadgeSwitch() {
  const { toast } = useFeedback()
  const [on, setOn] = useState(badgeEnabled)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <Switch
        checked={on}
        disabled={busy}
        onChange={async (next) => {
          setBusy(true)
          const result = await setBadgeEnabled(next)
          setBusy(false)
          if (result.ok) setOn(next)
          else toast(result.message ?? 'Could not change that.', { kind: 'error' })
        }}
        label="Show a count on the app icon"
        description={
          badgeSupported()
            ? 'A red number on the icon: your Unassigned and Mine conversations. On an iPhone this asks to allow notifications, which the count needs. It updates while the app is open or recently used.'
            : 'Not available in this browser. On an iPhone, add the app to your home screen and turn this on from there.'
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------------------------

function TeamSettings() {
  const { user: me } = useSession()
  const users = useUsers()
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const admin = me.role === 'admin'
  const mailboxes = useMailboxes()
  const chat = mailboxes.data?.some((m) => m.chatEnabled) ?? false
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Team"
        description="The people who answer conversations."
        action={
          admin && (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
              Add teammate
            </Button>
          )
        }
      />
      {users.isPending ? (
        <Spinner />
      ) : (
        <Card className="divide-y divide-line">
          {users.data?.map((u) => (
            <div key={u.id} className={cx('flex items-center gap-3 px-5 py-3', u.disabled && 'opacity-60')}>
              <Avatar name={u.name} color={u.color} src={u.avatarUrl} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {u.name}
                  {u.id === me.id && <span className="ml-1.5 text-[13px] font-normal text-fg-3">(you)</span>}
                </p>
                <p className="truncate text-[13px] text-fg-3">{u.email}</p>
              </div>
              {chat && !u.disabled && (
                <span
                  className={cx('hidden h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium sm:inline-flex', u.chatAvailable ? 'bg-ok-soft text-ok' : 'bg-sunken text-fg-3')}
                  title={u.chatAvailable ? 'Available for live chat' : u.chatStatus === 'away' ? 'Set to away' : 'Available, but does not have the app open'}
                >
                  <span className={cx('size-1.5 rounded-full', u.chatAvailable ? 'bg-ok' : 'bg-fg-3')} aria-hidden />
                  {u.chatAvailable ? 'Available' : 'Away'}
                </span>
              )}
              <span className="text-[13px] text-fg-2">
                {u.disabled ? 'Deactivated' : u.role === 'admin' ? 'Admin' : 'Agent'}
                {!u.disabled && u.mailboxAccess === 'some' && (
                  <span className="text-fg-3" title={(mailboxes.data ?? []).filter((m) => u.mailboxIds.includes(m.id)).map((m) => m.name).join(', ')}>
                    {' · '}
                    {plural(u.mailboxIds.length, 'mailbox', 'mailboxes')}
                  </span>
                )}
              </span>
              {admin && (
                <Button size="sm" onClick={() => setEditing(u)}>
                  Edit
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
      {editing && <TeammateForm user={editing === 'new' ? null : editing} isSelf={editing !== 'new' && editing.id === me.id} onClose={() => setEditing(null)} />}
    </div>
  )
}

function TeammateForm({ user, isSelf, onClose }: { user: User | null; isSelf: boolean; onClose: () => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const { refresh } = useSession()
  // The photo changes while the dialog is open, so read it from the live list.
  const users = useUsers()
  const live = user ? (users.data?.find((u) => u.id === user.id) ?? user) : null
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'agent',
    password: '',
    mailboxAccess: user?.mailboxAccess ?? ('all' as 'all' | 'some'),
    mailboxIds: user?.mailboxIds ?? ([] as number[]),
  })
  const allMailboxes = useMailboxes().data ?? []
  const limited = form.role !== 'admin' && form.mailboxAccess === 'some'
  const [error, setError] = useState<string | null>(null)
  const done = (message: string) => {
    void client.invalidateQueries({ queryKey: ['users'] })
    toast(message)
    onClose()
  }
  const save = useMutation({
    mutationFn: () => {
      if (limited && form.mailboxIds.length === 0) throw new Error('Pick at least one mailbox, or give access to all of them.')
      return user ? api.patch(`/users/${user.id}`, { ...form, password: form.password || undefined }) : api.post('/users', form)
    },
    onSuccess: () => done(user ? 'Teammate saved' : 'Teammate added'),
    onError: (err: Error) => setError(err.message),
  })
  const toggle = useMutation({
    mutationFn: () => api.patch(`/users/${user!.id}`, { disabled: !user!.disabled }),
    onSuccess: () => done(user!.disabled ? 'Teammate reactivated' : 'Teammate deactivated'),
    onError: (err: Error) => setError(err.message),
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Add a teammate'}
      description={user ? undefined : 'Create their account, then send them the sign-in address and password.'}
      footer={
        <>
          {user && !isSelf && (
            <Button variant="ghost" className="mr-auto text-danger hover:text-danger" loading={toggle.isPending} onClick={() => toggle.mutate()}>
              {user.disabled ? 'Reactivate' : 'Deactivate'}
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {user ? 'Save changes' : 'Add teammate'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        {error && <Banner kind="danger">{error}</Banner>}
        {live && (
          <PhotoPicker
            user={live}
            path={`/users/${live.id}/avatar`}
            onChange={() => {
              void client.invalidateQueries({ queryKey: ['users'] })
              if (isSelf) refresh()
            }}
          />
        )}
        <Field label="Name">{(id) => <Input id={id} required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        <Field label="Role" hint="Admins can also manage mailboxes, teammates and workflows.">
          {(id) => (
            <Select id={id} value={form.role} disabled={isSelf} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'agent' })}>
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </Select>
          )}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium">Mailboxes</legend>
          {form.role === 'admin' ? (
            <p className="text-[13px] text-fg-3">Admins can see every mailbox.</p>
          ) : (
            <>
              <div role="radiogroup" aria-label="Mailbox access" className="flex gap-1 rounded-lg bg-sunken p-1">
                {(['all', 'some'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={form.mailboxAccess === value}
                    onClick={() => setForm({ ...form, mailboxAccess: value })}
                    className={cx('h-7 flex-1 rounded-md text-[13px] font-medium transition-colors', form.mailboxAccess === value ? 'bg-surface text-fg shadow-card' : 'text-fg-2 hover:text-fg')}
                  >
                    {value === 'all' ? 'All mailboxes' : 'Only some'}
                  </button>
                ))}
              </div>
              {form.mailboxAccess === 'all' ? (
                <p className="text-[13px] text-fg-3">Includes mailboxes you add later.</p>
              ) : (
                <>
                  <div className="flex flex-col rounded-lg border border-line-strong">
                    {allMailboxes.map((m) => {
                      const on = form.mailboxIds.includes(m.id)
                      return (
                        <label key={m.id} className="flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0 hover:bg-sunken">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setForm({ ...form, mailboxIds: on ? form.mailboxIds.filter((id) => id !== m.id) : [...form.mailboxIds, m.id] })}
                            className="size-4 accent-[var(--accent)]"
                          />
                          <span className="size-2 shrink-0 rounded-full" style={{ background: m.color }} aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.name}</span>
                          <span className="truncate text-xs text-fg-3">{m.email}</span>
                        </label>
                      )
                    })}
                  </div>
                  <p className="text-[13px] text-fg-3">They see only these mailboxes: their conversations, customers' history in them, reports and live chats. Conversations assigned to them in other mailboxes become unassigned.</p>
                </>
              )}
            </>
          )}
        </fieldset>
        <Field label={user ? 'New password' : 'Password'} hint={user ? 'Leave blank to keep their current password.' : 'At least 8 characters.'}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" required={!user} minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

const TAG_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b']

function TagsSettings() {
  const tags = useTags()
  const client = useQueryClient()
  const { toast, confirm } = useFeedback()
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0])
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['tags'] })
    void client.invalidateQueries({ queryKey: ['conversations'] })
    void client.invalidateQueries({ queryKey: ['conversation'] })
  }
  const create = useMutation({
    mutationFn: () => api.post('/tags', { name, color }),
    onSuccess: () => {
      setName('')
      refresh()
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const recolor = useMutation({ mutationFn: (tag: { id: number; color: string }) => api.patch(`/tags/${tag.id}`, { color: tag.color }), onSuccess: refresh })
  const remove = async (tag: Tag) => {
    const ok = await confirm({ title: `Delete the tag “${tag.name}”?`, body: tag.count ? `It is removed from ${plural(tag.count, 'conversation')}. The conversations stay.` : undefined, confirmLabel: 'Delete tag', danger: true })
    if (!ok) return
    await api.del(`/tags/${tag.id}`)
    refresh()
    toast('Tag deleted')
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Tags" description="Label conversations by topic to find and report on them later." />
      <Card className="p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <Field label="New tag" className="min-w-48 flex-1">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="billing" />}
          </Field>
          <ColorPicker value={color} onChange={setColor} />
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            Add tag
          </Button>
        </form>
      </Card>
      {tags.isPending ? (
        <Spinner />
      ) : tags.data?.length === 0 ? (
        <Card>
          <EmptyState icon={<TagIcon />} title="No tags yet" body="Add one above, or type a new tag on any conversation." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {tags.data?.map((tag) => (
            <div key={tag.id} className="flex items-center gap-3 px-5 py-2.5">
              <ColorPicker value={tag.color} onChange={(c) => recolor.mutate({ id: tag.id, color: c })} compact />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{tag.name}</span>
              <span className="text-[13px] text-fg-3">{plural(tag.count ?? 0, 'conversation')}</span>
              <IconButton label={`Delete tag ${tag.name}`} size="sm" onClick={() => void remove(tag)}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

function ColorPicker({ value, onChange, compact }: { value: string; onChange: (color: string) => void; compact?: boolean }) {
  if (compact) {
    return (
      <Popover
        role="dialog"
        trigger={({ ref, ...props }) => <button ref={ref} type="button" {...props} aria-label="Change tag color" title="Change color" className="size-4 shrink-0 rounded-full" style={{ background: value }} />}
      >
        {(close) => (
          <div className="flex gap-1.5 p-1.5">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={value === c}
                onClick={() => {
                  onChange(c)
                  close()
                }}
                className={cx('size-5 rounded-full ring-offset-2 ring-offset-surface', value === c && 'ring-2 ring-fg')}
                style={{ background: c }}
              />
            ))}
          </div>
        )}
      </Popover>
    )
  }
  return (
    <fieldset className="flex h-9 items-center gap-1.5">
      <legend className="sr-only">Tag color</legend>
      {TAG_COLORS.map((c) => (
        <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={value === c} onClick={() => onChange(c)} className={cx('size-5 rounded-full ring-offset-2 ring-offset-surface', value === c && 'ring-2 ring-fg')} style={{ background: c }} />
      ))}
    </fieldset>
  )
}

