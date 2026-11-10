/**
 * Fill an empty database with demo data so you can explore Ansa before connecting real email.
 *   npm run seed            (development)
 *   node dist/seed.js       (production build / Docker)
 * Sign in with demo@ansa.local / demo1234. Nothing is emailed: seeded replies skip delivery.
 */
import { get, migrate, run, now } from './db.ts'
import { hashPassword } from './crypto.ts'
import { USER_COLORS } from './auth.ts'
import { addCustomerMessage, addNote, addReply, createConversation, updateConversation, type Actor, type Status } from './services/conversations.ts'
import { updateCustomer } from './services/customers.ts'

migrate()
if (get('SELECT 1 FROM users LIMIT 1') && !process.argv.includes('--force')) {
  console.log('The database already has data. Seed only runs on an empty database (pass --force to add demo data anyway).')
  process.exit(0)
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const start = now()
const p = (...paragraphs: string[]) => paragraphs.map((x) => `<p>${x}</p>`).join('')

// A small deterministic random source keeps every seed identical.
let state = 42
const rand = () => {
  state = (state * 1664525 + 1013904223) % 4294967296
  return state / 4294967296
}
const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]

const password = hashPassword('demo1234')
const team = [
  ['Riza Ardiyanto', 'demo@ansa.local', 'admin'],
  ['Maya Chen', 'maya@ansa.local', 'agent'],
  ['Tomás Silva', 'tomas@ansa.local', 'agent'],
  ['Priya Nair', 'priya@ansa.local', 'agent'],
].map(([name, email, role], i) => run('INSERT INTO users (name, email, password_hash, role, color, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', name, email, password, role, USER_COLORS[i], `<p>${name.split(' ')[0]}<br>Northwind Support</p>`, start - 60 * DAY).id)

const mailbox = (name: string, email: string, color: string) =>
  run('INSERT INTO mailboxes (name, email, from_name, color, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)', name, email, `Northwind ${name}`, color, '<p>The Northwind team</p>', start - 60 * DAY).id
const support = mailbox('Support', 'support@northwind.example', '#5448e2')
const billing = mailbox('Billing', 'billing@northwind.example', '#0d9488')

for (const [name, body] of [
  ['Password reset steps', p('Hi {{customer.firstName}},', 'You can reset your password from the sign-in page: choose <strong>Forgot password</strong>, enter your email, and follow the link we send. The link works for 30 minutes.', 'Tell me if the email does not arrive and I will send one from our side.')],
  ['Refund policy', p('Hi {{customer.firstName}},', 'We refund any charge from the last 30 days, no questions asked. I have started the refund. Your bank usually shows it within 5 to 7 business days.')],
  ['Ask for more detail', p('Hi {{customer.firstName}},', 'Thanks for the report. To track this down, could you send the page address where it happens, a screenshot, and your browser version?')],
  ['Feature request logged', p('Hi {{customer.firstName}},', 'Thanks for the idea. I have passed it to our product team and added your vote. I cannot promise a date, but we will email you if it ships.')],
] as [string, string][]) {
  run('INSERT INTO saved_replies (name, body_html, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', name, body, team[0], start, start)
}

run(
  'INSERT INTO workflows (mailbox_id, name, enabled, trigger, match, conditions, actions, run_count, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)',
  null,
  'Tag refund requests',
  'new',
  'any',
  JSON.stringify([
    { field: 'subject', op: 'contains', value: 'refund' },
    { field: 'body', op: 'contains', value: 'refund' },
  ]),
  JSON.stringify([{ type: 'add_tag', value: 'refund' }]),
  7,
  start,
)
run(
  'INSERT INTO workflows (mailbox_id, name, enabled, trigger, match, conditions, actions, run_count, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)',
  support,
  'Send enterprise customers to Maya',
  'new',
  'all',
  JSON.stringify([{ field: 'from', op: 'ends_with', value: '@globex.example' }]),
  JSON.stringify([{ type: 'assign', value: String(team[1]) }, { type: 'add_tag', value: 'enterprise' }]),
  3,
  start,
)

