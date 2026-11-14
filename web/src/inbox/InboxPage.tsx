import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpDown, Archive, Check, ChevronDown, Clock, Eye, Inbox, PenLine, SquareCheckBig, MessageCircle, Minus, Paperclip, Search, StickyNote, UserRoundCheck } from 'lucide-react'
import { api, qs } from '../lib/api'
import { plural, shortTime, STATUS_LABEL } from '../lib/format'
import { canSee } from '../lib/access'
import { useDebounced, useDocumentTitle, useHotkeys, useLocalState, useMailboxes, useSession, useViewers } from '../lib/hooks'
import type { ConversationSummary, Folder, Viewer } from '../lib/types'
import { Avatar, Button, EmptyState, IconButton, Input, MenuItem, Popover, Spinner, StatusBadge, cx, useFeedback } from '../ui'
import { FOLDERS, useShell, visibleFolders } from '../Shell'
import { Logo } from '../pages/Auth'
import { workspace } from '../lib/workspace'
import { ConversationView } from './ConversationView'
import { SwipeRow } from './SwipeRow'
import { SelectionBar, type BulkPayload } from './SelectionBar'

type Sort = 'recent' | 'waiting' | 'oldest'
const SORTS: Record<Sort, string> = { recent: 'Newest activity', waiting: 'Longest waiting', oldest: 'Oldest activity' }
const PAGE = 40

const EMPTY: Record<Folder, { title: string; body: string }> = {
  unassigned: { title: 'All caught up', body: 'New conversations that nobody owns yet show up here.' },
  mine: { title: 'Nothing on your plate', body: 'Conversations assigned to you show up here.' },
  pending: { title: 'Nothing is waiting on a customer', body: 'Conversations you answered and set to “Waiting on customer” stay here until the customer writes back.' },
  mentioned: { title: 'No mentions', body: 'Open conversations where a teammate mentioned you in a note show up here.' },
  assigned: { title: 'Nothing assigned', body: 'Open conversations that have an owner show up here.' },
  snoozed: { title: 'Nothing snoozed', body: 'Snooze a conversation to hide it until you need it.' },
  closed: { title: 'No closed conversations', body: 'Conversations you close are kept here.' },
  spam: { title: 'No spam', body: 'Conversations marked as spam are kept here.' },
  all: { title: 'No conversations yet', body: 'Every conversation in this mailbox shows up here.' },
}

