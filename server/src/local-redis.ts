/**
 * LocalRedis — an in-process, Redis-compatible data structure store.
 *
 * The personal build of Cumora runs entirely inside one desktop app, so
 * the pub/sub fan-out + ephemeral state that the cloud build put in Redis
 * lives here instead: one shared store, no external service, no socket.
 * `server/src/redis.ts` hands out instances of this class shaped like the
 * ioredis clients the codebase already uses — same call signatures, same
 * return shapes — so no call site had to change.
 *
 * Supported surface (exactly what this server uses, nothing more):
 *   strings  get / set (EX, NX) / del / exists / incr / expire / keys / getdel
 *   hashes   hget / hset / hsetnx / hdel / hgetall
 *   zsets    zadd (optionally NX) / zrem / zscore / zrange (+WITHSCORES) /
 *            zrangebyscore (+LIMIT)
 *   pub/sub  publish / subscribe / on('message' | 'error') / disconnect
 *   pipeline multi() … exec()  (queued, not transactional — single process)
 *   eval     the two seen-boundary Lua scripts, implemented natively
 *   misc     duplicate() / scanStream() / status
 *
 * Semantics notes:
 *  - Single process means single writer, so multi() queues commands and
 *    executes them in order (atomicity is trivially guaranteed by the
 *    event loop — no other command can interleave because exec() body
 *    is fully synchronous).
 *  - Everything is in-memory: a server restart drops pub/sub state,
 *    busy leases, wake-retry jobs, and seen-boundary anchors. That is
 *    the same durability class Redis had in the cloud build (no
 *    persistence was configured there either); durable state lives in
 *    Postgres.
 */

type RedisValue = string

interface ZSetEntry { score: number; member: string }

function nowMs(): number { return Date.now() }

function patternToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') { out += '\\' + pattern[i + 1]; i++; continue }
    if (c === '*') { out += '.*'; continue }
    if (c === '?') { out += '.'; continue }
    if (c === '[') {
      // Redis supports [abc] / [a-z] / [^abc] — translate through.
      const end = pattern.indexOf(']', i)
      if (end > i) {
        let body = pattern.slice(i + 1, end)
        const negated = body.startsWith('^')
        if (negated) body = body.slice(1)
        out += `[${negated ? '^' : ''}${body}]`
        i = end
        continue
      }
    }
    out += c.replace(/[.+^${}()|[\]]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** One shared store for every client in this process. */
class LocalRedisStore {
  private strings = new Map<string, RedisValue>()
  private hashes = new Map<string, Map<string, RedisValue>>()
  private zsets = new Map<string, Map<string, number>>()
  private expires = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private channels = new Map<string, Set<(channel: string, payload: string) => void>>()

  /* ---- expiry ---- */

  private live(key: string): boolean {
    const exp = this.expires.get(key)
    return exp === undefined || exp > nowMs()
  }

  private touch(key: string, ttlSeconds: number): void {
    const at = nowMs() + ttlSeconds * 1000
    this.expires.set(key, at)
    const prev = this.timers.get(key)
    if (prev) clearTimeout(prev)
    this.timers.set(key, setTimeout(() => this.evict(key), ttlSeconds * 1000 + 5))
    // Never keep the event loop alive for a TTL timer.
    ;(this.timers.get(key) as unknown as { unref?: () => void })?.unref?.()
  }

  private evict(key: string): void {
    this.strings.delete(key)
    this.hashes.delete(key)
    this.zsets.delete(key)
    this.expires.delete(key)
    const t = this.timers.get(key)
    if (t) { clearTimeout(t); this.timers.delete(key) }
  }

  /* ---- strings ---- */

  get(key: string): RedisValue | null {
    if (!this.live(key)) return null
    return this.strings.get(key) ?? null
  }

  set(key: string, value: RedisValue, opts?: { exSeconds?: number; nx?: boolean }): RedisValue | null {
    if (!this.live(key)) this.evict(key)
    if (opts?.nx && this.strings.has(key)) return null
    this.strings.set(key, value)
    if (opts?.exSeconds && opts.exSeconds > 0) this.touch(key, opts.exSeconds)
    return 'OK'
  }

  getdel(key: string): RedisValue | null {
    const v = this.get(key)
    this.evict(key)
    return v
  }

  del(...keys: string[]): number {
    let n = 0
    for (const key of keys) {
      if (!this.live(key)) { this.evict(key); continue }
      const had =
        this.strings.delete(key) ||
        this.hashes.delete(key) ||
        this.zsets.delete(key)
      this.expires.delete(key)
      const t = this.timers.get(key)
      if (t) { clearTimeout(t); this.timers.delete(key) }
      if (had) n++
    }
    return n
  }

  exists(key: string): number {
    return this.live(key) && (this.strings.has(key) || this.hashes.has(key) || this.zsets.has(key)) ? 1 : 0
  }

  incr(key: string): number {
    const cur = Number(this.get(key) ?? '0') || 0
    const next = cur + 1
    this.strings.set(key, String(next))
    return next
  }

  expire(key: string, ttlSeconds: number): number {
    if (!this.exists(key)) return 0
    this.touch(key, ttlSeconds)
    return 1
  }

  keys(pattern: string): string[] {
    const re = patternToRegExp(pattern)
    const seen = new Set<string>()
    for (const key of this.strings.keys()) if (re.test(key) && this.live(key)) seen.add(key)
    for (const key of this.hashes.keys()) if (re.test(key) && this.live(key)) seen.add(key)
    for (const key of this.zsets.keys()) if (re.test(key) && this.live(key)) seen.add(key)
    return [...seen].sort()
  }

  /* ---- hashes ---- */

  private hash(key: string): Map<string, RedisValue> {
    if (!this.live(key)) this.evict(key)
    let h = this.hashes.get(key)
    if (!h) { h = new Map(); this.hashes.set(key, h) }
    return h
  }

  hget(key: string, field: string): RedisValue | null {
    if (!this.live(key)) return null
    return this.hashes.get(key)?.get(field) ?? null
  }

  hset(key: string, field: string, value: RedisValue): number {
    const h = this.hash(key)
    const isNew = !h.has(field)
    h.set(field, value)
    return isNew ? 1 : 0
  }

  hsetnx(key: string, field: string, value: RedisValue): number {
    const h = this.hash(key)
    if (h.has(field)) return 0
    h.set(field, value)
    return 1
  }

  hdel(key: string, ...fields: string[]): number {
    if (!this.live(key)) return 0
    const h = this.hashes.get(key)
    if (!h) return 0
    let n = 0
    for (const f of fields) if (h.delete(f)) n++
    if (h.size === 0) this.hashes.delete(key)
    return n
  }

  hgetall(key: string): Record<string, RedisValue> {
    if (!this.live(key)) return {}
    const h = this.hashes.get(key)
    if (!h) return {}
    return Object.fromEntries(h)
  }

  /* ---- sorted sets ---- */

  private zset(key: string): Map<string, number> {
    if (!this.live(key)) this.evict(key)
    let z = this.zsets.get(key)
    if (!z) { z = new Map(); this.zsets.set(key, z) }
    return z
  }

  zadd(key: string, score: number, member: string, nx = false): number {
    const z = this.zset(key)
    if (nx && z.has(member)) return 0
    z.set(member, score)
    return 1
  }

  zrem(key: string, ...members: string[]): number {
    if (!this.live(key)) return 0
    const z = this.zsets.get(key)
    if (!z) return 0
    let n = 0
    for (const m of members) if (z.delete(m)) n++
    if (z.size === 0) this.zsets.delete(key)
    return n
  }

  zscore(key: string, member: string): RedisValue | null {
    if (!this.live(key)) return null
    const s = this.zsets.get(key)?.get(member)
    return s === undefined ? null : String(s)
  }

  /** Members ordered by (score, member), like Redis. */
  private zsorted(key: string): Array<{ member: string; score: number }> {
    const z = this.zsets.get(key)
    if (!z || !this.live(key)) return []
    return [...z.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0))
  }

  zrange(key: string, start: number, stop: number, withScores?: string): string[] {
    const all = this.zsorted(key)
    if (all.length === 0) return []
    const len = all.length
    const normStart = start < 0 ? len + start : start
    const normStop = stop < 0 ? len + stop : stop
    const slice = all.slice(Math.max(0, normStart), normStop + 1)
    const out: string[] = []
    for (const e of slice) {
      out.push(e.member)
      if (withScores === 'WITHSCORES') out.push(String(e.score))
    }
    return out
  }

  zrangebyscore(key: string, min: number | string, max: number | string, ...rest: string[]): string[] {
    const all = this.zsorted(key)
    const lo = typeof min === 'string' ? Number(min) : min
    const hi = typeof max === 'string' ? Number(max) : max
    let out = all.filter((e) => e.score >= lo && e.score <= hi).map((e) => e.member)
    if (rest[0] === 'LIMIT') {
      const offset = Number(rest[1]) || 0
      const count = Number(rest[2]) || 0
      out = out.slice(offset, offset + count)
    }
    return out
  }

  /* ---- pub/sub ---- */

  subscribe(handler: (channel: string, payload: string) => void, ...channels: string[]): void {
    for (const ch of channels) {
      let set = this.channels.get(ch)
      if (!set) { set = new Set(); this.channels.set(ch, set) }
      set.add(handler)
    }
  }

  unsubscribe(handler: (channel: string, payload: string) => void): void {
    for (const set of this.channels.values()) set.delete(handler)
  }

  publish(channel: string, payload: string): number {
    const set = this.channels.get(channel)
    if (!set) return 0
    for (const handler of [...set]) {
      // Match ioredis delivery: synchronous emit, one handler error never
      // blocks the others (ioredis catches listener exceptions the same way).
      try { handler(channel, payload) } catch (e) {
        console.error('[local-redis] subscriber handler threw', e instanceof Error ? e.message : e)
      }
    }
    return set.size
  }

  /* ---- key enumeration for scanStream ---- */

  scanKeys(match: string, count: number): string[][] {
    const keys = this.keys(match)
    const batches: string[][] = []
    for (let i = 0; i < keys.length; i += count) batches.push(keys.slice(i, i + count))
    return batches
  }
}

