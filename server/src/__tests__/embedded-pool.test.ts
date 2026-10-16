/**
 * EmbeddedPool — transaction + concurrency semantics of the PGlite-backed
 * single-backend pool. These are the properties the server's `pg` usage
 * depends on: real BEGIN/COMMIT/ROLLBACK, SAVEPOINT inside a transaction,
 * autocommit statements, and isolation between logical clients (a second
 * client's statements must not join an open transaction).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let pool: import('../db/embedded.js').EmbeddedPool

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cumora-embed-test-'))
  process.env.CUMORA_DATA_DIR = dir
  const mod = await import('../db/embedded.js')
  pool = new mod.EmbeddedPool()
  await pool.query('CREATE TABLE t (id int primary key, v text)')
})

after(async () => {
  await pool.end()
  delete process.env.CUMORA_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

test('autocommit statement commits immediately', async () => {
  await pool.query('INSERT INTO t (id, v) VALUES (1, $1)', ['a'])
  const { rows } = await pool.query('SELECT v FROM t WHERE id = 1')
  assert.equal(rows[0].v, 'a')
})

test('BEGIN/COMMIT persists a transaction', async () => {
  const c = await pool.connect()
  await c.query('BEGIN')
  await c.query('INSERT INTO t (id, v) VALUES (2, $1)', ['b'])
  await c.query('COMMIT')
  c.release()
  const { rows } = await pool.query('SELECT count(*)::int AS c FROM t WHERE id = 2')
  assert.equal(rows[0].c, 1)
})

test('ROLLBACK reverts a transaction', async () => {
  const c = await pool.connect()
  await c.query('BEGIN')
  await c.query('INSERT INTO t (id, v) VALUES (3, $1)', ['c'])
  await c.query('ROLLBACK')
  c.release()
  const { rows } = await pool.query('SELECT count(*)::int AS c FROM t WHERE id = 3')
  assert.equal(rows[0].c, 0)
})

test('SAVEPOINT inside a transaction works (personal-workspace pattern)', async () => {
  const c = await pool.connect()
  await c.query('BEGIN')
  await c.query('SAVEPOINT sp')
  await c.query('INSERT INTO t (id, v) VALUES (4, $1)', ['d'])
  await c.query('ROLLBACK TO SAVEPOINT sp')
  await c.query('INSERT INTO t (id, v) VALUES (5, $1)', ['e'])
  await c.query('COMMIT')
  c.release()
  const { rows } = await pool.query('SELECT id FROM t WHERE id IN (4,5) ORDER BY id')
  assert.deepEqual(rows.map((r) => r.id), [5])
})

test('release() mid-transaction rolls back and frees the backend', async () => {
  const c = await pool.connect()
  await c.query('BEGIN')
  await c.query('INSERT INTO t (id, v) VALUES (6, $1)', ['f'])
  c.release()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const { rows } = await pool.query('SELECT count(*)::int AS c FROM t WHERE id = 6')
  assert.equal(rows[0].c, 0)
})

test('a second client is isolated from an open transaction', async () => {
  const holder = await pool.connect()
  await holder.query('BEGIN')
  await holder.query('INSERT INTO t (id, v) VALUES (7, $1)', ['g'])

  // Other statements must NOT observe or join the open transaction; they
  // queue until it commits.
  let observed: number | null = null
  const queued = pool
    .query<{ c: number }>('SELECT count(*)::int AS c FROM t WHERE id = 7')
    .then((r) => { observed = r.rows[0].c })

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(observed, null, 'pool query must not run inside the open transaction')

  await holder.query('COMMIT')
  holder.release()
  await queued
  assert.equal(observed, 1)
})

test('int8 results are normalized to strings (pg parity)', async () => {
  const { rows } = await pool.query('SELECT 9007199254740993::int8 AS big')
  assert.equal(typeof rows[0].big, 'string')
})

test('multi-statement SQL runs and returns the last result (migration DDL)', async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS m1 (x int);
    CREATE TABLE IF NOT EXISTS m2 (y int);
    INSERT INTO m2 (y) VALUES (1)
  `)
  const { rows } = await pool.query('SELECT count(*)::int AS c FROM m2')
  assert.equal(rows[0].c, 1)
})

test('unsupported extension errors surface (pgvector absent)', async () => {
  await assert.rejects(pool.query('CREATE EXTENSION IF NOT EXISTS vector'))
})
