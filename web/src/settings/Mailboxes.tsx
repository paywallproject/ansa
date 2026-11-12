import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, CircleAlert, CircleCheck, Copy, Mail, Plus, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { brand } from '../lib/workspace'
import { ago } from '../lib/format'
import { useMailboxes, useSession } from '../lib/hooks'
import type { AssignAfterReply, ChatAvailability, Mailbox } from '../lib/types'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Switch, Textarea, cx, useFeedback } from '../ui'
import { RichField } from '../inbox/Editor'

type Security = 'starttls' | 'ssl' | 'none'
interface FormState {
  name: string
  email: string
  fromName: string
  color: string
  smtpHost: string
  smtpPort: number
  smtpSecurity: Security
  smtpUser: string
  smtpPassword: string
  imapEnabled: boolean
  imapHost: string
  imapPort: number
  imapSecurity: Security
  imapUser: string
  imapPassword: string
  imapFolder: string
  importExisting: boolean
  sameLogin: boolean
  signature: string
  autoReplyEnabled: boolean
  autoReplyBody: string
  assignAfterReply: AssignAfterReply
  chatEnabled: boolean
  chatTitle: string
  chatGreeting: string
  chatColor: string
  /** One website per line. */
  chatOrigins: string
  chatAvailability: ChatAvailability
  chatDays: number[]
  chatStart: string
  chatEnd: string
  chatTimezone: string
  chatAwayMessage: string
  chatHideWhenAway: boolean
}

const AVAILABILITY_OPTIONS: { id: ChatAvailability; label: string; hint: string }[] = [
  { id: 'team', label: 'When a teammate is available', hint: 'Online while at least one teammate is set to Available and has the app open. Each person switches between Available and Away in the account menu.' },
  { id: 'hours', label: 'During office hours', hint: 'Online on the days and hours you set, whoever is signed in.' },
  { id: 'always', label: 'Always online', hint: 'The chat never shows as away.' },
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
const allZones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

const ASSIGN_OPTIONS: { id: AssignAfterReply; label: string; hint: string }[] = [
  { id: 'keep', label: 'Leave it unassigned', hint: 'Sending doesn’t change the assignee. Unassigned conversations stay unassigned.' },
  { id: 'replier', label: 'Assign to the person who replied', hint: 'Whoever sends the reply becomes the assignee.' },
  { id: 'choose', label: 'Choose when sending', hint: 'The composer has an assignee picker next to Send. It starts on the current assignee.' },
]

const PRESETS: { id: string; label: string; smtpHost: string; smtpPort: number; smtpSecurity: Security; imapHost: string; imapPort: number }[] = [
  { id: 'google', label: 'Google Workspace or Gmail', smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecurity: 'starttls', imapHost: 'imap.gmail.com', imapPort: 993 },
  { id: 'microsoft', label: 'Microsoft 365', smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecurity: 'starttls', imapHost: 'outlook.office365.com', imapPort: 993 },
  { id: 'fastmail', label: 'Fastmail', smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSecurity: 'ssl', imapHost: 'imap.fastmail.com', imapPort: 993 },
]
const COLORS = ['#5448e2', '#0ea5e9', '#0d9488', '#16a34a', '#d97706', '#dc2626', '#db2777', '#64748b']

const initial = (m?: Mailbox): FormState => ({
  name: m?.name ?? '',
  email: m?.email ?? '',
  fromName: m?.fromName ?? '',
  color: m?.color ?? COLORS[0],
  smtpHost: m?.smtpHost ?? '',
  smtpPort: m?.smtpPort ?? 587,
  smtpSecurity: m?.smtpSecurity ?? 'starttls',
  // A saved mailbox with no SMTP username signs in with its own address: show that, rather than a grey example.
  smtpUser: m?.smtpUser || (m?.smtpPasswordSet ? m.email : ''),
  smtpPassword: '',
  imapEnabled: m?.imapEnabled ?? true,
  imapHost: m?.imapHost ?? '',
  imapPort: m?.imapPort ?? 993,
  imapSecurity: m?.imapSecurity ?? 'ssl',
  imapUser: m?.imapUser ?? '',
  imapPassword: '',
  imapFolder: m?.imapFolder ?? 'INBOX',
  importExisting: m?.importExisting ?? false,
  sameLogin: m ? (m.imapSameLogin ?? m.imapUser === m.smtpUser) : true,
  signature: m?.signature ?? '',
  autoReplyEnabled: m?.autoReplyEnabled ?? false,
  autoReplyBody: m?.autoReplyBody ?? '',
  assignAfterReply: m?.assignAfterReply ?? 'replier',
  chatEnabled: m?.chatEnabled ?? false,
  chatTitle: m?.chat?.title ?? 'Chat with us',
  chatGreeting: m?.chat?.greeting ?? '',
  chatColor: m?.chat?.color ?? COLORS[0],
  chatOrigins: (m?.chat?.origins ?? []).join('\n'),
  chatAvailability: m?.chat?.availability ?? 'team',
  chatDays: m?.chat?.hours.days ?? [1, 2, 3, 4, 5],
  chatStart: m?.chat?.hours.start ?? '09:00',
  chatEnd: m?.chat?.hours.end ?? '17:00',
  // Office hours not set up yet start in the admin's own time zone rather than UTC.
  chatTimezone: m?.chat?.availability === 'hours' ? m.chat.hours.timezone : m?.chat?.hours.timezone && m.chat.hours.timezone !== 'UTC' ? m.chat.hours.timezone : browserZone(),
  chatAwayMessage: m?.chat?.awayMessage ?? '',
  chatHideWhenAway: m?.chat?.hideWhenAway ?? false,
})

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-fg-3">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </Card>
  )
}

