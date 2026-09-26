import { execFileSync } from "node:child_process"
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parse } from "yaml"
import { loadConfig, runnerNames, type PipelineConfig, type RoleConfig } from "./config.ts"
import { createGitHub } from "./github.ts"
import type { Executor } from "./harness/executor.ts"
import { createHarness, type Harness } from "./harness/harness.ts"
import { createWorkspace, removeWorkspace, type Workspace } from "./harness/workspace.ts"
import { fingerprint, incidentCauses, incidentId, listIncidents, saveIncident, subjectOf, type Incident, type IncidentCause, type IncidentKind } from "./incidents.ts"
import { extractJsonObject } from "./json.ts"
import { cooldownPattern, incidentGaveUpText, incidentOpenedPrefix } from "./notify/events.ts"
import { startNotificationLoop } from "./notify/index.ts"
import { createExecutor, landingBranch, landTasksFile, runAgent, type PipelineContext, type RunStop } from "./pipeline.ts"
import { cliPath, installDir as liveInstallDir, listProjects, openProjectStore, processAlive, retryTask, runAlive, runLogPath, startRun, withProjectStore } from "./project.ts"
import { operateTick } from "./operate/tick.ts"
import { sprintTick } from "./sprint.ts"
import { decideReplan } from "./replan.ts"
import type { Store } from "./store.ts"
import { loadTasks } from "./tasks.ts"

export interface DoctorConfig {
  stallMinutes: number
  maxAttempts: number
  maxUsdPerIncident: number
  sourceDir: string
  // owner/name of the agent-team repo; null = read from the source clone's origin.
  repo: string | null
  // Merge the doctor's pull request once the resumed run gets past the failing point.
  autoMerge: boolean
  role: RoleConfig
}

export function loadDoctorConfig(runsDir: string): DoctorConfig {
  const path = join(runsDir, "doctor.yaml")
  const raw = existsSync(path) ? (parse(readFileSync(path, "utf8")) ?? {}) : {}
  const config: DoctorConfig = {
    stallMinutes: raw.stallMinutes ?? 45,
    maxAttempts: raw.maxAttempts ?? 3,
    maxUsdPerIncident: raw.maxUsdPerIncident ?? 15,
    sourceDir: expandHome(raw.sourceDir ?? "~/agent-team-src"),
    repo: raw.repo ?? null,
    autoMerge: raw.autoMerge ?? true,
    role: { runner: raw.role?.runner ?? "claude", model: raw.role?.model ?? "opus", fallbacks: raw.role?.fallbacks ?? [] },
  }
  const errors: string[] = []
  if (!(config.stallMinutes > 0)) errors.push("stallMinutes must be a number above 0")
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) errors.push("maxAttempts must be a whole number of 1 or more")
  if (!(config.maxUsdPerIncident > 0)) errors.push("maxUsdPerIncident must be a number above 0")
  if (typeof config.autoMerge !== "boolean") errors.push("autoMerge must be true or false")
  if (!runnerNames.includes(config.role.runner)) errors.push(`role.runner must be one of ${runnerNames.join(", ")}`)
  if (errors.length) throw new Error(`Invalid ${path}:\n- ${errors.join("\n- ")}`)
  return config
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path)
}

// ---------- Detection ----------

export type Detection =
  | { kind: "none"; reason: string }
  // A decision for the user: open an issue once, do not act.
  | { kind: "notice"; fingerprint: string; reason: string }
  // A runner cooldown has passed: resume once before calling it an incident.
  | { kind: "cooldown_resume"; fingerprint: string; reason: string }
  // The run process died without a stop record (killed by a redeploy, OOM, host restart): resume once before calling it an incident.
  | { kind: "crash_resume"; fingerprint: string; reason: string }
  | { kind: "incident"; incidentKind: IncidentKind; fingerprint: string; reason: string }

const cooldownResumeKey = "doctor.cooldownResume"
const crashResumeKey = "doctor.crashResume"
// An agent call may run this long past its timeout before the run counts as stalled (container teardown, retries).
const stallGraceMs = 5 * 60_000

export function readStop(store: Store): RunStop | null {
  const value = store.meta("run.stop")
  if (!value) return null
  try {
    return JSON.parse(value) as RunStop
  } catch {
    return null
  }
}

const legacyScanEvents = 500

