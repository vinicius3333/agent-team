import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { loadConfig, planningPhases } from "../src/config.ts"
import { commitAll } from "../src/git.ts"
import { createGitHub } from "../src/github.ts"
import type { AgentJob, Harness, HarnessOutcome } from "../src/harness/harness.ts"
import { codeMap, fillPrompt, keyFailureLines, reviewPrompt, runPipeline, workerPrompt, type PipelineContext, type RunStop } from "../src/pipeline.ts"
import { createProject } from "../src/project.ts"
import { qaContainerNames } from "../src/screenshots.ts"
import { diffFileHashes, flaggedFiles, reviewerMetrics } from "../src/reviews.ts"
import { faviconFiles } from "../src/favicon.ts"
import { smokeContainerNames, smokeFailures, smokeScreens, type SmokeCheck } from "../src/smoke.ts"
import { openStore, type Store } from "../src/store.ts"
import { validateTasks, type Task } from "../src/tasks.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-context-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id.toLowerCase()}/**`], readPaths: [], acceptance: ["works"], verify: "true", ...overrides }
}

const pass = '```json\n{"verdict":"pass","reasons":[],"fixes":[]}\n```'

type Reply = string | ((job: AgentJob, workdir: string) => string)

// Scripted harness: each role answers from its own queue; the last reply repeats. With a store, calls are recorded at costUsd.
function stubHarness(replies: Partial<Record<string, Reply[]>>, options: { store?: Store; costUsd?: number | null } = {}) {
  const jobs: AgentJob[] = []
  const harness = {
    async run(_role: unknown, job: AgentJob, executor: { workdir: string }): Promise<HarnessOutcome> {
      jobs.push(job)
      const queue = replies[job.role] ?? ["ok"]
      const reply = queue.length > 1 ? queue.shift()! : queue[0]
      const summary = typeof reply === "function" ? reply(job, executor.workdir) : reply
      const costUsd = options.costUsd ?? null
      options.store?.recordAttempt({ subject: job.subject, role: job.role, runner: "claude", model: "stub", status: "done", failureClass: null, costUsd, durationMs: 1, transcriptPath: "x.log" })
      return { result: { status: "done", summary, costUsd, durationMs: 1, exitCode: 0, diagnostics: "" }, candidate: { runner: "claude", model: "stub" }, failureClass: null }
    },
  }
  return { harness: harness as unknown as Harness, jobs }
}

function writeFile(workdir: string, path: string, content = "export {}\n"): void {
  mkdirSync(join(workdir, path, ".."), { recursive: true })
  writeFileSync(join(workdir, path), content)
}

function setupProject(name: string, tasks: Task[], files: Record<string, string> = {}) {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  writeFileSync(join(projectDir, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`)
  for (const [path, content] of Object.entries(files)) writeFile(projectDir, path, content)
  commitAll(projectDir, "plan")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  config.harness.isolation = "none"
  config.autonomy.gates = []
  config.qa.enabled = false
  config.deploy.enabled = false
  config.publish.github.enabled = false
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  for (const phase of planningPhases) store.setPhase(phase, "approved")
  const run = (harness: Harness, smokeCheck?: SmokeCheck, renderFavicons?: PipelineContext["renderFavicons"]) =>
    runPipeline({ projectDir, config, store, harness, github: createGitHub({ projectDir, config, store }), signal: new AbortController().signal, smokeCheck, renderFavicons })
  return { projectDir, config, store, run }
}

function readEvents(projectDir: string, type: string): string[] {
  const db = new DatabaseSync(join(projectDir, ".agent-team", "state.db"))
  try {
    return (db.prepare("SELECT message FROM events WHERE type = ?").all(type) as { message: string }[]).map((row) => row.message)
  } finally {
    db.close()
  }
}

function showMain(projectDir: string, path: string): string {
  return execFileSync("git", ["show", `main:${path}`], { cwd: projectDir, encoding: "utf8" })
}

test("codeMap draws a tree, skips lockfiles and assets, and caps its length", () => {
  const files = ["package.json", "package-lock.json", "src/app.tsx", "src/auth/login.ts", "src/auth/login.test.ts", "public/logo.png", "src/zeta.ts"]
  assert.deepEqual(codeMap(files), ["package.json", "src/", "  app.tsx", "  auth/", "    login.test.ts", "    login.ts", "  zeta.ts"])
  const many = Array.from({ length: 300 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`)
  const capped = codeMap(many)
  assert.equal(capped.length, 200)
  assert.equal(capped.at(-1), "[102 more lines not shown]")
})

