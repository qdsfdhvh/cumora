/**
 * "Is the server's model service working?" — fetched in one place, shared by
 * the Rail (a dot on 我) and the 模型服务 panel (the explanation).
 *
 * Why this exists: a broken model service has no user-visible symptom. The
 * agents still answer, because their reasoning runs on the paired computer, so
 * the only trace is a column of failed rows in the call ledger that nobody
 * opens. On the install this was written on, the agenda classifier had failed
 * 247 consecutive times — invisible.
 *
 * The answer comes from the server's own ledger (see `/local/llm-health`), so
 * it cannot drift from what actually happened: it is the newest call vs the
 * newest successful one.
 */
import { useEffect, useState } from 'react'
import { api, type ApiLocalLlmHealth } from '@/api/client'

const POLL_MS = 60_000

let snapshot: ApiLocalLlmHealth | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<(next: ApiLocalLlmHealth | null) => void>()
let timer: ReturnType<typeof setInterval> | null = null

function publish(next: ApiLocalLlmHealth | null): void {
  snapshot = next
  for (const l of listeners) l(next)
}

/** Fetch now and wake every subscriber. Called after 测试连接 too, so the
 *  answer on screen updates the moment the owner has done something about it. */
export function refreshLlmHealth(): Promise<void> {
  if (inflight) return inflight
  inflight = api.localLlmHealth()
    .then((r) => publish(r))
    // A failing fetch is not itself evidence about the model service (it can
    // simply mean the server is restarting) — keep the last answer.
    .catch(() => { /* keep previous snapshot */ })
    .finally(() => { inflight = null })
  return inflight
}

/** Subscribe to the shared poller. Starts it on first use. */
export function useLlmHealth(): ApiLocalLlmHealth | null {
  const [state, setState] = useState<ApiLocalLlmHealth | null>(snapshot)
  useEffect(() => {
    const listener = (next: ApiLocalLlmHealth | null) => setState(next)
    listeners.add(listener)
    setState(snapshot)
    void refreshLlmHealth()
    if (!timer) timer = setInterval(() => void refreshLlmHealth(), POLL_MS)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }, [])
  return state
}
