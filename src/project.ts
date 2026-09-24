import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument } from "yaml"
import { normalizePhaseName, planningPhases, type PipelineConfig, type PlanningPhase, type RunnerName } from "./config.ts"
import { appendFeedback, archiveFeedback } from "./feedback.ts"
import { commitAll, initRepository } from "./git.ts"
import { openStore, type Store } from "./store.ts"

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url))
const examplePipelinePath = new URL("../pipeline.example.yaml", import.meta.url)

// Thrown for problems the caller caused; status maps to an HTTP status in the dashboard.
export class ProjectError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface ProjectChoices {
  target: PipelineConfig["target"]
  workerRunner: RunnerName
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
  if (choices.workerRunner === "codex") {
    document.setIn(["roles", "worker", "runner"], "codex")
    document.setIn(["roles", "worker", "model"], "gpt-5.5")
  }
  return document.toString()
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
  store.log("task", `${taskId} reset for retry`)
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