function TestButton({ payload }: { payload: () => Record<string, unknown> }) {
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; message: string }>('/mailboxes/test', payload()) })
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button loading={test.isPending} onClick={() => test.mutate()}>
        Test connection
      </Button>
      {test.data && !test.isPending && (
        <p role="status" className={cx('flex min-w-0 flex-1 items-start gap-1.5 text-[13px]', test.data.ok ? 'text-ok' : 'text-danger')}>
          {test.data.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          {test.data.message}
        </p>
      )}
      {test.isError && <p className="text-[13px] text-danger">{(test.error as Error).message}</p>}
    </div>
  )
}

export function MailboxForm({ mailbox, onSaved, compact = false }: { mailbox?: Mailbox; onSaved: (mailbox: Mailbox) => void; compact?: boolean }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [form, setForm] = useState<FormState>(() => initial(mailbox))
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))
  const text = (key: keyof FormState) => (e: { target: { value: string } }) => set(key, e.target.value as never)

  // Follows the host field, so typing your own server clears the highlighted provider.
  const preset = PRESETS.find((p) => p.smtpHost === form.smtpHost.trim().toLowerCase())?.id ?? null
  const [pickedOther, setPickedOther] = useState(false)
  const other = !preset && (pickedOther || form.smtpHost.trim() !== '')
  /** "Other" clears a filled-in provider so you can type your own server. Your own entries are kept. */
  const applyOther = () => {
    setPickedOther(true)
    if (preset) setForm((f) => ({ ...f, smtpHost: '', imapHost: '', smtpUser: f.smtpUser || f.email }))
  }
  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!
    setPickedOther(false)
    setForm((f) => ({ ...f, smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpSecurity: p.smtpSecurity, imapHost: p.imapHost, imapPort: p.imapPort, imapSecurity: 'ssl', smtpUser: f.smtpUser || f.email, sameLogin: true }))
  }
  const payload = () => ({
    ...form,
    id: mailbox?.id,
    // A blank username means the mailbox address, as the box's example shows.
    smtpUser: form.smtpUser.trim() || (form.smtpPassword || mailbox?.smtpPasswordSet ? form.email.trim() : ''),
    imapUser: form.sameLogin ? form.smtpUser.trim() || form.email.trim() : form.imapUser,
    imapPassword: form.sameLogin ? form.smtpPassword : form.imapPassword,
    // With a shared login and no new password typed, the server reuses the saved SMTP password.
    copySmtpPassword: form.sameLogin,
    // Chat is set up on a saved mailbox; a new one keeps the defaults.
    ...(mailbox
      ? {
          chat: {
            title: form.chatTitle,
            greeting: form.chatGreeting,
            color: form.chatColor,
            origins: form.chatOrigins,
            availability: form.chatAvailability,
            awayMessage: form.chatAwayMessage,
            hideWhenAway: form.chatHideWhenAway,
            // Office hours are checked only when they are used.
            ...(form.chatAvailability === 'hours' ? { hours: { days: form.chatDays, start: form.chatStart, end: form.chatEnd, timezone: form.chatTimezone } } : {}),
          },
        }
      : {}),
  })

  const save = useMutation({
    mutationFn: () => (mailbox ? api.patch<{ mailbox: Mailbox }>(`/mailboxes/${mailbox.id}`, payload()) : api.post<{ mailbox: Mailbox }>('/mailboxes', payload())),
    onSuccess: async ({ mailbox: saved }) => {
      await client.invalidateQueries({ queryKey: ['mailboxes'] })
      toast(mailbox ? 'Mailbox saved' : 'Mailbox added')
      setForm((f) => ({ ...f, smtpPassword: '', imapPassword: '' }))
      onSaved(saved)
    },
    onError: (err: Error) => setError(err.message),
  })

  const google = preset === 'google'
  const passwordHint = () => (google ? 'Paste the 16-character app password.' : undefined)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      <Section title="Mailbox" description="The address customers write to, and the name they see on your replies.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mailbox name" hint="Shown in the sidebar, for example Support.">
            {(id) => <Input id={id} required value={form.name} onChange={text('name')} placeholder="Support" />}
          </Field>
          <Field label="Email address">{(id) => <Input id={id} type="email" required value={form.email} onChange={text('email')} placeholder="support@yourcompany.com" />}</Field>
          <Field label="Sender name" hint="Customers see this in their inbox. Defaults to the mailbox name.">
            {(id) => <Input id={id} value={form.fromName} onChange={text('fromName')} placeholder={form.name || 'Acme Support'} />}
          </Field>
          {!compact && (
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium">Color</legend>
              <div className="flex h-9 items-center gap-2">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Color ${color}`}
                    aria-pressed={form.color === color}
                    onClick={() => set('color', color)}
                    className={cx('size-6 rounded-full ring-offset-2 ring-offset-surface transition-shadow', form.color === color && 'ring-2 ring-fg')}
                    style={{ background: color }}
                  />
                ))}
              </div>
            </fieldset>
          )}
        </div>
      </Section>

      <Section title="Email provider" description="Pick your provider to fill in the server details, or choose Other to enter your own.">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              onClick={() => applyPreset(p.id)}
              className={cx('h-8 rounded-lg border px-3 text-[13px] font-medium transition-colors', preset === p.id ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong hover:bg-sunken')}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={other}
            onClick={applyOther}
            className={cx('h-8 rounded-lg border px-3 text-[13px] font-medium transition-colors', other ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong hover:bg-sunken')}
          >
            Other (custom SMTP)
          </button>
        </div>
        {other && (
          <Banner>
            Any mail server works, including the one from your web hosting. Enter the host, port and login from your provider&rsquo;s email settings. The host is often <strong>mail.yourdomain.com</strong>, with port 465 (SSL/TLS) or 587 (STARTTLS), and the full email address as the username.
          </Banner>
        )}
        {google && (
          <Banner>
            Google needs an <strong>app password</strong>, not your normal one. Turn on 2-Step Verification, then create one at{' '}
            <a className="font-medium underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords
            </a>
            . Use the full email address as the username.
          </Banner>
        )}
      </Section>

      <Section title="Sending (SMTP)" description={`${brand()} sends replies through this server, so they come from your own address.`}>
        <div className="grid gap-4 sm:grid-cols-[1fr_110px_150px]">
          <Field label="SMTP host">{(id) => <Input id={id} value={form.smtpHost} onChange={text('smtpHost')} placeholder={other ? "mail.yourdomain.com" : "smtp.gmail.com"} />}</Field>
          <Field label="Port">{(id) => <Input id={id} type="number" value={form.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} />}</Field>
          <Field label="Security">
            {(id) => (
              <Select id={id} value={form.smtpSecurity} onChange={(e) => set('smtpSecurity', e.target.value as Security)}>
                <option value="starttls">STARTTLS</option>
                <option value="ssl">SSL/TLS</option>
                <option value="none">None</option>
              </Select>
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username">{(id) => <Input id={id} autoComplete="off" value={form.smtpUser} onChange={text('smtpUser')} placeholder={form.email || 'support@yourcompany.com'} />}</Field>
          <PasswordField saved={!!mailbox?.smtpPasswordSet} value={form.smtpPassword} onChange={(v) => set('smtpPassword', v)} hint={passwordHint()} />
        </div>
        <TestButton payload={() => ({ ...payload(), kind: 'smtp' })} />
      </Section>

      <Section title="Receiving (IMAP)" description={`${brand()} watches this inbox and turns new email into conversations. Mail stays in your account too.`}>
        <Switch checked={form.imapEnabled} onChange={(v) => set('imapEnabled', v)} label="Fetch incoming email" />
        {form.imapEnabled && (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_110px_150px]">
              <Field label="IMAP host">{(id) => <Input id={id} value={form.imapHost} onChange={text('imapHost')} placeholder={other ? "mail.yourdomain.com" : "imap.gmail.com"} />}</Field>
              <Field label="Port">{(id) => <Input id={id} type="number" value={form.imapPort} onChange={(e) => set('imapPort', Number(e.target.value))} />}</Field>
              <Field label="Security">
                {(id) => (
                  <Select id={id} value={form.imapSecurity} onChange={(e) => set('imapSecurity', e.target.value as Security)}>
                    <option value="ssl">SSL/TLS</option>
                    <option value="starttls">STARTTLS</option>
                    <option value="none">None</option>
                  </Select>
                )}
              </Field>
            </div>
            <Switch checked={form.sameLogin} onChange={(v) => set('sameLogin', v)} label="Use the same username and password as SMTP" />
            {!form.sameLogin && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Username">{(id) => <Input id={id} autoComplete="off" value={form.imapUser} onChange={text('imapUser')} />}</Field>
                <PasswordField saved={!!mailbox?.imapPasswordSet} value={form.imapPassword} onChange={(v) => set('imapPassword', v)} hint={passwordHint()} />
              </div>
            )}
            {!compact && (
              <Field label="Folder" hint="Usually INBOX.">
                {(id) => <Input id={id} value={form.imapFolder} onChange={text('imapFolder')} className="max-w-60" />}
              </Field>
            )}
            {!mailbox && <Switch checked={form.importExisting} onChange={(v) => set('importExisting', v)} label="Import the last 30 days of email" description="Off: only email that arrives from now on becomes a conversation." />}
            <TestButton payload={() => ({ ...payload(), kind: 'imap' })} />
          </>
        )}
      </Section>

      {!compact && (
        <>
          <Section title="Signature" description="Added under every reply from this mailbox, unless the teammate has a personal signature.">
            <RichField value={form.signature} onChange={(html) => set('signature', html)} placeholder="Best regards, the Acme team" minHeight={72} />
          </Section>
          <Section title="After sending a reply" description="Who the conversation is assigned to once a teammate replies.">
            <div role="radiogroup" aria-label="Assignee after sending" className="flex flex-col gap-2">
              {ASSIGN_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={form.assignAfterReply === o.id}
                  onClick={() => set('assignAfterReply', o.id)}
                  className={cx('flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors', form.assignAfterReply === o.id ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-sunken')}
                >
                  <span className={cx('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', form.assignAfterReply === o.id ? 'border-accent' : 'border-line-strong')} aria-hidden>
                    {form.assignAfterReply === o.id && <span className="size-2 rounded-full bg-accent" />}
                  </span>
                  <span>
                    <span className={cx('block text-[13px] font-medium', form.assignAfterReply === o.id && 'text-accent-fg')}>{o.label}</span>
                    <span className="block text-xs text-fg-3">{o.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </Section>
          {mailbox && <LiveChatSection form={form} set={set} chatKey={mailbox.chatKey ?? null} savedEnabled={!!mailbox.chatEnabled} onlineNow={mailbox.chatOnline ?? false} />}
          <Section title="Auto reply" description="Send an automatic acknowledgement when a customer starts a new conversation.">
            <Switch checked={form.autoReplyEnabled} onChange={(v) => set('autoReplyEnabled', v)} label="Send an auto reply to new conversations" />
            {form.autoReplyEnabled && (
              <Field label="Message" hint="You can use {{customer.firstName}}, {{mailbox.name}} and {{conversation.id}}.">
                {(id) => <Textarea id={id} rows={5} value={form.autoReplyBody} onChange={text('autoReplyBody')} placeholder={'Hi {{customer.firstName}},\n\nThanks for writing in. We got your message and will reply within one business day.'} />}
              </Field>
            )}
          </Section>
        </>
      )}

      {error && <Banner kind="danger">{error}</Banner>}
      <div className="flex justify-end gap-2">
        <Button type="submit" variant="primary" size={compact ? 'lg' : 'md'} loading={save.isPending}>
          {mailbox ? 'Save changes' : 'Add mailbox'}
        </Button>
      </div>
    </form>
  )
}

function LiveChatSection({
  form,
  set,
  chatKey,
  savedEnabled,
  onlineNow,
}: {
  form: FormState
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void
  chatKey: string | null
  savedEnabled: boolean
  onlineNow: boolean
}) {
  const zones = allZones()
  const { appUrl } = useSession()
  const [copied, setCopied] = useState(false)
  const snippet = chatKey ? `<script src="${appUrl}/api/chat/widget.js?key=${chatKey}" async></script>` : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* the snippet stays selectable */
    }
  }
  return (
    <Section
      title="Live chat"
      description="A chat button for your website. Each chat becomes a conversation in this mailbox. You answer it here, and the visitor sees your reply at once. If they left, it goes to them by email."
    >
      <Switch checked={form.chatEnabled} onChange={(v) => set('chatEnabled', v)} label="Turn on live chat for this mailbox" />
      {form.chatEnabled && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" hint="At the top of the chat window.">
              {(id) => <Input id={id} maxLength={60} value={form.chatTitle} onChange={(e) => set('chatTitle', e.target.value)} placeholder="Chat with us" />}
            </Field>
            <Field label="Color" hint="The button and the window's header.">
              {(id) => (
                <div className="flex h-9 items-center gap-1.5">
                  {COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Color ${color}`}
                      aria-pressed={form.chatColor === color}
                      onClick={() => set('chatColor', color)}
                      className={cx('size-6 shrink-0 rounded-full ring-offset-2 ring-offset-surface transition-shadow', form.chatColor === color && 'ring-2 ring-fg')}
                      style={{ background: color }}
                    />
                  ))}
                  <input id={id} type="color" value={form.chatColor} onChange={(e) => set('chatColor', e.target.value)} aria-label="Custom color" className="size-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                </div>
              )}
            </Field>
          </div>
          <Field label="Greeting" hint="The first message a visitor sees. Leave it empty for none.">
            {(id) => <Textarea id={id} rows={2} maxLength={500} value={form.chatGreeting} onChange={(e) => set('chatGreeting', e.target.value)} placeholder="Hi there! Ask us anything. We usually reply within a few minutes." />}
          </Field>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-medium">When the chat is online</p>
              {savedEnabled && (
                <span className={cx('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium', onlineNow ? 'bg-ok-soft text-ok' : 'bg-sunken text-fg-2')}>
                  <span className={cx('size-1.5 rounded-full', onlineNow ? 'bg-ok' : 'bg-fg-3')} aria-hidden />
                  {onlineNow ? 'Online now' : 'Away now'}
                </span>
              )}
            </div>
            <div role="radiogroup" aria-label="When the chat is online" className="flex flex-col gap-2">
              {AVAILABILITY_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={form.chatAvailability === o.id}
                  onClick={() => set('chatAvailability', o.id)}
                  className={cx('flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors', form.chatAvailability === o.id ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-sunken')}
                >
                  <span className={cx('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', form.chatAvailability === o.id ? 'border-accent' : 'border-line-strong')} aria-hidden>
                    {form.chatAvailability === o.id && <span className="size-2 rounded-full bg-accent" />}
                  </span>
                  <span>
                    <span className={cx('block text-[13px] font-medium', form.chatAvailability === o.id && 'text-accent-fg')}>{o.label}</span>
                    <span className="block text-xs text-fg-3">{o.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          {form.chatAvailability === 'hours' && (
            <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
              <div role="group" aria-label="Open days" className="flex flex-wrap gap-1.5">
                {DAYS.map((label, day) => {
                  const on = form.chatDays.includes(day)
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set('chatDays', on ? form.chatDays.filter((d) => d !== day) : [...form.chatDays, day].sort())}
                      className={cx('h-8 min-w-12 rounded-lg border px-2 text-[13px] font-medium transition-colors', on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong text-fg-2 hover:bg-sunken')}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="From">{(id) => <Input id={id} type="time" value={form.chatStart} onChange={(e) => set('chatStart', e.target.value)} />}</Field>
                <Field label="To">{(id) => <Input id={id} type="time" value={form.chatEnd} onChange={(e) => set('chatEnd', e.target.value)} />}</Field>
                <Field label="Time zone">
                  {(id) => (
                    <>
                      <Input id={id} list={`${id}-zones`} value={form.chatTimezone} onChange={(e) => set('chatTimezone', e.target.value)} placeholder="Europe/Berlin" />
                      <datalist id={`${id}-zones`}>
                        {zones.map((zone) => (
                          <option key={zone} value={zone} />
                        ))}
                      </datalist>
                    </>
                  )}
                </Field>
              </div>
              <p className="text-xs text-fg-3">An end time before the start time runs past midnight.</p>
            </div>
          )}
          {form.chatAvailability !== 'always' && (
            <>
              <Field label="Away message" hint="Shown instead of the greeting while the chat is away. Visitors can still write, and you reply by email.">
                {(id) => <Textarea id={id} rows={2} maxLength={500} value={form.chatAwayMessage} onChange={(e) => set('chatAwayMessage', e.target.value)} placeholder="We're away right now. Leave a message and we'll reply by email." />}
              </Field>
              <Switch
                checked={form.chatHideWhenAway}
                onChange={(v) => set('chatHideWhenAway', v)}
                label="Hide the chat button while away"
                description="Visitors who are already in a chat still see it."
              />
            </>
          )}
          <Field label="Websites that can show the chat" hint="One per line, such as https://example.com or https://*.example.com. Leave it empty to allow any website.">
            {(id) => <Textarea id={id} rows={2} value={form.chatOrigins} onChange={(e) => set('chatOrigins', e.target.value)} placeholder="https://example.com" className="font-mono text-[13px]" />}
          </Field>
          <div className="flex flex-col gap-1.5">
            <p className="text-[13px] font-medium">Embed code</p>
            {chatKey && savedEnabled ? (
              <>
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 rounded-lg border border-line-strong bg-sunken px-3 py-2 font-mono text-xs break-all text-fg-2 select-all">{snippet}</code>
                  <Button icon={copied ? <Check /> : <Copy />} onClick={() => void copy()}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p className="text-[13px] text-fg-3">Paste it before the closing &lt;/body&gt; tag on every page that should show the chat button. Open it from your own button with <code className="font-mono text-xs">AnsaChat.open()</code>.</p>
              </>
            ) : (
              <p className="text-[13px] text-fg-3">Save changes to get the code for your website.</p>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

/**
 * A mail password. Once one is saved, there is no empty password box: browsers and password managers fill
 * empty boxes with a saved login, which would be tested and saved as the mail password. "Change" opens one.
 */
function PasswordField({ saved, value, onChange, hint }: { saved: boolean; value: string; onChange: (value: string) => void; hint?: string }) {
  const [changing, setChanging] = useState(false)
  if (saved && !changing && !value) {
    return (
      <Field label="Password" hint="Saved. It is kept unless you change it.">
        {(id) => (
          <div className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-sunken pr-1 pl-3">
            <span id={id} className="min-w-0 flex-1 truncate text-sm text-fg-2">
              Saved password
            </span>
            <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
              Change
            </Button>
          </div>
        )}
      </Field>
    )
  }
  return (
    <Field label="Password" hint={saved ? 'Type the new password. Cancel keeps the saved one.' : hint}>
      {(id) => (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            // Asks browsers and password managers not to fill this with a saved login.
            autoComplete="new-password"
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            autoFocus={changing}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {saved && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange('')
                setChanging(false)
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </Field>
  )
}

function SyncStatus({ mailbox }: { mailbox: Mailbox }) {
  const client = useQueryClient()
  const sync = useMutation({ mutationFn: () => api.post(`/mailboxes/${mailbox.id}/sync`), onSettled: () => void client.invalidateQueries({ queryKey: ['mailboxes'] }) })
  if (!mailbox.imapEnabled) return <Banner kind="warn">This mailbox does not fetch incoming email. Turn on “Fetch incoming email” below to receive conversations.</Banner>
  if (mailbox.syncStatus === 'error') {
    return (
      <Banner kind="danger" action={<Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()} icon={<RefreshCw className="size-3.5" aria-hidden />}>Retry</Button>}>
        <strong>Cannot fetch email.</strong> {mailbox.syncError} {brand()} keeps retrying.
      </Banner>
    )
  }
  if (mailbox.syncStatus === 'ok') {
    return (
      <Banner kind="ok" action={<Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()} icon={<RefreshCw className="size-3.5" aria-hidden />}>Check now</Button>}>
        Receiving email. {mailbox.lastSyncAt ? `Last checked ${ago(mailbox.lastSyncAt).toLowerCase()}.` : ''}
      </Banner>
    )
  }
  return <Banner>Connecting to the mail server…</Banner>
}

export function MailboxesSettings() {
  const { mailboxId } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { toast, confirm } = useFeedback()
  const mailboxes = useMailboxes()
  if (mailboxes.isPending) return <Spinner />
  const list = mailboxes.data ?? []

  if (mailboxId === 'new') {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Add a mailbox" description="Connect a shared address such as support@ or billing@." />
        <MailboxForm onSaved={(m) => navigate(`/settings/mailboxes/${m.id}`)} />
      </div>
    )
  }

  const current = list.find((m) => String(m.id) === mailboxId)
  if (mailboxId && current) {
    const remove = async () => {
      const ok = await confirm({
        title: `Delete ${current.name}?`,
        body: 'Every conversation in this mailbox is deleted with it. Email in your own mail account is not touched. You cannot undo this.',
        confirmLabel: 'Delete mailbox',
        danger: true,
      })
      if (!ok) return
      await api.del(`/mailboxes/${current.id}`)
      await client.invalidateQueries({ queryKey: ['mailboxes'] })
      toast('Mailbox deleted')
      navigate('/settings/mailboxes')
    }
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title={current.name}
          description={
            <>
              <Link to="/settings/mailboxes" className="hover:underline">
                Mailboxes
              </Link>{' '}
              / {current.email}
            </>
          }
        />
        <SyncStatus mailbox={current} />
        <MailboxForm key={current.id} mailbox={current} onSaved={() => {}} />
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h2 className="text-[15px] font-semibold">Delete this mailbox</h2>
            <p className="text-[13px] text-fg-3">Removes the mailbox and all of its conversations from {brand()}.</p>
          </div>
          <Button variant="danger" onClick={() => void remove()}>
            Delete mailbox
          </Button>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Mailboxes"
        description="Each mailbox is a shared email address your team answers together."
        action={
          <Link to="/settings/mailboxes/new">
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />}>
              Add mailbox
            </Button>
          </Link>
        }
      />
      {list.length === 0 ? (
        <Card>
          <EmptyState icon={<Mail />} title="No mailboxes yet" body="Add your support address to start receiving and answering email." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {list.map((m) => (
            <Link key={m.id} to={`/settings/mailboxes/${m.id}`} className="flex items-center gap-3 px-5 py-3.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-sunken">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: m.color }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{m.name}</span>
                <span className="block truncate text-[13px] text-fg-3">{m.email}</span>
              </span>
              <span className={cx('text-[13px]', m.syncStatus === 'error' ? 'text-danger' : m.syncStatus === 'ok' ? 'text-ok' : 'text-fg-3')}>
                {m.syncStatus === 'error' ? 'Connection problem' : !m.imapEnabled ? 'Not receiving' : m.syncStatus === 'ok' ? 'Receiving email' : 'Connecting…'}
              </span>
              <ChevronRight className="size-4 text-fg-3" aria-hidden />
            </Link>
          ))}
        </Card>
      )}
    </div>
  )
}
