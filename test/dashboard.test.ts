import assert from "node:assert/strict"
import { once } from "node:events"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { appendFeedback } from "../src/feedback.ts"
import { phasePrompt } from "../src/pipeline.ts"
import { createProject, withProjectStore, type ProjectChoices } from "../src/project.ts"
import { hashPassword, loadAuthConfig } from "../src/ui/auth.ts"
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
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, startRun: (projectDir) => void started.push(projectDir) })
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

test("operate events do not mark a project active", async (t) => {
  const runsDir = join(scratch, "operate-runs")
  const projectDir = join(runsDir, "live-app")
  createProject(projectDir, "brief")
  withProjectStore(projectDir, (store) => store.log("operate", "health: down (timeout)"))
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" } })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  assert.equal((await (await fetch(`${base}/api/projects/live-app`)).json()).active, false)
  withProjectStore(projectDir, (store) => store.log("run", "phase spec started"))
  assert.equal((await (await fetch(`${base}/api/projects/live-app`)).json()).active, true)
})

test("POST /api/projects writes role models and POST /roles changes them", async (t) => {
  const runsDir = join(scratch, "roles-runs")
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, startRun: () => {} })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-agent-team": "1" }) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  const { workerRunner: _, ...rest } = choices
  const valid = { name: "models-app", brief: "Build it", ...rest }

  assert.equal((await post("/api/projects", { ...valid, roles: { boss: { runner: "claude", model: "opus" } } })).status, 400)
  assert.equal((await post("/api/projects", { ...valid, roles: { pm: { runner: "gemini", model: "x" } } })).status, 400)
  assert.equal((await post("/api/projects", { ...valid, roles: { pm: { runner: "claude", model: "bad model!" } } })).status, 400)
  assert.equal((await post("/api/projects", { ...valid, roles: { illustrator: { runner: "claude", model: "opus" } } })).status, 400)
  assert.equal((await post("/api/projects", { ...valid, roles: [] })).status, 400)

  const roles = { pm: { runner: "codex", model: "gpt-6-sol" }, worker: { runner: "codex", model: "gpt-6-luna" }, reviewer: { runner: "codex", model: "my-model:v2" } }
  assert.equal((await post("/api/projects", { ...valid, roles })).status, 201)
  const projectDir = join(runsDir, "models-app")
  const path = join(projectDir, "pipeline.yaml")
  assert.match(readFileSync(path, "utf8"), /# image generation needs codex/)
  let config = loadConfig(path)
  assert.deepEqual([config.roles.pm.runner, config.roles.pm.model], ["codex", "gpt-6-sol"])
  assert.equal(config.roles.reviewer.model, "my-model:v2")
  assert.equal(config.roles.worker.maxRetries, 3)
  assert.equal(config.allowSameVendorReview, true)

  const change = { roles: { designer: { runner: "codex", model: "gpt-5.5" }, worker: { runner: "claude", model: "haiku" } } }
  assert.equal((await post("/api/projects/models-app/roles", change, {})).status, 403)
  assert.equal((await post("/api/projects/missing/roles", change)).status, 404)
  assert.equal((await post("/api/projects/models-app/roles", { roles: { qa: { runner: "claude", model: "" } } })).status, 400)
  withProjectStore(projectDir, (store) => store.setMeta("run.pid", String(process.pid)))
  assert.equal((await post("/api/projects/models-app/roles", change)).status, 409)
  withProjectStore(projectDir, (store) => store.setMeta("run.pid", ""))

  writeFileSync(join(projectDir, "notes.md"), "human edit")
  assert.equal((await post("/api/projects/models-app/roles", change)).status, 200)
  config = loadConfig(path)
  assert.deepEqual([config.roles.designer.runner, config.roles.designer.model], ["codex", "gpt-5.5"])
  assert.equal(config.roles.worker.model, "haiku")
  assert.match(readFileSync(path, "utf8"), /# image generation needs codex/)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8" })
  assert.equal(git("log", "-1", "--format=%s").trim(), "chore: change agent models")
  assert.match(git("status", "--porcelain"), /\?\? notes\.md/)
})

