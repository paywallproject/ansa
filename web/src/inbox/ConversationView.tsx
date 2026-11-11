import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Ellipsis,
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
} from 'lucide-react'
import { api, qs } from '../lib/api'
import { fileSize, fullTime, messageTime, STATUS_LABEL } from '../lib/format'
import { useDebounced, useDocumentTitle, useHotkeys, useMailboxes, useSession, useTags, useUsers } from '../lib/hooks'
import type { Attachment, Conversation, ConversationSummary, Status, Thread, Viewer } from '../lib/types'
import { Avatar, Button, EmptyState, IconButton, Input, MenuDivider, MenuItem, MenuLabel, Modal, Popover, Spinner, StatusBadge, TagChip, cx, useFeedback } from '../ui'
import { Composer, type ComposerHandle } from './Composer'
import { CustomerPanel } from './CustomerPanel'

type Patch = Partial<{ status: Status; assigneeId: number | null; subject: string; addTags: string[]; removeTags: string[]; snoozedUntil: number | null; mailboxId: number }>

export function ConversationView({ id, onBack, onDone }: { id: number; onBack: () => void; onDone: () => void }) {
  const { user } = useSession()
  const client = useQueryClient()
  const navigate = useNavigate()
  const { toast, confirm } = useFeedback()
  const composer = useRef<ComposerHandle>(null)
  const [panel, setPanel] = useState(false)
  const [typing, setTyping] = useState(false)
  const [merging, setMerging] = useState(false)

  const query = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<{ conversation: Conversation; viewers: Viewer[] }>(`/conversations/${id}`),
  })
  const conversation = query.data?.conversation
  const livePresence = useQuery<Viewer[]>({ queryKey: ['presence', id], queryFn: () => query.data?.viewers ?? [], enabled: false })
  const viewers = (livePresence.data ?? query.data?.viewers ?? []).filter((v) => v.userId !== user.id)
  useDocumentTitle(conversation?.subject ?? '')

  // Tell teammates we are here, and whether we are writing a reply.
  useEffect(() => {
    const ping = () => void api.post(`/conversations/${id}/presence`, { state: typing ? 'replying' : 'viewing' }).catch(() => {})
    ping()
    const timer = setInterval(ping, 20_000)
    return () => clearInterval(timer)
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
          toast(`Marked as ${STATUS_LABEL[status].toLowerCase()}`, { action: { label: 'Undo', run: () => update.mutate({ status: previous }) } })
          if (status === 'closed' || status === 'spam') onDone()
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
        composer.current?.focus('reply')
      },
      n: (e) => {
        e.preventDefault()
        composer.current?.focus('note')
      },
      a: () => conversation && update.mutate({ assigneeId: conversation.assignee?.id === user.id ? null : user.id }),
      e: () => setStatus('closed'),
    },
    !!conversation,
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

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          conversation={conversation}
          viewers={viewers}
          busy={update.isPending}
          onBack={onBack}
          onPatch={(patch) => update.mutate(patch)}
          onStatus={setStatus}
          onDelete={() => void remove()}
          onMerge={() => setMerging(true)}
          onTogglePanel={() => setPanel((open) => !open)}
        />
        <ThreadList conversation={conversation} />
        <Composer
          key={conversation.id}
          ref={composer}
          conversation={conversation}
          agentName={user.name}
          othersReplying={viewers.filter((v) => v.state === 'replying')}
          onTyping={setTyping}
          onSent={(status) => status === 'closed' && onDone()}
        />
      </div>
      <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-line xl:block 2xl:w-80" aria-label="Customer">
        <CustomerPanel conversation={conversation} />
      </aside>
      {panel && (
        <div className="animate-fade fixed inset-0 z-30 flex justify-end bg-black/40 xl:hidden" onClick={() => setPanel(false)}>
          <aside className="h-full w-80 max-w-[88vw] overflow-y-auto bg-surface shadow-pop" onClick={(e) => e.stopPropagation()} aria-label="Customer">
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

const pill = 'inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 text-[13px] font-medium text-fg transition-colors hover:bg-sunken'

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
    <header className="shrink-0 border-b border-line px-4 pt-3 pb-3 md:px-6">
      <div className="flex items-start gap-2">
        <IconButton label="Back to the list" onClick={onBack} className="-ml-1.5">
          <ArrowLeft className="size-4.5" />
        </IconButton>
        <div className="min-w-0 flex-1">
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
              className="h-8 text-base font-semibold"
            />
          ) : (
            <h1 className="text-[17px] leading-7 font-semibold tracking-tight">
              <button type="button" onClick={() => setEditing(true)} title="Edit subject" className="rounded text-left hover:bg-sunken">
                {c.subject}
              </button>
              <span className="ml-2 text-sm font-normal text-fg-3 tabular-nums">#{c.id}</span>
            </h1>
          )}
        </div>
        {viewers.length > 0 && (
          <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-warn-soft py-0.5 pr-2.5 pl-1 text-xs font-medium text-warn" role="status">
            <span className="flex -space-x-1.5">
              {viewers.slice(0, 3).map((v) => (
                <Avatar key={v.userId} name={v.name} color={v.color} size={20} className="ring-2 ring-warn-soft" />
              ))}
            </span>
            <span className="hidden sm:inline">
              {viewers.length === 1 ? viewers[0].name.split(' ')[0] : `${viewers.length} people`} {viewers.some((v) => v.state === 'replying') ? 'replying' : 'viewing'}
            </span>
          </div>
        )}
        <IconButton label="Customer details" onClick={onTogglePanel} className="xl:hidden">
          <PanelRight className="size-4.5" />
        </IconButton>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Popover
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className={pill} aria-label={`Status: ${STATUS_LABEL[c.status]}`} disabled={busy}>
              <StatusDot status={c.status} />
              {STATUS_LABEL[c.status]}
              <ChevronDown className="size-3.5 text-fg-3" aria-hidden />
            </button>
          )}
        >
          {(close) =>
            (['active', 'pending', 'closed'] as Status[]).map((status) => (
              <MenuItem
                key={status}
                icon={<StatusDot status={status} />}
                checked={c.status === status}
                onSelect={() => {
                  close()
                  onStatus(status)
                }}
              >
                {STATUS_LABEL[status]}
              </MenuItem>
            ))
          }
        </Popover>

        <Popover
          width={230}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className={pill} aria-label={`Assignee: ${c.assignee?.name ?? 'nobody'}`}>
              {c.assignee ? <Avatar name={c.assignee.name} color={c.assignee.color} size={18} /> : <UserRound className="size-3.5 text-fg-3" aria-hidden />}
              {c.assignee?.name ?? 'Unassigned'}
              <ChevronDown className="size-3.5 text-fg-3" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuLabel>Assign to</MenuLabel>
              {(users.data ?? [])
                .filter((u) => !u.disabled)
                .map((u) => (
                  <MenuItem
                    key={u.id}
                    icon={<Avatar name={u.name} color={u.color} size={18} />}
                    checked={c.assignee?.id === u.id}
                    onSelect={() => {
                      close()
                      onPatch({ assigneeId: u.id })
                    }}
                  >
                    {u.name}
                  </MenuItem>
                ))}
              <MenuDivider />
              <MenuItem
                icon={<UserRound />}
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

        <SnoozeMenu snoozedUntil={c.snoozedUntil} onSnooze={(until) => onPatch({ snoozedUntil: until })} />

        {c.tags.map((tag) => (
          <TagChip key={tag.id} name={tag.name} color={tag.color} onRemove={() => onPatch({ removeTags: [tag.name] })} />
        ))}
        <TagMenu current={c.tags.map((t) => t.name)} onAdd={(name) => onPatch({ addTags: [name] })} onRemove={(name) => onPatch({ removeTags: [name] })} />

        <div className="flex-1" />
        <Popover
          align="end"
          width={220}
          trigger={({ ref, ...props }) => (
            <IconButton ref={ref} {...props} label="More actions" size="sm">
              <Ellipsis className="size-4" />
            </IconButton>
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
      </div>
    </header>
  )
}