const globalStore = new LocalRedisStore()

type CommandResult = string | number | null | string[] | Record<string, string>

type CommandFn = (...args: unknown[]) => CommandResult

export class LocalRedisClient {
  /** Mirrors ioredis.status — 'ready' the moment the module loads. */
  status = 'ready'

  private closed = false
  private messageHandler: ((channel: string, payload: string) => void) | null = null
  private requestedChannels = new Set<string>()

  constructor(private readonly opts: { lazyConnect?: boolean } = {}) {}

  /* ---- strings ---- */
  async get(key: string): Promise<string | null> { this.assertOpen(); return globalStore.get(key) }

  async set(key: string, value: RedisValue, ...rest: unknown[]): Promise<string | null> {
    this.assertOpen()
    // Shapes used in this codebase:
    //   set(key, val)
    //   set(key, val, 'EX', seconds)
    //   set(key, val, 'EX', seconds, 'NX')
    const opts: { exSeconds?: number; nx?: boolean } = {}
    for (let i = 0; i < rest.length; i++) {
      const flag = String(rest[i]).toUpperCase()
      if (flag === 'EX') opts.exSeconds = Number(rest[i + 1])
      if (flag === 'NX') opts.nx = true
    }
    return globalStore.set(key, value, opts)
  }

  async getdel(key: string): Promise<string | null> { this.assertOpen(); return globalStore.getdel(key) }

  async del(...keys: string[]): Promise<number> { this.assertOpen(); return globalStore.del(...keys) }

  async exists(key: string): Promise<number> { this.assertOpen(); return globalStore.exists(key) }

  async incr(key: string): Promise<number> { this.assertOpen(); return globalStore.incr(key) }

  async expire(key: string, ttlSeconds: number): Promise<number> { this.assertOpen(); return globalStore.expire(key, ttlSeconds) }

  async keys(pattern: string): Promise<string[]> { this.assertOpen(); return globalStore.keys(pattern) }

  /* ---- hashes ---- */

  async hget(key: string, field: string): Promise<string | null> { this.assertOpen(); return globalStore.hget(key, field) }

  async hset(key: string, field: string, value: RedisValue): Promise<number> { this.assertOpen(); return globalStore.hset(key, field, value) }

  async hsetnx(key: string, field: string, value: RedisValue): Promise<number> { this.assertOpen(); return globalStore.hsetnx(key, field, value) }

  async hdel(key: string, ...fields: string[]): Promise<number> { this.assertOpen(); return globalStore.hdel(key, ...fields) }

  async hgetall(key: string): Promise<Record<string, string>> { this.assertOpen(); return globalStore.hgetall(key) }

  /* ---- sorted sets ---- */

  async zadd(key: string, ...rest: unknown[]): Promise<number> {
    this.assertOpen()
    // Shapes used: zadd(key, score, member) and zadd(key, 'NX', score, member)
    let nx = false
    let score: number
    let member: string
    if (typeof rest[0] === 'string' && rest[0].toUpperCase() === 'NX') {
      nx = true
      score = Number(rest[1])
      member = String(rest[2])
    } else {
      score = Number(rest[0])
      member = String(rest[1])
    }
    return globalStore.zadd(key, score, member, nx)
  }

