import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { qaHardFailures } from "../src/pipeline.ts"
import { createProject } from "../src/project.ts"
import { parseArchitectureCommands, parseDesignScreens, parseQaVerdict, runQaLoop, validateFixTasks, type QaLoopSteps, type QaRoundResult } from "../src/qa.ts"
import { openStore } from "../src/store.ts"
import type { Task } from "../src/tasks.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-qa-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id}/**`], readPaths: [], acceptance: ["works"], verify: "npm test", ...overrides }
}

const existing = [task("T001", { phase: "foundation" }), task("T002", { dependsOn: ["T001"] })]

test("parseDesignScreens reads Route lines leniently and adds /design-system", () => {
  const markdown = [
    "## Screens",
    "### Home",
    "- User stories: US-01",
    "- Route: `/`",
    "- Branding: design/branding/02-home.png",
    "### Settings",
    "**Route:** /settings/",
    "### Tasks",
    "- **Routes**: `/tasks`, `/tasks/:id`, /tasks/[id]",
    "Branding: `03-tasks.png`",
    "### Profile",
    "route: /profile.",
    "The route, for example /not-a-route",
    "## Navigation",
    "Route: /settings",
  ].join("\n")
  assert.deepEqual(parseDesignScreens(markdown), [
    { route: "/", slug: "root", branding: "02-home.png" },
    { route: "/settings", slug: "settings", branding: null },
    { route: "/tasks", slug: "tasks", branding: "03-tasks.png" },
    { route: "/profile", slug: "profile", branding: null },
    { route: "/design-system", slug: "design-system", branding: null },
  ])
  assert.deepEqual(parseDesignScreens(""), [{ route: "/design-system", slug: "design-system", branding: null }])
  assert.deepEqual(
    parseDesignScreens("Route: /a-b\nRoute: /a/b\nRoute: /design-system").map((screen) => screen.slug),
    ["a-b", "a-b-2", "design-system"],
  )
})

test("parseArchitectureCommands reads install and test from ## Commands only", () => {
  const markdown = ["## Stack", "- test: wrong", "## Commands", "```", "- install: npm ci", "- test: `npm test`", "- dev: npm run dev", "```", "## Deployment"].join("\n")
  assert.deepEqual(parseArchitectureCommands(markdown), { install: "npm ci", test: "npm test" })
  assert.deepEqual(parseArchitectureCommands(""), { install: null, test: null })
})

test("parseQaVerdict accepts pass and valid fail verdicts", () => {
  const pass = parseQaVerdict('Done.\n{"verdict":"pass","findings":[],"tasks":[]}', 1, existing)
  assert.deepEqual(pass, { verdict: "pass", findings: [], tasks: [] })
  const fix = task("Q101", { dependsOn: ["T001"] })
  const fail = parseQaVerdict(JSON.stringify({ verdict: "fail", findings: [{ title: "No logo", detail: "header", screen: "/" }], tasks: [fix, task("Q102")] }), 1, existing)
  assert.equal(fail.verdict, "fail")
  assert.deepEqual(fail.findings, [{ title: "No logo", detail: "header", screen: "/" }])
  assert.deepEqual(fail.tasks.map((entry) => entry.id), ["Q101", "Q102"])
})

test("parseQaVerdict rejects malformed verdicts and fix tasks", () => {
  const finding = [{ title: "x", detail: "y", screen: "/" }]
  const fail = (tasks: unknown, round = 1) => parseQaVerdict(JSON.stringify({ verdict: "fail", findings: finding, tasks }), round, existing)
  assert.throws(() => parseQaVerdict("looks good to me", 1, existing), /not one JSON object/)
  assert.throws(() => parseQaVerdict('{"verdict":"maybe"}', 1, existing), /verdict must be/)
  assert.throws(() => parseQaVerdict('{"verdict":"fail","findings":[],"tasks":[]}', 1, existing), /at least one finding/)
  assert.throws(() => fail([]), /at least one fix task/)
  assert.throws(() => fail([task("T003")]), /id must look like Q101/)
  assert.throws(() => fail([task("Q101")], 2), /id must look like Q201/)
  assert.throws(() => fail([task("Q1001")]), /id must look like Q101/)
  assert.throws(() => fail([task("Q101"), task("Q102", { dependsOn: ["Q101"] })]), /may depend only on existing tasks, not Q101/)
  assert.throws(() => fail([task("Q101", { allowedPaths: ["docs/**"] })]), /allowedPaths may not include docs/)
  assert.throws(() => fail([task("Q101", { verify: "" })]), /verify command is required/)
  assert.throws(() => fail([task("Q101"), task("Q101")]), /duplicate id/)
  assert.throws(() => validateFixTasks([task("T001")], 1, existing), /already exists/)
})

