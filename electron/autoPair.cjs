/* eslint-env node */
/**
 * Pair THIS machine with the local Cumora server, without the user pasting a
 * command into a terminal.
 *
 * The user-facing flow is Me → Computers → "Add a computer": the renderer mints
 * a pairing code from the API it is already authenticated against, hands the
 * code here, and this module runs the published daemon CLI:
 *
 *   npx -y cumora@<version> agent computer --pair <code> --server http://127.0.0.1:<port>
 *
 * Two details make the one-click path behave like a careful manual setup:
 *
 *   1. **PATH is sanitised before spawning.** `--install-service` copies the
 *      spawning shell's PATH into the LaunchAgent, so a session that had
 *      per-session shims (a wrapper `gh`/`git`) would bake them into the daemon
 *      and break the agents' tools. Session-scoped directories are dropped.
 *   2. **The service env is finished afterwards.** The CLI's installer does not
 *      propagate the unsandboxed-engine opt-in, so when the user allows those
 *      engines we add `CUMORA_BYOA_ALLOW_UNSANDBOXED=1` to the plist and reload
 *      the job (launchd does not re-read a plist on `kickstart`).
 *
 * Deliberately dependency-free (fs/path/child_process only) so the pure parts
 * are unit-testable without Electron.
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DAEMON_LABEL = 'io.cumora.daemon'
const DAEMON_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`)
const PAIR_TIMEOUT_MS = 180_000

/** Directories that only make sense inside an agent/session shell. */
function isSessionShimDir(dir) {
  if (dir.includes('/gh-session-bin/')) return true
  if (dir.includes('/.lody/repos/') && dir.endsWith('node_modules/.bin')) return true
  return false
}

/** Drop session-scoped directories, keeping order and dropping duplicates. */
function sanitizePath(value) {
  const seen = new Set()
  const kept = []
  for (const dir of String(value ?? '').split(':').filter(Boolean)) {
    if (isSessionShimDir(dir)) continue
    if (seen.has(dir)) continue
    seen.add(dir)
    kept.push(dir)
  }
  return kept.join(':')
}

/** Where a node/npx could live on a normal macOS install. */
function candidateBinDirs(pathValue = process.env.PATH ?? '') {
  const home = os.homedir()
  return [
    ...String(pathValue).split(':').filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.volta', 'bin'),
    '/usr/bin',
  ]
}

