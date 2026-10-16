/**
 * AuthGate — wraps the entire app and decides whether to show the
 * sign-in screen or the real UI based on the auth store.
 *
 * Two responsibilities:
 *   1. On first mount, consume a `#token=...&companyId=...` fragment if one
 *      is present (legacy deep-link hand-off). Persist the session, then
 *      scrub the URL so a reload doesn't re-arm the fragment.
 *   2. Probe /auth/me with the persisted token; if the token is valid
 *      the app loads, otherwise we fall through to AuthScreen (which in the
 *      personal build signs in locally — no OAuth, no cloud).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '@/api/client'
import { useT } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'
import { isElectron } from '@/lib/runtime'
import { AuthScreen } from './AuthScreen'
import { WindowDragStrip } from './WindowDragStrip'

interface AuthGateProps {
  children: ReactNode
  /** Override the "no token" rendering. The invite-accept flow uses this
   *  so an unauthenticated visitor sees the invitation card (with sign-in
   *  buttons embedded) instead of the bare login screen. */
  unauthFallback?: ReactNode
}

interface CarriedSession { token: string; companyId: string | null }

/** Pull a fresh OAuth token out of `location.hash`. Returns null if the
 *  fragment is empty or has no token. On success, scrubs the fragment so
 *  the token never lingers in the browser address bar. */
function consumeOAuthFragment(): CarriedSession | null {
  const hash = location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const token = params.get('token')
  if (!token) return null
  const companyId = params.get('companyId')
  // Replace the URL without ?#... so refresh/reopen doesn't re-process.
  history.replaceState(null, '', location.pathname + location.search)
  return { token, companyId }
}


export function AuthGate({ children, unauthFallback }: AuthGateProps) {
  const t = useT()
  const token = useAuth((s) => s.token)
  const cachedUser = useAuth((s) => s.user)
  const ready = useAuth((s) => s.ready)
  const setSession = useAuth((s) => s.setSession)
  const setMe = useAuth((s) => s.setMe)
  const setServerCapabilities = useAuth((s) => s.setServerCapabilities)
  const clear = useAuth((s) => s.clear)
  const markReady = useAuth((s) => s.markReady)

  // Run-once: consume the OAuth fragment before the probe effect sees
  // `token` and decides what to do. useState init runs synchronously
  // before any effect, so the auth store has the new token in time.
  useState(() => {
    const carried = consumeOAuthFragment()
    if (carried) {
      // setMe runs on the /auth/me probe right below. For now just plant
      // a placeholder user so setSession's WS-reconnect call has a valid
      // token; the probe will fill in the rest.
      setSession(carried.token, { id: '', email: '', name: '' }, carried.companyId)
    }
    return null
  })

  useEffect(() => {
    let cancelled = false
    if (!token) { markReady(); return }
    void (async () => {
      // The packaged app renders before its embedded server is listening, so a
      // boot-time probe can fail with a connection error. That is NOT a bad
      // session: only a 401 means the token is dead. Anything else retries
      // (and, if the server stays down, leaves the token alone so the session
      // survives the next launch).
      let delay = 300
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api.authMe()
          if (cancelled) return
          setMe(r.user, r.companies, r.activeCompanyId)
          setServerCapabilities(r.serverCapabilities)
          markReady()
          return
        } catch (e) {
          if (cancelled) return
          const unauthorized = e instanceof ApiError && e.status === 401
          if (unauthorized) { clear(); return }
          if (attempt >= 12) {
            // Give up waiting: keep the session (it is not wrong, the server
            // is just unreachable) and let the shell render its own errors.
            markReady()
            return
          }
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 1.5, 2_000)
        }
      }
    })()
    return () => { cancelled = true }
  }, [token, setMe, setServerCapabilities, clear, markReady])

  // Paint the real shell right away when the last session is still on disk:
  // the probe below only confirms it (and clears it on a 401). Without this the
  // packaged app shows a blank frame until its embedded server answers.
  if (!ready && !(token && cachedUser?.id)) {
    // Brief loading flash while we probe — keeps the app from flashing
    // login → main on a valid token reload.
    return (
      <div
        className="fixed inset-0 grid place-items-center text-ink-300 font-display italic text-[13px]"
        style={{ background: 'var(--paper)' }}
      ><WindowDragStrip />{t('app.starting')}</div>
    )
  }

  if (!token) return <>{unauthFallback ?? <AuthScreen />}</>
  return <>{children}</>
}
