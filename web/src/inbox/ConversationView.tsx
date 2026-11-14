import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Download,
  Ellipsis,
  Expand,
  FileText,
  FolderInput,
  Merge,
  PanelRight,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Tag as TagIcon,
  Trash2,
  UserRound,
  X,
  Clock,
  FileCode,
  StickyNote,
  EllipsisVertical,
  Reply,
  Archive,
  MailOpen,
  MessageCircle,
} from 'lucide-react'
import { api, qs } from '../lib/api'
import { fileSize, fullTime, messageTime, STATUS_LABEL } from '../lib/format'
import { canSee } from '../lib/access'
import { useDebounced, useDocumentTitle, useHotkeys, useMailboxes, useSession, useTags, useUsers } from '../lib/hooks'
import type { Attachment, Conversation, ConversationSummary, Status, Thread, Viewer } from '../lib/types'
import { Avatar, Button, EmptyState, Input, MenuDivider, MenuItem, MenuLabel, Modal, Popover, Spinner, StatusBadge, cx, useFeedback } from '../ui'
import { Composer, type ComposerHandle } from './Composer'
import { lineHtml } from './Editor'
import { STATUS_DOT, statusOptions, workspace } from '../lib/workspace'
import { LightboxProvider, isImageType, useLightbox, type LightboxImage } from './Lightbox'
import { useZone, zonedLabel } from '../lib/timezone'
import { CustomerPanel } from './CustomerPanel'
import { useSheetDrag } from '../lib/sheetDrag'

type Patch = Partial<{ status: Status; assigneeId: number | null; subject: string; addTags: string[]; removeTags: string[]; snoozedUntil: number | null; mailboxId: number }>