export function detect(projectDir: string, store: Store, config: DoctorConfig, now = Date.now()): Detection {
  const lastEvent = store.lastEvent()
  if (!lastEvent) return { kind: "none", reason: "never ran" }
  const coolingDown = store.runnerHealth().some((entry) => entry.until > now)

  if (runAlive(projectDir)) {
    let pipeline: PipelineConfig
    try {
      pipeline = loadConfig(join(projectDir, "pipeline.yaml"))
    } catch {
      return { kind: "none", reason: "pipeline.yaml does not load" }
    }
    const lastActivity = Math.max(Date.parse(lastEvent.at), Date.parse(store.lastAttemptAt() ?? lastEvent.at))
    const thresholdMs = Math.max(config.stallMinutes * 60_000, pipeline.harness.agentTimeoutMs + stallGraceMs)
    if (coolingDown || now - lastActivity < thresholdMs) return { kind: "none", reason: "running" }
    const reason = `the run logged nothing for ${Math.round((now - lastActivity) / 60_000)} min; last event: [${lastEvent.type}] ${lastEvent.message.split("\n")[0].slice(0, 300)}`
    return { kind: "incident", incidentKind: "stalled", fingerprint: fingerprint("stalled", `[${lastEvent.type}] ${lastEvent.message.split("\n")[0]}`), reason }
  }

  const stop = readStop(store)
  if (!stop) {
    if (/^finished: completed/.test(lastEvent.message)) return { kind: "none", reason: "completed" }
    if (store.phases().some((phase) => phase.status === "awaiting_approval")) return { kind: "none", reason: "waiting at a gate" }
    // Every run resets run.stop to "" when it starts, so only a project that never had the key predates the doctor.
    // Those runs end with a "finished:" event; commands such as deploy may log after it.
    const predatesDoctor = store.meta("run.stop") === null
    if (predatesDoctor && store.recentEvents(legacyScanEvents).some((event) => event.type === "run" && event.message.startsWith("finished:"))) return { kind: "none", reason: "stopped before the doctor existed" }
    const reason = `the run process died without recording why (a redeploy, a crash, or the host restarting); last event: [${lastEvent.type}] ${lastEvent.message.split("\n")[0].slice(0, 300)}`
    const crashFingerprint = fingerprint("crashed", `[${lastEvent.type}] ${lastEvent.message.split("\n")[0]}`)
    if (store.meta(crashResumeKey) !== crashFingerprint) return { kind: "crash_resume", fingerprint: crashFingerprint, reason }
    return { kind: "incident", incidentKind: "crashed", fingerprint: crashFingerprint, reason }
  }
  if (operatorStopped(store)) return { kind: "none", reason: "stopped by the operator" }

  if (stop.outcome === "awaiting_approval") {
    if (store.phases().some((phase) => phase.status === "awaiting_approval")) return { kind: "none", reason: "waiting at a gate" }
    return { kind: "notice", fingerprint: fingerprint("paused", stop.reason), reason: stop.reason }
  }

  const incidentKind: IncidentKind = stop.outcome === "failed" ? "failed" : "paused"
  const stopFingerprint = fingerprint(incidentKind, stop.reason)
  if (incidentKind === "paused" && cooldownPattern.test(stop.reason)) {
    if (coolingDown) return { kind: "none", reason: "a runner is cooling down" }
    if (store.meta(cooldownResumeKey) !== stopFingerprint) return { kind: "cooldown_resume", fingerprint: stopFingerprint, reason: stop.reason }
  }
  return { kind: "incident", incidentKind, fingerprint: stopFingerprint, reason: stop.reason }
}

// Ctrl+C or a dashboard stop logs "interrupt received" just before the run finishes.
function operatorStopped(store: Store): boolean {
  const recent = store.recentEvents(20)
  const finished = recent.findIndex((event) => event.type === "run" && event.message.startsWith("finished:"))
  const interrupt = recent.findIndex((event) => event.type === "run" && event.message.startsWith("interrupt received"))
  return interrupt !== -1 && (finished === -1 || interrupt > finished)
}

// ---------- The doctor's answer ----------

export type ProjectAction =
  | { action: "retry"; taskId: string }
  | { action: "reset_cooldowns" }
  | { action: "resume" }
  | { action: "edit_task"; taskId: string; allowedPaths: string[] }

export interface DoctorReport {
  diagnosis: string
  cause: IncidentCause
  projectActions: ProjectAction[]
  codeFix: boolean
  summary: string
}

export function parseDoctorReport(text: string): DoctorReport {
  const parsed = extractJsonObject(text) as any
  const errors: string[] = []
  if (typeof parsed?.diagnosis !== "string" || !parsed.diagnosis.trim()) errors.push("diagnosis must be a non-empty string")
  if (!incidentCauses.includes(parsed?.cause)) errors.push(`cause must be one of ${incidentCauses.join(", ")}`)
  if (typeof parsed?.codeFix !== "boolean") errors.push("codeFix must be true or false")
  if (typeof parsed?.summary !== "string") errors.push("summary must be a string")
  const actions = parsed?.projectActions ?? []
  if (!Array.isArray(actions)) errors.push("projectActions must be an array")
  else {
    for (const [index, action] of actions.entries()) {
      const problem = actionProblem(action)
      if (problem) errors.push(`projectActions[${index}]: ${problem}`)
    }
  }
  if (errors.length) throw new Error(`invalid doctor report:\n- ${errors.join("\n- ")}`)
  return { diagnosis: parsed.diagnosis.trim(), cause: parsed.cause, projectActions: actions, codeFix: parsed.codeFix, summary: parsed.summary.trim() }
}

function actionProblem(action: any): string | null {
  const hasTaskId = typeof action?.taskId === "string" && action.taskId.trim() !== ""
  switch (action?.action) {
    case "reset_cooldowns":
    case "resume":
      return null
    case "retry":
      return hasTaskId ? null : "retry needs a taskId"
    case "edit_task":
      if (!hasTaskId) return "edit_task needs a taskId"
      if (!Array.isArray(action.allowedPaths) || !action.allowedPaths.length || !action.allowedPaths.every((path: unknown) => typeof path === "string" && path)) {
        return "edit_task needs a non-empty allowedPaths list of strings"
      }
      return null
    default:
      return "action must be retry, reset_cooldowns, resume, or edit_task"
  }
}

// ---------- Dependencies, replaced by stubs in tests ----------

export interface CommandResult {
  passed: boolean
  output: string
}

export interface DoctorDeps {
  // Runs the gh CLI on the host and returns stdout; throws on failure.
  gh: (args: string[], cwd: string, input?: string) => string
  createHarness: (store: Store, pipeline: PipelineConfig, signal: AbortSignal) => Harness
  // Runs a check (npm ci, tsc, tests) for a code fix inside the executor.
  runCommand: (executor: Executor, command: string, transcriptPath: string, signal: AbortSignal) => Promise<CommandResult>
  startRun: (projectDir: string, logPath: string) => void
  // The live install the runs use; hotfixes are copied here.
  installDir: string
}

const checkTimeoutMs = 15 * 60_000

