import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Building2, Copy, MapPin, Pencil, Phone, RefreshCw, SquarePen } from 'lucide-react'
import { api } from '../lib/api'
import { ago, dateOnly } from '../lib/format'
import type { Conversation, Customer } from '../lib/types'
import { Avatar, Banner, Button, Field, IconButton, Input, Modal, StatusBadge, Textarea, useFeedback } from '../ui'
import { useShell } from '../Shell'

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
        <section key={app.id} aria-label={app.name}>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-medium text-fg-3">{app.name}</h3>
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

  return (
    <div className="flex flex-col gap-5 p-5">
      <section>
        <div className="flex items-start gap-3">
          <Avatar name={customer.name || customer.email} size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold">
              <Link to={`/customers/${customer.id}`} className="hover:underline">
                {customer.name || customer.email}
              </Link>
            </h2>
            <p className="text-xs text-fg-3">Customer since {dateOnly(customer.createdAt)}</p>
          </div>
          <IconButton label="Edit customer" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </IconButton>
        </div>
        <ul className="mt-3 flex flex-col gap-0.5">
          {customer.emails.map((email) => (
            <li key={email} className="group flex h-7 items-center gap-1 text-[13px]">
              <a href={`mailto:${email}`} className="min-w-0 truncate text-accent-fg hover:underline">
                {email}
              </a>
              <IconButton label={`Copy ${email}`} size="sm" className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => copy(email)}>
                <Copy className="size-3" />
              </IconButton>
            </li>
          ))}
        </ul>
        {filled.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {filled.map(([icon, value]) => (
              <li key={value} className="flex items-center gap-2 text-[13px] text-fg-2 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg-3">
                {icon}
                <span className="truncate">{value}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <label htmlFor="customer-notes" className="mb-1.5 block text-xs font-medium text-fg-3">
          Notes about this customer
        </label>
        <Textarea
          id="customer-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== customer.notes && save.mutate({ notes })}
          placeholder="Plan, preferences, account details"
          className="min-h-16 text-[13px]"
          rows={3}
        />
      </section>

      <AppPanels conversationId={conversation.id} customerId={customer.id} />

      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-xs font-medium text-fg-3">
            Other conversations
          </h3>
          <IconButton label={`New conversation with ${customer.name || customer.email}`} size="sm" className="size-6" onClick={() => shell.compose({ customerEmail: customer.email, customerName: customer.name, mailboxId: conversation.mailboxId })}>
            <SquarePen className="size-3.5" />
          </IconButton>
        </div>
        {conversation.previousConversations.length === 0 ? (
          <p className="text-[13px] text-fg-3">This is their first conversation.</p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {conversation.previousConversations.map((c) => (
              <li key={c.id}>
                <Link to={`/c/${c.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{c.subject}</span>
                    <span className="block text-xs text-fg-3">{ago(c.updatedAt)}</span>
                  </span>
                  <StatusBadge status={c.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
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
