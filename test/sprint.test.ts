import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { defaultSprintConfig, loadConfig, type PipelineConfig } from "../src/config.ts"
import { changeRequestMaxLength, createProject, ProjectError, withProjectStore } from "../src/project.ts"
import { addBacklogItem, parseEvaluation, parseSprintPlan, sprintBlocker, sprintRequest, sprintSpend, sprintTick, syncSprint } from "../src/sprint.ts"
import { openStore, type Store } from "../src/store.ts"
import type { DeployResult } from "../src/deploy.ts"
import { liveAppLine, startSprint } from "../src/improve.ts"
import { ensureDeployed, type PipelineContext } from "../src/pipeline.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-sprint-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

let storeCount = 0
function freshStore(): Store {
  return openStore(join(scratch, `state-${++storeCount}.db`))
}

// A finished, deployed build: the state a sprint starts from.
function finishedStore(): Store {
  const store = freshStore()
  for (const phase of ["plan", "qa", "deploy"]) store.setPhase(phase, "approved")
  store.syncTasks(["T001"])
  store.updateTask("T001", "merged")
  return store
}

function spend(store: Store, usd: number): void {
  store.recordAttempt({ subject: "x", role: "worker", runner: "claude", model: "m", status: "done", failureClass: null, costUsd: usd, tokens: null, durationMs: 1, transcriptPath: "x" })
}

const config = { sprints: { ...defaultSprintConfig, enabled: true }, deploy: { enabled: true } } as PipelineConfig
const day = 24 * 60 * 60_000

// What a sprint does before the evaluator runs: deploy when the app has no URL, then report the live app.
async function sprintReportAfterDeploy(name: string, result: DeployResult): Promise<string> {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  const projectConfig = loadConfig(join(projectDir, "pipeline.yaml"))
  projectConfig.deploy.enabled = true
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  store.setPhase("deploy", "approved")
  const context = { projectDir, config: projectConfig, store, signal: new AbortController().signal, deploy: async () => result, appRunning: () => false } as unknown as PipelineContext
  await ensureDeployed(context)
  return liveAppLine(store)
}

test("the sprint report holds the live URL after a deploy", async () => {
  const line = await sprintReportAfterDeploy("sprint-deployed", { url: "https://sprint.trycloudflare.com", error: null })
  assert.equal(line, "- The live app: https://sprint.trycloudflare.com.")
})

test("the sprint report holds the reason after a failed deploy", async () => {
  // A tunnel failure pauses the deploy with no worker fix, so the test needs no runner.
  const line = await sprintReportAfterDeploy("sprint-deploy-failed", { url: null, error: "tunnel URL https://x.trycloudflare.com did not answer", stage: "tunnel" })
  assert.match(line, /^- The live app: not deployed \(The app runs, but its public URL did not answer: .+, then run: agent-team deploy .+\)\.$/)
})

test("the sprint report treats an empty deploy.url as not deployed", () => {
  const store = freshStore()
  store.setMeta("deploy.url", "")
  assert.equal(liveAppLine(store), "- The live app: not deployed.")
  store.setMeta("deploy.error", "Waiting for secrets: STRIPE_KEY. Enter or skip them in Settings > Secrets.")
  assert.equal(liveAppLine(store), "- The live app: not deployed (Waiting for secrets: STRIPE_KEY. Enter or skip them in Settings > Secrets).")
})

function evaluationJson(scores: number[], gaps: unknown[]) {
  const names = ["brief_coverage", "functionality", "monetization", "ux_and_branding", "quality_and_reliability"]
  return JSON.stringify({ summary: "ok", dimensions: Object.fromEntries(names.map((name, index) => [name, { score: scores[index], notes: "" }])), gaps })
}

test("parseEvaluation averages the dimensions and maps gap severities to backlog severities", () => {
  const evaluation = parseEvaluation(evaluationJson([80, 60, 20, 70, 70], [
    { title: "No checkout", detail: "404", severity: "blocker" },
    { title: "Spacing", detail: "", severity: "minor" },
    { title: "", detail: "untitled gaps are dropped", severity: "major" },
  ]), 3)
  assert.equal(evaluation.score, 60)
  assert.equal(evaluation.sprint, 3)
  assert.deepEqual(evaluation.gaps.map((gap) => [gap.title, gap.severity]), [["No checkout", "high"], ["Spacing", "low"]])
  assert.throws(() => parseEvaluation(JSON.stringify({ dimensions: {}, gaps: [] }), 1), /brief_coverage/)
})