export const defaultDoctorDeps: DoctorDeps = {
  gh: (args, cwd, input) => execFileSync("gh", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(),
  createHarness: (store, pipeline, signal) => createHarness({ config: pipeline.harness, store, signal }),
  runCommand: async (executor, command, transcriptPath, signal) => {
    const result = await executor.exec({ command: "sh", args: ["-c", command], input: "", timeoutMs: checkTimeoutMs, transcriptPath, signal })
    const output = `${result.stdout}\n${result.stderr}`.slice(-4000)
    if (result.timedOut) return { passed: false, output: `timed out after ${checkTimeoutMs / 60_000} min\n${output}` }
    return { passed: result.exitCode === 0 && !result.aborted, output }
  },
  startRun: (projectDir, logPath) => void startRun(projectDir, logPath),
  installDir: liveInstallDir,
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim()
}

function errorText(error: unknown): string {
  const failure = error as { stderr?: string; message?: string }
  return String(failure.stderr || failure.message || error).trim()
}

// ---------- GitHub issues on the agent-team repo ----------

// Best effort: a failed gh call is logged in the project and the doctor goes on.
function createNotifier(deps: DoctorDeps, repo: string, cwd: string, store: Store) {
  const attempt = <T>(what: string, action: () => T): T | null => {
    try {
      return action()
    } catch (error) {
      store.log("doctor", `${what} failed: ${errorText(error).slice(0, 300)}`)
      return null
    }
  }
  let labelReady = false
  return {
    openIssue(title: string, body: string): string | null {
      if (!labelReady) {
        attempt("create the incident label", () => deps.gh(["label", "create", "incident", "--color", "d93f0b", "--description", "Opened by the agent-team doctor", "--force", "-R", repo], cwd))
        labelReady = true
      }
      return attempt(`open issue "${title}"`, () => deps.gh(["issue", "create", "-R", repo, "--title", title, "--label", "incident", "--body-file", "-"], cwd, body))
    },
    comment(issueUrl: string | null, body: string): void {
      if (issueUrl) attempt("comment on the incident issue", () => deps.gh(["issue", "comment", issueUrl, "--body-file", "-"], cwd, body))
    },
    close(issueUrl: string | null, body: string): void {
      if (issueUrl) attempt("close the incident issue", () => deps.gh(["issue", "close", issueUrl, "--comment", body], cwd))
    },
    pullRequest(url: string): { state: "OPEN" | "CLOSED" | "MERGED"; base: string } | null {
      const viewed = attempt("read the doctor pull request", () => deps.gh(["pr", "view", url, "--json", "state,baseRefName"], cwd))
      try {
        const { state, baseRefName } = JSON.parse(viewed ?? "") as { state: "OPEN" | "CLOSED" | "MERGED"; baseRefName: string }
        return { state, base: baseRefName }
      } catch {
        return null
      }
    },
    // Returns why the merge failed, or null when it merged.
    merge(url: string): string | null {
      try {
        deps.gh(["pr", "merge", url, "--merge", "--delete-branch"], cwd)
        return null
      } catch (error) {
        return errorText(error).slice(0, 500)
      }
    },
    openDoctorPullRequests(): { branch: string; url: string; files: string[] }[] {
      const listed = attempt("list open doctor pull requests", () => deps.gh(["pr", "list", "-R", repo, "--state", "open", "--json", "headRefName,url,files", "--limit", "50"], cwd))
      try {
        return (JSON.parse(listed || "[]") as { headRefName: string; url: string; files?: { path: string }[] }[])
          .filter((pr) => pr.headRefName.startsWith("doctor/"))
          .map((pr) => ({ branch: pr.headRefName, url: pr.url, files: (pr.files ?? []).map((file) => file.path) }))
      } catch {
        return []
      }
    },
  }
}

type Notifier = ReturnType<typeof createNotifier>

const silentNotifier: Notifier = { openIssue: () => null, comment: () => {}, close: () => {}, pullRequest: () => null, merge: () => "GitHub is not available", openDoctorPullRequests: () => [] }

function block(text: string, max = 3000): string {
  return ["```", text.trim().slice(0, max), "```"].join("\n")
}

// ---------- The source clone and the doctor's workspace ----------

function repoFromRemote(remote: string): string {
  const match = remote.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)
  return match ? match[1] : remote.trim()
}

export function prepareSourceClone(config: DoctorConfig, deps: DoctorDeps): { sourceDir: string; repo: string } {
  const { sourceDir } = config
  if (!existsSync(join(sourceDir, ".git"))) {
    if (!config.repo) throw new Error(`${sourceDir} is not a git clone; set repo in doctor.yaml so the doctor can clone it`)
    mkdirSync(dirname(sourceDir), { recursive: true })
    deps.gh(["repo", "clone", config.repo, sourceDir], dirname(sourceDir))
  }
  git(sourceDir, ["fetch", "-q", "--prune", "origin"])
  const exclude = join(sourceDir, ".git", "info", "exclude")
  const excluded = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
  if (!excluded.split("\n").includes(".incident/")) {
    mkdirSync(dirname(exclude), { recursive: true })
    appendFileSync(exclude, `${excluded && !excluded.endsWith("\n") ? "\n" : ""}.incident/\n.agent-team/\n`)
  }
  return { sourceDir, repo: config.repo ?? repoFromRemote(git(sourceDir, ["remote", "get-url", "origin"])) }
}

const evidenceDir = ".incident"
const logTailLines = 300
const transcriptCount = 6

function tailLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n")
}

function subjectPrefix(subject: string | null): string | null {
  if (!subject) return null
  if (subject === "qa") return "qa-"
  if (subject === "deploy") return "deploy-"
  if (/^[a-z]+$/.test(subject)) return `phase-${subject}-`
  return `${subject}-`
}

