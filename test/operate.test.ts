import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { posthogEnv } from "../src/deploy.ts"
import { healthSummary, percentile, probe, probeProject } from "../src/operate/health.ts"
import { fetchPosthogData, posthogMetrics, PosthogError } from "../src/operate/posthog.ts"
import { dueAgents, parseInsightReply, runInsightAgent } from "../src/operate/agents.ts"
import { operateTick } from "../src/operate/tick.ts"
import { approveFinding, dismissFinding } from "../src/operate/findings.ts"
import { createProject, ProjectError, withProjectStore } from "../src/project.ts"
import { toClaudeTools } from "../src/runners/claude.ts"
import { downsampleChecks } from "../src/operate/snapshot.ts"
import { openStore } from "../src/store.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-operate-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

let storeCount = 0
function freshStore() {
  return openStore(join(scratch, `state-${++storeCount}.db`))
}

const finding = { source: "monitoring" as const, severity: "high" as const, title: "Fix vote API errors", evidence: "2.3% 5xx", proposal: "Retry the insert." }

test("addFinding updates an open finding with the same normalized title instead of adding one", () => {
  const store = freshStore()
  const first = store.addFinding(finding)
  const again = store.addFinding({ ...finding, title: "  fix   VOTE api errors ", evidence: "3.1% 5xx" })
  assert.equal(first.created, true)
  assert.deepEqual(again, { id: first.id, created: false })
  const [only] = store.listFindings()
  assert.equal(store.listFindings().length, 1)
  assert.equal(only.evidence, "3.1% 5xx")
  assert.equal(only.title, "Fix vote API errors")

  assert.equal(store.addFinding({ ...finding, source: "analytics" }).created, true)
  store.setFindingStatus(first.id, "dismissed")
  assert.equal(store.addFinding(finding).created, true)
  assert.equal(store.openFindingCount(), 2)
  store.close()
})

test("listFindings ranks by severity, then newest first, and filters by status", () => {
  const store = freshStore()
  store.addFinding({ ...finding, severity: "low", title: "a" })
  store.addFinding({ ...finding, severity: "high", title: "b" })
  store.addFinding({ ...finding, severity: "medium", title: "c" })
  const later = store.addFinding({ ...finding, severity: "high", title: "d" })
  assert.deepEqual(store.listFindings().map((row) => row.title), ["d", "b", "c", "a"])
  store.setFindingStatus(later.id, "approved", "C002")
  assert.deepEqual(store.listFindings({ status: "approved" }).map((row) => [row.title, row.changeId]), [["d", "C002"]])
  assert.deepEqual(store.listFindings({ status: "open" }).map((row) => row.title), ["b", "c", "a"])
  store.close()
})

test("addHealthCheck keeps 14 days of checks", () => {
  const store = freshStore()
  const now = Date.parse("2026-09-24T12:00:00Z")
  const day = 24 * 60 * 60_000
  store.addHealthCheck({ ok: true, statusCode: 200, latencyMs: 90, error: null }, new Date(now - 20 * day))
  store.addHealthCheck({ ok: false, statusCode: 502, latencyMs: 30, error: "HTTP 502" }, new Date(now - 13 * day))
  store.addHealthCheck({ ok: true, statusCode: 200, latencyMs: 80, error: null }, new Date(now))
  const checks = store.healthChecks("")
  assert.equal(checks.length, 2)
  assert.equal(checks[0].ok, false)
  assert.deepEqual(store.recentHealthChecks(10, true).map((check) => check.statusCode), [502])
  store.close()
})

test("metrics keep the latest and previous value per key and replace the funnel", () => {
  const store = freshStore()
  store.recordMetrics([
    { at: "2026-09-17T00:00:00Z", key: "wau", value: 1146 },
    { at: "2026-09-17T00:00:00Z", key: "funnel.$pageview", value: 100 },
    { at: "2026-09-17T00:00:00Z", key: "funnel.old_step", value: 10 },
  ])
  store.recordMetrics([
    { at: "2026-09-24T00:00:00Z", key: "wau", value: 1284 },
    { at: "2026-09-24T00:00:00Z", key: "funnel.$pageview", value: 120 },
  ])
  const latest = store.latestMetrics()
  assert.deepEqual(latest.wau, { value: 1284, previous: 1146, at: "2026-09-24T00:00:00Z" })
  assert.equal(latest["funnel.old_step"], undefined)
  assert.equal(latest["funnel.$pageview"].previous, null)
  store.recordMetrics([{ at: "2026-09-24T00:00:00Z", key: "wau", value: 1290 }])
  assert.deepEqual(store.metricSeries("wau").map((metric) => metric.value), [1146, 1290])
  store.close()
})

