import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument, type Document } from "yaml"
import { loadConfig, normalizePhaseName, planningPhases, roles, runnerNames, type Candidate, type PipelineConfig, type PlanningPhase, type Role, type RunnerName } from "./config.ts"
import { appendFeedback, archiveFeedback } from "./feedback.ts"
import { commitAll, commitPaths, initRepository } from "./git.ts"
import { openStore, type Store } from "./store.ts"

export const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url))
// The directory the CLI runs from; the doctor copies hotfixes here.
export const installDir = fileURLToPath(new URL("..", import.meta.url))
const projectNamePattern = /^[A-Za-z0-9._-]+$/
const examplePipelinePath = new URL("../pipeline.example.yaml", import.meta.url)

// Thrown for problems the caller caused; status maps to an HTTP status in the dashboard.
export class ProjectError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type RoleModels = Partial<Record<Role, Candidate>>

const modelPattern = /^[A-Za-z0-9._:-]{1,64}$/

// Checks a { role: { runner, model } } object from a request and returns it typed.
export function parseRoleModels(raw: unknown): RoleModels {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProjectError(400, "The roles field must be an object of role names.")
  const parsed: RoleModels = {}
  for (const [role, value] of Object.entries(raw)) {
    if (!(roles as readonly string[]).includes(role)) throw new ProjectError(400, `Unknown role "${role}". Roles are ${roles.join(", ")}.`)
    const { runner, model } = (value ?? {}) as Record<string, unknown>
    if (typeof runner !== "string" || !(runnerNames as readonly string[]).includes(runner)) throw new ProjectError(400, `The runner for ${role} must be ${runnerNames.join(" or ")}.`)
    if (typeof model !== "string" || !modelPattern.test(model)) throw new ProjectError(400, `The model for ${role} must be 1 to 64 characters: letters, digits, dots, dashes, underscores, or colons.`)
    if (role === "illustrator" && runner !== "codex") throw new ProjectError(400, "The illustrator must run on codex, because image generation needs codex.")
    parsed[role as Role] = { runner: runner as RunnerName, model }
  }
  return parsed
}

// Keeps comments and other keys; the review check fails to load when worker and reviewer share a runner without the flag.
function applyRoleModels(document: Document, models: RoleModels): void {
  for (const [role, candidate] of Object.entries(models)) {
    document.setIn(["roles", role, "runner"], candidate.runner)
    document.setIn(["roles", role, "model"], candidate.model)
  }
  const workerRunner = document.getIn(["roles", "worker", "runner"])
  if (workerRunner !== undefined && workerRunner === document.getIn(["roles", "reviewer", "runner"])) document.set("allowSameVendorReview", true)
}

export function changeRoleModels(projectDir: string, models: RoleModels): void {
  const path = join(projectDir, "pipeline.yaml")
  const original = readFileSync(path, "utf8")
  const document = parseDocument(original)
  applyRoleModels(document, models)
  writeFileSync(path, document.toString())
  try {
    loadConfig(path)
  } catch (error) {
    writeFileSync(path, original)
    throw new ProjectError(400, error instanceof Error ? error.message : String(error))
  }
  commitPaths(projectDir, ["pipeline.yaml"], "chore: change agent models")
}

export interface ProjectChoices {
  target: PipelineConfig["target"]
  workerRunner?: RunnerName
  roles?: RoleModels
  gates: PlanningPhase[]
  github: boolean
  deploy: boolean
  branding: boolean
}

export function createProject(projectDir: string, brief: string, choices?: ProjectChoices): void {
  if (existsSync(projectDir) && readdirSync(projectDir).length > 0) throw new ProjectError(409, `${projectDir} already exists and is not empty`)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, "input.md"), brief)
  const pipeline = readFileSync(examplePipelinePath, "utf8")
  writeFileSync(join(projectDir, "pipeline.yaml"), choices ? applyChoices(pipeline, choices) : pipeline)
  writeFileSync(join(projectDir, ".gitignore"), ".agent-team/\nnode_modules/\n")
  initRepository(projectDir)
  commitAll(projectDir, "chore: start project from brief")
}

function applyChoices(pipelineYaml: string, choices: ProjectChoices): string {
  const document = parseDocument(pipelineYaml)
  document.set("target", choices.target)
  const gates = document.createNode(choices.gates)
  gates.flow = true
  document.setIn(["autonomy", "gates"], gates)
  document.setIn(["publish", "github", "enabled"], choices.github)
  document.setIn(["deploy", "enabled"], choices.deploy)
  document.setIn(["branding", "enabled"], choices.branding)
  const workerModels: RoleModels = choices.workerRunner === "codex" ? { worker: { runner: "codex", model: "gpt-5.5" } } : {}
  applyRoleModels(document, { ...workerModels, ...choices.roles })
  return document.toString()
}

