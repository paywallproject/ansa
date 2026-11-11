import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark, ChevronDown, Send, StickyNote, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import { useLocalState, useSavedReplies } from '../lib/hooks'
import type { Conversation, Viewer } from '../lib/types'
import { Avatar, Banner, Button, Input, MenuItem, MenuLabel, Popover, cx, useFeedback } from '../ui'
import { AttachButton, EditorArea, EditorToolbar, UploadList, editorHtml, useFileDrop, useRichEditor, useUploads } from './Editor'

export interface ComposerHandle {
  focus: (mode: 'reply' | 'note') => void
}

type SendStatus = 'closed' | 'pending' | 'active'
const SEND_LABEL: Record<SendStatus, string> = { closed: 'Send and close', pending: 'Send as pending', active: 'Send and keep active' }
const AFTER_SENDING: Record<SendStatus, string> = { closed: 'Close the conversation', pending: 'Set to pending', active: 'Keep it active' }
const SEND_DOT: Record<SendStatus, string> = { closed: 'bg-fg-3', pending: 'bg-warn', active: 'bg-ok' }

const splitEmails = (value: string) => value.split(/[,;\s]+/).filter(Boolean)

export function fillSavedReply(html: string, conversation: Pick<Conversation, 'customer' | 'id'>, agentName: string) {
  const first = conversation.customer.name.split(' ')[0] || 'there'
  const vars: Record<string, string> = { 'customer.firstName': first, 'customer.name': conversation.customer.name, 'customer.email': conversation.customer.email, 'agent.name': agentName, 'agent.firstName': agentName.split(' ')[0], 'conversation.id': String(conversation.id) }
  return html.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    conversation: Conversation
    agentName: string
    othersReplying: Viewer[]
    /** The composer is hidden until someone starts a reply or a note. It stays mounted so a draft and the cursor survive. */
    open: boolean
    onOpenChange: (open: boolean) => void
    onTyping: (typing: boolean) => void
    onSent: (status: SendStatus | null) => void
  }
