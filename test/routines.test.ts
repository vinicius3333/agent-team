import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { parse, parseDocument } from "yaml"
import { loadConfig } from "../src/config.ts"
import { operateTick } from "../src/operate/tick.ts"
import { createProject, withProjectStore } from "../src/project.ts"
import { startSprint } from "../src/improve.ts"
import type { PipelineContext } from "../src/pipeline.ts"
import { checkStageImages, dueRoutines, markRoutineBaselines, parseRoutineReply, routineBlocker, routinesSnapshot, runRoutine } from "../src/routines.ts"
import type { RunResult } from "../src/runners/types.ts"
import { openStore, type Store } from "../src/store.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-routines-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const day = 24 * 60 * 60_000

const socialPosts = `
routines:
  monthlyUsd: 10
  list:
    - { id: research, enabled: false }
    - id: social-posts
      name: Weekly social posts
      role: marketer
      instructions: Make 3 square images for the best jokes.
      trigger: interval
      everyDays: 7
      output: marketing
      budgetUsd: 2
      enabled: true
    - id: launch-post
      name: Launch post
      role: researcher
      instructions: Write a launch note for what shipped.
      trigger: sprint
      output: report
      budgetUsd: 1
      enabled: true
`

// Merges top-level blocks into pipeline.yaml; roles and operate merge one level deeper, so their defaults stay.
// A null block is removed, as in a project from before that block existed.
function configure(projectDir: string, extraYaml: string): void {
  const path = join(projectDir, "pipeline.yaml")
  const document = parseDocument(readFileSync(path, "utf8"))
  for (const [key, value] of Object.entries(parse(extraYaml) as Record<string, any>)) {
    if (key === "roles" || key === "operate") for (const [inner, innerValue] of Object.entries(value)) document.setIn([key, inner], innerValue)
    else if (value === null) document.deleteIn([key])
    else document.setIn([key], value)
  }
  writeFileSync(path, document.toString())
}

function project(name: string, extraYaml = socialPosts, runsDir = scratch): string {
  const projectDir = join(runsDir, name)
  createProject(projectDir, "Dad jokes")
  configure(projectDir, extraYaml)
  return projectDir
}

function goLive(store: Store): void {
  store.setMeta("deploy.url", "https://app.example")
  store.setPhase("deploy", "approved")
}

function done(summary: string, costUsd: number | null = 0.3): RunResult {
  return { status: "done", summary, costUsd, tokens: 10, durationMs: 5, exitCode: 0, diagnostics: "" }
}

const json = (value: unknown) => `Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

function lastCommit(projectDir: string): string {
  return execFileSync("git", ["log", "-1", "--format=%s"], { cwd: projectDir, encoding: "utf8" }).trim()
}

test("loadConfig turns operate.schedule into built-in routines and derives the schedule from them", () => {
  const legacy = loadConfig(join(project("legacy", "routines: ~\noperate:\n  schedule: { research: 0, monitoring: 6 }\n"), "pipeline.yaml"))
  const builtIns = legacy.routines.list.map((routine) => [routine.id, routine.enabled, routine.everyDays])
  assert.deepEqual(builtIns, [["monitoring", true, 0.25], ["analytics", true, 1], ["research", false, 7]])
  assert.deepEqual(legacy.operate.schedule, { monitoring: 6, analytics: 24, research: 0 })

  const config = loadConfig(join(project("custom"), "pipeline.yaml"))
  assert.deepEqual(config.routines.list.map((routine) => routine.id), ["monitoring", "analytics", "research", "social-posts", "launch-post"])
  assert.equal(config.operate.schedule.research, 0)
  assert.equal(config.routines.monthlyUsd, 10)
})

test("loadConfig rejects routines that cannot run", () => {
  const bad = `
roles:
  marketer: { runner: claude, model: opus }
routines:
  list:
    - { id: monitoring, trigger: sprint }
    - { id: images, name: Images, role: marketer, instructions: Draw, output: marketing, budgetUsd: 1 }
    - { id: writer, name: Writer, role: worker, instructions: Write, output: report, budgetUsd: 1 }
    - { id: empty, name: Empty, role: pm, instructions: "", output: report, budgetUsd: 50 }
