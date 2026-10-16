/**
 * A custom OpenAI-compatible endpoint — DeepSeek, Moonshot, Together, a
 * self-hosted llama.cpp / Ollama / vLLM server, and so on.
 *
 * Why a bridge at all: our call sites are written against OpenAI's Responses
 * API (`client.responses.create`), while the OpenAI-compatible ecosystem
 * overwhelmingly implements *Chat Completions*. That translation already
 * exists for the Novita route, so this provider reuses it rather than
 * maintaining a second, drifting copy — the only provider-specific inputs are
 * the client (base URL + key) and the model name.
 *
 * Model names are passed through unchanged: the operator names the models they
 * actually want via `OPENAI_MODEL` / `OPENAI_MODEL_SUPPORT` /
 * `OPENAI_COMPACTION_MODEL`. Nothing is guessed, because renaming a model
 * silently is worse than a clear 404 from the provider.
 *
 * Two things a Chat-Completions endpoint must support to be usable here:
 * function/tool calling (agent turns, classifiers) and `stream` responses.
 * Image generation is not part of this API; avatars have to be uploaded, and
 * `server/src/agents/cli.ts` says so instead of failing obscurely.
 */
import OpenAI from 'openai'
import { env } from './env.js'
import { type ChatBridge, makeResponsesShim } from './novita.js'

let _client: OpenAI | null = null

/** Exposed for tests: point the bridge at a fake endpoint. */
export function __setCompatibleClientForTesting(client: OpenAI | null): void {
  _client = client
}

function compatibleClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY,
      baseURL: env.LLM_BASE_URL,
    })
  }
  return _client
}

const bridge: ChatBridge = { client: compatibleClient, mapModel: (model) => model }

/** Responses-API-shaped surface over {@link LLM_BASE_URL}. */
export const compatibleResponsesShim = makeResponsesShim(bridge)

/** Human-readable name of the endpoint in use, for logs and the probe. */
export function llmEndpointLabel(): string {
  return env.LLM_BASE_URL || 'https://api.openai.com/v1'
}
