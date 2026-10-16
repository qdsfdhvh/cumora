/**
 * Reload the Cumora daemon's LaunchAgent.
 *
 * `launchctl bootout` followed immediately by `bootstrap` intermittently fails
 * with "Bootstrap failed: 5: Input/output error" — launchd has not finished
 * tearing the old job down. Retrying the bootstrap is the documented-enough
 * workaround and what makes these maintenance scripts safe to re-run.
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DAEMON_LABEL = 'io.cumora.daemon'
export const DAEMON_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`)

const sleep = (ms: number) => spawnSync('/bin/sleep', [String(ms / 1000)])

export function reloadDaemonService(attempts = 6): boolean {
  const uid = process.getuid?.() ?? 0
  const target = `gui/${uid}/${DAEMON_LABEL}`
  spawnSync('launchctl', ['bootout', target], { encoding: 'utf8' })

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, DAEMON_PLIST], { encoding: 'utf8' })
    const loaded = spawnSync('launchctl', ['print', target], { encoding: 'utf8' }).status === 0
    if (loaded) {
      console.log(`service reloaded${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      return true
    }
    if (r.status !== 0) console.warn(`  bootstrap attempt ${attempt} failed: ${(r.stderr || r.stdout).trim()}`)
    sleep(2_000)
  }
  console.warn('could not reload the service after several attempts — check `launchctl print gui/$(id -u)/' + DAEMON_LABEL + '`')
  return false
}
