import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { loadConfig, planningPhases } from "../src/config.ts"
import { commitAll } from "../src/git.ts"
import { createGitHub } from "../src/github.ts"
import type { AgentJob, Harness, HarnessOutcome } from "../src/harness/harness.ts"
import { notificationFor } from "../src/notify/events.ts"
import { runPipeline, validateChangePlan } from "../src/pipeline.ts"
import { abandonChange, createProject, openChange } from "../src/project.ts"
import { openStore } from "../src/store.ts"
import type { Task } from "../src/tasks.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-change-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const pass = '```json\n{"verdict":"pass","reasons":[],"fixes":[]}\n```'
const qaPass = '```json\n{"verdict":"pass","findings":[],"tasks":[]}\n```'

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id.toLowerCase()}/**`], readPaths: [], acceptance: ["works"], verify: "true", ...overrides }
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function writeFile(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true })
  writeFileSync(join(dir, path), content)
}

type Reply = string | ((job: AgentJob, workdir: string) => string)

function stubHarness(replies: Partial<Record<string, Reply[]>>) {
  const jobs: AgentJob[] = []
  const harness = {
    async run(_role: unknown, job: AgentJob, executor: { workdir: string }): Promise<HarnessOutcome> {
      jobs.push(job)
      const queue = replies[job.role] ?? ["ok"]
      const reply = queue.length > 1 ? queue.shift()! : queue[0]
      const summary = typeof reply === "function" ? reply(job, executor.workdir) : reply
      return { result: { status: "done", summary, costUsd: null, tokens: null, durationMs: 1, exitCode: 0, diagnostics: "" }, candidate: { runner: "claude", model: "stub" }, failureClass: null }
    },
  }
  return { harness: harness as unknown as Harness, jobs }
}

const specHeadings = "# Notes\n\n## Problem\n\n## Users\n\n## User stories\n\n- US-01: write a note\n\n## Out of scope\n\n## Open questions\n"

// A finished first build: planning docs on main, T001 merged, every phase approved.
function completedProject(name: string) {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  writeFile(projectDir, "docs/spec.md", specHeadings)
  writeFile(projectDir, "docs/architecture.md", "# Architecture\n\n## Commands\n\n- test: true\n")
  writeFile(projectDir, "AGENTS.md", "# Agents\n\n## Commands\n\n- test: true\n")
  writeFile(projectDir, "src/t001/a.ts", "export const a = 1\n")
  writeFile(projectDir, "tasks.json", `${JSON.stringify([task("T001")], null, 2)}\n`)
  commitAll(projectDir, "first build")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  config.target = "api"
  config.harness.isolation = "none"
  config.deploy.enabled = false
  config.publish.github.enabled = false
  config.autonomy.gates = []
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  for (const phase of [...planningPhases, "qa", "deploy"]) store.setPhase(phase, "approved")
  store.syncTasks(["T001"])
  store.updateTask("T001", "merged")
  const run = (harness: Harness) => runPipeline({ projectDir, config, store, harness, github: createGitHub({ projectDir, config, store }), signal: new AbortController().signal })
  return { projectDir, store, config, run }
}

function events(projectDir: string, type: string): string[] {
  const db = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
  try {
    return (db.prepare("SELECT message FROM events WHERE type = ?").all(type) as { message: string }[]).map((row) => row.message)
  } finally {
    db.close()
  }
}

// Scripted agents that plan and build one new task, T002, for change C001.
function changeAgents(onWorker?: (workdir: string) => void) {
  return stubHarness({
    pm: [
      (_job, dir) => {
        writeFile(dir, "docs/changes/C001/spec.md", "## Change\n\nAdd tags.\n\n## New or changed user stories\n\n- US-02: tag a note\n\n## Out of scope\n\n## Open questions\n")
        writeFile(dir, "docs/spec.md", specHeadings.replace("- US-01: write a note", "- US-01: write a note\n- US-02: tag a note"))
        return "done"
      },
    ],
    architect: [
      (_job, dir) => {
        writeFile(dir, "docs/changes/C001/architecture.md", "## Changes\n\nA tags module.\n\n## New dependencies\n\nNone.\n\n## Data migrations\n\nNone.\n\n## Risks\n\nNone.\n")
        return "done"
      },
    ],
    planner: [
      (_job, dir) => {
        writeFile(dir, "docs/changes/C001/tasks.json", JSON.stringify([task("T002", { dependsOn: ["T001"], allowedPaths: ["src/t001/**", "src/t002/**"] })]))
        return "done"
      },
    ],
    worker: [
      (_job, dir) => {
        onWorker?.(dir)
        writeFile(dir, "src/t002/a.ts", "export const tags = []\n")
        return "done"
      },
    ],
    reviewer: [pass],
    qa: [qaPass],
  })
}

test("openChange resets the change phases, keeps merged tasks, archives phases, and creates the branch", () => {
  const { projectDir, store } = completedProject("open")
  const mainBefore = git(projectDir, ["rev-parse", "main"])
  const change = openChange(projectDir, store, "Add tags to notes\n\nTags are free text.")
  assert.equal(change.id, "C001")
  assert.equal(change.branch, "change/C001-add-tags-to-notes")
  assert.equal(change.baseCommit, mainBefore)
  assert.equal(store.meta("change.current"), "C001")
  for (const phase of ["spec", "architecture", "plan", "qa", "deploy"]) assert.equal(store.phaseStatus(phase), "pending", phase)
  for (const phase of ["branding", "design", "marketing"]) assert.equal(store.phaseStatus(phase), "approved", phase)
  assert.equal(store.task("T001").status, "merged")
  const db = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
  const archived = db.prepare("SELECT change_id AS changeId, name, status FROM phase_history ORDER BY name").all() as { changeId: string; status: string }[]
  db.close()
  assert.ok(archived.length >= 8)
  assert.ok(archived.every((row) => row.changeId === "" && row.status === "approved"))
  assert.equal(git(projectDir, ["rev-parse", "main"]), mainBefore, "main does not move")
  assert.equal(git(projectDir, ["show", `${change.branch}:docs/changes/C001/request.md`]), "Add tags to notes\n\nTags are free text.")
  assert.match(events(projectDir, "change")[0], /^opened change C001 on change\/C001-add-tags-to-notes: Add tags to notes$/)
  store.recordAttempt({ subject: "phase-spec-1", role: "pm", runner: "claude", model: "stub", status: "done", failureClass: null, costUsd: 0.5, tokens: null, durationMs: 1, transcriptPath: "x.log" })
  const costs = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
  assert.equal((costs.prepare("SELECT change_id AS changeId FROM attempts").get() as { changeId: string }).changeId, "C001", "attempts during a change carry its id")
  costs.close()
})

test("openChange refuses while a run is alive, a change is open, or the build is not complete", () => {
  const alive = completedProject("refuse-alive")
  alive.store.setMeta("run.pid", String(process.pid))
  assert.throws(() => openChange(alive.projectDir, alive.store, "x"), (error: any) => error.status === 409 && /run is in progress/.test(error.message))

  const open = completedProject("refuse-open")
  openChange(open.projectDir, open.store, "first")
  assert.throws(() => openChange(open.projectDir, open.store, "second"), (error: any) => error.status === 409 && /C001 is still open/.test(error.message))

  const unfinished = completedProject("refuse-unfinished")
  unfinished.store.setPhase("qa", "failed")
  assert.throws(() => openChange(unfinished.projectDir, unfinished.store, "x"), (error: any) => error.status === 409 && /Finish or fix the current run first/.test(error.message))

  assert.throws(() => openChange(unfinished.projectDir, unfinished.store, "  "), (error: any) => error.status === 400)
  assert.throws(() => openChange(unfinished.projectDir, unfinished.store, "x".repeat(4001)), (error: any) => error.status === 400)
})

test("the change plan rejects an existing id, an edited task, and a feature task on a foundation file", () => {
  const dir = join(scratch, "plan-checks")
  createProject(dir, "brief")
  writeFile(dir, "tasks.json", JSON.stringify([task("T001", { phase: "foundation", allowedPaths: ["package.json", "src/app/**"] })]))
  commitAll(dir, "plan")
  const merged = new Set(["T001"])
  const planWith = (tasks: unknown) => writeFile(dir, "docs/changes/C001/tasks.json", JSON.stringify(tasks))

  planWith([task("T001")])
  assert.throws(() => validateChangePlan(dir, "C001", merged), /T001 already exists/)

  planWith([task("T002", { allowedPaths: ["package.json"] })])
  assert.throws(() => validateChangePlan(dir, "C001", merged), /shared foundation file/)
  planWith([task("T002", { phase: "foundation", allowedPaths: ["package.json"] })])
  assert.equal(validateChangePlan(dir, "C001", merged).at(-1)?.change, "C001", "a foundation task may own package.json")

  planWith([task("T002", { allowedPaths: ["src/app/**"] })])
  assert.equal(validateChangePlan(dir, "C001", merged).length, 2, "a merged task's files are free")
  writeFile(dir, "tasks.json", JSON.stringify([task("T001", { title: "renamed" })]))
  assert.throws(() => validateChangePlan(dir, "C001", merged), /tasks.json was edited/)
})

test("a change builds only its new tasks on its branch, then merges into main once", async () => {
  const { projectDir, store, run } = completedProject("full")
  const change = openChange(projectDir, store, "Add tags")
  const mainBefore = git(projectDir, ["rev-parse", "main"])
  const mainDuringBuild: string[] = []
  const workerBases: string[] = []
  const { harness, jobs } = changeAgents((dir) => {
    mainDuringBuild.push(git(projectDir, ["rev-parse", "main"]))
    workerBases.push(git(dir, ["merge-base", "--is-ancestor", `${change.branch}`, "HEAD"]) === "" ? change.branch : "?")
  })
  assert.equal(await run(harness), "completed")

  const workers = jobs.filter((job) => job.role === "worker")
  assert.deepEqual(workers.map((job) => job.subject.split("-")[0]), ["T002"], "merged tasks do not rerun")
  assert.match(workers[0].taskPrompt, /docs\/changes\/C001\/request\.md/)
  assert.deepEqual(mainDuringBuild, [mainBefore], "main does not move during the change")
  assert.deepEqual(workerBases, [change.branch])
  assert.match(jobs.find((job) => job.role === "pm")!.taskPrompt, /^Change mode: change request C001/)
  assert.match(jobs.find((job) => job.role === "planner")!.taskPrompt, /## Code map/)
  assert.match(jobs.find((job) => job.role === "qa")!.taskPrompt, /On other routes, fail only on regressions/)

  const mainTasks = JSON.parse(git(projectDir, ["show", "main:tasks.json"])) as Task[]
  assert.deepEqual(mainTasks.map((entry) => [entry.id, entry.change ?? null]), [["T001", null], ["T002", "C001"]])
  assert.equal(git(projectDir, ["rev-list", "--parents", "-n", "1", "main"]).split(" ").length, 3, "the final merge is a merge commit")
  assert.equal(git(projectDir, ["log", "-1", "--format=%s", "main"]), "feat: Add tags")
  assert.equal(store.change("C001")?.status, "merged")
  assert.equal(store.meta("change.current"), "")
  assert.equal(store.task("T002").status, "merged")

  const changeEvents = events(projectDir, "change")
  const qaPassAt = events(projectDir, "qa").findIndex((message) => /pass$/.test(message))
  assert.ok(qaPassAt >= 0)
  assert.ok(changeEvents.some((message) => message === "merged change C001 into main"))
  assert.equal(store.phaseStatus("deploy"), "approved")
})

test("the change merges only after QA passes", async () => {
  const { projectDir, store, run } = completedProject("qa-first")
  openChange(projectDir, store, "Add tags")
  const scripted = changeAgents()
  const originalRun = scripted.harness.run.bind(scripted.harness)
  let mergedBeforeQa = false
  scripted.harness.run = async (role, job, executor) => {
    if (job.role === "qa") mergedBeforeQa = store.change("C001")?.status === "merged"
    return originalRun(role, job, executor)
  }
  assert.equal(await run(scripted.harness), "completed")
  assert.equal(mergedBeforeQa, false)
  assert.equal(store.change("C001")?.status, "merged")
})

test("a conflict with main stops the run for a person and names the files", async () => {
  const { projectDir, store, run } = completedProject("conflict")
  openChange(projectDir, store, "Add tags")
  writeFile(projectDir, "docs/spec.md", specHeadings.replace("- US-01: write a note", "- US-01: write a hotfixed note"))
  commitAll(projectDir, "fix: hotfix on main")
  const { harness } = changeAgents()
  assert.equal(await run(harness), "awaiting_approval")
  const stop = JSON.parse(store.meta("run.stop") ?? "{}")
  assert.match(stop.reason, /conflicts with main in docs\/spec\.md/)
  assert.equal(store.change("C001")?.status, "open")
  assert.equal(git(projectDir, ["log", "-1", "--format=%s", "main"]), "fix: hotfix on main", "main keeps only the hotfix")
})

test("an uncommitted pipeline.yaml on main does not block the final merge", async () => {
  const { projectDir, store, run } = completedProject("dirty-settings")
  openChange(projectDir, store, "Add tags")
  writeFileSync(join(projectDir, "pipeline.yaml"), `${readFileSync(join(projectDir, "pipeline.yaml"), "utf8")}# a hand edit\n`)
  const { harness } = changeAgents()
  assert.equal(await run(harness), "completed")
  assert.equal(store.change("C001")?.status, "merged")
  assert.match(git(projectDir, ["show", "main:pipeline.yaml"]), /# a hand edit/)
  assert.equal(git(projectDir, ["status", "--porcelain", "--", "pipeline.yaml"]), "")
})

test("a stray uncommitted edit on main is stashed so the final merge still runs", async () => {
  const { projectDir, store, run } = completedProject("dirty-source")
  openChange(projectDir, store, "Add tags")
  writeFile(projectDir, "src/t001/a.ts", "export const a = 2 // a stray edit\n")
  const { harness } = changeAgents((dir) => writeFile(dir, "src/t001/a.ts", "export const a = 3\n"))
  assert.equal(await run(harness), "completed")
  assert.equal(store.change("C001")?.status, "merged")
  assert.equal(git(projectDir, ["show", "main:src/t001/a.ts"]), "export const a = 3")
  assert.match(git(projectDir, ["stash", "list"]), /stray edits on main before merging C001/)
  assert.match(git(projectDir, ["stash", "show", "-p"]), /a stray edit/)
  assert.ok(events(projectDir, "change").some((message) => /stashed uncommitted edits on main before the merge \(src\/t001\/a\.ts\)/.test(message)))
})

test("abandon restores the phase rows and removes the change's tasks", () => {
  const { projectDir, store } = completedProject("abandon")
  const change = openChange(projectDir, store, "Add tags")
  const worktree = join(scratch, "abandon-branch")
  git(projectDir, ["worktree", "add", "-q", worktree, change.branch])
  writeFile(worktree, "tasks.json", JSON.stringify([task("T001"), task("T002", { change: "C001" }), task("Q101", { change: "C001" })]))
  commitAll(worktree, "plan the change")
  git(projectDir, ["worktree", "remove", "--force", worktree])
  store.syncTasks(["T002", "Q101"])
  abandonChange(projectDir, store, "C001")
  assert.equal(store.change("C001")?.status, "abandoned")
  assert.equal(store.meta("change.current"), "")
  for (const phase of ["spec", "architecture", "plan", "qa", "deploy"]) assert.equal(store.phaseStatus(phase), "approved", phase)
  assert.deepEqual(store.tasks().map((row) => row.id), ["T001"])
  assert.equal(openChange(projectDir, store, "Try again").id, "C002")
})

test("marketing does not run during a change, even without a marketing row", async () => {
  const { projectDir, store, config, run } = completedProject("marketing")
  config.target = "web"
  config.qa.enabled = false
  const db = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
  db.exec("DELETE FROM phases WHERE name = 'marketing'")
  db.close()
  openChange(projectDir, store, "Add tags")
  const { harness, jobs } = changeAgents()
  assert.equal(await run(harness), "completed")
  assert.ok(!jobs.some((job) => job.role === "marketer"))
  assert.ok(events(projectDir, "phase").includes("marketing skipped: a change request does not rerun marketing"))
})

test("a change with no new tasks merges its docs and skips build and QA", async () => {
  const { projectDir, store, run } = completedProject("docs-only")
  openChange(projectDir, store, "Reword the intro")
  const { harness, jobs } = stubHarness({
    pm: [(_job, dir) => (writeFile(dir, "docs/changes/C001/spec.md", "## Change\n\n## New or changed user stories\n\n## Out of scope\n\n## Open questions\n"), "done")],
    architect: [(_job, dir) => (writeFile(dir, "docs/changes/C001/architecture.md", "## Changes\n\n## New dependencies\n\n## Data migrations\n\n## Risks\n"), "done")],
    planner: [(_job, dir) => (writeFile(dir, "docs/changes/C001/tasks.json", "[]"), "done")],
  })
  assert.equal(await run(harness), "completed")
  assert.ok(!jobs.some((job) => job.role === "worker" || job.role === "qa"))
  assert.equal(store.change("C001")?.status, "merged")
  assert.equal(git(projectDir, ["show", "main:docs/changes/C001/tasks.json"]), "[]")
  assert.ok(events(projectDir, "change").some((message) => /has no new tasks/.test(message)))
})

test("manual changeMerge waits for approval before the merge", async () => {
  const { projectDir, store, config, run } = completedProject("manual")
  config.autonomy.changeMerge = "manual"
  openChange(projectDir, store, "Add tags")
  const { harness } = changeAgents()
  assert.equal(await run(harness), "awaiting_approval")
  assert.equal(store.change("C001")?.status, "open")
  assert.match(events(projectDir, "change").at(-1) ?? "", /^change C001 waits for a merge/)
  store.setMeta("change.C001.mergeApproved", "1")
  assert.equal(await run(stubHarness({}).harness), "completed")
  assert.equal(store.change("C001")?.status, "merged")
  assert.match(readFileSync(join(projectDir, "tasks.json"), "utf8"), /"change": "C001"/)
})

test("change events become notifications", () => {
  const event = (message: string) => ({ id: 1, at: "2026-09-24T00:00:00Z", type: "change", message })
  const context = { cooldowns: false, interrupted: false }
  assert.deepEqual(notificationFor(event("opened change C001 on change/C001-x: Add tags"), null, context), { kind: "change", severity: "info", reason: "opened change C001 on change/C001-x: Add tags", changeId: "C001" })
  assert.equal(notificationFor(event("merged change C002 into main"), null, context)?.changeId, "C002")
  assert.equal(notificationFor(event("change C003 waits for a merge: conflicts with main in a.ts"), null, context)?.severity, "action")
  assert.equal(notificationFor(event("C001 has no new tasks; merging its docs"), null, context), null)
})
