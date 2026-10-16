/**
 * Where images come from.
 *
 * Deliberately separate from the text provider. A DeepSeek key cannot draw, and
 * "cheap text, real images" is a normal thing to want — so the image endpoint
 * has its own base URL, key and model.
 *
 * Resolution, in order:
 *   1. `CUMORA_IMAGE_BASE_URL` is set      → that endpoint.
 *   2. otherwise, the text endpoint is OpenAI (the default) → OpenAI.
 *   3. otherwise (text is a custom endpoint and no image endpoint is set)
 *      → unavailable. The app disables 生成 with a reason instead of sending a
 *      text request to an image API and reporting whatever comes back.
 */
import OpenAI from 'openai'
import { env } from './env.js'

export interface ImageEndpoint {
  available: boolean
  /** Empty when unavailable. */
  baseUrl: string
  model: string
  /** Human-readable reason when unavailable (surfaced in the UI). */
  reason: string | null
}

/** Pure so the resolution rules can be tested without touching the env. */
export function resolveImageEndpoint(input: {
  imageBaseUrl: string
  textBaseUrl: string
  model: string
}): ImageEndpoint {
  const model = input.model
  if (input.imageBaseUrl) {
    return { available: true, baseUrl: input.imageBaseUrl, model, reason: null }
  }
  if (!input.textBaseUrl) {
    return { available: true, baseUrl: 'https://api.openai.com/v1', model, reason: null }
  }
  return {
    available: false,
    baseUrl: '',
    model,
    reason: `the configured text endpoint (${input.textBaseUrl}) does not generate images`,
  }
}

export function imageEndpoint(): ImageEndpoint {
  return resolveImageEndpoint({
    imageBaseUrl: env.IMAGE_BASE_URL,
    textBaseUrl: env.LLM_BASE_URL,
    model: env.OPENAI_IMAGE_MODEL,
  })
}

/**
 * A client for the image endpoint. Falls back to the text client's credentials
 * when no image-specific key is set, so an OpenAI setup needs no extra fields.
 */
export function imageClient(): OpenAI {
  return new OpenAI({
    // An image-specific key wins; otherwise the text key is reused, so an
    // OpenAI setup needs no extra fields to keep working.
    apiKey: env.IMAGE_API_KEY || env.LLM_API_KEY || env.OPENAI_API_KEY,
    ...(env.IMAGE_BASE_URL ? { baseURL: env.IMAGE_BASE_URL } : {}),
  })
}
