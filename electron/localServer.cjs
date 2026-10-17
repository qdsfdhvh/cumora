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
const { spawn, spawnSync } = require('node:child_process')

const SERVER_PORT = 5181
const HEALTH_PATH = '/api/health'
const HEALTH_TIMEOUT_MS = 120_000
const MAX_LOG_LINES = 500

/** Env-var keys the app owns in server.env. */
const ENV_FILE_KEYS = [
  'OPENAI_API_KEY',
  'AGENT_RUNTIME_SECRET',
  'CUMORA_DURABILITY',
  // Model service (Me → 本地服务 → 模型服务). Absent ⇒ the OpenAI defaults.
  // CUMORA_LLM_BASE_URL points the server's own LLM calls at any
  // OpenAI-compatible endpoint; the OPENAI_MODEL* names go with it.
  'CUMORA_LLM_BASE_URL',
  'CUMORA_LLM_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_MODEL_SUPPORT',
  'OPENAI_COMPACTION_MODEL',
  // Images may live on a different endpoint than text (a DeepSeek key cannot
  // draw). Empty ⇒ OpenAI when text is OpenAI, else AI avatars are unavailable.
  'CUMORA_LLM_RESPONSES_NATIVE',
  'CUMORA_IMAGE_BASE_URL',
  'CUMORA_IMAGE_API_KEY',
  'OPENAI_IMAGE_MODEL',
]

const BACKUP_DIR_NAME = 'backups'
const BACKUP_PREFIX = 'cumora-'
const BACKUP_DEFAULT_KEEP = 7

/**
 * Is an automatic backup due? Pure so the cadence can be tested without waiting
 * a day: `auto` is off/daily/weekly and `lastAt` is the last successful run.
 */
function isBackupDue(state, nowMs) {
  const auto = state?.auto
  if (auto !== 'daily' && auto !== 'weekly') return false
  const last = state?.lastAt ? Date.parse(state.lastAt) : Number.NaN
  if (!Number.isFinite(last)) return true
  const periodMs = auto === 'daily' ? 86_400_000 : 7 * 86_400_000
  return nowMs - last >= periodMs
}

/**
 * Which backup files to delete to keep `keep` newest. Pure; names carry an
 * ISO-derived stamp so a plain string sort is chronological. Only files this
 * feature wrote are considered — anything else in the folder is left alone.
 * A missing/garbage `keep` falls back to the default (never "delete all"), and
 * an absurd number is clamped to 1..60.
 */
function backupsToDelete(names, keep) {
  const wanted = Math.max(1, Math.min(60, Number(keep) || BACKUP_DEFAULT_KEEP))
  // Strictly the files this feature writes (cumora-<stamp>.zip). A loose
  // startsWith/endsWith would also match a user's own "cumora-cloud-8.0-backup.zip"
  // sitting in the folder and quietly delete it.
  const pattern = new RegExp(`^${BACKUP_PREFIX}\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.zip$`)
  const mine = names.filter((n) => typeof n === 'string' && pattern.test(n)).sort()
  return mine.slice(0, Math.max(0, mine.length - wanted))
}

/** Filesystem-safe, sortable stamp: 2026-10-16T10-53-12. */
function backupStamp(d = new Date()) {
  return d.toISOString().slice(0, 19).replace(/:/g, '-')
}

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

function backupStatePath() {
  return path.join(localDir(), 'backup-state.json')
}

function readBackupState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(backupStatePath(), 'utf8'))
    return {
      auto: parsed?.auto === 'daily' || parsed?.auto === 'weekly' ? parsed.auto : 'off',
      keep: Number.isFinite(parsed?.keep) ? parsed.keep : BACKUP_DEFAULT_KEEP,
      lastAt: typeof parsed?.lastAt === 'string' ? parsed.lastAt : null,
      lastPath: typeof parsed?.lastPath === 'string' ? parsed.lastPath : null,
      lastBytes: Number.isFinite(parsed?.lastBytes) ? parsed.lastBytes : 0,
      lastError: typeof parsed?.lastError === 'string' ? parsed.lastError : null,
    }
  } catch {
    return { auto: 'off', keep: BACKUP_DEFAULT_KEEP, lastAt: null, lastPath: null, lastBytes: 0, lastError: null }
  }
}

function writeBackupState(next) {
  const dir = localDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(backupStatePath(), JSON.stringify(next, null, 2))
}

/**
 * Fingerprint of the settings that only take effect at boot (the model service,
 * durability, the key). Stamped onto the forked server as CUMORA_CONFIG_REV and
 * echoed on /api/health, so the app can tell whether a running server was
 * started with the configuration it would use now.
 */
function configRevision() {
  const envFile = readEnvFile()
  const parts = ENV_FILE_KEYS
    .filter((k) => k !== 'AGENT_RUNTIME_SECRET')
    .map((k) => `${k}=${envFile[k] ?? ''}`)
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16)
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