test("insight runs report the last run per agent", () => {
  const store = freshStore()
  const first = store.startInsightRun("monitoring")
  store.finishInsightRun(first, "done", "All good.", 0)
  const second = store.startInsightRun("monitoring")
  store.startInsightRun("research")
  assert.equal(store.lastInsightRun("monitoring")?.id, second)
  assert.equal(store.lastInsightRun("monitoring")?.status, "running")
  assert.deepEqual(store.lastInsightRuns().map((run) => run.agent), ["monitoring", "research"])
  store.close()
})

const examplePipeline = readFileSync(new URL("../pipeline.example.yaml", import.meta.url), "utf8")

function writePipeline(name: string, operateYaml: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "pipeline.yaml")
  writeFileSync(path, `${examplePipeline.replace(/^operate:[\s\S]*?\n\n/m, "")}\n${operateYaml}`)
  return path
}

test("loadConfig reads the operate block and fills defaults", () => {
  const defaults = loadConfig(writePipeline("operate-defaults", "")).operate
  assert.deepEqual(defaults, { enabled: true, healthPath: "/", schedule: { monitoring: 24, analytics: 24, research: 168 }, posthog: null, competitors: [] })
  const config = loadConfig(
    writePipeline(
      "operate-full",
      "operate:\n  schedule: { research: 0 }\n  posthog: { projectId: 12345, publicKey: phc_x }\n  competitors: [https://example.com]\n",
    ),
  )
  assert.deepEqual(config.operate.schedule, { monitoring: 24, analytics: 24, research: 0 })
  assert.deepEqual(config.operate.posthog, { host: "https://us.posthog.com", projectId: "12345", publicKey: "phc_x", apiKeyEnv: "POSTHOG_API_KEY" })
  assert.equal(config.roles.monitor.model, "claude-opus-5-5")
  assert.equal(config.roles.researcher.runner, "claude")
  assert.throws(() => loadConfig(writePipeline("operate-bad", "operate:\n  healthPath: health\n  schedule: { monitoring: -1 }\n  competitors: [example.com]\n")), /healthPath[\s\S]*monitoring[\s\S]*competitors/)
})

const minute = 60_000
const hour = 60 * minute

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}

test("probe counts 2xx and 3xx as up and reports errors", async () => {
  const up = await probe("https://app.example", "/health", stubFetch((url) => {
    assert.equal(url, "https://app.example/health")
    return new Response("ok", { status: 200 })
  }))
  assert.equal(up.ok, true)
  assert.equal(up.statusCode, 200)
  assert.equal((await probe("https://app.example", "/", stubFetch(() => new Response(null, { status: 302 })))).ok, true)
  assert.deepEqual({ ...(await probe("https://app.example", "/", stubFetch(() => new Response("", { status: 503 })))), latencyMs: 0 }, { ok: false, statusCode: 503, latencyMs: 0, error: "HTTP 503" })
  const timeout = await probe("https://app.example", "/", stubFetch(() => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" })
  }))
  assert.deepEqual(timeout, { ok: false, statusCode: null, latencyMs: null, error: "no answer in 10s" })
})

test("healthSummary computes uptime over 7 days and p95 latency over 24 hours", () => {
  const store = freshStore()
  const now = Date.parse("2026-09-24T12:00:00Z")
  assert.deepEqual(healthSummary(store, now), { uptime7d: null, p95LatencyMs24h: null, lastCheckAt: null, state: "unknown" })
  store.addHealthCheck({ ok: false, statusCode: 500, latencyMs: 5000, error: "HTTP 500" }, new Date(now - 3 * 24 * hour))
  for (let index = 1; index <= 19; index++) store.addHealthCheck({ ok: true, statusCode: 200, latencyMs: index * 10, error: null }, new Date(now - (20 - index) * minute))
  const summary = healthSummary(store, now)
  assert.equal(summary.uptime7d, 95)
  assert.equal(summary.p95LatencyMs24h, 190)
  assert.equal(summary.state, "up")
  assert.equal(healthSummary(store, now + 2 * hour).state, "unknown")
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95), 19)
  store.close()
})

