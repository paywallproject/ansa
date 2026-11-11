import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Download } from 'lucide-react'
import { api } from '../lib/api'
import { useMailboxes } from '../lib/hooks'
import { brand } from '../lib/workspace'
import { Banner, Button, Card, Field, Input, PageHeader, Select, Spinner, Switch, cx, useFeedback } from '../ui'

interface ImportInbox {
  hsId: number
  name: string
  email: string
  mailboxId: number
  page: number
  totalPages: number
  total: number
  done: boolean
}
interface ImportState {
  status: 'idle' | 'running' | 'paused' | 'done' | 'cancelled'
  startedAt: number | null
  finishedAt: number | null
  message: string | null
  attachments: boolean
  inboxes: ImportInbox[]
  imported: number
  skipped: number
  files: number
  filesSkipped: number
  waitUntil: number
}
interface FoundInbox {
  id: number
  name: string
  email: string
  conversations: number
}

const PAGE_SIZE = 25 // Help Scout returns 25 conversations per page.
const n = (value: number) => value.toLocaleString()

export function ImportSettings() {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const status = useQuery({
    queryKey: ['import-helpscout'],
    queryFn: () => api.get<{ import: ImportState }>('/import/helpscout').then((r) => r.import),
    // Follow a running import without asking the person to reload.
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  })
  const [again, setAgain] = useState(false)
  const state = status.data
  const active = state && (state.status === 'running' || state.status === 'paused')
  const finished = state && (state.status === 'done' || state.status === 'cancelled') && !again

  const refresh = (next: ImportState) => {
    client.setQueryData(['import-helpscout'], next)
    void client.invalidateQueries({ queryKey: ['mailboxes'] })
    void client.invalidateQueries({ queryKey: ['conversations'] })
  }
  const act = useMutation({
    mutationFn: (action: 'cancel' | 'resume') => api.post<{ import: ImportState }>(`/import/helpscout/${action}`),
    onSuccess: (data) => refresh(data.import),
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Import" description={`Bring your conversations from Help Scout into ${brand()}. Nothing in Help Scout is changed.`} />
      {status.isPending ? (
        <Spinner />
      ) : active || finished ? (
        <Progress state={state!} busy={act.isPending} onCancel={() => act.mutate('cancel')} onResume={() => act.mutate('resume')} onAgain={() => setAgain(true)} />
      ) : (
        <Setup
          onStarted={(next) => {
            setAgain(false)
            refresh(next)
          }}
        />
      )}
    </div>
  )
}

function Setup({ onStarted }: { onStarted: (state: ImportState) => void }) {
  const mailboxes = useMailboxes()
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [found, setFound] = useState<FoundInbox[] | null>(null)
  // For each Help Scout inbox: 'skip', 'new', or the id of an existing mailbox.
  const [target, setTarget] = useState<Record<number, string>>({})
  const [attachments, setAttachments] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const connect = useMutation({
    mutationFn: () => api.post<{ inboxes: FoundInbox[] }>('/import/helpscout/connect', { appId: appId.trim(), appSecret: appSecret.trim() }),
    onSuccess: (data) => {
      setError(null)
      setFound(data.inboxes)
      const existing = mailboxes.data ?? []
      // Suggest the mailbox with the same address, otherwise a new one.
      setTarget(Object.fromEntries(data.inboxes.map((box) => [box.id, String(existing.find((m) => m.email.toLowerCase() === box.email.toLowerCase())?.id ?? 'new')])))
    },
    onError: (err: Error) => setError(err.message),
  })
  const chosen = (found ?? []).filter((box) => target[box.id] !== 'skip')
  const start = useMutation({
    mutationFn: () =>
      api.post<{ import: ImportState }>('/import/helpscout/start', {
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        attachments,
        inboxes: chosen.map((box) => ({ hsId: box.id, name: box.name, email: box.email, mailboxId: target[box.id] === 'new' ? null : Number(target[box.id]) })),
      }),
    onSuccess: (data) => onStarted(data.import),
    onError: (err: Error) => setError(err.message),
  })
  const total = chosen.reduce((sum, box) => sum + box.conversations, 0)

  return (
    <>
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">1. Get access from Help Scout</h2>
        <p className="mt-0.5 text-[13px] text-fg-3">Help Scout gives out conversations only through its API. You create a private app there to get two codes. It takes a minute and is free.</p>
        <ol className="mt-4 flex list-decimal flex-col gap-1.5 pl-5 text-[13px]">
          <li>
            In Help Scout, open{' '}
            <a href="https://secure.helpscout.net/authentication/apps/" target="_blank" rel="noreferrer" className="font-medium text-accent-fg underline">
              Your Profile → My Apps
            </a>
            .
          </li>
          <li>
            Press <strong>Create My App</strong>. Use any name. For the redirection URL, enter <code className="rounded bg-sunken px-1 py-0.5 font-mono text-xs">https://example.com</code>.
          </li>
          <li>
            Copy the <strong>App ID</strong> and the <strong>App Secret</strong> into the fields below.
          </li>
        </ol>
        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            connect.mutate()
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="App ID">{(id) => <Input id={id} value={appId} autoComplete="off" onChange={(e) => setAppId(e.target.value)} />}</Field>
            <Field label="App Secret">{(id) => <Input id={id} type="password" autoComplete="new-password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />}</Field>
          </div>
          {error && <Banner kind="danger">{error}</Banner>}
          <div>
            <Button type="submit" variant={found ? 'secondary' : 'primary'} loading={connect.isPending} disabled={!appId.trim() || !appSecret.trim()}>
              {found ? 'Check again' : 'Connect to Help Scout'}
            </Button>
          </div>
        </form>
      </Card>

      {found && (
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">2. Choose what to import</h2>
          <p className="mt-0.5 text-[13px] text-fg-3">Pick where each Help Scout inbox goes. A new mailbox gets the inbox's name and address; connect its email later in Settings → Mailboxes.</p>
          {found.length === 0 ? (
            <p className="mt-4 text-[13px] text-fg-3">This Help Scout account has no inboxes that the app's owner can see.</p>
          ) : (
            <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
              {found.map((box) => (
                <li key={box.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3">
                  <div className="min-w-40 flex-1">
                    <p className="truncate text-sm font-medium">{box.name}</p>
                    <p className="truncate text-[13px] text-fg-3">
                      {box.email} · {n(box.conversations)} {box.conversations === 1 ? 'conversation' : 'conversations'}
                    </p>
                  </div>
                  <Select aria-label={`Where to import ${box.name}`} className="w-56" value={target[box.id] ?? 'new'} onChange={(e) => setTarget((t) => ({ ...t, [box.id]: e.target.value }))}>
                    <option value="new">New mailbox “{box.name}”</option>
                    {(mailboxes.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        Into {m.name}
                      </option>
                    ))}
                    <option value="skip">Do not import</option>
                  </Select>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5">
            <Switch checked={attachments} onChange={setAttachments} label="Include attachments" description="Files up to 25 MB each. This makes the import slower, because Help Scout hands over one file per request." />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<Download />} loading={start.isPending} disabled={chosen.length === 0} onClick={() => start.mutate()}>
              Import {n(total)} {total === 1 ? 'conversation' : 'conversations'}
            </Button>
            <span className="text-[13px] text-fg-3">It runs in the background. You can keep working and close this page.</span>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">What comes over</h2>
        <div className="mt-3 grid gap-x-8 gap-y-4 text-[13px] sm:grid-cols-2">
          <div>
            <p className="mb-1.5 font-medium text-ok">Imported</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-fg-2">
              <li>Conversations with their original dates and status</li>
              <li>Customer messages, replies and internal notes</li>
              <li>Customers, tags and attachments</li>
              <li>Who wrote each reply. People who are not on your team here are added as disabled teammates, so their name stays.</li>
            </ul>
          </div>
          <div>
            <p className="mb-1.5 font-medium text-fg-3">Not imported</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-fg-2">
              <li>Spam, drafts and deleted conversations</li>
              <li>Activity lines such as “assigned to” and “marked as closed”</li>
              <li>Saved replies, workflows, custom fields and satisfaction ratings</li>
              <li>The assignee, when that person has no active account here</li>
            </ul>
          </div>
        </div>
        <p className="mt-4 text-[13px] text-fg-3">You can run the import again later. Conversations that are already here are skipped, so only new ones are added.</p>
      </Card>
    </>
  )
}

function Progress({ state, busy, onCancel, onResume, onAgain }: { state: ImportState; busy: boolean; onCancel: () => void; onResume: () => void; onAgain: () => void }) {
  const running = state.status === 'running'
  const waiting = running && state.waitUntil > Date.now()
  const title = { running: 'Importing from Help Scout', paused: 'Import paused', done: 'Import finished', cancelled: 'Import stopped', idle: '' }[state.status]

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2.5">
        {running ? <Spinner /> : state.status === 'done' ? <CircleCheck className="size-4 text-ok" aria-hidden /> : <CircleAlert className={cx('size-4', state.status === 'paused' ? 'text-warn' : 'text-fg-3')} aria-hidden />}
        <h2 className="text-[15px] font-semibold">{title}</h2>
      </div>
      <p className="mt-1 text-[13px] text-fg-3" role="status">
        {n(state.imported)} {state.imported === 1 ? 'conversation' : 'conversations'} imported
        {state.files > 0 && `, ${n(state.files)} ${state.files === 1 ? 'file' : 'files'}`}
        {state.skipped > 0 && `, ${n(state.skipped)} skipped (spam, drafts or empty)`}
        {state.filesSkipped > 0 && `, ${n(state.filesSkipped)} ${state.filesSkipped === 1 ? 'file' : 'files'} left out`}.
        {waiting && ' Help Scout asked for a short pause; it continues by itself.'}
      </p>
      {state.message && (
        <div className="mt-3">
          <Banner kind="warn">{state.message}</Banner>
        </div>
      )}

      <ul className="mt-4 flex flex-col gap-3">
        {state.inboxes.map((box) => {
          // Pages already passed, as a share of all pages. The count is exact once a page has been read.
          const share = box.done ? 1 : box.totalPages > 0 ? Math.min(0.99, (box.page - 1) / box.totalPages) : 0
          const seen = box.done ? box.total : Math.min(box.total, (box.page - 1) * PAGE_SIZE)
          return (
            <li key={box.hsId}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="truncate font-medium">{box.name}</span>
                <span className="shrink-0 text-fg-3 tabular-nums">{box.done ? `Done · ${n(box.total)}` : box.total > 0 ? `${n(seen)} of ${n(box.total)}` : 'Waiting'}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`${box.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                <div className={cx('h-full rounded-full transition-[width] duration-500', box.done ? 'bg-ok' : 'bg-accent')} style={{ width: `${Math.round(share * 100)}%` }} />
              </div>
            </li>
          )
        })}
      </ul>

      <div className="mt-5 flex flex-wrap gap-2">
        {state.status === 'paused' && (
          <Button variant="primary" loading={busy} onClick={onResume}>
            Resume
          </Button>
        )}
        {(running || state.status === 'paused') && (
          <Button loading={busy && running} onClick={onCancel}>
            Stop the import
          </Button>
        )}
        {(state.status === 'done' || state.status === 'cancelled') && <Button onClick={onAgain}>Import again</Button>}
      </div>
      {running && <p className="mt-3 text-[13px] text-fg-3">You can leave this page. The import keeps running, and conversations appear in their mailbox as they arrive.</p>}
      {state.status === 'cancelled' && <p className="mt-3 text-[13px] text-fg-3">What was imported so far stays. Import again to continue: conversations that are already here are skipped.</p>}
    </Card>
  )
}
