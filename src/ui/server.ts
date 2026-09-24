import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, openSync, readSync, closeSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { basename, join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { defaultRunBudgetUsd, loadConfig, normalizePhaseName, planningPhases, runnerNames, type PlanningPhase } from "../config.ts"
import { pendingFeedback } from "../feedback.ts"
import { approvePhase, createProject, listProjects, ProjectError, raiseRunBudget, requestChanges, retryTask, runAlive, runLogPath, startRun as spawnRun, withProjectStore, type ProjectChoices } from "../project.ts"
import { listIncidents, openIncident, readIncident } from "../incidents.ts"
import { reviewerMetrics, type ReviewRow } from "../reviews.ts"

const execFileAsync = promisify(execFile)
const builtWebDir = fileURLToPath(new URL("../../web/dist/", import.meta.url))
const examplePipelinePath = fileURLToPath(new URL("../../pipeline.example.yaml", import.meta.url))
const staticTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
}
const bodyMaxBytes = 64 * 1024
const newProjectNamePattern = /^[a-z0-9][a-z0-9-]{1,40}$/
const targets = ["web", "api", "web+api"]
const transcriptMaxBytes = 200 * 1024
const artifactMaxBytes = 500 * 1024
const imageMaxBytes = 20 * 1024 * 1024
const brandingImagePattern = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/
// The dashboard reads the state DB read-only, so it maps the pre-rename "mockups" row itself.
const phaseNameColumn = "CASE name WHEN 'mockups' THEN 'branding' ELSE name END AS name"
// Projects created before the rename keep their images in design/mockups/.
const brandingDirectories = [join("design", "branding"), join("design", "mockups")]
const qaRoundDirectoryPattern = /^round-(\d{1,4})$/
const qaRoundPattern = /^\d{1,4}$/
const qaImagePattern = /^[a-z0-9-]+\.png$/
const qaJsonFiles = ["tests.json", "report.json", "verdict.json"]
const activeWindowMs = 2 * 60_000
const projectNamePattern = /^[A-Za-z0-9._-]+$/
const transcriptNamePattern = /^[A-Za-z0-9._-]+\.log$/
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])

// Blocks DNS rebinding: a hostile page resolving its own name to 127.0.0.1 would otherwise be same-origin and pass the header check.
function allowedHost(request: IncomingMessage, extraHosts: string[]): boolean {
  const host = String(request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "")
  return loopbackHosts.has(host) || host.endsWith(".ts.net") || extraHosts.includes(host)
}

// Agents write the project files, so a symlink could point outside the project; the real path must stay inside.
function projectFile(projectDir: string, relative: string): string | null {
  const path = resolve(projectDir, relative)
  if (!path.startsWith(projectDir + sep) || !existsSync(path)) return null
  const real = realpathSync(path)
  return real.startsWith(realpathSync(projectDir) + sep) ? real : null
}

export interface ActiveTime {
  ms: number
  openSince: string | null
}

// Time spent inside runs only: each "finished:" event closes a run, and the gap until the next event (a blocked or stopped project) is not counted.
export function activeTime(events: { at: string; type: string; message: string }[]): ActiveTime {
  let ms = 0
  let openSince: string | null = null
  let last: string | null = null
  for (const event of events) {
    openSince ??= event.at
    last = event.at
    if (event.type === "run" && event.message.startsWith("finished")) {
      ms += Date.parse(event.at) - Date.parse(openSince)
      openSince = null
    }
  }
  return { ms, openSince: openSince && last ? openSince : null }
}

function withDatabase<T>(projectDir: string, read: (db: DatabaseSync) => T, fallback: T): T {
  const path = join(projectDir, ".agent-team", "state.db")
  if (!existsSync(path)) return fallback
  for (let attempt = 0; attempt < 5; attempt++) {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path, { readOnly: true })
      db.exec("PRAGMA busy_timeout = 2000")
      return read(db)
    } catch (error) {
      if (!/SQLITE_BUSY|database is locked/i.test(String(error))) return fallback
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
    } finally {
      db?.close()
    }
  }
  return fallback
}

const ignoredDirectories = new Set([".git", ".agent-team", "node_modules"])
// SVG is left out on purpose: served from this origin it could run script.
const rawImageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }
const markdownMaxDepth = 4