test("probeProject waits 5 minutes between probes and logs down after 3 failures, then recovered", async () => {
  const store = freshStore()
  const failing = async () => ({ ok: false, statusCode: 502, latencyMs: 20, error: "HTTP 502" })
  assert.equal(await probeProject(store, "/", { probe: failing }), null)
  store.setMeta("deploy.url", "https://app.example")
  store.setPhase("deploy", "approved")
  const start = Date.parse("2026-09-24T12:00:00Z")
  for (let index = 0; index < 3; index++) assert.ok(await probeProject(store, "/", { now: start + index * 5 * minute, probe: failing }))
  assert.equal(await probeProject(store, "/", { now: start + 11 * minute, probe: failing }), null)
  await probeProject(store, "/", { now: start + 15 * minute, probe: failing })
  await probeProject(store, "/", { now: start + 20 * minute, probe: async () => ({ ok: true, statusCode: 200, latencyMs: 80, error: null }) })
  const messages = store.recentEvents(10).map((event) => `${event.type}: ${event.message}`).reverse()
  assert.deepEqual(messages, ["operate: health: down (HTTP 502)", "operate: health: recovered"])
  store.close()
})

const posthogConfig = { host: "https://ph.example", projectId: "12345", publicKey: null, apiKeyEnv: "TEST_POSTHOG_KEY" }

function posthogStub(queries: string[], funnelEvents: [string, number][]) {
  return stubFetch((url, init) => {
    assert.equal(url, "https://ph.example/api/projects/12345/query/")
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret")
    const hogql = JSON.parse(String(init?.body)).query.query as string
    queries.push(hogql)
    const results = hogql.includes("countDistinctIf")
      ? [[1284, 1146]]
      : hogql.includes("toDate")
        ? [["2026-09-23", 400], ["2026-09-24", 420]]
        : hogql.includes("LIMIT 10")
          ? [["signed_up", 50], ["joke_voted", 300]]
          : funnelEvents
    return Response.json({ results })
  })
}

test("fetchPosthogData queries HogQL and falls back to the default funnel", async () => {
  const queries: string[] = []
  const projectDir = join(scratch, "posthog-default")
  mkdirSync(projectDir, { recursive: true })
  const data = await fetchPosthogData({ projectDir, config: posthogConfig, env: { TEST_POSTHOG_KEY: "secret" }, fetch: posthogStub(queries, [["$pageview", 1000], ["signed_up", 31]]) })
  assert.deepEqual(data.wau, { thisWeek: 1284, lastWeek: 1146 })
  assert.deepEqual(data.pageviews, [{ day: "2026-09-23", count: 400 }, { day: "2026-09-24", count: 420 }])
  assert.deepEqual(data.funnel, [{ step: "$pageview", count: 1000 }, { step: "signed_up", count: 31 }, { step: "joke_voted", count: 0 }])
  assert.match(queries.at(-1)!, /event IN \('\$pageview', 'signed_up', 'joke_voted'\)/)
  const metrics = posthogMetrics(data, new Date("2026-09-24T15:00:00Z"))
  assert.deepEqual(metrics.find((metric) => metric.key === "signup_conversion"), { at: "2026-09-24T00:00:00.000Z", key: "signup_conversion", value: 3.1 })
  assert.deepEqual(metrics.filter((metric) => metric.key === "wau").map((metric) => [metric.at.slice(0, 10), metric.value]), [["2026-09-17", 1146], ["2026-09-24", 1284]])
})

test("fetchPosthogData reads funnel steps from docs/analytics.md", async () => {
  const projectDir = join(scratch, "posthog-docs")
  mkdirSync(join(projectDir, "docs"), { recursive: true })
  writeFileSync(join(projectDir, "docs", "analytics.md"), "# Analytics\n\n## Events\n\n- `joke_viewed`\n\n## Funnel\n\n1. `landing_viewed`\n2. `signup_started`\n3. `signed_up`\n\n## Notes\n\n`ignored`\n")
  const data = await fetchPosthogData({ projectDir, config: posthogConfig, env: { TEST_POSTHOG_KEY: "secret" }, fetch: posthogStub([], [["landing_viewed", 100]]) })
  assert.deepEqual(data.funnel.map((step) => step.step), ["landing_viewed", "signup_started", "signed_up"])
})