// Writes the evidence the doctor reads, then makes it read-only.
export function writeEvidence(options: { dir: string; runsDir: string; name: string; projectDir: string; store: Store; incident: Incident }): void {
  const { dir, projectDir, store, incident } = options
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, "transcripts"), { recursive: true })
  const logPath = runLogPath(options.runsDir, options.name)
  writeFileSync(join(dir, "run.log"), existsSync(logPath) ? tailLines(readFileSync(logPath, "utf8"), logTailLines) : "(no run log file)\n")
  writeFileSync(join(dir, "events.log"), store.recentEvents(logTailLines).reverse().map((event) => `${event.at} [${event.type}] ${event.message}`).join("\n"))
  writeFileSync(join(dir, "stop.txt"), `Kind: ${incident.kind}\nSubject: ${incident.subject ?? "unknown"}\n\n${incident.reason}\n`)
  let status: string
  try {
    status = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cliPath, "status", projectDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    status = `agent-team status failed: ${errorText(error)}`
  }
  writeFileSync(join(dir, "status.txt"), status)
  for (const file of ["tasks.json", "pipeline.yaml"]) {
    if (existsSync(join(projectDir, file))) copyFileSync(join(projectDir, file), join(dir, file))
  }
  const byPrefix = store.recentAttempts(subjectPrefix(incident.subject), transcriptCount + 10).filter((attempt) => attempt.role !== "doctor")
  const attempts = (byPrefix.length ? byPrefix : store.recentAttempts(null, transcriptCount + 10).filter((attempt) => attempt.role !== "doctor")).slice(0, transcriptCount)
  for (const attempt of attempts) {
    if (existsSync(attempt.transcriptPath)) copyFileSync(attempt.transcriptPath, join(dir, "transcripts", attempt.transcriptPath.split("/").pop()!))
  }
  setReadOnly(dir, true)
}

function setReadOnly(dir: string, readOnly: boolean): void {
  if (!existsSync(dir)) return
  if (!readOnly) chmodSync(dir, 0o755)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) setReadOnly(path, readOnly)
    else chmodSync(path, readOnly ? 0o444 : 0o644)
  }
  if (readOnly) chmodSync(dir, 0o555)
}

function createDoctorWorktree(sourceDir: string, name: string): Workspace {
  const path = join(sourceDir, ".agent-team", "worktrees", name)
  const branch = `doctor/${name}`
  const base = "origin/main"
  cleanupWorktree(sourceDir, { path, branch, base })
  git(sourceDir, ["worktree", "add", "-q", "-b", branch, path, base])
  return { path, branch, base }
}

function cleanupWorktree(sourceDir: string, workspace: Workspace): void {
  setReadOnly(join(workspace.path, evidenceDir), false)
  removeWorkspace(sourceDir, workspace)
}

// Every top-level entry of the worktree except the evidence, as edit rules for the agent.
function writableRoots(worktree: string): string[] {
  const roots = new Set(git(worktree, ["ls-files"]).split("\n").filter(Boolean).map((file) => file.split("/")[0]))
  return [...roots].sort().map((root) => (existsSync(join(worktree, root)) && statSync(join(worktree, root)).isDirectory() ? `${root}/**` : root))
}

// Files changed since the base, committed or not. The evidence folder is in .git/info/exclude, so it is never added.
function changedSince(worktree: string, base: string): string[] {
  git(worktree, ["add", "-A"])
  return git(worktree, ["diff", "--cached", "--name-only", base]).split("\n").filter(Boolean)
}

// ---------- Code fix ----------

type CodeFixResult = { kind: "rejected"; reason: string } | { kind: "landed"; prUrl: string | null; branch: string; files: string[]; hotfixError: string | null }

export function commitTitle(summary: string): string {
  const firstSentence = summary.trim().split(/(?<=[.!?])\s|\n/)[0].replace(/[.!?]+$/, "") || "repair an orchestrator bug"
  const subject = firstSentence.charAt(0).toLowerCase() + firstSentence.slice(1)
  const title = `fix(doctor): ${subject}`
  return title.length <= 72 ? title : `${title.slice(0, 71).replace(/\s+\S*$/, "")}`
}

