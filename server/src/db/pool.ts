import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { env } from '../env.js'
import { embeddedEnabled, EmbeddedPool } from './embedded.js'
import * as schema from './schema.js'

/** Main request pool size. `DATABASE_POOL_MAX` overrides the default of 20.
 * Values that are not an integer from 1 to 100 fall back to 20 so a bad
 * env var cannot open an unbounded number of Cloud SQL connections. */
export function databasePoolMax(raw = process.env.DATABASE_POOL_MAX): number {
  if (raw == null || raw.trim() === '') return 20
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 100) return 20
  return n
}

/** Personal build: when CUMORA_DATA_DIR is set, run against the in-process
 *  PGlite database (see ./embedded.js) instead of an external PostgreSQL.
 *  The embedded pool implements the `pg` Pool surface the server uses. */
export const pool: Pool = embeddedEnabled()
  ? new EmbeddedPool() as unknown as Pool
  : new Pool({
  connectionString: env.DATABASE_URL,
  max: databasePoolMax(),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Defense-in-depth against connection-pool exhaustion. A single slow or stuck
  // query must never pin a pool slot indefinitely — that is exactly how one
  // un-indexed hot query (idle.ts' MAX(created_at) seq-scan) held all 20 slots
  // at ~8s each and 503-ed the entire API. 60s is far above any healthy request
  // (sub-second) but reaps genuine runaways; idle-in-transaction reaps leaked
  // transactions holding a slot open doing nothing. The standalone migration
  // owner and CONCURRENTLY index builds legitimately run longer and disable
  // these on their own session (see ensureSchema -> `SET statement_timeout = 0`).
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 30_000,
  })

pool.on('error', (err) => {
  console.error('[pg] idle client error', err)
})

/** Readiness uses its own single connection. `/api/health` must not wait
 * behind the request pool it is supposed to report on. (Embedded mode has
 * one backend anyway — a separate EmbeddedPool just shares it.) */
export const healthPool: Pool = embeddedEnabled()
  ? new EmbeddedPool() as unknown as Pool
  : new Pool({
  connectionString: env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 1_000,
  statement_timeout: 1_000,
  idle_in_transaction_session_timeout: 30_000,
  })

healthPool.on('error', (err) => {
  console.error('[pg] health pool error', err)
})

export const db = drizzle(pool, { schema })
