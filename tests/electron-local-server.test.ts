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
  }
  serverEnv: () => Record<string, string>
  setStatusHandler: (fn: (s: unknown) => void) => void
  start: () => Promise<void>
  stop: () => void
}

let dir: string
let localServer: LocalServerLike

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
  localServer = require(join(process.cwd(), 'electron', 'localServer.cjs')).localServer as LocalServerLike
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
