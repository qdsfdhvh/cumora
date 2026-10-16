/**
 * Local database doctor — integrity check and emergency repair for the
 * embedded (PGlite) database the personal build runs on.
 *
 *   node --import tsx scripts/local-db-doctor.ts                 # check only
 *   node --import tsx scripts/local-db-doctor.ts --repair        # check + repair
 *   node --import tsx scripts/local-db-doctor.ts --reset-stuck-runs
 *
 * Run it with the app closed (the database allows a single writer).
 *
 * The check uses Postgres' own tools: `verify_heapam` (amcheck) for table
 * corruption and `bt_index_check` for every b-tree index. `--repair` then
 * runs the standard remedies — `VACUUM FULL` on corrupt tables and `REINDEX`
 * on corrupt indexes — and re-checks. `--reset-stuck-runs` closes
 * `agent_runs` rows left 'running' by a crash, so agents stop looking busy.
 *
 * Why this exists: PGlite dies with the process. A graceful quit closes
 * Postgres cleanly, but a hard kill can leave corrupt tuples that make a scan
 * spin forever (a HOT-chain cycle) or a WAL that Postgres refuses to recover.
 * Startup already quarantines free-space-map files (see
 * server/src/db/pglite-repair.ts); this script handles the rest.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { amcheck } from '@electric-sql/pglite/contrib/amcheck'
import { quarantineFreeSpaceMaps } from '../server/src/db/pglite-repair.js'

const args = new Set(process.argv.slice(2))
const doRepair = args.has('--repair')
const resetStuck = args.has('--reset-stuck-runs')

const defaultDataDir = join(process.env.HOME ?? '', 'Library', 'Application Support', 'Cumora', 'local')
const dataDir = (process.env.CUMORA_DATA_DIR ?? defaultDataDir).replace(/\/+$/, '')
const pgdata = join(dataDir, 'pgdata')

if (!existsSync(pgdata)) {
  console.error(`no embedded database at ${pgdata}`)
  process.exit(1)
}

async function open(): Promise<PGlite> {
  try {
    const db = new PGlite(pgdata, { extensions: { amcheck } })
    await db.waitReady
    return db
  } catch (err) {
    const quarantined = await quarantineFreeSpaceMaps(pgdata)
    if (!quarantined) throw err
    console.log(`startup failed; quarantined free-space maps to ${quarantined}; retrying…`)
    const db = new PGlite(pgdata, { extensions: { amcheck } })
    await db.waitReady
    return db
  }
}

const db = await open()
await db.query('CREATE EXTENSION IF NOT EXISTS amcheck').catch(() => { /* already there */ })
await db.query('SET statement_timeout = 300000')

async function userTables(): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY c.relname`,
  )
  return rows.map((r) => r.relname)
}

async function heapProblems(): Promise<Array<{ table: string; items: number }>> {
  const out: Array<{ table: string; items: number }> = []
  for (const table of await userTables()) {
    try {
      const { rows } = await db.query<{ c: number }>(`SELECT count(*)::int c FROM verify_heapam('${table}')`)
      if ((rows[0]?.c ?? 0) > 0) out.push({ table, items: rows[0].c })
    } catch { /* extension missing on this table type */ }
  }
  return out
}

async function indexProblems(): Promise<string[]> {
  const { rows } = await db.query<{ n: string; tbl: string }>(
    `SELECT c.relname n, t.relname tbl FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind = 'i' AND i.indisvalid
      ORDER BY t.relname, c.relname`,
  )
  const bad: string[] = []
  for (const { n, tbl } of rows) {
    try { await db.query(`SELECT bt_index_check('${n}'::regclass)`) }
    catch (e) { if (!/expected "btree"/.test(String((e as Error).message))) bad.push(`${tbl}.${n}`) }
  }
  return bad
}

console.log(`database: ${pgdata}`)
let heaps = await heapProblems()
let indexes = await indexProblems()
console.log(`  tables with corrupt tuples: ${heaps.length ? JSON.stringify(heaps) : 'none'}`)
console.log(`  corrupt b-tree indexes:     ${indexes.length ? indexes.join(', ') : 'none'}`)

if (doRepair && (heaps.length || indexes.length)) {
  for (const { table } of heaps) {
    const t0 = Date.now()
    try {
      await db.query(`VACUUM FULL ${table}`)
      console.log(`  repaired ${table} (VACUUM FULL) in ${Date.now() - t0}ms`)
    } catch (e) {
      console.log(`  VACUUM FULL ${table} failed: ${(e as Error).message}`)
    }
  }
  for (const name of indexes) {
    const t0 = Date.now()
    try {
      await db.query(`REINDEX INDEX ${name}`)
      console.log(`  reindexed ${name} in ${Date.now() - t0}ms`)
    } catch (e) {
      console.log(`  REINDEX ${name} failed: ${(e as Error).message}`)
    }
  }
  heaps = await heapProblems()
  indexes = await indexProblems()
  console.log(`  after repair → corrupt tuples: ${heaps.length ? JSON.stringify(heaps) : 'none'} · corrupt indexes: ${indexes.length ? indexes.join(', ') : 'none'}`)
}

if (resetStuck) {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE agent_runs
        SET status = 'failed', stage = 'orphaned',
            summary = COALESCE(NULLIF(summary, ''), 'Agent run orphaned by a database crash'),
            error = COALESCE(error, 'Closed by local-db-doctor'),
            updated_at = NOW(), finished_at = NOW()
      WHERE status = 'running' RETURNING id`,
  )
  console.log(`  closed ${rows.length} stuck agent run(s)`)
}

const counts = await db.query<{ messages: number; conversations: number; participants: number; running: number }>(
  `SELECT (SELECT count(*)::int FROM messages) messages,
          (SELECT count(*)::int FROM conversations) conversations,
          (SELECT count(*)::int FROM participants) participants,
          (SELECT count(*)::int FROM agent_runs WHERE status = 'running') running`,
)
console.log(`  data: ${JSON.stringify(counts.rows[0])}`)
await db.close()
console.log(heaps.length || indexes.length ? 'RESULT: problems remain — see output above' : 'RESULT: healthy')
