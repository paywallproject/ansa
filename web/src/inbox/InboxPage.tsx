import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpDown, Check, CircleCheck, Inbox, MessagesSquare, Paperclip, Search, ShieldAlert, Trash2, UserRoundCheck, X } from 'lucide-react'
import { api, qs } from '../lib/api'
import { plural, shortTime } from '../lib/format'
import { useDebounced, useDocumentTitle, useHotkeys, useLocalState, useMailboxes, useSession } from '../lib/hooks'
import type { ConversationSummary, Folder } from '../lib/types'
import { Avatar, Button, EmptyState, IconButton, Input, MenuItem, Popover, Spinner, StatusBadge, cx, useFeedback } from '../ui'
import { FOLDERS } from '../Shell'
import { ConversationView } from './ConversationView'

type Sort = 'recent' | 'waiting' | 'oldest'
const SORTS: Record<Sort, string> = { recent: 'Newest activity', waiting: 'Longest waiting', oldest: 'Oldest activity' }
const PAGE = 40

const EMPTY: Record<Folder, { title: string; body: string }> = {
  unassigned: { title: 'All caught up', body: 'New conversations that nobody owns yet show up here.' },
  mine: { title: 'Nothing on your plate', body: 'Conversations assigned to you show up here.' },
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
  /** After closing a conversation, move to the next one in the list. */
  const advance = () => {
    const index = items.findIndex((c) => c.id === selectedId)
    const next = items[index + 1] ?? items[index - 1]
    open(next && ['unassigned', 'mine', 'assigned'].includes(folder) && !search ? next.id : null)
  }
  useHotkeys({ j: () => step(1), k: () => step(-1), escape: () => selectedId && !document.querySelector('[role=dialog], [role=menu]') && open(null) })

  const bulk = useMutation({
    mutationFn: (payload: { patch?: Record<string, unknown>; delete?: boolean }) => api.post('/conversations/bulk', { ids: [...checked], ...payload }),
    onSuccess: (_data, payload) => {
      toast(`${plural(checked.size, 'conversation')} ${payload.delete ? 'deleted' : 'updated'}`)
      setChecked(new Set())
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      void client.invalidateQueries({ queryKey: ['conversation'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
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

  return (
    <div className="flex h-full">
      <section className={cx('flex w-full shrink-0 flex-col border-line lg:w-[360px] lg:border-r 2xl:w-[400px]', selectedId && 'hidden lg:flex')} aria-label="Conversations">
        {checked.size > 0 ? (
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-accent-soft px-3">
            <IconButton label="Clear selection" size="sm" onClick={() => setChecked(new Set())}>
              <X className="size-4" />
            </IconButton>
            <span className="flex-1 text-[13px] font-semibold text-accent-fg">{checked.size} selected</span>
            <IconButton label="Close selected" onClick={() => bulk.mutate({ patch: { status: 'closed' } })} disabled={bulk.isPending}>
              <CircleCheck className="size-4" />
            </IconButton>
            <IconButton label="Assign selected to me" onClick={() => bulk.mutate({ patch: { assigneeId: user.id } })} disabled={bulk.isPending}>
              <UserRoundCheck className="size-4" />
            </IconButton>
            <IconButton label="Mark selected as spam" onClick={() => bulk.mutate({ patch: { status: 'spam' } })} disabled={bulk.isPending}>
              <ShieldAlert className="size-4" />
            </IconButton>
            <IconButton label="Delete selected" onClick={() => void bulkDelete()} disabled={bulk.isPending}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ) : (
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
            {search ? (
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-3" aria-hidden />
                <Input autoFocus aria-label="Search conversations" placeholder="Search conversations" className="h-9 pl-8" value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} />
              </div>
            ) : (
              <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                {folderInfo?.label ?? 'All conversations'}
                {total > 0 && <span className="ml-2 text-[13px] font-normal text-fg-3 tabular-nums">{total.toLocaleString()}</span>}
              </h1>
            )}
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

        <div className="min-h-0 flex-1 overflow-y-auto">
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
              <ul>
                {items.map((c) => (
                  <Row key={c.id} conversation={c} to={`${base}/${c.id}${suffix}`} selected={c.id === selectedId} checked={checked.has(c.id)} anyChecked={checked.size > 0} onCheck={() => toggle(c.id)} showMailbox={search} folder={search ? null : folder} />
                ))}
              </ul>
              {list.hasNextPage && (
                <div className="flex justify-center p-3">
                  <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    Show more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className={cx('min-w-0 flex-1', !selectedId && 'hidden lg:block')} aria-label="Conversation">
        {selectedId ? (
          <ConversationView key={selectedId} id={selectedId} onBack={() => open(null)} onDone={advance} />
        ) : (
          <EmptyState icon={<MessagesSquare />} title={items.length ? 'Pick a conversation' : 'Nothing to read'} body={items.length ? 'Choose one from the list, or press J to open the first.' : undefined} />
        )}
      </section>
    </div>
  )
}

function Row({
  conversation: c,
  to,
  selected,
  checked,
  anyChecked,
  onCheck,
  showMailbox,
  folder,
}: {
  conversation: ConversationSummary
  to: string
  selected: boolean
  checked: boolean
  anyChecked: boolean
  onCheck: () => void
  showMailbox: boolean
  folder: Folder | null
}) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const waiting = c.status === 'active' && !!c.waitingSince
  const showStatus = folder === null || folder === 'all' || (c.status === 'pending' && folder !== 'closed') || folder === 'snoozed'
  const showAssignee = c.assignee && folder !== 'mine'
  const hasMeta = showStatus || c.tags.length > 0 || showAssignee || c.hasAttachments || c.threadCount > 1 || showMailbox

  return (
    <li ref={ref} className={cx('group relative border-b border-line', selected ? 'bg-accent-soft' : checked ? 'bg-sunken' : 'hover:bg-sunken')}>
      <div className="absolute top-3.5 left-3 z-10 flex size-5 items-center justify-center">
        <span className={cx('size-2 rounded-full', waiting ? 'bg-accent' : 'bg-transparent', (anyChecked || checked) && 'hidden', 'group-hover:hidden group-focus-within:hidden')} aria-hidden />
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`Select conversation: ${c.subject}`}
          onClick={onCheck}
          className={cx(
            'absolute inset-0 m-auto size-4 items-center justify-center rounded border transition-colors',
            checked ? 'flex border-accent bg-accent text-white' : 'border-line-strong bg-surface',
            anyChecked || checked ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
          )}
        >
          {checked && <Check className="size-3" strokeWidth={3} aria-hidden />}
        </button>
      </div>
      <Link to={to} aria-current={selected ? 'page' : undefined} className="block py-3 pr-4 pl-10 outline-offset-[-2px]">
        <div className="flex items-baseline gap-2">
          <span className={cx('min-w-0 flex-1 truncate text-[13px]', waiting ? 'font-semibold text-fg' : 'font-medium text-fg-2')}>{c.customer.name || c.customer.email}</span>
          <time className={cx('shrink-0 text-xs tabular-nums', waiting ? 'font-medium text-accent-fg' : 'text-fg-3')} dateTime={new Date(c.updatedAt).toISOString()}>
            {shortTime(c.updatedAt)}
          </time>
        </div>
        <p className={cx('mt-0.5 truncate text-sm', waiting ? 'font-semibold text-fg' : 'text-fg')}>{c.subject}</p>
        <p className="mt-0.5 truncate text-[13px] text-fg-3">{c.preview || 'No message text'}</p>
        {hasMeta && (
          <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden">
            {showStatus && <StatusBadge status={c.status} />}
            {showMailbox && <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-2">{c.mailboxName}</span>}
            {c.tags.slice(0, 3).map((t) => (
              <span key={t.id} className="inline-flex h-5 min-w-0 items-center gap-1 rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-2">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />
                <span className="truncate">{t.name}</span>
              </span>
            ))}
            {c.tags.length > 3 && <span className="text-xs text-fg-3">+{c.tags.length - 3}</span>}
            <span className="flex-1" />
            {c.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-fg-3" aria-label="Has attachments" />}
            {c.threadCount > 1 && (
              <span className="shrink-0 text-xs text-fg-3 tabular-nums" title={plural(c.threadCount, 'message')}>
                {c.threadCount}
              </span>
            )}
            {showAssignee && <Avatar name={c.assignee!.name} color={c.assignee!.color} size={18} />}
          </div>
        )}
      </Link>
    </li>
  )
}