const DOT: Record<string, string> = { active: 'bg-ok', pending: 'bg-warn', closed: 'bg-fg-3', spam: 'bg-danger' }
export const StatusDot = ({ status }: { status: string }) => <span className={cx('size-2 shrink-0 rounded-full', DOT[status])} aria-hidden />

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
      width={250}
      trigger={({ ref, ...props }) =>
        snoozedUntil ? (
          <button ref={ref} type="button" {...props} className={cx(pill, 'border-transparent bg-accent-soft text-accent-fg hover:bg-accent-soft')}>
            <AlarmClock className="size-3.5" aria-hidden />
            Until {messageTime(snoozedUntil)}
          </button>
        ) : (
          <button ref={ref} type="button" {...props} className={cx(pill, 'text-fg-2')}>
            <AlarmClock className="size-3.5 text-fg-3" aria-hidden />
            Snooze
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

function TagMenu({ current, onAdd, onRemove }: { current: string[]; onAdd: (name: string) => void; onRemove: (name: string) => void }) {
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
        <button ref={ref} type="button" {...props} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg">
          <TagIcon className="size-3.5" aria-hidden />
          {current.length === 0 && 'Add tag'}
          {current.length > 0 && <Plus className="size-3" aria-label="Add tag" />}
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

function ThreadList({ conversation }: { conversation: Conversation }) {
  const scroller = useRef<HTMLDivElement>(null)
  const messages = conversation.threads.filter((t) => t.type !== 'event')
  const lastId = conversation.threads[conversation.threads.length - 1]?.id
  // Long threads start with older messages folded so the latest exchange is on screen.
  const initiallyFolded = useMemo(() => new Set(messages.length > 4 ? messages.slice(0, -3).map((t) => t.id) : []), [conversation.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [folded, setFolded] = useState(initiallyFolded)
  useEffect(() => setFolded(initiallyFolded), [initiallyFolded])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversation.id, lastId])

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
      <ol className="mx-auto flex max-w-3xl flex-col gap-3">
        {conversation.threads.map((thread) =>
          thread.type === 'event' ? (
            <EventLine key={thread.id} thread={thread} />
          ) : (
            <Message
              key={thread.id}
              thread={thread}
              folded={folded.has(thread.id)}
              onToggle={() =>
                setFolded((set) => {
                  const next = new Set(set)
                  if (next.has(thread.id)) next.delete(thread.id)
                  else next.add(thread.id)
                  return next
                })
              }
            />
          ),
        )}
      </ol>
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
    <li className="flex items-center gap-3 py-0.5 text-xs text-fg-3">
      <span className="h-px flex-1 bg-line" aria-hidden />
      <span>
        {eventText(thread)} · <time title={fullTime(thread.createdAt)}>{messageTime(thread.createdAt)}</time>
      </span>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </li>
  )
}

function Message({ thread, folded, onToggle }: { thread: Thread; folded: boolean; onToggle: () => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [showQuoted, setShowQuoted] = useState(false)
  const quoted = useQuery({ queryKey: ['thread-full', thread.id], queryFn: () => api.get<{ html: string }>(`/threads/${thread.id}/full`).then((r) => r.html), enabled: showQuoted, staleTime: Infinity })
  const retry = useMutation({
    mutationFn: () => api.post(`/threads/${thread.id}/retry`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['conversation'] }),
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const isNote = thread.type === 'note'
  const isCustomer = thread.type === 'customer'
  const name = thread.author.name
  const color = thread.author.kind === 'user' ? thread.author.color : undefined
  const verb = isNote ? 'added a note' : thread.type === 'reply' ? (thread.via === 'auto' ? 'sent automatically' : 'replied') : ''
  const files = thread.attachments.filter((a) => !a.inline)
  const text = useMemo(() => (folded ? stripTags(thread.bodyHtml) : ''), [folded, thread.bodyHtml])
  const html = showQuoted && quoted.data ? quoted.data : thread.bodyHtml

  return (
    <li
      className={cx(
        'rounded-xl border',
        isNote ? 'border-note-line bg-note' : isCustomer ? 'border-line bg-surface shadow-card' : 'border-line bg-sunken/60',
        thread.state === 'failed' && 'border-danger/50',
      )}
    >
      <article aria-label={`${isNote ? 'Note' : 'Message'} from ${name}`}>
        <header className={cx('flex items-center gap-2.5 px-4', folded ? 'py-2.5' : 'pt-3')}>
          <Avatar name={name} color={color} size={28} />
          <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded text-left">
            <span className="shrink-0 text-[13px] font-semibold">{name}</span>
            {verb && <span className={cx('shrink-0 text-[13px]', isNote ? 'text-note-fg' : 'text-fg-3')}>{verb}</span>}
            {folded && <span className="min-w-0 flex-1 truncate text-[13px] text-fg-3">{text}</span>}
          </button>
          {thread.state === 'sending' && <span className="shrink-0 text-xs text-fg-3">Sending…</span>}
          <time className="shrink-0 text-xs text-fg-3" title={fullTime(thread.createdAt)}>
            {messageTime(thread.createdAt)}
          </time>
        </header>
        {!folded && (
          <div className="px-4 pt-1 pb-3.5 pl-[54px]">
            {!isNote && (thread.cc.length > 0 || (thread.type === 'reply' && thread.to.length > 0)) && (
              <p className="mb-2 text-xs text-fg-3">
                {thread.type === 'reply' && thread.to.length > 0 && <>To {thread.to.join(', ')}</>}
                {thread.cc.length > 0 && (
                  <>
                    {thread.type === 'reply' && thread.to.length > 0 ? ' · ' : ''}Cc {thread.cc.join(', ')}
                  </>
                )}
              </p>
            )}
            {thread.state === 'failed' && (
              <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
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
            <div className="prose-mail" dangerouslySetInnerHTML={{ __html: html }} />
            {thread.hasQuoted && (
              <button
                type="button"
                onClick={() => setShowQuoted((open) => !open)}
                aria-expanded={showQuoted}
                className="mt-2 inline-flex h-5 items-center rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-3 hover:bg-hover hover:text-fg"
              >
                {quoted.isFetching ? 'Loading…' : showQuoted ? 'Hide quoted text' : 'Show quoted text'}
              </button>
            )}
            {files.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {files.map((file) => (
                  <AttachmentChip key={file.id} file={file} />
                ))}
              </ul>
            )}
          </div>
        )}
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
  const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(file.mime)
  return (
    <li>
      <a
        href={file.url}
        target="_blank"
        rel="noreferrer"
        className="group flex h-11 max-w-64 items-center gap-2.5 rounded-lg border border-line bg-surface pr-3 pl-1.5 transition-colors hover:border-line-strong hover:bg-sunken"
      >
        {isImage ? (
          <img src={file.url} alt="" className="size-8 rounded-md object-cover" loading="lazy" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-md bg-sunken text-fg-3">
            <FileText className="size-4" aria-hidden />
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{file.filename}</span>
          <span className="block text-xs text-fg-3">{fileSize(file.size)}</span>
        </span>
        <Download className="size-3.5 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </a>
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
