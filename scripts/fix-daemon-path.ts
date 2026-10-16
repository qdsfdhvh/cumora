/**
 * Fix the Cumora daemon's PATH so agents use YOUR toolchain.
 *
 *   node --import tsx scripts/fix-daemon-path.ts            # show + fix the plist
 *   node --import tsx scripts/fix-daemon-path.ts --reload   # …then restart the service
 *
 * Why this exists: `cumora agent computer --install-service` copies the PATH of
 * whatever shell ran it into the LaunchAgent. Run it from a session that has
 * per-session shims ahead of the real binaries and the agents inherit them —
 * most visibly `gh`, whose session shim answers
 * `[Lody GitHub] … code: "context_missing"` for any agent that tries to read a
 * pull request, even though `gh` is installed and logged in.
 *
 * This drops those session-scoped directories from the plist, keeping the order
 * of everything else, and reloads the service when asked. Re-running
 * `--install-service` from such a shell will poison the PATH again — run this
 * afterwards (or install the service from a plain terminal).
 */
import { spawnSync } from 'node:child_process'
import { reloadDaemonService } from './lib/reload-daemon.js'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'io.cumora.daemon.plist')
const LABEL = 'io.cumora.daemon'
const reload = process.argv.includes('--reload')

if (!existsSync(PLIST)) {
  console.error(`no daemon service at ${PLIST} — pair a computer first (Me → Computers)`)
  process.exit(1)
}

/** Directories that only make sense inside an agent session. */
function isSessionShim(path: string): boolean {
  if (path.includes('/gh-session-bin/')) return true
  if (path.startsWith('/Users/') && path.includes('/.lody/repos/') && path.endsWith('node_modules/.bin')) return true
  return false
}

function plistBuddy(...args: string[]): string {
  const r = spawnSync('/usr/libexec/PlistBuddy', [...args, PLIST], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`PlistBuddy ${args.join(' ')} failed: ${r.stderr.trim() || r.status}`)
  return r.stdout.trim()
}

const current = plistBuddy('-c', 'Print :EnvironmentVariables:PATH')
const parts = current.split(':').filter(Boolean)
const seen = new Set<string>()
const kept: string[] = []
const dropped: string[] = []
for (const part of parts) {
  if (isSessionShim(part)) { dropped.push(part); continue }
  if (seen.has(part)) { dropped.push(`${part} (duplicate)`); continue }
  seen.add(part)
  kept.push(part)
}

// Which `gh` the agents would resolve to, before and after.
const firstGh = (list: string[]): string => list.find((p) => existsSync(join(p, 'gh'))) ?? '(none — gh will not be found)'

if (dropped.length === 0) {
  console.log(`PATH already clean (${kept.length} entries); gh → ${firstGh(kept)}`)
} else {
  console.log(`dropping ${dropped.length} session entr${dropped.length === 1 ? 'y' : 'ies'}:`)
  for (const d of dropped) console.log(`  - ${d}`)
  plistBuddy('-c', `Set :EnvironmentVariables:PATH ${kept.join(':')}`)
  console.log(`wrote ${kept.length} entries; gh → ${firstGh(kept)}`)
}

if (reload) {
  if (reloadDaemonService()) console.log('agents pick the new PATH up on their next turn')
} else {
  console.log('reload to apply: launchctl bootout gui/$(id -u)/' + LABEL + ' && launchctl bootstrap gui/$(id -u) ' + PLIST)
}
