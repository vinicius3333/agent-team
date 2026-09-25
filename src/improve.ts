import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { loadConfig } from "./config.ts"
import { parseEvaluation, runEvolveLoop, type EvaluateResult, type Evaluation, type EvolveOutcome } from "./evolve.ts"
import { applyCuratorResult, collectSignals, curatorPrompt, lessonsPath, loadLessons, parseCuratorResult, projectStacks, recordRetired, saveLessons } from "./lessons.ts"
import { createExecutor, isInfrastructureFailure, landingBranch, landTasksFile, qaRoundPath, runAgent, type PipelineContext, type RunOutcome } from "./pipeline.ts"
import { createWorkspace, removeWorkspace } from "./harness/workspace.ts"
import { loadTasks, type Task } from "./tasks.ts"

const readTools = ["read"]
const evaluateAttempts = 2
const curateAttempts = 2
const learnedAtKey = "learning.curatedAt"
// Fewer new signals than this after a stopped run are not worth a curator call; a finished run always curates.
const minSignals = 3
const maxSignals = 40
const maxChatMessages = 40

export function evaluationPath(cycle: number): string {
  return join(".agent-team", "evaluations", `cycle-${cycle}.json`)
}

// Runs the evolve loop after the first deploy. ship() builds the evaluator's tasks, runs QA, and deploys again.
export async function runEvolution(context: PipelineContext, ship: () => Promise<RunOutcome>, noteStop: (reason: string, kind?: "budget") => void): Promise<EvolveOutcome> {
  const { config, store } = context
  return runEvolveLoop(store, config.evolve, {
    spentUsd: () => store.projectCost().usd,
    runBudgetUsd: () => {
      try {
        return loadConfig(join(context.projectDir, "pipeline.yaml")).budget.runUsd
      } catch {
        return config.budget.runUsd
      }
    },
    evaluate: (cycle) => evaluate(context, cycle),
    learn: () => learnLessons(context, { force: true }),
    addTasks: (cycle, tasks) => addEvolveTasks(context, cycle, tasks),
    ship,
    noteStop,
  })
}

async function evaluate(context: PipelineContext, cycle: number): Promise<EvaluateResult> {
  const { projectDir, store } = context
  const name = `evaluate-${cycle}`
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const screenshots = copyLatestQaRound(context, workspace.path)
    const existing = loadTasks(join(workspace.path, "tasks.json"))
    let previousError: string | null = null
    for (let attempt = 1; attempt <= evaluateAttempts; attempt++) {
      const prompt = evaluatorPrompt({ context, cycle, existing, screenshots, previousError })
      const outcome = await runAgent(context, executor, "evaluator", `${name}-${attempt}`, readTools, prompt)
      if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `evaluator ${outcome.failureClass}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      try {
        const evaluation = parseEvaluation(outcome.result.summary, cycle, existing)
        writeEvaluation(projectDir, evaluation)
        return { kind: "evaluated", evaluation }
      } catch (error) {
        previousError = (error as Error).message
        store.log("evolve", `cycle ${cycle}: evaluation rejected: ${previousError.slice(0, 300)}`)
      }
    }
    return { kind: "invalid", reason: previousError ?? "no evaluation" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

function writeEvaluation(projectDir: string, evaluation: Evaluation): void {
  const path = join(projectDir, evaluationPath(evaluation.cycle))
  mkdirSync(join(projectDir, ".agent-team", "evaluations"), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...evaluation, at: new Date().toISOString() }, null, 2)}\n`)
}

// The evaluator sees the app through the screenshots of the last QA round, copied into its worktree.
// The newest round may sit in a change's folder (qa/C001/round-11) when that change's QA was the last one to run.
function copyLatestQaRound(context: PipelineContext, workspacePath: string): string | null {
  const round = Number(context.store.meta("qa.round") ?? 0)
  if (!round) return null
  const qaDir = join(context.projectDir, ".agent-team", "qa")
  const changeIds = existsSync(qaDir) ? readdirSync(qaDir).filter((name) => /^C\d+$/.test(name)).sort().reverse() : []
  const candidates = [context.store.currentChange()?.id ?? null, null, ...changeIds].map((changeId) => qaRoundPath(changeId, round))
  const relative = candidates.find((path) => existsSync(join(context.projectDir, path, "report.json")))
  if (!relative) return null
  cpSync(join(context.projectDir, relative), join(workspacePath, relative), { recursive: true })
  return relative
}

