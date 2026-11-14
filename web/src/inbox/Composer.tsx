import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark, ChevronDown, Clock, KeyboardOff, Send, StickyNote, Trash2, UserRound, X } from 'lucide-react'
import { api } from '../lib/api'
import { canSee } from '../lib/access'
import { useLocalState, useMailboxes, useSavedReplies, useSession, useUsers } from '../lib/hooks'
import type { Conversation, Status, User, Viewer } from '../lib/types'
import { STATUS_LABEL } from '../lib/format'
import { STATUS_DOT, statusOptions } from '../lib/workspace'
import { Avatar, Banner, Button, Input, MenuDivider, MenuItem, MenuLabel, Popover, cx, useFeedback } from '../ui'
import { AttachButton, EditorArea, EditorToolbar, UploadList, editorHtml, lineHtml, paragraphHtml, useFileDrop, useRichEditor, useUploads } from './Editor'
import { SendLaterDialog } from './SendLater'
import { useZone, zonedLabel } from '../lib/timezone'

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
  const zone = useZone()
  const [mode, setMode] = useState<'reply' | 'note'>(conversation.draft?.kind ?? 'reply')
  // A live chat goes back and forth, so closing it on every reply would be wrong. Chats keep their own choice.
  const isChat = conversation.source === 'chat'
  const [storedStatus, setSendStatus] = useLocalState<SendStatus>(isChat ? 'ansa-chat-send-status' : 'ansa-send-status', isChat ? 'active' : 'closed')
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
  // Shown next to the trash button, as in Gmail, so it is clear the draft is kept.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>(conversation.draft?.bodyHtml ? 'saved' : 'idle')
  const modeRef = useRef(mode)
  modeRef.current = mode

  // The draft as saved, mirrored into the conversation's cache so the thread's draft card shows it at once.
  const lastSaved = useRef(conversation.draft?.bodyHtml ?? '')
  const cacheDraft = (bodyHtml: string, kind: 'reply' | 'note') => {
    lastSaved.current = bodyHtml
    client.setQueryData(['conversation', conversation.id], (old: any) =>
      old ? { ...old, conversation: { ...old.conversation, draft: bodyHtml ? { kind, bodyHtml, updatedAt: Date.now() } : null } } : old,
    )
    void client.invalidateQueries({ queryKey: ['conversations'] })
  }
  const saveNow = (html: string, kind: 'reply' | 'note') => {
    clearTimeout(draftTimer.current)
    setSaveState(html ? 'saving' : 'idle')
    return api
      .put(`/conversations/${conversation.id}/draft`, { kind, bodyHtml: html })
      .then(() => {
        setSaveState(html ? 'saved' : 'idle')
        cacheDraft(html, kind)
      })
      .catch(() => setSaveState('idle'))
  }

  // With the mailbox set to "choose when sending", the reply carries who the conversation goes to.
  // It starts on the current assignee until someone picks another.
  const mailboxes = useMailboxes()
  const chooseAssignee = mailboxes.data?.find((m) => m.id === conversation.mailboxId)?.assignAfterReply === 'choose'
  const [pickedAssignee, setPickedAssignee] = useState<number | null | undefined>(undefined)
  const sendAssignee = pickedAssignee !== undefined ? pickedAssignee : (conversation.assignee?.id ?? null)

  const [later, setLater] = useState(false)
  const send = useMutation({
    mutationFn: ({ status, sendAt, ifNoReply }: { status: SendStatus; sendAt?: number; ifNoReply?: boolean }) => {
      const bodyHtml = lineHtml(editorHtml(editor))
      clearTimeout(draftTimer.current)
      return mode === 'reply'
        ? api.post<{ conversation: Conversation }>(`/conversations/${conversation.id}/reply`, { bodyHtml, status, cc: showCc ? splitEmails(cc) : [], bcc: showBcc ? splitEmails(bcc) : [], attachmentIds: uploads.ids, sendAt, ifNoReply, ...(chooseAssignee || pickedAssignee !== undefined ? { assigneeId: sendAssignee } : {}) })
        : api.post<{ conversation: Conversation }>(`/conversations/${conversation.id}/note`, { bodyHtml, attachmentIds: uploads.ids })
    },
    onSuccess: (data, { status, sendAt }) => {
      client.setQueryData(['conversation', conversation.id], (old: any) => (old ? { ...old, conversation: data.conversation } : old))
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      editor?.commands.clearContent()
      setSaveState('idle')
      setFilled(false)
      lastSaved.current = ''
      uploads.clear()
      setPickedAssignee(undefined)
      onTyping(false)
      // The conversation says "Reply sent" itself, since it may go back to the list.
      if (mode === 'note' || sendAt) toast(mode === 'note' ? 'Note added' : `Reply scheduled for ${zonedLabel(sendAt!, zone)}`)
      // A scheduled reply changes nothing yet, so the conversation stays open in front of you.
      onSent(mode === 'reply' && !sendAt ? status : null)
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })

  const submit = () => {
    if (send.isPending || uploads.busy) return
    if (!editorHtml(editor) && uploads.ids.length === 0) return
    send.mutate({ status: sendStatus })
  }
  const hasContent = () => !!editorHtml(editor) || uploads.ids.length > 0
  // Whether there is anything to send, for the phone's Send button, which stays pale until there is.
  const [filled, setFilled] = useState(!!conversation.draft?.bodyHtml)
  const submitRef = useRef(submit)
  submitRef.current = submit

  // Mentions: typing "@" in a note opens a list of teammates. Picking one writes "@Full Name",
  // which the server recognises when the note is saved.
  const { user: me } = useSession()
  const teammates = useUsers()
  const [mention, setMention] = useState<{ from: number; to: number; query: string; left: number; bottom: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const candidates: User[] = mention ? (teammates.data ?? []).filter((u) => !u.disabled && u.id !== me.id && canSee(u, conversation.mailboxId) && u.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6) : []
  const trackMention = (ed: NonNullable<typeof editor>) => {
    const { $from, empty } = ed.state.selection
    const match = empty && modeRef.current === 'note' ? /(?:^|\s)@([^\s@]*(?: [^\s@]*)?)$/.exec($from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')) : null
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
    content: paragraphHtml(conversation.draft?.bodyHtml ?? ''),
    placeholder: mode === 'reply' ? `Reply to ${customerName}` : 'Write a note for your team. Type @ to mention a teammate',
    onSubmit: () => submitRef.current(),
    onKeyDown: (event) => {
      if (mentionKey(event)) return true
      // Esc saves the draft and closes the reply box, as in Help Scout.
      if (event.key === 'Escape') {
        event.preventDefault()
        saveAndCloseRef.current()
        return true
      }
      return false
    },
    onCaret: (ed) => trackMention(ed),
    onChange: (html) => {
      onTyping(!!html && modeRef.current === 'reply')
      setFilled(!!html)
      clearTimeout(draftTimer.current)
      setSaveState(html ? 'saving' : 'idle')
      draftTimer.current = setTimeout(() => void saveNow(html, modeRef.current), 700)
    },
  })
  useEffect(() => () => clearTimeout(draftTimer.current), [])

  // A draft changed somewhere else (an assistant's draft_reply, a reply taken back from Send later, Discard on
  // the draft card): load it, unless the reply box is open with text in it, which is never overwritten.
  const draftHtml = conversation.draft?.bodyHtml ?? ''
  useEffect(() => {
    if (!editor || draftHtml === lastSaved.current) return
    lastSaved.current = draftHtml
    if (open && !editor.isEmpty) return
    setMode(conversation.draft?.kind ?? 'reply')
    editor.commands.setContent(paragraphHtml(draftHtml), { emitUpdate: false })
    setFilled(!!draftHtml)
    setSaveState(draftHtml ? 'saved' : 'idle')
  }, [draftHtml, editor]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Save the draft and close the reply box. The draft then shows in the conversation, with Edit to reopen it. */
  const saveAndClose = () => {
    const html = editorHtml(editor)
    onOpenChange(false)
    onTyping(false)
    if (!html) return
    void saveNow(html, mode)
    toast('Draft saved')
  }
  const saveAndCloseRef = useRef(saveAndClose)
  saveAndCloseRef.current = saveAndClose

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
    setSaveState('idle')
    setFilled(false)
    uploads.clear()
    onTyping(false)
    void saveNow('', mode)
    onOpenChange(false)
  }

  const drop = useFileDrop(uploads.add)
  const phone = useIsPhone()
  const [phoneCc, setPhoneCc] = useState(false)
  // On a phone, ✕ on a reply with something in it asks what to do with it, as in Help Scout's app.
  const [askClose, setAskClose] = useState(false)
  const closePhone = () => {
    if (!hasContent()) return saveAndClose()
    editor?.commands.blur()
    setAskClose(true)
  }
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


  // Shared by the computer layout and the phone sheet.
  const savedRepliesMenu = (close: () => void) => (
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
                )
  const statusMenu = (close: () => void) => (
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
                    )
  const mentionList = mention && candidates.length > 0 && open && (
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
                <Avatar name={person.name} color={person.color} src={person.avatarUrl} size={20} />
                <span className="truncate">{person.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )

  /**
   * On a phone: a full-screen sheet, as in Help Scout's app. ✕ keeps the draft, Send sits top right, the options
   * are rows (To, Status, Assign, Cc/Bcc, Send later), and the tools sit on the keyboard.
   */
  const phoneSheet = () => {
    const row = 'flex min-h-13 w-full items-center gap-3 border-b border-line px-4 text-left text-[17px]'
    const value = 'flex items-center gap-2 text-[16px] text-fg-3'
    return (
      <div className={cx('sheet-safe fixed inset-x-0 top-0 z-40 flex flex-col', isNote ? 'bg-note' : 'bg-surface', !open && 'hidden')} style={{ height: 'var(--app-height, 100dvh)' }} role="dialog" aria-label={isNote ? 'Note' : 'Reply'}>
        {mentionList}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2">
          <button type="button" aria-label="Close" onClick={closePhone} className="flex size-11 items-center justify-center rounded-full text-fg-2">
            <X className="size-6" aria-hidden />
          </button>
          <h2 className="flex-1 text-center text-[17px] font-semibold">{isNote ? 'Note' : 'Reply'}</h2>
          <Button variant="primary" size="lg" loading={send.isPending} disabled={uploads.busy} onClick={submit} className={cx('mr-1 rounded-xl transition-opacity', !filled && uploads.ids.length === 0 && 'opacity-45')}>
            {isNote ? 'Save' : 'Send'}
          </Button>
        </header>
        {!isNote && (
          <div className="shrink-0">
            <div className={row}>
              <span className="text-fg-3">To:</span>
              <span className="min-w-0 truncate">
                {customerName}
                {conversation.customer.name && <span className="text-fg-3"> · {conversation.customer.email}</span>}
              </span>
            </div>
            <Popover
              align="end"
              width={230}
              trigger={({ ref: triggerRef, ...props }) => (
                <button ref={triggerRef} type="button" {...props} className={row}>
                  <span className="flex-1 text-fg-3">Status</span>
                  <span className={value}>
                    <span className={cx('size-2 rounded-full', STATUS_DOT[sendStatus])} aria-hidden />
                    {STATUS_LABEL[sendStatus]}
                  </span>
                </button>
              )}
            >
              {statusMenu}
            </Popover>
            {/* Always offered on a phone, as in Help Scout's app. Left alone, the mailbox's own rule decides. */}
            <div className={row}>
              <span className="flex-1 text-fg-3">Assign</span>
              <AssignPicker plain assigneeId={sendAssignee} meId={me.id} users={(teammates.data ?? []).filter((u) => canSee(u, conversation.mailboxId))} onPick={setPickedAssignee} />
            </div>
            {phoneCc || showCc || showBcc ? (
              <div className="divide-y divide-line border-b border-line px-4">
                {addressRow('Cc', cc, setCc, () => {
                  setShowCc(false)
                  setCc('')
                })}
                {addressRow('Bcc', bcc, setBcc, () => {
                  setShowBcc(false)
                  setBcc('')
                })}
              </div>
            ) : (
              <button
                type="button"
                className={row}
                onClick={() => {
                  setPhoneCc(true)
                  setShowCc(true)
                  setShowBcc(true)
                }}
              >
                <span className="text-fg-3">Cc/Bcc</span>
              </button>
            )}
            <button type="button" className={row} disabled={send.isPending || uploads.busy} onClick={() => (hasContent() ? setLater(true) : toast('Write a reply first.', { kind: 'error' }))}>
              <span className="flex-1 text-fg-3">Send later</span>
              <Clock className="size-5 text-fg-3" aria-hidden />
            </button>
          </div>
        )}
        {othersReplying.length > 0 && !isNote && (
          <div className="shrink-0 px-4 pt-2">
            <Banner kind="warn">
              {othersReplying.map((v) => v.name).join(' and ')} {othersReplying.length === 1 ? 'is' : 'are'} writing a reply right now.
            </Banner>
          </div>
        )}
        <div {...drop.handlers} className="min-h-0 flex-1 overflow-y-auto">
          <EditorArea editor={editor} className="composer-phone min-h-full px-4 pt-3 pb-4" />
          {uploads.uploads.length > 0 && (
            <div className="px-4 pb-3">
              <UploadList uploads={uploads.uploads} onRemove={uploads.remove} />
            </div>
          )}
        </div>
        {/* The tools ride on the keyboard. */}
        <div className="flex shrink-0 items-center gap-1 border-t border-line bg-canvas px-2 py-1.5">
          <Popover
            side="top"
            width={300}
            onOpenChange={(isOpen) => isOpen && setFilter('')}
            trigger={({ ref: triggerRef, ...props }) => (
              <button ref={triggerRef} type="button" {...props} aria-label="Insert a saved reply" className="flex size-11 items-center justify-center rounded-lg text-fg-2">
                <Bookmark className="size-5" aria-hidden />
              </button>
            )}
          >
            {savedRepliesMenu}
          </Popover>
          <AttachButton onFiles={uploads.add} />
          <EditorToolbar editor={editor} />
          <span className="flex-1" />
          <button type="button" aria-label="Hide keyboard" onClick={() => editor?.commands.blur()} className="flex size-11 items-center justify-center rounded-lg text-fg-3">
            <KeyboardOff className="size-5" aria-hidden />
          </button>
        </div>
        <SendLaterDialog
          open={later}
          onClose={() => setLater(false)}
          onPick={(sendAt, ifNoReply) => {
            setLater(false)
            send.mutate({ status: sendStatus, sendAt, ifNoReply })
          }}
        />
        {askClose && (
          // An iOS action sheet: what to do with the reply, with Cancel apart at the bottom.
          <div className="animate-fade fixed inset-0 z-50 flex flex-col justify-end bg-black/35 px-2 pb-[calc(var(--safe-bottom)+8px)]" onClick={() => setAskClose(false)}>
            <div className="animate-sheet" role="alertdialog" aria-label={isNote ? 'Save your note as draft?' : 'Save your reply as draft?'} onClick={(e) => e.stopPropagation()}>
              <div className="overflow-hidden rounded-2xl bg-surface">
                <p className="px-4 py-3.5 text-center text-[13px] text-fg-3">{isNote ? 'Save your note as draft?' : 'Save your reply as draft?'}</p>
                <button
                  type="button"
                  className="h-14 w-full border-t border-line text-[19px] text-accent active:bg-sunken"
                  onClick={() => {
                    setAskClose(false)
                    saveAndClose()
                  }}
                >
                  Save Draft
                </button>
                <button
                  type="button"
                  className="h-14 w-full border-t border-line text-[19px] text-danger active:bg-sunken"
                  onClick={() => {
                    setAskClose(false)
                    discard()
                  }}
                >
                  Delete
                </button>
              </div>
              <button type="button" className="mt-2 h-14 w-full rounded-2xl bg-surface text-[19px] font-semibold text-accent active:bg-sunken" onClick={() => setAskClose(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }
  if (phone) return phoneSheet()

  return (
    // On a computer, a card under the conversation. A phone gets a full-screen sheet instead (phoneSheet).
    <div className={cx('shrink-0 md:px-6 md:pb-5', !open && 'hidden')}>
      {mentionList}
      <div className="mx-auto max-w-[860px] md:px-14">
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
            'relative border-t shadow-[0_-6px_20px_rgba(24,24,29,0.08)] transition-colors md:rounded-xl md:border md:shadow-[0_1px_2px_rgba(24,24,29,0.06)]',
            isNote ? 'border-note-line bg-note' : 'border-line-strong bg-surface md:focus-within:border-accent',
            drop.over && 'border-accent ring-3 ring-accent/20',
          )}
        >
          {/* Close, as in Help Scout: the draft is kept and shows in the conversation. */}
          <button
            type="button"
            onClick={saveAndClose}
            aria-label="Close. Your draft is kept."
            title="Close (Esc). Your draft is kept."
            className="absolute -top-4 right-4 z-10 flex size-8 items-center justify-center rounded-full border border-line-strong bg-surface text-fg-2 shadow-[0_2px_6px_rgba(24,24,29,0.10)] transition-colors hover:text-fg max-md:hidden"
          >
            <X className="size-4" aria-hidden />
          </button>
          {!isNote && (
            <div className="divide-y divide-line px-3 md:pr-14 md:pl-5">
              <div className="flex min-h-9 items-center gap-2 py-1 md:min-h-10 md:py-1.5">
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

          <EditorArea editor={editor} className={cx('max-h-[30vh] min-h-[56px] px-3 pt-3 pb-1 md:max-h-[38vh] md:min-h-[96px] md:px-5 md:pt-4 md:pb-2', !isNote && 'border-t border-line')} />

          {uploads.uploads.length > 0 && (
            <div className="px-3 pb-2 md:px-5">
              <UploadList uploads={uploads.uploads} onRemove={uploads.remove} />
            </div>
          )}

          {/* On a narrow screen the send controls drop to their own line instead of running off the edge. */}
          <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1.5 px-1.5 pt-1 pb-2 md:px-3.5 md:pt-2 md:pb-3.5">
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
                {savedRepliesMenu}
              </Popover>
            </EditorToolbar>

            <div className="ml-auto flex items-center">
              <button type="button" aria-label="Discard draft" title="Discard draft" onClick={discard} className={tool}>
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
                        className="ml-1 flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-surface pr-2.5 pl-2.5 text-[13px] font-medium text-fg transition-colors hover:bg-sunken aria-expanded:bg-sunken md:ml-1.5 md:gap-2 md:pr-2"
                      >
                        <span className={cx('size-2 shrink-0 rounded-full', STATUS_DOT[sendStatus])} aria-hidden />
                        {STATUS_LABEL[sendStatus]}
                        <ChevronDown className="size-3.5 opacity-60 max-md:hidden" aria-hidden />
                      </button>
                    )}
                  >
                    {statusMenu}
                  </Popover>
                  {chooseAssignee && <AssignPicker assigneeId={sendAssignee} meId={me.id} users={(teammates.data ?? []).filter((u) => canSee(u, conversation.mailboxId))} onPick={setPickedAssignee} />}
                  <button
                    type="button"
                    aria-label="Send later"
                    title="Send later"
                    disabled={send.isPending || uploads.busy}
                    onClick={() => (hasContent() ? setLater(true) : toast('Write a reply first.', { kind: 'error' }))}
                    className={cx(tool, 'ml-1 disabled:opacity-50')}
                  >
                    <Clock className="size-4" aria-hidden />
                  </button>
                  <Button variant="primary" loading={send.isPending} disabled={uploads.busy} onClick={submit} className="ml-1" icon={<Send className="size-3.5" aria-hidden />}>
                    Send
                  </Button>
                  <SendLaterDialog
                    open={later}
                    onClose={() => setLater(false)}
                    onPick={(sendAt, ifNoReply) => {
                      setLater(false)
                      send.mutate({ status: sendStatus, sendAt, ifNoReply })
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

/** A phone-width screen, tracked live (a tablet turning round can cross the line). */
const PHONE = '(max-width: 767px)'
function useIsPhone() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(PHONE)
      query.addEventListener('change', notify)
      return () => query.removeEventListener('change', notify)
    },
    () => window.matchMedia(PHONE).matches,
  )
}

const NobodyIcon = ({ size = 20 }: { size?: number }) => (
  <span className="flex shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3" style={{ width: size, height: size }}>
    <UserRound className="size-3" aria-hidden />
  </span>
)

/** Who the conversation is assigned to once this reply is sent. */
function AssignPicker({ assigneeId, meId, users, onPick, plain }: { assigneeId: number | null; meId: number; users: User[]; onPick: (id: number | null) => void; plain?: boolean }) {
  const active = users.filter((u) => !u.disabled)
  const current = active.find((u) => u.id === assigneeId) ?? null
  const label = current ? (current.id === meId ? 'Me' : current.name.split(' ')[0]) : 'Unassigned'
  return (
    <Popover
      align="end"
      side="top"
      width={230}
      trigger={({ ref: triggerRef, ...props }) =>
        plain ? (
          // A phone sheet row's value: plain text, as in Help Scout's app.
          <button ref={triggerRef} type="button" {...props} aria-label={`Assign after sending: ${current?.name ?? 'Anyone'}`} className="-mr-1 flex h-11 items-center gap-2 px-1 text-[16px] text-fg-3">
            {current && <Avatar name={current.name} color={current.color} src={current.avatarUrl} size={22} />}
            {current ? label : 'Anyone'}
          </button>
        ) : (
        <button
          ref={triggerRef}
          type="button"
          {...props}
          aria-label={`Assign after sending: ${current?.name ?? 'Unassigned'}`}
          title="Assign after sending"
          className="ml-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-surface pr-2 pl-1 text-[13px] font-medium text-fg transition-colors hover:bg-sunken aria-expanded:bg-sunken"
        >
          {current ? <Avatar name={current.name} color={current.color} src={current.avatarUrl} size={22} /> : <NobodyIcon size={22} />}
          <span className="hidden max-w-24 truncate sm:inline">{label}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </button>
        )
      }
    >
      {(close) => (
        <>
          <MenuLabel>Assign after sending</MenuLabel>
          {active.map((u) => (
            <MenuItem
              key={u.id}
              icon={<Avatar name={u.name} color={u.color} src={u.avatarUrl} size={20} />}
              checked={assigneeId === u.id}
              onSelect={() => {
                onPick(u.id)
                close()
              }}
            >
              {u.name} {u.id === meId && <span className="ml-1 text-fg-3">you</span>}
            </MenuItem>
          ))}
          <MenuDivider />
          <MenuItem
            icon={<NobodyIcon />}
            checked={assigneeId === null}
            onSelect={() => {
              onPick(null)
              close()
            }}
          >
            Unassigned
          </MenuItem>
        </>
      )}
    </Popover>
  )
}
