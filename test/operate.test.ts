import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { openStore } from "../src/store.ts"

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