async function landCodeFix(options: {
  incident: Incident
  report: DoctorReport
  worktree: Workspace
  sourceDir: string
  repo: string
  autoMerge: boolean
  executor: Executor
  deps: DoctorDeps
  notifier: Notifier
  transcript: (name: string) => string
  signal: AbortSignal
}): Promise<CodeFixResult> {
  const { incident, report, worktree, deps, notifier } = options
  const files = changedSince(worktree.path, "origin/main")
  if (!files.length) return { kind: "rejected", reason: "codeFix is true, but no file changed in the worktree" }
  if (!files.some((file) => file.startsWith("test/"))) return { kind: "rejected", reason: `the fix changes ${files.join(", ")} but adds no regression test under test/` }

  const identity = git(worktree.path, ["config", "--default", "", "user.email"]) ? [] : ["-c", "user.name=agent-team doctor", "-c", "user.email=agent-team@localhost"]
  const title = commitTitle(report.summary)
  git(worktree.path, [...identity, "commit", "-q", "-m", title, "-m", `Incident ${incident.project}/${incident.id}.\n\n${report.summary}`])

  const overlapping = notifier.openDoctorPullRequests().find((pr) => pr.files.some((file) => files.includes(file))) ?? null
  // An open pull request that nobody merged must not block every later fix to the same files: when the fix does not apply on top of it, it goes on main.
  const stacked = overlapping && rebaseOnto(worktree, options.sourceDir, overlapping.branch) ? overlapping : null
  const unstacked = overlapping && !stacked ? overlapping : null
  const base = stacked?.branch ?? "main"

  const outputs: string[] = []
  for (const command of ["npm ci --no-audit --no-fund", "npx tsc --noEmit", "npm test"]) {
    const result = await deps.runCommand(options.executor, command, options.transcript(command.split(" ").slice(0, 2).join("-")), options.signal)
    outputs.push(`$ ${command}\n${result.output.trim()}`)
    if (!result.passed) return { kind: "rejected", reason: `\`${command}\` failed:\n${result.output.slice(-2500)}` }
  }

  git(worktree.path, ["push", "-q", "-u", "origin", `${worktree.branch}:${worktree.branch}`])
  const body = [
    `The agent-team doctor opened this pull request for incident \`${incident.project}/${incident.id}\`${incident.issueUrl ? ` (${incident.issueUrl})` : ""}.`,
    stacked ? `\nIt builds on ${stacked.url}, which changes the same files. Merge that one first.` : "",
    unstacked ? `\nIt changes the same files as ${unstacked.url} but does not apply on top of it, so it is based on main. Merging both needs a manual conflict fix.` : "",
    "",
    "## Diagnosis",
    "",
    report.diagnosis,
    "",
    "## Change",
    "",
    report.summary,
    "",
    `Files: ${files.map((file) => `\`${file}\``).join(", ")}`,
    "",
    "## Checks",
    "",
    block(tailLines(outputs.join("\n\n"), 80), 6000),
    "",
    options.autoMerge
      ? "The fix is already copied into the live install as a hotfix. The doctor merges this pull request once the resumed run gets past the failing point. Pull it into the live install, or the next deploy from a laptop overwrites the hotfix."
      : "The fix is already copied into the live install as a hotfix. Merge this pull request and pull it there, or the next deploy from a laptop overwrites the hotfix.",
  ].join("\n")
  let prUrl: string | null = null
  try {
    prUrl = deps.gh(["pr", "create", "-R", options.repo, "--base", base, "--head", worktree.branch, "--title", title, "--body-file", "-"], worktree.path, body)
  } catch (error) {
    return { kind: "rejected", reason: `the branch ${worktree.branch} is pushed, but gh pr create failed: ${errorText(error).slice(0, 500)}` }
  }
  // A read-only install (a container image) cannot take the hotfix. The pull request still carries the fix, so the incident goes on.
  let hotfixError: string | null = null
  try {
    copyHotfix(worktree.path, deps.installDir, files)
  } catch (error) {
    hotfixError = errorText(error).slice(0, 500)
  }
  return { kind: "landed", prUrl, branch: worktree.branch, files, hotfixError }
}

function rebaseOnto(worktree: Workspace, sourceDir: string, branch: string): boolean {
  try {
    git(sourceDir, ["fetch", "-q", "origin", branch])
    git(worktree.path, ["rebase", "-q", "--onto", `origin/${branch}`, "origin/main"])
    return true
  } catch {
    try {
      git(worktree.path, ["rebase", "--abort"])
    } catch {}
    return false
  }
}

export function copyHotfix(from: string, to: string, files: string[]): void {
  const root = resolve(to)
  for (const file of files) {
    const target = resolve(root, file)
    if (!target.startsWith(root + sep)) throw new Error(`refusing to copy ${file} outside ${root}`)
    const source = join(from, file)
    if (existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    } else {
      rmSync(target, { force: true })
    }
  }
}

// ---------- Project actions ----------

function applyAction(action: ProjectAction, projectDir: string, store: Store): string {
  switch (action.action) {
    case "retry":
      retryTask(store, action.taskId)
      return `reset ${action.taskId} for a retry`
    case "reset_cooldowns":
      store.clearCooldowns()
      store.log("harness", "runner cooldowns cleared by the doctor")
      return "cleared runner cooldowns"
    case "resume":
      return "resume requested"
    case "edit_task":
      return editTask(projectDir, store, action.taskId, action.allowedPaths)
  }
}

// Goes through the same checks and landing path as a replan: shared files or another task's files need a human.
function editTask(projectDir: string, store: Store, taskId: string, allowedPaths: string[]): string {
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const workspace = createWorkspace(projectDir, `doctor-edit-${taskId}`, landingBranch({ store }))
  try {
    const tasks = loadTasks(join(workspace.path, "tasks.json"))
    const mergedIds = new Set(tasks.filter((task) => store.task(task.id)?.status === "merged").map((task) => task.id))
    const decision = decideReplan(tasks, taskId, { action: "rebind", allowedPaths }, mergedIds)
    if (decision.kind === "human") {
      store.requireHuman(taskId, `the doctor asked for this change: ${decision.reason}`)
      return `edit of ${taskId} needs a human: ${decision.reason}`
    }
    const context = { projectDir, config, store, github: createGitHub({ projectDir, config, store }) } as PipelineContext
    landTasksFile(context, workspace, decision.tasks, `chore(plan): doctor widens ${taskId}`, `The agent-team doctor ${decision.summary}.`)
    store.resetTask(taskId)
    return decision.summary
  } finally {
    removeWorkspace(projectDir, workspace)
  }
}

// ---------- The loop ----------

export interface DoctorOptions {
  runsDir: string
  deps?: Partial<DoctorDeps>
  signal?: AbortSignal
  now?: () => number
}

interface Candidate {
  name: string
  projectDir: string
  incident: Incident
}

export async function checkOnce(options: DoctorOptions): Promise<void> {
  const runsDir = resolve(options.runsDir)
  const deps: DoctorDeps = { ...defaultDoctorDeps, ...options.deps }
  const signal = options.signal ?? new AbortController().signal
  const now = options.now ?? Date.now
  const config = loadDoctorConfig(runsDir)
  let source: { sourceDir: string; repo: string } | null = null
  const ensureSource = () => (source ??= prepareSourceClone(config, deps))

  const candidates: Candidate[] = []
  for (const name of listProjects(runsDir)) {
    if (signal.aborted) return
    const projectDir = join(runsDir, name)
    const store = openProjectStore(projectDir)
    try {
      const notifierFor = (): Notifier => {
        try {
          const { repo, sourceDir } = ensureSource()
          return createNotifier(deps, repo, sourceDir, store)
        } catch (error) {
          store.log("doctor", `GitHub notifications are off: ${errorText(error).slice(0, 300)}`)
          return silentNotifier
        }
      }
      followUp(projectDir, store, notifierFor, config.autoMerge)
      const detection = detect(projectDir, store, config, now())
      const incidents = listIncidents(projectDir)
      for (const stale of incidents.filter((incident) => (incident.status === "open" || incident.status === "diagnosing") && !matches(detection, incident))) {
        stale.status = "fixed"
        addAction(stale, "cleared", "the stop cleared without the doctor (a person resumed or fixed the project)")
        saveIncident(projectDir, stale)
      }
      if (detection.kind === "notice") notice(store, name, detection, notifierFor)
      if (detection.kind === "cooldown_resume") {
        store.setMeta(cooldownResumeKey, detection.fingerprint)
        store.log("doctor", "the runner cooldown has passed; resuming the run once before treating it as an incident")
        deps.startRun(projectDir, runLogPath(runsDir, name))
      }
      if (detection.kind === "crash_resume") {
        store.setMeta(crashResumeKey, detection.fingerprint)
        store.log("doctor", `${detection.reason.split(";")[0]}; resuming the run once before treating it as an incident`)
        deps.startRun(projectDir, runLogPath(runsDir, name))
      }
      if (detection.kind !== "incident") continue
      const incident = incidentFor(projectDir, name, store, detection, config, notifierFor)
      if (incident) candidates.push({ name, projectDir, incident })
    } catch (error) {
      store.log("doctor", `check failed: ${errorText(error).slice(0, 500)}`)
    } finally {
      store.close()
    }
  }

  // One incident at a time across all projects: the oldest first.
  const next = candidates.sort((a, b) => a.incident.createdAt.localeCompare(b.incident.createdAt))[0]
  if (next) await treat({ ...next, runsDir, config, deps, signal, source: ensureSource })
}

function matches(detection: Detection, incident: Incident): boolean {
  return detection.kind === "incident" && detection.fingerprint === incident.fingerprint
}

function addAction(incident: Incident, action: string, detail: string): void {
  incident.actions.push({ at: new Date().toISOString(), action, detail })
}

function notice(store: Store, name: string, detection: Extract<Detection, { kind: "notice" }>, notifierFor: () => Notifier): void {
  const key = `doctor.notice.${detection.fingerprint}`
  if (store.meta(key)) return
  const url = notifierFor().openIssue(`Decision needed: ${name}: ${detection.reason.split("\n")[0].slice(0, 80)}`, [
    `The run of \`${name}\` stopped for a decision the doctor does not make.`,
    "",
    block(detection.reason),
  ].join("\n"))
  store.setMeta(key, url ?? "unsent")
  store.log("doctor", `the run needs a human decision; ${url ? `opened ${url}` : "no issue opened"}`)
}

