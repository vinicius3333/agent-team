import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument, type Document } from "yaml"
import { loadConfig, normalizePhaseName, planningPhases, roles, runnerNames, type Candidate, type PipelineConfig, type PlanningPhase, type Role, type RunnerName } from "./config.ts"
import { appendFeedback, archiveFeedback } from "./feedback.ts"
import { commitAll, commitOf, commitPaths, createBranch, initRepository } from "./git.ts"
import { changeTitle, createGitHub } from "./github.ts"
import { commitAndRebase, createWorkspace, fastForward, removeWorkspace } from "./harness/workspace.ts"
import { openStore, type Change, type Store } from "./store.ts"
import { applyTemplate, customTemplate, findTemplate, type StackTemplate } from "./templates.ts"

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
  // A stack template name; undefined or "custom" lets the architect choose the stack.
  template?: string
}

const baseIgnores = [".agent-team/", "node_modules/"]

// Resolves a template choice for a target; ProjectError 400 when the name is unknown or serves another target.
export function chooseTemplate(name: string | undefined, target: PipelineConfig["target"]): StackTemplate | null {
  if (name === undefined || name === customTemplate) return null
  let template: StackTemplate | null
  try {
    template = findTemplate(name)
  } catch (error) {
    throw new ProjectError(400, (error as Error).message)
  }
  if (!template) throw new ProjectError(400, `Unknown stack template "${name}". Run agent-team templates to list them.`)
  if (!template.targets.includes(target)) throw new ProjectError(400, `The ${name} template serves ${template.targets.join(", ")}, not ${target}.`)
  return template
}

// Partial choices (from the CLI) change only the fields they set.
export function createProject(projectDir: string, brief: string, choices?: Partial<ProjectChoices>): void {
  if (existsSync(projectDir) && readdirSync(projectDir).length > 0) throw new ProjectError(409, `${projectDir} already exists and is not empty`)
  const pipeline = readFileSync(examplePipelinePath, "utf8")
  const target = choices?.target ?? (parseDocument(pipeline).get("target") as PipelineConfig["target"])
  const template = chooseTemplate(choices?.template, target)
  mkdirSync(projectDir, { recursive: true })
  initRepository(projectDir)
  if (template) {
    applyTemplate(template, projectDir)
    writeGitignore(projectDir)
    commitAll(projectDir, `chore: start from ${template.name} template v${template.version}`)
  } else {
    writeGitignore(projectDir)
  }
  writeFileSync(join(projectDir, "input.md"), brief)
  writeFileSync(join(projectDir, "pipeline.yaml"), choices ? applyChoices(pipeline, choices, template) : pipeline)
  commitAll(projectDir, "chore: start project from brief")
}

// Keeps the scaffold's own ignore lines and adds the ones every project needs.
function writeGitignore(projectDir: string): void {
  const path = join(projectDir, ".gitignore")
  const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []
  writeFileSync(path, `${[...new Set([...baseIgnores, ...existing])].join("\n")}\n`)
}