test("parseSprintPlan accepts open items and proposals within maxItems, and rejects the rest", () => {
  const store = freshStore()
  const open = store.addFinding({ source: "manual", severity: "medium", title: "Dark mode", evidence: "Added by you.", proposal: "Follow the system theme." }).id
  const closed = store.addFinding({ source: "research", severity: "low", title: "Digest", evidence: "e", proposal: "p" }).id
  store.setFindingStatus(closed, "dismissed")
  const stale = store.addFinding({ source: "analytics", severity: "low", title: "Old", evidence: "e", proposal: "p" }).id
  const backlog = store.listFindings()
  const proposal = { severity: "low", title: "Share as image", evidence: "Shares drive growth.", proposal: "Render the joke as an image." }

  const plan = parseSprintPlan(JSON.stringify({ goal: "Dark mode", items: [open], proposals: [proposal], dismiss: [{ id: stale, reason: "done" }, { id: open, reason: "picked" }], request: "Add dark mode." }), backlog, defaultSprintConfig)
  assert.deepEqual(plan.items, [open])
  assert.equal(plan.proposals[0].title, "Share as image")
  assert.deepEqual(plan.dismiss, [{ id: stale, reason: "done" }], "a picked item is never dismissed")

  assert.throws(() => parseSprintPlan(JSON.stringify({ goal: "g", items: [closed], request: "r" }), backlog, defaultSprintConfig), /not open backlog items: 2/)
  assert.throws(() => parseSprintPlan(JSON.stringify({ goal: "g", items: [open], proposals: [proposal, proposal], request: "r" }), backlog, { ...defaultSprintConfig, maxItems: 2 }), /at most 2/)
  assert.throws(() => parseSprintPlan(JSON.stringify({ goal: "g", proposals: [proposal], request: "r" }), backlog, { ...defaultSprintConfig, newFeatures: false }), /newFeatures is off/)
  assert.throws(() => parseSprintPlan(JSON.stringify({ items: [open] }), backlog, defaultSprintConfig), /goal is missing[\s\S]*request is missing/)
  const empty = parseSprintPlan(JSON.stringify({ items: [], proposals: [] }), backlog, defaultSprintConfig)
  assert.equal(empty.items.length + empty.proposals.length, 0, "an empty plan skips the sprint")
  store.close()
})

test("sprintRequest keeps the trail of backlog items and fits the change request limit", () => {
  const store = freshStore()
  const id = store.addFinding({ source: "evaluator", severity: "high", title: "Checkout fails", evidence: "e", proposal: "p" }).id
  const request = sprintRequest(4, { goal: "Payments work", items: [id], proposals: [], dismiss: [], request: "x".repeat(10_000) }, store.listFindings())
  assert.ok(request.length <= changeRequestMaxLength)
  assert.match(request, /^Sprint 4: Payments work/)
  assert.match(request, new RegExp(`- #${id} \\[evaluator, high\\] Checkout fails$`))
  store.close()
})

test("sprintBlocker waits for a finished deployed build, then for everyDays after the last sprint", () => {
  const store = freshStore()
  assert.match(sprintBlocker(store, config)!, /build is not finished/)
  assert.match(sprintBlocker(store, { ...config, deploy: { enabled: false } })!, /need deploy.enabled/)
  store.close()

  const done = finishedStore()
  const now = Date.now()
  assert.equal(sprintBlocker(done, config, { now }), null, "the first sprint starts right after the build")
  const first = done.startSprint(0)
  assert.match(sprintBlocker(done, config, { now })!, /sprint 1 is still planning/)
  done.finishSprint(first.number, "skipped")
  assert.match(sprintBlocker(done, config, { now })!, /next sprint is due/)
  assert.equal(sprintBlocker(done, config, { now, early: true }), null, "Start sprint now skips the wait")
  assert.equal(sprintBlocker(done, config, { now: now + 7 * day + 1000 }), null)

  const second = done.startSprint(0)
  done.finishSprint(second.number, "failed", "runner outage")
  assert.equal(sprintBlocker(done, config, { now: now + 6 * 60 * 60_000 + 1000 }), null, "a failed sprint is tried again after 6 hours")
  done.close()
})

