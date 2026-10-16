/**
 * Sign-in screen — personal local build.
 *
 * There is no cloud account to sign into and no OAuth provider to visit.
 * The desktop app runs its own server + database on this Mac, so this
 * screen does two things:
 *
 *   1. First run: collect the OpenAI key the server's agent brains use.
 *      The key is handed to the Electron main process, which stores it in
 *      the app's Application Support directory and restarts the local
 *      server with it. "Skip for now" is allowed — chat, boards, docs and
 *      calendar all work; only the LLM-backed agent features wait.
 *   2. Enter: POST /api/auth/local, which find-or-creates the machine's
 *      single local user and mints a normal session. No password, no
 *      provider, no network egress.
 */
import { useEffect, useState } from 'react'
import { api, getServerOrigin, setServerOrigin } from '@/api/client'
import { isElectron, type LocalServerStatus } from '@/lib/runtime'
import { useAuth } from '@/stores/auth'
import { CloudLogo } from './Avatar'
import { WindowDragStrip } from './WindowDragStrip'
import { useT } from '@/lib/i18n'

export function AuthScreen() {
  const t = useT()
  const [name, setName] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [status, setStatus] = useState<LocalServerStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showServer, setShowServer] = useState(false)

  // Local-server status is Electron-only. Subscribe first, then read the
  // current snapshot, so the first-run card reflects reality even if the
  // server reports readiness between the two calls.
  useEffect(() => {
    const bridge = window.cumora?.localServer
    if (!isElectron || !bridge) return
    const off = bridge.onStatus(setStatus)
    void bridge.status().then(setStatus).catch(() => { /* server not up yet */ })
    return off
  }, [])

  const needsKey = isElectron && status !== null && !status.hasApiKey
  const starting = isElectron && status !== null && (status.state === 'starting' || status.state === 'stopped')

  async function saveKey() {
    const bridge = window.cumora?.localServer
    if (!bridge || !keyInput.trim()) return
    setSavingKey(true)
    setErr(null)
    try {
      const next = await bridge.setOpenAIKey(keyInput.trim())
      setStatus(next)
      setKeyInput('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingKey(false)
    }
  }

  async function enter() {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.authLocal(name.trim() || null)
      useAuth.getState().setSession(r.token, { id: r.user.id, email: r.user.email, name: r.user.displayName }, r.companyId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 grid place-items-center overflow-auto" style={{ background: 'var(--paper)' }}>
      <WindowDragStrip />
      <div className="w-[360px] flex flex-col items-center gap-6 py-10">
        <CloudLogo size={64} />
        <div className="text-center">
          <div className="font-display text-[22px] text-ink-900">{t('auth.localWelcome')}</div>
          <div className="font-display italic text-[13px] text-ink-400 mt-1">{t('auth.localSub')}</div>
        </div>

        {needsKey && (
          <div className="w-full border border-ink-100 rounded-[12px] p-4 bg-cloud flex flex-col gap-2">
            <div className="font-display text-[14px] text-ink-900">{t('auth.openaiTitle')}</div>
            <div className="text-[11.5px] text-ink-500 leading-relaxed">{t('auth.openaiHint')}</div>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={t('auth.openaiPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className="h-10 px-3 rounded-[8px] border border-ink-100 bg-paper text-ink-900 placeholder:text-ink-300 text-[13px] focus:outline-none focus:border-sky2-300"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveKey}
                disabled={savingKey || !keyInput.trim()}
                className="h-9 px-3 rounded-[8px] bg-skype hover:bg-skype-deep text-white text-[12.5px] disabled:opacity-40"
              >
                {savingKey ? t('auth.preparing') : t('auth.saveKey')}
              </button>
            </div>
          </div>
        )}

        <div className="w-full flex flex-col gap-2">
          <label className="text-[11px] text-ink-400 font-display">{t('auth.nameLabel')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('auth.namePlaceholder')}
            className="h-10 px-3 rounded-[8px] border border-ink-100 bg-cloud text-ink-900 placeholder:text-ink-300 text-[13px] focus:outline-none focus:border-sky2-300"
          />
          <button
            type="button"
            onClick={enter}
            disabled={busy || starting}
            className="h-11 rounded-[10px] bg-skype hover:bg-skype-deep text-white transition-colors flex items-center justify-center text-[14px] font-medium disabled:opacity-60"
          >
            {busy || starting ? t('auth.preparing') : t('auth.enter')}
          </button>
        </div>

        {status && !needsKey && (
          <div className="text-[11px] text-ink-300 text-center">
            {status.state === 'ready' ? '● ' : '○ '}
            {status.state}
            {status.detail ? ` · ${status.detail}` : ''}
          </div>
        )}

        {err && <div className="text-[12px] text-red-600 text-center max-w-full break-words">{err}</div>}

        <div className="text-[11px] text-ink-300 text-center font-display italic">{t('auth.localNote')}</div>

        <ServerSwitch open={showServer} onToggle={() => setShowServer((v) => !v)} />
      </div>
    </div>
  )
}

/** Which API origin this build talks to. The personal build defaults to the
 *  bundled local server; the override exists for pointing the app at a
 *  different machine (e.g. a home server) without rebuilding. */
function ServerSwitch({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT()
  const [custom, setCustom] = useState('')
  const current = getServerOrigin()

  function apply(origin: string | null) {
    setServerOrigin(origin)
    location.reload()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="text-[11px] text-ink-300 hover:text-ink-500 transition-colors font-display"
      >
        {t('auth.apiServer')}: <span className="underline decoration-dotted">{current || 'http://127.0.0.1:5181'}</span>
      </button>
    )
  }
  return (
    <div className="w-full border border-ink-100 rounded-[10px] p-3 bg-cloud flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-display text-ink-900">{t('auth.apiServer')}</div>
        <button type="button" onClick={onToggle} className="text-[11px] text-ink-500 hover:text-ink-900">{t('common.close')}</button>
      </div>
      <div className="text-[11px] text-ink-500 break-all">{current || 'http://127.0.0.1:5181'}</div>
      <div className="flex items-stretch gap-2 pt-1">
        <input
          type="url"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="http://127.0.0.1:5181"
          className="flex-1 h-9 px-2 rounded-[6px] border border-ink-100 bg-paper text-ink-900 placeholder:text-ink-300 text-[12px] focus:outline-none focus:border-sky2-300"
        />
        <button
          type="button"
          disabled={!custom.trim()}
          onClick={() => apply(custom.trim())}
          className="h-9 px-3 rounded-[6px] bg-skype hover:bg-skype-deep text-white text-[12px] disabled:opacity-40"
        >
          {t('common.use')}
        </button>
      </div>
      {current && (
        <button
          type="button"
          onClick={() => apply(null)}
          className="text-[11px] text-ink-500 hover:text-ink-900 self-start"
        >
          {t('auth.clearOverride')}
        </button>
      )}
    </div>
  )
}
