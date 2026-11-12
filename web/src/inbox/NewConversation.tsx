import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, StickyNote } from 'lucide-react'
import { api, qs } from '../lib/api'
import { useDebounced, useSession, useUsers } from '../lib/hooks'
import type { Conversation, Customer, Mailbox } from '../lib/types'
import { Banner, Button, Field, Input, Modal, Select, cx } from '../ui'
import { AttachButton, EditorArea, EditorToolbar, UploadList, editorHtml, lineHtml, useFileDrop, useRichEditor, useUploads } from './Editor'

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

  const create = useMutation({
    mutationFn: () =>
      api.post<{ conversation: Conversation }>('/conversations', {
        mailboxId,
        customerEmail: email.trim(),
        customerName: name.trim(),
        subject: subject.trim(),
        bodyHtml: lineHtml(editorHtml(editor)),
        kind,
        status: kind === 'reply' ? 'pending' : 'active',
        attachmentIds: uploads.ids,
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
  const submit = () => {
    if (create.isPending || uploads.busy) return
    setError(null)
    if (!editorHtml(editor)) return setError(kind === 'reply' ? 'Write your message before sending.' : 'Write the note before saving.')
    create.mutate()
  }
  const editor = useRichEditor({ placeholder: kind === 'reply' ? 'Write your message' : 'What happened? For example, notes from a phone call', onSubmit: submit })
  const exact = suggestions.data?.some((c) => c.emails.some((e) => e.toLowerCase() === email.trim().toLowerCase()))

  return (
    <Modal
      open
      onClose={onClose}
      title="New conversation"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={uploads.busy} onClick={submit}>
            {kind === 'reply' ? 'Send email' : 'Save conversation'}
          </Button>
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
                  .filter((u) => !u.disabled)
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
                <Input id={id} type="email" required autoFocus={!prefill.customerEmail} list={`${id}-list`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" />
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
          <Field label="Customer name" hint={exact ? 'Existing customer. Leave blank to keep their name.' : undefined}>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />}
          </Field>
        </div>
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
