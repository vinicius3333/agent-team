import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { PosthogConfig } from "../config.ts"
import type { Metric, Store } from "../store.ts"

export interface PosthogData {
  wau: { thisWeek: number; lastWeek: number }
  pageviews: { day: string; count: number }[]
  funnel: { step: string; count: number }[]
  topEvents: { event: string; count: number }[]
}

export class PosthogError extends Error {
  status: number | null
  constructor(status: number | null, message: string) {
    super(message)
    this.status = status
  }
}

const requestTimeoutMs = 30_000
const eventNamePattern = /^[A-Za-z0-9_$.:-]{1,100}$/
const signupEvent = "signed_up"

function quoted(event: string): string {
  if (!eventNamePattern.test(event)) throw new Error(`unsafe event name "${event}"`)
  return `'${event}'`
}

// Backticked event names under a "Funnel" heading in docs/analytics.md, in order.
export function funnelStepsFromDocs(projectDir: string): string[] | null {
  const path = join(projectDir, "docs", "analytics.md")
  if (!existsSync(path)) return null
  const section = readFileSync(path, "utf8").match(/^#+ .*funnel.*$([\s\S]*?)(?=^#+ |(?![\s\S]))/im)?.[1]
  if (!section) return null
  const steps = [...new Set([...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((name) => eventNamePattern.test(name)))]
  return steps.length >= 2 ? steps : null
}

export function defaultFunnel(topEvents: { event: string }[]): string[] {
  const firstCustom = topEvents.find((entry) => entry.event !== signupEvent)?.event
  return ["$pageview", signupEvent, ...(firstCustom ? [firstCustom] : [])]
}

export function posthogClient(config: PosthogConfig, apiKey: string, fetchImpl: typeof fetch = fetch) {
  return async function query(hogql: string): Promise<unknown[][]> {
    let response: Response
    try {
      response = await fetchImpl(`${config.host}/api/projects/${encodeURIComponent(config.projectId)}/query/`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError"
      throw new PosthogError(null, timedOut ? `PostHog did not answer in ${requestTimeoutMs / 1000}s` : `PostHog request failed: ${(error as Error).message}`)
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200)
      throw new PosthogError(response.status, `PostHog answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
    }
    const body = (await response.json()) as { results?: unknown[][] }
    return Array.isArray(body.results) ? body.results : []
  }
}

export async function fetchPosthogData(options: { projectDir: string; config: PosthogConfig; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }): Promise<PosthogData> {
  const apiKey = (options.env ?? process.env)[options.config.apiKeyEnv]
  if (!apiKey) throw new PosthogError(null, `the ${options.config.apiKeyEnv} environment variable is not set`)
  const query = posthogClient(options.config, apiKey, options.fetch)
  const [wauRows, pageviewRows, topRows] = await Promise.all([
    query("SELECT countDistinctIf(person_id, timestamp >= now() - INTERVAL 7 DAY), countDistinctIf(person_id, timestamp < now() - INTERVAL 7 DAY) FROM events WHERE timestamp >= now() - INTERVAL 14 DAY"),
    query("SELECT toDate(timestamp) AS day, count() FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL 14 DAY GROUP BY day ORDER BY day"),
    query("SELECT event, count() AS total FROM events WHERE timestamp >= now() - INTERVAL 30 DAY AND NOT startsWith(event, '$') GROUP BY event ORDER BY total DESC LIMIT 10"),
  ])
  const topEvents = topRows.map(([event, count]) => ({ event: String(event), count: Number(count) }))
  const steps = funnelStepsFromDocs(options.projectDir) ?? defaultFunnel(topEvents)
  // Distinct people per step over 30 days; a count per step, not a strict ordered funnel.
  const funnelRows = await query(`SELECT event, count(DISTINCT person_id) FROM events WHERE timestamp >= now() - INTERVAL 30 DAY AND event IN (${steps.map(quoted).join(", ")}) GROUP BY event`)
  const perStep = new Map(funnelRows.map(([event, count]) => [String(event), Number(count)]))
  return {
    wau: { thisWeek: Number(wauRows[0]?.[0] ?? 0), lastWeek: Number(wauRows[0]?.[1] ?? 0) },
    pageviews: pageviewRows.map(([day, count]) => ({ day: String(day).slice(0, 10), count: Number(count) })),
    funnel: steps.map((step) => ({ step, count: perStep.get(step) ?? 0 })),
    topEvents,
  }
}

// Metrics are dated by day, so a second run on the same day replaces the first.
export function posthogMetrics(data: PosthogData, now = new Date()): Metric[] {
  const today = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const weekAgo = `${new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString().slice(0, 10)}T00:00:00.000Z`
  const [first, second] = data.funnel
  const signups = data.funnel.find((step) => step.step === signupEvent)?.count ?? second?.count ?? 0
  const metrics: Metric[] = [
    { at: weekAgo, key: "wau", value: data.wau.lastWeek },
    { at: today, key: "wau", value: data.wau.thisWeek },
    { at: today, key: "signups", value: signups },
    ...data.funnel.map((step) => ({ at: today, key: `funnel.${step.step}`, value: step.count })),
    ...data.pageviews.map((entry) => ({ at: `${entry.day}T00:00:00.000Z`, key: "pageviews", value: entry.count })),
  ]
  if (first?.count) metrics.push({ at: today, key: "signup_conversion", value: Math.round((signups / first.count) * 1000) / 10 })
  return metrics
}

export function storePosthogData(store: Store, data: PosthogData, now = new Date()): void {
  store.recordMetrics(posthogMetrics(data, now))
}
