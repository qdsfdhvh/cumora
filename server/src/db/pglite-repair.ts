/**
 * Emergency repair helpers for the embedded (PGlite) database.
 *
 * PGlite runs Postgres in-process, so it dies with the process. A **graceful
 * quit closes it cleanly** (the app does that: `pool.end()` → `db.close()`),
 * but a hard kill — `kill -9`, a force-quit, a kernel panic, a power loss —
 * can leave the data directory in a state Postgres refuses to start from:
 *
 *   LOG: request to flush past end of generated WAL; request 0/1BFF530,
 *        current position 0/1BE50E8
 *   FATAL: xlog flush request 0/1BFF530 is not satisfied
 *
 * The failing write is an FSM (free-space map) page: FSM contents are
 * disposable — Postgres rebuilds them lazily and loses nothing but hints — so
 * quarantining the `*_fsm` files lets recovery complete. Corrupted *tuples*
 * (which make a scan spin forever on a HOT-chain cycle) are repaired with
 * `VACUUM FULL` / `REINDEX`, which is what `scripts/local-db-doctor.ts` does.
 *
 * Keep this module dependency-free (fs + path only) so both the server and the
 * doctor script can use it.
 */
import { mkdir, rename, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

/** Every `*_fsm` file under `pgdata/base`. */
async function findFsmFiles(pgdata: string): Promise<string[]> {
  const base = join(pgdata, 'base')
  if (!(await exists(base))) return []
  const out: string[] = []
  for (const db of await readdir(base)) {
    const dir = join(base, db)
    if (!(await stat(dir)).isDirectory()) continue
    for (const name of await readdir(dir)) {
      if (name.endsWith('_fsm')) out.push(join(dir, name))
    }
  }
  return out
}

/**
 * Move every FSM file out of `pgdata` (Postgres rebuilds them on demand).
 * Returns the directory they were moved to, or null when there was nothing
 * to quarantine. The quarantine lives next to `pgdata` so Postgres never
 * scans it.
 */
export async function quarantineFreeSpaceMaps(pgdata: string): Promise<string | null> {
  const files = await findFsmFiles(pgdata)
  if (files.length === 0) return null
  const dir = join(pgdata, '..', `fsm-quarantine-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(dir, { recursive: true })
  for (const file of files) {
    try { await rename(file, join(dir, file.split('/').slice(-2).join('-'))) } catch { /* skip */ }
  }
  return dir
}