test("sprintBlocker stops at sprints.monthlyUsd and counts a sprint in progress", () => {
  const store = finishedStore()
  const now = Date.now()
  const sprint = store.startSprint(store.projectCost().usd)
  spend(store, 80)
  assert.equal(Math.round(sprintSpend(store, now)), 80)
  store.finishSprint(sprint.number, "done")
  assert.match(sprintBlocker(store, config, { now: now + 8 * day })!, /spent \$80\.00 in the last 30 days/)
  assert.equal(sprintBlocker(store, config, { now: now + 31 * day }), null, "spend older than 30 days no longer counts")
  store.close()
})

test("syncSprint closes a building sprint when its change merges, and a dead planning sprint as failed", () => {
  const store = finishedStore()
  const planning = store.startSprint(0)
  syncSprint(store)
  assert.equal(store.sprint(planning.number)!.status, "failed")

  const building = store.startSprint(0)
  store.openChange({ id: "C001", request: "r", branch: "change/C001-r", baseCommit: "abc" }, [])
  store.updateSprint(building.number, { status: "building", changeId: "C001" })
  spend(store, 4)
  syncSprint(store)
  assert.equal(store.sprint(building.number)!.status, "building")
  store.finishChange("C001", "merged")
  syncSprint(store)
  const closed = store.sprint(building.number)!
  assert.equal(closed.status, "done")
  assert.equal(closed.costUsd, 4)
  assert.ok(closed.finishedAt)
  store.close()
})

test("syncSprint closes a change stuck open with no live run as failed, so sprints can start again", () => {
  const store = finishedStore()
  const building = store.startSprint(0)
  store.openChange({ id: "C001", request: "r", branch: "change/C001-r", baseCommit: "abc" }, ["plan", "qa", "deploy"])
  store.updateSprint(building.number, { status: "building", changeId: "C001" })
  const now = Date.now()
  syncSprint(store, now)
  assert.equal(store.change("C001")!.status, "open", "a change just opened waits for its run")
  syncSprint(store, now + 2 * 60 * 60_000)
  assert.equal(store.change("C001")!.status, "failed")
  assert.ok(store.recentEvents(10).some((event) => /C001 was still open with no run in progress/.test(event.message)), "the close has a reason")
  assert.equal(store.sprint(building.number)!.status, "abandoned")
  assert.doesNotMatch(sprintBlocker(store, config, { now: now + 2 * 60 * 60_000, early: true }) ?? "", /still open|build is not finished/)
  store.close()
})

test("an imported project with approved findings starts a sprint that ends in a final state", async () => {
  const projectDir = join(scratch, "imported")
  createProject(projectDir, "brief")
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/imported-project/state.json", import.meta.url), "utf8"))
  const projectConfig = loadConfig(join(projectDir, "pipeline.yaml"))
  projectConfig.deploy.enabled = true
  projectConfig.sprints.enabled = true
  projectConfig.harness.isolation = "none"
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  for (const [phase, status] of Object.entries(fixture.phases)) store.setPhase(phase, status as "approved")
  for (const [key, value] of Object.entries(fixture.meta)) store.setMeta(key, value as string)
  for (const finding of fixture.findings) store.setFindingStatus(store.addFinding(finding).id, "approved")
  assert.equal(sprintBlocker(store, projectConfig), null)

  const deploys: string[] = []
  const failed = { status: "failed", summary: "fake runner: no reply", costUsd: 0, tokens: null, durationMs: 1, exitCode: 1, diagnostics: "" }
  const harness = { run: async () => ({ result: failed, candidate: null, failureClass: "agent_failure" }) }
  const deploy = async () => (deploys.push("deploy"), { url: "https://imported.trycloudflare.com", error: null })
  const context = { projectDir, config: projectConfig, store, signal: new AbortController().signal, harness, deploy, appRunning: () => false } as unknown as PipelineContext
  await startSprint(context, { early: true })
  const sprint = store.sprints(1)[0]
  assert.ok(sprint, "the sprint has a row")
  assert.ok(["done", "failed"].includes(sprint.status), `the sprint ended ${sprint.status}`)
  assert.deepEqual(deploys, ["deploy"], "the sprint deploys the app first")
  store.close()
})

