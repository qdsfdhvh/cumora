/**
 * Pin the Cumora daemon's version in its LaunchAgent.
 *
 *   node --import tsx scripts/pin-daemon-version.ts                 # pin to this repo's version
 *   node --import tsx scripts/pin-daemon-version.ts --version 0.18.7
 *   node --import tsx scripts/pin-daemon-version.ts --latest        # back to `cumora@latest`
 *   node --import tsx scripts/pin-daemon-version.ts --reload        # …and restart the daemon
 *
 * `agent computer --install-service` writes `npx -y cumora@latest …`, so every
 * restart of the service downloads whatever npm published most recently. On a
 * machine that runs its own server that is a surprise: a new daemon can change
 * protocol details under a server you did not upgrade. Pinning keeps the pair
 * matched until you decide otherwise.
 */
import { spawnSync } from 'node:child_process'
import { reloadDaemonService } from './lib/reload-daemon.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'io.cumora.daemon.plist')
const LABEL = 'io.cumora.daemon'
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : null
}
const reload = argv.includes('--reload')
const toLatest = argv.includes('--latest')

/** This repo's version — the server the daemon should match. */
function repoVersion(): string {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }
  if (!parsed.version) throw new Error('package.json has no version')
  return parsed.version
}

const target = toLatest ? 'cumora@latest' : `cumora@${flag('--version') ?? repoVersion()}`

if (!existsSync(PLIST)) {
  console.error(`no daemon service at ${PLIST} — pair a computer first (Me → Computers)`)
  process.exit(1)
}

const plistBuddy = (...args: string[]): string => {
  const r = spawnSync('/usr/libexec/PlistBuddy', [...args, PLIST], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`PlistBuddy ${args.join(' ')} failed: ${r.stderr.trim() || r.status}`)
  return r.stdout.trim()
}

// ProgramArguments is an array; find the `cumora…` / `cumora@…` entry.
const count = Number(plistBuddy('-c', 'Print :ProgramArguments').match(/^\s*\[(\d+)\]/m)?.[1] ?? 0)
let index = -1
let current = ''
for (let i = 0; i < Math.max(count, 1) + 4 && index < 0; i++) {
  const value = plistBuddy('-c', `Print :ProgramArguments:${i}`)
  if (value.startsWith('cumora')) { index = i; current = value }
}

if (index < 0) {
  console.error('could not find the cumora entry in ProgramArguments — inspect the plist by hand')
  process.exit(1)
}

if (current === target) {
  console.log(`already pinned: ProgramArguments:${index} = ${current}`)
} else {
  plistBuddy('-c', `Set :ProgramArguments:${index} ${target}`)
  console.log(`ProgramArguments:${index}: ${current} → ${target}`)
}

if (reload) {
  reloadDaemonService()
} else {
  console.log(`reload to apply: launchctl bootout gui/$(id -u)/${LABEL} && launchctl bootstrap gui/$(id -u) ${PLIST}`)
}
