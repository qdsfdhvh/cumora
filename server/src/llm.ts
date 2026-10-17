/**
 * OpenAI client factory — every server-side LLM call goes through here.
 *
 * Personal build: the cloud sub2api per-user LLM gateway is gone. Every
 * call uses the operator's own `env.OPENAI_API_KEY` (optionally rerouted
 * per-model to Novita / OrcaRouter by the provider-prefix wrapper below).
 * The `tenant` argument is kept for call-site compatibility.
 *
 * Per-tenant client cache: OpenAI client construction is cheap but we
 * call this on every LLM hop. Cache by tenant; invalidate explicitly
 * via `invalidateLlmClient(tenant)`.
 *
 * Provider routing (model-based, on top of the above): whichever client is
 * chosen by the tenant rules is wrapped by `withProviderRouting` before it's
 * returned. That wrapper inspects the `model` on each individual
 * `responses.create()` call — not the tenant — and reroutes calls whose
 * model carries a recognized provider prefix:
 *   - `novita/<model>`       → Novita's real Chat Completions API via
 *                              server/src/novita.ts's translation shim, since
 *                              Novita has no Responses API to swap a base URL
 *                              onto.
 *   - `orcarouter/<model>`   → OrcaRouter (https://www.orcarouter.ai) via a
 *                              pure base-URL swap (server/src/orcarouter.ts),
 *                              since OrcaRouter speaks the Responses API
 *                              natively — no translation needed.
 * Everything else about the returned client (chat.completions, images,
 * embeddings, non-prefixed responses.create calls) is the same object
 * callers already know.
 */
import OpenAI from 'openai'
import { env } from './env.js'
import { isNovitaModel, novitaResponsesShim } from './novita.js'
import { isOrcaRouterModel, orcarouterResponsesCreate } from './orcarouter.js'
import { compatibleResponsesShim, llmEndpointLabel } from './compatible.js'

interface CachedClient {
  client: OpenAI
  /** What we built the client from — used for cheap invalidation. */
  key: string
  /** unix-ms when the cache entry was minted; expire after 5 min so a
   *  silent tier change / key rotation doesn't strand the cache forever
   *  even when the explicit invalidate path is missed. */
  mintedAt: number
}

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, CachedClient>()

/** Tolerance settings for both the sub2api-routed client AND the legacy
 *  fallback. Production has surfaced "all four agents 502'd at once →
 *  every run failed → fingerprint locks them out" sequences caused by
 *  brief upstream flakiness on sub2api / the model provider. The OpenAI
 *  SDK retries on 5xx + 408 + 429 + network errors out of the box, but
 *  its default ceiling (2) is too thin for the bursty 502 windows we
 *  see; 5 absorbs short outages without making the wall-clock pathological.
 *  Timeout is 5 min — model responses (especially with reasoning) can
 *  legitimately take a couple minutes; the SDK aborts and retries within
 *  this budget. */
const SDK_MAX_RETRIES = 5
const SDK_TIMEOUT_MS = 5 * 60_000

/** Test-only override. When set, every {@link getLlmClient} call returns
 *  whatever this function produces. Production code never sets this; it
 *  exists so integration tests can inject a fake OpenAI client whose
 *  `responses.create` returns crafted Responses-API event streams instead
 *  of round-tripping through sub2api / OpenAI. */
let testLlmOverride: ((tenant: string | null) => OpenAI | Promise<OpenAI>) | null = null
/** Which endpoint the server-side LLM calls will use, for logs and the probe. */
export { llmEndpointLabel }

export function __setLlmClientOverrideForTesting(fn: typeof testLlmOverride): void {
  testLlmOverride = fn
}

/** Wrap a client so any call whose `model` carries a recognized provider
 *  prefix is routed to that provider instead of this client's own
 *  `responses.create`:
 *    - `novita/<model>`     → Novita (server/src/novita.ts), translated
 *                             through `novitaResponsesShim` so the caller sees
 *                             an ordinary Responses-API stream/return.
 *    - `orcarouter/<model>` → OrcaRouter (server/src/orcarouter.ts), a pure
 *                             base-URL swap — OrcaRouter speaks the Responses
 *                             API natively.
 *
 *  Model, not tenant, decides the provider: `getLlmClient` is resolved
 *  once per tenant/hop before the model for that specific call is even
 *  read off `args.model`, so routing has to happen at `.responses.create()`
 *  call time, not here. Every caller in this codebase reads only
 *  `client.responses.create(...)`, so wrapping just that property is a
 *  complete, minimal interception — everything else (chat.completions,
 *  images, embeddings) passes through to the real client untouched. */
