/**
 * Motion policy — which decorative animation is allowed to run right now.
 *
 * The cloud build animated its ambient decoration unconditionally (a bobbing
 * mascot cloud, reaction bursts). On a laptop that keeps the compositor busy at
 * 60 fps forever: measured ~6.6% of a core on the GPU process plus ~2.4% on the
 * renderer, with the app sitting in the background behind the owner's editor.
 *
 * This module publishes two flags on <html> that CSS keys off:
 *
 *   data-attentive="0|1"      is anyone actually looking at this window?
 *                             (the app already tracks this for notifications;
 *                             hidden windows and unfocused windows are quiet)
 *   data-reduce-motion="1"    the owner asked for less motion in Preferences,
 *                             or the OS says so
 *
 * Only *ambient* animation is gated (see styles/globals.css). Progress spinners
 * and other functional motion keep running — they are how the app says "still
 * working".
 */
import { setNativeAppFocused, subscribeWindowAttention, isWindowAttentive } from './windowAttention'
import { usePrefs } from '@/stores/preferences'
import { isElectron } from './runtime'

const REDUCE_MOTION_KEY = 'ui.reduce_motion'

function osPrefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function prefsWantReducedMotion(): boolean {
  try {
    return usePrefs.getState().prefs[REDUCE_MOTION_KEY] === true || osPrefersReducedMotion()
  } catch {
    return osPrefersReducedMotion()
  }
}

function publish(attentive: boolean): void {
  const root = document.documentElement
  root.dataset.attentive = attentive ? '1' : '0'
  root.dataset.reduceMotion = prefsWantReducedMotion() ? '1' : '0'
}

/**
 * Start publishing the policy. Called once from the app entry point so it also
 * covers the sign-in screen (which shows the mascot before any store loads).
 */
export function bootMotionPolicy(): void {
  if (typeof document === 'undefined') return

  // Electron reports focus through native events (document.hasFocus() is
  // unreliable there); the browser path uses the DOM.
  const initial = isElectron ? isWindowAttentive() : (document.hasFocus() && document.visibilityState === 'visible')
  publish(initial)

  const offAttention = subscribeWindowAttention((attentive) => {
    publish(attentive && document.visibilityState === 'visible')
  })

  const onVisibility = () => {
    // Coming back to a visible window is "attentive" even if the OS never
    // re-fired focus (e.g. Mission Control, or a full-screen other app).
    publish(document.visibilityState === 'visible' && (isElectron ? isWindowAttentive() : document.hasFocus()))
  }
  document.addEventListener('visibilitychange', onVisibility)

  // Keep the OS flag honest for the browser shell; Electron does this itself.
  if (!isElectron) {
    const onFocus = () => setNativeAppFocused(true)
    const onBlur = () => setNativeAppFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
  }

  // Preferences can change at runtime (Me → 偏好设置 → 减少动态效果).
  const unsubscribePrefs = usePrefs.subscribe(() => {
    document.documentElement.dataset.reduceMotion = prefsWantReducedMotion() ? '1' : '0'
  })

  void offAttention
  void unsubscribePrefs
}