function listMarkdown(projectDir: string): string[] {
  const found: string[] = []
  const walk = (relative: string, depth: number) => {
    if (depth > markdownMaxDepth) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(join(projectDir, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(path)
    }
  }
  walk("", 1)
  return found.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function all(db: DatabaseSync, sql: string, ...params: (string | number)[]): any[] {
  try {
    return db.prepare(sql).all(...params) as any[]
  } catch {
    return []
  }
}

function readTasksFile(projectDir: string): any[] {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, "tasks.json"), "utf8"))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function summary(runsDir: string, name: string) {
  const projectDir = join(runsDir, name)
  return withDatabase(
    projectDir,
    (db) => {
      const phases = all(db, `SELECT ${phaseNameColumn}, status FROM phases`)
      const counts: Record<string, number> = {}
      for (const row of all(db, "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")) counts[row.status] = row.count
      const lastEvent = all(db, "SELECT at, type, message FROM events ORDER BY id DESC LIMIT 1")[0] ?? null
      const running = all(db, "SELECT id FROM tasks WHERE status = 'running' LIMIT 1")[0]?.id ?? null
      const activePhase = phases.find((phase) => phase.status === "running")?.name ?? null
      const pidRow = all(db, "SELECT value FROM meta WHERE key = 'run.pid'")[0]
      const active = pidRow ? processAlive(Number(pidRow.value)) : Boolean(lastEvent && Date.now() - Date.parse(lastEvent.at) < activeWindowMs && !/^finished/.test(lastEvent.message))
      const cost = all(db, "SELECT COALESCE(SUM(cost_usd), 0) AS total, SUM(cost_usd IS NULL) AS unreported FROM attempts")[0]
      const stop = parseStop(all(db, "SELECT value FROM meta WHERE key = 'run.stop'")[0]?.value)
      return { name, phases, counts, lastEvent, current: running ?? activePhase, active, costUsd: cost?.total ?? 0, costUnreported: (cost?.unreported ?? 0) > 0, stop, incident: incidentBanner(projectDir) }
    },
    { name, phases: [], counts: {}, lastEvent: null, current: null, active: false, costUsd: 0, costUnreported: false, stop: null, incident: incidentBanner(projectDir) },
  )
}

function incidentBanner(projectDir: string) {
  const incident = openIncident(projectDir)
  return incident ? { id: incident.id, status: incident.status, reason: incident.reason, attempts: incident.attempts, issueUrl: incident.issueUrl, createdAt: incident.createdAt } : null
}

