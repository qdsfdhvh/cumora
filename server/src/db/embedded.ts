/**
 * Embedded Postgres — in-process PGlite for the packaged desktop app.
 *
 * When `CUMORA_DATA_DIR` is set, the whole server runs against a single
 * in-process Postgres (PGlite — real Postgres compiled to WASM) instead of
 * an external PostgreSQL server. The database files live on disk under
 * `<CUMORA_DATA_DIR>/pgdata`, so all data persists across app restarts and
 * nothing ever leaves the machine.
 *
 * PGlite is a single-session Postgres: every statement is serialized
 * through one backend. The server's driver surface (`pg` Pool) assumes
 * multiple independent sessions with isolated transactions, so this module
 * emulates the `pg` contract on top of that one backend:
 *
 *  - `pool.query(...)` — statement-level access: acquire the backend for
 *    one statement, run, release.
 *  - `pool.connect()` — a logical client. `BEGIN` on a logical client takes
 *    exclusive ownership of the backend until its `COMMIT` / `ROLLBACK`,
 *    so no other statement can interleave into the transaction. Other
 *    clients queue (FIFO) and proceed after the transaction ends — the
 *    same isolation they would get from separate backends.
 *  - `pg_advisory_lock` is inherently single-session here (always free to
 *    the one backend). Safe in practice: the personal build runs exactly
 *    one server instance.
 *  - Multi-statement SQL strings (migration DDL) run through PGlite's
 *    `exec`; the last statement's result is returned, matching the `pg`
 *    simple-query behavior the code relies on.
 *  - Result values are normalized to match `pg`'s default parsers where
 *    they differ (int8 → string).
 *
 * `npm run dev` / tests leave `CUMORA_DATA_DIR` unset and keep using a
 * real PostgreSQL — this module is inert there.
 */
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'

/** Minimal structural type for anything the server passes as `values`. */
type ParamList = unknown[] | undefined

/** `pg` accepts both `query(text, values)` and `query({ name, text, values })`.
 *  The named form is a prepared-statement hint; PGlite has no such cache, so
 *  the name is accepted and ignored. */
export type QueryInput = string | { name?: string; text: string; values?: unknown[] }

function normalizeQuery(input: QueryInput, values?: unknown[]): { text: string; values: ParamList } {
  if (typeof input === 'string') return { text: input, values }
  const text = typeof input?.text === 'string' ? input.text : ''
  return { text, values: input?.values ?? values }
}

interface RawResult {
  rows: Record<string, unknown>[]
  fields: { name: string; dataTypeID: number }[]
  rowCount: number | null
  command: string | null
}

type PGliteLike = {
  query: (sql: string, params?: unknown[]) => Promise<RawResult & { affectedRows?: number }>
  exec: (sql: string) => Promise<Array<RawResult & { affectedRows?: number; command?: string }>>
  close: () => Promise<void>
}

let pglitePromise: Promise<PGliteLike> | null = null

/** True when the server should run on the embedded database. */
export function embeddedEnabled(): boolean {
  return Boolean(process.env.CUMORA_DATA_DIR)
}

function dataDir(): string {
  const base = process.env.CUMORA_DATA_DIR ?? ''
  if (!base) throw new Error('CUMORA_DATA_DIR is not set')
  return `${base.replace(/\/+$/, '')}/pgdata`
}

async function openPglite(): Promise<PGliteLike> {
  // Dynamic import: dev/test never load the ~30MB WASM module.
  const mod = await import('@electric-sql/pglite')
  // pg_trgm backs the message-search GIN index; it ships as a contrib
  // extension alongside the core WASM. pgvector is NOT available in
  // PGlite — the server already degrades to recency-only agent memory
  // when the extension is absent (see agents/embeddings.ts).
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm')
  const db = new mod.PGlite(dataDir(), { extensions: { pg_trgm } })
  await db.waitReady
  return db as unknown as PGliteLike
}

/** The shared PGlite handle, opened on first use. */
function pglite(): Promise<PGliteLike> {
  if (!pglitePromise) {
    pglitePromise = openPglite().catch((e) => {
      pglitePromise = null
      throw e
    })
  }
  return pglitePromise
}

/** Awaited by index.ts so boot logs order correctly. In embedded mode this
 *  also runs the schema migrations — the packaged app has no separate
 *  migrate Job; a fresh install initialises its database on first launch
 *  (ensureSchema is idempotent + advisory-locked, so every boot is safe). */