// Project folder names in runsDir, sorted. A folder counts when it has a pipeline.yaml.
export function listProjects(runsDir: string): string[] {
  if (!existsSync(runsDir)) return []
  return readdirSync(runsDir)
    .filter((name) => projectNamePattern.test(name))
    .filter((name) => existsSync(join(runsDir, name, "pipeline.yaml")))
    .sort()
}

// Where a run started from the dashboard or the doctor writes its output.
export function runLogPath(runsDir: string, name: string): string {
  return join(runsDir, `${name}.log`)
}

export function openProjectStore(projectDir: string): Store {
  if (!existsSync(join(projectDir, "pipeline.yaml"))) throw new ProjectError(404, `${projectDir} is not an agent-team project (no pipeline.yaml)`)
  const stateDir = join(projectDir, ".agent-team")
  mkdirSync(stateDir, { recursive: true })
  return openStore(join(stateDir, "state.db"))
}

export function withProjectStore<T>(projectDir: string, use: (store: Store) => T): T {
  const store = openProjectStore(projectDir)
  try {
    return use(store)
  } finally {
    store.close()
  }
}

function requireAwaitingApproval(store: Store, requestedPhase: string | undefined): PlanningPhase {
  const phase = requestedPhase === undefined ? undefined : normalizePhaseName(requestedPhase)
  if (!planningPhases.includes(phase as PlanningPhase)) throw new ProjectError(400, `phase must be one of ${planningPhases.join(", ")}`)
  if (store.phaseStatus(phase!) !== "awaiting_approval") throw new ProjectError(409, `phase "${phase}" is not waiting for approval`)
  return phase as PlanningPhase
}

export function approvePhase(projectDir: string, store: Store, phase: string | undefined): void {
  const approved = requireAwaitingApproval(store, phase)
  commitAll(projectDir, `docs(${approved}): apply human edits`)
  archiveFeedback(projectDir, approved)
  store.setPhase(approved, "approved")
  store.log("gate", `phase "${approved}" approved`)
}

export function requestChanges(projectDir: string, store: Store, phase: string | undefined, message: string): void {
  const reviewed = requireAwaitingApproval(store, phase)
  // The rerun agent works in a worktree from main, so human edits must be committed for it to see them.
  commitAll(projectDir, `docs(${reviewed}): apply human edits`)
  appendFeedback(projectDir, reviewed, message)
  store.setPhase(reviewed, "pending")
  store.log("gate", `phase "${reviewed}": changes requested`)
}

export function retryTask(store: Store, taskId: string | undefined): void {
  if (!taskId) throw new ProjectError(400, "retry needs a task id")
  if (!store.task(taskId)) throw new ProjectError(404, `unknown task "${taskId}"`)
  store.resetTask(taskId)
  store.resetReplans(taskId)
  store.log("task", `${taskId} reset for retry`)
}

const budgetRaiseFactor = 1.5

// Raises budget.runUsd in pipeline.yaml, by 50% unless a new limit is given, keeping the file's comments, and returns the new value.
export function raiseRunBudget(projectDir: string, store: Store, runUsd?: number): number {
  const path = join(projectDir, "pipeline.yaml")
  const current = loadConfig(path).budget.runUsd
  if (runUsd !== undefined && !(Number.isFinite(runUsd) && runUsd > current && runUsd <= current * 100)) {
    throw new ProjectError(400, `The new budget must be above the current $${current.toFixed(2)}.`)
  }
  const raised = Math.round((runUsd ?? current * budgetRaiseFactor) * 100) / 100
  const document = parseDocument(readFileSync(path, "utf8"))
  document.setIn(["budget", "runUsd"], raised)
  writeFileSync(path, document.toString())
  store.log("budget", `budget.runUsd raised from $${current.toFixed(2)} to $${raised.toFixed(2)}`)
  return raised
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function runAlive(projectDir: string): boolean {
  return withProjectStore(projectDir, (store) => processAlive(Number(store.meta("run.pid"))))
}

export function startRun(projectDir: string, logPath: string): number {
  const log = openSync(logPath, "a")
  try {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cliPath, "run", projectDir], {
      detached: true,
      stdio: ["ignore", log, log],
    })
    child.unref()
    // Recorded now so a second request sees the run before the child writes its own pid.
    if (child.pid) withProjectStore(projectDir, (store) => store.setMeta("run.pid", String(child.pid)))
    return child.pid ?? 0
  } finally {
    closeSync(log)
  }
}
