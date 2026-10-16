/**
 * Auto-pairing the local daemon (electron/autoPair.cjs).
 *
 * Only the pure decisions are covered here — the spawn itself is exercised
 * against a throwaway server in the manual runbook (docs/LOCAL_BUILD.md). What
 * matters is that the command we hand the daemon CLI, and the environment it
 * inherits, cannot bake a broken setup into the user's LaunchAgent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const autoPair = require(join(process.cwd(), 'electron', 'autoPair.cjs')) as {
  sanitizePath: (value: string) => string
  findExecutable: (name: string, opts?: { pathValue?: string; exists?: (p: string) => boolean }) => string | null
  buildPairArgv: (o: Record<string, unknown>) => string[]
  buildPairEnv: (base: Record<string, string | undefined>, o?: { allowUnsandboxed?: boolean }) => Record<string, string | undefined>
}

test('sanitizePath drops session shims and duplicates, keeping order', () => {
  const out = autoPair.sanitizePath([
    '/usr/bin',
    '/Users/x/.lody/gh-session-bin/abc123',
    '/opt/homebrew/bin',
    '/Users/x/.lody/repos/foo/node_modules/.bin',
    '/usr/bin',
    '/Users/x/.local/bin',
  ].join(':'))
  assert.equal(out, '/usr/bin:/opt/homebrew/bin:/Users/x/.local/bin')
})

test('findExecutable resolves against the provided path list', () => {
  const exists = (p: string) => p === '/opt/homebrew/bin/npx'
  assert.equal(
    autoPair.findExecutable('npx', { pathValue: '/usr/bin:/opt/homebrew/bin', exists }),
    '/opt/homebrew/bin/npx',
  )
  // The search falls back to the standard install locations, so "not found"
  // means it is nowhere there either.
  assert.equal(autoPair.findExecutable('npx', { pathValue: '/usr/bin', exists: () => false }), null)
  assert.equal(
    autoPair.findExecutable('npx', { pathValue: '/usr/bin', exists }),
    '/opt/homebrew/bin/npx',
    'a minimal PATH (Finder launch) still finds a Homebrew node',
  )
})

test('buildPairArgv pins the version, passes the code and flags', () => {
  assert.deepEqual(
    autoPair.buildPairArgv({ code: 'ABC123', serverUrl: 'http://127.0.0.1:5181', version: '0.18.7', installService: true }),
    ['-y', 'cumora@0.18.7', 'agent', 'computer', '--pair', 'ABC123', '--server', 'http://127.0.0.1:5181', '--install-service'],
  )
  assert.deepEqual(
    autoPair.buildPairArgv({ code: 'ABC', serverUrl: 'http://127.0.0.1:5181', version: '0.18.7', engine: 'pi' }),
    ['-y', 'cumora@0.18.7', 'agent', 'computer', '--pair', 'ABC', '--server', 'http://127.0.0.1:5181', '--engine', 'pi'],
  )
  assert.throws(() => autoPair.buildPairArgv({ serverUrl: 'http://127.0.0.1:5181' }), /pairing code/)
})

test('buildPairEnv sanitises PATH and owns the unsandboxed opt-in', () => {
  const withShim = { PATH: '/Users/x/.lody/gh-session-bin/abc:/opt/homebrew/bin', CUMORA_BYOA_ALLOW_UNSANDBOXED: '1' }
  const off = autoPair.buildPairEnv(withShim, { allowUnsandboxed: false })
  assert.equal(off.PATH, '/opt/homebrew/bin')
  assert.equal(off.CUMORA_BYOA_ALLOW_UNSANDBOXED, undefined, 'without the opt-in the flag must not leak in')

  const on = autoPair.buildPairEnv({ PATH: '/opt/homebrew/bin' }, { allowUnsandboxed: true })
  assert.equal(on.CUMORA_BYOA_ALLOW_UNSANDBOXED, '1')
})
