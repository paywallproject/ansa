import type { ReactNode } from 'react'
import { CircleUserRound, Clock, Flag, FolderInput, ShieldAlert, Tag as TagIcon, Trash2, UserRound, X } from 'lucide-react'
import { STATUS_LABEL } from '../lib/format'
import { canSee } from '../lib/access'
import { useMailboxes, useSession, useUsers } from '../lib/hooks'
import type { ConversationSummary } from '../lib/types'
import { Avatar, MenuDivider, MenuItem, MenuLabel, Popover, cx } from '../ui'
import { STATUS_DOT, statusOptions } from '../lib/workspace'
import { SnoozeMenu, TagMenu } from './ConversationView'

export type BulkPayload = { patch?: Record<string, unknown>; delete?: boolean; /** Keep the selection afterwards, to add another tag. */ keep?: boolean }

const tool = 'flex size-10 shrink-0 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/12 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white disabled:opacity-50'

/**
 * What can be done to the conversations ticked in the list, as a dark bar floating over the list's header, as in
 * Help Scout: assign, status, tags, snooze, move, spam and delete. Each icon names itself on hover.
 */
export function SelectionBar({
  selected,
  mailboxId,
  pending,
  onBulk,
  onDelete,
  onClear,
}: {
  selected: ConversationSummary[]
  mailboxId: number | undefined
  pending: boolean
  onBulk: (payload: BulkPayload) => void
  onDelete: () => void
  onClear: () => void
}) {
  const { user } = useSession()
  const users = useUsers()
  const mailboxes = useMailboxes()
  // A tag is ticked when every selected conversation has it, so a click removes it from all of them.
  const common = selected.length > 0 ? selected[0].tags.map((t) => t.name).filter((name) => selected.every((c) => c.tags.some((t) => t.name === name))) : []
  // Move to another mailbox: one the selected conversations are not all in already.
  const from = new Set(selected.map((c) => c.mailboxId))
  const targets = (mailboxes.data ?? []).filter((m) => !(from.size === 1 && from.has(m.id)))
  const icon = (label: string, children: ReactNode) => ({ ref, ...props }: Parameters<Parameters<typeof Popover>[0]['trigger']>[0]) => (
    <button ref={ref} type="button" {...props} disabled={pending} aria-label={label} title={label} className={tool}>
      {children}
    </button>
  )

  return (
    <div role="toolbar" aria-label={`Actions for ${selected.length} selected`} className="animate-fade absolute top-1.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-2xl bg-[#151a21] py-1 pr-1.5 pl-1 text-white shadow-[0_10px_30px_-8px_rgba(0,0,0,0.45)] ring-1 ring-white/10 md:top-2">
      <button type="button" onClick={onClear} aria-label="Clear selection" title="Clear selection" className="flex h-10 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[13px] font-semibold whitespace-nowrap text-white/85 transition-colors hover:bg-white/12 hover:text-white">
        <X className="size-4" aria-hidden />
        <span className="tabular-nums">{selected.length}</span>
      </button>
      <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />

      <Popover align="start" width={230} trigger={icon('Assign', <CircleUserRound className="size-5" aria-hidden />)}>
        {(close) => (
          <>
            <MenuLabel>Assign to</MenuLabel>
            {(users.data ?? [])
              .filter((u) => !u.disabled && (mailboxId === undefined || canSee(u, mailboxId)))
              // Yourself first: it is the most common choice.
              .sort((x, y) => Number(y.id === user.id) - Number(x.id === user.id))
              .map((u) => (
                <MenuItem
                  key={u.id}
                  icon={<Avatar name={u.name} color={u.color} src={u.avatarUrl} size={20} />}
                  onSelect={() => {
                    close()
                    onBulk({ patch: { assigneeId: u.id } })
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
              onSelect={() => {
                close()
                onBulk({ patch: { assigneeId: null } })
              }}
            >
              Unassigned
            </MenuItem>
          </>
        )}
      </Popover>

      <Popover align="start" width={200} trigger={icon('Status', <Flag className="size-5" aria-hidden />)}>
        {(close) =>
          statusOptions().map((status) => (
            <MenuItem
              key={status}
              icon={<span className={cx('size-2.5 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />}
              onSelect={() => {
                close()
                onBulk({ patch: { status } })
              }}
            >
              {STATUS_LABEL[status]}
            </MenuItem>
          ))
        }
      </Popover>

      <TagMenu
        current={common}
        hiddenCount={0}
        onAdd={(name) => onBulk({ patch: { addTags: [name] }, keep: true })}
        onRemove={(name) => onBulk({ patch: { removeTags: [name] }, keep: true })}
        trigger={icon('Tag', <TagIcon className="size-5" aria-hidden />)}
      />

      <SnoozeMenu snoozedUntil={null} onSnooze={(until) => until && onBulk({ patch: { snoozedUntil: until } })} trigger={icon('Snooze', <Clock className="size-5" aria-hidden />)} />

      {targets.length > 0 && (mailboxes.data?.length ?? 0) > 1 && (
        <Popover align="start" width={230} trigger={icon('Move to mailbox', <FolderInput className="size-5" aria-hidden />)}>
          {(close) => (
            <>
              <MenuLabel>Move to</MenuLabel>
              {targets.map((m) => (
                <MenuItem
                  key={m.id}
                  icon={<FolderInput />}
                  onSelect={() => {
                    close()
                    onBulk({ patch: { mailboxId: m.id } })
                  }}
                >
                  {m.name}
                </MenuItem>
              ))}
            </>
          )}
        </Popover>
      )}

      <button type="button" disabled={pending} onClick={() => onBulk({ patch: { status: 'spam' } })} aria-label="Mark as spam" title="Mark as spam" className={tool}>
        <ShieldAlert className="size-5" aria-hidden />
      </button>
      <button type="button" disabled={pending} onClick={onDelete} aria-label="Delete" title="Delete" className={tool}>
        <Trash2 className="size-5" aria-hidden />
      </button>
    </div>
  )
}
