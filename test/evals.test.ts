import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { parse } from "yaml"
import { compareResults, listBriefs, loadBrief, readBaseYaml, runEval, suiteConfig, type BriefResult, type EvalBrief, type EvalResult, type ProjectRunner } from "../src/evals.ts"
import { openStore, type Store } from "../src/store.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-evals-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function writeBrief(dir: string, id: string, settings: string): string {
  const briefDir = join(dir, id)
  mkdirSync(briefDir, { recursive: true })
  writeFileSync(join(briefDir, "brief.md"), `# ${id}\n\nA tiny app.\n`)
  writeFileSync(join(briefDir, "eval.yaml"), settings)
  return briefDir
}

function brief(overrides: Partial<EvalBrief> = {}): EvalBrief {
  return { id: "sample", brief: "# sample\n", tier: "smoke", target: "web", pipeline: {}, budgetUsd: 2, timeoutMinutes: 5, briefHash: "hash", ...overrides }
}

function seed(store: Store, costUsd: number): void {
  store.syncTasks(["T001", "T002", "Q101"])
  store.updateTask("T001", "merged")
  store.updateTask("T002", "blocked", "stuck")
  store.countReplan("T002")
  const attempt = { subject: "T001-1", status: "done", failureClass: null, durationMs: 10, transcriptPath: "x" }
  store.recordAttempt({ ...attempt, role: "worker", runner: "claude", model: "claude-opus-5-5", costUsd, tokens: 1000 })
  store.recordAttempt({ ...attempt, role: "worker", runner: "codex", model: "gpt-5.5", costUsd: null, tokens: null })
  store.recordAttempt({ ...attempt, role: "reviewer", runner: "claude", model: "opus", costUsd: 0.5, tokens: 500 })
  store.recordAttempt({ ...attempt, role: "lead", runner: "claude", model: "opus", costUsd: 9, tokens: 9000 })
  store.recordReview({ taskId: "T001", attempt: 1, verdict: "fail", flaggedFiles: [], fileHashes: {} })
  store.recordReview({ taskId: "T001", attempt: 2, verdict: "pass", flaggedFiles: [], fileHashes: {} })
}

function briefResult(overrides: Partial<BriefResult> = {}): BriefResult {
  return {
    id: "sample", briefHash: "hash", outcome: "completed", stop: null, phases: {},
    tasks: { total: 4, merged: 4, blocked: 0, replans: 0 }, attempts: { total: 8, byRole: {}, fallbacks: 0 },
    reviews: { total: 4, fail: 0 }, qa: { rounds: 1, verdict: "pass", fixTasks: 0 },
    costUsd: 2, unreportedCalls: 0, tokens: 1000, wallMs: 60_000, ...overrides,
  }
}

function evalResult(briefs: BriefResult[], overrides: Partial<EvalResult> = {}): EvalResult {
  return { resultId: "r", gitSha: "abc", dirty: false, label: null, tier: "smoke", configHash: "c", config: { roles: { worker: { model: "sonnet" } } }, runnerVersions: {}, aborted: null, briefs, ...overrides }
}

test("loadBrief applies defaults and rejects bad settings", () => {
  const dir = join(scratch, "load")
  const loaded = loadBrief(writeBrief(dir, "ok", "tier: smoke\nbudgetUsd: 2\n"), "ok")
  assert.equal(loaded.target, "web")
  assert.equal(loaded.timeoutMinutes, 90)
  assert.equal(loaded.briefHash.length, 16)
  assert.throws(() => loadBrief(writeBrief(dir, "tier", "tier: huge\nbudgetUsd: 2\n"), "tier"), /tier must be/)
  assert.throws(() => loadBrief(writeBrief(dir, "budget", "tier: smoke\n"), "budget"), /budgetUsd/)
})

test("listBriefs filters by tier, and full includes smoke", () => {
  const dir = join(scratch, "list")
  writeBrief(dir, "a-smoke", "tier: smoke\nbudgetUsd: 1\n")
  writeBrief(dir, "b-full", "tier: full\nbudgetUsd: 1\n")
  assert.deepEqual(listBriefs("smoke", [], dir).map((entry) => entry.id), ["a-smoke"])
  assert.deepEqual(listBriefs("full", [], dir).map((entry) => entry.id), ["a-smoke", "b-full"])
  assert.deepEqual(listBriefs("smoke", ["b-full"], dir).map((entry) => entry.id), ["b-full"])
  assert.throws(() => listBriefs("smoke", ["nope"], dir), /unknown brief "nope"/)
})

test("suiteConfig forces safety settings, then tier, then brief overrides", () => {
  const overrides = { deploy: { enabled: true }, qa: { maxRounds: 2 }, autonomy: { gates: ["spec"] }, budget: { runUsd: 999 } }
  const config = parse(suiteConfig(readBaseYaml(undefined), "smoke", brief({ target: "api", pipeline: overrides, budgetUsd: 4 })))
  assert.deepEqual(config.autonomy.gates, [])
  assert.equal(config.publish.github.enabled, false)
  assert.equal(config.deploy.enabled, true)
  assert.equal(config.branding.enabled, false)
  assert.equal(config.qa.maxRounds, 2)
  assert.equal(config.parallelTasks, 2)
  assert.equal(config.target, "api")
  assert.equal(config.budget.runUsd, 4)
})

