/**
 * The image endpoint resolution rules. Pure, because the interesting part is
 * the decision — "can this deployment draw at all?" — and it has to be right
 * before any call is made: the avatar button is disabled from it.
 *
 * Run: node --import tsx --test server/src/__tests__/image-service.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveImageEndpoint } from '../image-service.js'

const MODEL = 'gpt-image-2'

test('defaults to OpenAI when neither endpoint is customised', () => {
  const ep = resolveImageEndpoint({ imageBaseUrl: '', textBaseUrl: '', model: MODEL })
  assert.equal(ep.available, true)
  assert.equal(ep.baseUrl, 'https://api.openai.com/v1')
  assert.equal(ep.model, MODEL)
  assert.equal(ep.reason, null)
})

test('a custom text endpoint with no image endpoint leaves images unavailable', () => {
  // The case that motivated this: DeepSeek for text cannot draw, so the app
  // must say so up front instead of failing after the click.
  const ep = resolveImageEndpoint({ imageBaseUrl: '', textBaseUrl: 'https://api.deepseek.com/v1', model: MODEL })
  assert.equal(ep.available, false)
  assert.equal(ep.baseUrl, '')
  assert.match(String(ep.reason), /api\.deepseek\.com/)
})

test('an image endpoint wins over the text endpoint', () => {
  const ep = resolveImageEndpoint({
    imageBaseUrl: 'https://api.openai.com/v1',
    textBaseUrl: 'https://api.deepseek.com/v1',
    model: 'gpt-image-1',
  })
  assert.deepEqual(ep, { available: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', reason: null })
})

test('a self-hosted image endpoint is usable with local text', () => {
  const ep = resolveImageEndpoint({ imageBaseUrl: 'http://127.0.0.1:8080/v1', textBaseUrl: 'http://127.0.0.1:8080/v1', model: 'sdxl' })
  assert.equal(ep.available, true)
  assert.equal(ep.model, 'sdxl')
})
