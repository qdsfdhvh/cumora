import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const readRepo = (path: string): Promise<string> => readFile(resolve(repoRoot, path), 'utf8')

test('application startup verifies schema compatibility and imports no migrator', async () => {
  const source = await readRepo('server/src/index.ts')
  assert.match(source, /verifySchemaWithBootRetry/)
  assert.doesNotMatch(source, /from ['"]\.\/db\/migrate\.js['"]/)
  assert.doesNotMatch(source, /ensureSchema/)
})

test('production deploy delegates one guarded transaction to the recovery runner', async () => {
  const workflow = await readRepo('.github/workflows/deploy.yml')
  assert.match(workflow, /scripts\/deploy-release\.mjs run/)
  assert.match(workflow, /CANDIDATE_SERVER_IMAGE/)
  assert.match(workflow, /MIGRATION_REPAIR/)
  assert.match(workflow, /RECOVERY_WORKDIR/)
  assert.match(workflow, /concurrency:/)
  assert.doesNotMatch(workflow, /kubectl rollout undo/)
})