test("qaHardFailures covers failed tests, a dead app, and broken routes", () => {
  const tests = { install: "npm ci", command: "npm test", passed: true, output: "" }
  assert.deepEqual(qaHardFailures(tests, null), [])
  const route = { slug: "x", file: "x.png", consoleErrors: [], branding: null }
  const visual = {
    baseUrl: "http://app:3000",
    viewport: { width: 1440, height: 900 },
    startError: null,
    routes: [
      { ...route, route: "/", status: 200, error: null },
      { ...route, route: "/missing", status: 404, error: null },
      { ...route, route: "/slow", status: null, error: "Timeout 30000ms exceeded" },
    ],
  }
  assert.deepEqual(qaHardFailures({ ...tests, passed: false }, visual), ["tests failed (npm test)", "/missing answered HTTP 404", "/slow did not load: Timeout 30000ms exceeded"])
  assert.deepEqual(qaHardFailures(tests, { ...visual, startError: "exited", routes: [] }), ["the app did not start"])
})

test("qa config defaults to enabled with 3 rounds and a claude opus role", () => {
  const projectDir = join(scratch, "config")
  createProject(projectDir, "brief")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  assert.deepEqual(config.qa, { enabled: true, maxRounds: 3 })
  assert.deepEqual(config.roles.qa, { runner: "claude", model: "opus", fallbacks: [] })
  const legacyPath = join(scratch, "legacy.yaml")
  writeFileSync(legacyPath, "roles:\n  pm: { runner: claude, model: opus }\n  architect: { runner: claude, model: opus }\n  designer: { runner: claude, model: opus }\n  planner: { runner: claude, model: opus }\n  worker: { runner: claude, model: sonnet }\n  reviewer: { runner: codex, model: gpt-5.5 }\nqa:\n  maxRounds: 0\n")
  assert.throws(() => loadConfig(legacyPath), /qa.maxRounds must be/)
})

function stubSteps(rounds: QaRoundResult[]) {
  const calls: string[] = []
  const steps: QaLoopSteps = {
    async runRound(round) {
      calls.push(`round ${round}`)
      return rounds.shift() ?? { kind: "pass", findings: [] }
    },
    async applyFixes(round, tasks) {
      calls.push(`fixes ${round}: ${tasks.map((entry) => entry.id).join(",")}`)
    },
    async build() {
      calls.push("build")
      return "completed"
    },
    async deploy() {
      calls.push("deploy")
      return "completed"
    },
  }
  return { steps, calls }
}

const failRound = (round: number): QaRoundResult => ({ kind: "fail", findings: [{ title: "broken", detail: "", screen: "/" }], tasks: [task(`Q${round}01`)] })

function freshStore(name: string) {
  return openStore(join(scratch, `${name}.db`))
}

test("runQaLoop: pass goes straight to deploy", async () => {
  const store = freshStore("pass")
  const { steps, calls } = stubSteps([{ kind: "pass", findings: [] }])
  assert.equal(await runQaLoop(store, 3, steps), "completed")
  assert.deepEqual(calls, ["round 1", "deploy"])
  assert.equal(store.phaseStatus("qa"), "approved")
  assert.equal(store.meta("qa.round"), "1")
  const { steps: again, calls: againCalls } = stubSteps([])
  assert.equal(await runQaLoop(store, 3, again), "completed")
  assert.deepEqual(againCalls, ["deploy"])
})