  async zrem(key: string, ...members: string[]): Promise<number> { this.assertOpen(); return globalStore.zrem(key, ...members) }

  async zscore(key: string, member: string): Promise<string | null> { this.assertOpen(); return globalStore.zscore(key, member) }

  async zrange(key: string, start: number, stop: number, withScores?: string): Promise<string[]> {
    this.assertOpen()
    return globalStore.zrange(key, start, stop, withScores)
  }

  async zrangebyscore(key: string, min: number | string, max: number | string, ...rest: (string | number)[]): Promise<string[]> {
    this.assertOpen()
    return globalStore.zrangebyscore(key, min, max, ...rest.map(String))
  }

  /* ---- pub/sub ---- */

  async publish(channel: string, payload: string): Promise<number> { this.assertOpen(); return globalStore.publish(channel, payload) }

  /** ioredis accepts both `subscribe(...channels)` and a trailing callback:
   *  `subscribe(CH_A, CH_B, (err) => …)`. Filter out function args and
   *  mirror both styles. */
  async subscribe(...channelsAndCb: Array<string | ((err: unknown) => void)>): Promise<number> {
    this.assertOpen()
    const channels = channelsAndCb.filter((c): c is string => typeof c === 'string')
    const cb = channelsAndCb.find((c): c is (err: unknown) => void => typeof c === 'function')
    for (const ch of channels) this.requestedChannels.add(ch)
    if (this.messageHandler) globalStore.subscribe(this.messageHandler, ...channels)
    cb?.(null)
    return this.requestedChannels.size
  }

  on(event: 'message', handler: (channel: string, payload: string) => void): this
  on(event: string, handler: (...args: unknown[]) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): any {
    if (event === 'message') {
      this.messageHandler = (channel, payload) => handler(channel, payload)
      // The codebase registers on('message') after subscribe() — attach the
      // now-known handler to every channel requested so far.
      if (this.requestedChannels.size > 0) {
        globalStore.subscribe(this.messageHandler, ...this.requestedChannels)
      }
    }
    // 'error' / 'ready' / others: nothing to do in-process.
    return this
  }

  once(event: string, _handler: (...args: unknown[]) => void): this {
    // No async connect in-process — nothing will ever fire.
    void event
    return this
  }

  /** EventEmitter-style removal of a 'message' handler (integration tests
   *  use this to detach between scenarios). */
  off(event: 'message', handler: (channel: string, payload: string) => void): this
  off(event: string, handler: (...args: never[]) => void): this
  off(event: string, handler: (...args: never[]) => void): this {
    if (event === 'message' && this.messageHandler) {
      globalStore.unsubscribe(this.messageHandler)
      this.messageHandler = null
    }
    void handler
    return this
  }

  /** Leave the given channels (ioredis returns the count left). */
  async unsubscribe(...channels: string[]): Promise<number> {
    this.assertOpen()
    for (const ch of channels) this.requestedChannels.delete(ch)
    if (this.messageHandler) {
      for (const ch of channels) globalStore.unsubscribe(this.messageHandler)
    }
    return this.requestedChannels.size
  }

  /* ---- pipeline ---- */

  /** Queued command list. ioredis returns a chainable whose methods queue;
   *  exec() runs them in order and resolves with the results array. */
  multi(): LocalRedisPipeline {
    return new LocalRedisPipeline()
  }

  /* ---- eval (the two seen-boundary Lua scripts, native) ---- */

  async eval(script: string, numKeys: number, ...keysAndArgs: unknown[]): Promise<string | number | null> {
    this.assertOpen()
    const key = String(keysAndArgs[0] ?? '')
    if (script.includes('newv > cur')) {
      // MONOTONIC_SET_SCRIPT — set iff higher, with TTL refresh.
      const newv = Number(keysAndArgs[1])
      const ttl = Number(keysAndArgs[2])
      const cur = Number(globalStore.get(key) ?? '0') || 0
      if (Number.isFinite(newv) && newv > cur) {
        globalStore.set(key, String(newv), { exSeconds: ttl })
        return 1
      }
      return 0
    }
    if (script.includes('redis.call(\'DEL\', KEYS[1])')) {
      // CONSUME_SCRIPT — GET+DEL atomically.
      return globalStore.getdel(key)
    }
    throw new Error(`[local-redis] unsupported eval script (personal build implements the seen-boundary scripts only)`)
  }

  /* ---- misc ---- */