test("addBacklogItem records a manual item and validates the input", () => {
  const store = freshStore()
  const item = addBacklogItem(store, { title: " Dark mode ", detail: "Follow the system theme." }, "vini")
  assert.deepEqual([item.source, item.severity, item.title, item.evidence, item.proposal], ["manual", "medium", "Dark mode", "Added by vini.", "Follow the system theme."])
  const rejects = (input: Parameters<typeof addBacklogItem>[1], pattern: RegExp) =>
    assert.throws(() => addBacklogItem(store, input, "vini"), (error: unknown) => error instanceof ProjectError && error.status === 400 && pattern.test(error.message))
  rejects({ title: "" }, /title/)
  rejects({ title: "x", severity: "urgent" }, /Severity/)
  rejects({ title: "x".repeat(201) }, /under 200/)
  store.close()
})

test("an evolve block from before sprints turns sprints on with its cycle budget", () => {
  const path = join(scratch, "legacy.yaml")
  const example = readFileSync(new URL("../pipeline.example.yaml", import.meta.url), "utf8")
  const withoutSprints = example.replace(/^sprints:[\s\S]*?\n\n/m, "")
  writeFileSync(path, `${withoutSprints}\nevolve:\n  enabled: true\n  targetScore: 90\n  cycleBudgetUsd: 40\n`)
  const legacy = loadConfig(path).sprints
  assert.equal(legacy.enabled, true)
  assert.equal(legacy.budgetUsd, 40)
  assert.equal(legacy.everyDays, defaultSprintConfig.everyDays)
  writeFileSync(path, `${example.replace("monthlyUsd: 100", "monthlyUsd: 10")}`)
  assert.throws(() => loadConfig(path), /sprints.monthlyUsd must be at least sprints.budgetUsd/)
})

test("sprintTick starts a sprint run for a due project and none for one that is not", () => {
  const runsDir = mkdtempSync(join(scratch, "runs-"))
  const due = join(runsDir, "due")
  const idle = join(runsDir, "idle")
  for (const projectDir of [due, idle]) {
    createProject(projectDir, "Dad jokes")
    withProjectStore(projectDir, (store) => {
      for (const phase of ["plan", "qa", "deploy"]) store.setPhase(phase, "approved")
      store.syncTasks(["T001"])
      store.updateTask("T001", "merged")
    })
  }
  withProjectStore(idle, (store) => store.finishSprint(store.startSprint(0).number, "done"))
  const started: string[] = []
  sprintTick({ runsDir, startRun: (projectDir, _log, command) => (started.push(`${projectDir} ${command.join(" ")}`), 1) })
  assert.deepEqual(started, [`${due} sprint`])
})

test("the dashboard lists sprints, adds backlog items, and starts a sprint early", async (t) => {
  const runsDir = mkdtempSync(join(scratch, "ui-"))
  const projectDir = join(runsDir, "dad-jokes")
  createProject(projectDir, "Dad jokes")
  const launched: string[] = []
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, notifications: false, startRun: (_dir, _log, command) => void launched.push((command ?? ["run"]).join(" ")) })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/dad-jokes`
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify(body) })

  const before = await (await fetch(`${base}/sprints`)).json()
  assert.deepEqual(before.sprints, [])
  assert.match(before.startBlocker, /build is not finished/)
  const refused = await post("/sprints/start")
  assert.equal(refused.status, 409)
  assert.deepEqual(launched, [])

  const added = await post("/findings", { title: "Dark mode", detail: "Follow the system theme.", severity: "high" })
  assert.equal(added.status, 201)
  assert.deepEqual(await added.json().then((item) => [item.source, item.severity, item.evidence]), ["manual", "high", "Added by you."])
  assert.equal((await post("/findings", { title: "" })).status, 400)

  withProjectStore(projectDir, (store) => {
    for (const phase of ["plan", "qa", "deploy"]) store.setPhase(phase, "approved")
    store.syncTasks(["T001"])
    store.updateTask("T001", "merged")
    store.finishSprint(store.startSprint(0).number, "done")
  })
  const after = await (await fetch(`${base}/sprints`)).json()
  assert.match(after.blocker, /next sprint is due/)
  assert.equal(after.startBlocker, null)
  assert.equal(after.backlogSize, 1)
  assert.equal((await post("/sprints/start")).status, 202)
  assert.deepEqual(launched, ["sprint --now"])
})