test("GET /api/defaults returns the roles from pipeline.example.yaml", async (t) => {
  const server = startUi({ runsDir: join(scratch, "defaults-runs"), port: 0, auth: { mode: "none" } })
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
    const server = startUi({ runsDir: join(scratch, "spa-runs"), port: 0, auth: { mode: "none" }, webDir: dir })
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

test("activeTime skips the time a project sat stopped between runs", async () => {
  const { activeTime } = await import("../src/ui/server.ts")
  const events = [
    { at: "2026-09-24T01:00:00Z", type: "phase", message: "spec" },
    { at: "2026-09-24T01:10:00Z", type: "run", message: "finished: failed" },
    { at: "2026-09-24T05:00:00Z", type: "task", message: "T005 reset for retry" },
    { at: "2026-09-24T05:05:00Z", type: "task", message: "T005 merged" },
  ]
  assert.deepEqual(activeTime(events), { ms: 10 * 60_000, openSince: "2026-09-24T05:00:00Z" })
  assert.deepEqual(activeTime(events.slice(0, 2)), { ms: 10 * 60_000, openSince: null })
})

test("the login gates every /api route and keeps static files public", async (t) => {
  const runsDir = join(scratch, "auth-runs")
  createProject(join(runsDir, "gated"), "brief")
  const webDir = join(scratch, "auth-web")
  mkdirSync(join(webDir, "assets"), { recursive: true })
  writeFileSync(join(webDir, "index.html"), "<div id=root></div>")
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)")
  let clock = 1_000_000
  const auth = loadAuthConfig({ AGENT_TEAM_UI_PASSWORD_HASH: hashPassword("correct horse battery"), AGENT_TEAM_UI_SESSION_SECRET: Buffer.alloc(32, 3).toString("base64url") })
  const server = startUi({ runsDir, port: 0, auth, webDir, startRun: () => {}, now: () => clock, failedLoginDelayMs: 0 })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const login = (password: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1", ...headers }, body: JSON.stringify({ password }) })

  assert.equal((await fetch(`${base}/api/projects`)).status, 401)
  const anonymous = await fetch(`${base}/api/auth/session`)
  assert.equal(anonymous.status, 200)
  assert.deepEqual(await anonymous.json(), { authenticated: false, user: null, source: null, mode: "password" })
  for (const path of ["/", "/projects/gated", "/assets/app.js"]) assert.equal((await fetch(`${base}${path}`)).status, 200, path)
  assert.equal((await fetch(`${base}/`)).headers.get("x-frame-options"), "DENY")

  const loggedIn = await login("correct horse battery")
  assert.equal(loggedIn.status, 204)
  const setCookie = loggedIn.headers.get("set-cookie") ?? ""
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Max-Age=604800/)
  assert.doesNotMatch(setCookie, /Secure/)
  const cookie = setCookie.split(";")[0]
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 200)
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()
  assert.deepEqual(session, { authenticated: true, user: "dashboard", source: "session", mode: "password" })

  const stream = await fetch(`${base}/api/stream/gated`, { headers: { cookie } })
  assert.equal(stream.status, 200)
  await stream.body?.cancel()
  assert.equal((await fetch(`${base}/api/stream/gated`)).status, 401)

  const foreign = await fetch(`${base}/api/projects/gated/run`, { method: "POST", headers: { cookie, "x-agent-team": "1", origin: "https://evil.example" } })
  assert.equal(foreign.status, 403)
  assert.equal((await login("correct horse battery", { origin: "https://evil.example" })).status, 403)

  const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, "x-agent-team": "1" } })
  assert.equal(logout.status, 204)
  assert.match(logout.headers.get("set-cookie") ?? "", /agent_team_session=;.*Max-Age=0/)

  clock += 8 * 24 * 3600_000
  assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 401)

  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await login("wrong password")).status, 401)
  const limited = await login("correct horse battery")
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get("retry-after"), "900")
  clock += 15 * 60_000
  assert.equal((await login("correct horse battery")).status, 204)
})

