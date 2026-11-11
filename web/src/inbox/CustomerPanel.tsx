import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Building2, Copy, Lock, Mail, MapPin, Pencil, Phone, RefreshCw, SquarePen } from 'lucide-react'
import { api } from '../lib/api'
import { ago, dateOnly, STATUS_LABEL } from '../lib/format'
import type { Conversation, Customer } from '../lib/types'
import { Avatar, Banner, Button, Field, IconButton, Input, Modal, useFeedback } from '../ui'
import { useShell } from '../Shell'

const DOT: Record<string, string> = { active: 'bg-ok', pending: 'bg-warn', closed: 'bg-fg-3', spam: 'bg-danger' }
const StatusDot = ({ status, className }: { status: string; className?: string }) => <span className={`size-2 shrink-0 rounded-full ${DOT[status] ?? 'bg-fg-3'} ${className ?? ''}`} aria-hidden />

interface AppPanel {
  id: number
  name: string
  html: string
  error: string | null
}

/** Content from the team's apps (Settings → Apps). The server has already cleaned the HTML. */
function AppPanels({ conversationId, customerId }: { conversationId: number; customerId: number }) {
  const apps = useQuery({
    queryKey: ['conversation-apps', conversationId, customerId],
    queryFn: () => api.get<{ apps: AppPanel[] }>(`/conversations/${conversationId}/apps`).then((r) => r.apps),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  if (!apps.data?.length) return null
  return (
    <>
      {apps.data.map((app) => (
        <section key={app.id} aria-label={app.name} className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex h-5 items-center justify-between">
            <h3 className="font-semibold">{app.name}</h3>
            <IconButton label={`Reload ${app.name}`} size="sm" className="size-6" onClick={() => void apps.refetch()} disabled={apps.isFetching}>
              <RefreshCw className={apps.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </IconButton>
          </div>
          {app.error ? (
            <p className="text-[13px] text-danger">{app.error}</p>
          ) : app.html ? (
            <div className="prose-mail text-[13px]" dangerouslySetInnerHTML={{ __html: app.html }} />
          ) : (
            <p className="text-[13px] text-fg-3">Nothing to show.</p>
          )}
        </section>
      ))}
    </>
  )
}

export function CustomerPanel({ conversation }: { conversation: Conversation }) {
  const customer = conversation.customer
  const shell = useShell()
  const { toast } = useFeedback()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [notes, setNotes] = useState(customer.notes)
  useEffect(() => setNotes(customer.notes), [customer.id, customer.notes])

  const save = useMutation({
    mutationFn: (patch: Partial<Customer>) => api.patch<{ customer: Customer }>(`/customers/${customer.id}`, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['conversation'] })
      void client.invalidateQueries({ queryKey: ['customers'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast('Copied'))
  }
  const details: [ReactNode, string][] = [
    [<Building2 key="c" />, customer.company],
    [<Briefcase key="t" />, customer.title],
    [<Phone key="p" />, customer.phone],
    [<MapPin key="l" />, customer.location],
  ]
  const filled = details.filter(([, value]) => value)

  const displayName = customer.name || customer.email
  const firstName = customer.name.split(' ')[0] || 'them'
  const iconButton = 'flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-sunken hover:text-fg'

  return (
    <div className="flex flex-col gap-2 p-2 text-[13px]">
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <Avatar name={displayName} color="#6fa3e8" size={44} />
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="text-[15px] leading-5 font-semibold [overflow-wrap:anywhere]">
              <Link to={`/customers/${customer.id}`} className="hover:underline">
                {displayName}
              </Link>
            </h2>
            <p className="mt-0.5 text-xs whitespace-nowrap text-fg-3">Customer since {dateOnly(customer.createdAt)}</p>
          </div>
          <button type="button" aria-label="Edit customer" onClick={() => setEditing(true)} className={`${iconButton} -mr-1.5`}>
            <Pencil className="size-3.5" aria-hidden />
          </button>
        </div>

        <dl className="mt-4 flex flex-col gap-0.5">
          {customer.emails.map((email) => (
            <div key={email} className="flex h-8 items-center gap-2.5">
              <dt className="flex w-4 shrink-0 justify-center text-fg-3">
                <Mail className="size-3.5" aria-label="Email" />
              </dt>
              <dd className="min-w-0 flex-1 truncate">
                <a href={`mailto:${email}`} className="text-accent-fg hover:underline">
                  {email}
                </a>
              </dd>
              <button type="button" aria-label={`Copy ${email}`} onClick={() => copy(email)} className={`${iconButton} -mr-1.5`}>
                <Copy className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
          {filled.map(([icon, value]) => (
            <div key={value} className="flex h-8 items-center gap-2.5">
              <dt className="flex w-4 shrink-0 justify-center text-fg-3 [&>svg]:size-3.5">{icon}</dt>
              <dd className="min-w-0 flex-1 truncate text-fg-2">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex h-5 items-center">
          <h3 className="font-semibold">
            <label htmlFor="customer-notes">Notes</label>
          </h3>
          <span className="ml-auto flex items-center gap-1 text-xs text-fg-3">
            <Lock className="size-3" aria-hidden />
            Team only
          </span>
        </div>
        <textarea
          id="customer-notes"
          aria-label="Notes about this customer"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== customer.notes && save.mutate({ notes })}
          placeholder="Plan, preferences, account details"
          className="mt-2.5 block w-full resize-y rounded-lg border border-transparent bg-sunken px-3 py-2 outline-none placeholder:text-fg-3 focus:border-accent focus:bg-surface"
        />
      </section>

      <AppPanels conversationId={conversation.id} customerId={customer.id} />

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex h-5 items-center">
          <h3 className="font-semibold">Conversations</h3>
          <span className="ml-1.5 text-fg-3 tabular-nums">{conversation.previousConversations.length + 1}</span>
        </div>
        <ul className="-mx-2 mt-2.5 flex flex-col gap-0.5">
          <li>
            <div className="flex items-start gap-2.5 rounded-lg bg-accent-soft px-2 py-2" aria-current="true">
              <StatusDot status={conversation.status} className="mt-1.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate font-medium">{conversation.subject}</span>
                  <span className="shrink-0 text-fg-3 tabular-nums">#{conversation.id}</span>
                </span>
                <span className="block text-xs text-fg-3">
                  {STATUS_LABEL[conversation.status]} · {ago(conversation.updatedAt)} · Viewing now
                </span>
              </span>
            </div>
          </li>
          {conversation.previousConversations.map((c) => (
            <li key={c.id}>
              <Link to={`/c/${c.id}`} className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-sunken">
                <StatusDot status={c.status} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate font-medium">{c.subject}</span>
                    <span className="shrink-0 text-fg-3 tabular-nums">#{c.id}</span>
                  </span>
                  <span className="block text-xs text-fg-3">
                    {STATUS_LABEL[c.status]} · {ago(c.updatedAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {conversation.previousConversations.length === 0 && <p className="mt-3 text-fg-3">This is their first conversation.</p>}
        <button
          type="button"
          onClick={() => shell.compose({ customerEmail: customer.email, customerName: customer.name, mailboxId: conversation.mailboxId })}
          className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line font-medium text-fg-2 transition-colors hover:bg-sunken"
        >
          <SquarePen className="size-3.5" aria-hidden />
          <span className="truncate">New conversation with {firstName}</span>
        </button>
      </section>

      {editing && <CustomerForm customer={customer} onClose={() => setEditing(false)} />}
    </div>
  )
}

export function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved?: (customer: Customer) => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [form, setForm] = useState({
    name: customer?.name ?? '',
    emails: customer?.emails.join(', ') ?? '',
    company: customer?.company ?? '',
    title: customer?.title ?? '',
    phone: customer?.phone ?? '',
    location: customer?.location ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  const save = useMutation({
    mutationFn: () => {
      const emails = form.emails.split(/[,;\s]+/).filter(Boolean)
      const payload = { ...form, emails }
      return customer ? api.patch<{ customer: Customer }>(`/customers/${customer.id}`, payload) : api.post<{ customer: Customer }>('/customers', { ...payload, email: emails[0] ?? '' })
    },
    onSuccess: (data) => {
      void client.invalidateQueries({ queryKey: ['conversation'] })
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['customers'] })
      toast(customer ? 'Customer saved' : 'Customer added')
      onSaved?.(data.customer)
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={customer ? 'Edit customer' : 'Add a customer'}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {customer ? 'Save changes' : 'Add customer'}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        {error && (
          <div className="sm:col-span-2">
            <Banner kind="danger">{error}</Banner>
          </div>
        )}
        <Field label="Name">{(id) => <Input id={id} autoFocus value={form.name} onChange={set('name')} />}</Field>
        <Field label="Email" hint="Separate several addresses with commas.">
          {(id) => <Input id={id} value={form.emails} onChange={set('emails')} placeholder="jane@example.com" />}
        </Field>
        <Field label="Company">{(id) => <Input id={id} value={form.company} onChange={set('company')} />}</Field>
        <Field label="Job title">{(id) => <Input id={id} value={form.title} onChange={set('title')} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={form.phone} onChange={set('phone')} />}</Field>
        <Field label="Location">{(id) => <Input id={id} value={form.location} onChange={set('location')} />}</Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
