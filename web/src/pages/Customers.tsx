import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Briefcase, Building2, MapPin, Pencil, Phone, Plus, Search, SquarePen, UsersRound } from 'lucide-react'
import { api, qs } from '../lib/api'
import { ago, dateOnly, plural, shortTime } from '../lib/format'
import { useDebounced, useDocumentTitle } from '../lib/hooks'
import type { ConversationSummary, Customer } from '../lib/types'
import { Avatar, Button, Card, EmptyState, Input, PageHeader, Spinner, StatusBadge } from '../ui'
import { useShell } from '../Shell'
import { CustomerForm } from '../inbox/CustomerPanel'

const PAGE = 50

export function CustomersPage() {
  const { customerId } = useParams()
  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">{customerId ? <CustomerProfile id={Number(customerId)} /> : <CustomerList />}</div>
    </div>
  )
}

function CustomerList() {
  useDocumentTitle('Customers')
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const term = useDebounced(query.trim(), 250)
  const list = useInfiniteQuery({
    queryKey: ['customers', 'list', term],
    queryFn: ({ pageParam }) => api.get<{ items: Customer[]; total: number }>(`/customers${qs({ q: term, limit: PAGE, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (pages.length * PAGE < last.total ? pages.length * PAGE : undefined),
  })
  const items = list.data?.pages.flatMap((p) => p.items) ?? []
  const total = list.data?.pages[0]?.total ?? 0

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Customers"
        description={list.data ? `${plural(total, 'person', 'people')} ${term ? 'match your search' : 'have written to you'}` : undefined}
        action={
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
            Add customer
          </Button>
        }
      />
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-fg-3" aria-hidden />
        <Input aria-label="Search customers" placeholder="Search by name, email or company" className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {list.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<UsersRound />}
            title={term ? 'No customer matches' : 'No customers yet'}
            body={term ? 'Check the spelling, or search by email address.' : 'People are added here the first time they email you.'}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-fg-3">
                <th scope="col" className="px-5 py-2.5 font-medium">
                  Customer
                </th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">
                  Company
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">
                  Conversations
                </th>
                <th scope="col" className="hidden px-5 py-2.5 text-right font-medium sm:table-cell">
                  Last message
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((c) => (
                <tr key={c.id} className="cursor-pointer transition-colors hover:bg-sunken" onClick={() => navigate(`/customers/${c.id}`)}>
                  <td className="px-5 py-2.5">
                    <Link to={`/customers/${c.id}`} className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                      <Avatar name={c.name || c.email} size={30} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{c.name || c.email}</span>
                        <span className="block truncate text-[13px] text-fg-3">{c.email}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="hidden px-3 py-2.5 text-fg-2 sm:table-cell">{c.company || <span className="text-fg-3">–</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{c.conversationCount ?? 0}</td>
                  <td className="hidden px-5 py-2.5 text-right text-fg-3 sm:table-cell">{c.lastSeenAt ? ago(c.lastSeenAt) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage && (
            <div className="flex justify-center border-t border-line p-3">
              <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Show more
              </Button>
            </div>
          )}
        </Card>
      )}
      {adding && <CustomerForm customer={null} onClose={() => setAdding(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />}
    </div>
  )
}

function CustomerProfile({ id }: { id: number }) {
  const shell = useShell()
  const [editing, setEditing] = useState(false)
  const query = useQuery({ queryKey: ['customers', 'detail', id], queryFn: () => api.get<{ customer: Customer; conversations: ConversationSummary[] }>(`/customers/${id}`) })
  useDocumentTitle(query.data?.customer.name ?? 'Customer')
  if (query.isPending) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )
  }
  if (query.isError) {
    return (
      <Card>
        <EmptyState
          title="Customer not found"
          body="They may have been merged or removed."
          action={
            <Link to="/customers">
              <Button>Back to customers</Button>
            </Link>
          }
        />
      </Card>
    )
  }
  const { customer, conversations } = query.data
  const details = [
    { icon: <Building2 />, value: customer.company },
    { icon: <Briefcase />, value: customer.title },
    { icon: <Phone />, value: customer.phone },
    { icon: <MapPin />, value: customer.location },
  ].filter((d) => d.value)

  return (
    <div className="flex flex-col gap-5">
      <Link to="/customers" className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden />
        Customers
      </Link>
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={customer.name || customer.email} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">{customer.name || customer.email}</h1>
            <p className="mt-0.5 text-sm text-fg-2">
              {customer.emails.map((email, i) => (
                <span key={email}>
                  {i > 0 && ', '}
                  <a href={`mailto:${email}`} className="text-accent-fg hover:underline">
                    {email}
                  </a>
                </span>
              ))}
            </p>
            <p className="mt-0.5 text-[13px] text-fg-3">Customer since {dateOnly(customer.createdAt)}</p>
          </div>
          <div className="flex gap-2">
            <Button icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="primary" icon={<SquarePen className="size-3.5" aria-hidden />} onClick={() => shell.compose({ customerEmail: customer.email, customerName: customer.name })}>
              New conversation
            </Button>
          </div>
        </div>
        {(details.length > 0 || customer.notes) && (
          <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
            {details.length > 0 && (
              <ul className="flex flex-wrap gap-x-6 gap-y-1.5">
                {details.map((d) => (
                  <li key={d.value} className="flex items-center gap-2 text-sm text-fg-2 [&>svg]:size-4 [&>svg]:text-fg-3">
                    {d.icon}
                    {d.value}
                  </li>
                ))}
              </ul>
            )}
            {customer.notes && <p className="text-sm whitespace-pre-wrap text-fg-2">{customer.notes}</p>}
          </div>
        )}
      </Card>

      <section>
        <h2 className="mb-2 text-[15px] font-semibold">Conversations</h2>
        {conversations.length === 0 ? (
          <Card>
            <EmptyState title="No conversations yet" body="Start one with the button above." />
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {conversations.map((c) => (
              <Link key={c.id} to={`/c/${c.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-sunken">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.subject}</span>
                  <span className="block truncate text-[13px] text-fg-3">{c.preview}</span>
                </span>
                <StatusBadge status={c.status} />
                <span className="w-14 shrink-0 text-right text-xs text-fg-3 tabular-nums">{shortTime(c.updatedAt)}</span>
              </Link>
            ))}
          </Card>
        )}
      </section>
      {editing && <CustomerForm customer={customer} onClose={() => setEditing(false)} />}
    </div>
  )
}
