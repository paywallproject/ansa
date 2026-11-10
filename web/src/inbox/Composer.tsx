import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BookmarkPlus, ChevronDown, CornerUpLeft, Send, StickyNote } from 'lucide-react'
import { api } from '../lib/api'
import { useLocalState, useSavedReplies } from '../lib/hooks'
import type { Conversation, Viewer } from '../lib/types'
import { Banner, Button, IconButton, Input, MenuItem, Popover, cx, useFeedback } from '../ui'
import { AttachButton, EditorArea, EditorToolbar, UploadList, editorHtml, useFileDrop, useRichEditor, useUploads } from './Editor'

export interface ComposerHandle {
  focus: (mode: 'reply' | 'note') => void
}

type SendStatus = 'closed' | 'pending' | 'active'
const SEND_LABEL: Record<SendStatus, string> = { closed: 'Send and close', pending: 'Send as pending', active: 'Send and keep active' }
const SEND_HINT: Record<SendStatus, string> = { closed: 'Done unless they write back', pending: 'Waiting on the customer', active: 'Still needs work from us' }

const splitEmails = (value: string) => value.split(/[,;\s]+/).filter(Boolean)

export function fillSavedReply(html: string, conversation: Pick<Conversation, 'customer' | 'id'>, agentName: string) {
  const first = conversation.customer.name.split(' ')[0] || 'there'
  const vars: Record<string, string> = { 'customer.firstName': first, 'customer.name': conversation.customer.name, 'customer.email': conversation.customer.email, 'agent.name': agentName, 'agent.firstName': agentName.split(' ')[0], 'conversation.id': String(conversation.id) }
  return html.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
}

export const Composer = forwardRef<
  ComposerHandle,
  { conversation: Conversation; agentName: string; othersReplying: Viewer[]; onTyping: (typing: boolean) => void; onSent: (status: SendStatus | null) => void }
>(function Composer({ conversation, agentName, othersReplying, onTyping, onSent }, ref) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [mode, setMode] = useState<'reply' | 'note'>(conversation.draft?.kind ?? 'reply')
  const [sendStatus, setSendStatus] = useLocalState<SendStatus>('ansa-send-status', 'closed')
  const [showCc, setShowCc] = useState(conversation.cc.length > 0)
  const [cc, setCc] = useState(conversation.cc.join(', '))
  const [bcc, setBcc] = useState('')
  const uploads = useUploads()
  const savedReplies = useSavedReplies()
  const [filter, setFilter] = useState('')
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const send = useMutation({
    mutationFn: (status: SendStatus) => {
      const bodyHtml = editorHtml(editor)
      clearTimeout(draftTimer.current)
      return mode === 'reply'
        ? api.post<{ conversation: Conversation }>(`/conversations/${conversation.id}/reply`, { bodyHtml, status, cc: splitEmails(cc), bcc: splitEmails(bcc), attachmentIds: uploads.ids })
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

  const editor = useRichEditor({
    content: conversation.draft?.bodyHtml ?? '',
    placeholder: mode === 'reply' ? `Reply to ${conversation.customer.name || conversation.customer.email}` : 'Write a note for your team',
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

  const drop = useFileDrop(uploads.add)
  const isNote = mode === 'note'
  const matching = (savedReplies.data ?? []).filter((r) => (!r.mailboxId || r.mailboxId === conversation.mailboxId) && r.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="shrink-0 px-4 pb-4 md:px-6">
      <div className="mx-auto max-w-3xl">
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
          'rounded-xl border shadow-card transition-colors focus-within:ring-3',
          isNote ? 'border-note-line bg-note focus-within:ring-note-line/60' : 'border-line-strong bg-surface focus-within:border-accent focus-within:ring-accent/15',
          drop.over && 'border-accent ring-3 ring-accent/20',
        )}
      >
        <div className="flex items-center gap-1 px-2 pt-2">
          <div role="tablist" aria-label="Message type" className="flex gap-0.5">
            {(
              [
                ['reply', 'Reply', CornerUpLeft],
                ['note', 'Note', StickyNote],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mode === id}
                onClick={() => {
                  setMode(id)
                  editor?.commands.focus()
                }}
                className={cx(
                  'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
                  mode === id ? (id === 'note' ? 'bg-note-line/60 text-note-fg' : 'bg-accent-soft text-accent-fg') : 'text-fg-3 hover:text-fg',
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          {!isNote && (
            <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 text-[13px] text-fg-3">
              <span className="truncate">
                To <span className="text-fg-2">{conversation.customer.email}</span>
              </span>
              {!showCc && (
                <button type="button" className="shrink-0 font-medium hover:text-fg" onClick={() => setShowCc(true)}>
                  Cc/Bcc
                </button>
              )}
            </div>
          )}
          {isNote && <span className="ml-2 text-[13px] text-note-fg">Only your team sees notes</span>}
        </div>

        {showCc && !isNote && (
          <div className="mt-2 grid gap-2 px-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-[13px] text-fg-3">
              Cc
              <Input className="h-7 text-[13px]" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="name@example.com" />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-fg-3">
              Bcc
              <Input className="h-7 text-[13px]" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="name@example.com" />
            </label>
          </div>
        )}

        <EditorArea editor={editor} className="max-h-[38vh] min-h-20 px-3 py-2.5" />

        {uploads.uploads.length > 0 && (
          <div className="px-3 pb-2">
            <UploadList uploads={uploads.uploads} onRemove={uploads.remove} />
          </div>
        )}

        <div className="flex items-center gap-1 px-2 pb-2">
          <EditorToolbar editor={editor}>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            <AttachButton onFiles={uploads.add} />
            <Popover
              side="top"
              width={300}
              onOpenChange={(open) => open && setFilter('')}
              trigger={({ ref: triggerRef, ...props }) => (
                <IconButton ref={triggerRef} {...props} label="Insert a saved reply" size="sm">
                  <BookmarkPlus className="size-4" />
                </IconButton>
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
          <div className="flex-1" />
          {isNote ? (
            <Button variant="primary" loading={send.isPending} disabled={uploads.busy} onClick={submit} icon={<StickyNote className="size-3.5" aria-hidden />}>
              Add note
            </Button>
          ) : (
            <div className="flex">
              <Button variant="primary" loading={send.isPending} disabled={uploads.busy} onClick={submit} className="rounded-r-none" icon={<Send className="size-3.5" aria-hidden />}>
                <span className="sm:hidden">Send</span>
                <span className="hidden sm:inline">{SEND_LABEL[sendStatus]}</span>
              </Button>
              <Popover
                align="end"
                side="top"
                width={260}
                trigger={({ ref: triggerRef, ...props }) => (
                  <Button ref={triggerRef} {...props} variant="primary" aria-label="Choose what happens after sending" className="rounded-l-none border-l border-white/25 px-1.5">
                    <ChevronDown className="size-3.5" />
                  </Button>
                )}
              >
                {(close) =>
                  (Object.keys(SEND_LABEL) as SendStatus[]).map((status) => (
                    <button
                      key={status}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sendStatus === status}
                      onClick={() => {
                        setSendStatus(status)
                        close()
                      }}
                      className={cx('flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-hover', sendStatus === status && 'bg-accent-soft')}
                    >
                      <span className={cx('text-[13px] font-medium', sendStatus === status && 'text-accent-fg')}>{SEND_LABEL[status]}</span>
                      <span className="text-xs text-fg-3">{SEND_HINT[status]}</span>
                    </button>
                  ))
                }
              </Popover>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  )
})
