/**
 * Free-space-map quarantine — the one automatic repair the embedded database
 * does at startup. A hard kill can leave an FSM page whose LSN sits past the
 * truncated WAL, which makes Postgres refuse to start; the files are
 * disposable, so they are moved out of the data directory and Postgres
 * rebuilds them on demand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quarantineFreeSpaceMaps } from '../db/pglite-repair.js'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cumora-fsm-'))
  mkdirSync(join(root, 'pgdata', 'base', '1'), { recursive: true })
  mkdirSync(join(root, 'pgdata', 'base', '5'), { recursive: true })
  writeFileSync(join(root, 'pgdata', 'base', '1', '16384_fsm'), 'a')
  writeFileSync(join(root, 'pgdata', 'base', '1', '16384'), 'heap')
  writeFileSync(join(root, 'pgdata', 'base', '5', '16439_fsm'), 'b')
  return root
}

test('moves every FSM file out of pgdata and leaves heap files alone', async () => {
  const root = fixture()
  const pgdata = join(root, 'pgdata')
  const quarantine = await quarantineFreeSpaceMaps(pgdata)
  assert.ok(quarantine, 'returns the quarantine directory')
  assert.equal(existsSync(join(pgdata, 'base', '1', '16384_fsm')), false)
  assert.equal(existsSync(join(pgdata, 'base', '5', '16439_fsm')), false)
  assert.equal(existsSync(join(pgdata, 'base', '1', '16384')), true, 'heap file untouched')
  assert.equal(readdirSync(quarantine).sort().join(','), '1-16384_fsm,5-16439_fsm')
  // Idempotent: nothing left to quarantine.
  assert.equal(await quarantineFreeSpaceMaps(pgdata), null)
  rmSync(root, { recursive: true, force: true })
})

test('a database without FSM files is left untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cumora-fsm-empty-'))
  mkdirSync(join(root, 'pgdata', 'base', '1'), { recursive: true })
  assert.equal(await quarantineFreeSpaceMaps(join(root, 'pgdata')), null)
  rmSync(root, { recursive: true, force: true })
})