function incidentFor(projectDir: string, name: string, store: Store, detection: Extract<Detection, { kind: "incident" }>, config: DoctorConfig, notifierFor: () => Notifier): Incident | null {
  const previous = listIncidents(projectDir).find((incident) => incident.fingerprint === detection.fingerprint)
  if (previous?.status === "gave_up") return null
  if (previous?.status === "open" || previous?.status === "diagnosing") return previous
  if (previous?.status === "fixed") {
    if (previous.attempts >= config.maxAttempts || previous.costUsd >= config.maxUsdPerIncident) {
      giveUp(projectDir, previous, notifierFor(), "the same stop came back after the fix, and the attempt limit is reached")
      return null
    }
    previous.status = "open"
    previous.resumedAt = null
    previous.succeededAt = null
    addAction(previous, "reopened", "the same stop came back after the fix")
    notifierFor().comment(previous.issueUrl, "The same stop came back after the fix. The doctor tries again.")
    store.log("doctor", `incident ${previous.id} reopened: the same stop came back`)
    return saveIncident(projectDir, previous)
  }
  const createdAt = new Date()
  const incident: Incident = {
    id: incidentId(createdAt),
    project: name,
    fingerprint: detection.fingerprint,
    kind: detection.incidentKind,
    reason: detection.reason,
    subject: subjectOf(detection.reason),
    status: "open",
    attempts: 0,
    costUsd: 0,
    tokens: 0,
    diagnosis: null,
    cause: null,
    actions: [],
    branch: null,
    prUrl: null,
    issueUrl: null,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    resumedAt: null,
    succeededAt: null,
    closedAt: null,
  }
  const keyLines = store.recentEvents(15).reverse().map((event) => `[${event.type}] ${event.message.split("\n")[0].slice(0, 200)}`).join("\n")
  incident.issueUrl = notifierFor().openIssue(`Incident: ${name}: ${detection.reason.split("\n")[0].slice(0, 80)}`, [
    `Project: \`${name}\``,
    `Kind: ${detection.incidentKind}`,
    `Incident: \`${incident.id}\``,
    "",
    "## Stop reason",
    "",
    block(detection.reason),
    "",
    "## Key log lines",
    "",
    block(keyLines),
  ].join("\n"))
  store.log("doctor", `${incidentOpenedPrefix} ${incident.id}: ${detection.reason.split("\n")[0].slice(0, 300)}`)
  return saveIncident(projectDir, incident)
}

function giveUp(projectDir: string, incident: Incident, notifier: Notifier, why: string): void {
  incident.status = "gave_up"
  addAction(incident, "gave_up", why)
  saveIncident(projectDir, incident)
  withProjectStore(projectDir, (store) => store.log("doctor", `incident ${incident.id}: ${incidentGaveUpText}: ${why}`))
  notifier.comment(incident.issueUrl, `The doctor gave up: ${why}. It does not act on this stop again. A person must look.`)
}

// For fixed incidents: say when the resumed run gets past the failing point, merge the fix, and close the issue when the run completes.
function followUp(projectDir: string, store: Store, notifierFor: () => Notifier, autoMerge: boolean): void {
  for (const incident of listIncidents(projectDir)) {
    const awaitsMerge = autoMerge && incident.prUrl !== null && !incident.mergedAt && !incident.mergeError
    if (incident.status !== "fixed" || !incident.resumedAt || (incident.closedAt && !awaitsMerge)) continue
    let changed = false
    if (!incident.closedAt) {
      const alive = runAlive(projectDir)
      const stop = alive ? null : readStop(store)
      const completed = !alive && !stop && /^finished: completed/.test(store.lastEvent()?.message ?? "")
      const subjectMerged = incident.subject ? store.task(incident.subject)?.status === "merged" || store.phaseStatus(incident.subject) === "approved" : false
      const movedOn = completed || subjectMerged || (stop !== null && fingerprint(stop.outcome === "failed" ? "failed" : "paused", stop.reason) !== incident.fingerprint)
      if (movedOn && !incident.succeededAt) {
        incident.succeededAt = new Date().toISOString()
        addAction(incident, "succeeded", "the resumed run got past the failing point")
        notifierFor().comment(incident.issueUrl, "The resumed run got past the failing point.")
        store.log("doctor", `incident ${incident.id}: the resumed run got past the failing point`)
      }
      if (completed) {
        incident.closedAt = new Date().toISOString()
        addAction(incident, "closed", "the project's run completed")
        notifierFor().close(incident.issueUrl, "The project's run completed after the fix.")
      }
      changed = movedOn || completed
    }
    if (awaitsMerge && incident.succeededAt && mergeFix(incident, notifierFor(), store)) changed = true
    if (changed) saveIncident(projectDir, incident)
  }
}

