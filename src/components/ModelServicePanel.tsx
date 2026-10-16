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

type Preset = 'openai' | 'deepseek' | 'custom'

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
}

function detectPreset(baseUrl: string): Preset {
  if (!baseUrl) return 'openai'
  if (baseUrl === PRESETS.deepseek.baseUrl) return 'deepseek'
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
    setPreset(detectPreset(llm.baseUrl))
  }, [llm])

  function applyPreset(next: Preset) {
    setPreset(next)
    setMsg(null)
    setTestMsg(null)
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
      const next = await bridge.setLlmConfig({ baseUrl, model, modelSupport: support, apiKey })
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

  const field = 'h-9 px-2 rounded-[8px] border border-ink-100 bg-paper text-ink-900 placeholder:text-ink-300 text-[12.5px] focus:outline-none focus:border-sky2-300'

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] font-display text-ink-700">{t('me.llmLabel')}</div>
      <div className="text-[11.5px] text-ink-400 leading-snug">{t('me.llmHint')}</div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(['openai', 'deepseek', 'custom'] as Preset[]).map((p) => {
          const active = preset === p
          const label = p === 'openai' ? t('me.llmPresetOpenai') : p === 'deepseek' ? 'DeepSeek' : t('me.llmPresetCustom')
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
      {msg && <div className="text-[11.5px] text-ink-500">{msg}</div>}
      {testMsg && <div className="text-[11.5px] text-ink-500 break-words">{testMsg}</div>}
    </div>
  )
}
