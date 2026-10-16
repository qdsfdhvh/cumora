/**
 * Product analytics seam — the personal build ships with NO telemetry.
 *
 * The cloud build wired PostHog here (env-gated, baked at build time).
 * This fork removed the SDK entirely: nothing is sent anywhere, ever.
 * The two exported helpers are kept so call sites stay stable and an
 * operator who wants analytics later has an obvious seam to fill.
 */
export function getAnalyticsSurface(): 'electron' | 'web' | 'notification' | 'browser' {
  if (typeof window === 'undefined') return 'browser'
  if (window.location.hash === '#notifications') return 'notification'
  if (window.cumora?.isElectron) return 'electron'
  return 'browser'
}

export async function initObservability(): Promise<void> {
  // Intentionally empty: no analytics in the personal build.
}
