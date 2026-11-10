import sanitizeHtml from 'sanitize-html'

const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img', 'sub', 'sup', 'small',
]

/** Clean untrusted HTML (incoming mail, editor output) down to a small, safe subset. */
export function cleanHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'title'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      ol: ['start'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    allowProtocolRelative: false,
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && /^data:(?!image\/(png|jpe?g|gif|webp))/i.test(frame.attribs.src || ''),
  }).trim()
}

const QUOTE_MARKERS: RegExp[] = [
  /<div[^>]+class\s*=\s*"[^"]*\bgmail_quote\b/i,
  /<blockquote[^>]+class\s*=\s*"[^"]*\bgmail_quote\b/i,
  /<blockquote[^>]+type\s*=\s*"?cite/i,
  /<div[^>]+id\s*=\s*"?(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)/i,
  /<div[^>]+class\s*=\s*"[^"]*\b(yahoo_quoted|moz-cite-prefix|protonmail_quote|zmail_extra)\b/i,
  /<hr[^>]+id\s*=\s*"?stopSpelling/i,
  /<div[^>]*style\s*=\s*"[^"]*border-top:\s*solid\s+#[a-f0-9]{6}\s+1\.0pt/i,
  /<(div|p|span)[^>]*>\s*-{2,}\s*Original Message\s*-{2,}/i,
]

const TRAILING_ATTRIBUTION = /(<(div|p|span|br)[^>]*>\s*)*(On\s[^<]{5,200}\swrote:|Le\s[^<]{5,200}\sa écrit\s?:|Am\s[^<]{5,200}\sschrieb[^<]{0,80}:)\s*(<\/?(div|p|span|br)[^>]*>\s*)*$/i

/**
 * Remove the quoted history a mail client appends to a reply.
 * Returns the trimmed HTML, or null when nothing was removed or nothing useful would remain.
 */
export function stripQuotedHtml(rawHtml: string): string | null {
  let cut = -1
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(rawHtml)
    if (match && (cut === -1 || match.index < cut)) cut = match.index
  }
  if (cut <= 0) return null
  const head = rawHtml.slice(0, cut).replace(TRAILING_ATTRIBUTION, '')
  const cleaned = cleanHtml(head)
  return htmlToText(cleaned).trim().length > 0 ? cleaned : null
}

/** Same idea for plain-text mail. Returns null when nothing was removed. */
export function stripQuotedText(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^On\s.{5,200}\swrote:$/i.test(line) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) || /^_{10,}$/.test(line)) {
      end = i
      break
    }
    // "On ... wrote:" wrapped over two lines by the mail client
    if (/^On\s.{5,200}$/i.test(line) && /wrote:$/i.test((lines[i + 1] || '').trim()) && (lines[i + 2] || '').trim().startsWith('>')) {
      end = i
      break
    }
  }
  if (end === lines.length) {
    let i = lines.length
    while (i > 0 && (lines[i - 1].trim() === '' || lines[i - 1].trimStart().startsWith('>'))) i--
    if (lines.slice(i).some((l) => l.trimStart().startsWith('>'))) end = i
  }
  if (end === lines.length) return null
  const head = lines.slice(0, end).join('\n').trim()
  return head.length > 0 ? head : null
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export { escapeHtml }

/** Turn plain text into simple HTML paragraphs with clickable links. */
export function textToHtml(text: string): string {
  const linked = (segment: string) =>
    escapeHtml(segment).replace(
      /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`,
    )
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${linked(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return !text || text === href || href.startsWith('mailto:') ? text || href : `${text} (${href})`
    })
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|ul|ol|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (match, code: string) => {
      if (ENTITIES[code.toLowerCase()]) return ENTITIES[code.toLowerCase()]
      if (code[0] === '#') {
        const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
      }
      return match
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function previewOf(text: string, length = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat
}

/** Fill {{customer.firstName}}-style placeholders. Unknown placeholders become empty. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
}