interface Person {
  name: string
  email: string
  company: string
  title: string
  location: string
  notes?: string
}
const people: Person[] = [
  { name: 'Amara Okafor', email: 'amara@brightpath.example', company: 'Brightpath Studio', title: 'Operations Lead', location: 'Lagos, Nigeria', notes: 'Team plan, 12 seats. Prefers short answers.' },
  { name: 'Lucas Meyer', email: 'lucas.meyer@globex.example', company: 'Globex', title: 'IT Manager', location: 'Berlin, Germany', notes: 'Enterprise contract. Renewal in March.' },
  { name: 'Sofia Rossi', email: 'sofia@rossi-design.example', company: 'Rossi Design', title: 'Founder', location: 'Milan, Italy' },
  { name: 'Kenji Watanabe', email: 'kenji.w@tanuki.example', company: 'Tanuki Labs', title: 'Engineer', location: 'Osaka, Japan' },
  { name: 'Hannah Schultz', email: 'hannah@fernwood.example', company: 'Fernwood Books', title: 'Owner', location: 'Portland, USA' },
  { name: 'Diego Fernández', email: 'diego@solmar.example', company: 'Solmar Travel', title: 'Marketing', location: 'Valencia, Spain' },
  { name: 'Aisha Rahman', email: 'aisha.rahman@kite.example', company: 'Kite Analytics', title: 'Data Analyst', location: 'Dhaka, Bangladesh' },
  { name: 'Oliver Bennett', email: 'oliver@bennettco.example', company: 'Bennett & Co', title: 'Accountant', location: 'Leeds, UK' },
  { name: 'Mei Lin', email: 'mei@paperlantern.example', company: 'Paper Lantern', title: 'Product Manager', location: 'Singapore' },
  { name: 'Noah Williams', email: 'noah.williams@harbor.example', company: 'Harbor Freight Co', title: 'Dispatcher', location: 'Halifax, Canada' },
  { name: 'Fatima Zahra', email: 'fatima@atlasweb.example', company: 'Atlas Web', title: 'Developer', location: 'Casablanca, Morocco' },
  { name: 'Erik Lindqvist', email: 'erik@nordlys.example', company: 'Nordlys', title: 'CTO', location: 'Tromsø, Norway' },
  { name: 'Grace Kim', email: 'grace.kim@maple.example', company: 'Maple Health', title: 'Office Manager', location: 'Seoul, South Korea' },
  { name: 'Rafael Costa', email: 'rafael@costacafe.example', company: 'Costa Café', title: 'Owner', location: 'Porto, Portugal' },
]

