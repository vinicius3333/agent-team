import { insightAgents, type InsightAgent, type PipelineConfig } from "../config.ts"
import type { HealthCheck, InsightRun, Store } from "../store.ts"
import { healthSummary, projectLive, type HealthSummary } from "./health.ts"

const maxCheckPoints = 200
const dayMs = 24 * 60 * 60_000

export interface CheckPoint {
  at: string
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
}

export interface OperateSnapshot {
  enabled: boolean
  live: boolean
  health: HealthSummary
  checks: CheckPoint[]
  metrics: Record<string, { value: number; previous: number | null; at: string }>
  series: { wau: { at: string; value: number }[]; pageviews: { at: string; value: number }[] }
  funnel: { step: string; count: number }[]
  topEvents: { event: string; count: number }[]
  runs: Record<InsightAgent, InsightRun | null>
  config: { posthog: boolean; competitors: string[]; schedule: Record<InsightAgent, number> }
}

// Merges neighbouring checks into at most `limit` points: a point is up only when every check in it was up.
export function downsampleChecks(checks: HealthCheck[], limit = maxCheckPoints): CheckPoint[] {
  const size = Math.max(1, Math.ceil(checks.length / limit))
  const points: CheckPoint[] = []
  for (let start = 0; start < checks.length; start += size) {
    const group = checks.slice(start, start + size)
    const latencies = group.map((check) => check.latencyMs).filter((latency): latency is number => latency !== null)
    const failed = group.findLast((check) => !check.ok)
    points.push({
      at: group[0].at,
      ok: !failed,
      statusCode: (failed ?? group.at(-1)!).statusCode,
      latencyMs: latencies.length ? Math.round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length) : null,
    })
  }
  return points
}

export function operateSnapshot(store: Store, config: PipelineConfig, now = Date.now()): OperateSnapshot {
  const since = (days: number) => new Date(now - days * dayMs).toISOString()
  const points = (key: string, days: number) => store.metricSeries(key, since(days)).map(({ at, value }) => ({ at, value }))
  return {
    enabled: config.operate.enabled,
    live: projectLive(store),
    health: healthSummary(store, now),
    checks: downsampleChecks(store.healthChecks(since(7))),
    metrics: Object.fromEntries(Object.entries(store.latestMetrics()).filter(([key]) => !key.includes("."))),
    series: { wau: points("wau", 90), pageviews: points("pageviews", 14) },
    funnel: store.metricsWithPrefix("funnel.").map(({ name, value }) => ({ step: name, count: value })),
    topEvents: store.metricsWithPrefix("event.").map(({ name, value }) => ({ event: name, count: value })),
    runs: Object.fromEntries(insightAgents.map((agent) => [agent, store.lastInsightRun(agent)])) as Record<InsightAgent, InsightRun | null>,
    config: { posthog: config.operate.posthog !== null, competitors: config.operate.competitors, schedule: config.operate.schedule },
  }
}
