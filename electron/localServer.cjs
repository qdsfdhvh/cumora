/* eslint-env node */
/**
 * Local server + database lifecycle for the personal build.
 *
 * The packaged app is fully self-contained: this module forks the bundled
 * Cumora API server (`resources/local-dist/server.cjs`) as an Electron
 * utility process. That server runs its own in-process PGlite database and
 * Redis-compatible bus (see server/src/db/embedded.ts + local-redis.ts), so
 * there is no Postgres, no Redis, and no network egress to cumora.ai.
 *
 * Everything the server needs lives under the app's userData directory:
 *
 *   <userData>/local/pgdata       — the Postgres data directory (PGlite)
 *   <userData>/local/uploads      — attachments in local-storage mode
 *   <userData>/local/server.env   — operator-editable secrets (OPENAI key,
 *                                   runtime secret) written by the app
 *   <userData>/local/logs/server.log
 *
 * In dev (`npm run electron:dev`) the server is started separately by
 * concurrently; this module then only health-probes it, so the dev flow is
 * unchanged.
 */
const { app, utilityProcess } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const SERVER_PORT = 5181
const HEALTH_PATH = '/api/health'
const HEALTH_TIMEOUT_MS = 120_000
const MAX_LOG_LINES = 500

/** Env-var keys the app owns in server.env. */
const ENV_FILE_KEYS = ['OPENAI_API_KEY', 'AGENT_RUNTIME_SECRET', 'CUMORA_DURABILITY']

function localDir() {
  return path.join(app.getPath('userData'), 'local')
}

function envFilePath() {
  return path.join(localDir(), 'server.env')
}

function logFilePath() {
  return path.join(localDir(), 'logs', 'server.log')
}

/** Minimal KEY=VALUE reader (no dotenv dependency in the Electron main). */
function readEnvFile() {
  const out = {}
  try {
    const raw = fs.readFileSync(envFilePath(), 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      out[key] = value
    }
  } catch { /* absent file → defaults */ }
  return out
}

function writeEnvFile(values) {
  fs.mkdirSync(localDir(), { recursive: true })
  const merged = { ...readEnvFile(), ...values }
  const body = [
    '# Cumora local server — secrets for THIS machine only.',
    '# Written by the desktop app; safe to edit by hand (restart the app after).',
    // Never blank a line that already has a value: merging a partial update
    // (say the durability toggle) must not erase the key.
    ...ENV_FILE_KEYS.map((k) => `${k}=${merged[k] ?? ''}`).filter((line) => !line.endsWith('=')),
    '',
  ].join('\n')
  fs.writeFileSync(envFilePath(), body, { mode: 0o600 })
}

function ensureRuntimeSecret() {
  const existing = readEnvFile().AGENT_RUNTIME_SECRET
  if (existing && existing.length >= 32) return existing
  const secret = crypto.randomBytes(32).toString('hex')
  writeEnvFile({ AGENT_RUNTIME_SECRET: secret })
  return secret
}

/** Server bundle location. Packaged: extraResources. Dev: source entry. */
function packagedServerPath() {
  return path.join(process.resourcesPath, 'local-dist', 'server.cjs')
}

function devCommandHint() {
  return 'npm run server:dev'
}

function probeHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: SERVER_PORT, path: HEALTH_PATH, timeout: timeoutMs },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          resolve(res.statusCode === 200 && body.includes('"ok":true'))
        })
      },
    )
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

class LocalServer {
  constructor() {
    this.child = null
    this.state = 'stopped' // stopped | starting | ready | error
    this.detail = ''
    this.logLines = []
    this.onStatus = null
    this.startPromise = null
    this.backingUp = false
  }

  setStatusHandler(handler) { this.onStatus = handler }

  status() {
    const envFile = readEnvFile()
    return {
      state: this.state,
      detail: this.detail,
      /** True while a backup is in flight (the server is briefly stopped). */
      backingUp: this.backingUp === true,
      /** Write durability: 'safe' (default) or 'fast' (see server/src/env.ts). */
      durability: envFile.CUMORA_DURABILITY === 'fast' ? 'fast' : 'safe',
      port: SERVER_PORT,
      hasApiKey: Boolean(envFile.OPENAI_API_KEY),
      dataDir: localDir(),
      isDev: !app.isPackaged,
      log: this.logLines.slice(-120),
    }
  }