interface Scenario {
  subject: string
  ask: string
  answer?: string
  followUp?: string
  note?: string
  tags: string[]
  mailbox?: number
}
const scenarios: Scenario[] = [
  { subject: 'Cannot sign in after changing my password', ask: p('Hi,', 'I changed my password this morning and now the app says “invalid credentials” on every device. I tried the reset link twice. Can you help? I have a client demo at 3pm.'), answer: p('Hi there,', 'Sorry about the trouble before your demo. Your account was locked after several failed attempts. I have unlocked it, so your new password works now.', 'If it fails again, reply here and I will call you.'), followUp: p('That worked, thank you for the fast fix!'), tags: ['login'] },
  { subject: 'Refund for duplicate charge', ask: p('Hello,', 'I was charged twice for the Team plan on the 3rd. Both charges are $49. Please refund one of them.'), answer: p('Hello,', 'You are right, the second charge was a mistake on our side. I have refunded $49 to your card. It should show within 5 to 7 business days.'), tags: ['billing', 'refund'], mailbox: billing },
  { subject: 'How do I export my data to CSV?', ask: p('Is there a way to export all of our projects to CSV? I need it for a quarterly report.'), answer: p('Yes. Open <strong>Settings → Data → Export</strong> and choose CSV. Large workspaces take a few minutes, and we email you a download link when it is ready.'), tags: ['how-to'] },
  { subject: 'Invoice needs our VAT number', ask: p('Hi team,', 'Our accountant needs the VAT number on last month’s invoice. Can you reissue it? The number is in my signature.'), note: p('Reissued invoice INV-2291 with the VAT ID. Finance confirmed the format.'), answer: p('Hi,', 'Done. The corrected invoice is attached to your billing page, and I have added the VAT number to your account so future invoices include it.'), tags: ['billing', 'invoice'], mailbox: billing },
  { subject: 'App is very slow since yesterday', ask: p('Since yesterday afternoon every page takes 10 to 15 seconds to load. Nothing changed on our side. Three people on my team see the same thing.'), note: p('Checked status page: EU region had elevated latency 14:00–17:20 UTC. Engineering deployed a fix. Asked the customer to confirm.'), answer: p('Thanks for flagging this. Our EU servers had a slowdown yesterday that is now fixed. Could you check whether pages load normally for you again?'), tags: ['bug', 'performance'] },
  { subject: 'Feature request: dark mode for the mobile app', ask: p('Love the product. One request: please add dark mode to the mobile app. The web version has it and my eyes would thank you.'), answer: p('Thanks for the kind words. Dark mode for mobile is on our list, and I have added your vote. We will email you when it ships.'), tags: ['feature-request'] },
  { subject: 'Upgrade from Starter to Team plan', ask: p('We are growing and need 8 seats. What happens to our data if we upgrade from Starter to Team mid-month? Do we pay the full price?'), answer: p('Good news: nothing changes with your data, and we only charge the difference for the days left in this month. You can upgrade under <strong>Settings → Plan</strong>, or tell me and I will do it for you.'), followUp: p('Please go ahead and upgrade us to 8 seats.'), tags: ['billing', 'sales'], mailbox: billing },
  { subject: 'Webhook deliveries failing with 401', ask: p('Our webhook endpoint started getting 401 responses from your side on Monday. Signature header looks different from the docs. Did the signing scheme change?'), note: p('Confirmed with platform team: v2 signatures rolled out Monday. Docs page is stale. Filed DOCS-118.'), tags: ['api', 'bug'] },
  { subject: 'Change the owner of our workspace', ask: p('Our previous admin left the company. How do we move workspace ownership to me? I am currently a regular member.'), answer: p('I can help with that. For security we need a confirmation from the current owner’s email address, or a signed letter on company letterhead. Which is easier for you?'), tags: ['account'] },
  { subject: 'Emails from the app go to spam', ask: p('Notification emails from your app land in spam for everyone at our company. We use Google Workspace. Anything we can allowlist?'), answer: p('Yes. Please ask your Google Workspace admin to allowlist <code>mail.northwind.example</code>. I have also attached our SPF and DKIM details in case your IT team wants them.'), tags: ['email', 'how-to'] },
  { subject: 'Cancel my subscription', ask: p('Please cancel my subscription at the end of this billing period. The product is good, we just do not need it any more.'), answer: p('I am sorry to see you go. Your subscription now ends on the last day of this billing period and you will not be charged again. Your data stays available for 30 days after that in case you change your mind.'), tags: ['billing', 'cancellation'], mailbox: billing },
  { subject: 'Is there an API rate limit?', ask: p('We are building an integration and hit 429 errors at around 50 requests per second. What are the limits and can they be raised?'), answer: p('The default limit is 40 requests per second per workspace. For higher volume we can raise it on the Team plan and above. Tell me roughly what you need and I will set it up.'), tags: ['api'] },
  { subject: 'Thank you!', ask: p('Just wanted to say Maya was incredibly helpful on the phone yesterday. Problem solved in five minutes. Thank you!'), answer: p('That made our day. I have passed your message on to Maya. Thanks for taking the time to write.'), tags: ['praise'] },
  { subject: 'Two-factor code not arriving by SMS', ask: p('I am not receiving the SMS code when I sign in. I waited 10 minutes and requested it three times. My number has not changed.'), tags: ['login', 'bug'] },
  { subject: 'Can we get a signed DPA?', ask: p('Our legal team requires a signed data processing agreement before we roll out to the whole company. Do you have a standard one?'), tags: ['legal', 'enterprise'] },
  { subject: 'Attachment upload fails over 10 MB', ask: p('Uploading any file larger than about 10 MB fails with “Something went wrong”. Smaller files work. Screenshot attached.'), tags: ['bug'] },
]

const agent = (id: number): Actor => ({ userId: id, via: 'web' })
let made = 0
const customerFirstSeen = new Map<string, number>()

