import { Link } from 'react-router-dom'
import { Settings, SquarePen } from 'lucide-react'
import { useDocumentTitle, useSession } from '../lib/hooks'
import type { Mailbox } from '../lib/types'
import { brand, workspace } from '../lib/workspace'
import { useShell } from '../Shell'
import { cx } from '../ui'

type CountKey = 'unassigned' | 'mine' | 'mentioned' | 'assigned'

/** The folders a card lists, as in Help Scout's dashboard. Mentioned only when the workspace uses it. */
const rows = (): { id: CountKey; label: string }[] => [
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'mine', label: 'Mine' },
  ...(workspace().mentions ? [{ id: 'mentioned' as const, label: 'Mentioned' }] : []),
  { id: 'assigned', label: 'Assigned' },
]

/** Home with more than one mailbox: a card per mailbox with what waits in it. */
export function Dashboard({ mailboxes }: { mailboxes: Mailbox[] }) {
  useDocumentTitle('Dashboard')
  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">
        <h1 className="text-xl font-semibold tracking-tight text-fg md:text-2xl">{brand()} Dashboard</h1>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {mailboxes.map((m) => (
            <MailboxCard key={m.id} mailbox={m} />
          ))}
        </div>
      </div>
    </div>
  )
}

function MailboxCard({ mailbox }: { mailbox: Mailbox }) {
  const { user } = useSession()
  const shell = useShell()
  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface p-2 shadow-card">
      <div className="h-1 rounded-full" style={{ background: mailbox.color || 'var(--accent)' }} aria-hidden />
      <div className="px-4 pt-5 pb-1 md:px-5">
        <Link to={`/m/${mailbox.id}/unassigned`} className="block truncate text-[17px] font-semibold text-fg hover:underline">
          {mailbox.name}
        </Link>
        <p className="mt-1 truncate text-sm text-fg-3">{mailbox.email}</p>
      </div>
      <ul className="mt-3 px-1.5 md:px-2">
        {rows().map((row) => {
          const count = mailbox.counts[row.id] ?? 0
          return (
            <li key={row.id}>
              <Link
                to={`/m/${mailbox.id}/${row.id}`}
                className={cx('flex h-11 items-center justify-between rounded-lg px-2.5 text-[15px] hover:bg-hover md:px-3', count > 0 ? 'font-semibold text-fg' : 'text-fg-2')}
              >
                <span>{row.label}</span>
                {count > 0 && <span className="tabular-nums">{count}</span>}
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="mt-auto flex justify-end gap-1 px-2 pt-6 pb-1">
        <button type="button" onClick={() => shell.compose({ mailboxId: mailbox.id })} className="flex size-9 items-center justify-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg" aria-label={`New conversation in ${mailbox.name}`} title="New conversation">
          <SquarePen className="size-[18px]" />
        </button>
        {user.role === 'admin' && (
          <Link to={`/settings/mailboxes/${mailbox.id}`} className="flex size-9 items-center justify-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg" aria-label={`${mailbox.name} settings`} title="Mailbox settings">
            <Settings className="size-[18px]" />
          </Link>
        )}
      </div>
    </div>
  )
}