let novitaUnconfiguredWarned = false
let orcarouterUnconfiguredWarned = false
/** One log line per provider, not one per call — this fires on every hop of
 *  every turn of an agent whose model names an unconfigured provider. */
function warnProviderUnconfiguredOnce(provider: 'Novita' | 'OrcaRouter', model: string | undefined): void {
  if (provider === 'Novita') {
    if (novitaUnconfiguredWarned) return
    novitaUnconfiguredWarned = true
    console.warn(`[llm] model "${model}" requests Novita but NOVITA_API_KEY is unset — using the tenant's normal client instead`)
    return
  }
  if (orcarouterUnconfiguredWarned) return
  orcarouterUnconfiguredWarned = true
  console.warn(`[llm] model "${model}" requests OrcaRouter but ORCAROUTER_API_KEY is unset — using the tenant's normal client instead`)
}

function withProviderRouting(client: OpenAI): OpenAI {
  return new Proxy(client, {
    get(target, prop, receiver): unknown {
      if (prop !== 'responses') return Reflect.get(target, prop, receiver)
      const real = target.responses
      return new Proxy(real, {
        get(rt, p, rr): unknown {
          if (p !== 'create') return Reflect.get(rt, p, rr)
          return (args: { model?: string } & Record<string, unknown>, opts?: unknown) => {
            if (isNovitaModel(args.model)) {
              // Route to Novita only when this deployment actually configured
              // a key — otherwise fall through to the tenant's normal client,
              // exactly as env.ts documents. Without this guard an unset key
              // sent the call to api.novita.ai with an empty bearer and the
              // agent died on an unexplained 401 instead of degrading.
              if (env.NOVITA_API_KEY) {
                return novitaResponsesShim.create(args as never, opts as never)
              }
              warnProviderUnconfiguredOnce('Novita', args.model)
            } else if (isOrcaRouterModel(args.model)) {
              // Same degrade-not-die guard for OrcaRouter: an unset key must
              // fall through to the tenant's normal client, not send a bare
              // bearer to api.orcarouter.ai.
              if (env.ORCAROUTER_API_KEY) {
                return orcarouterResponsesCreate(args, opts)
              }
              warnProviderUnconfiguredOnce('OrcaRouter', args.model)
            }
            return (real.create as (a: unknown, o?: unknown) => unknown)(args, opts)
          }
        },
      })
    },
  })
}

/** Build (and cache) the OpenAI client for this tenant. Always returns a
 *  working client — the operator's own key. */
export async function getLlmClient(tenant: string | null): Promise<OpenAI> {
  if (testLlmOverride) return testLlmOverride(tenant)
  const cached = tenant ? cache.get(tenant) : undefined
  if (cached && Date.now() - cached.mintedAt < CACHE_TTL_MS) {
    return withProviderRouting(cached.client)
  }
  const c = legacyClient()
  if (tenant) cache.set(tenant, { client: c, key: 'local', mintedAt: Date.now() })
  return withProviderRouting(c)
}

/** Drop a tenant's cached client. Call from tier-change handlers so the
 *  next LLM hop picks up the swapped key / group. */
export function invalidateLlmClient(tenant: string): void {
  cache.delete(tenant)
}

let _legacy: OpenAI | null = null
function legacyClient(): OpenAI {
  if (_legacy) return _legacy
  const custom = env.LLM_BASE_URL
  const real = new OpenAI({
    apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY,
    ...(custom ? { baseURL: custom } : {}),
    maxRetries: SDK_MAX_RETRIES,
    timeout: SDK_TIMEOUT_MS,
  })
  // A native-Responses endpoint needs no translation at all: hand it our calls
  // as-is (the client already carries its base URL).
  if (!custom || env.LLM_RESPONSES_NATIVE) {
    _legacy = real
    return _legacy
  }
  // A custom OpenAI-compatible endpoint speaks Chat Completions, so only the
  // Responses surface is translated; every other surface (images, chat,
  // embeddings) is left pointing at the same endpoint, where it either works
  // or reports the provider's own error.
  _legacy = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop === 'responses') return compatibleResponsesShim
      return Reflect.get(target, prop, receiver)
    },
  }) as OpenAI
  return _legacy
}
