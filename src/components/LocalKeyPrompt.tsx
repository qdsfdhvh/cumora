/**
 * The local OpenAI key prompt.
 *
 * The packaged app runs its own server, so the key is collected here once and
 * stored in the app's data directory (`server.env`) rather than shipped with the
 * build. Two surfaces use it: the sign-in screen (a fresh install, before the
 * account exists) and the onboarding wizard's first step — the same card, so
 * whichever the owner meets first, the ask happens exactly once and the other
 * surface then reports it as configured.
 *
 * Presentational: the caller owns the server status (it needs it for its own
 * gating) and just gets told when a save landed.
 */
import { useState } from 'react'
import { useT } from '@/lib/i18n'
import type { LocalServerStatus } from '@/lib/runtime'

export function LocalKeyPrompt({
  status,
  onSaved,
}: {
  status: LocalServerStatus | null
  onSaved?: (next: LocalServerStatus) => void
}) {
  const t = useT()
  const [keyInput, setKeyInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const hasKey = status?.hasApiKey === true

  async function save() {
    const bridge = window.cumora?.localServer
    if (!bridge || !keyInput.trim()) return
    setSaving(true)
    setErr(null)
    try {
      const next = await bridge.setOpenAIKey(keyInput.trim())
      onSaved?.(next)
      setKeyInput('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (hasKey) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-ink-500">
        <span aria-hidden>✅</span>
        <span>{t('auth.keyConfigured')}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11.5px] text-ink-500 leading-relaxed">{t('auth.openaiHint')}</div>
      <div className="flex items-stretch gap-2">
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={t('auth.openaiPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 h-10 px-3 rounded-[8px] border border-ink-100 bg-paper text-ink-900 placeholder:text-ink-300 text-[13px] focus:outline-none focus:border-sky2-300"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !keyInput.trim()}
          className="h-10 px-3 rounded-[8px] bg-skype hover:bg-skype-deep text-white text-[12.5px] disabled:opacity-40"
        >
          {saving ? t('auth.preparing') : t('auth.saveKey')}
        </button>
      </div>
      {err && <div className="text-[11.5px] text-coral-deep break-words">{err}</div>}
    </div>
  )
}