  emit() {
    try { this.onStatus?.(this.status()) } catch { /* renderer gone */ }
  }

  pushLog(line) {
    const stamped = line.replace(/\s+$/, '')
    if (!stamped) return
    this.logLines.push(stamped)
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES)
    try {
      fs.appendFileSync(logFilePath(), stamped + '\n')
    } catch { /* log dir missing is non-fatal */ }
    this.emit()
  }

  /** Build the environment the forked server boots with. */
  serverEnv() {
    const dir = localDir()
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      // Embedded data + auth defaults for a single-user local install.
      CUMORA_DATA_DIR: dir,
      CUMORA_UPLOAD_DIR: path.join(dir, 'uploads'),
      // Absolute /uploads URLs — the renderer runs on app://cumora, where a
      // relative path would resolve against the app scheme and 404.
      CUMORA_UPLOADS_BASE: `http://127.0.0.1:${SERVER_PORT}`,
      CUMORA_LOCAL_AUTH: '1',
      // The renderer is served from app://cumora in production and
      // http://localhost:5180 in dev — both must pass CORS.
      CUMORA_CORS_ORIGINS: 'app://cumora,http://localhost:5180,http://127.0.0.1:5180',
      AGENT_RUNTIME_SECRET: ensureRuntimeSecret(),
    }
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
    const envFile = readEnvFile()
    if (envFile.OPENAI_API_KEY) env.OPENAI_API_KEY = envFile.OPENAI_API_KEY
    if (envFile.CUMORA_DURABILITY) env.CUMORA_DURABILITY = envFile.CUMORA_DURABILITY
    return env
  }

  /**
   * Copy the whole data directory into a zip.
   *
   * The embedded database must not be copied while Postgres is running (a torn
   * copy is unopenable), so this stops the server first — which closes PGlite
   * cleanly — archives, then starts it again. A few seconds of downtime, and
   * the app stays open.
   */
  async backupTo(destPath) {
    if (this.backingUp) return { ok: false, error: 'a backup is already running' }
    if (!destPath || typeof destPath !== 'string') return { ok: false, error: 'no destination' }
    this.backingUp = true
    this.emit()
    const wasRunning = this.state === 'ready'
    try {
      this.stop()
      // Give launchd/Node a beat to release the data directory.
      await new Promise((resolve) => setTimeout(resolve, 800))
      const result = await new Promise((resolve) => {
        // Archive exactly what a restore needs. `zip` (present on macOS) takes
        // several roots in one pass and, unlike `ditto`, does not add
        // AppleDouble `._*` entries or sweep in stray copies sitting next to
        // the database.
        const items = ['pgdata', 'uploads', 'server.env', 'logs'].filter((name) => fs.existsSync(path.join(localDir(), name)))
        const child = spawn('/usr/bin/zip', ['-r', '-q', '-y', destPath, ...items], { cwd: localDir() })
        child.on('error', (e) => resolve({ ok: false, error: e.message }))
        child.on('exit', (code) => {
          if (code === 0) {
            let bytes = 0
            try { bytes = fs.statSync(destPath).size } catch { /* ignore */ }
            resolve({ ok: true, path: destPath, bytes })
          } else {
            resolve({ ok: false, error: `zip exited with code ${code}` })
          }
        })
      })
      if (result.ok) this.pushLog(`[backup] wrote ${result.path} (${Math.round(result.bytes / 1024 / 1024)} MB)`)
      else this.pushLog(`[backup] failed: ${result.error}`)
      return result
    } finally {
      this.backingUp = false
      if (wasRunning || app.isPackaged) await this.start()
      this.emit()
    }
  }

  /** Start (or adopt) the local server. Resolves once it is healthy. */
  start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#startInner().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  async #startInner() {
    // Fast path: something healthy already listens (a previous instance that
    // outlived the app, or the dev server started by electron:dev).
    if (await probeHealth()) {
      this.state = 'ready'
      this.detail = app.isPackaged ? 'already running' : `external (${devCommandHint()})`
      this.emit()
      return
    }

    this.state = 'starting'
    this.detail = app.isPackaged ? 'starting local server' : `dev server not reachable — run \`${devCommandHint()}\``
    this.emit()

    if (!app.isPackaged) {
      // Dev: the server is a separate process; poll until it appears.
      const ok = await this.waitHealth(HEALTH_TIMEOUT_MS).catch(() => false)
      this.state = ok ? 'ready' : 'error'
      this.detail = ok ? `external (${devCommandHint()})` : `dev server not reachable — run \`${devCommandHint()}\``
      this.emit()
      return
    }

    const entry = packagedServerPath()
    if (!fs.existsSync(entry)) {
      this.state = 'error'
      this.detail = `server bundle missing: ${entry}`
      this.emit()
      return
    }

    const ok = await this.#forkAndWait(entry)
    this.state = ok ? 'ready' : 'error'
    this.detail = ok ? 'ready' : 'local server did not become healthy in time — see 本地服务 → 日志'
    this.emit()
  }

  /**
   * Fork the bundled server and wait for it to answer a health probe. Retried
   * once, because a restart can race the previous process releasing the port and
   * the database directory; one retry turns that into a two-second blip instead
   * of a dead server the owner has to figure out.
   */
  async #forkAndWait(entry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const child = utilityProcess.fork(entry, [], {
        cwd: localDir(),
        env: this.serverEnv(),
        stdio: 'pipe',
        serviceName: 'cumora-local-server',
      })
      this.child = child
      child.stdout?.on('data', (chunk) => this.pushLog(String(chunk)))
      child.stderr?.on('data', (chunk) => this.pushLog(String(chunk)))
      child.on('exit', (code) => {
        this.child = null
        if (this.state !== 'stopped') {
          this.state = 'error'
          this.detail = `local server exited (code ${code ?? 'null'}) — see 本地服务 → 日志`
          this.emit()
        }
      })
      if (await this.waitHealth(HEALTH_TIMEOUT_MS).catch(() => false)) return true
      if (attempt === 1) {
        this.pushLog(`[local-server] attempt ${attempt} did not answer health; retrying\n`)
        await this.#stopAndWait()
      }
    }
    return false
  }

  async waitHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await probeHealth()) return true
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return false
  }

  /** Switch write durability and restart so the server picks it up. */
  async setDurability(mode) {
    const value = mode === 'fast' ? 'fast' : 'safe'
    writeEnvFile({ CUMORA_DURABILITY: value })
    await this.restart()
    return this.status()
  }

  /** Persist the OpenAI key and restart so the server picks it up. */
  async setOpenAIKey(key) {
    const trimmed = String(key ?? '').trim()
    writeEnvFile({ OPENAI_API_KEY: trimmed })
    await this.restart()
    return this.status()
  }

  /**
   * Stop and wait for the old process to really be gone before starting the
   * next one. A flat sleep here was a bug: PGlite releases its data directory
   * as the child tears down, so starting the replacement too early made it die
   * on a locked database — the owner saw "local server did not become healthy
   * in time" with nothing to act on.
   */
  async restart() {
    await this.#stopAndWait()
    return this.start()
  }

  /** SIGTERM the child, then resolve once it exited (or the deadline passed). */
  async #stopAndWait(timeoutMs = 10000) {
    const child = this.child
    this.child = null
    this.state = 'stopped'
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('exit', done)
      try {
        child.kill()
      } catch {
        done()
      }
      setTimeout(done, timeoutMs)
    })
    // The port and the database directory are released slightly after exit.
    await new Promise((r) => setTimeout(r, 300))
  }

  stop() {
    const child = this.child
    this.child = null
    this.state = 'stopped'
    if (child) {
      try { child.kill() } catch { /* already gone */ }
    }
  }
}

const localServer = new LocalServer()

module.exports = { localServer, SERVER_PORT }