test("runQaLoop: fail appends fix tasks, builds them, then runs the next round", async () => {
  const store = freshStore("fail-then-pass")
  const { steps, calls } = stubSteps([failRound(1), { kind: "pass", findings: [] }])
  assert.equal(await runQaLoop(store, 3, steps), "completed")
  assert.deepEqual(calls, ["round 1", "fixes 1: Q101", "build", "round 2", "deploy"])
  assert.equal(store.meta("qa.round"), "2")
})

test("runQaLoop: maxRounds failures stop the run, and a resumed run starts a new round", async () => {
  const store = freshStore("max-rounds")
  const { steps, calls } = stubSteps([failRound(1), failRound(2)])
  assert.equal(await runQaLoop(store, 2, steps), "failed")
  assert.deepEqual(calls, ["round 1", "fixes 1: Q101", "build", "round 2", "fixes 2: Q201"])
  assert.equal(store.phaseStatus("qa"), "failed")

  const { steps: resumed, calls: resumedCalls } = stubSteps([{ kind: "pass", findings: [] }])
  assert.equal(await runQaLoop(store, 2, resumed), "completed")
  assert.deepEqual(resumedCalls, ["round 3", "deploy"])
})

test("runQaLoop: infrastructure pauses, invalid verdicts and failed builds stop", async () => {
  const paused = freshStore("paused")
  assert.equal(await runQaLoop(paused, 3, stubSteps([{ kind: "infrastructure", reason: "docker down" }]).steps), "paused")
  assert.equal(paused.phaseStatus("qa"), "pending")

  const invalid = freshStore("invalid")
  assert.equal(await runQaLoop(invalid, 3, stubSteps([{ kind: "invalid", reason: "no JSON" }]).steps), "failed")
  assert.equal(invalid.phaseStatus("qa"), "failed")

  const blocked = freshStore("blocked")
  const { steps } = stubSteps([failRound(1)])
  steps.build = async () => "failed"
  assert.equal(await runQaLoop(blocked, 3, steps), "failed")
  assert.equal(blocked.phaseStatus("qa"), "pending")
})

test("QA endpoints list rounds and serve only files inside the project", async (t) => {
  const runsDir = join(scratch, "runs")
  const projectDir = join(runsDir, "shop")
  createProject(projectDir, "brief")
  const roundDir = join(projectDir, ".agent-team", "qa", "round-1")
  mkdirSync(roundDir, { recursive: true })
  writeFileSync(join(roundDir, "root.png"), "png")
  writeFileSync(join(roundDir, "report.json"), JSON.stringify({ routes: [{ route: "/", file: "root.png" }] }))
  writeFileSync(join(roundDir, "verdict.json"), JSON.stringify({ round: 1, verdict: "pass", findings: [], tasks: [] }))
  const outside = join(scratch, "secret.png")
  writeFileSync(outside, "secret")
  symlinkSync(outside, join(roundDir, "escape.png"))
  symlinkSync(scratch, join(projectDir, ".agent-team", "qa", "round-2"))

  const server = startUi({ runsDir, port: 0, startRun: () => {} })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/shop/qa`

  const rounds = await (await fetch(base)).json()
  assert.equal(rounds.length, 2)
  const [second, first] = rounds
  assert.deepEqual(second, { round: 2, tests: null, report: null, verdict: null, images: [] })
  assert.equal(first.round, 1)
  assert.deepEqual(first.images, ["root.png"])
  assert.equal(first.verdict.verdict, "pass")
  assert.equal(first.tests, null)

  const image = await fetch(`${base}/1/root.png`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get("content-type"), "image/png")
  assert.equal(await image.text(), "png")
  assert.equal((await fetch(`${base}/1/report.json`)).status, 200)
  assert.equal((await fetch(`${base}/1/escape.png`)).status, 404)
  assert.equal((await fetch(`${base}/2/secret.png`)).status, 404)
  assert.equal((await fetch(`${base}/1/tests.json`)).status, 404)
  assert.equal((await fetch(`${base}/1/other.json`)).status, 400)
  assert.equal((await fetch(`${base}/1/..%2F..%2Fstate.db`)).status, 400)
  assert.equal((await fetch(`${base}/x/root.png`)).status, 400)
})
