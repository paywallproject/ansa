// Minimal types for the Workers runtime pieces this project uses.
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}

interface SqlCursor {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
  /** The rows as arrays of values, in column order. */
  raw(): IterableIterator<unknown[]>
}
interface DurableObjectState {
  /** Stop this object now. The next request starts a fresh one with the latest code. Always throws. */
  abort(reason?: string): never
  /** Keep the object alive until this work finishes, after the response has gone. */
  waitUntil(promise: Promise<unknown>): void
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor }
    kv: { get<T = unknown>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }
    transactionSync<T>(fn: () => T): T
    getAlarm(): Promise<number | null>
    setAlarm(time: number): Promise<void>
    /** Resolves once every write so far is saved. */
    sync(): Promise<void>
  }
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response>; backup(): Promise<string> }
}
interface ScheduledController {
  scheduledTime: number
  cron: string
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}
