/**
 * A small S3 client for DigitalOcean Spaces (any S3-compatible store works: set SPACES_ENDPOINT).
 * Only what backups need: put, get, list, delete and multipart upload.
 */
import { AwsClient } from 'aws4fetch'

export interface SpacesEnv {
  /** Spaces access key and its secret (DigitalOcean → Spaces Object Storage → Access Keys). */
  SPACES_KEY?: string
  SPACES_SECRET?: string
  /** The bucket ("Space") name, e.g. "acme-backups". */
  SPACES_BUCKET?: string
  /** The datacenter, e.g. "nyc3". */
  SPACES_REGION?: string
  /** Folder inside the bucket. Default "ansa". */
  SPACES_PREFIX?: string
  /** Another S3-compatible endpoint, e.g. http://localhost:9555 for testing. Overrides SPACES_REGION. */
  SPACES_ENDPOINT?: string
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? decode(m[1]) : undefined
}
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class Spaces {
  private constructor(
    private aws: AwsClient,
    private base: string,
    private prefix: string,
  ) {}

  /** The configured store, or null when backups are not set up. */
  static from(env: SpacesEnv): Spaces | null {
    const { SPACES_KEY: key, SPACES_SECRET: secret, SPACES_BUCKET: bucket } = env
    if (!key || !secret || !bucket || !(env.SPACES_REGION || env.SPACES_ENDPOINT)) return null
    const endpoint = (env.SPACES_ENDPOINT || `https://${env.SPACES_REGION}.digitaloceanspaces.com`).replace(/\/+$/, '')
    // Spaces accepts "us-east-1" as the signing region for every datacenter.
    const aws = new AwsClient({ accessKeyId: key, secretAccessKey: secret, service: 's3', region: 'us-east-1' })
    const prefix = (env.SPACES_PREFIX ?? 'ansa').replace(/^\/+|\/+$/g, '')
    return new Spaces(aws, `${endpoint}/${bucket}`, prefix ? `${prefix}/` : '')
  }

  /** Where backups go, for messages. */
  get where() {
    return `${this.base}/${this.prefix}`
  }

  private url(key: string, query = '') {
    const path = (this.prefix + key).split('/').map(encodeURIComponent).join('/')
    return `${this.base}/${path}${query}`
  }

  private async call(url: string, init: RequestInit & { headers?: Record<string, string> }, ok: number[] = [200]) {
    // The body is not hashed into the signature: HTTPS protects it, and hashing large files costs CPU time.
    const res = await this.aws.fetch(url, { ...init, headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', ...init.headers } })
    if (!ok.includes(res.status)) {
      const body = await res.text().catch(() => '')
      throw new Error(`Spaces ${init.method ?? 'GET'} ${url.replace(this.base, '')} failed: ${res.status} ${tag(body, 'Code') ?? ''} ${tag(body, 'Message') ?? body.slice(0, 200)}`.trim())
    }
    return res
  }

  async put(key: string, body: Uint8Array | string, type = 'application/octet-stream') {
    await this.call(this.url(key), { method: 'PUT', body: body as BodyInit, headers: { 'content-type': type } })
  }

  /** The object, or null when there is none. */
  async get(key: string): Promise<Response | null> {
    const res = await this.call(this.url(key), { method: 'GET' }, [200, 404])
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    return res
  }

  async remove(key: string) {
    await this.call(this.url(key), { method: 'DELETE' }, [200, 204, 404])
  }

  /** Up to 1000 keys under `folder`, in order, after `startAfter`. Keys are relative to the backup folder. */
  async list(folder: string, startAfter = ''): Promise<{ keys: { key: string; size: number }[]; more: boolean }> {
    const q = new URLSearchParams({ 'list-type': '2', prefix: this.prefix + folder, 'max-keys': '1000' })
    if (startAfter) q.set('start-after', this.prefix + startAfter)
    const xml = await (await this.call(`${this.base}?${q}`, { method: 'GET' })).text()
    const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({ key: tag(m[1], 'Key')!.slice(this.prefix.length), size: Number(tag(m[1], 'Size') ?? 0) }))
    return { keys, more: tag(xml, 'IsTruncated') === 'true' }
  }

  /** Every key under `folder`. For small folders only (the database snapshots). */
  async listAll(folder: string) {
    const out: { key: string; size: number }[] = []
    for (let after = '', more = true; more; ) {
      const page = await this.list(folder, after)
      out.push(...page.keys)
      more = page.more && page.keys.length > 0
      after = page.keys.at(-1)?.key ?? ''
    }
    return out
  }

  /** Upload a stream of unknown length in parts. Every part but the last must be at least 5 MB. */
  async upload(key: string, stream: ReadableStream<Uint8Array>, type: string): Promise<number> {
    const PART = 16 * 1024 * 1024
    const started = await (await this.call(this.url(key, '?uploads'), { method: 'POST', headers: { 'content-type': type } })).text()
    const uploadId = tag(started, 'UploadId')
    if (!uploadId) throw new Error('Spaces did not start the upload.')
    const etags: string[] = []
    let size = 0
    const send = async (part: Uint8Array) => {
      const n = etags.length + 1
      const res = await this.call(this.url(key, `?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`), { method: 'PUT', body: part as BodyInit })
      await res.body?.cancel()
      etags.push(res.headers.get('etag') ?? '')
      size += part.byteLength
    }
    try {
      let chunks: Uint8Array[] = []
      let buffered = 0
      const flush = async () => {
        const part = new Uint8Array(buffered)
        let at = 0
        for (const c of chunks) {
          part.set(c, at)
          at += c.byteLength
        }
        chunks = []
        buffered = 0
        await send(part)
      }
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        buffered += value.byteLength
        if (buffered >= PART) await flush()
      }
      if (buffered > 0 || etags.length === 0) await flush()
      const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(e)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
      const done = await (await this.call(this.url(key, `?uploadId=${encodeURIComponent(uploadId)}`), { method: 'POST', body: xml, headers: { 'content-type': 'application/xml' } })).text()
      // S3 can answer 200 and still report an error in the body.
      if (/<Error>/.test(done)) throw new Error(`Spaces could not finish the upload: ${tag(done, 'Message') ?? done.slice(0, 200)}`)
      return size
    } catch (err) {
      await this.call(this.url(key, `?uploadId=${encodeURIComponent(uploadId)}`), { method: 'DELETE' }, [200, 204, 404]).catch(() => {})
      throw err
    }
  }
}
