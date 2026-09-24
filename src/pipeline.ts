import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Candidate, PipelineConfig, PlanningPhase, Role } from "./config.ts"
import { changedFiles, stagedDiff, trackedFiles } from "./git.ts"
import { createDockerExecutor, ensureImage } from "./harness/docker.ts"
import { hostExecutor, type Executor } from "./harness/executor.ts"
import { defaultAllowlist, ensureEgressProxy } from "./harness/network.ts"
import type { Harness, HarnessOutcome } from "./harness/harness.ts"
import { commitAndRebase, createWorkspace, detectSetupCommand, fastForwardMain, removeWorkspace, type Workspace } from "./harness/workspace.ts"
import { deployProject } from "./deploy.ts"
import { archiveFeedback, readFeedback } from "./feedback.ts"
import type { GitHub } from "./github.ts"
import { parseArchitectureCommands, parseDesignScreens, parseQaVerdict, runQaLoop, type QaRoundResult, type QaScreen } from "./qa.ts"
import { extractJsonObject } from "./json.ts"
import { decideReplan, formatBlock, normalizeFailure, parseBlock, parseReplanAction, type Block, type ReplanDecision } from "./replan.ts"
import { diffFileHashes, flaggedFiles } from "./reviews.ts"
import { captureScreenshots, type VisualReport } from "./screenshots.ts"
import { runUiSmoke, type SmokeCheck } from "./smoke.ts"
import type { Store } from "./store.ts"
import { filesOutsideScope, loadTasks, type Task } from "./tasks.ts"

const phaseAttempts = 2
const deployAttempts = 3
const commandTimeoutMs = 10 * 60 * 1000
const planningTools = ["read", "edit", "write", "bash:mkdir", "bash:ls"]
const reviewerTools = ["read"]
const qaTools = ["read"]
const replannerTools = ["read"]
const reviewAttempts = 2
const maxReplansPerTask = 1
const maxAttemptDiffLength = 40_000
const maxListedFiles = 300
const maxCodeMapLines = 200
const maxSummaryLines = 3
const progressPath = "docs/progress.md"
// Written by the architect and the orchestrator; no worker may edit them, whatever its allowedPaths say.
const orchestratorFiles = ["AGENTS.md", "CLAUDE.md", progressPath]
const lockfileNames = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum"])
const assetPattern = /\.(png|jpe?g|gif|webp|avif|ico|svg|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|pdf|zip|gz)$/i

interface PhaseDefinition {
  role: Role
  inputs: string[]
  outputs: string[]
  validate: (projectDir: string, config: PipelineConfig) => void
}

const phaseDefinitions: Record<PlanningPhase, PhaseDefinition> = {
  spec: {
    role: "pm",
    inputs: ["input.md"],
    outputs: ["docs/spec.md"],
    validate: (dir) =>
      requireHeadings(join(dir, "docs/spec.md"), ["## Problem", "## Users", "## User stories", "## Out of scope", "## Open questions"]),
  },
  architecture: {
    role: "architect",
    inputs: ["input.md", "docs/spec.md"],
    outputs: ["docs/architecture.md", "docs/adr/", "contracts/openapi.yaml (if the app has an API)", "AGENTS.md"],
    validate: (dir) => {
      requireHeadings(join(dir, "docs/architecture.md"), ["## Commands"])
      requireHeadings(join(dir, "AGENTS.md"), ["## Commands"])
    },
  },
  branding: {
    role: "illustrator",
    inputs: ["input.md", "docs/spec.md", "docs/architecture.md"],
    outputs: ["design/branding/01-logo.png", "design/branding/02-<screen>.png and later screens", "design/branding/README.md"],
    validate: (dir, config) => validateBranding(dir, config.branding.count),
  },
  design: {
    role: "designer",
    inputs: [
      "docs/spec.md",
      "docs/architecture.md",
      "contracts/",
      "design/branding/ (logo and desktop screen images: open and study every one, build the design system from them)",
    ],
    outputs: ["design/tokens.css", "design/logo.svg", "design/logo-mark.svg", "docs/design-system.md", "docs/design.md"],
    validate: (dir) => {
      const tokens = readFileSync(requireFile(join(dir, "design/tokens.css")), "utf8")
      if (!tokens.includes("--primary:")) throw new Error("design/tokens.css has no --primary variable")
      for (const logo of ["design/logo.svg", "design/logo-mark.svg"]) requireSvg(join(dir, logo))
      requireHeadings(join(dir, "docs/design-system.md"), designSystemHeadings)
      requireFile(join(dir, "docs/design.md"))
    },
  },
  plan: {
    role: "planner",
    inputs: ["docs/spec.md", "docs/architecture.md", "docs/design.md", "contracts/"],
    outputs: ["tasks.json"],
    validate: (dir) => void loadTasks(join(dir, "tasks.json")),
  },
}

const designSystemHeadings = ["## Principles", "## Color", "## Typography", "## Spacing and radius", "## Components", "## Icons", "## Logo"]
const imagePattern = /\.(png|jpe?g|webp)$/i

export function validateBranding(dir: string, count: number): void {
  const brandingDir = join(dir, "design/branding")
  requireFile(join(brandingDir, "01-logo.png"))
  requireFile(join(brandingDir, "README.md"))
  const screens = readdirSync(brandingDir).filter((file) => imagePattern.test(file) && file !== "01-logo.png")
  if (screens.length < count - 1) throw new Error(`design/branding/ has ${screens.length} screen images; expected at least ${count - 1}`)
}

function requireSvg(path: string): void {
  const content = readFileSync(requireFile(path), "utf8").replace(/^\uFEFF/, "").trim()
  const withoutProlog = content.replace(/^<\?xml[\s\S]*?\?>\s*/, "").replace(/^(<!--[\s\S]*?-->\s*)*/, "")
  if (!/^<svg[\s>]/.test(withoutProlog) || !/<\/svg>\s*$/.test(content)) throw new Error(`${path} is not an SVG file with an <svg> root`)
}

// "paused" = stopped for a reason outside the agents' work (operator abort, no runner available); rerun to resume.
export type RunOutcome = "completed" | "awaiting_approval" | "paused" | "failed"

export interface PipelineContext {
  projectDir: string
  config: PipelineConfig
  store: Store
  harness: Harness
  github: GitHub
  signal: AbortSignal
  // Replaces the per-task UI smoke check (tests use a stub instead of Docker).
  smokeCheck?: SmokeCheck
}

// Why the run stopped, shown on the dashboard. kind "budget" offers to raise the budget.
export interface RunStop {
  outcome: Exclude<RunOutcome, "completed">
  kind: "budget" | "other"
  reason: string
  at: string
}

const runStopKey = "run.stop"
// Per-run state that the step functions report into, keyed by context so parallel test runs stay apart.
const runStates = new WeakMap<PipelineContext, { stopReason: string | null; budgetExceeded: boolean }>()

function runState(context: PipelineContext) {
  let state = runStates.get(context)
  if (!state) {
    state = { stopReason: null, budgetExceeded: false }
    runStates.set(context, state)
  }
  return state
}

// Records the full reason for a pause or failure; the events keep only a short slice.
// Once the budget stops the run, the pauses it causes further up keep the budget message.
function noteStop(context: PipelineContext, reason: string): void {
  const state = runState(context)
  if (!state.budgetExceeded) state.stopReason = reason
}