// A stacked pull request waits: once the one below it merges and its branch is deleted, GitHub retargets it to main.
function mergeFix(incident: Incident, notifier: Notifier, store: Store): boolean {
  const url = incident.prUrl!
  const pullRequest = notifier.pullRequest(url)
  if (!pullRequest) return false
  if (pullRequest.state === "MERGED") {
    incident.mergedAt = new Date().toISOString()
    addAction(incident, "merged", `${url} was merged outside the doctor`)
    return true
  }
  if (pullRequest.state === "CLOSED") {
    incident.mergeError = "the pull request was closed without a merge"
    addAction(incident, "merge_skipped", `${url}: ${incident.mergeError}`)
    return true
  }
  if (pullRequest.base !== "main") return false
  const error = notifier.merge(url)
  if (error) {
    incident.mergeError = error
    addAction(incident, "merge_failed", `${url}: ${error}`)
    notifier.comment(incident.issueUrl, [`The doctor could not merge ${url}. A person must merge it.`, "", block(error)].join("\n"))
    store.log("doctor", `incident ${incident.id}: merging ${url} failed: ${error.slice(0, 300)}`)
    return true
  }
  incident.mergedAt = new Date().toISOString()
  addAction(incident, "merged", url)
  notifier.comment(incident.issueUrl, `Merged ${url} into main. Pull it into the live install so the next deploy keeps the fix.`)
  store.log("doctor", `incident ${incident.id}: merged ${url}`)
  return true
}

async function stopStalledRun(projectDir: string, store: Store): Promise<void> {
  const pid = Number(store.meta("run.pid"))
  if (!runAlive(projectDir) || !pid) return
  store.log("doctor", `stopping the stalled run (pid ${pid}) before resuming`)
  process.kill(pid, "SIGTERM")
  for (let waited = 0; waited < 90 && runAlive(projectDir); waited++) await sleep(1000)
  if (runAlive(projectDir)) process.kill(pid, "SIGKILL")
}

function taskPrompt(incident: Incident, name: string, attempt: number): string {
  const earlier = incident.actions.filter((action) => action.action !== "opened")
  return [
    `Project \`${name}\` stopped. Incident ${incident.id}, doctor attempt ${attempt}.`,
    "",
    `Kind: ${incident.kind}. Failing subject: ${incident.subject ?? "unknown"}.`,
    "",
    "Stop reason:",
    "",
    block(incident.reason, 4000),
    "",
    "The evidence is in `.incident/` (read-only): stop.txt, status.txt, run.log, events.log, tasks.json, pipeline.yaml, transcripts/.",
    ...(earlier.length ? ["", "Earlier doctor attempts on this incident:", ...earlier.map((action) => `- ${action.action}: ${action.detail.slice(0, 500)}`)] : []),
    "",
    "Find the cause, fix it, and answer with the JSON block described in your instructions.",
  ].join("\n")
}

const doctorTools = ["read", "edit", "write", "bash:npm", "bash:npx", "bash:node", "bash:ls", "bash:mkdir"]

