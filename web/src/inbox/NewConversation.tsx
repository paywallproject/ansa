import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Mail, StickyNote, X } from 'lucide-react'
import { SendLaterDialog } from './SendLater'
import { api, qs } from '../lib/api'
import { canSee } from '../lib/access'
import { useDebounced, useSession, useUsers } from '../lib/hooks'
import type { Conversation, Customer, Mailbox } from '../lib/types'
import { Banner, Button, Field, Input, Modal, Select, cx } from '../ui'
import { AttachButton, EditorArea, EditorToolbar, UploadList, editorHtml, lineHtml, useFileDrop, useRichEditor, useUploads } from './Editor'

const splitEmails = (value: string) => value.split(/[,;\s]+/).filter(Boolean)

export interface ComposePrefill {
  mailboxId?: number
  customerEmail?: string
  customerName?: string
}

export function NewConversation({ prefill, mailboxes, onClose }: { prefill: ComposePrefill; mailboxes: Mailbox[]; onClose: () => void }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [kind, setKind] = useState<'reply' | 'note'>('reply')
  const [mailboxId, setMailboxId] = useState(prefill.mailboxId ?? mailboxes[0]?.id ?? 0)
  const [email, setEmail] = useState(prefill.customerEmail ?? '')
  const [name, setName] = useState(prefill.customerName ?? '')
  const [subject, setSubject] = useState('')
  // Cc and Bcc, for an email only: a logged call or chat sends nothing.
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const sendsCc = kind === 'reply' && showCc
  const sendsBcc = kind === 'reply' && showBcc
  const [error, setError] = useState<string | null>(null)
  const uploads = useUploads()
  const drop = useFileDrop(uploads.add)
  const term = useDebounced(email.trim(), 200)
  const suggestions = useQuery({
    queryKey: ['customers', 'suggest', term],
    queryFn: () => api.get<{ items: Customer[] }>(`/customers${qs({ q: term, limit: 5 })}`).then((r) => r.items),
    enabled: term.length > 1 && !prefill.customerEmail,
  })
  const mailbox = mailboxes.find((m) => m.id === mailboxId)
  const { user: me } = useSession()
  const users = useUsers()
  // With the mailbox set to "choose when sending", pick the assignee here. It starts on you.
  const chooseAssignee = kind === 'reply' && mailbox?.assignAfterReply === 'choose'
  const [assigneeId, setAssigneeId] = useState<number | null>(me.id)

  const [later, setLater] = useState(false)
  const create = useMutation({
    mutationFn: (sendAt?: number) =>
      api.post<{ conversation: Conversation }>('/conversations', {
        ...(sendAt ? { sendAt } : {}),
        mailboxId,
        customerEmail: email.trim(),
        customerName: name.trim(),
        subject: subject.trim(),
        bodyHtml: lineHtml(editorHtml(editor)),
        kind,
        // Sent: nothing more to do until the customer answers, which reopens it.
        status: kind === 'reply' ? 'closed' : 'active',
        attachmentIds: uploads.ids,
        cc: sendsCc ? splitEmails(cc) : [],
        bcc: sendsBcc ? splitEmails(bcc) : [],
        ...(chooseAssignee ? { assigneeId } : {}),
      }),
    onSuccess: ({ conversation }) => {
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      onClose()
      navigate(`/c/${conversation.id}`)
    },
    onError: (err: Error) => setError(err.message),
  })
  /** Check what can be checked here, so Send later does not open for an email that cannot go out. */
  const ready = () => {
    if (create.isPending || uploads.busy) return false
    setError(null)
    if (!editorHtml(editor)) {
      setError(kind === 'reply' ? 'Write your message before sending.' : 'Write the note before saving.')
      return false
    }
    const wrong = [...(sendsCc ? splitEmails(cc) : []), ...(sendsBcc ? splitEmails(bcc) : [])].find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    if (wrong) {
      setError(`"${wrong}" is not an email address.`)
      return false
    }
    if (!subject.trim()) {
      setError('Add a subject.')
      return false
    }
    return true
  }
  const submit = () => {
    if (ready()) create.mutate(undefined)
  }
  const editor = useRichEditor({ placeholder: kind === 'reply' ? 'Write your message' : 'What happened? For example, notes from a phone call', onSubmit: submit })
  const existing = suggestions.data?.find((c) => c.emails.some((e) => e.toLowerCase() === email.trim().toLowerCase()))
  const addressButton = 'h-7 rounded-md px-1.5 text-[13px] font-medium text-fg-3 transition-colors hover:bg-sunken hover:text-fg'
  const addressRow = (label: 'Cc' | 'Bcc', value: string, onChange: (value: string) => void, onRemove: () => void) => (
    <Field label={label}>
      {(id) => (
        <div className="relative">
          <Input id={id} autoFocus={!value} value={value} onChange={(e) => onChange(e.target.value)} placeholder="name@example.com, another@example.com" className="pr-10" />
          <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-sunken hover:text-fg">
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </Field>
  )

  return (
    <Modal
      open
      onClose={onClose}
      title="New conversation"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {kind === 'reply' && (
            <Button icon={<Clock />} disabled={create.isPending || uploads.busy} onClick={() => ready() && setLater(true)}>
              Send later
            </Button>
          )}
          <Button variant="primary" loading={create.isPending} disabled={uploads.busy} onClick={submit}>
            {kind === 'reply' ? 'Send email' : 'Save conversation'}
          </Button>
          <SendLaterDialog
            open={later}
            condition={false}
            onClose={() => setLater(false)}
            onPick={(sendAt) => {
              setLater(false)
              create.mutate(sendAt)
            }}
          />
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {error && <Banner kind="danger">{error}</Banner>}
        <div role="radiogroup" aria-label="Conversation type" className="grid grid-cols-2 gap-2">
          {(
            [
              ['reply', 'Email a customer', 'Sends from the mailbox', Mail],
              ['note', 'Log a conversation', 'A call or chat. Nothing is sent', StickyNote],
            ] as const
          ).map(([id, title, hint, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={kind === id}
              onClick={() => setKind(id)}
              className={cx('flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors', kind === id ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-sunken')}
            >
              <Icon className={cx('size-4 shrink-0', kind === id ? 'text-accent-fg' : 'text-fg-3')} aria-hidden />
              <span>
                <span className={cx('block text-[13px] font-medium', kind === id && 'text-accent-fg')}>{title}</span>
                <span className="block text-xs text-fg-3">{hint}</span>
              </span>
            </button>
          ))}
        </div>
        {kind === 'reply' && mailbox && !mailbox.smtpConfigured && (
          <Banner kind="warn">{mailbox.name} has no SMTP server yet, so this email will fail to send. Add one in Settings → Mailboxes.</Banner>
        )}
        {chooseAssignee && (
          <Field label="Assign to">
            {(id) => (
              <Select id={id} value={assigneeId ?? ''} onChange={(e) => setAssigneeId(e.target.value ? Number(e.target.value) : null)}>
                {(users.data ?? [])
                  .filter((u) => !u.disabled && canSee(u, mailboxId))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.id === me.id ? `${u.name} (you)` : u.name}
                    </option>
                  ))}
                <option value="">Unassigned</option>
              </Select>
            )}
          </Field>
        )}
        {mailboxes.length > 1 && (
          <Field label="Mailbox">
            {(id) => (
              <Select id={id} value={mailboxId} onChange={(e) => setMailboxId(Number(e.target.value))}>
                {mailboxes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.email})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer email">
            {(id) => (
              <>
                <div className="relative">
                  <Input
                    id={id}
                    type="email"
                    required
                    autoFocus={!prefill.customerEmail}
                    list={`${id}-list`}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@example.com"
                    className={kind === 'reply' && !(showCc && showBcc) ? 'pr-20' : undefined}
                  />
                  {/* Cc and Bcc sit inside the address, as in Gmail, and open a row each. */}
                  {kind === 'reply' && (
                    <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
                      {!showCc && (
                        <button type="button" className={addressButton} onClick={() => setShowCc(true)}>
                          Cc
                        </button>
                      )}
                      {!showBcc && (
                        <button type="button" className={addressButton} onClick={() => setShowBcc(true)}>
                          Bcc
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <datalist id={`${id}-list`}>
                  {suggestions.data?.map((c) => (
                    <option key={c.id} value={c.email}>
                      {c.name}
                    </option>
                  ))}
                </datalist>
              </>
            )}
          </Field>
          {/* An existing customer's name shows as the placeholder, not as a line under the box, so the two boxes
              stay level and nothing below jumps when the address matches someone. */}
          <Field label="Customer name">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={existing ? `${existing.name || 'Existing customer'} (leave blank to keep)` : 'Optional'}
                title={existing ? 'Existing customer. Leave blank to keep their name.' : undefined}
              />
            )}
          </Field>
        </div>
        {sendsCc &&
          addressRow('Cc', cc, setCc, () => {
            setShowCc(false)
            setCc('')
          })}
        {sendsBcc &&
          addressRow('Bcc', bcc, setBcc, () => {
            setShowBcc(false)
            setBcc('')
          })}
        <Field label="Subject">{(id) => <Input id={id} required autoFocus={!!prefill.customerEmail} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <div {...drop.handlers} className={cx('rounded-lg border border-line-strong focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20', drop.over && 'border-accent ring-3 ring-accent/20')}>
          <EditorArea editor={editor} className="max-h-64 min-h-32 px-3 py-2.5" />
          {uploads.uploads.length > 0 && (
            <div className="px-3 pb-2">
              <UploadList uploads={uploads.uploads} onRemove={uploads.remove} />
            </div>
          )}
          <div className="border-t border-line px-2 py-1.5">
            <EditorToolbar editor={editor}>
              <span className="mx-1 h-4 w-px bg-line" aria-hidden />
              <AttachButton onFiles={uploads.add} />
            </EditorToolbar>
          </div>
        </div>
      </form>
    </Modal>
  )
}