// Keeps the lines that explain a command failure (npm error lines and the like), else the last lines.
export function keyFailureLines(output: string, maxLines = 15): string {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim())
  const key = lines.filter((line) => /\bnpm (error|ERR!)|\berror\b|\bERR_|\bfailed\b|\bcannot\b|\bnot found\b|\bexception\b/i.test(line))
  return (key.length ? key.slice(0, maxLines) : lines.slice(-maxLines)).join("\n")
}

function summarizeStop(reason: string): string {
  const [first, ...rest] = reason.trim().split("\n")
  if (!rest.length) return first.slice(0, 2000)
  return `${first.slice(0, 500)}\n${keyFailureLines(rest.join("\n"))}`.slice(0, 4000)
}

type AttemptResult =
  | { kind: "passed" }
  // diff is the rejected change, kept so the next attempt can fix it instead of starting over.
  | { kind: "failed"; reason: string; diff?: string }
  | { kind: "blocked"; reason: string; block: Block }
  | { kind: "infrastructure"; reason: string }

// "replanned" means tasks.json changed on main, so the caller reloads it before going on.
type TaskOutcome = RunOutcome | "replanned"

export interface PreviousAttempt {
  reason: string
  diff: string | null
}

export async function runPipeline(context: PipelineContext): Promise<RunOutcome> {
  const { store } = context
  const state = runState(context)
  state.stopReason = null
  state.budgetExceeded = false
  store.setMeta(runStopKey, "")
  let outcome = await runStages(context)
  if (state.budgetExceeded && outcome === "paused") outcome = "awaiting_approval"
  if (outcome !== "completed") {
    const lastEvent = store.lastEvent()
    const reason = state.stopReason ?? lastEvent?.message ?? "no reason recorded"
    const stop: RunStop = { outcome, kind: state.budgetExceeded ? "budget" : "other", reason: summarizeStop(reason), at: new Date().toISOString() }
    store.setMeta(runStopKey, JSON.stringify(stop))
  }
  return outcome
}

async function runStages(context: PipelineContext): Promise<RunOutcome> {
  for (const phase of Object.keys(phaseDefinitions) as PlanningPhase[]) {
    const outcome = await runPlanningPhase(context, phase)
    if (outcome !== "completed") return outcome
  }
  return runTasks(context)
}

async function runPlanningPhase(context: PipelineContext, phase: PlanningPhase): Promise<RunOutcome> {
  const { projectDir, config, store } = context
  const status = store.phaseStatus(phase)
  if (status === "approved") return "completed"
  if (status === "awaiting_approval") {
    store.log("gate", `phase "${phase}" is waiting for approval: agent-team approve ${projectDir} ${phase}`)
    return "awaiting_approval"
  }
  const skipReason =
    (phase === "design" || phase === "branding") && config.target === "api"
      ? "api-only target"
      : phase === "branding" && !config.branding.enabled
        ? "branding disabled in pipeline.yaml"
        : null
  if (skipReason) {
    store.setPhase(phase, "approved")
    store.log("phase", `${phase} skipped: ${skipReason}`)
    return "completed"
  }

  const definition = phaseDefinitions[phase]
  store.setPhase(phase, "running")
  let previousError: string | null = null
  for (let attempt = 1; attempt <= phaseAttempts; attempt++) {
    store.log("phase", `${phase}: attempt ${attempt} with ${definition.role}`)
    const result = await attemptPhase(context, phase, definition, attempt, previousError)
    if (result.kind === "infrastructure") {
      store.setPhase(phase, "pending")
      noteStop(context, `${phase} paused: ${result.reason}`)
      store.log("phase", `${phase}: paused: ${result.reason.slice(0, 300)}`)
      return "paused"
    }
    if (result.kind === "failed" || result.kind === "blocked") {
      previousError = result.reason
      store.log("phase", `${phase}: output rejected: ${previousError}`)
      continue
    }
    archiveFeedback(projectDir, phase)
    if (config.autonomy.gates.includes(phase)) {
      store.setPhase(phase, "awaiting_approval")
      store.log("gate", `phase "${phase}" is ready for review: agent-team approve ${projectDir} ${phase}`)
      return "awaiting_approval"
    }
    store.setPhase(phase, "approved")
    return "completed"
  }
  store.setPhase(phase, "failed")
  noteStop(context, `${phase} failed after ${phaseAttempts} attempts: ${previousError ?? "no reason"}`)
  return "failed"
}

