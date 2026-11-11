/** Where attachment bytes live. Files on a server, database rows on Cloudflare. */
export interface BlobStore {
  put(key: string, data: Uint8Array): void
  get(key: string): Uint8Array | null
  remove(key: string): void
}

let store: BlobStore | null = null
export function initBlobs(next: BlobStore) {
  store = next
}
const use = (): BlobStore => {
  if (!store) throw new Error('File storage is not ready. Load a platform module first.')
  return store
}

export const blobs: BlobStore = {
  put: (key, data) => use().put(key, data),
  get: (key) => use().get(key),
  remove: (key) => use().remove(key),
}