test("the proxy header counts only from a trusted proxy address", async (t) => {
  const serve = async (trusted: string) => {
    const auth = loadAuthConfig({ AGENT_TEAM_UI_TRUSTED_PROXIES: trusted, AGENT_TEAM_UI_PROXY_USER_HEADER: "Remote-User" })
    const server = startUi({ runsDir: join(scratch, "proxy-runs"), port: 0, auth })
    await once(server, "listening")
    t.after(() => server.close())
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  const untrusted = await serve("10.9.9.9")
  assert.equal((await fetch(`${untrusted}/api/projects`, { headers: { "remote-user": "ana" } })).status, 401)
  const trusted = await serve("127.0.0.1")
  assert.equal((await fetch(`${trusted}/api/projects`, { headers: { "remote-user": "ana" } })).status, 200)
  const session = await (await fetch(`${trusted}/api/auth/session`, { headers: { "remote-user": "ana" } })).json()
  assert.deepEqual(session, { authenticated: true, user: "ana", source: "proxy", mode: "proxy" })
})

test("startUi refuses a public bind without a login unless told to allow it", async (t) => {
  const runsDir = join(scratch, "bind-runs")
  assert.throws(() => startUi({ runsDir, port: 0, host: "0.0.0.0", auth: { mode: "none" } }), /Refusing to listen on 0\.0\.0\.0 without a login/)
  const server = startUi({ runsDir, port: 0, host: "0.0.0.0", auth: { mode: "none" }, allowInsecureBind: true })
  await once(server, "listening")
  t.after(() => server.close())
})

test("POST /changes validates the request and refuses while busy or unfinished", async (t) => {
  const runsDir = join(scratch, "change-runs")
  const started: string[] = []
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, startRun: (projectDir) => void started.push(projectDir) })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify(body) })
  const projectDir = join(runsDir, "notes")
  createProject(projectDir, "brief")

  assert.equal((await post("/api/projects/notes/changes", { request: "  " })).status, 400)
  assert.equal((await post("/api/projects/notes/changes", { request: "x".repeat(4001) })).status, 400)
  const unfinished = await post("/api/projects/notes/changes", { request: "Add tags" })
  assert.equal(unfinished.status, 409)
  assert.match((await unfinished.json()).error, /Finish or fix the current run first/)

  withProjectStore(projectDir, (store) => {
    for (const phase of ["plan", "qa", "deploy"]) store.setPhase(phase, "approved")
    store.syncTasks(["T001"])
    store.updateTask("T001", "merged")
    store.setMeta("run.pid", String(process.pid))
  })
  assert.equal((await post("/api/projects/notes/changes", { request: "Add tags" })).status, 409, "a run is alive")
  withProjectStore(projectDir, (store) => store.setMeta("run.pid", ""))

  const opened = await post("/api/projects/notes/changes", { request: "Add tags" })
  assert.equal(opened.status, 201)
  assert.deepEqual(await opened.json(), { id: "C001", branch: "change/C001-add-tags", started: true })
  assert.deepEqual(started, [projectDir])
  const again = await post("/api/projects/notes/changes", { request: "More" })
  assert.equal(again.status, 409)
  assert.match((await again.json()).error, /C001 is still open/)

  const detail = await (await fetch(`${base}/api/projects/notes`)).json()
  assert.equal(detail.changes[0].id, "C001")
  assert.equal(detail.changes[0].status, "open")
  assert.equal(detail.change.id, "C001")
  assert.equal(detail.canRequestChange, false)

  assert.equal((await post("/api/projects/notes/changes/C009/abandon", {})).status, 404)
  assert.equal((await post("/api/projects/notes/changes/C001/abandon", {})).status, 200)
  const after = await (await fetch(`${base}/api/projects/notes`)).json()
  assert.equal(after.changes[0].status, "abandoned")
  assert.equal(after.canRequestChange, true)
})