>(function Composer({ conversation, agentName, othersReplying, open, onOpenChange, onTyping, onSent }, ref) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [mode, setMode] = useState<'reply' | 'note'>(conversation.draft?.kind ?? 'reply')
  const [sendStatus, setSendStatus] = useLocalState<SendStatus>('ansa-send-status', 'closed')
  const [showCc, setShowCc] = useState(conversation.cc.length > 0)
  const [showBcc, setShowBcc] = useState(false)
  const [cc, setCc] = useState(conversation.cc.join(', '))
  const [bcc, setBcc] = useState('')
  const uploads = useUploads()
  const savedReplies = useSavedReplies()
  const [filter, setFilter] = useState('')
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const modeRef = useRef(mode)
  modeRef.current = mode

  // An unsent draft reopens the composer when the conversation loads.
  useEffect(() => {
    if (conversation.draft?.bodyHtml) onOpenChange(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const send = useMutation({
    mutationFn: (status: SendStatus) => {
      const bodyHtml = editorHtml(editor)
      clearTimeout(draftTimer.current)
      return mode === 'reply'
        ? api.post<{ conversation: Conversation }>(`/conversations/${conversation.id}/reply`, { bodyHtml, status, cc: showCc ? splitEmails(cc) : [], bcc: showBcc ? splitEmails(bcc) : [], attachmentIds: uploads.ids })
        : api.post<{ conversation: Conversation }>(`/conversations/${conversation.id}/note`, { bodyHtml, attachmentIds: uploads.ids })
    },
    onSuccess: (data, status) => {
      client.setQueryData(['conversation', conversation.id], (old: any) => (old ? { ...old, conversation: data.conversation } : old))
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      editor?.commands.clearContent()
      uploads.clear()
      onTyping(false)
      toast(mode === 'reply' ? 'Reply sent' : 'Note added')
      onSent(mode === 'reply' ? status : null)
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })

  const submit = () => {
    if (send.isPending || uploads.busy) return
    if (!editorHtml(editor) && uploads.ids.length === 0) return
    send.mutate(sendStatus)
  }
  const submitRef = useRef(submit)
  submitRef.current = submit

  const customerName = conversation.customer.name || conversation.customer.email
  const editor = useRichEditor({
    content: conversation.draft?.bodyHtml ?? '',
    placeholder: mode === 'reply' ? `Reply to ${customerName}` : 'Write a note for your team. The customer will not see it',
    onSubmit: () => submitRef.current(),
    onChange: (html) => {
      onTyping(!!html && modeRef.current === 'reply')
      clearTimeout(draftTimer.current)
      draftTimer.current = setTimeout(() => {
        void api.put(`/conversations/${conversation.id}/draft`, { kind: modeRef.current, bodyHtml: html }).catch(() => {})
      }, 700)
    },
  })
  useEffect(() => () => clearTimeout(draftTimer.current), [])

  useImperativeHandle(ref, () => ({
    focus: (next) => {
      setMode(next)
      // Focus now, not on the next frame: keys typed right after the shortcut must land in the editor.
      // (TipTap's own focus command waits for an animation frame, so focus the DOM node first.)
      editor?.view.dom.focus()
      editor?.commands.focus('end')
    },
  }))

  const discard = () => {
    clearTimeout(draftTimer.current)
    editor?.commands.clearContent()
    uploads.clear()
    onTyping(false)
    void api.put(`/conversations/${conversation.id}/draft`, { kind: mode, bodyHtml: '' }).catch(() => {})
    onOpenChange(false)
  }

  const drop = useFileDrop(uploads.add)
  const isNote = mode === 'note'
  const matching = (savedReplies.data ?? []).filter((r) => (!r.mailboxId || r.mailboxId === conversation.mailboxId) && r.name.toLowerCase().includes(filter.toLowerCase()))
  const rowButton = 'h-7 rounded-md px-2 text-[13px] font-medium text-fg-3 transition-colors hover:bg-sunken hover:text-fg'
  const tool = 'flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10'

  const addressRow = (label: 'Cc' | 'Bcc', value: string, onChange: (value: string) => void, onRemove: () => void) => (
    <div className="flex min-h-10 items-center gap-2 py-1.5">
      <label htmlFor={`composer-${label}`} className="w-8 shrink-0 text-[13px] text-fg-3">
        {label}
      </label>
      <input
        id={`composer-${label}`}
        autoFocus={!value}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="name@example.com, another@example.com"
        className="h-6 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-3/70"
      />
      <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-sunken hover:text-fg">
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )

  return (
    <div className={cx('shrink-0 px-4 pb-5 md:px-6', !open && 'hidden')}>
      <div className="mx-auto max-w-[800px] md:px-14">
        {othersReplying.length > 0 && !isNote && (
          <div className="mb-2">
            <Banner kind="warn">
              {othersReplying.map((v) => v.name).join(' and ')} {othersReplying.length === 1 ? 'is' : 'are'} writing a reply right now.
            </Banner>
          </div>
        )}
        <div
          {...drop.handlers}
          className={cx(
            'rounded-xl border shadow-[0_1px_2px_rgba(24,24,29,0.06)] transition-colors',
            isNote ? 'border-note-line bg-note' : 'border-line-strong bg-surface focus-within:border-accent',
            drop.over && 'border-accent ring-3 ring-accent/20',
          )}
        >
          {!isNote && (
            <div className="divide-y divide-line px-3">
              <div className="flex min-h-10 items-center gap-2 py-1.5">
                <span className="w-8 shrink-0 text-[13px] text-fg-3">To</span>
                <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-sunken pr-2 pl-0.5 text-[13px]">
                  <Avatar name={customerName} color="#6fa3e8" size={20} />
                  <span className="truncate font-medium">{customerName}</span>
                  {conversation.customer.name && <span className="hidden truncate text-fg-3 sm:inline">{conversation.customer.email}</span>}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  {!showCc && (
                    <button type="button" className={rowButton} onClick={() => setShowCc(true)}>
                      Cc
                    </button>
                  )}
                  {!showBcc && (
                    <button type="button" className={rowButton} onClick={() => setShowBcc(true)}>
                      Bcc
                    </button>
                  )}
                </div>
              </div>
              {showCc && addressRow('Cc', cc, setCc, () => setShowCc(false))}
              {showBcc && addressRow('Bcc', bcc, setBcc, () => setShowBcc(false))}
            </div>
          )}

          <EditorArea editor={editor} className={cx('max-h-[38vh] min-h-[78px] px-3 pt-3 pb-1', !isNote && 'border-t border-line')} />

          {uploads.uploads.length > 0 && (
            <div className="px-3 pb-2">
              <UploadList uploads={uploads.uploads} onRemove={uploads.remove} />
            </div>
          )}

          <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
            <EditorToolbar editor={editor}>
              <span className="mx-1.5 h-4 w-px bg-line" aria-hidden />
              <AttachButton onFiles={uploads.add} />
              <Popover
                side="top"
                width={300}
                onOpenChange={(isOpen) => isOpen && setFilter('')}
                trigger={({ ref: triggerRef, ...props }) => (
                  <button ref={triggerRef} type="button" {...props} aria-label="Insert a saved reply" className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10">
                    <Bookmark className="size-4" aria-hidden />
                    <span className="hidden md:inline">Saved replies</span>
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <div className="p-1">
                      <Input autoFocus className="h-8" aria-label="Find a saved reply" placeholder="Find a saved reply" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    </div>
                    {matching.length === 0 ? (
                      <p className="px-3 py-4 text-center text-[13px] text-fg-3">
                        {savedReplies.data?.length ? 'No saved reply matches.' : 'No saved replies yet. Add them in Settings → Saved replies.'}
                      </p>
                    ) : (
                      matching.map((reply) => (
                        <MenuItem
                          key={reply.id}
                          onSelect={() => {
                            editor?.chain().focus().insertContent(fillSavedReply(reply.bodyHtml, conversation, agentName)).run()
                            close()
                          }}
                        >
                          {reply.name}
                        </MenuItem>
                      ))
                    )}
                  </>
                )}
              </Popover>
            </EditorToolbar>

            <button type="button" aria-label="Discard draft" title="Discard draft" onClick={discard} className={cx(tool, 'ml-auto')}>
              <Trash2 className="size-4" aria-hidden />
            </button>
            {isNote ? (
              <Button variant="primary" loading={send.isPending} disabled={uploads.busy} onClick={submit} className="ml-1.5" icon={<StickyNote className="size-3.5" aria-hidden />}>
                Add note
              </Button>
            ) : (
              <div className="ml-1.5 flex">
                <Button variant="primary" loading={send.isPending} disabled={uploads.busy} onClick={submit} className="rounded-r-none" icon={<Send className="size-3.5" aria-hidden />}>
                  <span className="sm:hidden">Send</span>
                  <span className="hidden sm:inline">{SEND_LABEL[sendStatus]}</span>
                </Button>
                <Popover
                  align="end"
                  side="top"
                  width={240}
                  trigger={({ ref: triggerRef, ...props }) => (
                    <Button ref={triggerRef} {...props} variant="primary" aria-label="Choose what happens after sending" className="rounded-l-none border-l border-white/25 px-2">
                      <ChevronDown className="size-3.5" />
                    </Button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuLabel>After sending</MenuLabel>
                      {(Object.keys(SEND_LABEL) as SendStatus[]).map((status) => (
                        <MenuItem
                          key={status}
                          icon={<span className={cx('size-2 shrink-0 rounded-full', SEND_DOT[status])} aria-hidden />}
                          checked={sendStatus === status}
                          onSelect={() => {
                            setSendStatus(status)
                            close()
                          }}
                        >
                          {AFTER_SENDING[status]}
                        </MenuItem>
                      ))}
                    </>
                  )}
                </Popover>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
