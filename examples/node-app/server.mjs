/**
 * A complete Ansa app in one file, with no dependencies.
 *
 *   ANSA_APP_SECRET=ansa_app_... node server.mjs
 *
 * It answers two requests from Ansa:
 *   POST /sidebar   -> content for the conversation sidebar
 *   POST /webhook   -> events such as "conversation.created"
 * In Ansa, open Settings → Apps and enter these two addresses.
 */
import http from 'node:http'
import crypto from 'node:crypto'

const SECRET = process.env.ANSA_APP_SECRET || ''
const PORT = Number(process.env.PORT || 8788)

/** Check that the request really comes from your Ansa. Never skip this in production. */
function isFromAnsa(body, signature) {
  if (!SECRET) return true // only for a first local try
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex')
  return signature?.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

// Replace this with a lookup in your own database, shop or billing system.
async function findOrders(email) {
  return email.endsWith('@example.com') ? [{ id: 1042, total: '$129.00', status: 'Shipped' }] : []
}

const escape = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])

http
  .createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    if (req.method !== 'POST' || !isFromAnsa(body, req.headers['x-ansa-signature'])) {
      res.writeHead(401).end('Bad signature')
      return
    }
    const data = JSON.parse(body)

    if (req.url === '/sidebar') {
      const orders = await findOrders(data.customer.email)
      const html = orders.length
        ? `<p><strong>${orders.length} order${orders.length === 1 ? '' : 's'}</strong></p><ul>` +
          orders.map((o) => `<li><a href="https://shop.example.com/orders/${o.id}">#${o.id}</a> · ${escape(o.total)} · ${escape(o.status)}</li>`).join('') +
          '</ul>'
        : `<p>No orders for ${escape(data.customer.email)}.</p>`
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ html }))
      return
    }

    if (req.url === '/webhook') {
      console.log(`[${data.event}] #${data.conversation.id} "${data.conversation.subject}" from ${data.customer.email}`)
      // Do your work here: post to Slack, create a CRM record, start a refund...
      res.writeHead(200).end('ok')
      return
    }

    res.writeHead(404).end('Not found')
  })
  .listen(PORT, () => console.log(`Ansa example app on http://localhost:${PORT}`))
