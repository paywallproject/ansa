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
      <div className="px-4 py-6 md:px-8 md:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg md:text-2xl">{brand()} Dashboard</h1>
        <div className="mt-5 grid gap-3 sm:grid-cols-[repeat(auto-fill,250px)]">
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
    <div className="flex min-h-[290px] flex-col rounded-xl border border-line bg-surface p-1.5 shadow-card">
      <div className="h-1 rounded-full" style={{ background: mailbox.color || 'var(--accent)' }} aria-hidden />
      <div className="px-3.5 pt-4">
        <Link to={`/m/${mailbox.id}/unassigned`} className="block truncate text-[15px] font-semibold text-fg hover:underline">
          {mailbox.name}
        </Link>
        <p className="mt-0.5 truncate text-[13px] text-fg-3">{mailbox.email}</p>
      </div>
      <ul className="mt-3 px-1.5">
        {rows().map((row) => {
          const count = mailbox.counts[row.id] ?? 0
          return (
            <li key={row.id}>
              <Link
                to={`/m/${mailbox.id}/${row.id}`}
                className={cx('flex h-10 items-center justify-between rounded-md px-2 text-sm hover:bg-hover md:h-8 md:text-[13px]', count > 0 ? 'font-semibold text-fg' : 'text-fg-2')}
              >
                <span>{row.label}</span>
                {count > 0 && <span className="tabular-nums">{count}</span>}
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="mt-auto flex justify-end gap-0.5 px-1 pt-4">
        <button type="button" onClick={() => shell.compose({ mailboxId: mailbox.id })} className="flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg" aria-label={`New conversation in ${mailbox.name}`} title="New conversation">
          <SquarePen className="size-4" />
        </button>
        {user.role === 'admin' && (
          <Link to={`/settings/mailboxes/${mailbox.id}`} className="flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg" aria-label={`${mailbox.name} settings`} title="Mailbox settings">
            <Settings className="size-4" />
          </Link>
        )}
      </div>
    </div>
  )
}
