/**
 * Headless tests for the Electron-side local-server lifecycle
 * (electron/localServer.cjs), run under plain Node with a stubbed `electron`
 * module. The GUI shell itself can only be verified by launching the app;
 * these tests pin what can be checked without a display:
 *
 *   - server.env is created 0600 and round-trips
 *   - the runtime secret is generated once and reused
 *   - the forked server's environment points at the app's data dir, enables
 *     local auth, and allows the renderer origin(s) through CORS
 *   - status() reports readiness + whether an OpenAI key is configured
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Module, { createRequire } from 'node:module'

interface LocalServerLike {
  status: () => {
    state: string; detail: string; port: number; hasApiKey: boolean
    dataDir: string; isDev: boolean; log: string[]
    backups?: { auto: string; keep: number; lastAt: string | null; lastBytes: number; lastError: string | null }
  }
  serverEnv: () => Record<string, string>
  setStatusHandler: (fn: (s: unknown) => void) => void
  start: () => Promise<void>
  stop: () => void
}

let dir: string
let localServer: LocalServerLike
let isBackupDue: (state: { auto?: string; lastAt?: string | null } | undefined, nowMs: number) => boolean
let backupsToDelete: (names: string[], keep: number) => string[]
let listenerPids: (port: number) => number[]

const moduleAny = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'cumora-localserver-test-'))
  // Stub `electron` before localServer.cjs requires it.
  const original = moduleAny._load
  moduleAny._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: { getPath: () => dir, isPackaged: true },
        utilityProcess: { fork: () => { throw new Error('not used in these tests') } },
      }
    }
    return original.call(this, request, parent, isMain)
  }
  const require = createRequire(import.meta.url)
  const mod = require(join(process.cwd(), 'electron', 'localServer.cjs'))
  localServer = mod.localServer as LocalServerLike
  isBackupDue = mod.isBackupDue
  backupsToDelete = mod.backupsToDelete
  listenerPids = mod.listenerPids
})

after(() => {
  localServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('status() reports the app data dir and no key before first run', () => {
  const s = localServer.status()
  assert.equal(s.dataDir, join(dir, 'local'))
  assert.equal(s.port, 5181)
  assert.equal(s.hasApiKey, false)
  assert.equal(s.isDev, false)
})

test('server env enables local auth, embedded data, and the renderer origins', () => {
  const env = localServer.serverEnv()
  assert.equal(env.CUMORA_DATA_DIR, join(dir, 'local'))
  assert.equal(env.CUMORA_LOCAL_AUTH, '1')
  assert.equal(env.CUMORA_UPLOAD_DIR, join(dir, 'local', 'uploads'))
  assert.equal(env.NODE_ENV, 'production')
  assert.equal(env.PORT, '5181')
  const origins = String(env.CUMORA_CORS_ORIGINS).split(',')
  assert.ok(origins.includes('app://cumora'), 'packaged renderer origin must be allowed')
  assert.ok(origins.includes('http://localhost:5180'), 'dev renderer origin must be allowed')
  assert.ok(typeof env.AGENT_RUNTIME_SECRET === 'string' && env.AGENT_RUNTIME_SECRET.length >= 32)
})

test('the runtime secret persists across reads and server.env stays private', () => {
  const first = localServer.serverEnv().AGENT_RUNTIME_SECRET
  const second = localServer.serverEnv().AGENT_RUNTIME_SECRET
  assert.equal(first, second)
  const envPath = join(dir, 'local', 'server.env')
  assert.ok(existsSync(envPath))
  assert.equal(statSync(envPath).mode & 0o777, 0o600, 'server.env must not be world-readable')
})

test('an OpenAI key in server.env is reported and passed to the server', () => {
  writeFileSync(
    join(dir, 'local', 'server.env'),
    'OPENAI_API_KEY=sk-test-123\nAGENT_RUNTIME_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
  )
  const s = localServer.status()
  assert.equal(s.hasApiKey, true)
  assert.equal(localServer.serverEnv().OPENAI_API_KEY, 'sk-test-123')
})

test('automatic backups are off until asked for, and off means never due', () => {
  // Default state: no schedule, so a launch must not write anything.
  const fresh = { auto: 'off', lastAt: null }
  assert.equal(isBackupDue(fresh, Date.now()), false)
  assert.equal(isBackupDue({ auto: 'daily', lastAt: null }, Date.now()), true, 'enabling it should run one')
  assert.equal(isBackupDue(undefined, Date.now()), false)
})

test('isBackupDue honours daily/weekly cadence', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z')
  const hours = (n: number) => new Date(now - n * 3_600_000).toISOString()
  assert.equal(isBackupDue({ auto: 'daily', lastAt: hours(23) }, now), false)
  assert.equal(isBackupDue({ auto: 'daily', lastAt: hours(25) }, now), true)
  assert.equal(isBackupDue({ auto: 'weekly', lastAt: hours(24 * 6) }, now), false)
  assert.equal(isBackupDue({ auto: 'weekly', lastAt: hours(24 * 8) }, now), true)
  // An unparseable stamp must not wedge the schedule forever.
  assert.equal(isBackupDue({ auto: 'daily', lastAt: 'not-a-date' }, now), true)
})

test('backupsToDelete rotates oldest-first and ignores foreign files', () => {
  const names = [
    'cumora-2026-10-14T10-00-00.zip',
    'cumora-2026-10-16T10-00-00.zip',
    'cumora-2026-10-15T10-00-00.zip',
    'cumora-cloud-0.18.7-backup.zip', // not ours — must survive
    'notes.txt',
  ]
  assert.deepEqual(backupsToDelete(names, 2), ['cumora-2026-10-14T10-00-00.zip'])
  assert.deepEqual(backupsToDelete(names, 3), [])
  assert.deepEqual(backupsToDelete(names, 1), ['cumora-2026-10-14T10-00-00.zip', 'cumora-2026-10-15T10-00-00.zip'])
  // A missing/garbage retention falls back to the default rather than deleting
  // everything; a nonsensical negative is clamped to keeping one.
  assert.deepEqual(backupsToDelete(names, Number.NaN), [])
  assert.deepEqual(backupsToDelete(names, 0), [])
  assert.deepEqual(backupsToDelete(names, -5), ['cumora-2026-10-14T10-00-00.zip', 'cumora-2026-10-15T10-00-00.zip'])
})

test('status() reports the backup schedule (off by default)', () => {
  const b = localServer.status().backups
  assert.ok(b, 'status must expose the backup state')
  assert.equal(b.auto, 'off')
  assert.ok(b.keep >= 1)
  assert.equal(b.lastAt, null)
})

test('listenerPids finds the process LISTENing on a port (not its clients)', async () => {
  // The restart path depends on this: a server this instance did not fork has
  // to be found through the port, or a saved config silently never takes effect.
  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => res.end('ok'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const pids = listenerPids(port)
    assert.ok(pids.includes(process.pid), `expected our pid in ${JSON.stringify(pids)}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
  // A port nobody listens on has no owner.
  assert.deepEqual(listenerPids(port), [])
})
