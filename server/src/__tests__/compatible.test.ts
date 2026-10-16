/**
 * Unit tests for the custom OpenAI-compatible endpoint bridge
 * (server/src/compatible.ts). No network access: the underlying
 * `chat.completions.create` is stubbed, so these assert the translation and
 * the model-name passthrough — the two things that differ from the Novita
 * route it reuses.
 *
 * Run: node --import tsx --test server/src/__tests__/compatible.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type OpenAI from 'openai'
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { __setCompatibleClientForTesting, compatibleResponsesShim, llmEndpointLabel } from '../compatible.js'
import { applyResponseStreamEvent, newResponseStreamState } from '../agents/turn-stream.js'

function fakeClient(create: (...args: unknown[]) => unknown): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI
}

test('non-streaming: sends Chat Completions and translates the answer back to output_text', async () => {
  let capturedBody: Record<string, unknown> = {}
  __setCompatibleClientForTesting(fakeClient(async (args: unknown) => {
    capturedBody = args as Record<string, unknown>
    return {
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'pong', tool_calls: [] } }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }
  }))
  try {
    const r = (await compatibleResponsesShim.create({
      model: 'deepseek-chat',
      instructions: 'be terse',
      input: 'ping',
      tools: [{ type: 'function', name: 'bash', parameters: { type: 'object' }, strict: true, description: 'run a shell command' }],
      max_output_tokens: 64,
    } as never)) as { output_text: string; output: unknown[]; usage: { input_tokens: number; output_tokens: number } }

    // The request is Chat Completions, not Responses.
    assert.equal(capturedBody.model, 'deepseek-chat')
    assert.equal(capturedBody.max_tokens, 64)
    assert.deepEqual(
      (capturedBody.messages as { role: string; content: string }[]).map((m) => [m.role, m.content]),
      [['system', 'be terse'], ['user', 'ping']],
    )
    assert.equal((capturedBody.tools as unknown[]).length, 1)
    assert.equal('tool_choice' in capturedBody, false)

    // The answer comes back in the shape our call sites read.
    assert.equal(r.output_text, 'pong')
    assert.equal(r.usage.input_tokens, 7)
    assert.equal(r.usage.output_tokens, 2)
  } finally {
    __setCompatibleClientForTesting(null)
  }
})

test('model names pass through untouched — no provider prefix is stripped or added', async () => {
  const seen: string[] = []
  __setCompatibleClientForTesting(fakeClient(async (args: unknown) => {
    seen.push((args as { model: string }).model)
    return { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }], usage: null }
  }))
  try {
    for (const model of ['deepseek-chat', 'deepseek-reasoner', 'moonshot-v1-128k', 'qwen2.5-32b-instruct', 'gpt-5.5']) {
      await compatibleResponsesShim.create({ model, input: 'hi' } as never)
    }
    assert.deepEqual(seen, ['deepseek-chat', 'deepseek-reasoner', 'moonshot-v1-128k', 'qwen2.5-32b-instruct', 'gpt-5.5'])
  } finally {
    __setCompatibleClientForTesting(null)
  }
})

test('tool calls translate into Responses-style function_call output', async () => {
  __setCompatibleClientForTesting(fakeClient(async () => ({
    id: 'chatcmpl-tc',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      },
    }],
    usage: null,
  })))
  try {
    const r = (await compatibleResponsesShim.create({
      model: 'deepseek-chat',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] } as unknown as ResponseInputItem],
      tools: [{ type: 'function', name: 'bash', parameters: { type: 'object' }, strict: false }],
    } as never)) as { output: { type: string; name?: string; arguments?: string; call_id?: string }[] }

    const call = r.output.find((o) => o.type === 'function_call')
    assert.ok(call, 'expected a function_call in output')
    assert.equal(call.name, 'bash')
    assert.equal(call.arguments, '{"cmd":"ls"}')
    assert.equal(call.call_id, 'call_1')
  } finally {
    __setCompatibleClientForTesting(null)
  }
})

test('streaming: yields Responses events our turn-stream reads', async () => {
  async function* chunks() {
    yield { id: 'c1', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'po' } }] }
    yield { id: 'c1', model: 'deepseek-chat', choices: [{ index: 0, delta: { content: 'ng' } }] }
    yield { id: 'c1', model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
  }
  __setCompatibleClientForTesting(fakeClient(async () => chunks()))
  try {
    const stream = (await compatibleResponsesShim.create({ model: 'deepseek-chat', input: 'ping', stream: true } as never)) as AsyncIterable<never>
    // Feed the bridge's events through the production reducer, which is what
    // turn.ts does — proof the custom endpoint's stream is understood as-is.
    const state = newResponseStreamState()
    for await (const ev of stream) applyResponseStreamEvent(state, ev)
    assert.equal(Array.from(state.responseTextByPart.values()).join(''), 'pong')
    assert.equal(state.responseStatus, 'completed')
  } finally {
    __setCompatibleClientForTesting(null)
  }
})

test('llmEndpointLabel names the configured endpoint', () => {
  // No CUMORA_LLM_BASE_URL in the test env ⇒ the default.
  assert.match(llmEndpointLabel(), /^https?:\/\//)
})