function applyChoices(pipelineYaml: string, choices: Partial<ProjectChoices>, template: StackTemplate | null): string {
  const document = parseDocument(pipelineYaml)
  if (choices.target !== undefined) document.set("target", choices.target)
  if (template) {
    const pin = document.createNode({ name: template.name, version: template.version })
    pin.flow = true
    document.set("template", pin)
  }
  if (choices.gates !== undefined) {
    const gates = document.createNode(choices.gates)
    gates.flow = true
    document.setIn(["autonomy", "gates"], gates)
  }
  if (choices.github !== undefined) document.setIn(["publish", "github", "enabled"], choices.github)
  if (choices.deploy !== undefined) document.setIn(["deploy", "enabled"], choices.deploy)
  if (choices.branding !== undefined) document.setIn(["branding", "enabled"], choices.branding)
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

// During a change the phase outputs live on the change branch, so edits in the main checkout are not committed: main must not move.
function commitHumanEdits(projectDir: string, store: Store, phase: PlanningPhase): void {
  if (!store.currentChange()) commitAll(projectDir, `docs(${phase}): apply human edits`)
}

export function approvePhase(projectDir: string, store: Store, phase: string | undefined): void {
  const approved = requireAwaitingApproval(store, phase)
  commitHumanEdits(projectDir, store, approved)
  archiveFeedback(projectDir, approved)
  store.setPhase(approved, "approved")
  store.log("gate", `phase "${approved}" approved`)
}

export function requestChanges(projectDir: string, store: Store, phase: string | undefined, message: string): void {
  const reviewed = requireAwaitingApproval(store, phase)
  // The rerun agent works in a worktree from main, so human edits must be committed for it to see them.
  commitHumanEdits(projectDir, store, reviewed)
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

// Raises budget.runUsd in pipeline.yaml by 50%, keeping the file's comments, and returns the new value.
export function raiseRunBudget(projectDir: string, store: Store): number {
  const path = join(projectDir, "pipeline.yaml")
  const current = loadConfig(path).budget.runUsd
  const raised = Math.round(current * budgetRaiseFactor * 100) / 100
  const document = parseDocument(readFileSync(path, "utf8"))
  document.setIn(["budget", "runUsd"], raised)
  writeFileSync(path, document.toString())
  store.log("budget", `budget.runUsd raised from $${current.toFixed(2)} to $${raised.toFixed(2)}`)
  return raised
}

export const changeRequestMaxLength = 4000
// The phases a change reruns; design joins them when the architecture delta asks for it.
export const changePhases = ["spec", "architecture", "plan", "qa", "deploy"]

export function changePath(id: string, file: string): string {
  return `docs/changes/${id}/${file}`
}

// Done means the last run got through QA and deploy (deploy counts as approved when it is off) with every task merged.
export function buildComplete(store: Store): boolean {
  if (!["plan", "qa", "deploy"].every((phase) => store.phaseStatus(phase) === "approved")) return false
  const tasks = store.tasks()
  return tasks.length > 0 && tasks.every((task) => task.status === "merged")
}

function changeSlug(request: string): string {
  const slug = changeTitle({ request }).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "")
  return slug || "change"
}

// Records the request on a new change/<id>-<slug> branch from main and resets the phases a change reruns.
export function openChange(projectDir: string, store: Store, rawRequest: unknown): Change {
  const request = typeof rawRequest === "string" ? rawRequest.trim() : ""
  if (!request) throw new ProjectError(400, "Describe the change first.")
  if (request.length > changeRequestMaxLength) throw new ProjectError(400, `Keep the change request under ${changeRequestMaxLength} characters.`)
  if (processAlive(Number(store.meta("run.pid")))) throw new ProjectError(409, "A run is in progress. Wait for it to stop.")
  const open = store.currentChange()
  if (open) throw new ProjectError(409, `Change ${open.id} is still open. Finish or abandon it first.`)
  if (!buildComplete(store)) throw new ProjectError(409, "Finish or fix the current run first.")

  const id = `C${String(store.changes().length + 1).padStart(3, "0")}`
  const branch = `change/${id}-${changeSlug(request)}`
  const baseCommit = commitOf(projectDir, "main")
  createBranch(projectDir, branch, baseCommit)
  const workspace = createWorkspace(projectDir, `change-${id}`, branch)
  try {
    const path = join(workspace.path, changePath(id, "request.md"))
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, `${request}
`)
    commitAndRebase(workspace, `docs(changes): add the ${id} request`)
    fastForward(projectDir, workspace.branch, branch)
  } finally {
    removeWorkspace(projectDir, workspace)
  }
  store.openChange({ id, request, branch, baseCommit }, changePhases)
  const change = store.change(id)!
  store.log("change", `opened change ${id} on ${branch}: ${changeTitle(change)}`)
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  createGitHub({ projectDir, config, store }).changeOpened(change)
  return change
}

// main never moved during the change, so its tasks.json and docs are already the ones from before it.
export function abandonChange(projectDir: string, store: Store, id: string | undefined): void {
  const change = id ? store.change(id) : null
  if (!change) throw new ProjectError(404, `unknown change "${id}"`)
  if (change.status !== "open") throw new ProjectError(409, `Change ${change.id} is ${change.status}, not open.`)
  if (processAlive(Number(store.meta("run.pid")))) throw new ProjectError(409, "A run is in progress. Stop it first.")
  const mainTaskIds = new Set(readTaskIds(projectDir))
  for (const task of store.tasks()) {
    if (!mainTaskIds.has(task.id)) store.removeTask(task.id)
  }
  store.restorePhases()
  store.finishChange(change.id, "abandoned")
  store.setMeta("run.stop", "")
  store.log("change", `abandoned change ${change.id}; phases restored and its tasks removed`)
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  createGitHub({ projectDir, config, store }).changeAbandoned(change)
}

function readTaskIds(projectDir: string): string[] {
  const path = join(projectDir, "tasks.json")
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, "utf8")) as { id: string }[]).map((task) => task.id)
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
