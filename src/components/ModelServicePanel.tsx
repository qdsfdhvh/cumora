/**
 * 模型服务 — which endpoint the server's own LLM calls go to.
 *
 * The agent's own reasoning runs on the paired computer's local engine; what
 * this panel moves is the server side: inbox triage, the agenda classifier,
 * conversation summaries, convene speech. Those default to OpenAI, and people
 * reasonably want DeepSeek (cheaper) or a local endpoint (private). Both are
 * the same thing to the server — an OpenAI-compatible base URL — so the panel
 * is a preset plus free-form fields.
 *
 * `测试连接` is the point of the panel: it runs one tiny round-trip and reports
 * the endpoint, the model and the latency, or the provider's own error message.
 * Without it, a wrong model id or a key pasted into the wrong provider looks
 * exactly like "the agent silently does nothing".
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { useT } from '@/lib/i18n'
import { refreshLlmHealth, useLlmHealth } from '@/lib/llmHealth'
import type { LocalServerStatus } from '@/lib/runtime'

type Preset = 'openai' | 'deepseek' | 'magpie' | 'custom'

/** Absolute local time — no relative-time keys needed, and no ambiguity about
 *  which timezone a "3 minutes ago" was computed in. */
function whenLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

const PRESETS: Record<Exclude<Preset, 'custom'>, { baseUrl: string; model: string; support: string }> = {
  // Empty strings mean "leave it alone": the server's built-in defaults.
  openai: { baseUrl: '', model: '', support: '' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', support: 'deepseek-chat' },
  // A local gateway (Magpie and friends) that speaks Responses natively and
  // routes by its own model ids. No key: it is on loopback.
  magpie: { baseUrl: 'http://127.0.0.1:3425/v1', model: 'group/daily-coding', support: 'group/cheap-and-feat' },
}

/** Presets that talk Responses natively rather than Chat Completions. */
const NATIVE_PRESETS: Preset[] = ['magpie']

function detectPreset(baseUrl: string): Preset {
  if (!baseUrl) return 'openai'
  if (baseUrl === PRESETS.deepseek.baseUrl) return 'deepseek'
  if (baseUrl === PRESETS.magpie.baseUrl) return 'magpie'
  return 'custom'
}

export function ModelServicePanel({
  status,
  onStatus,
}: {
  status: LocalServerStatus | null
  onStatus: (next: LocalServerStatus) => void
}) {
  const t = useT()
  const llm = status?.llm
  const health = useLlmHealth()
  const [preset, setPreset] = useState<Preset>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [support, setSupport] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [imageBaseUrl, setImageBaseUrl] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [imageApiKey, setImageApiKey] = useState('')
  const [native, setNative] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<string | null>(null)

  // Fill the fields from the server once, then leave the owner's edits alone.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !llm) return
    seeded.current = true
    setBaseUrl(llm.baseUrl)
    setModel(llm.model)
    setSupport(llm.modelSupport)
    setImageBaseUrl(llm.imageBaseUrl ?? '')
    setImageModel(llm.imageModel ?? '')
    setNative(llm.responsesNative === true)
    setPreset(detectPreset(llm.baseUrl))
  }, [llm])

  function applyPreset(next: Preset) {
    setPreset(next)
    setMsg(null)
    setTestMsg(null)
    setNative(NATIVE_PRESETS.includes(next))
    if (next === 'custom') return
    const p = PRESETS[next]
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setSupport(p.support)
  }

  async function save() {
    const bridge = window.cumora?.localServer
    if (!bridge) return
    setBusy(true)
    setMsg(null)
    try {
      const next = await bridge.setLlmConfig({
        baseUrl,
        model,
        modelSupport: support,
        apiKey,
        imageBaseUrl,
        imageModel,
        imageApiKey,
        responsesNative: native,
      })
      if ('error' in next) {
        setMsg(t('me.llmSaveFailed', { error: next.error }))
        return
      }
      onStatus(next)
      setApiKey('')
      setMsg(t('me.llmSaved'))
    } catch (e) {
      setMsg(t('me.llmSaveFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setTesting(true)
    setTestMsg(null)
    try {
      const r = await api.probeLocalLlm(support.trim() || model.trim() || undefined)
      setTestMsg(
        r.ok
          ? t('me.llmTestOk', { model: r.model, ms: String(r.ms), text: r.text || '—' })
          : t('me.llmTestFail', { error: r.error ?? 'unknown error' }),
      )
    } catch (e) {
      setTestMsg(t('me.llmTestFail', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setTesting(false)
      // The probe is a recorded call, so the health line can answer "fixed?".
      void refreshLlmHealth()
    }
  }

  // 测试连接 runs against the SAVED config (that is the config the server is
  // running). Testing an unsaved edit and reading its answer as "the server is
  // broken" is exactly the confusion this hint exists to prevent.
  const dirty = baseUrl !== (llm?.baseUrl ?? '')
    || model !== (llm?.model ?? '')
    || support !== (llm?.modelSupport ?? '')
    || apiKey.trim().length > 0
    || imageBaseUrl !== (llm?.imageBaseUrl ?? '')
    || imageModel !== (llm?.imageModel ?? '')
    || imageApiKey.trim().length > 0
    || native !== (llm?.responsesNative === true)

  const field = 'h-9 px-2 rounded-[8px] border border-ink-100 bg-paper text-ink-900 placeholder:text-ink-300 text-[12.5px] focus:outline-none focus:border-sky2-300'

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] font-display text-ink-700">{t('me.llmLabel')}</div>
      <div className="text-[11.5px] text-ink-400 leading-snug">{t('me.llmHint')}</div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(['openai', 'deepseek', 'magpie', 'custom'] as Preset[]).map((p) => {
          const active = preset === p
          const label = p === 'openai'
            ? t('me.llmPresetOpenai')
            : p === 'deepseek' ? 'DeepSeek' : p === 'magpie' ? t('me.llmPresetMagpie') : t('me.llmPresetCustom')
          return (
            <button
              key={p}
              type="button"
              onClick={() => applyPreset(p)}
              className={`rounded-[8px] px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                active ? 'bg-skype text-white' : 'border border-ink-200 text-ink-600 hover:bg-cloud'
              }`}
            >
              {label}
            </button>
          )
        })}
        {preset === 'custom' && (
          <span className="text-[11px] text-ink-400">{t('me.llmCustomHint')}</span>
        )}
      </div>

      {preset === 'openai' ? (
        <div className="text-[11.5px] text-ink-400">{t('me.llmOpenaiDefault')}</div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-500">{t('me.llmBaseUrl')}</span>
            <input
              value={baseUrl}
              onChange={(e) => { setBaseUrl(e.target.value); setPreset(detectPreset(e.target.value)) }}
              placeholder={PRESETS.deepseek.baseUrl}
              spellCheck={false}
              autoComplete="off"
              className={`${field} w-full`}
            />
          </label>
          <div className="flex items-stretch gap-2">
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-[11.5px] text-ink-500">{t('me.llmModel')}</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" spellCheck={false} className={field} />
            </label>
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-[11.5px] text-ink-500">{t('me.llmModelSupport')}</span>
              <input value={support} onChange={(e) => setSupport(e.target.value)} placeholder={model || 'deepseek-chat'} spellCheck={false} className={field} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-500">
              {t('me.llmKeyLabel')} {llm?.hasKey && <span className="text-ink-300">{t('me.llmKeySet')}</span>}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('me.llmKeyPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className={field}
            />
          </label>
        </div>
      )}

      {preset !== 'openai' && (
        <label className="flex items-start gap-2 text-[11.5px] text-ink-600">
          <input type="checkbox" checked={native} onChange={(e) => setNative(e.target.checked)} className="mt-0.5" />
          <span>
            {t('me.llmNativeLabel')}
            <span className="block text-[11px] text-ink-400 leading-snug">{t('me.llmNativeHint')}</span>
          </span>
        </label>
      )}

      {/* Images can live on their own endpoint: a DeepSeek key cannot draw, and
          "cheap text + real images" is a normal combination. */}
      <div className="flex flex-col gap-1.5 border-t border-ink-100 pt-2">
        <div className="text-[11.5px] font-display text-ink-600">{t('me.llmImageLabel')}</div>
        <div className="text-[11px] text-ink-400 leading-snug">{t('me.llmImageHint')}</div>
        <div className="flex items-stretch gap-2">
          <label className="flex flex-col gap-1 flex-[2]">
            <span className="text-[11px] text-ink-500">{t('me.llmImageBaseUrl')}</span>
            <input
              value={imageBaseUrl}
              onChange={(e) => setImageBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              autoComplete="off"
              className={`${field} w-full`}
            />
          </label>
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-[11px] text-ink-500">{t('me.llmImageModel')}</span>
            <input value={imageModel} onChange={(e) => setImageModel(e.target.value)} placeholder="gpt-image-1" spellCheck={false} className={`${field} w-full`} />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-ink-500">
            {t('me.llmImageKey')}
            {llm?.imageApiKeyStored && <span className="text-ink-300"> {t('me.llmKeySet')}</span>}
          </span>
          <input
            type="password"
            value={imageApiKey}
            onChange={(e) => setImageApiKey(e.target.value)}
            placeholder="sk-…"
            spellCheck={false}
            autoComplete="off"
            className={`${field} w-full`}
          />
        </label>
        {health?.images && (
          <div className={health.images.available ? 'text-[11px] text-ink-400' : 'text-[11px] text-gold-deep'}>
            {health.images.available
              ? t('me.llmImageAvailable', { endpoint: health.images.endpoint ?? 'api.openai.com', model: health.images.model })
              : t('me.llmImageUnavailable', { endpoint: baseUrl || 'api.openai.com' })}
          </div>
        )}
      </div>

      {health && (
        <div
          className={health.failing
            ? 'rounded-[8px] bg-coral-soft px-2.5 py-1.5 text-[11.5px] leading-snug text-coral-deep break-words'
            : 'text-[11.5px] leading-snug text-ink-400 break-words'}
        >
          {health.failing && health.latest
            ? t('me.llmHealthFailing', {
                status: health.latest.status,
                model: health.latest.model,
                error: health.latest.error ?? '',
                when: whenLabel(health.latest.createdAt),
              })
            : health.latestOk
              ? t('me.llmHealthOk', { when: whenLabel(health.latestOk.createdAt), purpose: health.latestOk.purpose })
              : t('me.llmHealthNone')}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || testing}
          onClick={() => void save()}
          className="h-9 px-3 rounded-[8px] bg-skype hover:bg-skype-deep text-white text-[12.5px] disabled:opacity-40"
        >
          {busy ? t('me.llmSaving') : t('me.llmSave')}
        </button>
        <button
          type="button"
          disabled={busy || testing}
          onClick={() => void test()}
          className="h-9 px-3 rounded-[8px] bg-paper text-ink-700 hover:bg-ink-100 text-[12.5px] disabled:opacity-40"
        >
          {testing ? t('me.llmTesting') : t('me.llmTest')}
        </button>
      </div>
      {dirty && <div className="text-[11px] leading-snug text-gold-deep">{t('me.llmDirtyHint')}</div>}
      {msg && <div className="text-[11.5px] text-ink-500">{msg}</div>}
      {testMsg && <div className="text-[11.5px] text-ink-500 break-words">{testMsg}</div>}
    </div>
  )
}
