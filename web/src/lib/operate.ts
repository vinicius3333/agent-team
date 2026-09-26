import type { Finding, FindingSeverity, FindingSource, HealthCheckPoint, OperateSnapshot } from "@/api/types"

export type MetricTone = "good" | "worse" | "down" | "none"

export const sourceLabels: Record<FindingSource, string> = {
  monitoring: "Monitoring",
  analytics: "PostHog",
  research: "Competitors",
  evaluator: "Evaluator",
  product: "Product ideas",
  manual: "Mine",
  routine: "Routines",
}

export const agentLabels: Record<FindingSource, string> = {
  monitoring: "Monitoring agent",
  analytics: "PostHog agent",
  research: "Research agent",
  evaluator: "Evaluator",
  product: "Product idea",
  manual: "Added by hand",
  routine: "Routine",
}

const severityRank: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 }

// The server sorts too; sorting again keeps the order stable when lists are merged or filtered.
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.createdAt.localeCompare(a.createdAt))
}

// Uptime below this over 7 days counts as worse, even while the app is up.
const uptimeTarget = 99.5
// A p95 above this counts as worse.
const slowLatencyMs = 1000

export function uptimeTone(health: OperateSnapshot["health"]): MetricTone {
  if (health.state === "down") return "down"
  if (health.uptime7d === null || health.state === "unknown") return "none"
  return health.uptime7d < uptimeTarget ? "worse" : "good"
}

export function latencyTone(health: OperateSnapshot["health"]): MetricTone {
  if (health.state === "down") return "down"
  if (health.p95LatencyMs24h === null) return "none"
  return health.p95LatencyMs24h > slowLatencyMs ? "worse" : "good"
}

// Higher is better for every PostHog headline metric.
export function trendTone(metric: OperateSnapshot["metrics"][string] | undefined): MetricTone {
  if (!metric) return "none"
  if (metric.previous === null) return "good"
  return metric.value < metric.previous ? "worse" : "good"
}

export function percentDelta(metric: OperateSnapshot["metrics"][string] | undefined): string | null {
  if (!metric || metric.previous === null || metric.previous === 0) return null
  const change = ((metric.value - metric.previous) / metric.previous) * 100
  return `${change >= 0 ? "+" : ""}${Math.round(change)}%`
}

export function pointDelta(metric: OperateSnapshot["metrics"][string] | undefined): string | null {
  if (!metric || metric.previous === null) return null
  const change = metric.value - metric.previous
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)} pt`
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

export type HourStatus = "up" | "down" | "none"

// One cell per hour for the last `hours` hours, oldest first. An hour with any failed check is down.
export function hourlyUptime(checks: HealthCheckPoint[], now = Date.now(), hours = 7 * 24): HourStatus[] {
  const hourMs = 60 * 60_000
  const start = now - hours * hourMs
  const cells: HourStatus[] = Array.from({ length: hours }, () => "none")
  for (const check of checks) {
    const index = Math.floor((Date.parse(check.at) - start) / hourMs)
    if (index < 0 || index >= hours) continue
    if (!check.ok) cells[index] = "down"
    else if (cells[index] === "none") cells[index] = "up"
  }
  // The server downsamples 7 days to about 200 points, so some hours hold no point; they take the previous hour's status.
  const last = cells.findLastIndex((cell) => cell !== "none")
  for (let index = 1; index < last; index++) if (cells[index] === "none") cells[index] = cells[index - 1]
  return cells
}
