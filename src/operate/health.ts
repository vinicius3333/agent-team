import type { Store } from "../store.ts"

export interface ProbeResult {
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
  error: string | null
}

export type HealthState = "up" | "down" | "unknown"

export interface HealthSummary {
  // null when there are no checks in the window.
  uptime7d: number | null
  p95LatencyMs24h: number | null
  lastCheckAt: string | null
  state: HealthState
}

const probeTimeoutMs = 10_000
export const probeIntervalMs = 5 * 60_000
export const downAfterFailures = 3
// A project whose checks stopped (the doctor is off) shows unknown, not a stale up or down.
const staleAfterMs = 60 * 60_000
const hourMs = 60 * 60_000

// A redirect counts as up, so it is not followed.
export async function probe(url: string, path: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const started = performance.now()
  try {
    const response = await fetchImpl(new URL(path, url), { redirect: "manual", signal: AbortSignal.timeout(probeTimeoutMs) })
    await response.body?.cancel()
    const latencyMs = Math.round(performance.now() - started)
    const ok = response.status >= 200 && response.status < 400
    return { ok, statusCode: response.status, latencyMs, error: ok ? null : `HTTP ${response.status}` }
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError"
    return { ok: false, statusCode: null, latencyMs: null, error: timedOut ? `no answer in ${probeTimeoutMs / 1000}s` : (error as Error).message }
  }
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

export function healthSummary(store: Store, now = Date.now()): HealthSummary {
  const week = store.healthChecks(new Date(now - 7 * 24 * hourMs).toISOString())
  const dayStart = new Date(now - 24 * hourMs).toISOString()
  const latencies = week.filter((check) => check.at >= dayStart && check.ok && check.latencyMs !== null).map((check) => check.latencyMs!)
  const last = week.at(-1) ?? null
  const recent = store.recentHealthChecks(downAfterFailures)
  const down = recent.length === downAfterFailures && recent.every((check) => !check.ok)
  const state: HealthState = !last || now - Date.parse(last.at) > staleAfterMs ? "unknown" : down ? "down" : "up"
  return {
    uptime7d: week.length ? Math.round((week.filter((check) => check.ok).length / week.length) * 10_000) / 100 : null,
    p95LatencyMs24h: percentile(latencies, 0.95),
    lastCheckAt: last?.at ?? null,
    state,
  }
}

// Live means deployed and approved: the app has a URL a person can open.
export function projectLive(store: Store): boolean {
  return Boolean(store.meta("deploy.url")) && store.phaseStatus("deploy") === "approved"
}

const downKey = "operate.health.down"

// Probes a live project at most every 5 minutes. Three failures in a row log one "down" event; the next success logs "recovered".
export async function probeProject(store: Store, healthPath: string, options: { now?: number; probe?: typeof probe } = {}): Promise<ProbeResult | null> {
  const now = options.now ?? Date.now()
  const url = store.meta("deploy.url")
  if (!url || !projectLive(store)) return null
  const last = store.recentHealthChecks(1)[0]
  if (last && now - Date.parse(last.at) < probeIntervalMs) return null
  const result = await (options.probe ?? probe)(url, healthPath)
  store.addHealthCheck(result, new Date(now))
  const recent = store.recentHealthChecks(downAfterFailures)
  const wasDown = store.meta(downKey) === "1"
  if (!wasDown && recent.length === downAfterFailures && recent.every((check) => !check.ok)) {
    store.setMeta(downKey, "1")
    store.log("operate", `health: down (${result.error ?? "unknown reason"})`)
  } else if (wasDown && result.ok) {
    store.setMeta(downKey, "")
    store.log("operate", "health: recovered")
  }
  return result
}
