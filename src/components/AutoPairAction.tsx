/**
 * "Set up this Mac" — pairs the local daemon from inside the app.
 *
 * The manual path (copy a command, paste it into a terminal) stays available
 * below it: this is the convenience path, not the only one. The renderer mints
 * the pairing code itself (it is the authenticated client) and the Electron
 * main process runs the published daemon CLI; output streams back line by line.
 *
 * Renders nothing in a browser/PWA build, or when the bridge is unavailable.
 */
import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { useComputers } from '@/stores/computers'
import { useT } from '@/lib/i18n'

export function AutoPairAction({
  engine,
  installService,
}: {
  /** Daemon default engine for a NEW computer, when the caller picked one. */
  engine?: string | null
  /** Register the daemon to start at login (the copy-paste flow's --install-service). */
  installService?: boolean
}) {
  const t = useT()
  const bridge = typeof window !== 'undefined' ? window.cumora?.localServer : undefined
  const [allowUnsandboxed, setAllowUnsandboxed] = useState(false)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; error?: string; hint?: string } | null>(null)

  useEffect(() => {
    if (!bridge?.onPairOutput) return
    return bridge.onPairOutput((line) => setLog((prev) => [...prev.slice(-200), line]))
  }, [bridge])

  // Browser/PWA builds have no main process to spawn the daemon.
  if (!bridge?.pairThisMac) return null

  /**
   * A code for THIS machine. If a computer is already paired to this workspace
   * we mint a *repair* code for it instead of a fresh pairing code: pairing
   * again would add a duplicate computer row and strand the agents that live on
   * the old one. Repair reconnects the existing computer, agents included.
   */
  async function resolveCode(): Promise<{ code: string; repaired: boolean }> {
    const existing = Object.values(useComputers.getState().byId).find((c) => c.kind !== 'cloud')
    if (existing) {
      const r = await api.repairComputer(existing.id)
      return { code: r.code, repaired: true }
    }
    const r = await api.requestPairingCode()
    return { code: r.code, repaired: false }
  }

  async function run() {
    if (!bridge?.pairThisMac) return
    setRunning(true)
    setResult(null)
    setLog([])
    try {
      const { code, repaired } = await resolveCode()
      const r = await bridge.pairThisMac({
        code,
        // Re-pairing must not re-pick engines: the agents on that computer
        // already have theirs.
        engine: repaired ? null : (engine ?? null),
        installService: installService !== false,
        allowUnsandboxed,
      })
      setResult({ ok: r.ok, error: r.error, hint: r.hint })
      if (!r.ok) setShowLog(true)
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
      setShowLog(true)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mt-3 rounded-[10px] border border-ink-100 bg-cloud p-3">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="w-full h-10 rounded-[9px] text-[12.5px] font-semibold text-white transition-colors disabled:opacity-50"
        style={{ background: 'var(--skype)' }}
      >
        {running ? t('pair.autoRunning') : t('pair.autoButton')}
      </button>

      <label className="flex items-start gap-2 mt-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={allowUnsandboxed}
          onChange={(e) => setAllowUnsandboxed(e.target.checked)}
          className="mt-[3px]"
        />
        <span className="text-[11.5px] text-ink-600 leading-snug">
          {t('pair.unsandboxed')} <span className="text-ink-400">— {t('pair.unsandboxedHint')}</span>
        </span>
      </label>

      {result?.ok && (
        <div className="mt-2 text-[11.5px] text-ink-500 font-display">{t('pair.autoDone')}</div>
      )}
      {result && !result.ok && (
        <div className="mt-2 text-[11.5px] text-coral-deep">
          {result.hint ?? t('pair.autoFailed')}
        </div>
      )}

      {log.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="text-[11px] text-ink-500 hover:text-ink-900"
          >
            {showLog ? t('pair.hideLog') : t('pair.showLog')}
          </button>
          {showLog && (
            <pre className="mt-1.5 max-h-[180px] overflow-auto rounded-[8px] bg-ink-900 text-cloud p-2 text-[10.5px] leading-[1.5] whitespace-pre-wrap break-all font-mono">
              {log.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