test("workerPrompt adds the code map, dependency files, and the progress log", () => {
  const prompt = workerPrompt({
    task: task("T002", { dependsOn: ["T001"], readPaths: ["docs/spec.md"] }),
    previous: null,
    codeMap: ["src/", "  a.ts"],
    dependencyFiles: [{ taskId: "T001", files: ["src/t001/a.ts"] }],
    hasProgress: true,
  })
  assert.match(prompt, /"readPaths": \[\n\s+"docs\/progress\.md",\n\s+"docs\/spec\.md"/)
  assert.match(prompt, /Read docs\/progress\.md first/)
  assert.match(prompt, /- T001: src\/t001\/a\.ts/)
  assert.match(prompt, /## Code map[\s\S]*```\nsrc\/\n  a\.ts\n```/)
  assert.doesNotMatch(workerPrompt({ task: task("T001"), previous: null }), /progress|Code map/)
})

test("reviewPrompt restates the goal after the diff, and the writer fills the reviewer prompt", () => {
  const prompt = reviewPrompt({ task: task("T001", { acceptance: ["shows a list"] }), diff: "diff --git a/x b/x", verifyOutput: "ok", previousError: null, hasProgress: true, dependencyFiles: [] })
  const diffAt = prompt.indexOf("diff --git")
  assert.ok(prompt.indexOf("## Reminder: the goal of T001") > diffAt)
  assert.ok(prompt.lastIndexOf("- shows a list") > diffAt)
  assert.match(prompt, /docs\/progress\.md lists what earlier tasks built/)
  const system = fillPrompt(readFileSync(new URL("../prompts/reviewer.md", import.meta.url), "utf8"), { writer: "codex gpt-5.5" })
  assert.match(system, /The worker agent \(codex gpt-5\.5\) wrote the code/)
  assert.doesNotMatch(system, /A different model|\{\{/)
})

test("keyFailureLines keeps the npm error lines", () => {
  const output = ["> install", "added 3 packages", "npm error code E404", "npm error 404 Not Found - GET https://registry.npmjs.org/nope", "npm error A complete log is in /tmp/x.log", "done"].join("\n")
  assert.equal(keyFailureLines(output), ["npm error code E404", "npm error 404 Not Found - GET https://registry.npmjs.org/nope", "npm error A complete log is in /tmp/x.log"].join("\n"))
  assert.equal(keyFailureLines("a\nb\nc", 2), "b\nc")
})

test("validateTasks accepts ui and routes, and rejects bad ones", () => {
  assert.equal(validateTasks([task("T001", { ui: true, routes: ["/", "/settings?tab=a"] })]).length, 1)
  assert.throws(() => validateTasks([{ ...task("T001"), ui: "yes" }]), /ui must be true or false/)
  assert.throws(() => validateTasks([task("T001", { routes: ["/tasks/:id"] })]), /routes must be an array of paths/)
  assert.throws(() => validateTasks([task("T001", { routes: ["settings"] })]), /routes must be an array of paths/)
})

test("smoke containers never share names with QA or deploy containers", () => {
  const projectDir = join(scratch, "My App")
  const smoke = Object.values(smokeContainerNames(projectDir))
  const others = [...Object.values(qaContainerNames(projectDir)), "agent-team-app-my-app", "agent-team-tunnel-my-app", "agent-team-qa-1", "agent-team-smoke-1"]
  for (const name of smoke) {
    assert.match(name, /_/)
    assert.ok(!others.includes(name))
  }
  assert.equal(new Set(smoke).size, 3)
  assert.deepEqual(smokeScreens(task("T001", { routes: ["/", "/a-b", "/a/b"] })).map((screen) => screen.slug), ["01-root", "02-a-b", "03-a-b"])
  assert.deepEqual(smokeScreens(task("T001")).map((screen) => screen.route), ["/"])
})

test("smokeFailures reports HTTP errors, load errors, and console errors", () => {
  const route = { slug: "x", file: null, branding: null }
  const failures = smokeFailures({
    baseUrl: "http://app:3000",
    viewport: { width: 1440, height: 900 },
    startError: null,
    routes: [
      { ...route, route: "/", status: 200, consoleErrors: [], error: null },
      { ...route, route: "/missing", status: 404, consoleErrors: [], error: null },
      { ...route, route: "/slow", status: null, consoleErrors: [], error: "Timeout 30000ms exceeded" },
      { ...route, route: "/broken", status: 200, consoleErrors: ["TypeError: x is undefined"], error: null },
    ],
  })
  assert.deepEqual(failures, ["/missing answered HTTP 404", "/slow did not load: Timeout 30000ms exceeded", "/broken logged console errors:\n  - TypeError: x is undefined"])
})

test("reviewerMetrics counts fails the next attempt confirmed", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+a\ndiff --git a/src/b.ts b/src/b.ts\n+b\n"
  const hashes = diffFileHashes(diff)
  assert.deepEqual(Object.keys(hashes), ["src/a.ts", "src/b.ts"])
  assert.deepEqual(flaggedFiles(Object.keys(hashes), { reasons: ["src/b.ts has no test"], fixes: [] }), ["src/b.ts"])
  assert.deepEqual(flaggedFiles(Object.keys(hashes), { reasons: ["no tests"], fixes: [] }), ["src/a.ts", "src/b.ts"])
  const changedB = diffFileHashes("diff --git a/src/a.ts b/src/a.ts\n+a\ndiff --git a/src/b.ts b/src/b.ts\n+b fixed\n")
  const metrics = reviewerMetrics([
    { taskId: "T001", attempt: 1, verdict: "fail", flaggedFiles: ["src/b.ts"], fileHashes: hashes },
    { taskId: "T002", attempt: 1, verdict: "fail", flaggedFiles: ["src/a.ts"], fileHashes: hashes },
    { taskId: "T001", attempt: 2, verdict: "pass", flaggedFiles: [], fileHashes: changedB },
    { taskId: "T002", attempt: 2, verdict: "pass", flaggedFiles: [], fileHashes: changedB },
    { taskId: "T003", attempt: 1, verdict: "fail", flaggedFiles: ["src/a.ts"], fileHashes: hashes },
  ])
  assert.deepEqual(metrics, { reviews: 5, fails: 3, followedFails: 2, confirmedFails: 1 })
})

test("merged tasks feed the progress log, dependency files, the reviewer, and the UI smoke check", async () => {
  const agents = "# Agents\n\n## Commands\n\n- test: true\n"
  const { projectDir, store, run } = setupProject("progress", [task("T001", { phase: "foundation" }), task("T002", { dependsOn: ["T001"], ui: true, routes: ["/items"] })], { "AGENTS.md": agents })
  const smokeCalls: string[] = []
  const smoke: SmokeCheck = async ({ task: smoked, attempt, worktree }) => {
    smokeCalls.push(`${smoked.id}-${attempt}`)
    assert.ok(worktree.includes(".agent-team/worktrees/"))
    return attempt === 1 && smoked.id === "T002" ? { kind: "failed", reason: "/items logged console errors:\n  - TypeError: boom" } : { kind: "passed", routes: 1 }
  }
  const { harness, jobs } = stubHarness({
    worker: [
      (job, workdir) => {
        const id = job.subject.split("-")[0]
        writeFile(workdir, `src/${id.toLowerCase()}/index.ts`)
        // next dev adds its own rules to AGENTS.md when a worker runs the app by hand.
        if (job.subject === "T002-worker-1") {
          writeFile(workdir, "AGENTS.md", `${agents}<!-- BEGIN:nextjs-agent-rules -->\n<!-- END:nextjs-agent-rules -->\n`)
          writeFile(workdir, "CLAUDE.md", "# hacked\n")
        }
        return `Built ${id}.\nLine two.\nLine three.\nLine four is cut.`
      },
    ],
    reviewer: [pass],
  })
  assert.equal(await run(harness, smoke), "completed")

  const progress = showMain(projectDir, "docs/progress.md")
  assert.match(progress, /^# Progress/)
  assert.match(progress, /## T001: task T001\n\nFiles: `src\/t001\/index\.ts`\n\n> Built T001\.\n> Line two\.\n> Line three\.\n/)
  assert.match(progress, /## T002: task T002/)
  assert.doesNotMatch(progress, /Line four/)

  const workers = jobs.filter((job) => job.role === "worker")
  assert.equal(workers.length, 3, "T001 once; T002 fails on the smoke check, then passes")
  assert.doesNotMatch(workers[0].taskPrompt, /docs\/progress\.md/)
  assert.match(workers[1].taskPrompt, /- T001: src\/t001\/index\.ts/)
  assert.match(workers[1].taskPrompt, /"docs\/progress\.md"/)
  assert.match(workers[1].taskPrompt, /## Code map[\s\S]*docs\/\n  progress\.md/)
  assert.match(workers[2].taskPrompt, /UI smoke check failed:\n\/items logged console errors/)
  assert.doesNotMatch(workers[2].taskPrompt, /nextjs-agent-rules|# hacked/, "files only the orchestrator writes are restored before the diff")
  assert.deepEqual(smokeCalls, ["T002-1", "T002-2"], "the smoke check runs after verify, only for ui tasks")
  assert.ok(readEvents(projectDir, "smoke").some((message) => /T002 attempt 1: UI smoke check failed/.test(message)))
  assert.ok(readEvents(projectDir, "task").some((message) => /T002 attempt 1: restored files that only the orchestrator writes: AGENTS\.md, CLAUDE\.md/.test(message)))
  assert.equal(store.task("T002").attempts, 2)
  assert.equal(showMain(projectDir, "AGENTS.md"), agents)

  const reviewers = jobs.filter((job) => job.role === "reviewer")
  assert.match(reviewers[0].systemPrompt, /The worker agent \(claude stub\) wrote the code/)
  assert.match(reviewers.at(-1)!.taskPrompt, /- T001: src\/t001\/index\.ts/)
  assert.deepEqual(store.taskFiles("T002"), ["src/t002/index.ts"])
})

test("the architect writes AGENTS.md and the harness adds CLAUDE.md", async () => {
  const { projectDir, store, run } = setupProject("agents", [task("T001")])
  store.setPhase("architecture", "pending")
  const architecture = "# Architecture\n\n## Commands\n\n- install: npm ci\n- test: npm test\n- dev: npm run dev\n"
  const { harness, jobs } = stubHarness({
    architect: [
      (_job, workdir) => {
        writeFile(workdir, "docs/architecture.md", architecture)
        writeFile(workdir, "AGENTS.md", "Read docs/progress.md first.\n\n## Layout\n")
        return "done"
      },
      (_job, workdir) => {
        writeFile(workdir, "docs/architecture.md", architecture)
        writeFile(workdir, "AGENTS.md", "Read docs/progress.md first.\n\n## Commands\n\n- test: npm test\n")
        return "done"
      },
    ],
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/a.ts")
        return "done"
      },
    ],
    reviewer: [pass],
  })
  assert.equal(await run(harness), "completed")
  assert.equal(jobs.filter((job) => job.role === "architect").length, 2)
  assert.match(jobs.filter((job) => job.role === "architect")[1].taskPrompt, /AGENTS\.md is missing headings: ## Commands/)
  assert.equal(showMain(projectDir, "CLAUDE.md"), "@AGENTS.md\n")
  assert.match(showMain(projectDir, "AGENTS.md"), /## Commands/)
})

test("a failed workspace setup pauses with the key npm lines on the detail API", async (t) => {
  const { projectDir, run } = setupProject("setup-fails", [task("T001")], { "package.json": "{ not json" })
  assert.equal(await run(stubHarness({}).harness), "paused")
  const server = startUi({ runsDir: scratch, port: 0, startRun: () => {} })
  await once(server, "listening")
  t.after(() => server.close())
  const detail = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/setup-fails`)).json()
  assert.equal(detail.stop.outcome, "paused")
  assert.equal(detail.stop.kind, "other")
  assert.match(detail.stop.reason, /^T001 paused: workspace setup failed \(npm install --no-audit --no-fund\):/)
  assert.match(detail.stop.reason, /npm error/)
  assert.ok(projectDir)
})

test("the run budget stops the run for approval, and the dashboard raises it", async (t) => {
  const { projectDir, config, store, run } = setupProject("budget", [task("T001"), task("T002")])
  const pipelinePath = join(projectDir, "pipeline.yaml")
  writeFileSync(pipelinePath, readFileSync(pipelinePath, "utf8").replace(/runUsd: [\d.]+/, "runUsd: 1"))
  config.parallelTasks = 1
  const recorder = stubHarness(
    {
      worker: [
        (job, workdir) => {
          writeFile(workdir, `src/${job.subject.split("-")[0].toLowerCase()}/a.ts`)
          return "done"
        },
      ],
      reviewer: [pass],
    },
    { store, costUsd: 0.6 },
  )
  store.recordAttempt({ subject: "old", role: "pm", runner: "codex", model: "x", status: "done", failureClass: null, costUsd: null, durationMs: 1, transcriptPath: "x.log" })
  assert.equal(await run(recorder.harness), "awaiting_approval")
  assert.equal(recorder.jobs.length, 2, "worker and reviewer for T001, then the budget stops T002's worker")
  assert.equal(store.task("T001").status, "merged")
  assert.equal(store.task("T002").attempts, 0, "the stopped attempt is not counted")
  const [event] = readEvents(projectDir, "budget")
  assert.match(event, /\$1\.20 reported of \$1\.00.*1 calls \(codex\) reported no cost/)
  const stop = JSON.parse(store.meta("run.stop")!) as RunStop
  assert.equal(stop.kind, "budget")
  assert.equal(stop.outcome, "awaiting_approval")

  const started: string[] = []
  const server = startUi({ runsDir: scratch, port: 0, startRun: (dir) => void started.push(dir) })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (headers: Record<string, string>, body = "{}") => fetch(`${base}/api/projects/budget/raise-budget`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
  assert.equal((await post({})).status, 403)
  assert.equal((await post({ "x-agent-team": "1" }, "x".repeat(70 * 1024))).status, 413)
  const detail = await (await fetch(`${base}/api/projects/budget`)).json()
  assert.equal(detail.stop.kind, "budget")
  assert.deepEqual(detail.budget, { runUsd: 1, spentUsd: 1.2, spentTokens: 0, unreportedCalls: 1 })
  assert.deepEqual(detail.reviewer, { reviews: 1, fails: 0, followedFails: 0, confirmedFails: 0 })

  store.setMeta("run.pid", String(process.pid))
  const raisedLive = await post({ "x-agent-team": "1" })
  assert.equal(raisedLive.status, 200, "a live run picks up the new budget before its next agent call")
  assert.deepEqual(await raisedLive.json(), { runUsd: 1.5, started: false })
  assert.deepEqual(started, [])
  store.setMeta("run.pid", "")
  const raised = await post({ "x-agent-team": "1" })
  assert.deepEqual(await raised.json(), { runUsd: 2.25, started: true })
  assert.deepEqual(started, [projectDir])
  const yaml = readFileSync(pipelinePath, "utf8")
  assert.match(yaml, /runUsd: 2.25/)
  assert.match(yaml, /# web \| api \| web\+api/, "comments survive")
  assert.equal(loadConfig(pipelinePath).budget.runUsd, 2.25)
})

function gitLog(projectDir: string): string[] {
  return execFileSync("git", ["log", "--format=%s", "main"], { cwd: projectDir, encoding: "utf8" }).trim().split("\n")
}

test("a worker's commit plan lands as atomic commits, with the progress entry in the last one", async () => {
  const { projectDir, run } = setupProject("commits", [task("T001")])
  const { harness } = stubHarness({
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/store.ts")
        writeFile(workdir, "src/t001/store.test.ts")
        writeFile(workdir, "src/t001/view.ts")
        writeFile(workdir, "src/t001/extra.ts")
        const plan = { commits: [{ message: "feat(t001): add the store", files: ["src/t001/store.ts", "src/t001/store.test.ts"] }, { message: "feat(t001): add the view", files: ["src/t001/view.ts"] }] }
        return `Built it.\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``
      },
    ],
    reviewer: [pass],
  })
  assert.equal(await run(harness), "completed")
  const [last, second, first] = gitLog(projectDir)
  assert.deepEqual([first, second, last], ["feat(t001): add the store", "feat(t001): add the view", "feat(T001): task T001"])
  const lastFiles = execFileSync("git", ["show", "--name-only", "--format=", "main"], { cwd: projectDir, encoding: "utf8" }).trim().split("\n").sort()
  assert.deepEqual(lastFiles, ["docs/progress.md", "src/t001/extra.ts"])
})

test("a bad commit plan falls back to one commit", async () => {
  const { projectDir, run } = setupProject("bad-commits", [task("T001")])
  const { harness } = stubHarness({
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/a.ts")
        return '```json\n{"commits":[{"message":"added stuff","files":["src/t001/a.ts"]}]}\n```'
      },
    ],
    reviewer: [pass],
  })
  assert.equal(await run(harness), "completed")
  assert.equal(gitLog(projectDir)[0], "feat(T001): task T001")
  assert.ok(readEvents(projectDir, "task").some((message) => /commit plan ignored/.test(message)))
})

test("UI tasks get a design review of the smoke screenshots, and a rejection fails the attempt", async () => {
  const { projectDir, run } = setupProject("ui-review", [task("T001", { ui: true, routes: ["/items"] })], { "docs/design.md": "## Items\nRoute: /items\nBranding: 02-items.png\n" })
  const smoke: SmokeCheck = async ({ attempt }) => {
    const outDir = join(projectDir, ".agent-team", "smoke", `T001-${attempt}`)
    mkdirSync(outDir, { recursive: true })
    const report = {
      baseUrl: "http://app:3000",
      viewport: { width: 1440, height: 900 },
      mobileViewport: { width: 390, height: 664 },
      startError: null,
      routes: [{ route: "/items", slug: "01-items", file: "01-items.png", status: 200, consoleErrors: [], error: null, branding: null, mobileBranding: null, mobile: { file: "01-items.mobile.png", status: 200, consoleErrors: [], error: null, layout: { horizontalOverflow: 0, overflowing: [], smallTargets: [], tightTargets: ['button "Add" is 80x32'] } } }],
    }
    writeFileSync(join(outDir, "report.json"), JSON.stringify(report))
    writeFileSync(join(outDir, "01-items.png"), "")
    return { kind: "passed", routes: 1, outDir }
  }
  const seen: boolean[] = []
  const { harness, jobs } = stubHarness({
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/items.tsx")
        return "done"
      },
    ],
    reviewer: [pass],
    "design-reviewer": [
      (_job, workdir) => {
        seen.push(existsSync(join(workdir, ".agent-team/ui-review/T001-1/01-items.png")))
        return '```json\n{"verdict":"fail","reasons":["Add button is 32px tall"],"fixes":["Make the Add button 44px tall in src/t001/items.tsx"]}\n```'
      },
      pass,
    ],
  })
  assert.equal(await run(harness, smoke), "completed")
  assert.deepEqual(seen, [true], "the screenshots are copied into the worktree for the reviewer")
  const reviews = jobs.filter((job) => job.role === "design-reviewer")
  assert.equal(reviews.length, 2)
  assert.match(reviews[0].systemPrompt, /desktop and on a phone/)
  assert.match(reviews[0].taskPrompt, /mobile \.agent-team\/ui-review\/T001-1\/01-items\.mobile\.png; branding design\/branding\/02-items\.png/)
  assert.match(reviews[0].taskPrompt, /Tap targets under 44px on mobile: button "Add" is 80x32/)
  const workers = jobs.filter((job) => job.role === "worker")
  assert.match(workers[1].taskPrompt, /the design reviewer rejected the screens[\s\S]*44px tall/)
  assert.doesNotMatch(execFileSync("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: projectDir, encoding: "utf8" }), /ui-review/)
})

test("the design phase runs in two steps, renders the favicon, fixes a rejection, and lands one commit per group", async () => {
  const { projectDir, store, run } = setupProject("design-phase", [task("T001")])
  store.setPhase("design", "pending")
  store.setPhase("plan", "pending")
  const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${fill}"/></svg>\n`
  const headings = ["## Principles", "## Color", "## Typography", "## Spacing and radius", "## Components", "## Icons", "## Logo"].join("\n\n")
  const renders: string[] = []
  const renderFavicons: PipelineContext["renderFavicons"] = async ({ dir }) => {
    renders.push(readFileSync(join(dir, "design/logo-mark.svg"), "utf8"))
    for (const file of faviconFiles) writeFile(dir, `design/favicon/${file}`, "icon")
  }
  const { harness, jobs } = stubHarness({
    designer: [
      (_job, workdir) => {
        writeFile(workdir, "design/tokens.css", ":root { --primary: #0f766e; }\n")
        writeFile(workdir, "design/logo.svg", svg("currentColor"))
        writeFile(workdir, "design/logo-mark.svg", svg("#0f766e"))
        writeFile(workdir, "docs/design-system.md", `# Design system\n\n${headings}\n`)
        return "system done"
      },
      (_job, workdir) => {
        writeFile(workdir, "docs/design.md", "## Screens\n\n### Items\nRoute: /items\n")
        return "screens done"
      },
      (_job, workdir) => {
        writeFile(workdir, "design/logo-mark.svg", svg("#115e59"))
        return "fixed"
      },
    ],
    "design-reviewer": ['```json\n{"verdict":"fail","reasons":["mark too light"],"fixes":["Darken design/logo-mark.svg"]}\n```', pass],
    planner: [
      (_job, workdir) => {
        writeFile(workdir, "tasks.json", JSON.stringify([task("T001")]))
        return "planned"
      },
    ],
    worker: [
      (_job, workdir) => {
        writeFile(workdir, "src/t001/a.ts")
        return "done"
      },
    ],
    reviewer: [pass],
  })
  assert.equal(await run(harness, undefined, renderFavicons), "completed")
  const designers = jobs.filter((job) => job.role === "designer")
  assert.match(designers[0].taskPrompt, /Step 1 of 2/)
  assert.match(designers[1].taskPrompt, /Step 2 of 2/)
  assert.match(designers[2].taskPrompt, /design reviewer rejected your output[\s\S]*- Darken design\/logo-mark\.svg/)
  assert.equal(renders.length, 2, "rendered after step 1 and again after the fix")
  assert.match(renders[1], /#115e59/)
  const reviewers = jobs.filter((job) => job.role === "design-reviewer")
  assert.match(reviewers[0].taskPrompt, /Review the design phase output/)
  assert.match(reviewers[0].taskPrompt, /favicon/)
  const log = gitLog(projectDir)
  const designCommits = log.slice(log.indexOf("docs(design): add the screen designs"), log.indexOf("design(tokens): add the theme tokens") + 1).reverse()
  assert.deepEqual(designCommits, [
    "design(tokens): add the theme tokens",
    "design(logo): add the logo and the mark",
    "design(favicon): add the favicon set",
    "docs(design): add the design system",
    "docs(design): add the screen designs",
  ])
  assert.match(showMain(projectDir, "design/logo-mark.svg"), /#115e59/)
})

test("a logo mark that uses theme variables is rejected before the favicon render", async () => {
  const { store, run } = setupProject("design-mark", [task("T001")])
  store.setPhase("design", "pending")
  let rendered = false
  const { harness, jobs } = stubHarness({
    designer: [
      (_job, workdir) => {
        writeFile(workdir, "design/tokens.css", ":root { --primary: #0f766e; }\n")
        writeFile(workdir, "design/logo.svg", '<svg viewBox="0 0 32 32"></svg>\n')
        writeFile(workdir, "design/logo-mark.svg", '<svg viewBox="0 0 32 32"><rect fill="var(--primary)"/></svg>\n')
        writeFile(workdir, "docs/design-system.md", ["## Principles", "## Color", "## Typography", "## Spacing and radius", "## Components", "## Icons", "## Logo"].join("\n"))
        return "done"
      },
    ],
  })
  assert.equal(await run(harness, undefined, async () => void (rendered = true)), "failed")
  assert.equal(rendered, false)
  assert.match(jobs.filter((job) => job.role === "designer")[1].taskPrompt, /must use literal colors/)
})