export function ConversationView({ id, onBack, onDone }: { id: number; onBack: () => void; onDone: (message: string, undo?: () => void) => void }) {
  const { user } = useSession()
  const client = useQueryClient()
  const navigate = useNavigate()
  const { toast, confirm } = useFeedback()
  const composer = useRef<ComposerHandle>(null)
  const [panel, setPanel] = useState(false)
  const [typing, setTyping] = useState(false)
  const [merging, setMerging] = useState(false)
  // Phone: the sheet with status, assignee, tags and more, opened from the card at the bottom.
  const [details, setDetails] = useState(false)
  const sheetDrag = useSheetDrag(() => setDetails(false))
  // The composer stays closed until someone asks to write. An unsent draft reopens it.
  const [composing, setComposing] = useState(false)
  const openComposer = (mode: 'reply' | 'note') => {
    // Show it first, in the same tick: a hidden editor cannot take focus, and the next keys must land in it.
    flushSync(() => setComposing(true))
    composer.current?.focus(mode)
  }

  const query = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<{ conversation: Conversation; viewers: Viewer[] }>(`/conversations/${id}`),
  })
  const conversation = query.data?.conversation
  const livePresence = useQuery<Viewer[]>({ queryKey: ['presence', id], queryFn: () => query.data?.viewers ?? [], enabled: false })
  const viewers = (livePresence.data ?? query.data?.viewers ?? []).filter((v) => v.userId !== user.id)
  useDocumentTitle(conversation?.subject ?? '')

  // Tell teammates we are here, and whether we are writing a reply.
  // Phones (an iPhone home screen app especially) freeze timers whenever the app is in the background, so the
  // regular ping alone could leave us missing for up to 20 seconds after coming back: announce at once on return,
  // and leave while away so teammates do not see someone who is not looking.
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState === 'hidden') return
      void api.post(`/conversations/${id}/presence`, { state: typing ? 'replying' : 'viewing' }).catch(() => {})
    }
    const leave = () => {
      // keepalive lets the request finish while the page is being hidden or closed.
      void fetch(`/api/conversations/${id}/presence`, { method: 'DELETE', headers: { 'X-Requested-With': 'ansa' }, credentials: 'same-origin', keepalive: true }).catch(() => {})
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? ping() : leave())
    ping()
    const timer = setInterval(ping, 15_000)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', ping)
    window.addEventListener('focus', ping)
    window.addEventListener('pagehide', leave)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', ping)
      window.removeEventListener('focus', ping)
      window.removeEventListener('pagehide', leave)
    }
  }, [id, typing])
  useEffect(
    () => () => {
      void api.del(`/conversations/${id}/presence`).catch(() => {})
    },
    [id],
  )

  const update = useMutation({
    mutationFn: (patch: Patch) => api.patch<{ conversation: Conversation }>(`/conversations/${id}`, patch),
    onSuccess: (data) => {
      client.setQueryData(['conversation', id], (old: any) => (old ? { ...old, conversation: data.conversation } : old))
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      void client.invalidateQueries({ queryKey: ['tags'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })

  const setStatus = (status: Status) => {
    if (!conversation || conversation.status === status) return
    const previous = conversation.status
    update.mutate(
      { status },
      {
        onSuccess: () => {
          // The conversation leaves this folder, so go back to the list.
          // As in Help Scout: "Conversation closed", with Undo to put the old status back.
          if (status === 'closed' || status === 'spam' || (status === 'pending' && workspace().fourStatuses))
            onDone(status === 'closed' ? 'Conversation closed' : `Marked as ${STATUS_LABEL[status].toLowerCase()}`, () =>
              api
                .patch(`/conversations/${id}`, { status: previous })
                .then(() => {
                  void client.invalidateQueries({ queryKey: ['conversation', id] })
                  void client.invalidateQueries({ queryKey: ['conversations'] })
                  void client.invalidateQueries({ queryKey: ['mailboxes'] })
                })
                .catch((err: Error) => toast(err.message, { kind: 'error' })),
            )
          else toast(`Marked as ${STATUS_LABEL[status].toLowerCase()}`, { action: { label: 'Undo', run: () => update.mutate({ status: previous }) } })
        },
      },
    )
  }

  const remove = async () => {
    if (!conversation) return
    const ok = await confirm({ title: 'Delete this conversation?', body: 'Every message, note and attachment in it is removed for the whole team. You cannot undo this.', confirmLabel: 'Delete conversation', danger: true })
    if (!ok) return
    try {
      await api.del(`/conversations/${id}`)
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      toast('Conversation deleted')
      onBack()
    } catch (err) {
      toast((err as Error).message, { kind: 'error' })
    }
  }

  useHotkeys(
    {
      r: (e) => {
        e.preventDefault()
        openComposer('reply')
      },
      n: (e) => {
        e.preventDefault()
        openComposer('note')
      },
      a: () => conversation && update.mutate({ assigneeId: conversation.assignee?.id === user.id ? null : user.id }),
      e: () => setStatus('closed'),
      // Status: press S, then C (closed), P (pending) or A (active).
      's c': () => setStatus('closed'),
      's p': () => setStatus('pending'),
      's a': () => setStatus('active'),
    },
    !!conversation,
  )

  // Every picture in the conversation, in order, so the lightbox can step through them.
  const images = useMemo<LightboxImage[]>(
    () => (conversation?.threads ?? []).flatMap((t) => t.attachments.filter((a) => isImageType(a.mime)).map((a) => ({ url: a.url, filename: a.filename, size: a.size }))),
    [conversation?.threads],
  )

  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (query.isError || !conversation) {
    return <EmptyState icon={<CircleAlert />} title="This conversation is gone" body="It may have been deleted or merged into another one." action={<Button onClick={onBack}>Back to the list</Button>} />
  }

  const header = (
    <Header
      conversation={conversation}
      viewers={viewers}
      busy={update.isPending}
      onBack={onBack}
      onPatch={(patch) => update.mutate(patch)}
      onStatus={setStatus}
      onDelete={() => void remove()}
      onMerge={() => {
        setDetails(false)
        setMerging(true)
      }}
      onTogglePanel={() => {
        setDetails(false)
        setPanel((open) => !open)
      }}
    />
  )
  const statusLabel = STATUS_LABEL[conversation.status]

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* On a phone the email gets the screen: the header's controls live in a sheet opened from the card below. */}
        <div className="max-md:hidden">{header}</div>
        <LightboxProvider images={images}>
          <ThreadList key={conversation.id} conversation={conversation} composing={composing} onCompose={openComposer} />
        </LightboxProvider>
        {/* Phone: a summary card and an action bar along the bottom, as in Help Scout's app. */}
        {!composing && (
          <div className="shrink-0 bg-canvas md:hidden">
            <button type="button" onClick={() => setDetails(true)} className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-2xl bg-surface px-3.5 py-3 text-left shadow-[0_4px_20px_rgba(24,24,29,0.10)]">
              <Avatar name={conversation.customer.name || conversation.customer.email} size={44} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[17px] font-semibold">{conversation.subject}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[14px] text-fg-3">
                  <span className={cx('size-2 rounded-full', STATUS_DOT[conversation.status])} aria-hidden />
                  {statusLabel}
                  <span aria-hidden>·</span>
                  <span className="truncate">{conversation.assignee ? conversation.assignee.name : 'Unassigned'}</span>
                </span>
              </span>
            </button>
            <nav aria-label="Conversation actions" className="flex items-center justify-around border-t border-line bg-surface px-2 pt-1.5 pb-[calc(0.5rem+var(--safe-bottom))]">
              {(
                [
                  ['Back to the list', ArrowLeft, onBack],
                  ['Close conversation', Archive, () => setStatus('closed')],
                  ['Reply', Reply, () => openComposer('reply')],
                  ['Add a note', StickyNote, () => openComposer('note')],
                  ['More', EllipsisVertical, () => setDetails(true)],
                ] as const
              ).map(([label, Icon, run]) => (
                <button key={label} type="button" aria-label={label} title={label} onClick={run} className="flex size-12 items-center justify-center rounded-xl text-fg-2 active:bg-sunken">
                  <Icon className="size-6" aria-hidden />
                </button>
              ))}
            </nav>
          </div>
        )}
        {details && (
          <div className="fixed inset-0 z-30 flex items-end bg-black/40 md:hidden" onClick={() => setDetails(false)}>
            <div
              ref={sheetDrag.ref}
              onTouchStart={sheetDrag.onTouchStart}
              onTouchMove={sheetDrag.onTouchMove}
              onTouchEnd={sheetDrag.onTouchEnd}
              className="sheet-safe w-full rounded-t-2xl bg-surface pt-2 shadow-pop"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Conversation details"
            >
              <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-line-strong" aria-hidden />
              <PhoneDetails
                conversation={conversation}
                onPatch={(patch) => update.mutate(patch)}
                onStatus={(status) => {
                  setStatus(status)
                  setDetails(false)
                }}
                onDelete={() => {
                  setDetails(false)
                  void remove()
                }}
                onMerge={() => {
                  setDetails(false)
                  setMerging(true)
                }}
                onCustomer={() => {
                  setDetails(false)
                  setPanel(true)
                }}
              />
            </div>
          </div>
        )}
        <Composer
          key={conversation.id}
          ref={composer}
          open={composing}
          onOpenChange={setComposing}
          conversation={conversation}
          agentName={user.name}
          othersReplying={viewers.filter((v) => v.state === 'replying')}
          onTyping={setTyping}
          onSent={(status) => {
            setComposing(false)
            if (!status) return
            // The conversation leaves this folder, so go back to the list.
            if (status === 'closed' || (status === 'pending' && workspace().fourStatuses)) onDone('Reply sent')
            else toast('Reply sent')
          }}
        />
      </div>
      <aside className="hidden w-[316px] shrink-0 overflow-y-auto border-l border-line bg-canvas xl:block" aria-label="Customer">
        <CustomerPanel conversation={conversation} />
      </aside>
      {panel && (
        <div className="safe-pad animate-fade fixed inset-0 z-30 flex justify-end bg-black/40 xl:hidden" onClick={() => setPanel(false)}>
          <aside className="h-full w-80 max-w-[88vw] overflow-y-auto bg-canvas shadow-pop" onClick={(e) => e.stopPropagation()} aria-label="Customer">
            <CustomerPanel conversation={conversation} />
          </aside>
        </div>
      )}
      {merging && (
        <MergeDialog
          conversation={conversation}
          onClose={() => setMerging(false)}
          onMerged={(target) => {
            setMerging(false)
            void client.invalidateQueries({ queryKey: ['conversations'] })
            toast(`Merged into #${target}`)
            navigate(`/c/${target}`)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Header: subject, status, assignee, tags, snooze, more
// ---------------------------------------------------------------------------------------------

const pill = 'inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface pr-2 pl-2.5 text-[13px] font-medium text-fg transition-colors hover:bg-sunken aria-expanded:bg-sunken'
const STATUS_PILL: Record<string, string> = {
  active: 'border-ok/25 bg-ok-soft text-ok hover:bg-ok-soft',
  waiting: 'border-accent/25 bg-accent-soft text-accent-fg hover:bg-accent-soft',
  pending: 'border-warn/25 bg-warn-soft text-warn hover:bg-warn-soft',
  closed: 'bg-sunken',
  spam: 'border-danger/25 bg-danger-soft text-danger hover:bg-danger-soft',
}
const STATUS_HINT: Record<string, string> = { active: 'needs a reply', pending: 'waiting on them', closed: 'done' }
// With four statuses the names say it all, except for the first one.
const STATUS_HINT_FOUR: Record<string, string> = { active: 'new or in progress', waiting: '', pending: '', closed: '' }
const MAX_TAGS = 3

function Header({
  conversation: c,
  viewers,
  busy,
  onBack,
  onPatch,
  onStatus,
  onDelete,
  onMerge,
  onTogglePanel,
}: {
  conversation: Conversation
  viewers: Viewer[]
  busy: boolean
  onBack: () => void
  onPatch: (patch: Patch) => void
  onStatus: (status: Status) => void
  onDelete: () => void
  onMerge: () => void
  onTogglePanel: () => void
}) {
  const users = useUsers()
  const mailboxes = useMailboxes()
  const { user } = useSession()
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(c.subject)
  useEffect(() => setSubject(c.subject), [c.subject])
  const saveSubject = () => {
    setEditing(false)
    if (subject.trim() && subject.trim() !== c.subject) onPatch({ subject: subject.trim() })
    else setSubject(c.subject)
  }
  const otherMailboxes = (mailboxes.data ?? []).filter((m) => m.id !== c.mailboxId)

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line py-2 pr-3 pl-3 md:pr-4">
      {/* Title and tags */}
      <div className="flex min-w-[min(100%,260px)] flex-1 items-center gap-2">
        <button type="button" aria-label="Back to the list" onClick={onBack} className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-sunken">
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        {editing ? (
          <Input
            autoFocus
            aria-label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={saveSubject}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveSubject()
              if (e.key === 'Escape') {
                setSubject(c.subject)
                setEditing(false)
              }
            }}
            className="h-8 max-w-md text-base font-semibold"
          />
        ) : (
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">
            <button type="button" onClick={() => setEditing(true)} title="Edit subject" className="max-w-full truncate rounded text-left align-bottom hover:bg-sunken">
              {c.subject}
            </button>
          </h1>
        )}
        <span className="shrink-0 text-[13px] text-fg-3 tabular-nums">#{c.id}</span>
        <div className="ml-2 flex shrink-0 items-center gap-1.5">
          {c.tags.slice(0, MAX_TAGS).map((tag) => (
            <span key={tag.id} className="hidden h-6 items-center gap-1 rounded-md bg-sunken pr-1 pl-2 text-xs font-medium text-fg-2 lg:flex">
              {tag.name}
              <button type="button" aria-label={`Remove tag ${tag.name}`} onClick={() => onPatch({ removeTags: [tag.name] })} className="flex size-4 items-center justify-center rounded text-fg-3 hover:text-fg">
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <TagMenu current={c.tags.map((t) => t.name)} hiddenCount={Math.max(0, c.tags.length - MAX_TAGS)} onAdd={(name) => onPatch({ addTags: [name] })} onRemove={(name) => onPatch({ removeTags: [name] })} />
        </div>
      </div>

      {/* Properties */}
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
        {viewers.length > 0 && (
          <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-warn-soft py-0.5 pr-2.5 pl-1 text-xs font-medium text-warn" role="status">
            <span className="flex -space-x-1.5">
              {viewers.slice(0, 3).map((v) => (
                <Avatar key={v.userId} name={v.name} color={v.color} src={v.avatarUrl} size={20} className="ring-2 ring-warn-soft" />
              ))}
            </span>
            <span className="hidden sm:inline">
              {viewers.length === 1 ? viewers[0].name.split(' ')[0] : `${viewers.length} people`} {viewers.some((v) => v.state === 'replying') ? 'replying' : 'viewing'}
            </span>
          </div>
        )}

        {c.visitorOnline !== null && (
          <span
            className={cx('flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium', c.visitorOnline ? 'bg-ok-soft text-ok' : 'bg-sunken text-fg-2')}
            role="status"
            title={c.visitorOnline ? 'The visitor has the chat open. Replies appear there at once.' : 'The visitor left the chat. Replies go to them by email.'}
          >
            <MessageCircle className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{c.visitorOnline ? 'In chat now' : 'Left chat'}</span>
            {c.visitorOnline && <span className="size-1.5 rounded-full bg-ok" aria-hidden />}
          </span>
        )}

        <SnoozeMenu snoozedUntil={c.snoozedUntil} onSnooze={(until) => onPatch({ snoozedUntil: until })} />

        <Popover
          align="end"
          width={248}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className={cx(pill, STATUS_PILL[c.status])} aria-label={`Status: ${STATUS_LABEL[c.status]}`} disabled={busy}>
              <StatusDot status={c.status} />
              {STATUS_LABEL[c.status]}
              <ChevronDown className="size-3.5 opacity-60" aria-hidden />
            </button>
          )}
        >
          {(close) =>
            statusOptions().map((status) => (
              <MenuItem
                key={status}
                icon={<StatusDot status={status} />}
                checked={c.status === status}
                onSelect={() => {
                  close()
                  onStatus(status)
                }}
              >
                {STATUS_LABEL[status]} <span className="ml-1 text-fg-3">{(workspace().fourStatuses ? STATUS_HINT_FOUR : STATUS_HINT)[status]}</span>
              </MenuItem>
            ))
          }
        </Popover>

        <Popover
          align="end"
          width={230}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className={cx(pill, 'pl-1.5')} aria-label={`Assignee: ${c.assignee?.name ?? 'nobody'}`}>
              {c.assignee ? (
                <Avatar name={c.assignee.name} color={c.assignee.color} src={c.assignee.avatarUrl} size={20} />
              ) : (
                <span className="flex size-5 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3">
                  <UserRound className="size-3" aria-hidden />
                </span>
              )}
              <span className="max-w-28 truncate">{c.assignee ? c.assignee.name.split(' ')[0] : 'Unassigned'}</span>
              <ChevronDown className="size-3.5 opacity-60" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              {(users.data ?? [])
                .filter((u) => !u.disabled && canSee(u, c.mailboxId))
                .map((u) => (
                  <MenuItem
                    key={u.id}
                    icon={<Avatar name={u.name} color={u.color} src={u.avatarUrl} size={20} />}
                    checked={c.assignee?.id === u.id}
                    onSelect={() => {
                      close()
                      onPatch({ assigneeId: u.id })
                    }}
                  >
                    {u.name} {u.id === user.id && <span className="ml-1 text-fg-3">you</span>}
                  </MenuItem>
                ))}
              <MenuDivider />
              <MenuItem
                icon={
                  <span className="flex size-5 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3">
                    <UserRound className="size-3" aria-hidden />
                  </span>
                }
                checked={!c.assignee}
                onSelect={() => {
                  close()
                  onPatch({ assigneeId: null })
                }}
              >
                Unassigned
              </MenuItem>
            </>
          )}
        </Popover>

        <Popover
          align="end"
          width={220}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} aria-label="More actions" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-sunken aria-expanded:bg-sunken">
              <Ellipsis className="size-4" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Merge />}
                onSelect={() => {
                  close()
                  onMerge()
                }}
              >
                Merge into another
              </MenuItem>
              {otherMailboxes.length > 0 && (
                <>
                  <MenuDivider />
                  <MenuLabel>Move to mailbox</MenuLabel>
                  {otherMailboxes.map((m) => (
                    <MenuItem
                      key={m.id}
                      icon={<FolderInput />}
                      onSelect={() => {
                        close()
                        onPatch({ mailboxId: m.id })
                      }}
                    >
                      {m.name}
                    </MenuItem>
                  ))}
                </>
              )}
              <MenuDivider />
              {c.status === 'spam' ? (
                <MenuItem
                  icon={<ShieldCheck />}
                  onSelect={() => {
                    close()
                    onStatus('active')
                  }}
                >
                  Not spam
                </MenuItem>
              ) : (
                <MenuItem
                  icon={<ShieldAlert />}
                  onSelect={() => {
                    close()
                    onStatus('spam')
                  }}
                >
                  Mark as spam
                </MenuItem>
              )}
              <MenuItem
                icon={<Trash2 />}
                danger
                onSelect={() => {
                  close()
                  onDelete()
                }}
              >
                Delete conversation
              </MenuItem>
            </>
          )}
        </Popover>

        <button type="button" aria-label="Customer details" onClick={onTogglePanel} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-sunken xl:hidden">
          <PanelRight className="size-4" aria-hidden />
        </button>
      </div>
    </header>
  )
}