/**
 * PIDs LISTENING on a port (never clients — `-sTCP:LISTEN`), via lsof, which
 * every macOS ships. Used to make sure a restart is not defeated by a server
 * this instance did not fork: one can outlive a hard-killed app, and
 * `backupTo()` stops and starts the server as well.
 */
function listenerPids(port) {
  for (const bin of ['/usr/sbin/lsof', 'lsof']) {
    const out = spawnSync(bin, ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    if (out.error) continue
    return String(out.stdout ?? '')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }
  return []
}

/** Resolves the health payload (`{ok, rev}`) when a server answers, else null. */
function probeHealthBody(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: SERVER_PORT, path: HEALTH_PATH, timeout: timeoutMs },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200 || !body.includes('"ok":true')) return resolve(null)
          try {
            resolve(JSON.parse(body))
          } catch {
            // Older builds answer with plain ok — no revision to compare.
            resolve({ ok: true, rev: null })
          }
        })
      },
    )
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

function probeHealth(timeoutMs = 1500) {
  return probeHealthBody(timeoutMs).then((body) => body !== null)
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
      /** Automatic backups: cadence, retention and the last successful run. */
      backups: readBackupState(),
      /** Which model service the server's own LLM calls use. Empty strings
       *  mean the built-in OpenAI defaults. */
      llm: {
        baseUrl: envFile.CUMORA_LLM_BASE_URL ?? '',
        model: envFile.OPENAI_MODEL ?? '',
        modelSupport: envFile.OPENAI_MODEL_SUPPORT ?? '',
        hasKey: Boolean(envFile.CUMORA_LLM_API_KEY || envFile.OPENAI_API_KEY),
        imageBaseUrl: envFile.CUMORA_IMAGE_BASE_URL ?? '',
        imageApiKeyStored: Boolean(envFile.CUMORA_IMAGE_API_KEY),
        imageModel: envFile.OPENAI_IMAGE_MODEL ?? '',
        /** True when the endpoint speaks Responses natively (e.g. Magpie). */
        responsesNative: envFile.CUMORA_LLM_RESPONSES_NATIVE === '1',
      },
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
      // See configRevision(): the server echoes this so a restart is skipped
      // only when the running process really has the current settings.
      CUMORA_CONFIG_REV: configRevision(),
    }
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
    const envFile = readEnvFile()
    // Anything the owner saved from the app overrides the inherited
    // environment; absent keys leave the server's own defaults in place.
    for (const key of ENV_FILE_KEYS) {
      if (key === 'AGENT_RUNTIME_SECRET') continue
      if (envFile[key]) env[key] = envFile[key]
    }
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
      await this.#stopAndWait()
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

  /**
   * Backups the app writes itself, into <data>/backups. Off by default: this
   * writes files on a schedule, so it only ever happens because the owner asked
   * for it. Rotation keeps the newest N and nothing else in the folder is
   * touched.
   */
  async runLocalBackup() {
    const dir = path.join(localDir(), BACKUP_DIR_NAME)
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `${BACKUP_PREFIX}${backupStamp()}.zip`)
    const result = await this.backupTo(dest)
    const prev = readBackupState()
    if (!result.ok) {
      const failed = { ...prev, lastError: result.error ?? 'unknown error' }
      writeBackupState(failed)
      this.emit()
      return result
    }
    let deleted = []
    try {
      deleted = backupsToDelete(fs.readdirSync(dir), prev.keep)
      for (const name of deleted) fs.unlinkSync(path.join(dir, name))
    } catch { /* rotation is best-effort */ }
    writeBackupState({
      ...prev,
      lastAt: new Date().toISOString(),
      lastPath: dest,
      lastBytes: result.bytes ?? 0,
      lastError: null,
    })
    this.pushLog(`[backup] auto ${dest} (${Math.round((result.bytes ?? 0) / 1024 / 1024)} MB)${deleted.length ? ` · rotated out ${deleted.length}` : ''}`)
    this.emit()
    return result
  }

  /** Change the cadence/retention. Enabling it (or asking while due) runs one. */
  async setBackupConfig({ auto, keep }) {
    const prev = readBackupState()
    const cadence = auto === 'daily' || auto === 'weekly' || auto === 'off' ? auto : prev.auto
    const retention = Math.max(1, Math.min(60, Number(keep) || prev.keep))
    writeBackupState({ ...prev, auto: cadence, keep: retention })
    this.emit()
    if (isBackupDue(readBackupState(), Date.now())) await this.runLocalBackup()
    return this.status()
  }

  /** Called after launch: a due daily/weekly backup runs once, in the
   *  background, a few minutes in (it briefly stops the server to copy a
   *  consistent database). */
  async runAutoBackupIfDue() {
    if (!isBackupDue(readBackupState(), Date.now())) return null
    return await this.runLocalBackup()
  }

  /** Start (or adopt) the local server. Resolves once it is healthy. */
  start({ adopt = true } = {}) {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#startInner(adopt).finally(() => { this.startPromise = null })
    return this.startPromise
  }

  async #startInner(adopt = true) {
    // Fast path: something healthy already listens (a previous instance that
    // outlived the app, or the dev server started by electron:dev). Only taken
    // when the caller allows adoption AND that server carries the current
    // configuration: adopting one started with older settings made a saved
    // change look like it did nothing (every server-side call kept going to the
    // previous endpoint).
    if (adopt) {
      const running = await probeHealthBody()
      // Dev keeps adopting whatever is on the port — that server is started by
      // hand (`npm run server:dev`) and killing it would be hostile.
      if (running !== null && (!app.isPackaged || running.rev === configRevision())) {
        this.state = 'ready'
        this.detail = app.isPackaged ? 'already running' : `external (${devCommandHint()})`
        this.emit()
        return
      }
      if (running !== null && app.isPackaged) {
        this.pushLog(`[local-server] a server is already running with different settings (rev ${running.rev ?? 'unknown'}) — replacing it\n`)
        await this.#stopAndWait()
      }
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
   * Point the server's own LLM calls at another OpenAI-compatible endpoint
   * (DeepSeek and friends), and restart so it takes effect. The key goes into
   * CUMORA_LLM_API_KEY when a custom provider is selected, so switching
   * providers does not overwrite the OpenAI key you may still want.
   */
  async setLlmConfig({ baseUrl, model, modelSupport, apiKey, imageBaseUrl, imageModel, imageApiKey, responsesNative }) {
    const clean = (v) => String(v ?? '').trim()
    const url = clean(baseUrl).replace(/\/+$/, '')
    if (url && !/^https?:\/\//i.test(url)) {
      throw new Error('base URL must start with http:// or https://')
    }
    const imageUrl = clean(imageBaseUrl).replace(/\/+$/, '')
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      throw new Error('image base URL must start with http:// or https://')
    }
    const main = clean(model)
    const small = clean(modelSupport) || main
    const patch = {
      CUMORA_LLM_BASE_URL: url,
      OPENAI_MODEL: main,
      OPENAI_MODEL_SUPPORT: small,
      OPENAI_COMPACTION_MODEL: small,
      // Empty clears the line, which is how AI avatars get switched off again.
      CUMORA_IMAGE_BASE_URL: imageUrl,
      OPENAI_IMAGE_MODEL: clean(imageModel),
    }
    if (typeof responsesNative === 'boolean') {
      patch.CUMORA_LLM_RESPONSES_NATIVE = responsesNative ? '1' : ''
    }
    const imageKey = clean(imageApiKey)
    if (imageKey) patch.CUMORA_IMAGE_API_KEY = imageKey
    // OpenAI itself keeps using OPENAI_API_KEY (see server/src/env.ts: the
    // custom key falls back to it anyway).
    const key = clean(apiKey)
    if (key) patch[url ? 'CUMORA_LLM_API_KEY' : 'OPENAI_API_KEY'] = key
    writeEnvFile(patch)
    await this.restart()
    return this.status()
  }

  /**
   * Restart so the next process reads the current config.
   *
   * Adoption is NOT allowed here. `#startInner`'s fast path ("something healthy
   * already listens → adopt it") is right when the app is starting up, and
   * wrong when the whole point is to replace the server: if the old process had
   * not finished dying, the replacement was skipped and the saved config stayed
   * unread while the app reported "already running". That is exactly how a
   * DeepSeek setting could be saved and still have every call go to
   * api.openai.com.
   */
  async restart() {
    await this.#stopAndWait()
    return this.start({ adopt: false })
  }

  /**
   * Stop the local server and wait until it is really gone (bounded).
   *
   * A flat sleep here was a bug (PGlite releases its data directory as the child
   * tears down, so starting the replacement too early made it die on a locked
   * database). Assuming `this.child` is the server was a second one: a server
   * can outlive the app that forked it, and `backupTo()` stops and starts it
   * too, so the process answering on the port is not always ours. Whatever
   * listens on our port is killed — this app is the only thing that uses it.
   */
  async #stopAndWait(timeoutMs = 10000) {
    const child = this.child
    this.child = null
    this.state = 'stopped'
    if (child && child.exitCode === null && child.signalCode === null) {
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
    }
    const strays = listenerPids(SERVER_PORT).filter((pid) => pid !== process.pid)
    if (strays.length > 0) {
      this.pushLog(`[local-server] stopping a server this instance did not fork (pid ${strays.join(', ')})\n`)
      for (const pid of strays) {
        try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && await probeHealth(500).catch(() => false)) {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
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

module.exports = { localServer, SERVER_PORT, isBackupDue, backupsToDelete, listenerPids }
