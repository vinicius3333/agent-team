import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { loadConfig, planningPhases } from "../src/config.ts"
import { commitAll } from "../src/git.ts"
import { createGitHub } from "../src/github.ts"
import type { AgentJob, Harness, HarnessOutcome } from "../src/harness/harness.ts"
import { extractJsonObject } from "../src/json.ts"
import { parseVerdict, runPipeline, workerPrompt } from "../src/pipeline.ts"
import { approveTaskBudget, createProject } from "../src/project.ts"
import { decideReplan, normalizeFailure, parseBlock, parseReplanAction } from "../src/replan.ts"
import { classifyFailure } from "../src/harness/classify.ts"
import { toClaudeTools } from "../src/runners/claude.ts"
import { openStore } from "../src/store.ts"
import { pathsOverlap, type Task } from "../src/tasks.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-loop-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id.toLowerCase()}/**`], readPaths: [], acceptance: ["works"], verify: "true", ...overrides }
}

test("extractJsonObject prefers the last json fence, else the last balanced object", () => {
  assert.deepEqual(extractJsonObject('Draft: ```json\n{"a":1}\n```\nFinal:\n```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(extractJsonObject('I checked {braces} in src. Result: {"verdict":"pass","note":"a } in a string"} done'), { verdict: "pass", note: "a } in a string" })
  assert.deepEqual(extractJsonObject('{"first":true} then {"second":true}'), { second: true })
  assert.throws(() => extractJsonObject("no json here"), /no ```json block/)
  assert.throws(() => extractJsonObject("```json\n{broken\n```"), /not valid JSON/)
})

test("parseVerdict reads a fenced verdict after prose that quotes braces", () => {
  const text = "I'm passing T005.\n\n- It throws `ApiError` with fields taken from `{ error }` and handles `{ status }`.\n\n```json\n{\"verdict\":\"pass\",\"reasons\":[],\"fixes\":[]}\n```"
  assert.deepEqual(parseVerdict(text), { verdict: "pass", reasons: [], fixes: [] })
})

test("parseVerdict validates the shape and fails loudly", () => {
  assert.deepEqual(parseVerdict('Looks fine {mostly}.\n```json\n{"verdict":"pass","reasons":[],"fixes":[]}\n```'), { verdict: "pass", reasons: [], fixes: [] })
  assert.deepEqual(parseVerdict('{"verdict":"fail","reasons":["no test"],"fixes":["add one"]}').reasons, ["no test"])
  assert.throws(() => parseVerdict("LGTM"), /no ```json block/)
  assert.throws(() => parseVerdict('{"verdict":"ok"}'), /verdict must be/)
  assert.throws(() => parseVerdict('{"verdict":"fail","reasons":[]}'), /at least one reason/)
  assert.throws(() => parseVerdict('{"verdict":"pass","reasons":"none"}'), /arrays of strings/)
})

test("parseBlock reads the structured form and the old free text", () => {
  assert.deepEqual(parseBlock('BLOCKED: {"kind":"scope","needPaths":["src/router.ts"],"reason":"route registry"}'), { kind: "scope", needPaths: ["src/router.ts"], reason: "route registry" })
  assert.deepEqual(parseBlock("  BLOCKED: the contract has no /users endpoint"), { kind: "spec", needPaths: [], reason: "the contract has no /users endpoint" })
  assert.equal(parseBlock("Done. BLOCKED: nothing"), null)
})

test("decideReplan applies safe changes and sends risky ones to a human", () => {
  const tasks = [task("T001", { phase: "foundation", allowedPaths: ["package.json", "src/app/**"] }), task("T002"), task("T003", { dependsOn: ["T002"] })]

  const rebind = decideReplan(tasks, "T002", parseReplanAction('```json\n{"action":"rebind","allowedPaths":["src/t002/**","src/shared/x.ts"]}\n```'))
  assert.equal(rebind.kind, "apply")
  assert.deepEqual(rebind.kind === "apply" && rebind.tasks[1].allowedPaths, ["src/t002/**", "src/shared/x.ts"])

  const owned = decideReplan(tasks, "T002", { action: "rebind", allowedPaths: ["src/t003/**"] })
  assert.equal(owned.kind, "human")
  assert.match(owned.kind === "human" ? owned.reason : "", /owned by T003/)
  const freed = decideReplan(tasks, "T002", { action: "rebind", allowedPaths: ["src/t003/**"] }, new Set(["T003"]))
  assert.equal(freed.kind, "apply")
  const mergedManifest = decideReplan(tasks, "T002", { action: "rebind", allowedPaths: ["package.json"] }, new Set(["T001"]))
  assert.match(mergedManifest.kind === "human" ? mergedManifest.reason : "", /shared foundation file/)
  const manifest = decideReplan(tasks, "T002", { action: "rebind", allowedPaths: ["package.json"] })
  assert.match(manifest.kind === "human" ? manifest.reason : "", /shared foundation file/)

  const prereq = decideReplan(tasks, "T002", { action: "prereq", task: task("T002a") })
  assert.equal(prereq.kind, "apply")
  if (prereq.kind === "apply") {
    assert.deepEqual(prereq.tasks.map((entry) => entry.id), ["T001", "T002a", "T002", "T003"])
    assert.deepEqual(prereq.tasks[2].dependsOn, ["T002a"])
  }

  const split = decideReplan(tasks, "T002", { action: "split", tasks: [task("T002a", { allowedPaths: ["src/t002/a/**"] }), task("T002b", { allowedPaths: ["src/t002/b/**"], dependsOn: ["T002a"] })] })
  assert.equal(split.kind, "apply")
  if (split.kind === "apply") {
    assert.ok(!split.tasks.some((entry) => entry.id === "T002"))
    assert.deepEqual(split.tasks.find((entry) => entry.id === "T003")?.dependsOn, ["T002a", "T002b"])
  }

  assert.equal(decideReplan(tasks, "T002", { action: "escalate", reason: "spec conflict" }).kind, "human")
  assert.throws(() => decideReplan(tasks, "T002", { action: "prereq", task: task("T003") }), /already exists/)
  assert.throws(() => decideReplan(tasks, "T002", { action: "prereq", task: task("T002a", { verify: "" }) }), /verify command is required/)
  assert.throws(() => parseReplanAction('{"action":"shrug"}'), /action must be/)
})

test("normalizeFailure ignores timestamps, durations, and temp paths", () => {
  const first = "2026-09-24T10:00:01.123Z FAIL /tmp/agent-x1/a.test.ts after 1.2s (35 ms)"
  const second = "2026-09-24T11:22:33.000Z FAIL /tmp/agent-y2/a.test.ts after 3.4s (12 ms)"
  assert.equal(normalizeFailure(first), normalizeFailure(second))
  assert.notEqual(normalizeFailure("expected 1"), normalizeFailure("expected 2"))
})

test("the Claude runner scopes edit and write to the task's paths", () => {
  assert.deepEqual(toClaudeTools(["read", "edit", "write", "bash:npm"], ["src/auth/**", "./package.json"]), [
    "Read",
    "Glob",
    "Grep",
    "Edit(./src/auth/**)",
    "Edit(./package.json)",
    "Write(./src/auth/**)",
    "Write(./package.json)",
    "Bash(npm:*)",
  ])
  assert.deepEqual(toClaudeTools(["edit", "write"]), ["Edit", "Write"])
})

test("workerPrompt carries the previous failure and diff", () => {
  const prompt = workerPrompt({ task: task("T001"), previous: { reason: "reviewer rejected: no test", diff: "diff --git a/x b/x" } })
  assert.match(prompt, /do not start over/)
  assert.match(prompt, /reviewer rejected: no test/)
  assert.match(prompt, /```diff\ndiff --git a\/x b\/x\n```/)
  assert.doesNotMatch(workerPrompt({ task: task("T001"), previous: null }), /Previous attempt/)
})

type Reply = string | ((job: AgentJob, workdir: string) => string)

// Scripted harness: each role answers from its own queue; the last reply repeats.
function stubHarness(replies: Partial<Record<string, Reply[]>>) {
  const jobs: AgentJob[] = []
  const harness = {
    async run(_role: unknown, job: AgentJob, executor: { workdir: string }): Promise<HarnessOutcome> {
      jobs.push(job)
      const queue = replies[job.subject.startsWith("replan-") ? "replanner" : job.role] ?? ["ok"]
      const reply = queue.length > 1 ? queue.shift()! : queue[0]
      const summary = typeof reply === "function" ? reply(job, executor.workdir) : reply
      return { result: { status: "done", summary, costUsd: null, durationMs: 1, exitCode: 0, diagnostics: "" }, candidate: { runner: "claude", model: "stub" }, failureClass: null }
    },
  }
  return { harness: harness as unknown as Harness, jobs }
}

function writeFile(workdir: string, path: string, content = "export {}\n"): void {
  mkdirSync(join(workdir, path, ".."), { recursive: true })
  writeFileSync(join(workdir, path), content)
}

const pass = '```json\n{"verdict":"pass","reasons":[],"fixes":[]}\n```'

function setupProject(name: string, tasks: Task[]) {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  writeFileSync(join(projectDir, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`)
  commitAll(projectDir, "plan")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  config.harness.isolation = "none"
  config.qa.enabled = false
  config.deploy.enabled = false
  config.publish.github.enabled = false
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  for (const phase of planningPhases) store.setPhase(phase, "approved")
  const run = (harness: Harness) => runPipeline({ projectDir, config, store, harness, github: createGitHub({ projectDir, config, store }), signal: new AbortController().signal })
  return { projectDir, store, run }
}

function readEvents(projectDir: string, type: string): string[] {
  const db = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
  try {
    return (db.prepare("SELECT message FROM events WHERE type = ?").all(type) as { message: string }[]).map((row) => row.message)
  } finally {
    db.close()
  }
}

function mainTasks(projectDir: string): Task[] {
  return JSON.parse(execFileSync("git", ["show", "main:tasks.json"], { cwd: projectDir, encoding: "utf8" }))
}

test("a scope block is replanned by rebinding, then the task merges", async () => {
  const { projectDir, store, run } = setupProject("rebind", [task("T001")])
  const { harness, jobs } = stubHarness({
    worker: [
      'BLOCKED: {"kind":"scope","needPaths":["src/extra/x.ts"],"reason":"needs src/extra"}',
      (_job, workdir) => {
        writeFile(workdir, "src/extra/x.ts")
        return "done"
      },
    ],
    replanner: ['Widen it.\n```json\n{"action":"rebind","allowedPaths":["src/t001/**","src/extra/**"]}\n```'],
    reviewer: [pass],
  })
  assert.equal(await run(harness), "completed")
  assert.deepEqual(mainTasks(projectDir)[0].allowedPaths, ["src/t001/**", "src/extra/**"])
  const row = store.task("T001")
  assert.equal(row.status, "merged")
  assert.equal(row.replans, 1)
  assert.equal(row.attempts, 1, "attempts restart after a replan")
  const replanJob = jobs.find((job) => job.subject.startsWith("replan-"))!
  assert.equal(replanJob.role, "planner")
  assert.match(replanJob.systemPrompt, /called back because a worker could not finish/)
  assert.match(replanJob.taskPrompt, /git ls-files/)
  assert.deepEqual(jobs.filter((job) => job.role === "worker").at(-1)?.writablePaths, ["src/t001/**", "src/extra/**"])
})

test("a replan that touches an unfinished task's files stops for a human", async () => {
  const { store, run } = setupProject("human", [task("T001", { phase: "foundation" }), task("T002", { dependsOn: ["T001"] }), task("T003", { dependsOn: ["T002"] })])
  const { harness } = stubHarness({
    worker: [
      (job, workdir) => {
        if (job.subject.startsWith("T002")) return 'BLOCKED: {"kind":"scope","needPaths":["src/t003/a.ts"],"reason":"shared helper"}'
        writeFile(workdir, "src/t001/a.ts")
        return "done"
      },
    ],
    replanner: ['```json\n{"action":"rebind","allowedPaths":["src/t002/**","src/t003/**"]}\n```'],
    reviewer: [pass],
  })
  assert.equal(await run(harness), "awaiting_approval")
  const row = store.task("T002")
  assert.equal(row.status, "blocked")
  assert.match(row.humanReason ?? "", /owned by T003/)
  assert.equal(await run(stubHarness({}).harness), "awaiting_approval", "a resumed run stops at the same decision")
})

test("a third attempt still sees the first rejection", async () => {
  const { run } = setupProject("earlier-reasons", [task("T001")])
  const { harness, jobs } = stubHarness({
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/a.ts")
        return "done"
      },
    ],
    reviewer: [
      '```json\n{"verdict":"fail","reasons":["missing node environment docblock"],"fixes":["add it"]}\n```',
      '```json\n{"verdict":"fail","reasons":["port logic untested"],"fixes":["test it"]}\n```',
      pass,
    ],
  })
  assert.equal(await run(harness), "completed")
  const thirdWorker = jobs.filter((job) => job.role === "worker")[2]
  assert.match(thirdWorker.taskPrompt, /port logic untested/)
  assert.match(thirdWorker.taskPrompt, /Earlier attempts were rejected[\s\S]*Attempt 1:[\s\S]*missing node environment docblock/)
})

test("flaky verify, a reviewer without JSON, and a retry that gets the previous diff", async () => {
  const flag = join(scratch, "flaky-flag")
  const { projectDir, store, run } = setupProject("retry", [task("T001", { verify: `if [ -f ${flag} ]; then exit 0; fi; touch ${flag}; exit 1` })])
  const { harness, jobs } = stubHarness({
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/a.ts", "export const first = 1\n")
        return "done"
      },
    ],
    reviewer: ['```json\n{"verdict":"fail","reasons":["no test"],"fixes":["add a test"]}\n```', "Looks good to me.", pass],
  })
  assert.equal(await run(harness), "completed")
  assert.equal(store.task("T001").attempts, 2)
  assert.ok(existsSync(join(projectDir, ".agent-team", "attempts", "T001-1.diff")))
  assert.match(readFileSync(join(projectDir, ".agent-team", "attempts", "T001-1.diff"), "utf8"), /^# Attempt 1 of T001 was rejected\.[\s\S]*export const first/)
  const secondWorker = jobs.filter((job) => job.role === "worker")[1]
  assert.match(secondWorker.taskPrompt, /no test/)
  assert.match(secondWorker.taskPrompt, /\+export const first = 1/)
  assert.equal(jobs.filter((job) => job.role === "reviewer").length, 3, "the reviewer is asked again once after an answer without JSON")
  assert.equal(readEvents(projectDir, "flaky").length, 1)
})

test("the same failure twice goes to the replanner, which may escalate", async () => {
  const { store, run } = setupProject("repeat", [task("T001")])
  const { harness, jobs } = stubHarness({
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/a.ts")
        return "done"
      },
    ],
    reviewer: ['```json\n{"verdict":"fail","reasons":["wrong status code"],"fixes":["return 404"]}\n```'],
    replanner: ['```json\n{"action":"escalate","reason":"the contract and the story disagree"}\n```'],
  })
  assert.equal(await run(harness), "awaiting_approval")
  assert.equal(jobs.filter((job) => job.role === "worker").length, 2, "stops after two identical failures, not three")
  assert.match(store.task("T001").humanReason ?? "", /escalated: the contract and the story disagree/)
})

test("classifyFailure spots a worker that spent its whole budget", () => {
  const result = { status: "failed" as const, summary: "", costUsd: 2, tokens: null, durationMs: 1, exitCode: 1, diagnostics: "Reached maximum budget ($2)\n" }
  assert.equal(classifyFailure(result), "budget")
})

test("a worker out of budget waits for approval, then resumes from its diff with double the budget", async () => {
  const { projectDir, store, run } = setupProject("budget", [task("T001")])
  const { harness: reviewers } = stubHarness({ reviewer: [pass] })
  const workerJobs: AgentJob[] = []
  const harness = {
    async run(role: unknown, job: AgentJob, executor: { workdir: string }): Promise<HarnessOutcome> {
      if (job.role !== "worker") return reviewers.run(role as never, job, executor as never)
      workerJobs.push(job)
      writeFile(executor.workdir, "src/t001/a.ts", `export const attempt = ${workerJobs.length}\n`)
      if (workerJobs.length === 1) {
        return { result: { status: "failed", summary: "", costUsd: 2, tokens: null, durationMs: 1, exitCode: 1, diagnostics: "Reached maximum budget ($2)" }, candidate: { runner: "claude", model: "stub" }, failureClass: "budget" }
      }
      return { result: { status: "done", summary: "done", costUsd: null, tokens: null, durationMs: 1, exitCode: 0, diagnostics: "" }, candidate: { runner: "claude", model: "stub" }, failureClass: null }
    },
  } as unknown as Harness

  assert.equal(await run(harness), "awaiting_approval")
  const stopped = store.task("T001")
  assert.equal(stopped.status, "blocked")
  assert.equal(stopped.attempts, 0, "running out of budget does not use up an attempt")
  assert.match(stopped.humanReason ?? "", /reached its \$2\.00 budget/)
  assert.throws(() => approveTaskBudget(store, "T002"), /unknown task/)

  assert.equal(approveTaskBudget(store, "T001"), 4)
  assert.throws(() => approveTaskBudget(store, "T001"), /not waiting for a budget approval/)
  assert.equal(await run(harness), "completed")
  assert.equal(workerJobs[1].budgetUsd, 4)
  assert.match(workerJobs[1].taskPrompt, /\+export const attempt = 1/)
  assert.equal(store.task("T001").status, "merged")
  assert.ok(existsSync(join(projectDir, ".agent-team", "attempts", "T001-0.diff")))
})

test("pathsOverlap flags patterns that can match the same file", () => {
  assert.equal(pathsOverlap(["src/a/**"], ["src/b/**"]), false)
  assert.equal(pathsOverlap(["src/**"], ["src/b/x.ts"]), true)
  assert.equal(pathsOverlap(["src/a/**"], ["src/a/x.ts"]), true)
  assert.equal(pathsOverlap(["package.json"], ["package-lock.json"]), false)
  assert.equal(pathsOverlap(["package.json"], ["package.json"]), true)
  assert.equal(pathsOverlap(["src/*.ts"], ["src/**/*.css"]), true)
})