// Planning agents also work in a throwaway worktree, so they never see the orchestrator state or write to main's .git.
async function attemptPhase(context: PipelineContext, phase: PlanningPhase, definition: PhaseDefinition, attempt: number, previousError: string | null): Promise<AttemptResult> {
  const { projectDir } = context
  const workspace = createWorkspace(projectDir, `phase-${phase}-${attempt}`)
  const executor = await createExecutor(context, workspace.path, `phase-${phase}-${attempt}`)
  try {
    const outcome = await runAgent(context, executor, definition.role, `phase-${phase}-${attempt}`, planningTools, phasePrompt(context, phase, previousError))
    if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `${outcome.failureClass}: ${outcome.result.summary}` }
    if (outcome.result.status !== "done") return { kind: "failed", reason: `agent ${outcome.result.status}: ${outcome.result.summary}` }
    try {
      definition.validate(workspace.path, context.config)
    } catch (error) {
      return { kind: "failed", reason: (error as Error).message }
    }
    if (phase === "architecture") ensureClaudeMemoryFile(context, workspace.path)
    const title = `docs(${phase}): add ${phase} artifacts`
    commitAndRebase(workspace, title)
    context.github.land({
      branch: workspace.branch,
      title,
      body: `Planning phase **${phase}**, written by the ${definition.role} agent (attempt ${attempt}).\n\nOutputs: ${definition.outputs.join(", ")}.`,
      localMerge: () => fastForwardMain(projectDir, workspace.branch),
    })
    return { kind: "passed" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

// Claude Code reads CLAUDE.md, Codex reads AGENTS.md; the import keeps one source of truth.
function ensureClaudeMemoryFile(context: PipelineContext, dir: string): void {
  const path = join(dir, "CLAUDE.md")
  if (existsSync(path)) return
  writeFileSync(path, "@AGENTS.md\n")
  context.store.log("phase", "architecture: created CLAUDE.md that imports AGENTS.md")
}

export function phasePrompt(context: Pick<PipelineContext, "projectDir" | "config">, phase: PlanningPhase, previousError: string | null): string {
  const { config, projectDir } = context
  const definition = phaseDefinitions[phase]
  const lines = [
    `Project target: ${config.target}.`,
    `Read these inputs: ${definition.inputs.join(", ")}.`,
    `Write these outputs: ${definition.outputs.join(", ")}.`,
  ]
  if (definition.role === "illustrator") lines.push(`Generate ${config.branding.count} images in total: the logo first, then ${config.branding.count - 1} desktop screens.`)
  if (config.stackHints.prefer.length) lines.push(`Preferred technologies: ${config.stackHints.prefer.join(", ")}.`)
  if (config.stackHints.avoid.length) lines.push(`Avoid: ${config.stackHints.avoid.join(", ")}.`)
  const feedback = readFeedback(projectDir, phase)
  if (feedback) {
    lines.push("A human reviewed your last output and asked for these changes:", feedback.trim())
    lines.push("Edit your existing outputs to address this feedback. Do not start over.")
  }
  if (previousError) lines.push(`Your previous output was rejected. Fix this: ${previousError}`)
  return lines.join("\n")
}

async function runTasks(context: PipelineContext): Promise<RunOutcome> {
  const built = await buildTasks(context)
  if (built !== "completed") return built
  let deployUrl: string | null = null
  const deploy = async () => {
    const result = await runDeployPhase(context)
    deployUrl = result.url
    return result.outcome
  }
  const outcome = await runQaPhase(context, deploy)
  if (outcome !== "completed") return outcome
  context.github.runCompleted(deployUrl)
  return "completed"
}

// Runs every task in tasks.json that is not merged yet. QA fix tasks and replans change the same file.
async function buildTasks(context: PipelineContext): Promise<RunOutcome> {
  const { projectDir, store } = context
  const load = () => {
    const tasks = loadTasks(join(projectDir, "tasks.json"))
    store.syncTasks(tasks.map((task) => task.id))
    context.github.syncTaskIssues(tasks)
    return tasks
  }
  let tasks = load()
  for (;;) {
    const task = tasks.find((candidate) => store.task(candidate.id).status !== "merged")
    if (!task) break
    const row = store.task(task.id)
    if (row.status === "blocked") {
      if (row.humanReason) {
        noteStop(context, `${task.id} needs a human decision: ${row.humanReason}`)
        store.log("gate", `${task.id} needs a human decision: ${row.humanReason.slice(0, 500)}. Edit tasks.json if needed, then: agent-team retry ${projectDir} ${task.id}`)
        return "awaiting_approval"
      }
      noteStop(context, `${task.id} is blocked: ${row.lastFailure}`)
      store.log("task", `${task.id} is blocked: ${row.lastFailure}. Fix it, then: agent-team retry ${projectDir} ${task.id}`)
      return "failed"
    }
    const outcome = await runTask(context, task)
    if (outcome === "replanned") {
      tasks = load()
      continue
    }
    if (outcome !== "completed") return outcome
  }
  store.log("run", "all tasks merged")
  return "completed"
}

async function runTask(context: PipelineContext, task: Task): Promise<TaskOutcome> {
  const { config, projectDir, store } = context
  const maxRetries = config.roles.worker.maxRetries ?? 3
  while (store.task(task.id).attempts < maxRetries) {
    const { attempts, lastFailure } = store.task(task.id)
    const attempt = attempts + 1
    store.updateTask(task.id, "running", lastFailure)
    store.log("task", `${task.id} "${task.title}": attempt ${attempt}/${maxRetries}`)
    context.github.taskStarted(task, attempt)

    const previous = lastFailure ? { reason: lastFailure, diff: readAttemptDiff(projectDir, task.id, attempts) } : null
    const result = await attemptTask(context, task, attempt, previous)
    switch (result.kind) {
      case "passed":
        store.countAttempt(task.id)
        store.updateTask(task.id, "merged")
        store.log("task", `${task.id} merged`)
        context.github.taskMerged(task)
        return "completed"
      case "infrastructure":
        store.updateTask(task.id, "pending", lastFailure)
        noteStop(context, `${task.id} paused: ${result.reason}`)
        store.log("task", `${task.id} paused, attempt not counted: ${result.reason.slice(0, 300)}`)
        return "paused"
      case "blocked":
        store.countAttempt(task.id)
        store.updateTask(task.id, "blocked", result.reason)
        store.log("task", `${task.id} blocked by worker: ${result.reason.slice(0, 300)}`)
        return handleBlock(context, task, result.block)
      case "failed":
        store.countAttempt(task.id)
        writeAttemptDiff(projectDir, task.id, attempt, result.reason, result.diff ?? "")
        if (lastFailure && normalizeFailure(lastFailure) === normalizeFailure(result.reason)) {
          store.updateTask(task.id, "blocked", result.reason)
          store.log("task", `${task.id} failed the same way on attempts ${attempt - 1} and ${attempt}; replanning instead of retrying`)
          return handleBlock(context, task, { kind: "spec", needPaths: [], reason: `the same failure repeated on two attempts in a row:\n${result.reason}` })
        }
        store.updateTask(task.id, "pending", result.reason)
        store.log("task", `${task.id} failed: ${result.reason.slice(0, 500)}`)
        context.github.attemptFailed(task, attempt, result.reason)
    }
  }
  store.updateTask(task.id, "blocked", store.task(task.id).lastFailure)
  noteStop(context, `${task.id} blocked after ${maxRetries} attempts: ${store.task(task.id).lastFailure ?? "no reason"}`)
  store.log("task", `${task.id} blocked after ${maxRetries} attempts`)
  context.github.taskBlocked(task, store.task(task.id).lastFailure ?? "max attempts reached")
  return "failed"
}

async function handleBlock(context: PipelineContext, task: Task, block: Block): Promise<TaskOutcome> {
  const { store } = context
  if (store.task(task.id).replans >= maxReplansPerTask) {
    return requireHuman(context, task, `${task.id} was already replanned once and is blocked again. ${formatBlock(block)}`)
  }
  store.log("replan", `${task.id}: asking the planner to replan (${block.kind} block)`)
  const result = await replanTask(context, task, block)
  if (result.kind === "infrastructure") {
    store.updateTask(task.id, "pending", formatBlock(block))
    noteStop(context, `${task.id} paused during a replan: ${result.reason}`)
    store.log("replan", `${task.id}: paused before the replan finished: ${result.reason.slice(0, 300)}`)
    return "paused"
  }
  store.countReplan(task.id)
  if (result.kind === "human") return requireHuman(context, task, `${result.reason}\n${formatBlock(block)}`)
  store.resetTask(task.id)
  if (!result.tasks.some((entry) => entry.id === task.id)) store.removeTask(task.id)
  store.log("replan", `${task.id}: ${result.summary}; attempts reset`)
  return "replanned"
}

function requireHuman(context: PipelineContext, task: Task, reason: string): RunOutcome {
  context.store.requireHuman(task.id, reason)
  noteStop(context, `${task.id} needs a human decision: ${reason}`)
  context.store.log("gate", `${task.id} needs a human decision: ${reason.slice(0, 500)}. Edit tasks.json if needed, then: agent-team retry ${context.projectDir} ${task.id}`)
  context.github.taskBlocked(task, reason)
  return "awaiting_approval"
}

type ReplanResult = ReplanDecision | { kind: "infrastructure"; reason: string }

// The planner gets the blocked task, the block, every task with its status, and the tracked files,
// and answers with one action. A valid "apply" lands on main like QA fix tasks do.
async function replanTask(context: PipelineContext, task: Task, block: Block): Promise<ReplanResult> {
  const { projectDir, store } = context
  const name = `replan-${task.id}`
  const workspace = createWorkspace(projectDir, name)
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const tasks = loadTasks(join(workspace.path, "tasks.json"))
    const statuses = Object.fromEntries(tasks.map((entry) => [entry.id, store.task(entry.id)?.status ?? "pending"]))
    const files = trackedFiles(workspace.path)
    let previousError: string | null = null
    for (let attempt = 1; attempt <= phaseAttempts; attempt++) {
      const prompt = replanPrompt({ task, block, tasks, statuses, files, previousError })
      const outcome = await runAgent(context, executor, "planner", `${name}-${attempt}`, replannerTools, prompt, { promptName: "replanner" })
      if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `planner ${outcome.failureClass}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      let decision: ReplanDecision
      try {
        decision = decideReplan(tasks, task.id, parseReplanAction(outcome.result.summary))
      } catch (error) {
        previousError = (error as Error).message
        store.log("replan", `${task.id}: answer rejected: ${previousError.slice(0, 300)}`)
        continue
      }
      if (decision.kind === "apply") {
        landTasksFile(context, workspace, decision.tasks, `chore(plan): replan ${task.id}`, [`${task.id} was blocked:`, "", "```", formatBlock(block).slice(0, 3000), "```", "", `The planner ${decision.summary}.`].join("\n"))
      }
      return decision
    }
    return { kind: "human", reason: `the planner gave no usable replan: ${previousError ?? "no answer"}` }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

export function replanPrompt(input: { task: Task; block: Block; tasks: Task[]; statuses: Record<string, string>; files: string[]; previousError: string | null }): string {
  const { task, block, files } = input
  const listed = files.slice(0, maxListedFiles)
  const lines = [
    `Task ${task.id} is blocked. Replan it.`,
    "",
    "## Blocked task",
    "",
    "```json",
    JSON.stringify(task, null, 2),
    "```",
    "",
    "## Block reported by the worker",
    "",
    "```json",
    JSON.stringify(block, null, 2),
    "```",
    "",
    "## All tasks",
    "",
    ...input.tasks.map((entry) => `- ${entry.id} [${input.statuses[entry.id] ?? "pending"}] ${entry.title}; dependsOn: ${entry.dependsOn.join(", ") || "none"}; allowedPaths: ${entry.allowedPaths.join(", ")}`),
    "",
    "## Tracked files (git ls-files)",
    "",
    ...listed,
  ]
  if (files.length > listed.length) lines.push(`[${files.length - listed.length} more files not shown]`)
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

async function attemptTask(context: PipelineContext, task: Task, attempt: number, previous: PreviousAttempt | null): Promise<AttemptResult> {
  const { projectDir, store } = context
  const workspace = createWorkspace(projectDir, `${task.id}-${attempt}`)
  const executor = await createExecutor(context, workspace.path, `${task.id}-${attempt}`)
  const rejected = (reason: string): AttemptResult => ({ kind: "failed", reason, diff: stagedDiff(workspace.path) })
  try {
    const setupCommand = detectSetupCommand(workspace.path)
    if (setupCommand) {
      const setup = await runCommand(context, executor, setupCommand, `${task.id}-${attempt}-setup`)
      if (!setup.passed) return { kind: "infrastructure", reason: `workspace setup failed (${setupCommand}):\n${setup.output}` }
    }

    const files = trackedFiles(workspace.path)
    const hasProgress = existsSync(join(workspace.path, progressPath))
    const dependencyFiles = dependencyChanges(store, task)
    const prompt = workerPrompt({ task, previous, codeMap: codeMap(files), dependencyFiles, hasProgress })
    const worker = await runAgent(context, executor, "worker", `${task.id}-worker-${attempt}`, workerTools(task), prompt, { writablePaths: task.allowedPaths })
    if (isInfrastructureFailure(worker)) return { kind: "infrastructure", reason: `worker ${worker.failureClass}: ${worker.result.summary}` }
    if (worker.result.status !== "done") return rejected(`worker ${worker.result.status}: ${worker.result.summary}`)
    const block = parseBlock(worker.result.summary)
    if (block) return { kind: "blocked", reason: formatBlock(block), block }

    const changed = changedFiles(workspace.path)
    const forbidden = changed.filter((file) => orchestratorFiles.includes(file))
    if (forbidden.length) return rejected(`edited files that only the orchestrator writes: ${forbidden.join(", ")}`)
    const outside = filesOutsideScope(changed, task.allowedPaths)
    if (outside.length) return rejected(`edited files outside allowedPaths: ${outside.join(", ")}`)

    const verification = await runCheck(context, executor, task.verify, `${task.id}-${attempt}-verify`, `${task.id} verify`)
    if (!verification.passed) return rejected(`verify command failed:\n${verification.output}`)

    if (task.ui) {
      const smoke = await (context.smokeCheck ?? runUiSmoke)({ projectDir, worktree: workspace.path, task, attempt, signal: context.signal })
      if (smoke.kind === "skipped") store.log("smoke", `${task.id} attempt ${attempt}: UI smoke check skipped: ${smoke.reason.slice(0, 500)}`)
      else if (smoke.kind === "passed") store.log("smoke", `${task.id} attempt ${attempt}: UI smoke check passed on ${smoke.routes} routes`)
      else {
        store.log("smoke", `${task.id} attempt ${attempt}: UI smoke check failed:\n${smoke.reason.slice(0, 1500)}`)
        return rejected(`UI smoke check failed:\n${smoke.reason}`)
      }
    }

    const diff = stagedDiff(workspace.path)
    const writer = worker.candidate ?? context.config.roles.worker
    const reviewInput = { task, diff, verifyOutput: verification.output, hasProgress, dependencyFiles }
    let verdict: ReviewVerdict | null = null
    let reviewError: string | null = null
    for (let reviewAttempt = 1; reviewAttempt <= reviewAttempts && !verdict; reviewAttempt++) {
      const subject = reviewAttempt === 1 ? `${task.id}-review-${attempt}` : `${task.id}-review-${attempt}-${reviewAttempt}`
      const review = await runAgent(context, executor, "reviewer", subject, reviewerTools, reviewPrompt({ ...reviewInput, previousError: reviewError }), {
        promptVariables: { writer: `${writer.runner} ${writer.model}` },
      })
      if (isInfrastructureFailure(review)) return { kind: "infrastructure", reason: `reviewer ${review.failureClass}: ${review.result.summary}` }
      if (review.result.status !== "done") return { kind: "failed", reason: `reviewer ${review.result.status}: ${review.result.summary}`, diff }
      try {
        verdict = parseVerdict(review.result.summary)
      } catch (error) {
        reviewError = (error as Error).message
        store.log("review", `${task.id} attempt ${attempt}: verdict rejected: ${reviewError.slice(0, 300)}`)
      }
    }
    if (!verdict) return { kind: "failed", reason: `the reviewer gave no valid verdict: ${reviewError}`, diff }
    const fileHashes = diffFileHashes(diff)
    store.recordReview({
      taskId: task.id,
      attempt,
      verdict: verdict.verdict,
      flaggedFiles: verdict.verdict === "fail" ? flaggedFiles(Object.keys(fileHashes), verdict) : [],
      fileHashes,
    })
    if (verdict.verdict !== "pass") {
      return { kind: "failed", reason: `reviewer rejected the change.\nReasons: ${verdict.reasons.join("; ")}\nFixes: ${verdict.fixes.join("; ")}`, diff }
    }

    appendProgress(workspace.path, task, changed, worker.result.summary)
    const title = `feat(${task.id}): ${task.title}`
    try {
      commitAndRebase(workspace, title)
      context.github.land({
        branch: workspace.branch,
        title,
        body: pullRequestBody(context, task, attempt, verdict),
        localMerge: () => fastForwardMain(projectDir, workspace.branch),
      })
    } catch (error) {
      return { kind: "failed", reason: `merge failed: ${(error as Error).message}` }
    }
    store.setTaskFiles(task.id, changed)
    store.log("progress", `${task.id}: appended to ${progressPath} (${changed.length} files)`)
    return { kind: "passed" }
  } catch (error) {
    store.log("harness", `${task.id} attempt ${attempt} crashed: ${(error as Error).message}`)
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

// Files merged by the tasks this one depends on, oldest dependency first.
function dependencyChanges(store: Store, task: Task): { taskId: string; files: string[] }[] {
  return task.dependsOn.map((taskId) => ({ taskId, files: store.taskFiles(taskId) }))
}

// The orchestrator, not the agent, keeps this log; it lands in the same commit as the task.
export function appendProgress(dir: string, task: Task, files: string[], workerSummary: string): void {
  const path = join(dir, progressPath)
  mkdirSync(join(dir, "docs"), { recursive: true })
  const header = existsSync(path) ? "" : "# Progress\n\nThe orchestrator appends one entry per merged task. Read it before you start.\n"
  const summary = workerSummary.trim().split("\n").map((line) => line.trim()).filter(Boolean).slice(0, maxSummaryLines)
  const entry = [
    "",
    `## ${task.id}: ${task.title}`,
    "",
    `Files: ${files.length ? files.map((file) => `\`${file}\``).join(", ") : "none"}`,
    "",
    ...(summary.length ? summary.map((line) => `> ${line}`) : ["> (no summary)"]),
    "",
  ].join("\n")
  writeFileSync(path, `${existsSync(path) ? readFileSync(path, "utf8").trimEnd() + "\n" : header}${entry}`)
}

// A compact tree of the tracked files, without lockfiles and binary assets, capped at maxLines lines.
export function codeMap(files: string[], maxLines = maxCodeMapLines): string[] {
  const shown = files.filter((file) => !lockfileNames.has(file.split("/").pop() ?? "") && !assetPattern.test(file)).sort()
  const lines: string[] = []
  const openDirectories: string[] = []
  for (const file of shown) {
    const parts = file.split("/")
    let depth = 0
    while (depth < openDirectories.length && depth < parts.length - 1 && openDirectories[depth] === parts[depth]) depth++
    openDirectories.length = depth
    for (; depth < parts.length - 1; depth++) {
      lines.push(`${"  ".repeat(depth)}${parts[depth]}/`)
      openDirectories.push(parts[depth])
    }
    lines.push(`${"  ".repeat(depth)}${parts[depth]}`)
  }
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), `[${lines.length - maxLines + 1} more lines not shown]`]
}

function attemptDiffPath(projectDir: string, taskId: string, attempt: number): string {
  return join(projectDir, ".agent-team", "attempts", `${taskId}-${attempt}.diff`)
}

// The file starts with the failure reason as `# ` lines, then the diff, so `git apply` still reads it.
function writeAttemptDiff(projectDir: string, taskId: string, attempt: number, reason: string, diff: string): void {
  const path = attemptDiffPath(projectDir, taskId, attempt)
  mkdirSync(join(projectDir, ".agent-team", "attempts"), { recursive: true })
  const header = [`Attempt ${attempt} of ${taskId} was rejected.`, "Reason:", ...reason.split("\n")].map((line) => `# ${line}`.trimEnd())
  writeFileSync(path, `${header.join("\n")}\n\n${capDiff(diff)}`)
}

function readAttemptDiff(projectDir: string, taskId: string, attempt: number): string | null {
  const path = attemptDiffPath(projectDir, taskId, attempt)
  if (attempt < 1 || !existsSync(path)) return null
  const lines = readFileSync(path, "utf8").split("\n")
  const start = lines.findIndex((line) => !line.startsWith("#"))
  const diff = lines.slice(start === -1 ? lines.length : start).join("\n").trim()
  return diff || null
}

function capDiff(diff: string): string {
  return diff.length > maxAttemptDiffLength ? `${diff.slice(0, maxAttemptDiffLength)}\n[diff truncated at 40 KB]` : diff
}

async function runQaPhase(context: PipelineContext, deploy: () => Promise<RunOutcome>): Promise<RunOutcome> {
  const { config, store } = context
  if (!config.qa.enabled) {
    if (store.phaseStatus("qa") !== "approved") {
      store.setPhase("qa", "approved")
      store.log("phase", "qa skipped: disabled in pipeline.yaml")
    }
    return deploy()
  }
  return runQaLoop(store, config.qa.maxRounds, {
    runRound: async (round) => {
      const result = await runQaRound(context, round)
      if (result.kind === "infrastructure") noteStop(context, `QA round ${round} paused: ${result.reason}`)
      if (result.kind === "invalid") noteStop(context, `QA round ${round} gave no usable verdict: ${result.reason}`)
      return result
    },
    applyFixes: (round, tasks) => appendFixTasks(context, round, tasks),
    build: () => buildTasks(context),
    deploy,
  })
}

interface TestGateResult {
  install: string | null
  command: string | null
  passed: boolean
  output: string
}

// Round artifacts go to .agent-team/qa/round-<n>/: tests.json, report.json, <route-slug>.png, verdict.json.
async function runQaRound(context: PipelineContext, round: number): Promise<QaRoundResult> {
  const { projectDir, config, store } = context
  const roundPath = join(".agent-team", "qa", `round-${round}`)
  const outDir = join(projectDir, roundPath)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const name = `qa-${round}`
  const workspace = createWorkspace(projectDir, name)
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const tests = await runTestGate(context, executor, workspace.path, name)
    writeJson(join(outDir, "tests.json"), tests)
    store.log("qa", `round ${round}: tests ${tests.command ? (tests.passed ? "passed" : "failed") : "not found"}`)

    let visual: VisualReport | null = null
    let screens: QaScreen[] = []
    if (config.target === "api") {
      store.log("qa", `round ${round}: visual gate skipped: api-only target`)
    } else {
      const designPath = join(workspace.path, "docs/design.md")
      screens = parseDesignScreens(existsSync(designPath) ? readFileSync(designPath, "utf8") : "")
      visual = await captureScreenshots({ projectDir, outDir, screens, signal: context.signal })
      const broken = visual.routes.filter((route) => route.error || (route.status ?? 0) >= 400).length
      store.log("qa", visual.startError ? `round ${round}: app did not start: ${visual.startError.slice(0, 300)}` : `round ${round}: ${visual.routes.length} screenshots, ${broken} broken routes`)
      // The reviewer sees only its worktree, so the round's files are copied in at the same relative path.
      cpSync(outDir, join(workspace.path, roundPath), { recursive: true })
    }

    const existing = loadTasks(join(workspace.path, "tasks.json"))
    const hardFailures = qaHardFailures(tests, visual)
    let previousError: string | null = null
    for (let attempt = 1; attempt <= phaseAttempts; attempt++) {
      const prompt = qaPrompt({ round, roundPath, target: config.target, tests, visual, screens, brandingImages: listBrandingImages(workspace.path), existing, hardFailures, previousError })
      const outcome = await runAgent(context, executor, "qa", `qa-${round}-review-${attempt}`, qaTools, prompt)
      if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `qa ${outcome.failureClass}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      try {
        const verdict = parseQaVerdict(outcome.result.summary, round, existing)
        if (verdict.verdict === "pass" && hardFailures.length) throw new Error(`the verdict cannot be pass while these gates fail: ${hardFailures.join("; ")}`)
        writeJson(join(outDir, "verdict.json"), { round, ...verdict })
        return verdict.verdict === "pass" ? { kind: "pass", findings: verdict.findings } : { kind: "fail", findings: verdict.findings, tasks: verdict.tasks }
      } catch (error) {
        previousError = (error as Error).message
        store.log("qa", `round ${round}: verdict rejected: ${previousError.slice(0, 300)}`)
      }
    }
    writeJson(join(outDir, "verdict.json"), { round, verdict: "invalid", reason: previousError, findings: [], tasks: [] })
    return { kind: "invalid", reason: previousError ?? "no verdict" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

async function runTestGate(context: PipelineContext, executor: Executor, dir: string, subject: string): Promise<TestGateResult> {
  const architecturePath = join(dir, "docs/architecture.md")
  const commands = parseArchitectureCommands(existsSync(architecturePath) ? readFileSync(architecturePath, "utf8") : "")
  const packagePath = join(dir, "package.json")
  const hasTestScript = existsSync(packagePath) && Boolean(JSON.parse(readFileSync(packagePath, "utf8")).scripts?.test)
  const install = commands.install ?? detectSetupCommand(dir)
  const command = commands.test ?? (hasTestScript ? "npm test" : null)
  if (!command) return { install, command, passed: true, output: "No test command in docs/architecture.md or package.json." }
  if (install) {
    const setup = await runCommand(context, executor, install, `${subject}-install`)
    if (!setup.passed) return { install, command, passed: false, output: `install failed (${install}):\n${setup.output}` }
  }
  const result = await runCheck(context, executor, command, `${subject}-test`, "QA tests")
  return { install, command, passed: result.passed, output: result.output }
}

export function qaHardFailures(tests: TestGateResult, visual: VisualReport | null): string[] {
  const failures: string[] = []
  if (!tests.passed) failures.push(`tests failed (${tests.command})`)
  if (visual?.startError) failures.push("the app did not start")
  for (const route of visual?.routes ?? []) {
    if (route.error) failures.push(`${route.route} did not load: ${route.error}`)
    else if ((route.status ?? 0) >= 400) failures.push(`${route.route} answered HTTP ${route.status}`)
  }
  return failures
}

function listBrandingImages(dir: string): string[] {
  for (const brandingDir of ["design/branding", "design/mockups"]) {
    const path = join(dir, brandingDir)
    if (existsSync(path)) return readdirSync(path).filter((file) => imagePattern.test(file)).sort().map((file) => `${brandingDir}/${file}`)
  }
  return []
}

function qaPrompt(input: {
  round: number
  roundPath: string
  target: PipelineConfig["target"]
  tests: TestGateResult
  visual: VisualReport | null
  screens: QaScreen[]
  brandingImages: string[]
  existing: Task[]
  hardFailures: string[]
  previousError: string | null
}): string {
  const { round, roundPath, tests, visual } = input
  const lines = [`QA round ${round}. Project target: ${input.target}.`, "", "## Gate 1: tests", ""]
  if (tests.command) lines.push(`Install: \`${tests.install ?? "none"}\`. Test: \`${tests.command}\`. Result: ${tests.passed ? "passed" : "FAILED"}.`, "", "```", tests.output.trim(), "```")
  else lines.push(tests.output)
  lines.push("", "## Gate 2: screenshots", "")
  if (!visual) lines.push("Skipped: the target is api only.")
  else if (visual.startError) lines.push("The app did not start, so there are no screenshots:", "", "```", visual.startError, "```")
  else {
    lines.push(`Each route was loaded at ${visual.viewport.width}x${visual.viewport.height} and captured full page. Full report: ${roundPath}/report.json.`, "")
    for (const route of visual.routes) {
      const shot = route.file ? `${roundPath}/${route.file}` : "no screenshot"
      const status = route.error ? `error: ${route.error}` : `HTTP ${route.status ?? "unknown"}`
      const errors = route.consoleErrors.length ? `; console errors: ${route.consoleErrors.slice(0, 5).join(" | ")}` : "; no console errors"
      const branding = route.branding ? `; compare with design/branding/${route.branding}` : ""
      lines.push(`- \`${route.route}\`: ${shot}, ${status}${errors}${branding}`)
    }
  }
  lines.push("", "## References", "")
  lines.push(`Branding images: ${input.brandingImages.join(", ") || "none"}.`)
  lines.push("Read docs/spec.md, docs/design.md, docs/design-system.md, and design/tokens.css.")
  lines.push("", "## Tasks", "")
  lines.push(`Existing task ids (all merged): ${input.existing.map((task) => task.id).join(", ")}.`)
  lines.push(`Name fix tasks Q${round}01, Q${round}02, and so on.`)
  if (input.hardFailures.length) lines.push("", "These gates failed, so the verdict must be fail with a fix task for each:", ...input.hardFailures.map((failure) => `- ${failure}`))
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

async function appendFixTasks(context: PipelineContext, round: number, tasks: Task[]): Promise<void> {
  const { projectDir } = context
  const workspace = createWorkspace(projectDir, `qa-fixes-${round}`)
  try {
    const current = JSON.parse(readFileSync(join(workspace.path, "tasks.json"), "utf8")) as Task[]
    const added = tasks.filter((task) => !current.some((existing) => existing.id === task.id))
    const body = [`QA round ${round} failed. The QA agent added these fix tasks:`, "", ...added.map((task) => `- ${task.id}: ${task.title}`)].join("\n")
    landTasksFile(context, workspace, [...current, ...added], `chore(qa): add round ${round} fix tasks`, body)
  } finally {
    removeWorkspace(projectDir, workspace)
  }
}

// Writes tasks.json in a worktree from main, checks it, and lands it on main through the normal merge path.
export function landTasksFile(context: PipelineContext, workspace: Workspace, tasks: Task[], title: string, body: string): void {
  const path = join(workspace.path, "tasks.json")
  writeJson(path, tasks)
  loadTasks(path)
  commitAndRebase(workspace, title)
  context.github.land({
    branch: workspace.branch,
    title,
    body,
    localMerge: () => fastForwardMain(context.projectDir, workspace.branch),
  })
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

// Deploy is the last phase. When the app does not come up, a worker agent gets the failure and fixes
// the start setup (deploy.json, start script), the fix lands through the normal merge path, and deploy retries.
async function runDeployPhase(context: PipelineContext): Promise<{ outcome: RunOutcome; url: string | null }> {
  const { projectDir, config, store } = context
  if (!config.deploy.enabled) {
    store.setPhase("deploy", "approved")
    return { outcome: "completed", url: null }
  }
  if (store.phaseStatus("deploy") === "approved" && store.meta("deploy.url")) return { outcome: "completed", url: store.meta("deploy.url") }
  store.setPhase("deploy", "running")
  let failure: string | null = null
  for (let attempt = 1; attempt <= deployAttempts; attempt++) {
    if (failure) {
      store.log("deploy", `attempt ${attempt}: asking the worker to fix the deploy`)
      const fix = await attemptDeployFix(context, attempt, failure)
      if (fix.kind === "infrastructure") {
        store.setPhase("deploy", "pending")
        noteStop(context, `deploy paused: ${fix.reason}`)
        store.log("deploy", `paused: ${fix.reason.slice(0, 300)}`)
        return { outcome: "paused", url: null }
      }
      if (fix.kind !== "passed") {
        failure = `${failure}\n\nThe previous fix attempt failed: ${fix.reason}`
        continue
      }
    }
    const result = await deployProject(projectDir, store)
    if (result.url) {
      store.setPhase("deploy", "approved")
      return { outcome: "completed", url: result.url }
    }
    failure = result.error
  }
  store.setPhase("deploy", "failed")
  noteStop(context, `deploy failed after ${deployAttempts} attempts: ${failure ?? "no reason"}`)
  store.log("deploy", `gave up after ${deployAttempts} attempts. Fix it, then: agent-team run ${projectDir}`)
  return { outcome: "failed", url: null }
}

async function attemptDeployFix(context: PipelineContext, attempt: number, failure: string): Promise<AttemptResult> {
  const { projectDir } = context
  const name = `deploy-fix-${attempt}`
  const workspace = createWorkspace(projectDir, name)
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const setupCommand = detectSetupCommand(workspace.path)
    if (setupCommand) {
      const setup = await runCommand(context, executor, setupCommand, `${name}-setup`)
      if (!setup.passed) return { kind: "infrastructure", reason: `workspace setup failed (${setupCommand}):\n${setup.output}` }
    }
    const prompt = [
      "The finished app failed to start in production. Make it deployable without changing its features.",
      "",
      "The platform runs `<install> && <start>` from deploy.json in a node:22 container with PORT=3000, HOST=0.0.0.0, and NODE_ENV=production, then probes http://127.0.0.1:$PORT.",
      "Without deploy.json it falls back to `npm start`, then to serving a static index.html.",
      "",
      "Write or fix deploy.json at the repository root ({ \"install\": ..., \"start\": ..., \"port\": 3000 }) and the start script so the app serves on 0.0.0.0:$PORT. Keep the tests passing. Do not edit docs/ or contracts/.",
      "",
      "Deploy failure:",
      failure,
    ].join("\n")
    const worker = await runAgent(context, executor, "worker", `${name}-worker`, ["read", "edit", "write", "bash:npm", "bash:npx", "bash:node", "bash:ls"], prompt)
    if (isInfrastructureFailure(worker)) return { kind: "infrastructure", reason: `worker ${worker.failureClass}: ${worker.result.summary}` }
    if (worker.result.status !== "done") return { kind: "failed", reason: `worker ${worker.result.status}: ${worker.result.summary}` }

    const forbidden = changedFiles(workspace.path).filter((file) => file.startsWith("docs/") || file.startsWith("contracts/"))
    if (forbidden.length) return { kind: "failed", reason: `edited files outside the deploy scope: ${forbidden.join(", ")}` }
    const packagePath = join(workspace.path, "package.json")
    const hasTests = existsSync(packagePath) && Boolean(JSON.parse(readFileSync(packagePath, "utf8")).scripts?.test)
    if (hasTests) {
      const tests = await runCommand(context, executor, "npm test", `${name}-verify`)
      if (!tests.passed) return { kind: "failed", reason: `npm test failed after the deploy fix:\n${tests.output}` }
    }

    const title = "fix(deploy): make the app start in production"
    commitAndRebase(workspace, title)
    context.github.land({
      branch: workspace.branch,
      title,
      body: ["The deploy phase could not start the app. The worker agent changed the start setup.", "", "```", failure.slice(0, 3000), "```"].join("\n"),
      localMerge: () => fastForwardMain(projectDir, workspace.branch),
    })
    return { kind: "passed" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

function pullRequestBody(context: PipelineContext, task: Task, attempt: number, verdict: { reasons: string[] }): string {
  const issue = context.github.taskIssue(task)
  const worker = context.config.roles.worker
  return [
    issue ? `Closes #${issue}.` : "",
    "",
    `Built by the worker agent (${worker.runner} ${worker.model}) on attempt ${attempt}. \`${task.verify}\` passed.`,
    "",
    "## Review",
    "",
    "Verdict: **pass**",
    ...verdict.reasons.map((reason) => `- ${reason}`),
    "",
    "## Acceptance criteria",
    "",
    ...task.acceptance.map((criterion) => `- [x] ${criterion}`),
  ].join("\n")
}

function isInfrastructureFailure(outcome: HarnessOutcome): boolean {
  return outcome.failureClass !== null && outcome.failureClass !== "agent_failure"
}

let egressProxy: ReturnType<typeof ensureEgressProxy> | null = null

// readOnlyPaths defaults to the project's .git, which a project worktree's .git file points to.
export async function createExecutor(context: PipelineContext, hostDir: string, name: string, readOnlyPaths?: string[]): Promise<Executor> {
  const { config, projectDir } = context
  if (config.harness.isolation === "none") return hostExecutor(hostDir)
  const { allowlist, extraDomains } = config.harness.network
  if (allowlist) egressProxy ??= ensureEgressProxy([...defaultAllowlist, ...extraDomains])
  const credentials = [...new Set(Object.values(config.roles).flatMap((role) => [role.runner, ...role.fallbacks.map((fallback) => fallback.runner)]))]
  return createDockerExecutor({
    hostDir,
    image: await ensureImage(),
    name: `agent-team-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    limits: config.harness.docker,
    credentials,
    readOnlyPaths: readOnlyPaths ?? (hostDir === projectDir ? [] : [join(projectDir, ".git")]),
    network: allowlist ? await egressProxy! : undefined,
  })
}

async function runCommand(context: PipelineContext, executor: Executor, command: string, subject: string): Promise<{ passed: boolean; output: string }> {
  const result = await executor.exec({
    command: "sh",
    args: ["-c", command],
    input: "",
    timeoutMs: commandTimeoutMs,
    transcriptPath: transcriptPath(context, `${subject}.log`),
    signal: context.signal,
  })
  const output = `${result.stdout}\n${result.stderr}`.slice(-4000)
  if (result.timedOut) return { passed: false, output: `timed out after ${commandTimeoutMs / 1000}s\n${output}` }
  return { passed: result.exitCode === 0 && !result.aborted, output }
}

// Runs a test command and, when it fails, once more; a pass on the rerun is logged as flaky and accepted.
async function runCheck(context: PipelineContext, executor: Executor, command: string, subject: string, label: string): Promise<{ passed: boolean; output: string }> {
  const first = await runCommand(context, executor, command, subject)
  if (first.passed || context.signal.aborted) return first
  const rerun = await runCommand(context, executor, command, `${subject}-rerun`)
  if (rerun.passed) context.store.log("flaky", `${label} failed, then passed on a rerun (\`${command}\`). First output:\n${first.output.slice(-1500)}`)
  return rerun
}

function workerTools(task: Task): string[] {
  const verifyExecutable = task.verify.trim().split(/\s+/)[0]
  return [...new Set(["read", "edit", "write", "bash:npm", "bash:npx", "bash:node", "bash:mkdir", "bash:ls", `bash:${verifyExecutable}`])]
}

export interface WorkerPromptInput {
  task: Task
  previous: PreviousAttempt | null
  // Compact `git ls-files` tree of the worktree.
  codeMap?: string[]
  // Files merged by each task in dependsOn.
  dependencyFiles?: { taskId: string; files: string[] }[]
  hasProgress?: boolean
}

// The worker and reviewer read the progress log whenever it exists.
function withProgressReadPath(task: Task, hasProgress: boolean | undefined): Task {
  return hasProgress && !task.readPaths.includes(progressPath) ? { ...task, readPaths: [progressPath, ...task.readPaths] } : task
}

function dependencySection(dependencyFiles: { taskId: string; files: string[] }[] | undefined): string | null {
  if (!dependencyFiles?.length) return null
  const lines = dependencyFiles.map(({ taskId, files }) => `- ${taskId}: ${files.length ? files.join(", ") : "no recorded files"}`)
  return ["## Files changed by the tasks this one depends on", "", ...lines].join("\n")
}

// The one place that builds the worker's task prompt.
export function workerPrompt(input: WorkerPromptInput): string {
  const { task, previous } = input
  const sections = ["Implement this task:", JSON.stringify(withProgressReadPath(task, input.hasProgress), null, 2)]
  if (input.hasProgress) sections.push(`Read ${progressPath} first: it lists what earlier tasks built.`)
  const dependencies = dependencySection(input.dependencyFiles)
  if (dependencies) sections.push(dependencies)
  if (input.codeMap?.length) sections.push(["## Code map (git ls-files, without lockfiles and assets)", "", "```", ...input.codeMap, "```"].join("\n"))
  if (previous) {
    sections.push(
      [
        "## Previous attempt",
        "",
        "Your previous attempt was rejected. Fix the listed problems; do not start over. Your worktree starts clean from main, so reapply the parts of the previous diff that were right, then fix the problems.",
        "",
        "Why it was rejected:",
        "",
        "```",
        previous.reason.trim(),
        "```",
      ].join("\n"),
    )
    if (previous.diff) sections.push(["Previous diff:", "", "```diff", previous.diff, "```"].join("\n"))
  }
  return sections.join("\n\n")
}

export interface ReviewPromptInput {
  task: Task
  diff: string
  verifyOutput: string
  previousError: string | null
  hasProgress?: boolean
  dependencyFiles?: { taskId: string; files: string[] }[]
}

// The goal comes first and again after the diff, so a long diff does not push it out of focus.
export function reviewPrompt(input: ReviewPromptInput): string {
  const { task, diff } = input
  const maxDiffLength = 60_000
  const shownDiff = diff.length > maxDiffLength ? `${diff.slice(0, maxDiffLength)}\n[diff truncated]` : diff
  const sections = ["Task:", JSON.stringify(withProgressReadPath(task, input.hasProgress), null, 2)]
  if (input.hasProgress) sections.push(`${progressPath} lists what earlier tasks built. Read it for context.`)
  const dependencies = dependencySection(input.dependencyFiles)
  if (dependencies) sections.push(`${dependencies}\n\nRead them when the diff builds on them.`)
  sections.push("Verify output (passed):", input.verifyOutput, "Diff:", shownDiff)
  sections.push(
    [
      `## Reminder: the goal of ${task.id}`,
      "",
      task.title,
      "",
      "Acceptance criteria:",
      ...task.acceptance.map((criterion) => `- ${criterion}`),
      "",
      "Judge the diff above against these criteria.",
    ].join("\n"),
  )
  if (input.previousError) sections.push(`Your previous answer was rejected: ${input.previousError}. End with exactly one \`\`\`json block that holds the verdict object.`)
  return sections.join("\n\n")
}

export interface ReviewVerdict {
  verdict: "pass" | "fail"
  reasons: string[]
  fixes: string[]
}

export function parseVerdict(text: string): ReviewVerdict {
  const parsed = extractJsonObject(text) as any
  if (parsed?.verdict !== "pass" && parsed?.verdict !== "fail") throw new Error('verdict must be "pass" or "fail"')
  const reasons = parsed.reasons ?? []
  const fixes = parsed.fixes ?? []
  if (!isStringList(reasons) || !isStringList(fixes)) throw new Error("reasons and fixes must be arrays of strings")
  if (parsed.verdict === "fail" && !reasons.length) throw new Error("a fail verdict needs at least one reason")
  return { verdict: parsed.verdict, reasons, fixes }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

export interface AgentOptions {
  // Globs the agent may edit; the Claude runner turns them into path-scoped permission rules.
  writablePaths?: string[]
  // Prompt file in prompts/, when it differs from the role name (the replanner runs as the planner role).
  promptName?: string
  // Values for {{name}} placeholders in the system prompt.
  promptVariables?: Record<string, string>
}

// Returned instead of calling an agent once the run budget is spent; callers treat it as a pause.
function budgetStop(context: PipelineContext, subject: string): HarnessOutcome | null {
  const { config, store } = context
  const state = runState(context)
  const spent = store.projectCost()
  if (spent.usd < config.budget.runUsd) return null
  if (!state.budgetExceeded) {
    state.budgetExceeded = true
    const codex = spent.unreportedCalls ? `; ${spent.unreportedCalls} calls (codex) reported no cost and are not counted` : ""
    const message = `run budget reached: $${spent.usd.toFixed(2)} reported of $${config.budget.runUsd.toFixed(2)} (budget.runUsd)${codex}. Stopped before ${subject}. Raise budget.runUsd in pipeline.yaml, then resume`
    state.stopReason = message
    store.log("budget", message)
  }
  return {
    result: { status: "aborted", summary: "run budget reached", costUsd: null, durationMs: 0, exitCode: null, diagnostics: "" },
    candidate: null,
    failureClass: "aborted",
  }
}

export async function runAgent(context: PipelineContext, executor: Executor, role: Role, subject: string, allowedTools: string[], taskPrompt: string, options: AgentOptions = {}): Promise<HarnessOutcome> {
  const { config, harness } = context
  const stopped = budgetStop(context, subject)
  if (stopped) return stopped
  return harness.run(
    config.roles[role],
    {
      role,
      subject,
      systemPrompt: fillPrompt(loadPrompt(options.promptName ?? role), options.promptVariables ?? {}),
      taskPrompt,
      allowedTools,
      writablePaths: options.writablePaths,
      budgetUsd: config.budget.perTaskUsd,
      transcriptPath: (candidate: Candidate, attempt: number) => transcriptPath(context, `${subject}-${candidate.runner}-${attempt}.log`),
    },
    executor,
  )
}

function transcriptPath(context: PipelineContext, fileName: string): string {
  const dir = join(context.projectDir, ".agent-team", "transcripts")
  mkdirSync(dir, { recursive: true })
  return join(dir, fileName)
}

export function fillPrompt(prompt: string, variables: Record<string, string>): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => variables[name] ?? placeholder)
}

function loadPrompt(name: string): string {
  return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8")
}

function requireFile(path: string): string {
  if (!existsSync(path)) throw new Error(`missing required file ${path}`)
  return path
}

function requireHeadings(path: string, headings: string[]): void {
  const lines = readFileSync(requireFile(path), "utf8").split("\n").map((line) => line.trim())
  const missing = headings.filter((heading) => !lines.includes(heading))
  if (missing.length) throw new Error(`${path} is missing headings: ${missing.join(", ")}`)
}
