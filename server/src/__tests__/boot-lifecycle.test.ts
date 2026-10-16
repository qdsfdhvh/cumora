import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('boot backfill does not run before listen, and shutdown closes sockets', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
  const main = source.slice(source.indexOf('async function main()'))
  const listen = main.indexOf('server.listen(')
  assert.ok(listen > 0)
  assert.ok(main.indexOf('await seedIfEmpty()') === -1)
  assert.ok(main.indexOf('runBootBackfill()') > listen)
  assert.match(main, /socket\.close\(1001/)
  assert.match(main, /server\.close\(/)
  assert.match(main, /stopEmailGcWorker\(\)/)
})