function allIncidents(runsDir: string) {
  return listProjects(runsDir)
    .flatMap((name) => listIncidents(join(runsDir, name)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function incidentDetail(runsDir: string, name: string, id: string) {
  const projectDir = join(runsDir, name)
  const incident = readIncident(projectDir, id)
  if (!incident) return null
  const attempts = withDatabase(
    projectDir,
    (db) =>
      all(db, "SELECT subject, role, runner, model, status, failure_class AS failureClass, cost_usd AS costUsd, duration_ms AS durationMs, transcript_path AS transcriptPath, created_at AS createdAt FROM attempts WHERE subject LIKE ? ORDER BY id", `doctor-${id}-%`),
    [],
  ).map(({ transcriptPath, ...attempt }: any) => ({ ...attempt, transcript: String(transcriptPath ?? "").split("/").pop() }))
  return { ...incident, calls: attempts }
}

async function command(cwd: string, file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch {
    return ""
  }
}

function brandingDirectory(projectDir: string): string | null {
  return brandingDirectories.find((dir) => existsSync(join(projectDir, dir))) ?? null
}

function qaRoundPath(round: number | string): string {
  return join(".agent-team", "qa", `round-${round}`)
}

function readQaJson(projectDir: string, relative: string): unknown {
  const path = projectFile(projectDir, relative)
  if (!path || !statSync(path).isFile() || statSync(path).size > artifactMaxBytes) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// Newest round first. Every path goes through projectFile, so a symlink in .agent-team/qa cannot leave the project.
function qaRounds(projectDir: string) {
  const base = projectFile(projectDir, join(".agent-team", "qa"))
  if (!base || !statSync(base).isDirectory()) return []
  return readdirSync(base)
    .map((entry) => Number(qaRoundDirectoryPattern.exec(entry)?.[1] ?? NaN))
    .filter((round) => Number.isInteger(round))
    .sort((a, b) => b - a)
    .map((round) => {
      const dir = projectFile(projectDir, qaRoundPath(round))
      const images = dir && statSync(dir).isDirectory() ? readdirSync(dir).filter((file) => qaImagePattern.test(file) && projectFile(projectDir, join(qaRoundPath(round), file))).sort() : []
      return {
        round,
        tests: readQaJson(projectDir, join(qaRoundPath(round), "tests.json")),
        report: readQaJson(projectDir, join(qaRoundPath(round), "report.json")),
        verdict: readQaJson(projectDir, join(qaRoundPath(round), "verdict.json")),
        images,
      }
    })
}

function readConfig(projectDir: string) {
  try {
    const raw = parseYaml(readFileSync(join(projectDir, "pipeline.yaml"), "utf8")) ?? {}
    const roles: Record<string, unknown> = {}
    for (const [role, value] of Object.entries<any>(raw.roles ?? {})) {
      roles[role] = { runner: value?.runner, model: value?.model, fallbacks: value?.fallbacks ?? [], maxRetries: value?.maxRetries ?? null }
    }
    return {
      target: raw.target ?? "web",
      gates: Array.isArray(raw.autonomy?.gates) ? raw.autonomy.gates.map((gate: unknown) => normalizePhaseName(String(gate))) : [],
      roles,
      branding: raw.branding ?? raw.mockups ?? null,
      qa: { enabled: raw.qa?.enabled ?? true, maxRounds: raw.qa?.maxRounds ?? 3 },
      publish: { github: { enabled: Boolean(raw.publish?.github?.enabled) } },
      budget: { perTaskUsd: raw.budget?.perTaskUsd ?? 2, runUsd: raw.budget?.runUsd ?? defaultRunBudgetUsd },
    }
  } catch {
    return null
  }
}

function httpsRepoUrl(remote: string): string | null {
  const trimmed = remote.trim()
  if (!trimmed) return null
  const ssh = trimmed.match(/^git@github\.com:(.+?)(\.git)?$/)
  if (ssh) return `https://github.com/${ssh[1]}`
  return trimmed.replace(/\.git$/, "").replace(/^https:\/\/[^@]+@/, "https://")
}

const pullRequestCache = new Map<string, { at: number; value: any[] }>()
const pullRequestCacheMs = 60_000

async function pullRequests(projectDir: string, repoUrl: string | null): Promise<any[]> {
  const repo = repoUrl?.match(/github\.com\/([^/]+\/[^/]+)$/)?.[1]
  if (!repo) return []
  const cached = pullRequestCache.get(projectDir)
  if (cached && Date.now() - cached.at < pullRequestCacheMs) return cached.value
  let value: any[] = []
  try {
    value = JSON.parse((await command(projectDir, "gh", ["pr", "list", "-R", repo, "--state", "all", "--json", "number,title,url,headRefName,state", "--limit", "100"])) || "[]")
  } catch {}
  pullRequestCache.set(projectDir, { at: Date.now(), value })
  return value
}

async function githubInfo(projectDir: string, meta: Record<string, string>, enabled: boolean) {
  const repoUrl = httpsRepoUrl(await command(projectDir, "git", ["remote", "get-url", "origin"]))
  if (!repoUrl && !meta["github.owner"]) return null
  const prs = enabled || repoUrl ? await pullRequests(projectDir, repoUrl) : []
  const owner = meta["github.owner"] ?? null
  const projectNumber = meta["github.project.number"] ?? null
  return {
    repoUrl,
    owner,
    epic: meta["github.epic"] ? Number(meta["github.epic"]) : null,
    projectUrl: owner && projectNumber ? `https://github.com/users/${owner}/projects/${projectNumber}` : null,
    pullRequests: prs.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, state: pr.state })),
  }
}

const deployCache = new Map<string, { at: number; value: DeployInfo }>()
const deployCacheMs = 10_000
const tunnelUrlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g

interface DeployInfo {
  url: string | null
  status: "live" | "starting" | "stopped" | "missing"
  appContainer: string
  tunnelContainer: string
  app: string
  tunnel: string
}

async function containerState(name: string): Promise<string> {
  return (await command(".", "docker", ["inspect", "-f", "{{.State.Status}}", name])).trim() || "missing"
}

// cloudflared logs to stderr, so both streams are read for the tunnel URL.
async function tunnelLogs(name: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", "--tail", "400", name], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    return `${stdout}${stderr}`
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`
  }
}

async function deployInfo(projectDir: string, metaUrl: string | null): Promise<DeployInfo> {
  const cached = deployCache.get(projectDir)
  if (cached && Date.now() - cached.at < deployCacheMs) return cached.value
  const slug = basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const appContainer = `agent-team-app-${slug}`
  const tunnelContainer = `agent-team-tunnel-${slug}`
  const [app, tunnel] = await Promise.all([containerState(appContainer), containerState(tunnelContainer)])
  const fromLogs = tunnel === "missing" ? null : ((await tunnelLogs(tunnelContainer)).match(tunnelUrlPattern)?.at(-1) ?? null)
  const url = fromLogs ?? (metaUrl || null)
  const status = app === "running" && tunnel === "running" ? (url ? "live" : "starting") : app === "missing" && tunnel === "missing" ? "missing" : "stopped"
  const value: DeployInfo = { url: status === "missing" ? null : url, status, appContainer, tunnelContainer, app, tunnel }
  deployCache.set(projectDir, { at: Date.now(), value })
  return value
}

function metaValue(projectDir: string, key: string): string | null {
  return withDatabase(projectDir, (db) => (all(db, "SELECT value FROM meta WHERE key = ?", key)[0]?.value as string | undefined) ?? null, null)
}

async function detail(runsDir: string, name: string) {
  const projectDir = join(runsDir, name)
  const taskDefinitions = new Map(readTasksFile(projectDir).map((task) => [task.id, task]))
  const state = withDatabase(
    projectDir,
    (db) => ({
      phases: all(db, `SELECT ${phaseNameColumn}, status, updated_at AS updatedAt FROM phases`),
      tasks: (() => {
        // Older state files may lack the newer columns; fall back step by step.
        const queries = [
          "SELECT id, status, attempts, last_failure AS lastFailure, issue_number AS issueNumber, human_reason AS needsHuman FROM tasks ORDER BY id",
          "SELECT id, status, attempts, last_failure AS lastFailure, issue_number AS issueNumber FROM tasks ORDER BY id",
          "SELECT id, status, attempts, last_failure AS lastFailure FROM tasks ORDER BY id",
        ]
        for (const query of queries) {
          const rows = all(db, query)
          if (rows.length) return rows
        }
        return []
      })(),
      meta: Object.fromEntries(all(db, "SELECT key, value FROM meta").filter((row) => !/^(github\.item|task\.files)\./.test(String(row.key))).map((row) => [row.key, row.value])),
      attempts: all(
        db,
        "SELECT id, subject, role, runner, model, status, failure_class AS failureClass, duration_ms AS durationMs, cost_usd AS costUsd, transcript_path AS transcriptPath, created_at AS createdAt FROM attempts ORDER BY id DESC LIMIT 300",
      ),
      events: all(db, "SELECT id, at, type, message FROM events ORDER BY id DESC LIMIT 300").reverse(),
      activeTime: activeTime(all(db, "SELECT at, type, message FROM events ORDER BY id")),
      cooldowns: all(db, "SELECT runner, cooldown_until AS until, reason FROM runner_health"),
      reviews: all(db, "SELECT task_id AS taskId, attempt, verdict, flagged_files AS flaggedFiles, file_hashes AS fileHashes FROM reviews ORDER BY id"),
      spend: all(db, "SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(cost_usd IS NULL), 0) AS unreportedCalls FROM attempts WHERE role != 'doctor'")[0] ?? { usd: 0, unreportedCalls: 0 },
    }),
    { phases: [], tasks: [], attempts: [], events: [], activeTime: { ms: 0, openSince: null } as ActiveTime, cooldowns: [], reviews: [], spend: { usd: 0, unreportedCalls: 0 }, meta: {} as Record<string, string> },
  )
  const definitionFields = (definition: any) => ({
    title: definition.title,
    phase: definition.phase ?? null,
    story: definition.story ?? null,
    dependsOn: definition.dependsOn ?? [],
    allowedPaths: definition.allowedPaths ?? [],
    readPaths: definition.readPaths ?? [],
    acceptance: definition.acceptance ?? [],
    verify: definition.verify ?? null,
  })
  const tasks = state.tasks.map((task: any) => {
    const definition = taskDefinitions.get(task.id) ?? {}
    return { issueNumber: null, needsHuman: null, ...task, ...definitionFields(definition), title: definition.title ?? task.id }
  })
  for (const [id, definition] of taskDefinitions) {
    if (!tasks.some((task: any) => task.id === id)) tasks.push({ id, status: "pending", attempts: 0, lastFailure: null, issueNumber: null, needsHuman: null, ...definitionFields(definition) })
  }
  const config = readConfig(projectDir)
  const attempts = state.attempts.map(({ transcriptPath, ...attempt }: any) => ({ ...attempt, transcript: String(transcriptPath ?? "").split("/").pop() }))
  const { meta, reviews, spend, ...stateWithoutMeta } = state
  const [github, gitLog, worktrees, dockerPs, deploy] = await Promise.all([
    githubInfo(projectDir, meta, Boolean(config?.publish.github.enabled)),
    command(projectDir, "git", ["log", "--oneline", "-30"]),
    command(projectDir, "git", ["worktree", "list"]),
    command(projectDir, "docker", ["ps", "--filter", "label=agent-team=1", "--format", "{{json .}}"]),
    deployInfo(projectDir, meta["deploy.url"] ?? null),
  ])
  const containers = dockerPs
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = JSON.parse(line)
        return { name: entry.Names, status: entry.Status, runningFor: entry.RunningFor }
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return {
    ...summary(runsDir, name),
    ...stateWithoutMeta,
    config,
    github,
    tasks,
    attempts,
    gitLog: gitLog.split("\n").filter(Boolean),
    worktrees: worktrees.split("\n").filter(Boolean),
    containers,
    deploy,
    qa: { round: meta["qa.round"] ? Number(meta["qa.round"]) : null },
    feedback: pendingFeedback(projectDir),
    budget: { runUsd: config?.budget.runUsd ?? defaultRunBudgetUsd, spentUsd: spend.usd, unreportedCalls: spend.unreportedCalls },
    reviewer: reviewerMetrics(reviews.map(parseReviewRow).filter((row: ReviewRow | null): row is ReviewRow => row !== null)),
  }
}

function parseStop(value: string | undefined): { outcome: string; kind: string; reason: string; at: string } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return typeof parsed?.reason === "string" ? { outcome: String(parsed.outcome), kind: parsed.kind === "budget" ? "budget" : "other", reason: parsed.reason, at: String(parsed.at) } : null
  } catch {
    return null
  }
}

function parseReviewRow(row: any): ReviewRow | null {
  try {
    return { taskId: row.taskId, attempt: row.attempt, verdict: row.verdict, flaggedFiles: JSON.parse(row.flaggedFiles), fileHashes: JSON.parse(row.fileHashes) }
  } catch {
    return null
  }
}

function defaultRoles() {
  const { roles } = loadConfig(examplePipelinePath)
  return Object.fromEntries(Object.entries(roles).map(([role, value]) => [role, { runner: value.runner, model: value.model, fallbacks: value.fallbacks }]))
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const buffer = Buffer.alloc(size - start)
  const handle = openSync(path, "r")
  try {
    readSync(handle, buffer, 0, buffer.length, start)
  } finally {
    closeSync(handle)
  }
  return (start > 0 ? "[earlier output truncated]\n" : "") + buffer.toString("utf8")
}

function send(response: ServerResponse, status: number, body: unknown, type = "application/json") {
  response.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" })
  response.end(typeof body === "string" ? body : JSON.stringify(body))
}

function serveStatic(response: ServerResponse, webDist: string, pathname: string) {
  const indexPath = join(webDist, "index.html")
  if (!existsSync(indexPath)) return send(response, 503, "The dashboard is not built. Run: npm run build:ui", "text/plain")
  const requested = resolve(webDist, `.${decodeURIComponent(pathname)}`)
  const inside = requested.startsWith(webDist)
  const isFile = inside && existsSync(requested) && statSync(requested).isFile()
  const path = isFile ? requested : indexPath
  const type = staticTypes[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"
  const immutable = isFile && path.startsWith(join(webDist, "assets") + sep)
  response.writeHead(200, { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store", "x-content-type-options": "nosniff" })
  response.end(readFileSync(path))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  // Drains the whole body even when too large, so the client reads the 413 instead of a reset connection.
  for await (const chunk of request) {
    size += chunk.length
    if (size <= bodyMaxBytes) chunks.push(chunk)
  }
  if (size > bodyMaxBytes) throw new ProjectError(413, "The request body is larger than 64 KB.")
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProjectError(400, "The request body is not valid JSON.")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProjectError(400, "The request body must be a JSON object.")
  return parsed as Record<string, unknown>
}

function parseChoices(body: Record<string, unknown>): { name: string; brief: string; choices: ProjectChoices } {
  const { name, brief, target, workerRunner, github, deploy } = body
  const branding = body.branding ?? body.mockups
  const gates = Array.isArray(body.gates) ? body.gates.map((gate) => (typeof gate === "string" ? normalizePhaseName(gate) : gate)) : body.gates
  if (typeof name !== "string" || !newProjectNamePattern.test(name)) {
    throw new ProjectError(400, "The name must be 2 to 41 characters: lowercase letters, digits, and dashes, starting with a letter or digit.")
  }
  if (typeof brief !== "string" || !brief.trim()) throw new ProjectError(400, "The brief is empty.")
  if (typeof target !== "string" || !targets.includes(target)) throw new ProjectError(400, "The target must be web, api, or web+api.")
  if (typeof workerRunner !== "string" || !(runnerNames as readonly string[]).includes(workerRunner)) throw new ProjectError(400, "The worker provider must be claude or codex.")
  if (!Array.isArray(gates) || !gates.every((gate) => (planningPhases as readonly unknown[]).includes(gate))) {
    throw new ProjectError(400, `Each gate must be one of ${planningPhases.join(", ")}.`)
  }
  for (const [field, value] of Object.entries({ github, deploy, branding })) {
    if (typeof value !== "boolean") throw new ProjectError(400, `The ${field} field must be true or false.`)
  }
  return {
    name,
    brief,
    choices: {
      target: target as ProjectChoices["target"],
      workerRunner: workerRunner as ProjectChoices["workerRunner"],
      gates: [...new Set(gates as PlanningPhase[])],
      github: github as boolean,
      deploy: deploy as boolean,
      branding: branding as boolean,
    },
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || !value.trim()) throw new ProjectError(400, `The ${field} field is required.`)
  return value
}

export interface UiOptions {
  runsDir: string
  port: number
  startRun?: (projectDir: string, logPath: string) => void
  webDir?: string
}

export function startUi(options: UiOptions) {
  const runsDir = resolve(options.runsDir)
  const webDist = options.webDir ? resolve(options.webDir) + sep : builtWebDir
  const knownProject = (name: string) => projectNamePattern.test(name) && existsSync(join(runsDir, name, "pipeline.yaml"))
  const launchRun = options.startRun ?? spawnRun
  const extraHosts = (process.env.AGENT_TEAM_UI_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)
  const startRunIfIdle = (name: string) => {
    const projectDir = join(runsDir, name)
    if (runAlive(projectDir)) return false
    launchRun(projectDir, runLogPath(runsDir, name))
    return true
  }

  async function handlePost(request: IncomingMessage, response: ServerResponse, parts: string[]) {
    if (request.headers["x-agent-team"] !== "1") return send(response, 403, { error: "The x-agent-team header is missing." })
    const body = await readJson(request)
    if (parts[0] !== "api" || parts[1] !== "projects") return send(response, 404, { error: "not found" })

    if (parts.length === 2) {
      const { name, brief, choices } = parseChoices(body)
      if (existsSync(join(runsDir, name))) return send(response, 409, { error: `A project named "${name}" already exists.` })
      createProject(join(runsDir, name), brief, choices)
      startRunIfIdle(name)
      return send(response, 201, { name })
    }

    const name = parts[2]
    if (!knownProject(name) || parts.length !== 4) return send(response, 404, { error: "unknown project" })
    const projectDir = join(runsDir, name)
    switch (parts[3]) {
      case "run":
        if (!startRunIfIdle(name)) return send(response, 409, { error: "A run is already in progress." })
        return send(response, 202, { started: true })
      case "approve":
        withProjectStore(projectDir, (store) => approvePhase(projectDir, store, requireString(body, "phase")))
        return send(response, 200, { started: startRunIfIdle(name) })
      case "feedback": {
        const phase = requireString(body, "phase")
        const message = requireString(body, "message")
        withProjectStore(projectDir, (store) => requestChanges(projectDir, store, phase, message))
        return send(response, 200, { started: startRunIfIdle(name) })
      }
      case "retry":
        withProjectStore(projectDir, (store) => retryTask(store, requireString(body, "taskId")))
        return send(response, 200, { started: startRunIfIdle(name) })
      case "raise-budget": {
        if (runAlive(projectDir)) return send(response, 409, { error: "A run is already in progress." })
        const runUsd = withProjectStore(projectDir, (store) => raiseRunBudget(projectDir, store))
        return send(response, 200, { runUsd, started: startRunIfIdle(name) })
      }
      default:
        return send(response, 404, { error: "not found" })
    }
  }

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (!allowedHost(request, extraHosts)) return send(response, 403, { error: "This host name is not allowed. Add it to AGENT_TEAM_UI_HOSTS." })
      const url = new URL(request.url ?? "/", "http://localhost")
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
      if (request.method === "POST") return await handlePost(request, response, parts)
      if (request.method !== "GET") return send(response, 405, { error: "method not allowed" })
      if (parts[0] !== "api") return serveStatic(response, webDist, url.pathname)

      if (parts[0] === "api" && parts[1] === "defaults" && parts.length === 2) return send(response, 200, { roles: defaultRoles() })
      if (parts[0] === "api" && parts[1] === "incidents" && parts.length === 2) return send(response, 200, allIncidents(runsDir))
      if (parts[0] === "api" && parts[1] === "incidents" && parts.length === 4) {
        if (!knownProject(parts[2])) return send(response, 404, { error: "unknown project" })
        const incident = incidentDetail(runsDir, parts[2], parts[3])
        return incident ? send(response, 200, incident) : send(response, 404, { error: "unknown incident" })
      }
      if (parts[0] === "api" && parts[1] === "projects" && parts.length === 2) {
        const names = listProjects(runsDir)
        const deploys = await Promise.all(names.map((name) => deployInfo(join(runsDir, name), metaValue(join(runsDir, name), "deploy.url"))))
        return send(response, 200, names.map((name, index) => ({ ...summary(runsDir, name), live: deploys[index].status === "live", liveUrl: deploys[index].url })))
      }
      if (parts[0] === "api" && parts[1] === "projects" && parts[2]) {
        const name = parts[2]
        if (!knownProject(name)) return send(response, 404, { error: "unknown project" })
        const projectDir = join(runsDir, name)
        if (parts.length === 3) return send(response, 200, await detail(runsDir, name))
        if (parts[3] === "transcript" && parts[4] && parts.length === 5) {
          if (!transcriptNamePattern.test(parts[4])) return send(response, 400, { error: "bad file name" })
          const path = join(projectDir, ".agent-team", "transcripts", parts[4])
          if (!existsSync(path)) return send(response, 404, { error: "not found" })
          return send(response, 200, readTail(path, transcriptMaxBytes), "text/plain")
        }
        if (parts[3] === "markdown" && parts.length === 4) return send(response, 200, listMarkdown(projectDir))
        if (parts[3] === "raw" && parts.length === 4) {
          const relative = url.searchParams.get("path") ?? ""
          const extension = relative.split(".").pop()?.toLowerCase() ?? ""
          const type = rawImageTypes[extension]
          const hidden = relative.split(/[\\/]/).some((segment) => ignoredDirectories.has(segment))
          if (!type || !resolve(projectDir, relative).startsWith(projectDir + sep) || hidden) return send(response, 400, { error: "path not allowed" })
          const path = projectFile(projectDir, relative)
          if (!path || !statSync(path).isFile() || statSync(path).size > imageMaxBytes) return send(response, 404, { error: "not found" })
          response.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" })
          return response.end(readFileSync(path))
        }
        const brandingRoute = parts[3] === "branding" || parts[3] === "mockups"
        if (brandingRoute && parts.length === 4) {
          const dir = brandingDirectory(projectDir)
          const images = dir ? readdirSync(join(projectDir, dir)).filter((file) => brandingImagePattern.test(file)).sort() : []
          return send(response, 200, images)
        }
        if (brandingRoute && parts[4] && parts.length === 5) {
          if (!brandingImagePattern.test(parts[4])) return send(response, 400, { error: "bad file name" })
          const dir = brandingDirectory(projectDir)
          const path = dir ? projectFile(projectDir, join(dir, parts[4])) : null
          if (!path || statSync(path).size > imageMaxBytes) return send(response, 404, { error: "not found" })
          const extension = parts[4].split(".").pop()!.toLowerCase()
          response.writeHead(200, { "content-type": `image/${extension === "jpg" ? "jpeg" : extension}`, "cache-control": "no-store" })
          return response.end(readFileSync(path))
        }
        if (parts[3] === "qa" && parts.length === 4) return send(response, 200, qaRounds(projectDir))
        if (parts[3] === "qa" && parts.length === 6) {
          const [round, file] = [parts[4], parts[5]]
          const isImage = qaImagePattern.test(file)
          if (!qaRoundPattern.test(round) || (!isImage && !qaJsonFiles.includes(file))) return send(response, 400, { error: "bad file name" })
          const path = projectFile(projectDir, join(qaRoundPath(round), file))
          if (!path || !statSync(path).isFile() || statSync(path).size > imageMaxBytes) return send(response, 404, { error: "not found" })
          response.writeHead(200, { "content-type": isImage ? "image/png" : "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" })
          return response.end(readFileSync(path))
        }
        if (parts[3] === "file" && parts.length === 4) {
          const relative = url.searchParams.get("path") ?? ""
          const inside = resolve(projectDir, relative).startsWith(projectDir + sep)
          const hidden = relative.split(/[\\/]/).some((segment) => ignoredDirectories.has(segment))
          if (!relative || !inside || hidden) return send(response, 400, { error: "path not allowed" })
          const path = projectFile(projectDir, relative)
          if (!path || !statSync(path).isFile()) return send(response, 404, { error: "not found" })
          if (statSync(path).size > artifactMaxBytes) return send(response, 413, { error: "file too large" })
          return send(response, 200, readFileSync(path, "utf8"), "text/plain")
        }
      }
      if (parts[0] === "api" && parts[1] === "stream" && parts[2] && parts.length === 3) {
        const name = parts[2]
        if (!knownProject(name)) return send(response, 404, { error: "unknown project" })
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
        let previous = ""
        let closed = false
        let pushing = false
        const push = async () => {
          if (closed || pushing) return
          pushing = true
          try {
            const snapshot = JSON.stringify(await detail(runsDir, name))
            if (closed) return
            if (snapshot !== previous) {
              previous = snapshot
              response.write(`data: ${snapshot}\n\n`)
            } else {
              response.write(": ping\n\n")
            }
          } catch (error) {
            if (!closed) response.write(`: error ${String((error as Error).message).replace(/\n/g, " ")}\n\n`)
          } finally {
            pushing = false
          }
        }
        const timer = setInterval(push, 2000)
        request.on("close", () => {
          closed = true
          clearInterval(timer)
        })
        await push()
        return
      }
      send(response, 404, { error: "not found" })
    } catch (error) {
      if (response.headersSent) return
      if (error instanceof ProjectError) return send(response, error.status, { error: error.message })
      if (error instanceof URIError) return send(response, 400, { error: "The URL is not valid." })
      send(response, 500, { error: (error as Error).message })
    }
  })
  server.listen(options.port, "127.0.0.1", () => {
    console.log(`agent-team ui on http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port} watching ${runsDir}`)
  })
  return server
}
