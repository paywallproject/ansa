import sanitizeHtml from 'sanitize-html'

/**
 * "Show original": the email as its sender designed it, and where it came from, as in Gmail.
 *
 * The conversation view strips mail down to plain formatting so every message reads alike. Here the
 * layout survives: tables, colours, inline styles and <style> blocks. The app shows the result in a
 * sandboxed frame with scripts off, and the page's own Content Security Policy still applies inside it.
 */

const DESIGNED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'picture', 'pre', 'q',
  's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]

const LAYOUT_ATTRIBUTES = [
  'style', 'class', 'id', 'align', 'valign', 'width', 'height', 'bgcolor', 'background', 'border', 'cellpadding', 'cellspacing',
  'color', 'face', 'size', 'dir', 'lang', 'title', 'role', 'colspan', 'rowspan', 'nowrap', 'hspace', 'vspace', 'frame', 'rules',
  'span', 'start', 'type', 'aria-hidden', 'aria-label',
]

/** Keep the email's own design, without anything that runs, submits or embeds another page. */
export function designedHtml(html: string, inlineImages: { contentId: string; url: string }[] = []): string {
  let source = html
  for (const image of inlineImages) {
    // Match the whole reference so "cid:img1" does not also rewrite "cid:img10".
    const ref = new RegExp(`cid:${image.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'\\s>)])`, 'gi')
    source = source.replace(ref, image.url)
  }
  return sanitizeHtml(source, {
    allowedTags: DESIGNED_TAGS,
    allowVulnerableTags: true, // <style>: harmless here, since nothing in the frame can run
    allowedAttributes: {
      '*': LAYOUT_ATTRIBUTES,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'srcset', 'alt'],
      ol: ['start', 'type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'select', 'button', 'iframe', 'object', 'svg', 'math'],
    transformTags: {
      // The <body> often carries the background colour: keep it on a wrapper.
      body: (_tagName, attribs) => ({ tagName: 'div', attribs }),
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
    },
  }).trim()
}

export interface DeliveryDetails {
  /** The domain bounces go back to (Return-Path), Gmail's "mailed-by". */
  mailedBy: string | null
  /** Domains whose DKIM signature checked out, Gmail's "signed-by". */
  signedBy: string[]
  /** Whether the last hop reached your mail server over TLS. Null when the headers do not say. */
  tls: boolean | null
  /** SPF, DKIM and DMARC results from your mail server, when it recorded them. */
  checks: { name: 'SPF' | 'DKIM' | 'DMARC'; result: string }[]
}

type Header = { name: string; value: string }

const domainOf = (address: string) => address.replace(/^.*?</, '').replace(/>.*$/, '').trim().split('@').pop()?.toLowerCase() || null

/** A hop inside your own mail provider: delivery to the mailbox (LMTP), a hand-off from localhost or a private address, or one with no sender at all. */
const INTERNAL_HOP = /^(?!\s*from\s)|\bwith (LMTPS?A?|local|HTTPS?|IMAP)\b|\blocalhost\b|\[(127\.|::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i
const TLS_HOP = /\bE?SMTPS(A)?\b|\bTLS ?v?1|\bversion=TLS|\bcipher=|Google Transport Security/i
const PLAIN_HOP = /\bwith E?SMTPA?\b/i

/**
 * Whether the email reached your mail provider encrypted. Received headers are read newest first: hops
 * inside your provider are skipped, and the first hop that says how it was carried decides. Null when
 * none says, so Ansa never warns on a guess.
 */
export function deliveredOverTls(received: string[]): boolean | null {
  for (const hop of received.slice(0, 8)) {
    if (INTERNAL_HOP.test(hop)) continue
    if (TLS_HOP.test(hop)) return true
    if (PLAIN_HOP.test(hop)) return false
  }
  return null
}

/**
 * Where the email came from, from its headers. Only the topmost Authentication-Results header and the
 * newest hops count: your own mail provider adds those, while lower ones could be written by anyone.
 */
export function deliveryDetails(headers: Header[]): DeliveryDetails {
  const first = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? null
  const auth = first('authentication-results') ?? ''

  const returnPath = first('return-path')
  const mailFrom = /smtp\.mailfrom=([^\s;]+)/i.exec(auth)?.[1]
  const mailedBy = (returnPath && returnPath.includes('@') ? domainOf(returnPath) : null) ?? (mailFrom ? domainOf(mailFrom) : null)

  const signedBy = new Set<string>()
  for (const match of auth.matchAll(/dkim=pass\b([^;]*)/gi)) {
    const d = /header\.d=([^\s;]+)/i.exec(match[1])?.[1] ?? /header\.i=@?([^\s;]+)/i.exec(match[1])?.[1]
    if (d) signedBy.add(domainOf(d.includes('@') ? d : `@${d}`)!)
  }

  const checks: DeliveryDetails['checks'] = []
  for (const name of ['SPF', 'DKIM', 'DMARC'] as const) {
    const result = new RegExp(`\\b${name}=([a-z]+)`, 'i').exec(auth)?.[1]
    if (result) checks.push({ name, result: result.toLowerCase() })
  }

  // Exim (cPanel, DirectAdmin, MXroute) writes no Authentication-Results: it appends X-DKIM and
  // X-DMARC-Status at the end of the headers, so only the last of each is its own.
  if (!auth) {
    const last = (name: string) => headers.findLast((h) => h.name.toLowerCase() === name)?.value ?? null
    const spf = /^\s*([a-z]+)/i.exec(first('received-spf') ?? '')?.[1]
    if (spf) checks.push({ name: 'SPF', result: spf.toLowerCase() })
    const dkim = last('x-dkim')
    const dkimStatus = dkim && /status='?([a-z]+)/i.exec(dkim)?.[1]?.toLowerCase()
    if (dkimStatus) {
      checks.push({ name: 'DKIM', result: dkimStatus })
      const signer = /signer='?([^'\s]+)/i.exec(dkim!)?.[1]
      if (dkimStatus === 'pass' && signer) signedBy.add(signer.toLowerCase())
    }
    const dmarc = /^\s*([a-z]+)/i.exec(last('x-dmarc-status') ?? '')?.[1]
    if (dmarc) checks.push({ name: 'DMARC', result: dmarc.toLowerCase() })
  }

  const tls = deliveredOverTls(headers.filter((h) => h.name.toLowerCase() === 'received').map((h) => h.value))

  return { mailedBy, signedBy: [...signedBy], tls, checks }
}
