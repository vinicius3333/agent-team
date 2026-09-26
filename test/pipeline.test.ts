import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { loadConfig, planningPhases } from "../src/config.ts"
import { commitAll } from "../src/git.ts"
import { createGitHub } from "../src/github.ts"
import type { AgentJob, Harness, HarnessOutcome } from "../src/harness/harness.ts"
import { runPipeline } from "../src/pipeline.ts"
import { createProject } from "../src/project.ts"
import { openStore } from "../src/store.ts"
import type { Task } from "../src/tasks.ts"

// autonomy.decide: auto. The default (human) paths are covered in task-loop.test.ts.

const scratch = mkdtempSync(join(tmpdir(), "agent-team-decide-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const pass = '```json\n{"verdict":"pass","reasons":[],"fixes":[]}\n```'

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id.toLowerCase()}/**`], readPaths: [], acceptance: ["works"], verify: "true", ...overrides }
}

function writeFile(workdir: string, path: string): void {
  mkdirSync(join(workdir, path, ".."), { recursive: true })
  writeFileSync(join(workdir, path), "export {}\n")
}

function setupProject(name: string, tasks: Task[], yaml: (text: string) => string = (text) => text) {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  const yamlPath = join(projectDir, "pipeline.yaml")
  writeFileSync(yamlPath, yaml(readFileSync(yamlPath, "utf8").replace("autoApproveScope: false", "autoApproveScope: false\n  decide: auto")))
  writeFileSync(join(projectDir, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`)
  commitAll(projectDir, "plan")
  const config = loadConfig(yamlPath)
  config.harness.isolation = "none"
  config.qa.enabled = false
  config.deploy.enabled = false
  config.publish.github.enabled = false
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  for (const phase of planningPhases) store.setPhase(phase, "approved")
  const issues: { id: string; reason: string }[] = []
  const github = createGitHub({ projectDir, config, store })
  github.taskBlocked = (blocked, reason) => {
    issues.push({ id: blocked.id, reason })
  }
  const run = (harness: Harness) => runPipeline({ projectDir, config, store, harness, github, signal: new AbortController().signal })
  return { projectDir, store, run, issues }
}

function outcome(summary: string, failureClass: HarnessOutcome["failureClass"] = null): HarnessOutcome {
  const status = failureClass ? "failed" : "done"
  const diagnostics = failureClass === "budget" ? "Reached maximum budget" : ""
  return { result: { status, summary, costUsd: null, tokens: null, durationMs: 1, exitCode: failureClass ? 1 : 0, diagnostics }, candidate: { runner: "claude", model: "stub" }, failureClass } as HarnessOutcome
}

// Reviewers pass, T002 always merges, and T001 answers from its own script.
function harnessFor(t001: (job: AgentJob, workdir: string, count: number) => HarnessOutcome, replanner = "") {
  const jobs: AgentJob[] = []
  let count = 0
  const harness = {
    async run(_role: unknown, job: AgentJob, executor: { workdir: string }): Promise<HarnessOutcome> {
      jobs.push(job)
      if (job.subject.startsWith("replan-")) return outcome(replanner)
      if (job.role !== "worker") return outcome(pass)
      if (job.subject.startsWith("T001")) return t001(job, executor.workdir, ++count)
      writeFile(executor.workdir, "src/t002/a.ts")
      return outcome("done")
    },
  } as unknown as Harness
  return { harness, jobs }
}

function events(projectDir: string): string[] {
  const db = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
  try {
    return (db.prepare("SELECT message FROM events WHERE type = 'autonomy'").all() as { message: string }[]).map((row) => row.message)
  } finally {
    db.close()
  }
}

test("decide: auto approves a scope block past maxAutoApprovals, then skips a task that asks again for files it has", async () => {
  const { projectDir, store, run, issues } = setupProject("scope", [task("T001"), task("T002")])
  store.syncTasks(["T001", "T002"])
  store.setMeta("task.T001.autoApprovals", "2")
  const { harness } = harnessFor(
    () => outcome('BLOCKED: {"kind":"scope","needPaths":["src/extra/x.ts"],"reason":"needs src/extra"}'),
    '```json\n{"action":"escalate","reason":"a person should look"}\n```',
  )
  const result = await run(harness)
  assert.notEqual(result, "awaiting_approval")
  const tasks = JSON.parse(readFileSync(join(projectDir, "tasks.json"), "utf8")) as Task[]
  assert.deepEqual(tasks.find((entry) => entry.id === "T001")?.allowedPaths, ["src/t001/**", "src/extra/x.ts"])
  assert.equal(store.meta("task.T001.autoApprovals"), "3", "the limit of 2 does not apply")
  const row = store.task("T001")
  assert.equal(row.status, "blocked")
  assert.equal(row.humanReason, null)
  assert.match(row.lastFailure ?? "", /asked again for files it already has/)
  assert.equal(store.task("T002").status, "merged", "the run goes on with other tasks")
  assert.deepEqual(issues.map((issue) => issue.id), ["T001"])
  const log = events(projectDir)
  assert.ok(log.some((message) => /T001: scope approved automatically \(src\/extra\/x\.ts\) because autonomy\.decide is auto/.test(message)))
  assert.ok(log.some((message) => /T001 skipped: it asked again for files it already has/.test(message)))
})

test("decide: auto raises a task budget by 50% once when the run budget allows, then skips it", async () => {
  const { projectDir, store, run, issues } = setupProject("budget", [task("T001"), task("T002")])
  const { harness, jobs } = harnessFor((_job, workdir) => {
    writeFile(workdir, "src/t001/a.ts")
    return outcome("", "budget")
  })
  const result = await run(harness)
  assert.notEqual(result, "awaiting_approval")
  const workers = jobs.filter((job) => job.role === "worker" && job.subject.startsWith("T001"))
  assert.deepEqual(workers.map((job) => job.budgetUsd), [2, 3])
  assert.equal(store.task("T001").status, "blocked")
  assert.equal(store.task("T001").humanReason, null)
  assert.equal(store.task("T002").status, "merged")
  assert.deepEqual(issues.map((issue) => issue.id), ["T001"])
  const log = events(projectDir)
  assert.ok(log.some((message) => /T001: budget raised from \$2\.00 to \$3\.00 because autonomy\.decide is auto/.test(message)))
  assert.ok(log.some((message) => /T001 skipped: its budget was already raised once/.test(message)))
})

test("decide: auto skips a task out of budget when the run budget cannot cover the raise", async () => {
  const { projectDir, store, run } = setupProject("budget-low", [task("T001"), task("T002")], (text) => text.replace(/runUsd: [\d.]+/, "runUsd: 2.5"))
  const { harness, jobs } = harnessFor(() => outcome("", "budget"))
  assert.notEqual(await run(harness), "awaiting_approval")
  assert.equal(jobs.filter((job) => job.role === "worker" && job.subject.startsWith("T001")).length, 1)
  assert.equal(store.task("T001").status, "blocked")
  assert.equal(store.task("T002").status, "merged")
  assert.ok(events(projectDir).some((message) => /T001 skipped: the run budget has \$2\.50 left, less than the \$3\.00 a raise needs/.test(message)))
})
