import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark, ChevronDown, Send, StickyNote, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import { useLocalState, useSavedReplies, useSession, useUsers } from '../lib/hooks'
import type { Conversation, Status, User, Viewer } from '../lib/types'
import { STATUS_LABEL } from '../lib/format'
import { STATUS_DOT, statusOptions, workspace } from '../lib/workspace'
import { Avatar, Banner, Button, Input, MenuItem, MenuLabel, Popover, cx, useFeedback } from '../ui'
import { AttachButton, EditorArea, EditorToolbar, UploadList, editorHtml, useFileDrop, useRichEditor, useUploads } from './Editor'

export interface ComposerHandle {
  focus: (mode: 'reply' | 'note') => void
}

type SendStatus = Exclude<Status, 'spam'>

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
  const [storedStatus, setSendStatus] = useLocalState<SendStatus>('ansa-send-status', 'closed')
  // A remembered choice can be one the workspace no longer offers.
  const sendStatus: SendStatus = (statusOptions() as SendStatus[]).includes(storedStatus) ? storedStatus : 'closed'
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

  // Mentions: typing "@" in a note opens a list of teammates. Picking one writes "@Full Name",
  // which the server recognises when the note is saved.
  const { user: me } = useSession()
  const teammates = useUsers()
  const [mention, setMention] = useState<{ from: number; to: number; query: string; left: number; bottom: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const candidates: User[] = mention ? (teammates.data ?? []).filter((u) => !u.disabled && u.id !== me.id && u.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6) : []
  const trackMention = (ed: NonNullable<typeof editor>) => {
    const { $from, empty } = ed.state.selection
    const match = empty && modeRef.current === 'note' && workspace().mentions ? /(?:^|\s)@([^\s@]*(?: [^\s@]*)?)$/.exec($from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')) : null
    if (!match) return setMention(null)
    const at = ed.view.coordsAtPos($from.pos)
    setMention({ from: $from.pos - match[1].length - 1, to: $from.pos, query: match[1], left: at.left, bottom: window.innerHeight - at.top + 6 })
    setMentionIndex(0)
  }
  const pickMention = (person: User) => {
    if (!mention || !editor) return
    editor
      .chain()
      .focus()
      .insertContentAt({ from: mention.from, to: mention.to }, [
        { type: 'text', text: `@${person.name}`, marks: [{ type: 'bold' }] },
        { type: 'text', text: ' ' },
      ])
      .run()
    setMention(null)
  }
  const mentionKey = (event: KeyboardEvent): boolean => {
    if (!mention || candidates.length === 0) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setMentionIndex((i) => (i + (event.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length)
    else if (event.key === 'Enter' || event.key === 'Tab') pickMention(candidates[Math.min(mentionIndex, candidates.length - 1)])
    else if (event.key === 'Escape') setMention(null)
    else return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const customerName = conversation.customer.name || conversation.customer.email
  const editor = useRichEditor({
    content: conversation.draft?.bodyHtml ?? '',
    placeholder: mode === 'reply' ? `Reply to ${customerName}` : workspace().mentions ? 'Write a note for your team. Type @ to mention a teammate' : 'Write a note for your team. The customer will not see it',
    onSubmit: () => submitRef.current(),
    onKeyDown: (event) => mentionKey(event),
    onCaret: (ed) => trackMention(ed),
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
      {mention && candidates.length > 0 && open && (
        <ul role="listbox" aria-label="Mention a teammate" className="animate-pop fixed z-50 w-60 rounded-lg bg-surface p-1 shadow-pop" style={{ left: Math.max(8, Math.min(mention.left, window.innerWidth - 248)), bottom: mention.bottom }}>
          {candidates.map((person, index) => (
            <li key={person.id} role="option" aria-selected={index === mentionIndex}>
              <button
                type="button"
                // Keep the cursor in the editor while clicking.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(person)}
                onMouseEnter={() => setMentionIndex(index)}
                className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]', index === mentionIndex ? 'bg-accent-soft text-accent-fg' : 'text-fg')}
              >
                <Avatar name={person.name} color={person.color} size={20} />
                <span className="truncate">{person.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
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
              <>
                {/* The status this reply gives the conversation. It is shown on the message afterwards. */}
                <Popover
                  align="end"
                  side="top"
                  width={230}
                  trigger={({ ref: triggerRef, ...props }) => (
                    <button
                      ref={triggerRef}
                      type="button"
                      {...props}
                      aria-label={`Status after sending: ${STATUS_LABEL[sendStatus]}`}
                      title="Status after sending"
                      className="ml-1.5 flex h-8 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-surface pr-2 pl-2.5 text-[13px] font-medium text-fg transition-colors hover:bg-sunken aria-expanded:bg-sunken"
                    >
                      <span className={cx('size-2 shrink-0 rounded-full', STATUS_DOT[sendStatus])} aria-hidden />
                      {STATUS_LABEL[sendStatus]}
                      <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuLabel>After sending</MenuLabel>
                      {(statusOptions() as SendStatus[]).map((status) => (
                        <MenuItem
                          key={status}
                          icon={<span className={cx('size-2 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />}
                          checked={sendStatus === status}
                          onSelect={() => {
                            setSendStatus(status)
                            close()
                          }}
                        >
                          {STATUS_LABEL[status]}
                        </MenuItem>
                      ))}
                    </>
                  )}
                </Popover>
                <Button variant="primary" loading={send.isPending} disabled={uploads.busy} onClick={submit} className="ml-1.5" icon={<Send className="size-3.5" aria-hidden />}>
                  Send
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