`
  assert.throws(
    () => loadConfig(join(project("bad-routines", bad), "pipeline.yaml")),
    (error: Error) => {
      assert.match(error.message, /monitoring.*interval or by hand only/)
      assert.match(error.message, /images.*need a role on the codex runner/)
      assert.match(error.message, /writer.*role must be one of marketer, researcher, pm, designer/)
      assert.match(error.message, /empty.*instructions are missing/)
      assert.match(error.message, /empty.*budgetUsd must be above 0 and at most 10/)
      return true
    },
  )
})

test("routineBlocker follows the interval, the sprint baseline, the monthly cap, and build runs", () => {
  const projectDir = project("due")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const [social, launch] = config.routines.list.slice(3)
  withProjectStore(projectDir, (store) => {
    const now = Date.now()
    assert.equal(routineBlocker(store, config, social, { now }), "the app is not live")
    assert.equal(routineBlocker(store, config, social, { now, manual: true }), null)
    goLive(store)
    markRoutineBaselines(store, config, now)
    assert.deepEqual(dueRoutines(store, config, now).map((routine) => routine.id), ["social-posts"])

    store.finishRoutineRun(store.startRoutineRun("social-posts", 2), { status: "done", summary: "ok", costUsd: null, findings: 0, files: [] })
    assert.match(routineBlocker(store, config, social, { now })!, /next run is due/)
    assert.equal(routineBlocker(store, config, social, { now: now + 8 * day }), null)

    assert.equal(routineBlocker(store, config, launch, { now }), "it waits for the next finished sprint")
    const sprint = store.startSprint(0)
    store.finishSprint(sprint.number, "done")
    assert.equal(routineBlocker(store, config, launch, { now: now + 1000 }), null)

    // The codex run reported no cost, so it counts its $2 budget: $2 + $9 passes the $10 cap.
    assert.match(routineBlocker(store, config, { ...launch, budgetUsd: 9 }, { now, manual: true })!, /routines.monthlyUsd/)
    store.setMeta("run.pid", String(process.pid))
    assert.equal(routineBlocker(store, config, launch, { now, manual: true }), "a build run is in progress")
  })
})

test("parseRoutineReply reads each output, and checkStageImages keeps only images in out/", () => {
  assert.equal(parseRoutineReply(json({ summary: "s", report: "## A" }), "report").report, "## A")
  assert.throws(() => parseRoutineReply(json({ summary: "s" }), "report"), /no report/)
  assert.equal(parseRoutineReply(json({ summary: "s", findings: [{ severity: "low", title: "t", evidence: "e", proposal: "p" }] }), "backlog").findings.length, 1)
  const images = parseRoutineReply(json({ summary: "s", images: Array.from({ length: 8 }, (_, index) => ({ file: `out/${index}.png` })) }), "marketing")
  assert.equal(images.images.length, 6)
  assert.equal(images.dropped.length, 2)
  assert.throws(() => parseRoutineReply(json({ summary: "s", images: [] }), "marketing"), /no images/)

  const stage = join(scratch, "stage")
  mkdirSync(join(stage, "out"), { recursive: true })
  writeFileSync(join(stage, "out", "post.png"), "png")
  writeFileSync(join(stage, "secret.png"), "png")
  writeFileSync(join(stage, "out", "notes.txt"), "text")
  const { kept, dropped } = checkStageImages(stage, [{ file: "out/post.png", caption: "c" }, { file: "out/../secret.png", caption: "" }, { file: "out/notes.txt", caption: "" }, { file: "out/missing.png", caption: "" }])
  assert.deepEqual(kept.map((image) => image.file), [join(stage, "out", "post.png")])
  assert.equal(dropped.length, 3)
})

test("runRoutine commits marketing images from the stage folder and records the run", async () => {
  const projectDir = project("marketing")
  mkdirSync(join(projectDir, "design"), { recursive: true })
  writeFileSync(join(projectDir, "design", "logo.svg"), "<svg/>")
  const outcome = await runRoutine({
    projectDir,
    id: "social-posts",
    runAgent: async (request, runner) => {
      assert.equal(runner, "codex")
      assert.equal(request.role, "marketer")
      assert.equal(request.budgetUsd, 2)
      assert.match(request.taskPrompt, /Make 3 square images/)
      assert.match(request.taskPrompt, /context\/design\/logo.svg/)
      const stage = request.executor.workdir
      assert.ok(existsSync(join(stage, "context", "design", "logo.svg")))
      writeFileSync(join(stage, "out", "Joke One.png"), "png")
      return done(json({ summary: "One post.", images: [{ file: "out/Joke One.png", caption: "Why did the dev quit?" }, { file: "../escape.png" }] }), null)
    },
  })
  assert.equal(outcome.status, "done")
  withProjectStore(projectDir, (store) => {
    const run = store.lastRoutineRun("social-posts")!
    assert.equal(run.status, "done")
    assert.equal(run.files.length, 1)
    assert.match(run.files[0].file, /^marketing\/routines\/social-posts\/\d{8}T\d{4}-joke-one\.png$/)
    assert.equal(run.files[0].caption, "Why did the dev quit?")
    assert.ok(existsSync(join(projectDir, run.files[0].file)))
    assert.equal(store.recentAttempts("routine-social-posts", 1)[0].role, "marketer")
    assert.ok(store.recentEvents(5).some((event) => /dropped .*escape.png/.test(event.message)))
  })
  assert.equal(lastCommit(projectDir), "design(marketing): add 1 image from social-posts")
})

test("runRoutine writes a report or backlog findings, and fails on a bad reply", async () => {
  const projectDir = project("report")
  const report = await runRoutine({ projectDir, id: "launch-post", runAgent: async (request) => {
    assert.deepEqual(request.allowedTools, ["read", "web_search", "web_fetch"])
    assert.equal(request.executor.workdir, projectDir)
    return done(json({ summary: "Shipped voting.", report: "## What shipped\n\nVoting." }))
  } })
  assert.equal(report.status, "done")
  assert.match(readFileSync(join(projectDir, "docs", "routines", "launch-post.md"), "utf8"), /# Launch post[\s\S]*## What shipped/)
  assert.equal(lastCommit(projectDir), "docs(routines): update launch-post")

  const failed = await runRoutine({ projectDir, id: "launch-post", runAgent: async () => done("no json here") })
  assert.equal(failed.status, "failed")
  assert.match(failed.summary, /not usable/)

  const backlogDir = project("backlog", socialPosts.replace("output: report", "output: backlog"))
  await runRoutine({ projectDir: backlogDir, id: "launch-post", runAgent: async () => done(json({ summary: "s", findings: [{ severity: "medium", title: "Add a share card", evidence: "3 of 4 rivals have it", proposal: "Add one" }] })) })
  withProjectStore(backlogDir, (store) => {
    const [finding] = store.listFindings({ source: "routine" })
    assert.equal(finding.title, "Add a share card")
    assert.equal(finding.evidence, "[Launch post] 3 of 4 rivals have it")
  })
})

test("runRoutine runs the monitoring routine with a fake runner, records lastRun, and adds its findings", async () => {
  const projectDir = project("monitoring")
  const outcome = await runRoutine({
    projectDir,
    id: "monitoring",
    logs: () => "GET / 500 in 2ms",
    runAgent: async (request) => {
      assert.match(request.taskPrompt, /GET \/ 500/)
      return done(json({ summary: "One error.", findings: [{ severity: "high", title: "Home page answers 500", evidence: "GET / 500", proposal: "Fix the home page" }] }))
    },
  })
  assert.equal(outcome.status, "done")
  withProjectStore(projectDir, (store) => {
    const config = loadConfig(join(projectDir, "pipeline.yaml"))
    const view = routinesSnapshot(store, config).routines.find((routine) => routine.id === "monitoring")!
    assert.equal(view.lastRun?.status, "done")
    assert.equal(view.lastRun?.findings, 1)
    assert.deepEqual(store.listFindings({ status: "open" }).map((finding) => finding.title), ["Home page answers 500"])
  })
})

test("a routine with output sprint adds its findings and starts a sprint that adds a sprint row", async () => {
  const sprintRoutine = socialPosts.replace("output: report", "output: sprint")
  const projectDir = project("sprint-output", sprintRoutine)
  const path = join(projectDir, "pipeline.yaml")
  const document = parseDocument(readFileSync(path, "utf8"))
  document.setIn(["sprints", "enabled"], true)
  document.setIn(["deploy", "enabled"], true)
  writeFileSync(path, document.toString())
  withProjectStore(projectDir, (store) => {
    for (const phase of ["plan", "qa"]) store.setPhase(phase, "approved")
    store.setMeta("import.done", "1")
  })
  const config = loadConfig(path)
  const launch = config.routines.list.find((routine) => routine.id === "launch-post")!
  withProjectStore(projectDir, (store) => assert.equal(routineBlocker(store, config, launch, { manual: true }), null))

  const failed: RunResult = { status: "failed", summary: "fake runner: no reply", costUsd: 0, tokens: null, durationMs: 1, exitCode: 1, diagnostics: "" }
  const outcome = await runRoutine({
    projectDir,
    id: "launch-post",
    runAgent: async () => done(json({ summary: "Found a gap.", findings: [{ severity: "medium", title: "Add a share card", evidence: "rivals have it", proposal: "Add one" }] })),
    startSprint: async (dir) => {
      const store = openStore(join(dir, ".agent-team", "state.db"))
      const sprintConfig = loadConfig(join(dir, "pipeline.yaml"))
      sprintConfig.harness.isolation = "none"
      const harness = { run: async () => ({ result: failed, candidate: null, failureClass: "agent_failure" }) }
      const deploy = async () => ({ url: "https://app.example", error: null })
      const context = { projectDir: dir, config: sprintConfig, store, signal: new AbortController().signal, harness, deploy, appRunning: () => false } as unknown as PipelineContext
      try {
        await startSprint(context, { early: true })
      } finally {
        store.close()
      }
    },
  })
  assert.equal(outcome.status, "done")
  assert.match(outcome.summary, /A sprint started/)
  withProjectStore(projectDir, (store) => {
    assert.equal(store.listFindings({ source: "routine" })[0].title, "Add a share card")
    const [sprint] = store.sprints(1)
    assert.ok(sprint, "the routine added a sprint row")
    assert.notEqual(sprint.status, "planning")
  })

  // With sprints off, Run now answers the blocker instead of running quietly.
  const off = loadConfig(path)
  off.sprints.enabled = false
  withProjectStore(projectDir, (store) => assert.match(routineBlocker(store, off, launch, { manual: true })!, /no sprint can start: sprints are off/))
})

test("operateTick runs due custom routines even with Operate off", async () => {
  const runsDir = join(scratch, "tick-runs")
  const projectDir = project("live", `operate:\n  enabled: false\n${socialPosts}`, runsDir)
  withProjectStore(projectDir, goLive)
  const calls: string[] = []
  let release = () => {}
  const finished = new Promise<void>((resolve) => (release = resolve))
  await operateTick({
    runsDir,
    runAgent: async () => assert.fail("Operate is off"),
    runRoutine: async (_dir, id) => {
      calls.push(id)
      release()
    },
  })
  await finished
  assert.deepEqual(calls, ["social-posts"])
})

test("server lists, saves, and runs routines", async (t) => {
  const runsDir = join(scratch, "server-runs")
  const projectDir = project("dad-jokes", "routines: ~\noperate:\n  schedule: { research: 0 }\n", runsDir)
  const runs: string[] = []
  let finishRun = () => {}
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, notifications: false, startRun: () => {}, runRoutine: (_dir, id) => {
    runs.push(id)
    return new Promise<void>((resolve) => (finishRun = resolve))
  } })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/dad-jokes`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify(body) })

  const snapshot = await (await fetch(`${base}/routines`)).json()
  assert.deepEqual(snapshot.routines.map((routine: { id: string; builtIn: boolean }) => [routine.id, routine.builtIn]), [["monitoring", true], ["analytics", true], ["research", true]])
  assert.deepEqual(snapshot.routines[2].capabilities, ["Web search"])

  const list = [...snapshot.routines, { name: "SEO keyword scan", role: "researcher", instructions: "Find 10 search terms.", trigger: "interval", everyDays: 14, output: "report", budgetUsd: 1, enabled: true }]
  assert.equal((await post("/routines", { monthlyUsd: 40, list: [...list, { ...list[3], role: "worker" }] })).status, 400)
  assert.equal((await post("/routines", { monthlyUsd: 40, list })).status, 200)
  const saved = parse(readFileSync(join(projectDir, "pipeline.yaml"), "utf8"))
  assert.equal(saved.operate.schedule, undefined, "the built-in routines replace operate.schedule")
  assert.deepEqual(saved.routines.list[2], { id: "research", enabled: false, trigger: "interval", everyDays: 7 })
  assert.equal(saved.routines.list[3].id, "seo-keyword-scan")
  assert.equal(loadConfig(join(projectDir, "pipeline.yaml")).operate.schedule.research, 0)

  assert.equal((await post("/routines/run", { id: "nope" })).status, 404)
  assert.equal((await post("/routines/run", { id: "seo-keyword-scan" })).status, 202)
  assert.equal((await post("/routines/run", { id: "seo-keyword-scan" })).status, 409)
  finishRun()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(runs, ["seo-keyword-scan"])
})