export function InboxPage({ search = false }: { search?: boolean }) {
  const params = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { user } = useSession()
  const { toast, confirm } = useFeedback()
  const mailboxes = useMailboxes()
  const [searchParams, setSearchParams] = useSearchParams()
  const mailboxId = Number(params.mailboxId) || undefined
  const folder = (params.folder as Folder) || 'all'
  const selectedId = Number(params.conversationId) || null
  const q = searchParams.get('q') ?? ''
  const [draftQuery, setDraftQuery] = useState(q)
  const shell = useShell()
  // Phone: the folder list dropped down from the title, or null. The number is where it starts (under the header).
  const [folderPanel, setFolderPanel] = useState<number | null>(null)
  // On a phone the checkboxes hide until you choose Select, as in Help Scout's app.
  const [selecting, setSelecting] = useState(false)
  const debouncedQuery = useDebounced(draftQuery, 300)
  const [sort, setSort] = useLocalState<Sort>('ansa-sort', 'recent')
  const [checked, setChecked] = useState<Set<number>>(new Set())

  const mailbox = mailboxes.data?.find((m) => m.id === mailboxId)
  const folderInfo = FOLDERS.find((f) => f.id === folder)
  const base = search ? '/search' : `/m/${mailboxId}/${folder}`
  const suffix = search && q ? qs({ q }) : ''
  useDocumentTitle(search ? `Search: ${q}` : selectedId ? '' : `${folderInfo?.label ?? 'Conversations'}${mailbox ? ` · ${mailbox.name}` : ''}`)

  useEffect(() => {
    if (search && debouncedQuery !== q) setSearchParams(debouncedQuery ? { q: debouncedQuery } : {}, { replace: true })
  }, [debouncedQuery]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setChecked(new Set()), [base, q])

  const view = search ? { q, sort } : { mailbox: mailboxId, folder, sort }
  const list = useInfiniteQuery({
    queryKey: ['conversations', view],
    queryFn: ({ pageParam }) => api.get<{ items: ConversationSummary[]; total: number }>(`/conversations${qs({ ...view, limit: PAGE, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (pages.length * PAGE < last.total ? pages.length * PAGE : undefined),
    enabled: search ? q.trim().length > 0 : !!mailboxId,
    placeholderData: (previous, previousQuery) => (previousQuery && JSON.stringify(previousQuery.queryKey[1]) === JSON.stringify(view) ? previous : undefined),
  })
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const total = list.data?.pages[0]?.total ?? 0

  const open = (id: number | null) => navigate(id ? `${base}/${id}${suffix}` : `${base}${suffix}`)
  const step = (delta: number) => {
    if (items.length === 0) return
    const index = items.findIndex((c) => c.id === selectedId)
    const next = items[index === -1 ? 0 : Math.min(items.length - 1, Math.max(0, index + delta))]
    if (next && next.id !== selectedId) open(next.id)
  }
  /** After closing a conversation, go back to the list, as in Help Scout, with a way to look at it again. */
  const done = (message: string, undo?: () => void) => {
    const id = selectedId
    open(null)
    toast(message, { action: undo ? { label: 'Undo', run: undo } : id ? { label: 'View', run: () => open(id) } : undefined })
  }
  useHotkeys({ j: () => step(1), k: () => step(-1), escape: () => selectedId && !document.querySelector('[role=dialog], [role=menu]') && open(null) })

  const bulk = useMutation({
    mutationFn: ({ keep: _keep, ...payload }: BulkPayload) => api.post('/conversations/bulk', { ids: [...checked], ...payload }),
    onSuccess: (_data, payload) => {
      toast(`${plural(checked.size, 'conversation')} ${payload.delete ? 'deleted' : 'updated'}`)
      if (!payload.keep) setChecked(new Set())
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      void client.invalidateQueries({ queryKey: ['conversation'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  // With conversations selected in the list, the status shortcuts act on all of them, as in an open conversation.
  const setSelectedStatus = (status: string) => !bulk.isPending && bulk.mutate({ patch: { status } })
  useHotkeys(
    {
      e: () => setSelectedStatus('closed'),
      's c': () => setSelectedStatus('closed'),
      's p': () => setSelectedStatus('pending'),
      's a': () => setSelectedStatus('active'),
    },
    checked.size > 0 && !selectedId,
  )

  // Swipe a row on a phone: close it, or take it. Undo puts it back.
  const quick = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown>; undo: Record<string, unknown>; message: string }) => api.patch(`/conversations/${id}`, patch),
    onSuccess: (_data, { id, undo, message }) => {
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      void client.invalidateQueries({ queryKey: ['conversation', id] })
      toast(message, { action: { label: 'Undo', run: () => quick.mutate({ id, patch: undo, undo: {}, message: 'Undone' }) } })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const swipeClose = (c: ConversationSummary) => quick.mutate({ id: c.id, patch: { status: 'closed' }, undo: { status: c.status }, message: 'Closed' })
  const swipeAssign = (c: ConversationSummary) => {
    const mine = c.assignee?.id === user.id
    quick.mutate({ id: c.id, patch: { assigneeId: mine ? null : user.id }, undo: { assigneeId: c.assignee?.id ?? null }, message: mine ? 'Unassigned' : 'Assigned to you' })
  }

  const bulkDelete = async () => {
    const ok = await confirm({ title: `Delete ${plural(checked.size, 'conversation')}?`, body: 'Their messages, notes and attachments are removed for the whole team. You cannot undo this.', confirmLabel: 'Delete', danger: true })
    if (ok) bulk.mutate({ delete: true })
  }

  if (!search && mailboxes.data && !mailbox) return <Navigate to="/" replace />
  if (!search && !FOLDERS.some((f) => f.id === folder) && folder !== 'all') return <Navigate to={`/m/${mailboxId}/unassigned`} replace />

  const toggle = (id: number) =>
    setChecked((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const needsMail = !search && mailbox && !mailbox.imapEnabled && total === 0 && folder === 'unassigned'

  if (selectedId) {
    return <ConversationView key={selectedId} id={selectedId} onBack={() => open(null)} onDone={done} />
  }

  const openFolder = !search && ['unassigned', 'mine', 'mentioned', 'assigned'].includes(folder)
  const allChecked = items.length > 0 && items.every((c) => checked.has(c.id))
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(items.map((c) => c.id)))

  return (
    <section className="relative flex h-full flex-col" aria-label="Conversations">
      {checked.size > 0 && (
        <SelectionBar
          selected={items.filter((c) => checked.has(c.id))}
          mailboxId={mailboxId}
          pending={bulk.isPending}
          onBulk={(payload) => !bulk.isPending && bulk.mutate(payload)}
          onDelete={() => void bulkDelete()}
          onClear={() => setChecked(new Set())}
        />
      )}
      {(
        <div className="flex h-11 shrink-0 items-center gap-2 px-2 md:h-14 md:border-b md:border-line md:px-5">
          {/* Phone: the logo opens the drawer (inboxes, search, settings), as in Help Scout's app. */}
          {!search && (
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => {
                // The folder panel would otherwise stay open on top of part of the drawer.
                setFolderPanel(null)
                shell.openDrawer()
              }}
              className="flex size-10 shrink-0 items-center justify-center rounded-lg md:hidden"
            >
              <Logo size={28} />
            </button>
          )}
          {search ? (
            <div className="relative max-w-xl flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-3" aria-hidden />
              <Input autoFocus aria-label="Search conversations" placeholder="Search conversations" className="h-9 pl-8" value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} />
            </div>
          ) : (
            <>
              <h1 className="min-w-0 truncate text-[15px] font-semibold phone:hidden">{folderInfo?.label ?? 'All conversations'}</h1>
              {/* On a phone: the folder, its count and a switcher, centred, as in Help Scout's app. */}
              {mailbox && (
                <div className="flex min-w-0 flex-1 justify-center md:hidden">
                  <button
                    type="button"
                    aria-expanded={folderPanel !== null}
                    onClick={(e) => setFolderPanel(folderPanel === null ? (e.currentTarget.closest('div.flex.h-11')?.getBoundingClientRect().bottom ?? 56) : null)}
                    className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[17px] font-semibold"
                  >
                    <span className="truncate">{folderInfo?.label ?? 'All conversations'}</span>
                    {folderInfo?.countKey && mailbox.counts[folderInfo.countKey] > 0 && <span className="font-normal text-fg-3 tabular-nums">({mailbox.counts[folderInfo.countKey]})</span>}
                    <ChevronDown className={cx('size-4 shrink-0 text-fg-3 transition-transform', folderPanel !== null && 'rotate-180')} aria-hidden />
                  </button>
                  {/* The folders drop down over the list, full width, as in Help Scout's app. */}
                  {folderPanel !== null && (
                    <div className="safe-x animate-fade fixed inset-x-0 bottom-0 z-[25] flex flex-col bg-surface" style={{ top: folderPanel }} role="dialog" aria-label="Folders">
                      <p className="pt-2 pb-5 text-center text-[14px] text-fg-3">{mailbox.name}</p>
                      <nav className="min-h-0 flex-1 overflow-y-auto">
                        {visibleFolders().map((f) => {
                          const count = f.countKey ? mailbox.counts[f.countKey] : 0
                          const active = f.id === folder
                          return (
                            <button
                              key={f.id}
                              type="button"
                              onClick={() => {
                                setFolderPanel(null)
                                navigate(`/m/${mailbox.id}/${f.id}`)
                              }}
                              className={cx('flex h-[52px] w-full items-center gap-4 px-5 text-left text-[18px] active:bg-sunken', active ? 'font-semibold text-accent' : 'text-fg')}
                            >
                              <f.icon className="size-6 shrink-0" aria-hidden />
                              <span className="flex-1">{f.label}</span>
                              {count > 0 && f.id !== 'spam' && <span className={cx('text-[17px] tabular-nums', active ? 'font-semibold text-accent' : 'text-fg-3')}>{count}</span>}
                            </button>
                          )
                        })}
                      </nav>
                      <div className="px-4 pt-3 pb-[calc(1rem+var(--safe-bottom))]">
                        <button
                          type="button"
                          onClick={() => {
                            setFolderPanel(null)
                            shell.compose({ mailboxId: mailbox.id })
                          }}
                          className="flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-sunken text-[17px] font-medium text-accent active:bg-hover"
                        >
                          <PenLine className="size-5" aria-hidden />
                          New conversation
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <span className="flex-1 phone:hidden" />
          <IconButton label={selecting ? 'Done selecting' : 'Select conversations'} size="sm" active={selecting} onClick={() => {
              if (selecting) setChecked(new Set())
              setSelecting(!selecting)
            }} className="md:hidden">
            <SquareCheckBig className="size-4" />
          </IconButton>
          <Popover
            align="end"
            trigger={({ ref, ...props }) => (
              <IconButton ref={ref} {...props} label={`Sort: ${SORTS[sort]}`} size="sm">
                <ArrowUpDown className="size-4" />
              </IconButton>
            )}
          >
            {(close) =>
              (Object.keys(SORTS) as Sort[]).map((s) => (
                <MenuItem
                  key={s}
                  checked={sort === s}
                  onSelect={() => {
                    setSort(s)
                    close()
                  }}
                >
                  {SORTS[s]}
                </MenuItem>
              ))
            }
          </Popover>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto phone:pb-[var(--safe-bottom)]">
        {list.isPending && list.fetchStatus !== 'idle' ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : list.isError ? (
          <EmptyState title="Could not load conversations" body={(list.error as Error).message} action={<Button onClick={() => void list.refetch()}>Try again</Button>} />
        ) : search && !q.trim() ? (
          <EmptyState icon={<Search />} title="Search every conversation" body="Find words in subjects, messages and notes, or a customer by name or email." />
        ) : items.length === 0 ? (
          search ? (
            <EmptyState icon={<Search />} title="No results" body={`Nothing matches “${q}”. Check the spelling or try fewer words.`} />
          ) : needsMail ? (
            <EmptyState
              icon={<Inbox />}
              title="This mailbox is not receiving email yet"
              body={user.role === 'admin' ? 'Connect it to your email account to start receiving conversations.' : 'Ask an admin to connect it to your email account.'}
              action={
                user.role === 'admin' ? (
                  <Link to={`/settings/mailboxes/${mailbox.id}`}>
                    <Button variant="primary">Connect email</Button>
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <EmptyState icon={folderInfo ? <folderInfo.icon /> : <Inbox />} title={EMPTY[folder]?.title ?? 'Nothing here'} body={EMPTY[folder]?.body} />
          )
        ) : (
          <>
            <div className="sticky top-0 z-20 hidden h-10 items-center border-b border-line bg-surface text-xs text-fg-3 md:flex">
              <div className="flex w-12 shrink-0 justify-center">
                <CheckBox checked={allChecked} mixed={!allChecked && checked.size > 0} label="Select all conversations" onClick={toggleAll} />
              </div>
              <div className={cx(COLS, 'flex-1 pr-5')}>
                <span>Customer</span>
                <span>Conversation</span>
                <span />
                <span>Number</span>
                <span>{openFolder ? 'Waiting' : 'Last updated'}</span>
              </div>
            </div>
            <ul>
              {items.map((c, index) => (
                <Fragment key={c.id}>
                  {/* Pending conversations sort last. A divider marks where "our turn" ends and "their turn" begins. */}
                  {c.status === 'pending' && index > 0 && items[index - 1].status !== 'pending' && (
                    <li className="flex items-center gap-2 border-b border-line bg-sunken px-4 py-1.5 text-xs font-medium text-fg-3 md:px-5" role="separator">
                      <Clock className="size-3.5" aria-hidden />
                      {STATUS_LABEL.pending === 'Pending' ? 'Pending · waiting on the customer' : STATUS_LABEL.pending}
                    </li>
                  )}
                  <Row
                    conversation={c}
                    to={`${base}/${c.id}${suffix}`}
                    checked={checked.has(c.id)}
                    onCheck={() => toggle(c.id)}
                    showMailbox={search}
                    selecting={selecting || checked.size > 0}
                    folder={search ? null : folder}
                    onSwipeClose={c.status === 'closed' ? undefined : () => swipeClose(c)}
                    onSwipeAssign={canSee(user, c.mailboxId) ? () => swipeAssign(c) : undefined}
                  />
                </Fragment>
              ))}
            </ul>
            {list.hasNextPage ? (
              <div className="flex justify-center p-4">
                <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  Show more
                </Button>
              </div>
            ) : (
              <p className="px-4 py-4 text-[13px] text-fg-3 md:px-5">
                <span className="font-semibold text-fg-2 tabular-nums">{total.toLocaleString()}</span> {total === 1 ? 'conversation' : 'conversations'}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** Column template shared by the header and every row, from the md breakpoint up. */
const COLS = 'md:grid md:grid-cols-[minmax(110px,194px)_minmax(0,1fr)_auto_64px_92px] md:items-center md:gap-x-4'

function CheckBox({ checked, mixed, label, onClick }: { checked: boolean; mixed?: boolean; label: string; onClick: () => void }) {
  const on = checked || mixed
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      onClick={onClick}
      className={cx('flex size-4 items-center justify-center rounded-[4px] border text-white transition-colors', on ? 'border-accent bg-accent' : 'border-line-strong bg-surface hover:border-fg-3')}
    >
      {checked ? <Check className="size-3" strokeWidth={3} aria-hidden /> : mixed ? <Minus className="size-3" strokeWidth={3} aria-hidden /> : null}
    </button>
  )
}

/** Teammates in this conversation right now. A pencil means one of them is writing a reply. */
function ViewersBadge({ viewers }: { viewers: Viewer[] }) {
  const replying = viewers.filter((v) => v.state === 'replying')
  const first = (v: Viewer) => v.name.split(' ')[0]
  const label = replying.length
    ? `${replying.map(first).join(', ')} ${replying.length === 1 ? 'is' : 'are'} replying`
    : `${viewers.map(first).join(', ')} ${viewers.length === 1 ? 'is' : 'are'} viewing`
  return (
    <span className={cx('inline-flex h-5 shrink-0 items-center gap-1 rounded-full pr-1.5 pl-0.5 text-xs font-medium', replying.length ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent-fg')} title={label} role="status" aria-label={label}>
      <span className="flex -space-x-1">
        {viewers.slice(0, 3).map((v) => (
          <Avatar key={v.userId} name={v.name} color={v.color} src={v.avatarUrl} size={16} className={cx('ring-2', replying.length ? 'ring-warn-soft' : 'ring-accent-soft')} />
        ))}
      </span>
      {replying.length ? <PenLine className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
      <span className="hidden lg:inline">{replying.length ? first(replying[0]) : first(viewers[0])}</span>
    </span>
  )
}

function Row({
  conversation: c,
  to,
  checked,
  onCheck,
  showMailbox,
  folder,
  onSwipeClose,
  onSwipeAssign,
  selecting,
}: {
  conversation: ConversationSummary
  to: string
  checked: boolean
  onCheck: () => void
  showMailbox: boolean
  folder: Folder | null
  onSwipeClose?: () => void
  onSwipeAssign?: () => void
  /** On a phone, checkboxes show only in select mode; otherwise the customer's avatar takes their place. */
  selecting: boolean
}) {
  const waiting = (c.status === 'active' || c.status === 'waiting') && !!c.waitingSince
  // Waiting on the customer: regular weight instead of bold, as in Help Scout. Still dark enough to read.
  const pending = c.status === 'pending'
  const { user: me } = useSession()
  const viewers = useViewers(c.id, me.id)
  const openFolder = folder === 'unassigned' || folder === 'mine' || folder === 'assigned' || folder === 'mentioned'
  const showStatus = folder === null || folder === 'all' || ((c.status === 'pending' || (c.status === 'waiting' && workspace().fourStatuses)) && folder !== 'closed' && folder !== 'pending') || folder === 'snoozed'
  const showAssignee = c.assignee && folder !== 'mine'
  const when = openFolder && c.waitingSince ? c.waitingSince : c.updatedAt

  return (
    <SwipeRow
      className="group md:border-b md:border-line"
      contentClassName={cx('w-full transition-shadow hover:shadow-[inset_2px_0_0_var(--accent)]', checked ? 'bg-accent-soft' : 'bg-surface hover:bg-sunken')}
      end={onSwipeClose && { label: 'Close', icon: <Archive className="size-5" />, tone: 'bg-ok', onCommit: onSwipeClose }}
      start={onSwipeAssign && { label: c.assignee?.id === me.id ? 'Unassign' : 'Assign to me', icon: <UserRoundCheck className="size-5" />, tone: 'bg-accent', onCommit: onSwipeAssign }}
    >
      <div className={cx('w-10 shrink-0 justify-center pt-4 md:flex md:w-12 md:items-center md:pt-0', selecting ? 'flex' : 'hidden')}>
        <CheckBox checked={checked} label={`Select conversation: ${c.subject}`} onClick={onCheck} />
      </div>
      {!selecting && (
        <Link to={to} tabIndex={-1} aria-hidden className="shrink-0 pt-2.5 pr-3 pl-4 md:hidden">
          <Avatar name={c.customer.name || c.customer.email} size={40} />
        </Link>
      )}
      <Link to={to} className={cx(COLS, 'grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2 pr-4 outline-offset-[-2px] md:py-1.5 md:pr-5')}>
        <span className={cx('truncate text-[16px] leading-snug md:text-sm md:leading-normal', waiting ? 'font-semibold text-fg' : pending ? 'text-fg' : 'font-medium text-fg-2 phone:font-semibold phone:text-fg')} title={c.customer.name || c.customer.email}>{c.customer.name || c.customer.email}</span>
        {/* Two lines, as in Help Scout: the subject, then the preview in lighter text under it. */}
        <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
          <span className="flex min-w-0 items-center gap-1.5">
            {c.source === 'chat' && <MessageCircle className="size-3.5 shrink-0 text-fg-3" aria-label="Live chat" />}
            {viewers.length > 0 && <ViewersBadge viewers={viewers} />}
            <span className={cx('truncate text-[15px] leading-snug md:text-sm md:leading-[1.35]', waiting ? 'font-semibold text-fg' : pending ? 'text-fg' : 'font-medium text-fg phone:font-semibold')}>{c.subject || '(no subject)'}</span>
            {showStatus && <StatusBadge status={c.status} />}
            {c.hasDraft && <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-amber-50 px-1.5 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">Draft</span>}
            {showMailbox && <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-2 group-hover:bg-hover">{c.mailboxName}</span>}
            {c.tags.slice(0, 3).map((t) => (
              <span key={t.id} className="hidden h-5 shrink-0 items-center gap-1 rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-2 group-hover:bg-hover md:inline-flex">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />
                {t.name}
              </span>
            ))}
            {c.tags.length > 3 && <span className="hidden shrink-0 text-xs text-fg-3 md:inline">+{c.tags.length - 3}</span>}
          </span>
          {/* The newest note, when nothing has been said since, as in Help Scout. */}
          {c.notePreview ? (
            <span className="mt-0.5 block text-sm text-fg-3 phone:line-clamp-2 phone:leading-snug md:mt-0 md:truncate md:text-sm md:leading-[1.35]">
              <StickyNote className="mr-1 inline size-3.5 -translate-y-px text-note-fg" aria-label="Note" />
              {c.notePreview}
            </span>
          ) : (
            <span className={cx('mt-0.5 block text-sm phone:line-clamp-2 phone:leading-snug md:mt-0 md:truncate md:text-sm md:leading-[1.35]', 'text-fg-3')}>{c.preview || 'No message text'}</span>
          )}
          {/* On a phone, tags get a line of their own, under the preview. */}
          {c.tags.length > 0 && (
            <span className="mt-1.5 flex flex-wrap gap-1 md:hidden">
              {c.tags.slice(0, 4).map((t) => (
                <span key={t.id} className="inline-flex h-5 items-center gap-1 rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-2">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />
                  {t.name}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="hidden items-center justify-end gap-2 md:flex">
          {c.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-fg-3" aria-label="Has attachments" />}
          {showAssignee && <Avatar name={c.assignee!.name} color={c.assignee!.color} src={c.assignee!.avatarUrl} size={20} />}
          {c.threadCount > 1 && (
            <span className="flex h-5 min-w-6 shrink-0 items-center justify-center rounded border border-line-strong px-1 text-xs font-medium text-fg-2 tabular-nums" title={plural(c.threadCount, 'message')}>
              {c.threadCount}
            </span>
          )}
        </span>
        <span className={cx('hidden text-[13px] tabular-nums md:block', pending ? 'text-fg-3' : 'font-medium text-fg-2')}>{c.id}</span>
        <time className={cx('col-start-2 row-start-1 shrink-0 text-[13px] tabular-nums md:col-start-auto md:row-start-auto md:text-[13px]', waiting ? 'font-semibold text-fg' : 'text-fg-3')} dateTime={new Date(when).toISOString()}>
          {shortTime(when)}
        </time>
      </Link>
    </SwipeRow>
  )
}
