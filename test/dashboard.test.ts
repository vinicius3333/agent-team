import assert from "node:assert/strict"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { appendFeedback } from "../src/feedback.ts"
import { phasePrompt } from "../src/pipeline.ts"
import { createProject, withProjectStore, type ProjectChoices } from "../src/project.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-dashboard-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const choices: ProjectChoices = { target: "api", workerRunner: "codex", gates: ["spec", "design"], github: true, deploy: false, branding: false }

test("createProject writes the choices into pipeline.yaml and keeps comments", () => {
  const projectDir = join(scratch, "created")
  createProject(projectDir, "Build a todo app", choices)
  assert.equal(readFileSync(join(projectDir, "input.md"), "utf8"), "Build a todo app")
  const yaml = readFileSync(join(projectDir, "pipeline.yaml"), "utf8")
  assert.match(yaml, /# web \| api \| web\+api/)
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  assert.equal(config.target, "api")
  assert.deepEqual(config.autonomy.gates, ["spec", "design"])
  assert.equal(config.publish.github.enabled, true)
  assert.equal(config.deploy.enabled, false)
  assert.equal(config.branding.enabled, false)
  assert.equal(config.roles.worker.runner, "codex")
  assert.equal(config.roles.worker.model, "gpt-5.5")
  assert.equal(config.roles.worker.maxRetries, 3)
  assert.throws(() => createProject(projectDir, "again", choices), /already exists/)
})

test("pending feedback goes into the phase prompt", () => {
  const projectDir = join(scratch, "feedback")
  createProject(projectDir, "brief")
  const context = { projectDir, config: loadConfig(join(projectDir, "pipeline.yaml")) }
  assert.doesNotMatch(phasePrompt(context, "spec", null), /asked for these changes/)
  appendFeedback(projectDir, "spec", "Add an offline mode.")
  const prompt = phasePrompt(context, "spec", null)
  assert.match(prompt, /A human reviewed your last output and asked for these changes:/)
  assert.match(prompt, /Add an offline mode\./)
  assert.doesNotMatch(phasePrompt(context, "design", null), /Add an offline mode/)
})

test("server write endpoints validate and start runs", async (t) => {
  const runsDir = join(scratch, "runs")
  const started: string[] = []
  const server = startUi({ runsDir, port: 0, startRun: (projectDir) => void started.push(projectDir) })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-agent-team": "1" }) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) })
  const valid = { name: "todo-app", brief: "Build a todo app", ...choices }

  assert.equal((await post("/api/projects", valid, {})).status, 403)
  assert.equal((await post("/api/projects", "{not json")).status, 400)
  assert.equal((await post("/api/projects", "x".repeat(70 * 1024))).status, 413)
  assert.equal((await post("/api/projects", { ...valid, name: "Bad_Name" })).status, 400)
  assert.equal((await post("/api/projects", { ...valid, gates: ["deploy"] })).status, 400)
  assert.equal((await post("/api/projects", { ...valid, github: "yes" })).status, 400)
  assert.deepEqual(started, [])

  const created = await post("/api/projects", valid)
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { name: "todo-app" })
  assert.deepEqual(started, [join(runsDir, "todo-app")])
  assert.equal((await post("/api/projects", valid)).status, 409)

  assert.equal((await post("/api/projects/missing/run", {})).status, 404)
  assert.equal((await post("/api/projects/todo-app/run", {})).status, 202)

  const projectDir = join(runsDir, "todo-app")
  withProjectStore(projectDir, (store) => store.setMeta("run.pid", String(process.pid)))
  assert.equal((await post("/api/projects/todo-app/run", {})).status, 409)
  withProjectStore(projectDir, (store) => store.setMeta("run.pid", ""))

  assert.equal((await post("/api/projects/todo-app/approve", { phase: "spec" })).status, 409)
  assert.equal((await post("/api/projects/todo-app/approve", { phase: "nope" })).status, 400)
  assert.equal((await post("/api/projects/todo-app/feedback", { phase: "spec" })).status, 400)

  withProjectStore(projectDir, (store) => store.setPhase("spec", "awaiting_approval"))
  const feedback = await post("/api/projects/todo-app/feedback", { phase: "spec", message: "Add offline mode." })
  assert.equal(feedback.status, 200)
  assert.equal(withProjectStore(projectDir, (store) => store.phaseStatus("spec")), "pending")
  assert.match(readFileSync(join(projectDir, ".agent-team/feedback/spec.md"), "utf8"), /Add offline mode\./)
  const detail = await (await fetch(`${base}/api/projects/todo-app`)).json()
  assert.match(detail.feedback.spec, /Add offline mode\./)

  withProjectStore(projectDir, (store) => store.setPhase("spec", "awaiting_approval"))
  assert.equal((await post("/api/projects/todo-app/approve", { phase: "spec" })).status, 200)
  assert.equal(withProjectStore(projectDir, (store) => store.phaseStatus("spec")), "approved")

  assert.equal((await post("/api/projects/todo-app/retry", { taskId: "T999" })).status, 404)
  withProjectStore(projectDir, (store) => store.syncTasks(["T001"]))
  assert.equal((await post("/api/projects/todo-app/retry", { taskId: "T001" })).status, 200)
  assert.equal(started.length, 5)

  const page = await fetch(`${base}/projects/todo-app`)
  const webBuilt = existsSync(new URL("../web/dist/index.html", import.meta.url))
  assert.equal(page.status, webBuilt ? 200 : 503)
  assert.equal((await fetch(`${base}/api/nope`)).status, 404)
  assert.ok(readdirSync(runsDir).includes("todo-app"))
})

test("GET /api/defaults returns the roles from pipeline.example.yaml", async (t) => {
  const server = startUi({ runsDir: join(scratch, "defaults-runs"), port: 0 })
  await once(server, "listening")
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/defaults`)
  assert.equal(response.status, 200)
  const { roles } = await response.json()
  const expected = loadConfig(new URL("../pipeline.example.yaml", import.meta.url).pathname).roles
  for (const [role, config] of Object.entries(expected)) {
    assert.deepEqual(roles[role], { runner: config.runner, model: config.model, fallbacks: config.fallbacks })
  }
})

test("the server falls back to the SPA index and answers 503 when the UI is not built", async (t) => {
  const webDir = join(scratch, "web-dist")
  mkdirSync(join(webDir, "assets"), { recursive: true })
  const serve = async (dir: string) => {
    const server = startUi({ runsDir: join(scratch, "spa-runs"), port: 0, webDir: dir })
    await once(server, "listening")
    t.after(() => server.close())
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  const missing = await serve(join(scratch, "not-built"))
  const notBuilt = await fetch(`${missing}/projects/x`)
  assert.equal(notBuilt.status, 503)
  assert.match(await notBuilt.text(), /npm run build:ui/)

  writeFileSync(join(webDir, "index.html"), "<div id=root></div>")
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)")
  const built = await serve(webDir)
  for (const path of ["/", "/projects/x", "/new", "/../../etc/passwd"]) {
    const page = await fetch(`${built}${path}`)
    assert.equal(page.status, 200, path)
    assert.match(page.headers.get("content-type") ?? "", /text\/html/)
    assert.equal(await page.text(), "<div id=root></div>")
  }
  const asset = await fetch(`${built}/assets/app.js`)
  assert.match(asset.headers.get("content-type") ?? "", /javascript/)
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/)
  assert.equal((await fetch(`${built}/api/nope`)).status, 404)
})