export async function bootEmbeddedInfra(): Promise<void> {
  if (!embeddedEnabled()) return
  const { mkdir } = await import('node:fs/promises')
  await mkdir(process.env.CUMORA_DATA_DIR as string, { recursive: true })
  const db = await pglite()
  const v = await db.query('SELECT version() AS v')
  console.log(`[embedded-pg] ${String(v.rows[0]?.v ?? 'Postgres (PGlite)').slice(0, 90)}`)
  const t0 = Date.now()
  const { ensureSchema } = await import('./migrate.js')
  await ensureSchema()
  console.log(`[embedded-pg] schema ready in ${Date.now() - t0}ms`)
}

/* ================= backend serialization ================= */

class BackendGate {
  private holder: symbol | null = null
  private holderLabel = ''
  private queue: Array<{ owner: symbol; resolve: () => void }> = []

  async acquire(owner: symbol, label: string, timeoutMs = 20_000): Promise<void> {
    if (this.holder === null) {
      this.holder = owner
      this.holderLabel = label
      return
    }
    if (this.holder === owner) return // logical client inside its own txn
    await new Promise<void>((resolve, reject) => {
      const entry = { owner, resolve: () => {
        const i = this.queue.indexOf(entry)
        if (i >= 0) this.queue.splice(i, 1)
        this.holder = owner
        this.holderLabel = label
        resolve()
      } }
      this.queue.push(entry)
      if (process.env.CUMORA_DEBUG_GATE === '1') {
        console.warn(`[embedded-gate] WAIT(${label}) behind HOLDER(${this.holderLabel})`)
      }
      setTimeout(() => {
        const i = this.queue.indexOf(entry)
        if (i >= 0) {
          this.queue.splice(i, 1)
          reject(new Error(
            `[embedded-pg] backend wait timeout (${label}) — a transaction held the ` +
            `single backend longer than ${timeoutMs}ms. This usually means nested ` +
            'pool access inside an open transaction.',
          ))
        }
      }, timeoutMs).unref()
    })
  }

  release(owner: symbol): void {
    if (this.holder !== owner) return
    this.holder = null
    this.holderLabel = ''
    const next = this.queue.shift()
    next?.resolve()
  }

  /** Who currently owns the backend (for diagnostics). */
  held(): boolean { return this.holder !== null }
}

const gate = new BackendGate()

/** pg parity: node-postgres default-parses int8 (OID 20) to string. */
function normalizeRow(row: Record<string, unknown>, fields: { name: string; dataTypeID: number }[]): Record<string, unknown> {
  for (const f of fields) {
    if (f.dataTypeID === 20) {
      const v = row[f.name]
      if (typeof v === 'number' || typeof v === 'bigint') row[f.name] = String(v)
    }
  }
  return row
}

async function runSql(
  sql: string,
  params: ParamList,
  owner: symbol,
): Promise<QueryResult<QueryResultRow>> {
  const db = await pglite()
  if (params && params.length > 0) {
    const r = await db.query(sql, params)
    return {
      rows: r.rows.map((row) => normalizeRow(row, r.fields)) as QueryResultRow[],
      fields: r.fields as QueryResult['fields'],
      rowCount: r.rowCount ?? r.rows.length,
      command: r.command ?? null,
    } as QueryResult<QueryResultRow>
  }
  // Multi-statement strings (migration DDL) must run through exec — PGlite's
  // query() uses the extended protocol and rejects multi-statement SQL.
  // node-pg's simple query returns the LAST statement's result; mirror that.
  if (/;\s*\S/.test(stripStringsAndComments(sql))) {
    const results = await db.exec(sql)
    const last = results[results.length - 1] ?? { rows: [], fields: [], rowCount: 0, command: null }
    return {
      rows: last.rows.map((row) => normalizeRow(row, last.fields)) as QueryResultRow[],
      fields: last.fields as QueryResult['fields'],
      rowCount: last.rowCount ?? last.rows.length,
      command: last.command ?? null,
    } as QueryResult<QueryResultRow>
  }
  const r = await db.query(sql)
  return {
    rows: r.rows.map((row) => normalizeRow(row, r.fields)) as QueryResultRow[],
    fields: r.fields as QueryResult['fields'],
    rowCount: r.rowCount ?? r.rows.length,
    command: r.command ?? null,
  } as QueryResult<QueryResultRow>
}

/** Cheap multi-statement detection that ignores semicolons inside string
 *  literals, dollar-quoted bodies, line comments, and block comments. */
function stripStringsAndComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (two === '--') { while (i < sql.length && sql[i] !== '\n') i++; continue }
    if (two === '/*') { i = sql.indexOf('*/', i + 2); i = i < 0 ? sql.length : i + 2; continue }
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue }
        if (sql[i] === quote) { i++; break }
        i++
      }
      out += ' '
      continue
    }
    if (ch === '$') {
      const m = /^\$(\w*)\$/.exec(sql.slice(i))
      if (m) {
        const closer = `$${m[1]}$`
        const end = sql.indexOf(closer, i + closer.length)
        i = end < 0 ? sql.length : end + closer.length
        out += ' '
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

const CONTROL_RE = /^\s*(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PREPARE TRANSACTION)\b/i

/* ================= client + pool ================= */

export class EmbeddedClient {
  private owner = Symbol('pg-client')
  private inTxn = false
  private released = false

  constructor(private readonly hooks: { onTxnEnd: () => void }) {}

  async query<R extends QueryResultRow = QueryResultRow>(input: QueryInput, values?: unknown[]): Promise<QueryResult<R>> {
    if (this.released) throw new Error('[embedded-pg] query after release()')
    const { text: sql, values: params } = normalizeQuery(input, values)
    const control = CONTROL_RE.exec(sql)?.[1]?.toUpperCase()
    if (control === 'BEGIN' || control === 'START TRANSACTION') {
      if (!this.inTxn) {
        await gate.acquire(this.owner, 'BEGIN')
        this.inTxn = true
        try {
          // Actually enter the transaction on the single backend — the gate
          // guarantees no other statement interleaves until COMMIT/ROLLBACK.
          await runSql(sql, params, this.owner)
        } catch (e) {
          this.inTxn = false
          gate.release(this.owner)
          throw e
        }
      }
      // Nested BEGIN on the same backend: real PG warns and stays in the
      // existing transaction — mirror that (no-op).
      return emptyResult(control) as unknown as QueryResult<R>
    }
    const runsInTxn = this.inTxn
    if (!runsInTxn) await gate.acquire(this.owner, sql.slice(0, 60))
    try {
      const result = await runSql(sql, params, this.owner)
      if ((control === 'COMMIT' || control === 'END' || control === 'ROLLBACK') && this.inTxn) {
        this.inTxn = false
        gate.release(this.owner)
        this.hooks.onTxnEnd()
      }
      return result as unknown as QueryResult<R>
    } finally {
      // Autocommit statements hold the backend only for their own duration.
      // (In-transaction statements keep it until COMMIT/ROLLBACK.)
      if (!runsInTxn && !this.inTxn) gate.release(this.owner)
    }
  }

  release(_mode?: unknown): void {
    if (this.released) return
    this.released = true
    if (this.inTxn) {
      // release() mid-transaction: the real Pool would hand a broken
      // session back; emulate ROLLBACK so the backend is not wedged.
      this.inTxn = false
      void runSql('ROLLBACK', undefined, this.owner)
        .catch(() => undefined)
        .then(() => {
          gate.release(this.owner)
          this.hooks.onTxnEnd()
        })
    }
  }
}

function emptyResult(command: string): QueryResult<QueryResultRow> {
  return { rows: [], fields: [], rowCount: null, command } as unknown as QueryResult<QueryResultRow>
}

export class EmbeddedPool {
  private closed = false

  async query<R extends QueryResultRow = QueryResultRow>(input: QueryInput, values?: unknown[]): Promise<QueryResult<R>> {
    if (this.closed) throw new Error('[embedded-pg] pool is closed')
    const { text: sql, values: params } = normalizeQuery(input, values)
    // Implicit pool.query never opens transactions; run + release.
    const owner = Symbol('pool-query')
    if (CONTROL_RE.test(sql)) {
      // Stray control statement through pool.query — treat as its own txn.
      await gate.acquire(owner, sql.slice(0, 60))
      try { return (await runSql(sql, params, owner)) as unknown as QueryResult<R> }
      finally { gate.release(owner) }
    }
    await gate.acquire(owner, sql.slice(0, 60))
    try { return (await runSql(sql, params, owner)) as unknown as QueryResult<R> }
    finally { gate.release(owner) }
  }

  async connect(): Promise<PoolClient> {
    if (this.closed) throw new Error('[embedded-pg] pool is closed')
    const client = new EmbeddedClient({ onTxnEnd: () => {} })
    // The pg PoolClient surface is far wider; every call site in this
    // server only uses query() + release(). Proxy just those, plus
    // no-op event methods for safety.
    const facade = {
      query: (input: QueryInput, values?: unknown[]) => client.query(input, values),
      release: (mode?: unknown) => client.release(mode),
      on: (_: string, __: (...args: never[]) => void) => facade,
      once: (_: string, __: (...args: never[]) => void) => facade,
      removeListener: (_: string, __: (...args: never[]) => void) => facade,
    }
    return facade as unknown as PoolClient
  }

  on(_event: string, _handler: (...args: never[]) => void): this { return this }

  async end(): Promise<void> {
    this.closed = true
    if (pglitePromise) {
      try { const db = await pglite(); await db.close() } catch { /* already closed */ }
      pglitePromise = null
    }
  }
}