async function treat(options: Candidate & { runsDir: string; config: DoctorConfig; deps: DoctorDeps; signal: AbortSignal; source: () => { sourceDir: string; repo: string } }): Promise<void> {
  const { name, projectDir, incident, config, deps, signal } = options
  const store = openProjectStore(projectDir)
  let source: { sourceDir: string; repo: string }
  try {
    source = options.source()
  } catch (error) {
    addAction(incident, "error", `the source clone is not ready: ${errorText(error).slice(0, 500)}`)
    saveIncident(projectDir, incident)
    store.log("doctor", `incident ${incident.id}: the source clone is not ready: ${errorText(error).slice(0, 300)}`)
    store.close()
    return
  }
  const { sourceDir, repo } = source
  let worktree: Workspace | null = null
  let executor: Executor | null = null
  const notifier = createNotifier(deps, repo, sourceDir, store)
  let attemptStarted = false
  try {
    if (incident.attempts >= config.maxAttempts || incident.costUsd >= config.maxUsdPerIncident) {
      giveUp(projectDir, incident, notifier, `the limit is reached (${incident.attempts} attempts, $${incident.costUsd.toFixed(2)})`)
      return
    }
    const attempt = incident.attempts + 1
    incident.attempts = attempt
    attemptStarted = true
    incident.status = "diagnosing"
    saveIncident(projectDir, incident)
    store.log("doctor", `incident ${incident.id}: attempt ${attempt} of ${config.maxAttempts}`)

    const pipeline = loadConfig(join(projectDir, "pipeline.yaml"))
    const remainingUsd = config.maxUsdPerIncident - incident.costUsd
    const doctorPipeline: PipelineConfig = { ...pipeline, roles: { ...pipeline.roles, doctor: config.role }, budget: { perTaskUsd: remainingUsd, runUsd: Number.POSITIVE_INFINITY } }
    const context: PipelineContext = {
      projectDir,
      config: doctorPipeline,
      store,
      harness: deps.createHarness(store, doctorPipeline, signal),
      github: createGitHub({ projectDir, config: pipeline, store }),
      signal,
    }
    const workName = `${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${incident.id.toLowerCase()}-${attempt}`
    worktree = createDoctorWorktree(sourceDir, workName)
    writeEvidence({ dir: join(worktree.path, evidenceDir), runsDir: options.runsDir, name, projectDir, store, incident })
    executor = await createExecutor(context, worktree.path, `doctor-${workName}`, [join(sourceDir, ".git")])
    const subject = `doctor-${incident.id}-${attempt}`
    const outcome = await runAgent(context, executor, "doctor", subject, doctorTools, taskPrompt(incident, name, attempt), { writablePaths: writableRoots(worktree.path) })
    incident.costUsd += outcome.result.costUsd ?? 0
    incident.tokens = (incident.tokens ?? 0) + (outcome.result.tokens ?? 0)
    if (signal.aborted) return
    if (outcome.result.status !== "done") {
      addAction(incident, "agent_failed", `${outcome.failureClass ?? outcome.result.status}: ${outcome.result.summary.slice(0, 500)}`)
      return
    }
    let report: DoctorReport
    try {
      report = parseDoctorReport(outcome.result.summary)
    } catch (error) {
      addAction(incident, "report_rejected", (error as Error).message)
      return
    }
    incident.diagnosis = report.diagnosis
    incident.cause = report.cause
    addAction(incident, "diagnosed", `${report.cause}: ${report.diagnosis}`)
    notifier.comment(incident.issueUrl, [`### Diagnosis (attempt ${attempt})`, "", `Cause: \`${report.cause}\``, "", report.diagnosis].join("\n"))

    if (report.codeFix) {
      const fix = await landCodeFix({
        incident,
        report,
        worktree,
        sourceDir,
        repo,
        autoMerge: config.autoMerge,
        executor,
        deps,
        notifier,
        transcript: (label) => join(projectDir, ".agent-team", "transcripts", `${subject}-${label}.log`),
        signal,
      })
      if (fix.kind === "rejected") {
        addAction(incident, "fix_rejected", fix.reason)
        notifier.comment(incident.issueUrl, [`### Fix rejected (attempt ${attempt})`, "", block(fix.reason)].join("\n"))
        return
      }
      incident.branch = fix.branch
      incident.prUrl = fix.prUrl
      if (fix.hotfixError) {
        addAction(incident, "pull_request", `${fix.prUrl ?? fix.branch}; hotfix not copied, the fix goes live when the pull request is merged and deployed: ${fix.hotfixError}`)
        notifier.comment(incident.issueUrl, `Opened ${fix.prUrl}. The live install is read-only, so the fix goes live when this pull request is merged and deployed.`)
      } else {
        addAction(incident, "pull_request", `${fix.prUrl ?? fix.branch}; hotfix copied: ${fix.files.join(", ")}`)
        notifier.comment(incident.issueUrl, `Opened ${fix.prUrl} and copied the fix into the live install.`)
      }
    }

    for (const action of report.projectActions) {
      try {
        addAction(incident, action.action, applyAction(action, projectDir, store))
      } catch (error) {
        addAction(incident, `${action.action}_failed`, errorText(error).slice(0, 500))
      }
    }
    if (!report.codeFix && !report.projectActions.length) {
      addAction(incident, "no_action", "the doctor proposed no fix and no project action")
      return
    }
    await stopStalledRun(projectDir, store)
    if (runAlive(projectDir)) {
      addAction(incident, "resume_skipped", "a run was already active")
    } else {
      deps.startRun(projectDir, runLogPath(options.runsDir, name))
      addAction(incident, "resumed", "started the run again")
      notifier.comment(incident.issueUrl, "Resumed the run.")
    }
    incident.status = "fixed"
    incident.resumedAt = new Date().toISOString()
    store.log("doctor", `incident ${incident.id}: fixed and resumed`)
  } catch (error) {
    addAction(incident, "error", errorText(error).slice(0, 1000))
    store.log("doctor", `incident ${incident.id}: ${errorText(error).slice(0, 300)}`)
  } finally {
    if (executor) await executor.dispose()
    if (worktree) cleanupWorktree(sourceDir, worktree)
    if (incident.status === "diagnosing") incident.status = "open"
    // The doctor itself stopped (a redeploy, a restart), so this attempt says nothing about the incident.
    if (signal.aborted && attemptStarted && incident.status === "open") {
      incident.attempts -= 1
      addAction(incident, "interrupted", "the doctor stopped during this attempt, so it does not count toward the limit")
    }
    saveIncident(projectDir, incident)
    if (incident.status === "open" && (incident.attempts >= config.maxAttempts || incident.costUsd >= config.maxUsdPerIncident)) {
      giveUp(projectDir, incident, notifier, `the limit is reached (${incident.attempts} attempts, $${incident.costUsd.toFixed(2)})`)
    }
    store.close()
  }
}

const tickMs = 60_000

// Runs until the signal aborts. A lock file keeps a second doctor (for example a cron --once) from overlapping.
export async function runDoctor(options: DoctorOptions & { once?: boolean }): Promise<void> {
  const runsDir = resolve(options.runsDir)
  const lockPath = join(runsDir, ".doctor.lock")
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8"))
    if (pid && pid !== process.pid && processAlive(pid)) throw new Error(`another doctor is running (pid ${pid})`)
  }
  writeFileSync(lockPath, String(process.pid))
  const stopNotifications = options.once ? null : startNotificationLoop(runsDir)
  try {
    for (;;) {
      try {
        await checkOnce(options)
      } catch (error) {
        console.error(`[doctor] ${errorText(error)}`)
        if (options.once) throw error
      }
      // --once is for cron incident checks; Operate agents and sprints run only in the long-lived doctor.
      if (!options.once) {
        await operateTick({ runsDir }).catch((error) => console.error(`[operate] ${errorText(error)}`))
        sprintTick({ runsDir })
      }
      if (options.once || options.signal?.aborted) return
      await sleep(tickMs, undefined, { signal: options.signal }).catch(() => {})
      if (options.signal?.aborted) return
    }
  } finally {
    stopNotifications?.()
    rmSync(lockPath, { force: true })
  }
}