function make(daysAgo: number, hour: number, scenario: Scenario, person: Person, outcome: 'closed' | 'pending' | 'open' | 'unassigned' | 'mine' | 'snoozed') {
  // History rows land at `hour` o'clock on their day. Rows for today (daysAgo 0) are `hour` hours old.
  const midnight = new Date(start - daysAgo * DAY).setHours(0, 0, 0, 0)
  const created = daysAgo === 0 ? start - hour * HOUR : midnight + hour * HOUR
  const createdAt = Math.min(created + Math.floor(rand() * 40) * 60_000, start - 4 * 60_000)
  const owner = outcome === 'mine' ? team[0] : pick(team)
  const { id } = createConversation(
    { mailboxId: scenario.mailbox ?? support, customerEmail: person.email, customerName: person.name, subject: scenario.subject, bodyHtml: scenario.ask, kind: 'customer', tags: scenario.tags, createdAt },
    { userId: null, via: 'email' },
  )
  customerFirstSeen.set(person.email, Math.min(customerFirstSeen.get(person.email) ?? createdAt, createdAt))
  made++
  if (outcome === 'unassigned') return id

  const replyDelay = (0.2 + rand() * (rand() < 0.2 ? 20 : 3)) * HOUR
  let at = Math.min(createdAt + replyDelay, start - 3 * 60_000)
  if (scenario.note) addNote(id, { bodyHtml: scenario.note, createdAt: Math.max(createdAt + 60_000, at - 5 * 60_000) }, agent(owner))
  if (outcome === 'open' || outcome === 'mine' || outcome === 'snoozed' || !scenario.answer) {
    run('UPDATE conversations SET assignee_id = ? WHERE id = ?', owner, id)
    if (outcome === 'snoozed') updateConversation(id, { snoozedUntil: start + 2 * DAY }, agent(owner))
    return id
  }
  const status: Status = outcome === 'closed' ? 'closed' : 'pending'
  addReply(id, { bodyHtml: scenario.answer, status: scenario.followUp ? 'pending' : status, createdAt: at, skipDelivery: true }, agent(owner))
  if (scenario.followUp && outcome === 'closed') {
    at = Math.min(at + (1 + rand() * 6) * HOUR, start - 2 * 60_000)
    addCustomerMessage(id, { customerId: get<{ customer_id: number }>('SELECT customer_id FROM conversations WHERE id = ?', id)!.customer_id, bodyHtml: scenario.followUp, createdAt: at })
    at = Math.min(at + (0.3 + rand() * 2) * HOUR, start - 60_000)
    addReply(id, { bodyHtml: p('You are welcome. I am closing this for now. Reply any time and it reopens.'), status: 'closed', createdAt: at, skipDelivery: true }, agent(owner))
  }
  return id
}

// Nine weeks of history, busier on weekdays, most of it closed.
for (let day = 64; day >= 2; day--) {
  const weekday = new Date(start - day * DAY).getDay()
  const count = weekday === 0 || weekday === 6 ? Math.floor(rand() * 2) : 2 + Math.floor(rand() * 4)
  for (let i = 0; i < count; i++) {
    const scenario = pick(scenarios.filter((s) => s.answer))
    make(day, 8 + Math.floor(rand() * 10), scenario, pick(people), rand() < 0.93 ? 'closed' : 'pending')
  }
}

// The last two days: a realistic mix of open work.
const s = (subject: string) => scenarios.find((x) => x.subject.startsWith(subject))!
make(1, 9, s('Refund'), people[7], 'closed')
make(1, 11, s('How do I export'), people[8], 'pending')
make(1, 14, s('Upgrade'), people[5], 'pending')
make(1, 15, s('Webhook'), people[10], 'mine')
make(1, 16, s('Change the owner'), people[12], 'snoozed')
make(0, 9, s('App is very slow'), people[1], 'mine')
make(0, 7, s('Is there an API'), people[11], 'open')
make(0, 6, s('Invoice needs'), people[7], 'unassigned')
make(0, 5, s('Can we get a signed DPA'), people[1], 'unassigned')
make(0, 4, s('Emails from the app'), people[4], 'unassigned')
make(0, 3, s('Attachment upload'), people[3], 'unassigned')
make(0, 2, s('Feature request'), people[2], 'unassigned')
make(0, 1, s('Two-factor'), people[6], 'unassigned')
const latest = make(0, 0, s('Cannot sign in'), people[0], 'unassigned')
run('UPDATE conversations SET created_at = ?, updated_at = ?, last_customer_at = ?, waiting_since = ? WHERE id = ?', start - 6 * 60_000, start - 6 * 60_000, start - 6 * 60_000, start - 6 * 60_000, latest)
run('UPDATE threads SET created_at = ? WHERE conversation_id = ?', start - 6 * 60_000, latest)

for (const person of people) {
  const row = get<{ id: number }>('SELECT customer_id AS id FROM customer_emails WHERE email = ?', person.email)
  if (!row) continue
  updateCustomer(row.id, { company: person.company, title: person.title, location: person.location, notes: person.notes ?? '' })
  run('UPDATE customers SET created_at = ? WHERE id = ?', (customerFirstSeen.get(person.email) ?? start) - 3 * DAY, row.id)
}
// Seeding should not leave "assigned by" noise or event rows dated today in old threads.
run(`DELETE FROM threads WHERE type = 'event' AND json_extract(event, '$.kind') != 'snoozed'`)

console.log(`Seeded ${made} conversations, ${people.length} customers, ${team.length} teammates and 2 mailboxes.`)
console.log('Sign in with demo@ansa.local / demo1234')
