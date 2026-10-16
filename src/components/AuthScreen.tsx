/**
 * Sign-in screen — personal local build.
 *
 * There is no cloud account and no provider to visit. Two things happen here:
 *
 *   1. First run: collect the OpenAI key the agent brains use. The key goes to
 *      the Electron main process, which stores it in the app's data directory
 *      and restarts the local server with it. "Skip for now" is allowed.
 *   2. Enter: POST /api/auth/local, which find-or-creates the machine's single
 *      local user and mints a session.
 *
 * When the local account already exists the screen is skipped entirely: nobody
 * wants to be asked their name on every launch — it is editable in Me →
 * profile — so the sign-in happens automatically unless the owner signed out
 * on purpose (that intent is remembered in localStorage).
 */
import { useEffect, useRef, useState } from 'react'
import { api, getServerOrigin, setServerOrigin } from '@/api/client'
import { isElectron, type LocalServerStatus } from '@/lib/runtime'
import { useAuth, SIGNED_OUT_KEY } from '@/stores/auth'
import { CloudLogo } from './Avatar'
import { LocalKeyPrompt } from './LocalKeyPrompt'
import { WindowDragStrip } from './WindowDragStrip'
import { useT } from '@/lib/i18n'

export function AuthScreen() {
  const t = useT()
  const [status, setStatus] = useState<LocalServerStatus | null>(null)
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof api.authProviders>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showServer, setShowServer] = useState(false)
  const [accountChecked, setAccountChecked] = useState(false)
  const tried = useRef(false)

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

  // Who is on this machine already, plus the workspace branding. The server is
  // still booting when this screen first paints, so retry until it answers —
  // otherwise a first-run-looking screen would hide an existing account (and
  // the auto sign-in below would never fire).
  const serverReady = !isElectron || status?.state === 'ready'
  useEffect(() => {
    if (!serverReady) return
    let cancelled = false
    void (async () => {
      let delay = 300
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api.authProviders()
          if (cancelled) return
          setProviders(r)
          setAccountChecked(true)
          return
        } catch {
          if (cancelled) return
          if (attempt >= 12) { setAccountChecked(true); return }
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 1.5, 2_000)
        }
      }
    })()
    return () => { cancelled = true }
  }, [serverReady])

  const needsKey = isElectron && status !== null && !status.hasApiKey
  const starting = isElectron && status !== null && (status.state === 'starting' || status.state === 'stopped')
  const account = providers?.account ?? null
  const branding = providers?.branding ?? null

  async function enter() {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.authLocal(null)
      useAuth.getState().setSession(r.token, { id: r.user.id, email: r.user.email, name: r.user.displayName }, r.companyId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  // The account exists and the owner didn't sign out → just go in. Wait for
  // the server (and, on first run, for the key form to be resolved) so this
  // never races the boot.
  useEffect(() => {
    if (tried.current) return
    if (!accountChecked) return
    if (!account) return
    if (starting || needsKey) return
    if (localStorage.getItem(SIGNED_OUT_KEY) === '1') return
    tried.current = true
    void enter()
  }, [accountChecked, account, starting, needsKey])

  const autoEntering = account !== null && !needsKey && !starting
    && localStorage.getItem(SIGNED_OUT_KEY) !== '1'

  return (
    <div className="fixed inset-0 grid place-items-center overflow-auto" style={{ background: 'var(--paper)' }}>
      <WindowDragStrip />
      <div className="w-[360px] flex flex-col items-center gap-6 py-10">
        {branding?.logoUrl
          ? (
            <img
              src={branding.logoUrl}
              alt={branding.workspaceName || 'Cumora'}
              width={64}
              height={64}
              className="rounded-[16px] object-cover"
              style={{ width: 64, height: 64 }}
            />
          )
          : <CloudLogo size={64} />}
        <div className="text-center">
          <div className="font-display text-[22px] text-ink-900">
            {branding?.workspaceName || t('auth.localWelcome')}
          </div>
          <div className="font-display italic text-[13px] text-ink-400 mt-1">{t('auth.localSub')}</div>
        </div>

        {isElectron && needsKey && (
          <div className="w-full border border-ink-100 rounded-[12px] p-4 bg-cloud">
            <div className="font-display text-[14px] text-ink-900 mb-2">{t('auth.openaiTitle')}</div>
            <LocalKeyPrompt status={status} onSaved={setStatus} />
          </div>
        )}

        {account && (
          <div className="w-full flex items-center gap-3 rounded-[12px] border border-ink-100 bg-cloud px-3 py-2.5">
            {account.avatarUrl
              ? <img src={account.avatarUrl} alt={account.name} width={34} height={34} className="rounded-full object-cover shrink-0" style={{ width: 34, height: 34 }} />
              : <div className="w-[34px] h-[34px] rounded-full bg-ink-100 shrink-0" />}
            <div className="min-w-0">
              <div className="font-display text-[13.5px] text-ink-900 truncate">{account.name}</div>
              <div className="text-[11px] text-ink-400 truncate">{account.email}</div>
            </div>
            <div className="ml-auto text-[10px] uppercase tracking-wider text-ink-300">{t('auth.localAccountLabel')}</div>
          </div>
        )}

        <button
          type="button"
          onClick={enter}
          disabled={busy || starting || autoEntering}
          className="w-full h-11 rounded-[10px] bg-skype hover:bg-skype-deep text-white transition-colors flex items-center justify-center text-[14px] font-medium disabled:opacity-60"
        >
          {busy || starting || autoEntering
            ? t('auth.preparing')
            : account ? t('auth.continueAs', { name: account.name }) : t('auth.enter')}
        </button>

        {accountChecked && !account && (
          <div className="text-[11px] text-ink-300 text-center">{t('auth.firstRunNote')}</div>
        )}

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