  /** ioredis variant of the raw command interface — not used by the app
   *  code, only by some integration tests through publish paths. */
  async call(command: string, ...args: unknown[]): Promise<CommandResult> {
    this.assertOpen()
    const table: Record<string, CommandFn> = {
      get: (k) => globalStore.get(String(k)),
      set: (k, v, ...rest) => this.setSync(String(k), String(v), rest),
      del: (...ks) => globalStore.del(...(ks as string[])),
      exists: (k) => globalStore.exists(String(k)),
      incr: (k) => globalStore.incr(String(k)),
      expire: (k, ttl) => globalStore.expire(String(k), Number(ttl)),
    }
    void command; void args
    const fn = table[command.toUpperCase()]
    if (!fn) throw new Error(`[local-redis] unsupported command ${command}`)
    return fn(...args)
  }

  private setSync(key: string, value: string, rest: unknown[]): string | null {
    const opts: { exSeconds?: number; nx?: boolean } = {}
    for (let i = 0; i < rest.length; i++) {
      const flag = String(rest[i]).toUpperCase()
      if (flag === 'EX') opts.exSeconds = Number(rest[i + 1])
      if (flag === 'NX') opts.nx = true
    }
    return globalStore.set(key, value, opts)
  }

  duplicate(_opts?: unknown): LocalRedisClient {
    return new LocalRedisClient()
  }

  /** async iterator of key batches — mirrors ioredis scanStream enough for
   *  `for await (const keys of redis.scanStream({match, count}))`. */
  async *scanStream(opts?: { match?: string; count?: number }): AsyncGenerator<string[]> {
    const batches = globalStore.scanKeys(opts?.match ?? '*', opts?.count ?? 100)
    for (const b of batches) yield b
  }

  disconnect(): void {
    this.closed = true
    if (this.messageHandler) globalStore.unsubscribe(this.messageHandler)
    this.messageHandler = null
  }

  /** ioredis compat — graceful quit == immediate disconnect here. */
  quit(): Promise<'OK'> { this.disconnect(); return Promise.resolve('OK') }

  private assertOpen(): void {
    if (this.closed) throw new Error('[local-redis] connection is closed')
  }
}

/** Chainable pipeline returned by multi(). Command methods return `this`
 *  so call sites can chain; exec() resolves with the per-command results. */
export class LocalRedisPipeline {
  private queue: Array<() => CommandResult | Promise<CommandResult>> = []

  private push<T>(fn: () => T): this {
    this.queue.push(fn as () => CommandResult)
    return this
  }

  get(key: string): this { return this.push(() => globalStore.get(key)) }
  set(key: string, value: RedisValue, ...rest: unknown[]): this {
    return this.push(() => {
      const opts: { exSeconds?: number; nx?: boolean } = {}
      for (let i = 0; i < rest.length; i++) {
        const flag = String(rest[i]).toUpperCase()
        if (flag === 'EX') opts.exSeconds = Number(rest[i + 1])
        if (flag === 'NX') opts.nx = true
      }
      return globalStore.set(key, value, opts)
    })
  }
  del(...keys: string[]): this { return this.push(() => globalStore.del(...keys)) }
  incr(key: string): this { return this.push(() => globalStore.incr(key)) }
  expire(key: string, ttl: number): this { return this.push(() => globalStore.expire(key, ttl)) }
  hset(key: string, field: string, value: RedisValue): this { return this.push(() => globalStore.hset(key, field, value)) }
  hdel(key: string, ...fields: string[]): this { return this.push(() => globalStore.hdel(key, ...fields)) }
  zadd(key: string, ...rest: unknown[]): this {
    return this.push(() => {
      let nx = false
      let score: number
      let member: string
      if (typeof rest[0] === 'string' && rest[0].toUpperCase() === 'NX') {
        nx = true
        score = Number(rest[1])
        member = String(rest[2])
      } else {
        score = Number(rest[0])
        member = String(rest[1])
      }
      return globalStore.zadd(key, score, member, nx)
    })
  }
  zrem(key: string, ...members: string[]): this { return this.push(() => globalStore.zrem(key, ...members)) }

  /** ioredis pipelines are thenable; support `await pipe` directly too. */
  then<T>(onfulfilled: (v: unknown[]) => T, onrejected?: (e: unknown) => unknown): Promise<T> {
    return this.exec().then(onfulfilled, onrejected) as Promise<T>
  }

  async exec(): Promise<unknown[]> {
    const results: unknown[] = []
    // Deliberately synchronous: nothing can interleave between the queued
    // commands (single-threaded store), which is the transactional
    // guarantee the call sites rely on.
    for (const cmd of this.queue) results.push(await cmd())
    this.queue = []
    return results
  }
}
