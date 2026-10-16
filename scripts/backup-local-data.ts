/**
 * Back up the local Cumora data directory.
 *
 *   node --import tsx scripts/backup-local-data.ts                 # → ~/Documents/cumora-backup-<ts>.zip
 *   node --import tsx scripts/backup-local-data.ts --out ~/x.zip
 *   node --import tsx scripts/backup-local-data.ts --force         # skip the "app is running" check
 *
 * The archive holds everything this machine's Cumora has: the embedded
 * database (`pgdata/`), `uploads/` (avatars, attachments), and `server.env`.
 * Restoring is unpacking it back into place (see docs/LOCAL_BUILD.md).
 *
 * Copying a running PGlite directory can produce a torn archive, so the script
 * refuses while the app's server answers on its port. The in-app button
 * (Me → 本地服务 → 备份数据…) does the same thing but stops the server itself
 * for a few seconds, which is the convenient path when the app is open.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}
const force = argv.includes('--force')

const dataDir = resolve(
  process.env.CUMORA_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Cumora', 'local'),
)
const port = Number(process.env.PORT ?? 5181)
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
const out = resolve(flag('--out') ?? join(homedir(), 'Documents', `cumora-backup-${stamp}.zip`))

if (!existsSync(join(dataDir, 'pgdata'))) {
  console.error(`no embedded database at ${dataDir} — nothing to back up`)
  process.exit(1)
}

/** Is the app's server answering? (It owns the database.) */
async function serverIsRunning(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_500)
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

if (!force && (await serverIsRunning())) {
  console.error(
    `the local server is running on :${port} — copying the database now can produce a torn archive.\n` +
    'Quit the app first, or use Me → 本地服务 → 备份数据… (which pauses the server for you).',
  )
  process.exit(1)
}

mkdirSync(dirname(out), { recursive: true })
const started = Date.now()
// Archive exactly what a restore needs — not whatever else happens to sit in
// the data directory (stray database copies, quarantine dirs).
const items = ['pgdata', 'uploads', 'server.env', 'logs'].filter((name) => existsSync(join(dataDir, name)))
const r = spawnSync('/usr/bin/zip', ['-r', '-q', '-y', out, ...items], { cwd: dataDir, encoding: 'utf8' })
if (r.status !== 0) {
  console.error(`zip failed (${r.status}): ${(r.stderr || r.stdout).trim()}`)
  process.exit(1)
}
console.log(`backed up ${dataDir}\n        → ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, ${Date.now() - started}ms)`)
// The archive holds the data directory's *contents*, so it unpacks back into
// the data directory itself.
console.log(`restore: unzip -o "${out}" -d "${dataDir}"   # then reopen the app`)
