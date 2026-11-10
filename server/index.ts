import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from './config.ts'
import { migrate } from './db.ts'
import { api } from './api.ts'
import { userFromBearer } from './auth.ts'
import { handleMcp } from './mcp.ts'
import { startAllMailboxes, stopAllMailboxes } from './mail/imap.ts'
import { wakeSnoozed } from './services/conversations.ts'

migrate()

const app = new Hono()

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'no-referrer')
  if (!c.res.headers.has('Content-Security-Policy')) {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
  }
})

app.get('/healthz', (c) => c.json({ ok: true }))

// Model Context Protocol endpoint. Authenticate with an API token from Settings → API & MCP.
app.all('/mcp', async (c) => {
  const user = userFromBearer(c.req.header('authorization'))
  if (!user) {
    return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized. Send "Authorization: Bearer <Ansa API token>".' }, id: null }, 401, {
      'WWW-Authenticate': 'Bearer realm="ansa"',
    })
  }
  if (c.req.method !== 'POST') {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless: use POST.' }, id: null }, 405, { Allow: 'POST' })
  }
  return handleMcp(c.req.raw, user)
})

app.route('/api', api)

// The built web app. Unknown paths fall back to index.html so client-side routes work on reload.
const webRoot = path.resolve(process.env.WEB_DIR || 'web/dist')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

app.get('*', (c) => {
  let decoded: string
  try {
    decoded = decodeURIComponent(c.req.path)
  } catch {
    return c.text('Bad request', 400)
  }
  const requested = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(webRoot, requested)
  if (!file.startsWith(webRoot)) return c.text('Not found', 404)
  const isAsset = fs.existsSync(file) && fs.statSync(file).isFile()
  if (!isAsset) {
    if (path.extname(requested)) return c.text('Not found', 404)
    file = path.join(webRoot, 'index.html')
    if (!fs.existsSync(file)) return c.text('The web app is not built yet. Run "npm run build", or use "npm run dev" and open the Vite URL.', 503)
  }
  return new Response(fs.readFileSync(file), {
    headers: {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': requested.startsWith('/assets/') && isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  })
})

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Ansa is running at http://localhost:${info.port} (public URL: ${config.appUrl})`)
  console.log(`Data directory: ${config.dataDir}`)
})

startAllMailboxes()
setInterval(wakeSnoozed, 30_000).unref()

const shutdown = () => {
  console.log('Shutting down…')
  void stopAllMailboxes().finally(() => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err) => console.error('[unhandled]', err))