test("fetchPosthogData fails with the HTTP status or a missing key", async () => {
  const projectDir = join(scratch, "posthog-default")
  await assert.rejects(fetchPosthogData({ projectDir, config: posthogConfig, env: {}, fetch: posthogStub([], []) }), /TEST_POSTHOG_KEY environment variable is not set/)
  await assert.rejects(
    fetchPosthogData({ projectDir, config: posthogConfig, env: { TEST_POSTHOG_KEY: "secret" }, fetch: stubFetch(() => new Response("bad key", { status: 401 })) }),
    (error: unknown) => error instanceof PosthogError && error.status === 401 && /HTTP 401: bad key/.test(error.message),
  )
})

const insightReply = (body: object) => `Looked at the data.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``
const validFinding = (title: string) => ({ severity: "medium", title, evidence: "62% drop", proposal: "Shorten signup." })

test("parseInsightReply keeps 5 valid findings and reports dropped ones", () => {
  const reply = parseInsightReply(
    insightReply({
      summary: " Signup leaks. ",
      findings: [validFinding("a"), { severity: "urgent", title: "b", evidence: "e", proposal: "p" }, { severity: "low", title: "c" }, validFinding("d"), validFinding("e"), validFinding("f"), validFinding("g"), validFinding("h")],
    }),
  )
  assert.equal(reply.summary, "Signup leaks.")
  assert.deepEqual(reply.findings.map((finding) => finding.title), ["a", "d", "e", "f", "g"])
  assert.deepEqual(reply.dropped, ["finding 2 has no valid severity", "finding 3 has no valid evidence, proposal", "finding 8 is over the limit of 5: h"])
  assert.throws(() => parseInsightReply(insightReply({ findings: [] })), /no summary/)
})

test("dueAgents runs agents past their schedule only on live projects", () => {
  const projectDir = join(scratch, "due")
  createProject(projectDir, "Dad jokes")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  withProjectStore(projectDir, (store) => {
    const now = Date.now()
    assert.deepEqual(dueAgents(store, config, now), [])
    store.setMeta("deploy.url", "https://app.example")
    store.setPhase("deploy", "approved")
    assert.deepEqual(dueAgents(store, config, now), ["monitoring", "analytics", "research"])
    store.finishInsightRun(store.startInsightRun("monitoring"), "done", "ok", 0)
    store.startInsightRun("research")
    assert.deepEqual(dueAgents(store, config, now), ["analytics"])
    assert.deepEqual(dueAgents(store, config, now + 25 * hour), ["monitoring", "analytics"])
    assert.deepEqual(dueAgents(store, { ...config, operate: { ...config.operate, schedule: { monitoring: 0, analytics: 0, research: 0 } } }, now + 25 * hour), [])
    assert.deepEqual(dueAgents(store, { ...config, operate: { ...config.operate, enabled: false } }, now), [])
    store.setMeta("run.pid", String(process.pid))
    assert.deepEqual(dueAgents(store, config, now), [])
  })
})

test("runInsightAgent gathers monitoring data, stores findings, and writes the report", async () => {
  const projectDir = join(scratch, "insight")
  createProject(projectDir, "Dad jokes")
  withProjectStore(projectDir, (store) => store.addHealthCheck({ ok: false, statusCode: 500, latencyMs: 40, error: "HTTP 500" }))
  let prompt = ""
  const outcome = await runInsightAgent({
    projectDir,
    agent: "monitoring",
    logs: () => "Error: vote insert failed",
    runAgent: async (request, runner) => {
      prompt = request.taskPrompt
      assert.equal(request.role, "monitor")
      assert.equal(runner, "claude")
      assert.equal(request.budgetUsd, 1)
      assert.deepEqual(request.allowedTools, ["read"])
      return { status: "done", summary: insightReply({ summary: "Votes fail.", findings: [{ ...validFinding("Fix vote API errors"), severity: "high" }, { title: "broken" }] }), costUsd: 0.2, tokens: 10, durationMs: 5, exitCode: 0, diagnostics: "" }
    },
  })
  assert.match(prompt, /vote insert failed/)
  assert.match(prompt, /HTTP 500/)
  assert.equal(outcome.status, "done")
  assert.deepEqual(outcome.findings.map((finding) => [finding.source, finding.title]), [["monitoring", "Fix vote API errors"]])
  assert.match(readFileSync(join(projectDir, "docs", "operate", "monitoring.md"), "utf8"), /Fix vote API errors/)
  withProjectStore(projectDir, (store) => {
    assert.equal(store.lastInsightRun("monitoring")?.status, "done")
    assert.equal(store.lastInsightRun("monitoring")?.findings, 1)
    assert.equal(store.recentAttempts("insight-monitoring", 1)[0].role, "monitor")
    assert.ok(store.recentEvents(5).some((event) => /dropped finding 2/.test(event.message)))
  })
})

test("runInsightAgent without PostHog fails and asks to set it up", async () => {
  const projectDir = join(scratch, "no-posthog")
  createProject(projectDir, "Dad jokes")
  const outcome = await runInsightAgent({ projectDir, agent: "analytics", runAgent: async () => assert.fail("no agent call without data") })
  assert.equal(outcome.status, "failed")
  assert.equal(outcome.summary, "posthog not configured")
  assert.deepEqual(outcome.findings.map((finding) => [finding.severity, finding.title]), [["low", "Set up PostHog analytics"]])
})

test("the Claude runner maps web tools for the research agent", () => {
  assert.deepEqual(toClaudeTools(["read", "web_search", "web_fetch"]), ["Read", "Glob", "Grep", "WebSearch", "WebFetch"])
})

// A finished first build: every phase approved and the one task merged, so openChange accepts a request.
function finishedProject(name: string): string {
  const projectDir = join(scratch, name)
  createProject(projectDir, "Dad jokes")
  withProjectStore(projectDir, (store) => {
    for (const phase of ["spec", "architecture", "branding", "design", "marketing", "plan", "qa", "deploy"]) store.setPhase(phase, "approved")
    store.syncTasks(["T001"])
    store.updateTask("T001", "merged")
  })
  return projectDir
}

const rejectsWith = (status: number, pattern: RegExp) => (error: unknown) => error instanceof ProjectError && error.status === status && pattern.test(error.message)

test("approveFinding opens a change from the finding and refuses like openChange", () => {
  const projectDir = finishedProject("approve")
  withProjectStore(projectDir, (store) => {
    const { id } = store.addFinding({ source: "analytics", severity: "medium", title: "Shorten signup to one step", evidence: "62% drop at email confirmation", proposal: "Let users vote before confirming email." })
    const other = store.addFinding({ ...finding, title: "Another" }).id
    assert.throws(() => approveFinding(projectDir, store, 999), rejectsWith(404, /unknown finding/))

    store.setMeta("run.pid", String(process.pid))
    assert.throws(() => approveFinding(projectDir, store, id), rejectsWith(409, /run is in progress/))
    assert.equal(store.finding(id)?.status, "open")
    store.setMeta("run.pid", "")

    const change = approveFinding(projectDir, store, id)
    assert.equal(change.request, "Shorten signup to one step\n\nLet users vote before confirming email.\n\nWhy: 62% drop at email confirmation")
    assert.deepEqual([store.finding(id)?.status, store.finding(id)?.changeId], ["approved", change.id])
    assert.throws(() => approveFinding(projectDir, store, id), rejectsWith(409, /already approved/))
    assert.throws(() => approveFinding(projectDir, store, other), rejectsWith(409, /still open/))
    assert.equal(store.finding(other)?.status, "open")

    dismissFinding(store, other)
    assert.equal(store.finding(other)?.status, "dismissed")
    assert.throws(() => dismissFinding(store, other), rejectsWith(409, /already dismissed/))
  })
})

test("operateTick probes live projects and runs due agents one at a time", async () => {
  const runsDir = join(scratch, "tick-runs")
  createProject(join(runsDir, "live"), "Dad jokes")
  createProject(join(runsDir, "building"), "Recipes")
  withProjectStore(join(runsDir, "live"), (store) => {
    store.setMeta("deploy.url", "https://app.example")
    store.setPhase("deploy", "approved")
  })
  const probed: string[] = []
  const calls: string[] = []
  let release = () => {}
  const done = new Promise<void>((resolve) => (release = resolve))
  await operateTick({
    runsDir,
    probe: async (url) => {
      probed.push(url)
      return { ok: true, statusCode: 200, latencyMs: 50, error: null }
    },
    runAgent: async (projectDir, agent) => {
      calls.push(`${projectDir.split("/").pop()}:${agent}`)
      if (calls.length === 3) release()
    },
  })
  await done
  assert.deepEqual(probed, ["https://app.example"])
  assert.deepEqual(calls, ["live:monitoring", "live:analytics", "live:research"])
})

test("posthogEnv passes the public key and host only when a key is set", () => {
  const config = loadConfig(writePipeline("posthog-env", "operate:\n  posthog: { host: https://eu.posthog.com/, projectId: 1, publicKey: phc_x }\n"))
  assert.deepEqual(posthogEnv(config), { POSTHOG_KEY: "phc_x", VITE_POSTHOG_KEY: "phc_x", POSTHOG_HOST: "https://eu.posthog.com" })
  assert.deepEqual(posthogEnv(loadConfig(writePipeline("posthog-none", ""))), {})
})

test("downsampleChecks keeps at most the limit and marks a group down when any check failed", () => {
  const checks = Array.from({ length: 10 }, (_, index) => ({ at: `2026-09-24T00:0${index}:00Z`, ok: index !== 3, statusCode: index === 3 ? 502 : 200, latencyMs: 100 + index, error: null }))
  const points = downsampleChecks(checks, 4)
  assert.equal(points.length, 4)
  assert.deepEqual(points[1], { at: "2026-09-24T00:03:00Z", ok: false, statusCode: 502, latencyMs: 104 })
  assert.equal(downsampleChecks(checks).length, 10)
})

test("server serves operate data and findings, and runs agents in the background", async (t) => {
  const runsDir = join(scratch, "server-runs")
  const projectDir = join(runsDir, "dad-jokes")
  createProject(projectDir, "Dad jokes")
  let findingId = 0
  withProjectStore(projectDir, (store) => {
    store.setMeta("deploy.url", "https://app.example")
    store.setPhase("deploy", "approved")
    store.addHealthCheck({ ok: true, statusCode: 200, latencyMs: 182, error: null })
    store.recordMetrics([{ at: "2026-09-24T00:00:00.000Z", key: "wau", value: 1284 }, { at: "2026-09-24T00:00:00.000Z", key: "funnel.$pageview", value: 100 }, { at: "2026-09-24T00:00:00.000Z", key: "event.joke_voted", value: 30 }])
    findingId = store.addFinding(finding).id
    store.addFinding({ ...finding, title: "Dismiss me" })
  })
  const agentRuns: string[] = []
  let finishRun = () => {}
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, notifications: false, startRun: () => {}, runInsight: (_dir, agent) => {
    agentRuns.push(agent)
    return new Promise<void>((resolve) => (finishRun = resolve))
  } })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify(body) })

  const operate = await (await fetch(`${base}/dad-jokes/operate`)).json()
  assert.equal(operate.enabled, true)
  assert.equal(operate.live, true)
  assert.equal(operate.health.state, "up")
  assert.equal(operate.checks.length, 1)
  assert.deepEqual(operate.metrics, { wau: { value: 1284, previous: null, at: "2026-09-24T00:00:00.000Z" } })
  assert.deepEqual(operate.funnel, [{ step: "$pageview", count: 100 }])
  assert.deepEqual(operate.topEvents, [{ event: "joke_voted", count: 30 }])
  assert.deepEqual(operate.runs, { monitoring: null, analytics: null, research: null })
  assert.deepEqual(operate.config, { posthog: false, competitors: [], schedule: { monitoring: 24, analytics: 24, research: 168 } })

  const list = await (await fetch(`${base}`)).json()
  assert.equal(list[0].openFindings, 2)
  assert.equal((await fetch(`${base}/dad-jokes/findings?status=nope`)).status, 400)
  assert.equal((await (await fetch(`${base}/dad-jokes/findings`)).json()).length, 2)

  const refused = await post(`/dad-jokes/findings/${findingId}/approve`)
  assert.equal(refused.status, 409)
  assert.match((await refused.json()).error, /Finish or fix the current run/)
  assert.equal((await post("/dad-jokes/findings/999/approve")).status, 404)
  assert.equal((await post(`/dad-jokes/findings/${findingId + 1}/dismiss`)).status, 200)
  assert.equal((await post(`/dad-jokes/findings/${findingId + 1}/dismiss`)).status, 409)
  assert.equal((await (await fetch(`${base}/dad-jokes/findings?status=all`)).json()).length, 2)

  assert.equal((await post("/dad-jokes/operate/run", { agent: "nope" })).status, 400)
  assert.equal((await post("/dad-jokes/operate/run", { agent: "research" })).status, 202)
  assert.equal((await post("/dad-jokes/operate/run", { agent: "research" })).status, 409)
  finishRun()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await post("/dad-jokes/operate/run", { agent: "research" })).status, 202)
  finishRun()
  assert.deepEqual(agentRuns, ["research", "research"])
})
