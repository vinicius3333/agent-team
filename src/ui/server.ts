import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"
import { parse as parseYaml } from "yaml"

const execFileAsync = promisify(execFile)
const pagePath = new URL("./index.html", import.meta.url)
const transcriptMaxBytes = 200 * 1024
const artifactMaxBytes = 500 * 1024
const mockupMaxBytes = 20 * 1024 * 1024
const mockupPattern = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/
const activeWindowMs = 2 * 60_000
const projectNamePattern = /^[A-Za-z0-9._-]+$/
const transcriptNamePattern = /^[A-Za-z0-9._-]+\.log$/

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

function projectDirs(runsDir: string): string[] {
  if (!existsSync(runsDir)) return []
  return readdirSync(runsDir)
    .filter((name) => projectNamePattern.test(name))
    .filter((name) => existsSync(join(runsDir, name, "pipeline.yaml")))
    .sort()
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
      const phases = all(db, "SELECT name, status FROM phases")
      const counts: Record<string, number> = {}
      for (const row of all(db, "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")) counts[row.status] = row.count
      const lastEvent = all(db, "SELECT at, type, message FROM events ORDER BY id DESC LIMIT 1")[0] ?? null
      const running = all(db, "SELECT id FROM tasks WHERE status = 'running' LIMIT 1")[0]?.id ?? null
      const activePhase = phases.find((phase) => phase.status === "running")?.name ?? null
      const pidRow = all(db, "SELECT value FROM meta WHERE key = 'run.pid'")[0]
      const active = pidRow ? processAlive(Number(pidRow.value)) : Boolean(lastEvent && Date.now() - Date.parse(lastEvent.at) < activeWindowMs && !/^finished/.test(lastEvent.message))
      return { name, phases, counts, lastEvent, current: running ?? activePhase, active }
    },
    { name, phases: [], counts: {}, lastEvent: null, current: null, active: false },
  )
}

async function command(cwd: string, file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch {
    return ""
  }
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
      gates: raw.autonomy?.gates ?? [],
      roles,
      mockups: raw.mockups ?? null,
      publish: { github: { enabled: Boolean(raw.publish?.github?.enabled) } },
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

async function detail(runsDir: string, name: string) {
  const projectDir = join(runsDir, name)
  const taskDefinitions = new Map(readTasksFile(projectDir).map((task) => [task.id, task]))
  const state = withDatabase(
    projectDir,
    (db) => ({
      phases: all(db, "SELECT name, status, updated_at AS updatedAt FROM phases"),
      tasks: (() => {
        const withIssue = all(db, "SELECT id, status, attempts, last_failure AS lastFailure, issue_number AS issueNumber FROM tasks ORDER BY id")
        return withIssue.length ? withIssue : all(db, "SELECT id, status, attempts, last_failure AS lastFailure FROM tasks ORDER BY id")
      })(),
      meta: Object.fromEntries(all(db, "SELECT key, value FROM meta").filter((row) => !String(row.key).startsWith("github.item.")).map((row) => [row.key, row.value])),
      attempts: all(
        db,
        "SELECT id, subject, role, runner, model, status, failure_class AS failureClass, duration_ms AS durationMs, cost_usd AS costUsd, transcript_path AS transcriptPath, created_at AS createdAt FROM attempts ORDER BY id DESC LIMIT 300",
      ),
      events: all(db, "SELECT id, at, type, message FROM events ORDER BY id DESC LIMIT 300").reverse(),
      cooldowns: all(db, "SELECT runner, cooldown_until AS until, reason FROM runner_health"),
    }),
    { phases: [], tasks: [], attempts: [], events: [], cooldowns: [], meta: {} as Record<string, string> },
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
    return { issueNumber: null, ...task, ...definitionFields(definition), title: definition.title ?? task.id }
  })
  for (const [id, definition] of taskDefinitions) {
    if (!tasks.some((task: any) => task.id === id)) tasks.push({ id, status: "pending", attempts: 0, lastFailure: null, issueNumber: null, ...definitionFields(definition) })
  }
  const config = readConfig(projectDir)
  const attempts = state.attempts.map(({ transcriptPath, ...attempt }: any) => ({ ...attempt, transcript: String(transcriptPath ?? "").split("/").pop() }))
  const { meta, ...stateWithoutMeta } = state
  const [github, gitLog, worktrees, dockerPs] = await Promise.all([
    githubInfo(projectDir, meta, Boolean(config?.publish.github.enabled)),
    command(projectDir, "git", ["log", "--oneline", "-30"]),
    command(projectDir, "git", ["worktree", "list"]),
    command(projectDir, "docker", ["ps", "--filter", "label=agent-team=1", "--format", "{{json .}}"]),
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
  }
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

export function startUi(options: { runsDir: string; port: number }) {
  const runsDir = resolve(options.runsDir)
  const knownProject = (name: string) => projectNamePattern.test(name) && existsSync(join(runsDir, name, "pipeline.yaml"))

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost")
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
      if (request.method !== "GET") return send(response, 405, { error: "read-only" })

      if (parts.length === 0) return send(response, 200, readFileSync(pagePath, "utf8"), "text/html")
      if (parts[0] === "api" && parts[1] === "projects" && parts.length === 2) {
        return send(response, 200, projectDirs(runsDir).map((name) => summary(runsDir, name)))
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
        if (parts[3] === "mockups" && parts.length === 4) {
          const dir = join(projectDir, "design", "mockups")
          const images = existsSync(dir) ? readdirSync(dir).filter((file) => mockupPattern.test(file)).sort() : []
          return send(response, 200, images)
        }
        if (parts[3] === "mockups" && parts[4] && parts.length === 5) {
          if (!mockupPattern.test(parts[4])) return send(response, 400, { error: "bad file name" })
          const path = join(projectDir, "design", "mockups", parts[4])
          if (!existsSync(path) || statSync(path).size > mockupMaxBytes) return send(response, 404, { error: "not found" })
          const extension = parts[4].split(".").pop()!.toLowerCase()
          response.writeHead(200, { "content-type": `image/${extension === "jpg" ? "jpeg" : extension}`, "cache-control": "no-store" })
          return response.end(readFileSync(path))
        }
        if (parts[3] === "file" && parts.length === 4) {
          const relative = url.searchParams.get("path") ?? ""
          const path = resolve(projectDir, relative)
          const inside = path.startsWith(projectDir + sep)
          const hidden = relative.split(/[\\/]/).some((segment) => segment === ".git" || segment === ".agent-team" || segment === "node_modules")
          if (!relative || !inside || hidden) return send(response, 400, { error: "path not allowed" })
          if (!existsSync(path) || !statSync(path).isFile()) return send(response, 404, { error: "not found" })
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
        const push = async () => {
          if (closed) return
          const snapshot = JSON.stringify(await detail(runsDir, name))
          if (snapshot !== previous && !closed) {
            previous = snapshot
            response.write(`data: ${snapshot}\n\n`)
          } else if (!closed) {
            response.write(": ping\n\n")
          }
        }
        await push()
        const timer = setInterval(push, 2000)
        request.on("close", () => {
          closed = true
          clearInterval(timer)
        })
        return
      }
      send(response, 404, { error: "not found" })
    } catch (error) {
      if (!response.headersSent) send(response, 500, { error: (error as Error).message })
    }
  })
  server.listen(options.port, "127.0.0.1", () => {
    console.log(`agent-team ui on http://127.0.0.1:${options.port} watching ${runsDir}`)
  })
  return server
}