/**
 * Phone: the conversation's details as a sheet, as in Help Scout's app. Big cards for Status, Assigned to and
 * Tags, each opening a full-width list, and the other actions as rows under them.
 */
function PhoneDetails({
  conversation: c,
  onPatch,
  onStatus,
  onDelete,
  onMerge,
  onCustomer,
}: {
  conversation: Conversation
  onPatch: (patch: Patch) => void
  onStatus: (status: Status) => void
  onDelete: () => void
  onMerge: () => void
  onCustomer: () => void
}) {
  const users = useUsers()
  const tags = useTags()
  const mailboxes = useMailboxes()
  const { user } = useSession()
  const [view, setView] = useState<'main' | 'status' | 'assignee' | 'tags' | 'snooze' | 'move'>('main')
  const [filter, setFilter] = useState('')
  const otherMailboxes = (mailboxes.data ?? []).filter((m) => m.id !== c.mailboxId)
  const customerName = c.customer.name || c.customer.email
  const card = 'flex w-full flex-col gap-2 rounded-2xl bg-sunken px-4 py-3.5 text-left active:bg-hover'
  const cardLabel = 'text-[14px] font-medium text-fg-3'
  const cardValue = 'flex min-w-0 items-center gap-3 text-[17px]'
  const row = 'flex min-h-14 w-full items-center gap-3.5 px-1 text-left text-[17px] active:bg-sunken'
  const unassignedIcon = (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-fg-3 text-fg-2">
      <UserRound className="size-4" aria-hidden />
    </span>
  )
  const back = (title: string) => (
    <div className="mb-1 flex h-12 items-center gap-1">
      <button type="button" aria-label="Back" onClick={() => setView('main')} className="-ml-2 flex size-11 items-center justify-center rounded-full text-fg-2 active:bg-sunken">
        <ChevronLeft className="size-6" aria-hidden />
      </button>
      <h2 className="text-[19px] font-semibold">{title}</h2>
    </div>
  )
  const option = (key: string | number, label: ReactNode, icon: ReactNode, checked: boolean, onSelect: () => void) => (
    <button key={key} type="button" onClick={onSelect} className={cx(row, 'border-b border-line last:border-b-0')}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check className="size-5 shrink-0 text-accent" aria-hidden />}
    </button>
  )
  const pick = (patch: Patch) => {
    onPatch(patch)
    setView('main')
  }

  return (
    <div className="max-h-[82dvh] overflow-y-auto overscroll-contain px-5 pt-2 pb-4">
      {view === 'main' && (
        <>
          <p className="text-[15px] text-fg-3 tabular-nums">{c.id}</p>
          <h2 className="mt-0.5 text-[24px] leading-tight font-bold tracking-tight">{c.subject || '(no subject)'}</h2>
          <button type="button" onClick={onCustomer} className="mt-4 flex w-full items-center gap-3.5 border-t border-line py-4 text-left">
            <Avatar name={customerName} size={48} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[18px] font-semibold">{customerName}</span>
              <span className="block truncate text-[15px] text-fg-3">{c.customer.email}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-fg-2" aria-hidden />
          </button>
          <div className="flex flex-col gap-3">
            <button type="button" className={card} onClick={() => setView('status')}>
              <span className={cardLabel}>Status</span>
              <span className={cardValue}>
                <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-full', STATUS_PILL[c.status])}>
                  <span className={cx('size-3 rounded-full', STATUS_DOT[c.status])} aria-hidden />
                </span>
                {STATUS_LABEL[c.status]}
              </span>
            </button>
            <button type="button" className={card} onClick={() => setView('assignee')}>
              <span className={cardLabel}>Assigned to</span>
              <span className={cardValue}>
                {c.assignee ? <Avatar name={c.assignee.name} color={c.assignee.color} src={c.assignee.avatarUrl} size={28} /> : unassignedIcon}
                <span className="truncate">{c.assignee ? c.assignee.name : 'Unassigned'}</span>
              </span>
            </button>
            <button
              type="button"
              className={card}
              onClick={() => {
                setFilter('')
                setView('tags')
              }}
            >
              <span className={cardLabel}>Tags</span>
              {c.tags.length > 0 ? (
                <span className="flex flex-wrap gap-1.5">
                  {c.tags.map((t) => (
                    <span key={t.id} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-surface px-2.5 text-[15px] font-medium text-fg-2">
                      <span className="size-2 rounded-full" style={{ background: t.color }} aria-hidden />
                      {t.name}
                    </span>
                  ))}
                </span>
              ) : (
                <span className={cardValue}>
                  <TagIcon className="size-6 shrink-0 text-fg-2" aria-hidden />
                  Add tags…
                </span>
              )}
            </button>
          </div>
          <div className="mt-3 flex flex-col">
            <button type="button" className={cx(row, 'border-b border-line')} onClick={() => setView('snooze')}>
              <AlarmClock className="size-6 shrink-0 text-fg-2" aria-hidden />
              <span className="flex-1">{c.snoozedUntil ? `Snoozed until ${messageTime(c.snoozedUntil)}` : 'Snooze'}</span>
              <ChevronRight className="size-5 text-fg-3" aria-hidden />
            </button>
            <button type="button" className={cx(row, 'border-b border-line')} onClick={onMerge}>
              <Merge className="size-6 shrink-0 text-fg-2" aria-hidden />
              Merge into another
            </button>
            {otherMailboxes.length > 0 && (
              <button type="button" className={cx(row, 'border-b border-line')} onClick={() => setView('move')}>
                <FolderInput className="size-6 shrink-0 text-fg-2" aria-hidden />
                <span className="flex-1">Move to mailbox</span>
                <ChevronRight className="size-5 text-fg-3" aria-hidden />
              </button>
            )}
            <button type="button" className={cx(row, 'border-b border-line')} onClick={() => onStatus(c.status === 'spam' ? 'active' : 'spam')}>
              {c.status === 'spam' ? <ShieldCheck className="size-6 shrink-0 text-fg-2" aria-hidden /> : <ShieldAlert className="size-6 shrink-0 text-fg-2" aria-hidden />}
              {c.status === 'spam' ? 'Not spam' : 'Mark as spam'}
            </button>
            <button type="button" className={cx(row, 'text-danger')} onClick={onDelete}>
              <Trash2 className="size-6 shrink-0" aria-hidden />
              Delete conversation
            </button>
          </div>
        </>
      )}
      {view === 'status' && (
        <>
          {back('Status')}
          {statusOptions().map((status) =>
            option(
              status,
              <>
                {STATUS_LABEL[status]} <span className="text-[15px] text-fg-3">{(workspace().fourStatuses ? STATUS_HINT_FOUR : STATUS_HINT)[status]}</span>
              </>,
              <span className={cx('size-3.5 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />,
              c.status === status,
              () => onStatus(status),
            ),
          )}
        </>
      )}
      {view === 'assignee' && (
        <>
          {back('Assign to')}
          {option('none', 'Unassigned', unassignedIcon, !c.assignee, () => pick({ assigneeId: null }))}
          {(users.data ?? [])
            .filter((u) => !u.disabled && canSee(u, c.mailboxId))
            .map((u) =>
              option(
                u.id,
                <>
                  {u.name} {u.id === user.id && <span className="text-[15px] text-fg-3">you</span>}
                </>,
                <Avatar name={u.name} color={u.color} src={u.avatarUrl} size={28} />,
                c.assignee?.id === u.id,
                () => pick({ assigneeId: u.id }),
              ),
            )}
        </>
      )}
      {view === 'tags' &&
        (() => {
          const current = c.tags.map((t) => t.name)
          const clean = filter.trim().toLowerCase().replace(/\s+/g, '-')
          const options = (tags.data ?? []).filter((t) => t.name.includes(clean))
          const canCreate = clean && !(tags.data ?? []).some((t) => t.name === clean)
          const toggle = (name: string) => onPatch(current.includes(name) ? { removeTags: [name] } : { addTags: [name] })
          return (
            <>
              {back('Tags')}
              <Input
                aria-label="Find or create a tag"
                placeholder="Find or create a tag"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="mb-1 h-11 text-[16px]"
              />
              {canCreate &&
                option('create', `Create “${clean}”`, <Plus className="size-6 shrink-0 text-fg-2" aria-hidden />, false, () => {
                  onPatch({ addTags: [clean] })
                  setFilter('')
                })}
              {options.map((t) => option(t.id, t.name, <span className="size-3 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />, current.includes(t.name), () => toggle(t.name)))}
            </>
          )
        })()}
      {view === 'snooze' && (
        <>
          {back('Snooze until')}
          {snoozePresets().map((p) => option(p.label, <>{p.label} <span className="text-[15px] text-fg-3">{p.hint}</span></>, <AlarmClock className="size-6 shrink-0 text-fg-2" aria-hidden />, false, () => pick({ snoozedUntil: p.at })))}
          {c.snoozedUntil && option('wake', 'Unsnooze now', <X className="size-6 shrink-0 text-fg-2" aria-hidden />, false, () => pick({ snoozedUntil: null }))}
        </>
      )}
      {view === 'move' && (
        <>
          {back('Move to mailbox')}
          {otherMailboxes.map((m) => option(m.id, m.name, <FolderInput className="size-6 shrink-0 text-fg-2" aria-hidden />, false, () => pick({ mailboxId: m.id })))}
        </>
      )}
    </div>
  )
}

export const StatusDot = ({ status }: { status: string }) => <span className={cx('size-2 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />

function snoozePresets(): { label: string; at: number; hint: string }[] {
  const now = new Date()
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0).getTime()
  const fmt = (ts: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ts)
  const untilMonday = (8 - now.getDay()) % 7 || 7
  const presets = [
    { label: 'In 3 hours', at: Date.now() + 3 * 3_600_000 },
    { label: 'Tomorrow morning', at: at(1, 9) },
    { label: 'In 3 days', at: at(3, 9) },
    { label: 'Next Monday', at: at(untilMonday, 9) },
  ]
  return presets.map((p) => ({ ...p, hint: fmt(p.at) }))
}

function SnoozeMenu({ snoozedUntil, onSnooze }: { snoozedUntil: number | null; onSnooze: (until: number | null) => void }) {
  const [custom, setCustom] = useState('')
  return (
    <Popover
      align="end"
      width={256}
      trigger={({ ref, ...props }) =>
        snoozedUntil ? (
          <button ref={ref} type="button" {...props} className={cx(pill, 'border-transparent bg-accent-soft text-accent-fg hover:bg-accent-soft')}>
            <AlarmClock className="size-4" aria-hidden />
            <span className="hidden sm:inline">Until {messageTime(snoozedUntil)}</span>
          </button>
        ) : (
          <button ref={ref} type="button" {...props} aria-label="Snooze" title="Snooze" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line text-fg-2 transition-colors hover:bg-sunken aria-expanded:bg-sunken">
            <AlarmClock className="size-4" aria-hidden />
          </button>
        )
      }
    >
      {(close) => (
        <>
          <MenuLabel>Hide until</MenuLabel>
          {snoozePresets().map((p) => (
            <MenuItem
              key={p.label}
              hint={p.hint}
              onSelect={() => {
                close()
                onSnooze(p.at)
              }}
            >
              {p.label}
            </MenuItem>
          ))}
          <MenuDivider />
          <form
            className="flex gap-1.5 p-1"
            onSubmit={(e) => {
              e.preventDefault()
              const ts = new Date(custom).getTime()
              if (ts > Date.now()) {
                close()
                onSnooze(ts)
              }
            }}
          >
            <Input type="datetime-local" aria-label="Custom date and time" className="h-8 px-2 text-[13px]" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <Button type="submit" variant="primary" disabled={!custom || new Date(custom).getTime() <= Date.now()}>
              Set
            </Button>
          </form>
          {snoozedUntil && (
            <>
              <MenuDivider />
              <MenuItem
                icon={<AlarmClock />}
                onSelect={() => {
                  close()
                  onSnooze(null)
                }}
              >
                Wake up now
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  )
}

function TagMenu({ current, hiddenCount, onAdd, onRemove }: { current: string[]; hiddenCount: number; onAdd: (name: string) => void; onRemove: (name: string) => void }) {
  const tags = useTags()
  const [filter, setFilter] = useState('')
  const clean = filter.trim().toLowerCase().replace(/\s+/g, '-')
  const options = (tags.data ?? []).filter((t) => t.name.includes(clean))
  const canCreate = clean && !(tags.data ?? []).some((t) => t.name === clean)
  return (
    <Popover
      width={230}
      onOpenChange={(open) => open && setFilter('')}
      trigger={({ ref, ...props }) => (
        <button ref={ref} type="button" {...props} aria-label="Add or remove tags" className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-dashed border-line-strong px-2 text-xs font-medium text-fg-3 transition-colors hover:border-fg-3 hover:text-fg aria-expanded:border-fg-3 aria-expanded:text-fg">
          <TagIcon className="size-3" aria-hidden />
          <span className={cx(current.length > 0 && 'lg:hidden')}>{current.length > 0 ? current.length : 'Add tag'}</span>
          {current.length > 0 && <span className="hidden lg:inline">{hiddenCount > 0 ? `+${hiddenCount}` : 'Add tag'}</span>}
        </button>
      )}
    >
      {() => (
        <>
          <div className="p-1">
            <Input
              autoFocus
              className="h-8"
              aria-label="Find or create a tag"
              placeholder="Find or create a tag"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !clean) return
                e.preventDefault()
                if (current.includes(clean)) onRemove(clean)
                else onAdd(clean)
                setFilter('')
              }}
            />
          </div>
          {options.map((t) => (
            <MenuItem
              key={t.id}
              icon={<span className="!size-2 rounded-full" style={{ background: t.color }} />}
              checked={current.includes(t.name)}
              onSelect={() => (current.includes(t.name) ? onRemove(t.name) : onAdd(t.name))}
            >
              {t.name}
            </MenuItem>
          ))}
          {canCreate && (
            <MenuItem
              icon={<Plus />}
              onSelect={() => {
                onAdd(clean)
                setFilter('')
              }}
            >
              Create “{clean}”
            </MenuItem>
          )}
          {options.length === 0 && !canCreate && <p className="px-3 py-3 text-center text-[13px] text-fg-3">Type a name to create your first tag.</p>}
        </>
      )}
    </Popover>
  )
}

// ---------------------------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------------------------

const CUSTOMER_COLOR = '#6fa3e8'
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dateThisYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const dateOtherYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
/** A message's date and time, as in Help Scout: "Nov 11, 4:33 PM" (with the year when it is not this year). */
const messageDate = (ts: number) => (new Date(ts).getFullYear() === new Date().getFullYear() ? dateThisYear : dateOtherYear).format(ts)
const dayKey = (ts: number) => new Date(ts).toDateString()
function dayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000)
  const short = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) }).format(date)
  return days === 0 ? `Today, ${short}` : days === 1 ? `Yesterday, ${short}` : short
}

function ThreadList({ conversation, composing, onCompose }: { conversation: Conversation; composing: boolean; onCompose: (mode: 'reply' | 'note') => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const lastId = conversation.threads[conversation.threads.length - 1]?.id
  // As in Gmail, what the team has not answered yet starts open (or just the newest message when everything is
  // answered), and older messages fold to a line. A failed or scheduled reply stays open: it needs a decision.
  // Click a name to open or fold one; the choices reset when another conversation opens.
  const defaultOpen = useMemo(() => {
    const messages = conversation.threads.filter((t) => t.type !== 'event')
    let answered = -1
    messages.forEach((t, i) => {
      if (t.type === 'reply' && (t.state === 'sent' || t.state === 'sending')) answered = i
    })
    const open = new Set(messages.slice(answered + 1).map((t) => t.id))
    if (open.size === 0 && messages.length > 0) open.add(messages[messages.length - 1].id)
    for (const t of messages) if (t.state === 'failed' || t.state === 'scheduled') open.add(t.id)
    return open
  }, [conversation.threads])
  const [toggled, setToggled] = useState<Map<number, boolean>>(() => new Map())
  const isOpen = (id: number) => toggled.get(id) ?? defaultOpen.has(id)
  // A long run of folded messages shrinks further: the first and last stay, the ones between become one
  // "N older messages" line, as in Gmail. Clicking it shows them all, still folded.
  const [showAll, setShowAll] = useState(false)
  const { hidden, pills } = useMemo(() => {
    const hidden = new Set<number>()
    const pills = new Map<number, number>() // the id of the first hidden thread → how many messages are hidden
    if (showAll) return { hidden, pills }
    const threads = conversation.threads
    let run: number[] = []
    const flush = () => {
      if (run.length >= 4) {
        for (let i = run[1]; i < run[run.length - 1]; i++) hidden.add(threads[i].id)
        pills.set(threads[run[1]].id, run.length - 2)
      }
      run = []
    }
    threads.forEach((t, i) => {
      if (t.type === 'event') return
      if (toggled.get(t.id) ?? defaultOpen.has(t.id)) flush()
      else run.push(i)
    })
    flush()
    return { hidden, pills }
  }, [conversation.threads, defaultOpen, toggled, showAll])
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    // Writing a reply: the end, so the newest message sits just above the composer.
    const messages = el.querySelectorAll<HTMLElement>('[data-message]')
    const newest = el.querySelector<HTMLElement>('[data-message][data-open]') ?? messages[messages.length - 1]
    if (composing || !newest) {
      el.scrollTop = el.scrollHeight
      return
    }
    // Reading: the start of the first open message (the newest one, unless the customer wrote more than once since
    // the last reply), as Help Scout does, not its signature at the bottom. A short
    // message cannot scroll that far, so it still ends up at the bottom as before.
    el.scrollTop = newest.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12
  }, [conversation.id, lastId, composing])

  // Expand all / Collapse all, as in Gmail: while any message is folded the button opens them all (and the
  // "N older messages" line with them); once all are open it folds them all again.
  const messageIds = conversation.threads.filter((t) => t.type !== 'event').map((t) => t.id)
  const anyFolded = messageIds.some((id) => !isOpen(id))
  const setAll = (open: boolean) => {
    setToggled(new Map(messageIds.map((id) => [id, open])))
    setShowAll(open)
  }
  let previous: Thread | undefined
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* On a phone, messages are cards on a light grey background, as in Help Scout's app. */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto bg-canvas px-3 md:bg-transparent md:px-6">
        {/* The extra bottom space keeps the last message clear of the floating buttons. */}
        <ol className={cx('mx-auto flex max-w-[860px] flex-col gap-3 pt-3 md:gap-4 md:pt-5', composing ? 'pb-4' : 'pb-4 md:pb-28')}>
          {messageIds.length > 1 && (
            <li className="-mb-1 flex justify-end md:-mb-2 md:px-14">
              <button
                type="button"
                onClick={() => setAll(anyFolded)}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg-3 transition-colors hover:bg-sunken hover:text-fg"
              >
                {anyFolded ? <ChevronsUpDown className="size-3.5" aria-hidden /> : <ChevronsDownUp className="size-3.5" aria-hidden />}
                {anyFolded ? 'Expand all' : 'Collapse all'}
              </button>
            </li>
          )}
          {conversation.threads.map((thread) => {
            const pill = pills.get(thread.id)
            if (hidden.has(thread.id) && !pill) return null
            if (pill)
              return (
                <li key={thread.id} className="flex items-center gap-3 md:px-14">
                  <span className="h-px flex-1 bg-line" aria-hidden />
                  <button type="button" onClick={() => setShowAll(true)} className="h-7 shrink-0 rounded-full border border-line bg-surface px-3 text-xs font-medium text-fg-2 transition-colors hover:bg-sunken hover:text-fg">
                    {pill} older {pill === 1 ? 'message' : 'messages'}
                  </button>
                  <span className="h-px flex-1 bg-line" aria-hidden />
                </li>
              )
            // A day line when the day changes from the message shown above, hidden ones aside.
            const newDay = previous === undefined || dayKey(thread.createdAt) !== dayKey(previous.createdAt)
            previous = thread
            return (
              <Fragment key={thread.id}>
                {newDay && (
                  <li className="flex items-center gap-3 text-xs text-fg-3 md:px-14">
                    <span className="h-px flex-1 bg-line" aria-hidden />
                    <time dateTime={new Date(thread.createdAt).toISOString().slice(0, 10)}>{dayLabel(thread.createdAt)}</time>
                    <span className="h-px flex-1 bg-line" aria-hidden />
                  </li>
                )}
                {thread.type === 'event' ? (
                  <EventLine thread={thread} />
                ) : (
                  <Message
                    thread={thread}
                    folded={!isOpen(thread.id)}
                    onToggle={() => setToggled((map) => new Map(map).set(thread.id, !isOpen(thread.id)))}
                  />
                )}
              </Fragment>
            )
          })}
          {conversation.draft && !composing && <DraftCard conversation={conversation} onEdit={() => onCompose(conversation.draft?.kind ?? 'reply')} />}
        </ol>
      </div>
      {!composing && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center gap-2.5 max-md:hidden">
          <button type="button" onClick={() => onCompose('reply')} className="pointer-events-auto flex h-11 min-w-[124px] items-center justify-center gap-2.5 rounded-[10px] bg-accent pr-3 pl-5 text-sm font-semibold text-white shadow-[0_6px_16px_-4px_rgba(34,31,92,0.45)] transition-colors hover:bg-accent-hover">
            Reply
            <kbd className="flex size-[22px] items-center justify-center rounded-md bg-white/20 font-sans text-xs font-semibold">R</kbd>
          </button>
          <button type="button" onClick={() => onCompose('note')} className="pointer-events-auto flex h-11 min-w-[124px] items-center justify-center gap-2.5 rounded-[10px] border border-note-line bg-note pr-3 pl-5 text-sm font-semibold text-note-fg shadow-[0_6px_16px_-6px_rgba(24,24,29,0.3)] transition-[filter] hover:brightness-[0.98]">
            Note
            <kbd className="flex size-[22px] items-center justify-center rounded-md bg-note-line/70 font-sans text-xs font-semibold">N</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

function eventText(thread: Thread): ReactNode {
  const e = thread.event ?? {}
  const who = thread.author.name
  switch (e.kind) {
    case 'status':
      return `${who} marked this ${e.to}`
    case 'assigned':
      return e.to ? `${who} assigned this to ${e.toName}` : `${who} removed the assignee`
    case 'snoozed':
      return `${who} snoozed this until ${messageTime(e.until)}`
    case 'unsnoozed':
      return e.auto ? 'Snooze ended' : `${who} ended the snooze`
    case 'moved':
      return `${who} moved this to ${e.toName}`
    case 'merged':
      return `${who} merged in #${e.fromId}${e.fromSubject ? ` “${e.fromSubject}”` : ''}`
    case 'customer':
      return `${who} changed the customer to ${e.toName}`
    default:
      return `${who} updated this conversation`
  }
}

function EventLine({ thread }: { thread: Thread }) {
  return (
    <li className="py-1 text-center text-[13px] text-fg-3 md:py-0.5 md:text-xs">
      {eventText(thread)} · <time title={fullTime(thread.createdAt)}>{timeOnly.format(thread.createdAt)}</time>
    </li>
  )
}

const KEEP_EMPTY = new Set(['IMG', 'HR', 'TABLE', 'VIDEO', 'AUDIO', 'IFRAME'])
const isBlank = (node: Node): boolean => {
  if (node.nodeType === Node.TEXT_NODE) return !(node.textContent || '').replace(/[\s ​‌]/g, '')
  if (node.nodeType !== Node.ELEMENT_NODE) return true
  const el = node as Element
  if (KEEP_EMPTY.has(el.tagName) || el.querySelector('img, hr, table')) return false
  return !(el.textContent || '').replace(/[\s ​‌]/g, '')
}
/**
 * Emails often end, and sometimes start, with empty lines. Drop them so every card has the same padding.
 * The HTML was cleaned by the server; it is parsed here in an inert template and nothing in it runs.
 */
function trimBlankEdges(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const trim = (parent: Node, edge: 'firstChild' | 'lastChild') => {
    for (let node = parent[edge]; node; node = parent[edge]) {
      if (isBlank(node)) parent.removeChild(node)
      else {
        if (node.nodeType === Node.ELEMENT_NODE && !KEEP_EMPTY.has((node as Element).tagName)) trim(node, edge)
        break
      }
    }
  }
  trim(template.content, 'lastChild')
  trim(template.content, 'firstChild')
  return template.innerHTML
}

/** "Nov 11 @ 8:38pm", in the teammate's time zone. */
function viewedLabel(ts: number, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(ts).map((x) => [x.type, x.value]))
  return `${p.month} ${p.day} @ ${p.hour}:${p.minute}${String(p.dayPeriod).toLowerCase()}`
}

/** The email as it arrived: the sender's plain-text version, and the raw source with every header. */
function OriginalDialog({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [tab, setTab] = useState<'text' | 'source'>('text')
  const original = useQuery({
    queryKey: ['original', thread.id],
    queryFn: () => api.get<{ available: boolean; text: string; source: string | null; headers: { name: string; value: string }[] }>(`/threads/${thread.id}/original`),
    staleTime: Infinity,
  })
  const header = (name: string) => original.data?.headers.find((h) => h.name.toLowerCase() === name)?.value
  return (
    <Modal
      open
      onClose={onClose}
      title="Original message"
      width={760}
      footer={
        <>
          {original.data?.available && (
            <a href={`/api/threads/${thread.id}/original.eml`} download className="mr-auto">
              <Button icon={<Download />}>Download .eml</Button>
            </a>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {original.isPending ? (
        <Spinner />
      ) : original.isError ? (
        <p className="text-[13px] text-danger">{(original.error as Error).message}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {original.data.available ? (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px]">
                {(['from', 'to', 'cc', 'date', 'subject'] as const).map((name) =>
                  header(name) ? (
                    <Fragment key={name}>
                      <dt className="text-fg-3 capitalize">{name}</dt>
                      <dd className="truncate" title={header(name)}>
                        {header(name)}
                      </dd>
                    </Fragment>
                  ) : null,
                )}
              </dl>
              <div role="tablist" aria-label="View" className="flex w-max gap-1 rounded-lg bg-sunken p-1">
                {(['text', 'source'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cx('h-7 rounded-md px-3 text-[13px] font-medium transition-colors', tab === id ? 'bg-surface text-fg shadow-card' : 'text-fg-2 hover:text-fg')}
                  >
                    {id === 'text' ? 'Plain text' : 'Source'}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="rounded-lg bg-sunken px-3 py-2 text-[13px] text-fg-2">This email arrived before originals were kept, so only its text is shown. Email received from now on keeps its original.</p>
          )}
          <pre
            className={cx(
              'max-h-[55vh] overflow-auto rounded-lg border border-line bg-sunken p-3 text-xs leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]',
              tab === 'source' && original.data.available ? 'font-mono' : 'font-sans text-[13px]',
            )}
          >
            {tab === 'source' && original.data.available ? original.data.source : original.data.text || 'No text in this message.'}
          </pre>
        </div>
      )}
    </Modal>
  )
}

/**
 * Your unsent draft, shown at the end of the conversation as in Help Scout: the reply box stays closed until
 * you choose Edit. Drafts are private, so only their writer sees this.
 */
function DraftCard({ conversation, onEdit }: { conversation: Conversation; onEdit: () => void }) {
  const { user } = useSession()
  const client = useQueryClient()
  const { toast } = useFeedback()
  const draft = conversation.draft!
  const isNote = draft.kind === 'note'
  const discard = async () => {
    try {
      await api.put(`/conversations/${conversation.id}/draft`, { kind: draft.kind, bodyHtml: '' })
      client.setQueryData(['conversation', conversation.id], (old: any) => (old ? { ...old, conversation: { ...old.conversation, draft: null } } : old))
      void client.invalidateQueries({ queryKey: ['conversations'] })
      toast('Draft discarded')
    } catch (err) {
      toast((err as Error).message, { kind: 'error' })
    }
  }
  return (
    <li className="relative md:px-14">
      <Avatar name={user.name} color={user.color} src={user.avatarUrl} size={40} className="absolute top-4 right-9 z-10 ring-4 ring-surface max-md:hidden" />
      <article aria-label={isNote ? 'Draft note' : 'Draft reply'} className={cx('relative rounded-[20px] border px-4 pt-4 pb-5 shadow-card md:rounded-xl md:px-12 md:pt-5 md:pb-6 md:shadow-none lg:px-20', isNote ? 'border-note-line bg-note' : 'border-line bg-surface')}>
        <span className="absolute top-2.5 bottom-2.5 left-2 w-[3px] rounded-full bg-accent" aria-hidden />
        <header className="flex items-center gap-2.5 border-b border-line pb-3">
          <span className="min-w-0 flex-1 truncate text-[17px] font-semibold md:text-sm">You</span>
          <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-fg">{isNote ? 'Draft note' : 'Draft'}</span>
          {draft.updatedAt && (
            <time className="shrink-0 text-[13px] text-fg-3 tabular-nums md:text-xs" title={fullTime(draft.updatedAt)}>
              {messageTime(draft.updatedAt)}
            </time>
          )}
        </header>
        <div className="prose-mail mt-4" dangerouslySetInnerHTML={{ __html: lineHtml(draft.bodyHtml) }} />
        <div className="mt-5 flex items-center gap-2">
          <Button onClick={onEdit}>Edit</Button>
          <Button variant="ghost" onClick={() => void discard()}>Discard</Button>
        </div>
      </article>
    </li>
  )
}

function Message({ thread, folded, onToggle }: { thread: Thread; folded: boolean; onToggle: () => void }) {
  const client = useQueryClient()
  const { toast, confirm } = useFeedback()
  const { user: me } = useSession()
  // A note can be deleted by its author or an admin.
  const canDelete = thread.type === 'note' && (me.role === 'admin' || (thread.author.kind === 'user' && thread.author.id === me.id))
  const deleteNote = async () => {
    const ok = await confirm({ title: 'Delete this note?', body: 'It is removed for the whole team, with its attachments. You cannot undo this.', confirmLabel: 'Delete note', danger: true })
    if (!ok) return
    try {
      await api.del(`/threads/${thread.id}`)
      void client.invalidateQueries({ queryKey: ['conversation'] })
      void client.invalidateQueries({ queryKey: ['conversations'] })
      toast('Note deleted')
    } catch (err) {
      toast((err as Error).message, { kind: 'error' })
    }
  }
  const [showQuoted, setShowQuoted] = useState(false)
  const quoted = useQuery({ queryKey: ['thread-full', thread.id], queryFn: () => api.get<{ html: string }>(`/threads/${thread.id}/full`).then((r) => r.html), enabled: showQuoted, staleTime: Infinity })
  const retry = useMutation({
    mutationFn: () => api.post(`/threads/${thread.id}/retry`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['conversation'] }),
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const scheduled = thread.state === 'scheduled'
  const act = useMutation({
    mutationFn: (what: 'send' | 'cancel') => (what === 'send' ? api.post(`/threads/${thread.id}/send-now`) : api.del(`/threads/${thread.id}/scheduled`)),
    onSuccess: (_data, what) => {
      void client.invalidateQueries({ queryKey: ['conversation'] })
      void client.invalidateQueries({ queryKey: ['conversations'] })
      toast(what === 'send' ? 'Reply sent' : 'Taken back. The text is in your draft.')
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const lightbox = useLightbox()
  const zone = useZone()
  const [original, setOriginal] = useState(false)
  // The customer's signature folds away behind "⋯", as in Help Scout.
  const [showSignature, setShowSignature] = useState(false)
  const isNote = thread.type === 'note'
  const isCustomer = thread.type === 'customer'
  const name = thread.author.name
  const color = thread.author.kind === 'user' ? thread.author.color : isCustomer ? CUSTOMER_COLOR : undefined
  const photo = thread.author.kind === 'user' ? thread.author.avatarUrl : null
  const files = thread.attachments.filter((a) => !a.inline)
  const text = useMemo(() => (folded ? stripTags(thread.bodyHtml) : ''), [folded, thread.bodyHtml])
  const html = useMemo(() => trimBlankEdges(showQuoted && quoted.data ? quoted.data : thread.bodyHtml), [showQuoted, quoted.data, thread.bodyHtml])
  const hasSignature = html.includes('ansa-signature')

  // The line under the name says where the message came from or went, and how.
  const meta: ReactNode[] = []
  const sender = thread.from || (thread.author.kind === 'customer' ? thread.author.email : '')
  if (isCustomer && sender) meta.push(<><span className="font-medium text-fg-2">From</span> {sender}</>)
  if (thread.type === 'reply' && thread.to.length > 0) meta.push(<><span className="font-medium text-fg-2">To</span> {thread.to.join(', ')}</>)
  if (!isNote && thread.cc.length > 0) meta.push(<><span className="font-medium text-fg-2">Cc</span> {thread.cc.join(', ')}</>)
  if (isNote) meta.push(<>Only your team sees this</>)
  // Open tracking, shown under the message, as Help Scout does.
  const viewed =
    thread.type === 'reply' && thread.openedAt ? (
      <p className="mt-5 flex items-center gap-2 text-[13px] text-fg-2" title={thread.openCount > 1 ? `Viewed ${thread.openCount} times` : undefined}>
        <MailOpen className="size-4 shrink-0" aria-hidden />
        Customer viewed on {viewedLabel(thread.openedAt, zone)}
      </p>
    ) : thread.type === 'reply' && thread.openLastAt ? (
      // Loaded, but only by something that looked like a mail scanner. Shown so a missing view can be explained.
      <p className="mt-5 flex items-center gap-2 text-[13px] text-fg-3" title={thread.openLastAgent ? `Loaded by: ${thread.openLastAgent}` : undefined}>
        <MailOpen className="size-4 shrink-0 opacity-60" aria-hidden />
        Image loaded {viewedLabel(thread.openLastAt, zone)}, not counted
      </p>
    ) : null
  const channel =
    thread.type === 'reply'
      ? thread.via === 'auto'
        ? 'Auto reply'
        : thread.event?.channel === 'chat'
          ? 'Sent in live chat'
          : thread.event?.channel === 'email'
            ? 'Emailed, the visitor had left the chat'
            : thread.via === 'email'
              ? 'Replied by email'
              : thread.via === 'mcp' || thread.via === 'api'
                ? 'Sent through the API'
                : ''
      : isCustomer && thread.via === 'chat'
        ? 'In live chat'
        : ''
  if (channel) meta.push(<>{channel}</>)
  // What the message did to the conversation at that moment: a customer message makes it active,
  // a reply sets the status the teammate chose when sending. An auto reply changes nothing.
  const sentStatus = isCustomer ? 'active' : thread.type === 'reply' && thread.via !== 'auto' ? (thread.event?.status as string | undefined) : undefined
  const how = isNote ? 'Note' : scheduled ? 'Not sent yet' : sentStatus ? (STATUS_LABEL[sentStatus] ?? '') : ''

  return (
    <li className="relative md:px-14" data-message data-open={folded ? undefined : ''}>
      {original && <OriginalDialog thread={thread} onClose={() => setOriginal(false)} />}
      {/* The avatar sits on the card's edge, half in and half out: left for the customer, right for the team.
          The ring is the page colour, so the card's border looks cut out around it. */}
      <Avatar name={name} color={color} src={photo} size={40} className={cx('absolute z-10 ring-4 ring-surface max-md:hidden', folded ? 'top-3' : 'top-4', isCustomer ? 'left-9' : 'right-9')} />
      <article
        aria-label={`${isNote ? 'Note' : 'Message'} from ${name}`}
        className={cx(
          // Wide side margins inside the card keep lines short and give the text room.
          'relative rounded-[20px] border px-4 shadow-card md:rounded-xl md:px-12 md:shadow-none lg:px-20',
          folded ? 'py-4' : 'pt-4 pb-5 md:pt-5 md:pb-6',
          isNote ? 'border-note-line bg-note' : 'border-line bg-surface',
          scheduled && 'border-dashed border-line-strong',
          thread.state === 'failed' && 'ring-1 ring-danger/50',
        )}
      >
        {/* A thin line down the left marks what the team wrote, as in Help Scout: from the name to the end of the
            message, not the "opened" line under it. It sits 6-10px in from the card's edge. */}
        <div className="relative">
        {!isCustomer && <span className={cx('absolute top-0 bottom-0 -left-2.5 w-0.5 rounded-full md:-left-[38px] lg:-left-[70px]', isNote ? 'bg-note-fg/30' : 'bg-line-strong')} aria-hidden />}
        <header>
          <div className="flex items-center gap-3 md:gap-2.5">
            <Avatar name={name} color={color} src={photo} size={36} className="md:hidden" />
            <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-baseline rounded text-left">
              <span className="truncate text-[17px] font-semibold md:text-[15px]">{name}</span>
            </button>
            {thread.state === 'sending' && <span className="shrink-0 text-xs text-fg-3">Sending…</span>}
            {scheduled && <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-fg">{thread.sendAt ? 'Scheduled' : 'On hold'}</span>}
            <time className={cx('shrink-0 text-[13px] tabular-nums', isNote ? 'text-note-fg' : 'text-fg-3')} title={fullTime(thread.createdAt)}>
              {messageDate(thread.createdAt)}
            </time>
            {((isCustomer && thread.via === 'email') || canDelete) && (
              <Popover
                align="end"
                width={200}
                trigger={({ ref, ...props }) => (
                  <button ref={ref} type="button" {...props} aria-label="Message actions" title="Message actions" className="-my-1 -mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg">
                    <Ellipsis className="size-4" aria-hidden />
                  </button>
                )}
              >
                {(close) =>
                  canDelete ? (
                    <MenuItem
                      icon={<Trash2 />}
                      danger
                      onSelect={() => {
                        close()
                        void deleteNote()
                      }}
                    >
                      Delete note
                    </MenuItem>
                  ) : (
                    <MenuItem
                      icon={<FileCode />}
                      onSelect={() => {
                        close()
                        setOriginal(true)
                      }}
                    >
                      Show original
                    </MenuItem>
                  )
                }
              </Popover>
            )}
          </div>
          {folded ? (
            <button type="button" onClick={onToggle} tabIndex={-1} className="mt-1 block w-full truncate text-left text-[13px] text-fg-3">
              {text || 'No message text'}
            </button>
          ) : (
            (meta.length > 0 || how) && (
              <div className={cx('mt-1 flex items-baseline gap-3 text-[13px]', isNote ? 'text-note-fg' : 'text-fg-3')}>
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {meta.map((part, index) => (
                    <Fragment key={index}>
                      {index > 0 && <span className="mx-1.5" aria-hidden>·</span>}
                      {part}
                    </Fragment>
                  ))}
                </p>
                {how && (
                  <span className="shrink-0" title={sentStatus ? `This message set the conversation to ${how.toLowerCase()}` : undefined}>
                    {how}
                  </span>
                )}
              </div>
            )
          )}
        </header>
        {!folded && (
          <div className={cx('mt-3 md:mt-4 md:border-t md:pt-5', isNote ? 'border-note-line' : 'border-line')}>
            {scheduled && (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent-fg">
                <Clock className="size-4 shrink-0" aria-hidden />
                <p className="min-w-40 flex-1">
                  {thread.sendAt ? (
                    <>
                      <span className="font-medium">Sends {zonedLabel(thread.sendAt, zone)}</span>
                      {thread.event?.ifNoReply ? ', unless the customer writes first.' : '.'} Then the conversation becomes {(STATUS_LABEL[thread.event?.status as string] ?? 'closed').toLowerCase()}.
                    </>
                  ) : (
                    <>
                      <span className="font-medium">Not sent.</span> The customer wrote before it was due.
                    </>
                  )}
                </p>
                <Button size="sm" loading={act.isPending && act.variables === 'send'} disabled={act.isPending} onClick={() => act.mutate('send')}>
                  Send now
                </Button>
                <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('cancel')}>
                  {thread.sendAt ? 'Cancel' : 'Back to draft'}
                </Button>
              </div>
            )}
            {thread.state === 'failed' && (
              <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">This reply was not sent.</p>
                  <p>{thread.error}</p>
                </div>
                <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()} icon={<RefreshCw className="size-3.5" aria-hidden />}>
                  Send again
                </Button>
              </div>
            )}
            <div
              className={cx('prose-mail [&_img]:cursor-zoom-in', hasSignature && !showSignature && 'hide-signature')}
              dangerouslySetInnerHTML={{ __html: html }}
              // A picture inside the message opens large too, unless it is a link.
              onClick={(e) => {
                const target = e.target as HTMLElement
                if (target instanceof HTMLImageElement && !target.closest('a')) lightbox(new URL(target.src).pathname.startsWith('/api/attachments/') ? new URL(target.src).pathname : target.src, { url: target.src, filename: target.alt || 'Image' })
              }}
            />
            {hasSignature && (
              <button
                type="button"
                onClick={() => setShowSignature((on) => !on)}
                aria-expanded={showSignature}
                aria-label={showSignature ? 'Hide signature' : 'Show signature'}
                title={showSignature ? 'Hide signature' : 'Show signature'}
                className="mt-2 flex h-6 items-center rounded-md bg-sunken px-2 text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              >
                <Ellipsis className="size-4" aria-hidden />
              </button>
            )}
            {thread.hasQuoted && (
              <button
                type="button"
                onClick={() => setShowQuoted((open) => !open)}
                aria-expanded={showQuoted}
                className={cx('mt-4 inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-fg-3 hover:text-fg', isNote ? 'bg-black/5 hover:bg-black/10 dark:bg-white/10' : 'bg-sunken hover:bg-hover')}
              >
                {quoted.isFetching ? 'Loading…' : showQuoted ? 'Hide quoted text' : 'Show quoted text'}
              </button>
            )}
            {files.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2">
                {files.map((file) => (
                  <AttachmentChip key={file.id} file={file} />
                ))}
              </ul>
            )}
          </div>
        )}
        </div>
        {!folded && viewed}
      </article>
    </li>
  )
}

const stripTags = (html: string) => {
  const el = document.createElement('div')
  el.innerHTML = html.replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ')
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function AttachmentChip({ file }: { file: Attachment }) {
  const lightbox = useLightbox()
  const isImage = isImageType(file.mime)
  const chip = 'group flex h-11 max-w-64 items-center gap-2.5 rounded-lg border border-line bg-surface pr-3 pl-1.5 text-left transition-colors hover:border-line-strong hover:bg-sunken'
  const label = (
    <span className="min-w-0">
      <span className="block truncate text-[13px] font-medium">{file.filename}</span>
      <span className="block text-xs text-fg-3">{fileSize(file.size)}</span>
    </span>
  )
  return (
    <li>
      {isImage ? (
        // Images open large over the page. Other files open in a new tab.
        <button type="button" onClick={() => lightbox(file.url)} aria-label={`View ${file.filename}`} className={chip}>
          <img src={file.url} alt="" className="size-8 rounded-md object-cover" loading="lazy" />
          {label}
          <Expand className="size-3.5 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
        </button>
      ) : (
        <a href={file.url} target="_blank" rel="noreferrer" className={chip}>
          <span className="flex size-8 items-center justify-center rounded-md bg-sunken text-fg-3">
            <FileText className="size-4" aria-hidden />
          </span>
          {label}
          <Download className="size-3.5 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        </a>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

function MergeDialog({ conversation, onClose, onMerged }: { conversation: Conversation; onClose: () => void; onMerged: (targetId: number) => void }) {
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<ConversationSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const term = useDebounced(query.trim(), 200)
  const results = useQuery({
    queryKey: ['merge-search', conversation.id, term],
    queryFn: () =>
      api
        .get<{ items: ConversationSummary[] }>(`/conversations${qs(term ? { q: term, limit: 8 } : { customer: conversation.customer.id, limit: 8 })}`)
        .then((r) => r.items.filter((c) => c.id !== conversation.id)),
  })
  const merge = useMutation({
    mutationFn: () => api.post(`/conversations/${conversation.id}/merge`, { intoId: target!.id }),
    onSuccess: () => onMerged(target!.id),
    onError: (err: Error) => setError(err.message),
  })
  return (
    <Modal
      open
      onClose={onClose}
      title="Merge into another conversation"
      description="Every message here moves into the conversation you pick. This one is then removed."
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!target} loading={merge.isPending} onClick={() => merge.mutate()}>
            {target ? `Merge into #${target.id}` : 'Merge'}
          </Button>
        </>
      }
    >
      {error && <p className="mb-3 text-[13px] text-danger">{error}</p>}
      <Input autoFocus aria-label="Search conversations" placeholder="Search by subject, customer or number" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto" role="listbox" aria-label="Conversations">
        {results.data?.length === 0 && <li className="py-6 text-center text-[13px] text-fg-3">{term ? 'No conversation matches.' : 'This customer has no other conversations. Search to find one.'}</li>}
        {results.data?.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              role="option"
              aria-selected={target?.id === c.id}
              onClick={() => setTarget(c)}
              className={cx('flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors', target?.id === c.id ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-sunken')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{c.subject}</span>
                <span className="block truncate text-xs text-fg-3">
                  #{c.id} · {c.customer.name} · {messageTime(c.updatedAt)}
                </span>
              </span>
              <StatusBadge status={c.status} />
              {target?.id === c.id && <Check className="size-4 text-accent-fg" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