test("evalSummary counts tasks, attempts, reviews, cost, and tokens without lead calls", () => {
  const store = openStore(":memory:")
  seed(store, 1.25)
  const summary = store.evalSummary()
  assert.deepEqual({ ...summary.tasks }, { total: 3, merged: 1, blocked: 1, replans: 1, qaFixes: 1 })
  assert.deepEqual({ ...summary.reviews }, { total: 2, fail: 1 })
  assert.equal(summary.costUsd, 1.75)
  assert.equal(summary.unreportedCalls, 1)
  assert.equal(summary.tokens, 1500)
  store.close()
})

const completingRun: ProjectRunner = async (_projectDir, store) => {
  seed(store, 1.25)
  store.setPhase("spec", "approved")
  return "completed"
}

test("runEval writes a result file with a fallback and the budget stop", async () => {
  const evalsDir = join(scratch, "run")
  const overBudget: ProjectRunner = async (_projectDir, store) => {
    store.setMeta("run.stop", JSON.stringify({ outcome: "awaiting_approval", kind: "budget", reason: "budget reached", at: "now" }))
    return "awaiting_approval"
  }
  const runners = [completingRun, overBudget]
  const { result, path } = await runEval({
    evalsDir, tier: "smoke", briefs: [brief({ id: "one" }), brief({ id: "two" })], baseYaml: readBaseYaml(undefined), label: "test",
    maxUsd: null, clean: false, signal: new AbortController().signal, log: () => {},
    runProject: (...args) => runners.shift()!(...args),
  })
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), result)
  assert.match(result.resultId, /-test$/)
  const [first, second] = result.briefs
  assert.equal(first.outcome, "completed")
  assert.deepEqual(first.tasks, { total: 3, merged: 1, blocked: 1, replans: 1 })
  assert.equal(first.attempts.fallbacks, 1)
  assert.equal(first.qa.fixTasks, 1)
  assert.equal(first.phases.spec, "approved")
  assert.equal(second.outcome, "awaiting_approval")
  assert.equal(second.stop?.kind, "budget")
  const pipeline = parse(readFileSync(join(evalsDir, "runs", result.resultId, "one", "pipeline.yaml"), "utf8"))
  assert.deepEqual(pipeline.autonomy.gates, [])
})

test("runEval stops before a brief that would pass --max-usd", async () => {
  const { result } = await runEval({
    evalsDir: join(scratch, "cap"), tier: "smoke", briefs: [brief({ id: "one", budgetUsd: 2 }), brief({ id: "two", budgetUsd: 2 })], baseYaml: readBaseYaml(undefined), label: null,
    maxUsd: 3, clean: true, signal: new AbortController().signal, log: () => {}, runProject: completingRun,
  })
  assert.deepEqual(result.briefs.map((entry) => entry.id), ["one"])
  assert.equal(result.aborted, "budget")
  assert.equal(existsSync(join(scratch, "cap", "runs", result.resultId)), false)
})

test("runEval records a timeout", async () => {
  // AbortSignal.timeout does not keep the event loop alive, so the stub holds a timer like a real run would.
  const hanging: ProjectRunner = (_projectDir, _store, signal) => new Promise((resolve) => {
    const alive = setInterval(() => {}, 1000)
    signal.addEventListener("abort", () => {
      clearInterval(alive)
      resolve("paused")
    })
  })
  const { result } = await runEval({
    evalsDir: join(scratch, "timeout"), tier: "smoke", briefs: [brief({ timeoutMinutes: 0.001 })], baseYaml: readBaseYaml(undefined), label: null,
    maxUsd: null, clean: true, signal: new AbortController().signal, log: () => {}, runProject: hanging,
  })
  assert.equal(result.briefs[0].outcome, "timeout")
})

test("compareResults flags worse outcomes, cost over 25%, and fewer merged tasks", () => {
  const before = evalResult([briefResult({ id: "a" }), briefResult({ id: "b" }), briefResult({ id: "c" }), briefResult({ id: "d" })])
  const after = evalResult([
    briefResult({ id: "a", outcome: "failed" }),
    briefResult({ id: "b", costUsd: 2.6 }),
    briefResult({ id: "c", tasks: { total: 4, merged: 3, blocked: 1, replans: 0 } }),
    briefResult({ id: "d", costUsd: 2.4 }),
  ], { configHash: "other", config: { roles: { worker: { model: "haiku" } } } })
  const comparison = compareResults(before, after)
  assert.deepEqual(comparison.briefs.map((entry) => entry.regressions.length > 0), [true, true, true, false])
  assert.deepEqual(comparison.changedConfigKeys, ["roles.worker.model"])
  assert.match(comparison.warnings[0], /roles\.worker\.model/)
})

test("compareResults compares the share of merged tasks, not the count", () => {
  const before = evalResult([briefResult({ tasks: { total: 9, merged: 9, blocked: 0, replans: 0 } })])
  const after = evalResult([briefResult({ tasks: { total: 8, merged: 8, blocked: 0, replans: 0 } })])
  assert.deepEqual(compareResults(before, after).briefs[0].regressions, [])
})

test("compareResults refuses a changed brief unless allowed", () => {
  const before = evalResult([briefResult()])
  const after = evalResult([briefResult({ briefHash: "new" })])
  assert.throws(() => compareResults(before, after), /--allow-brief-change/)
  assert.match(compareResults(before, after, true).warnings.join(), /changed/)
})