/** First directory that actually contains an executable `name`. */
function findExecutable(name, { pathValue = process.env.PATH, exists = (p) => {
  try { return fs.existsSync(p) && fs.statSync(p).isFile() } catch { return false }
} } = {}) {
  const seen = new Set()
  for (const dir of candidateBinDirs(pathValue)) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const candidate = path.join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/** The argv the daemon CLI is invoked with (pure — unit-tested). */
function buildPairArgv({ code, serverUrl, version, engine, installService }) {
  if (!code) throw new Error('a pairing code is required')
  const args = [
    '-y', `cumora@${version || 'latest'}`,
    'agent', 'computer',
    '--pair', String(code),
    '--server', String(serverUrl),
  ]
  if (engine) args.push('--engine', String(engine))
  if (installService) args.push('--install-service')
  return args
}

/** Environment for the spawned daemon install. */
function buildPairEnv(base = process.env, { allowUnsandboxed = false } = {}) {
  const env = { ...base, PATH: sanitizePath(base.PATH) }
  // The flag must be visible to the CLI so it accepts unsandboxed engines, and
  // so `--install-service` sees it in its own environment.
  if (allowUnsandboxed) env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'
  else delete env.CUMORA_BYOA_ALLOW_UNSANDBOXED
  return env
}

function plistBuddy(...args) {
  const r = spawnSync('/usr/libexec/PlistBuddy', [...args, DAEMON_PLIST], { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function reloadDaemonService(attempts = 6) {
  const uid = process.getuid?.() ?? 0
  const target = `gui/${uid}/${DAEMON_LABEL}`
  spawnSync('launchctl', ['bootout', target], { encoding: 'utf8' })
  for (let attempt = 1; attempt <= attempts; attempt++) {
    spawnSync('launchctl', ['bootstrap', `gui/${uid}`, DAEMON_PLIST], { encoding: 'utf8' })
    if (spawnSync('launchctl', ['print', target], { encoding: 'utf8' }).status === 0) return true
    spawnSync('/bin/sleep', ['2'])
  }
  return false
}

/**
 * Make the installed service match the chosen options. Only needed for the
 * unsandboxed opt-in (the CLI installer ignores it) — and for that we must
 * reload the job, because `launchctl kickstart` keeps the environment launchd
 * already has.
 */
function ensureDaemonServiceEnv({ allowUnsandboxed }) {
  if (!fs.existsSync(DAEMON_PLIST)) return { ok: true, changed: false }
  if (!allowUnsandboxed) return { ok: true, changed: false }
  const current = plistBuddy('-c', 'Print :EnvironmentVariables:CUMORA_BYOA_ALLOW_UNSANDBOXED')
  if (current.ok && current.out === '1') return { ok: true, changed: false }
  const added = current.ok
    ? plistBuddy('-c', 'Set :EnvironmentVariables:CUMORA_BYOA_ALLOW_UNSANDBOXED 1')
    : plistBuddy('-c', 'Add :EnvironmentVariables:CUMORA_BYOA_ALLOW_UNSANDBOXED string 1')
  if (!added.ok) return { ok: false, error: `PlistBuddy failed: ${added.err || added.out}` }
  const reloaded = reloadDaemonService()
  return { ok: true, changed: true, reloaded }
}

/**
 * Run the pairing. Streams the CLI's output through `onOutput` (one line per
 * call) and resolves with a summary. Never throws — the UI renders the log.
 */
async function pairThisMachine(opts) {
  const {
    code, serverUrl, version, engine, installService = true,
    allowUnsandboxed = false, onOutput = () => {},
  } = opts

  const npx = findExecutable('npx')
  if (!npx) {
    return {
      ok: false,
      error: 'no_node',
      log: '',
      hint: 'Node.js (npx) was not found on this Mac — install Node, or use the copy-paste command.',
    }
  }

  const args = buildPairArgv({ code, serverUrl, version, engine, installService })
  const env = buildPairEnv(process.env, { allowUnsandboxed })
  const command = `${npx} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`
  onOutput(`$ ${command}`)

  const log = await new Promise((resolve) => {
    const child = spawn(npx, args, { env, cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    const lines = []
    const push = (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\s+$/, '')
        buffer = buffer.slice(index + 1)
        if (line) { lines.push(line); onOutput(line) }
      }
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      lines.push(`(timed out after ${Math.round(PAIR_TIMEOUT_MS / 1000)}s)`)
    }, PAIR_TIMEOUT_MS)
    child.stdout.on('data', (c) => push(String(c)))
    child.stderr.on('data', (c) => push(String(c)))
    child.on('error', (e) => { clearTimeout(timer); lines.push(`spawn failed: ${e.message}`); resolve({ code: -1, lines }) })
    child.on('exit', (exitCode) => {
      clearTimeout(timer)
      if (buffer.trim()) { lines.push(buffer.trim()); onOutput(buffer.trim()) }
      resolve({ code: exitCode ?? -1, lines })
    })
  })

  const output = log.lines.join('\n')
  if (log.code !== 0) {
    return { ok: false, error: 'pair_failed', log: output, exitCode: log.code, command }
  }
  if (installService) {
    const serviceEnv = ensureDaemonServiceEnv({ allowUnsandboxed })
    if (!serviceEnv.ok) return { ok: false, error: 'service_env_failed', log: output, detail: serviceEnv.error, command }
    if (serviceEnv.changed) onOutput('service environment updated (unsandboxed engines allowed) and the daemon reloaded')
  }
  return { ok: true, log: output, command }
}

module.exports = {
  DAEMON_PLIST,
  sanitizePath,
  findExecutable,
  candidateBinDirs,
  buildPairArgv,
  buildPairEnv,
  ensureDaemonServiceEnv,
  pairThisMachine,
}
