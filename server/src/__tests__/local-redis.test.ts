/**
 * LocalRedis — behavioral parity tests for the in-process Redis replacement
 * against the exact call shapes the server uses (pub/sub fan-out, wake-retry
 * zsets, busy-lease SET NX EX, seen-boundary eval scripts, pipelines).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalRedisClient } from '../local-redis.js'

test('strings: set/get/del/exists/incr/expire/keys/getdel', async () => {
  const r = new LocalRedisClient()
  assert.equal(await r.set('a', '1'), 'OK')
  assert.equal(await r.get('a'), '1')
  assert.equal(await r.exists('a'), 1)
  assert.equal(await r.set('a', '2', 'EX', 5, 'NX'), null) // NX fails on existing key
  assert.equal(await r.get('a'), '1')
  assert.equal(await r.incr('ctr'), 1)
  assert.equal(await r.incr('ctr'), 2)
  assert.equal(await r.expire('a', 100), 1)
  assert.equal(await r.expire('missing', 100), 0)
  assert.deepEqual(await r.keys('a'), ['a'])
  assert.equal(await r.getdel('a'), '1')
  assert.equal(await r.get('a'), null)
  assert.equal(await r.del('ctr'), 1)
})

test('set EX NX claims a lease exactly once (busy-lease pattern)', async () => {
  const r = new LocalRedisClient()
  const first = await r.set('busy:agent-1', String(Date.now()), 'EX', 30, 'NX')
  const second = await r.set('busy:agent-1', String(Date.now()), 'EX', 30, 'NX')
  assert.equal(first, 'OK')
  assert.equal(second, null)
})

test('hashes: hset/hget/hsetnx/hdel/hgetall', async () => {
  const r = new LocalRedisClient()
  assert.equal(await r.hset('jobs', 'j1', '{"attempt":1}'), 1)
  assert.equal(await r.hset('jobs', 'j1', '{"attempt":2}'), 0)
  assert.equal(await r.hget('jobs', 'j1'), '{"attempt":2}')
  assert.equal(await r.hget('jobs', 'nope'), null)
  assert.equal(await r.hsetnx('jobs', 'j2', 'x'), 1)
  assert.equal(await r.hsetnx('jobs', 'j2', 'y'), 0)
  assert.equal(await r.hget('jobs', 'j2'), 'x')
  assert.equal(await r.hdel('jobs', 'j1'), 1)
  assert.deepEqual(await r.hgetall('jobs'), { j2: 'x' })
  assert.deepEqual(await r.hgetall('missing'), {})
})

test('zsets: zadd/zrem/zscore/zrange WITHSCORES/zrangebyscore LIMIT', async () => {
  const r = new LocalRedisClient()
  assert.equal(await r.zadd('due', 100, 'a'), 1)
  assert.equal(await r.zadd('due', 200, 'b'), 1)
  assert.equal(await r.zadd('due', 150, 'c'), 1)
  assert.equal(await r.zscore('due', 'b'), '200')
  assert.deepEqual(await r.zrangebyscore('due', 0, 150, 'LIMIT', 0, 10), ['a', 'c'])
  assert.deepEqual(await r.zrangebyscore('due', 0, 150, 'LIMIT', 1, 1), ['c'])
  assert.deepEqual(await r.zrange('due', 0, -1, 'WITHSCORES'), ['a', '100', 'c', '150', 'b', '200'])
  assert.deepEqual(await r.zrange('due', 0, -1), ['a', 'c', 'b'])
  assert.equal(await r.zrem('due', 'a'), 1)
  assert.equal(await r.zrem('due', 'gone'), 0)
})

test('zadd NX preserves the original claim (markThinking pattern)', async () => {
  const r = new LocalRedisClient()
  assert.equal(await r.zadd('thk', 100, 'agent-1'), 1)
  assert.equal(await r.zadd('thk', 'NX' as unknown as number, 200, 'agent-1' as unknown as string) ?? null, 0)
  assert.equal(await r.zscore('thk', 'agent-1'), '100')
})

test('pub/sub: message fan-out to subscribers only', async () => {
  const r = new LocalRedisClient()
  const sub = new LocalRedisClient()
  const got: Array<[string, string]> = []
  await sub.subscribe('ch:1', (err: unknown) => assert.equal(err, null))
  sub.on('message', (channel, payload) => got.push([channel, payload]))
  assert.equal(await r.publish('ch:1', JSON.stringify({ hello: 1 })), 1)
  assert.equal(await r.publish('ch:other', 'x'), 0)
  assert.equal(got.length, 1)
  assert.deepEqual(got[0], ['ch:1', '{"hello":1}'])
})

test('subscribe() before on(message) still delivers (scheduler order)', async () => {
  const sub = new LocalRedisClient()
  const r = new LocalRedisClient()
  await sub.subscribe('cumora:msg.new')
  const got: string[] = []
  sub.on('message', (_c, p) => got.push(p))
  await r.publish('cumora:msg.new', 'payload')
  assert.deepEqual(got, ['payload'])
})

test('multi() pipeline runs queued commands and returns results', async () => {
  const r = new LocalRedisClient()
  const pipe = r.multi()
  pipe.incr('n').expire('n', 60).zadd('thk:c1', 'NX', 123, 'agent-1' as unknown as number).expire('thk:c1', 60)
  const res = await pipe.exec()
  assert.deepEqual(res, [1, 1, 1, 1])
  assert.equal(await r.get('n'), '1')
  assert.equal(await r.zscore('thk:c1', 'agent-1'), '123')
})

test('multi() zrem (unmarkThinking pattern)', async () => {
  const r = new LocalRedisClient()
  await r.zadd('thk:c9', 1, 'a')
  const pipe = r.multi()
  pipe.zrem('thk:c9', 'a')
  await pipe.exec()
  assert.equal(await r.zscore('thk:c9', 'a'), null)
})

test('eval: MONOTONIC_SET_SCRIPT semantics', async () => {
  const r = new LocalRedisClient()
  const script = `
local cur = tonumber(redis.call('GET', KEYS[1])) or 0
local newv = tonumber(ARGV[1]) or 0
if newv > cur then
  redis.call('SET', KEYS[1], newv, 'EX', ARGV[2])
  return 1
end
return 0
`
  assert.equal(await r.eval(script, 1, 'k', '5', '60'), 1)
  assert.equal(await r.get('k'), '5')
  assert.equal(await r.eval(script, 1, 'k', '4', '60'), 0)
  assert.equal(await r.eval(script, 1, 'k', '9', '60'), 1)
  assert.equal(await r.get('k'), '9')
})

test('eval: CONSUME_SCRIPT get-and-delete', async () => {
  const r = new LocalRedisClient()
  const script = `
local v = redis.call('GET', KEYS[1])
if v then
  redis.call('DEL', KEYS[1])
  return v
end
return false
`
  await r.set('hold', 'seq:42', 'EX', 60)
  assert.equal(await r.eval(script, 1, 'hold'), 'seq:42')
  // Lua `return false` reaches ioredis as a Redis nil → null.
  assert.equal(await r.eval(script, 1, 'hold'), null)
})

test('scanStream yields key batches matching pattern', async () => {
  const r = new LocalRedisClient()
  await r.set('cumora:worklog:1', 'a')
  await r.set('cumora:worklog:2', 'b')
  await r.set('other', 'c')
  const batches: string[][] = []
  for await (const keys of r.scanStream({ match: 'cumora:worklog:*', count: 1 })) batches.push(keys)
  const flat = batches.flat().sort()
  assert.deepEqual(flat, ['cumora:worklog:1', 'cumora:worklog:2'])
})

test('duplicate() shares the store', async () => {
  const r = new LocalRedisClient()
  const dup = r.duplicate()
  await r.set('shared', '1')
  assert.equal(await dup.get('shared'), '1')
})

test('TTL expiry evicts keys', async () => {
  const r = new LocalRedisClient()
  await r.set('ttl-key', 'v', 'EX', 1)
  assert.equal(await r.exists('ttl-key'), 1)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(await r.exists('ttl-key'), 0)
})
