/**
 * A complete Ansa app as a Cloudflare Worker. Free to run, no server to manage.
 *
 *   npx wrangler deploy
 *   npx wrangler secret put ANSA_APP_SECRET     (paste the signing secret from Settings → Apps)
 *
 * In Ansa, open Settings → Apps and enter:
 *   Sidebar URL:  https://<your-worker>.workers.dev/sidebar
 *   Webhook URL:  https://<your-worker>.workers.dev/webhook
 */

/** Check that the request really comes from your Ansa. */
async function isFromAnsa(body, signature, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const expected = 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return signature === expected
}

const escape = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])

// Replace this with a call to your own shop, billing system or database.
async function findOrders(email) {
  return email.endsWith('@example.com') ? [{ id: 1042, total: '$129.00', status: 'Shipped' }] : []
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const body = await request.text()
    if (request.method !== 'POST' || !(await isFromAnsa(body, request.headers.get('x-ansa-signature'), env.ANSA_APP_SECRET))) {
      return new Response('Bad signature', { status: 401 })
    }
    const data = JSON.parse(body)

    if (url.pathname === '/sidebar') {
      const orders = await findOrders(data.customer.email)
      const html = orders.length
        ? `<p><strong>${orders.length} order${orders.length === 1 ? '' : 's'}</strong></p><ul>` +
          orders.map((o) => `<li><a href="https://shop.example.com/orders/${o.id}">#${o.id}</a> · ${escape(o.total)} · ${escape(o.status)}</li>`).join('') +
          '</ul>'
        : `<p>No orders for ${escape(data.customer.email)}.</p>`
      return Response.json({ html })
    }

    if (url.pathname === '/webhook') {
      console.log(`[${data.event}] #${data.conversation.id} "${data.conversation.subject}" from ${data.customer.email}`)
      // Do your work here: post to Slack, create a CRM record, start a refund...
      return new Response('ok')
    }

    return new Response('Not found', { status: 404 })
  },
}
