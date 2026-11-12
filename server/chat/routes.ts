/**
 * Public routes for the live chat widget, under /api/chat. No sign-in: a visitor proves which chat is
 * theirs with the token from /start, sent in the X-Ansa-Chat header (or ?token= for the event stream,
 * which cannot send headers).
 */
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { config } from '../config.ts'
import { allowAttempt } from '../auth.ts'
import { subscribe, visitorConnected, visitorDisconnected, viewersOf } from '../events.ts'
import { AppError } from '../services/customers.ts'
import { get } from '../db.ts'
import { chatMailbox, chatOnline, chatSettingsOf, chatStatus, chatTranscript, type ChatMailbox, postVisitorMessage, publicChatConfig, startChat, touchVisitor, visitorFromToken, type Visitor } from '../services/chat.ts'
import { FRAME_SCRIPT, framePage, widgetScript } from './widget.ts'

export const chat = new Hono()

chat.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'That message is too long.' }, 413) }))

chat.onError((err, c) => {
  if (err instanceof AppError) return c.json({ error: err.message }, err.status as 400)
  console.error('[chat]', err)
  return c.json({ error: 'Something went wrong. Try again.' }, 500)
})

const clientIp = (c: Context) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local'

const json = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const data = await c.req.json()
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function visitorOf(c: Context, token = c.req.header('x-ansa-chat')): Visitor & { token: string } {
  const visitor = visitorFromToken(token)
  if (!visitor || !token) throw new AppError('This chat has ended. Start a new one.', 401)
  touchVisitor(token)
  return { ...visitor, token }
}

// The script a website includes. It carries the launcher's color and label, so it is cached only briefly.
chat.get('/widget.js', (c) => {
  let body: string
  try {
    const mailbox = chatMailbox(c.req.query('key'))
    const s = chatSettingsOf(mailbox)
    body = widgetScript({ key: mailbox.chat_key!, base: config.appUrl, color: s.color, title: s.title, hideWhenAway: s.hideWhenAway })
  } catch {
    // A wrong key or a chat that was turned off must not break the website that includes the script.
    body = '/* This chat is not available. */'
  }
  return c.body(body, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' })
})

// The chat window, shown in an iframe on the website. Only listed websites may frame it.
chat.get('/frame', (c) => {
  const mailbox = chatMailbox(c.req.query('key'))
  const s = chatSettingsOf(mailbox)
  const ancestors = s.origins.length ? s.origins.join(' ') : '*'
  return c.html(framePage({ key: mailbox.chat_key!, ...publicChatConfig(mailbox) }), 200, {
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': `default-src 'self'; img-src * data: blob:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`,
  })
})

// Is the chat online? The widget asks from the customer's website, so any origin may read it.
chat.get('/status', (c) => {
  let status = { online: false, hideWhenAway: false, available: false }
  try {
    status = { ...chatStatus(chatMailbox(c.req.query('key'))), available: true }
  } catch {
    /* unknown key or chat turned off: report it unavailable */
  }
  return c.json(status, 200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
})

chat.get('/frame.js', (c) => c.body(FRAME_SCRIPT, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' }))

chat.post('/start', async (c) => {
  if (!allowAttempt(`chat-start:${clientIp(c)}`, 10)) throw new AppError('Too many new chats from your network. Wait a few minutes and try again.', 429)
  const data = await json(c)
  const mailbox = chatMailbox(typeof data.key === 'string' ? data.key : null)
  const { token } = startChat(mailbox, { name: data.name, email: data.email, message: data.message })
  return c.json({ token, transcript: chatTranscript(visitorFromToken(token)!) }, 201)
})

chat.get('/messages', (c) => c.json(chatTranscript(visitorOf(c))))

chat.post('/messages', async (c) => {
  const visitor = visitorOf(c)
  if (!allowAttempt(`chat-message:${visitor.token}`, 150)) throw new AppError('You are sending messages too fast. Wait a moment.', 429)
  postVisitorMessage(visitor, (await json(c)).message)
  return c.json({ transcript: chatTranscript(visitor) }, 201)
})

// Live updates for the visitor: "update" when the conversation changes, "typing" while a teammate writes a reply.
// While this stream is open, the visitor counts as present and replies reach them here instead of by email.
chat.get('/events', (c) => {
  const visitor = visitorOf(c, c.req.query('token'))
  const id = visitor.conversationId
  return streamSSE(c, async (stream) => {
    let open = true
    let typing = false
    const send = (data: unknown) => {
      if (open) void stream.writeSSE({ data: JSON.stringify(data) }).catch(() => {})
    }
    const unsubscribe = subscribe((event) => {
      if (event.type === 'conversation' && event.id === id) {
        // A merge moves the chat to another conversation: end the stream so the widget reconnects to it.
        if (event.reason === 'deleted') return void stream.abort()
        send({ type: 'update' })
      } else if (event.type === 'presence' && event.conversationId === id) {
        const now = event.viewers.some((v) => v.state === 'replying')
        if (now !== typing) send({ type: 'typing', on: (typing = now) })
      }
    })
    visitorConnected(id)
    stream.onAbort(() => {
      open = false
      unsubscribe()
      visitorDisconnected(id)
    })
    typing = viewersOf(id).some((v) => v.state === 'replying')
    const onlineNow = () => {
      const mailbox = get<ChatMailbox>('SELECT * FROM mailboxes WHERE id = ?', visitor.mailboxId)
      return !!mailbox && chatOnline(mailbox)
    }
    let online = onlineNow()
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', online }) })
    if (typing) send({ type: 'typing', on: true })
    // Availability changes with the clock and with teammates coming and going: check it now and then.
    let ticks = 0
    while (open) {
      await stream.sleep(15_000)
      if (!open) break
      const next = onlineNow()
      if (next !== online) send({ type: 'status', online: (online = next) })
      if (++ticks % 2 === 0) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
    }
  })
})

chat.all('*', (c) => c.json({ error: 'Not found.' }, 404))
