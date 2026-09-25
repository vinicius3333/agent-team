// Fills a project's state.db with realistic Operate data (the Dad Jokes mockups) to check the dashboard views.
// It replaces earlier health checks, metrics, findings, and insight runs. Usage: node scripts/seed-operate.ts <projectDir>
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openProjectStore } from "../src/project.ts"
import type { InsightAgent, Metric, NewFinding } from "../src/store.ts"

const minute = 60_000
const day = 24 * 60 * minute
const checkIntervalMs = 3 * minute

const projectDir = resolve(process.argv[2] ?? "")
if (!process.argv[2]) {
  console.error("Usage: node scripts/seed-operate.ts <projectDir>")
  process.exit(1)
}

// A fixed seed, so every run gives the same numbers.
let seed = 42
function random(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
  return seed / 2 ** 31
}

const store = openProjectStore(projectDir)
const raw = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
raw.exec("DELETE FROM health_checks; DELETE FROM metrics; DELETE FROM findings; DELETE FROM insight_runs;")
raw.close()

if (!store.meta("deploy.url")) store.setMeta("deploy.url", "https://dad-jokes-demo.trycloudflare.com")
if (store.phaseStatus("deploy") !== "approved") store.setPhase("deploy", "approved")

// 7 days of checks every 3 minutes: 2 failures in 3,360 checks is 99.94% uptime.
// The last 24 hours hold about 480 checks; 26 slow ones, the 4 fastest of them at 182 ms, make the p95 182 ms.
const now = Date.now()
const total = (7 * day) / checkIntervalMs
const lastDay = day / checkIntervalMs
const slowSlots = new Set<number>()
while (slowSlots.size < 26) slowSlots.add(Math.floor(random() * (lastDay - 10)))
const slowValues = [182, 182, 182, 182, ...Array.from({ length: 22 }, () => 190 + Math.round(random() * 140))]
for (let index = 0; index < total; index++) {
  const at = new Date(now - (total - index) * checkIntervalMs)
  const fromEnd = total - index - 1
  if (fromEnd === 900 || fromEnd === 2400) {
    store.addHealthCheck({ ok: false, statusCode: 502, latencyMs: 31, error: "HTTP 502" }, at)
    continue
  }
  const latencyMs = fromEnd < lastDay && slowSlots.has(fromEnd) ? slowValues.pop()! : 95 + Math.round(random() * 80)
  store.addHealthCheck({ ok: true, statusCode: 200, latencyMs, error: null }, at)
}

const dayStart = (daysAgo: number) => `${new Date(now - daysAgo * day).toISOString().slice(0, 10)}T00:00:00.000Z`
const metrics: Metric[] = [
  { at: dayStart(7), key: "wau", value: 1146 },
  { at: dayStart(0), key: "wau", value: 1284 },
  { at: dayStart(7), key: "signup_conversion", value: 3.9 },
  { at: dayStart(0), key: "signup_conversion", value: 3.1 },
  { at: dayStart(7), key: "signups", value: 45 },
  { at: dayStart(0), key: "signups", value: 40 },
  { at: dayStart(0), key: "funnel.$pageview", value: 2600 },
  { at: dayStart(0), key: "funnel.signup_form_viewed", value: 1066 },
  { at: dayStart(0), key: "funnel.email_confirmed", value: 416 },
  { at: dayStart(0), key: "funnel.first_vote", value: 312 },
  ...[["joke_viewed", 18_420], ["joke_voted", 6_312], ["joke_shared", 74], ["signup_form_viewed", 1_066], ["email_confirmed", 416], ["first_vote", 312], ["category_opened", 2_904], ["search_used", 611], ["signed_up", 402], ["joke_submitted", 58]].map(
    ([event, count]) => ({ at: dayStart(0), key: `event.${event}`, value: count as number }),
  ),
  ...Array.from({ length: 14 }, (_, index) => ({ at: dayStart(13 - index), key: "pageviews", value: Math.round(2_100 + index * 45 + random() * 380) })),
]
store.recordMetrics(metrics)

const findings: NewFinding[] = [
  { source: "monitoring", severity: "high", title: "Fix vote API errors", evidence: "2.3% 5xx on POST /api/votes since deploy #14 (212 of 9,180 requests in 7 days).", proposal: "Retry the vote insert once when SQLite reports SQLITE_BUSY, and return 409 for duplicate votes instead of 500." },
  { source: "analytics", severity: "medium", title: "Shorten signup to one step", evidence: "Funnel: 62% drop at email confirmation, 1,012 sessions in 30 days.", proposal: "Let users vote before confirming email; confirm later." },
  { source: "research", severity: "medium", title: "Add daily joke digest email", evidence: "2 of 3 tracked competitors ship it (icanhazdadjoke.com, jokesoftheday.net).", proposal: "Add an opt-in daily email with the top-voted joke of the day." },
  { source: "analytics", severity: "low", title: "Remove share button or move it", evidence: "0.4% usage over 30 days (74 shares in 18,420 joke views).", proposal: "Move the share button into the joke's menu to free space on the card." },
  { source: "analytics", severity: "low", title: "Add PostHog events for voting", evidence: "Vote flow has no tracked events for downvotes or vote changes.", proposal: "Track joke_downvoted and vote_changed with the joke id." },
]
for (const finding of findings) store.addFinding(finding)

const summaries: Record<InsightAgent, string> = {
  monitoring: "The app was up 99.94% of the last 7 days, with two short 502 outages during redeploys. p95 latency is 182 ms. The vote endpoint fails on 2.3% of requests since deploy #14: the log shows SQLITE_BUSY during vote bursts.",
  analytics: "Weekly active users grew 12% to 1,284. Signup conversion fell from 3.9% to 3.1%: most people leave at email confirmation. Voting is the core action, but downvotes and vote changes send no events.",
  research: "Three competitors checked. Two send a daily joke digest by email and one has a public API. None lets people submit jokes, which Dad Jokes already does, so submission is a clear edge.",
}
const counts: Record<InsightAgent, number> = { monitoring: 1, analytics: 3, research: 1 }
for (const agent of ["monitoring", "analytics", "research"] as const) store.finishInsightRun(store.startInsightRun(agent), "done", summaries[agent], counts[agent])

store.log("operate", "seeded Operate demo data")
store.close()
console.log(`Seeded ${projectDir}: ${total} health checks, ${metrics.length} metrics, ${findings.length} findings, 3 insight runs.`)