function evaluatorPrompt(input: { context: PipelineContext; cycle: number; existing: Task[]; screenshots: string | null; previousError: string | null }): string {
  const { context, cycle } = input
  const { store } = context
  const liveUrl = store.meta("deploy.url")
  const previous = cycle > 1 ? readPreviousEvaluation(context.projectDir, cycle - 1) : null
  const userMessages = store.chatMessages(maxChatMessages, "all").filter((message) => message.author === "human")
  const findings = store.listFindings({ status: "open" })
  const lines = [
    `Evolve cycle ${cycle}. Target score: ${context.config.evolve.targetScore}/100. Project target: ${context.config.target}.`,
    "",
    "## Sources",
    "",
    "- The brief: `input.md`. The spec: `docs/spec.md`. Also read `docs/architecture.md`, `docs/design.md`, and the code.",
    `- The live app: ${liveUrl ?? "not deployed"}.`,
    input.screenshots ? `- Screenshots of every route from the last QA round: \`${input.screenshots}/\` (report.json lists them). Open them.` : "- No QA screenshots are available.",
  ]
  if (previous) {
    lines.push("", `## Previous evaluation (cycle ${previous.cycle}, score ${previous.score})`, "", previous.summary, "", ...previous.gaps.map((gap) => `- [${gap.severity}] ${gap.title}`))
    lines.push("", "Check whether each previous gap is closed. A gap that is still open after its task was built is a sign the task was too vague: write a sharper one.")
  }
  if (userMessages.length) {
    lines.push("", "## What the user asked for in the project chat", "", ...userMessages.map((message) => `- ${message.at}: ${message.body.replace(/\s+/g, " ").slice(0, 400)}`))
  }
  if (findings.length) {
    lines.push("", "## Open findings from the live app (monitoring, analytics, research)", "", ...findings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.proposal.slice(0, 300)}`))
  }
  lines.push("", "## Tasks", "", `Existing task ids (all merged): ${input.existing.map((task) => task.id).join(", ")}.`, `Name new tasks E${cycle}01, E${cycle}02, and so on.`)
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

function readPreviousEvaluation(projectDir: string, cycle: number): Evaluation | null {
  try {
    return JSON.parse(readFileSync(join(projectDir, evaluationPath(cycle)), "utf8"))
  } catch {
    return null
  }
}

async function addEvolveTasks(context: PipelineContext, cycle: number, tasks: Task[]): Promise<void> {
  const { projectDir, store } = context
  const workspace = createWorkspace(projectDir, `evolve-tasks-${cycle}`, landingBranch(context))
  try {
    const current = JSON.parse(readFileSync(join(workspace.path, "tasks.json"), "utf8")) as Task[]
    const added = tasks.filter((task) => !current.some((existing) => existing.id === task.id))
    const body = [`Evolve cycle ${cycle}: the evaluator scored the app under the target and added these tasks:`, "", ...added.map((task) => `- ${task.id}: ${task.title}`)].join("\n")
    landTasksFile(context, workspace, [...current, ...added], `chore(evolve): add cycle ${cycle} tasks`, body)
  } finally {
    removeWorkspace(projectDir, workspace)
  }
  // QA and deploy run again for the new tasks; a resumed run picks up from here.
  store.setPhase("qa", "pending")
  store.setPhase("deploy", "pending")
}

// Turns the run's new signals into lessons shared by every project in the runs folder. Never throws:
// learning is a side effect and must not stop a run.
export async function learnLessons(context: PipelineContext, options: { force: boolean }): Promise<void> {
  const { config, projectDir, store } = context
  if (!config.learning.enabled) return
  const since = Date.parse(store.meta(learnedAtKey) ?? "") || 0
  const startedAt = new Date().toISOString()
  const signals = collectSignals(projectDir, since).slice(-maxSignals)
  if (!signals.length || (!options.force && signals.length < minSignals)) return
  const path = lessonsPath(projectDir)
  const workspace = createWorkspace(projectDir, "curate", landingBranch(context))
  try {
    const executor = await createExecutor(context, workspace.path, "curate")
    try {
      let previousError: string | null = null
      for (let attempt = 1; attempt <= curateAttempts; attempt++) {
        const lessons = loadLessons(path)
        const prompt = curatorPrompt({ project: basename(projectDir), lessons, signals, stacks: projectStacks(projectDir) }) + (previousError ? `\n\nYour previous answer was rejected. Fix this: ${previousError}` : "")
        const outcome = await runAgent(context, executor, "curator", `curate-${startedAt.replace(/[:.]/g, "-")}-${attempt}`, readTools, prompt)
        if (outcome.result.status !== "done") {
          store.log("learning", `curator ${outcome.result.status}: ${outcome.result.summary.slice(0, 300)}`)
          return
        }
        try {
          const result = parseCuratorResult(outcome.result.summary, lessons)
          // Reloaded right before the write, so a lesson another project added meanwhile is kept.
          saveLessons(path, applyCuratorResult(loadLessons(path), result))
          recordRetired(path, result.retire)
          store.setMeta(learnedAtKey, startedAt)
          store.log("learning", `${signals.length} signals: ${result.updates.filter((update) => update.id).length} lessons confirmed, ${result.updates.filter((update) => !update.id).length} new, ${result.retire.length} retired`)
          return
        } catch (error) {
          previousError = (error as Error).message
        }
      }
      store.log("learning", `curator gave no usable result: ${(previousError ?? "").slice(0, 300)}`)
    } finally {
      await executor.dispose()
    }
  } catch (error) {
    store.log("learning", `could not curate lessons: ${(error as Error).message.slice(0, 300)}`)
  } finally {
    removeWorkspace(projectDir, workspace)
  }
}
