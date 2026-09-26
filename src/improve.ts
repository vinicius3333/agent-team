import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { openChange, raiseRunBudget } from "./project.ts"
import { evaluationDimensions, gapFinding, parseEvaluation, parseSprintPlan, sprintBlocker, sprintRequest, syncSprint, type Evaluation, type EvaluationGap, type SprintPlan } from "./sprint.ts"
import { applyCuratorResult, collectSignals, curatorPrompt, lessonsPath, loadLessons, parseCuratorResult, projectStacks, recordRetired, removedIds, saveLessons } from "./lessons.ts"
import { createExecutor, ensureDeployed, isInfrastructureFailure, landingBranch, qaRoundPath, runAgent, type PipelineContext, type RunOutcome } from "./pipeline.ts"
import { createWorkspace, removeWorkspace } from "./harness/workspace.ts"
import { deployErrorKey } from "./deploy.ts"
import type { Finding, Store } from "./store.ts"

const readTools = ["read"]
const agentAttempts = 2
const curateAttempts = 2
const learnedAtKey = "learning.curatedAt"
// Fewer new signals than this after a stopped run are not worth a curator call; a finished run always curates.
const minSignals = 3
const maxSignals = 40
const maxChatMessages = 40

export function evaluationPath(sprint: number): string {
  return join(".agent-team", "evaluations", `sprint-${sprint}.json`)
}

// Plans the next sprint and opens its change, so the rest of the run builds, checks, merges, and deploys it.
// Returns null to go on with the pipeline, or an outcome when there is nothing to build. A failed plan is recorded on
// the sprint and ends the run as completed: the doctor tries again later, with no incident.
export async function startSprint(context: PipelineContext, options: { early: boolean }): Promise<RunOutcome | null> {
  const { projectDir, store, config } = context
  syncSprint(store)
  const blocker = sprintBlocker(store, config, { early: options.early, insideRun: true })
  if (blocker) {
    store.log("sprint", `no sprint started: ${blocker}`)
    return null
  }
  const spent = store.projectCost().usd
  const needed = Math.ceil((spent + config.sprints.budgetUsd) * 100) / 100
  if (config.budget.runUsd < needed) {
    config.budget.runUsd = raiseRunBudget(projectDir, store, needed)
  }
  const sprint = store.startSprint(spent)
  store.log("sprint", `sprint ${sprint.number} started (at most $${config.sprints.budgetUsd.toFixed(2)})`)
  try {
    const result = await planSprint(context, sprint.number)
    if (result.kind !== "planned") {
      store.finishSprint(sprint.number, "failed", `${result.kind === "infrastructure" ? "runner problem" : "no usable plan"}: ${result.reason.slice(0, 500)}`)
      store.log("sprint", `sprint ${sprint.number} failed: ${result.reason.slice(0, 300)}`)
      return "completed"
    }
    const { plan, evaluation } = result
    store.updateSprint(sprint.number, { goal: plan.goal, score: evaluation?.score ?? null })
    for (const entry of plan.dismiss) {
      store.setFindingStatus(entry.id, "dismissed")
      store.log("sprint", `sprint ${sprint.number}: dismissed backlog item ${entry.id}: ${entry.reason.slice(0, 200)}`)
    }
    const proposed = plan.proposals.map((proposal) => store.addFinding({ source: "product", ...proposal }).id)
    const picked = [...plan.items, ...proposed].map((id) => store.finding(id)!).filter(Boolean)
    if (!picked.length) {
      store.finishSprint(sprint.number, "skipped", "the backlog has nothing worth building")
      store.log("sprint", `sprint ${sprint.number} skipped: nothing worth building`)
      return "completed"
    }
    const change = openChange(projectDir, store, sprintRequest(sprint.number, plan, picked), { insideRun: true })
    for (const item of picked) store.setFindingStatus(item.id, "approved", change.id)
    store.updateSprint(sprint.number, { status: "building", changeId: change.id })
    store.log("sprint", `sprint ${sprint.number}: building ${picked.length} items as change ${change.id}: ${plan.goal}`)
    return null
  } catch (error) {
    store.finishSprint(sprint.number, "failed", (error as Error).message.slice(0, 500))
    store.log("sprint", `sprint ${sprint.number} failed: ${(error as Error).message.slice(0, 300)}`)
    return "completed"
  }
}

export type SprintPlanResult =
  | { kind: "planned"; plan: SprintPlan; evaluation: Evaluation | null }
  | { kind: "invalid"; reason: string }
  | { kind: "infrastructure"; reason: string }

// The evaluator scores the live app and its gaps join the backlog; then the PM picks what the sprint builds.
// A failed evaluation does not stop the sprint: the PM plans from the backlog alone.
export async function planSprint(context: PipelineContext, sprint: number): Promise<SprintPlanResult> {
  const { store } = context
  // The evaluator judges the live app, so bring it up first. A failed deploy does not stop the sprint: the report says why.
  await ensureDeployed(context)
  store.log("sprint", `sprint ${sprint}: evaluating the live app against the brief`)
  const evaluated = await evaluate(context, sprint)
  if (evaluated.kind === "infrastructure") return evaluated
  const evaluation = evaluated.kind === "evaluated" ? evaluated.evaluation : null
  if (evaluated.kind === "invalid") {
    store.log("sprint", `sprint ${sprint}: no usable evaluation (${evaluated.reason.slice(0, 300)}); planning from the backlog alone`)
  } else if (evaluation) {
    const added = evaluation.gaps.map((gap) => store.addFinding(gapFinding(gap, evaluation))).filter((result) => result.created).length
    store.log("sprint", `sprint ${sprint}: score ${evaluation.score}/100, ${evaluation.gaps.length} gaps (${added} new in the backlog). ${evaluation.summary.slice(0, 400)}`)
  }
  return pickSprintItems(context, sprint, evaluation)
}

type EvaluateResult = { kind: "evaluated"; evaluation: Evaluation } | { kind: "invalid"; reason: string } | { kind: "infrastructure"; reason: string }

async function evaluate(context: PipelineContext, sprint: number): Promise<EvaluateResult> {
  const { projectDir, store } = context
  const name = `evaluate-${sprint}`
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const screenshots = copyLatestQaRound(context, workspace.path)
    let previousError: string | null = null
    for (let attempt = 1; attempt <= agentAttempts; attempt++) {
      const prompt = evaluatorPrompt({ context, sprint, screenshots, previousError })
      const outcome = await runAgent(context, executor, "evaluator", `${name}-${attempt}`, readTools, prompt)
      if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `evaluator ${outcome.failureClass}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      try {
        const evaluation = parseEvaluation(outcome.result.summary, sprint)
        writeEvaluation(projectDir, evaluation)
        return { kind: "evaluated", evaluation }
      } catch (error) {
        previousError = (error as Error).message
        store.log("sprint", `sprint ${sprint}: evaluation rejected: ${previousError.slice(0, 300)}`)
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
  const path = join(projectDir, evaluationPath(evaluation.sprint))
  mkdirSync(join(projectDir, ".agent-team", "evaluations"), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...evaluation, at: new Date().toISOString() }, null, 2)}\n`)
}

// The evaluator sees the app through the screenshots of the last QA round, copied into its worktree.
// The newest round may sit in a change's folder (qa/C001/round-11) when that change's QA was the last one to run.
export function copyLatestQaRound(context: PipelineContext, workspacePath: string): string | null {
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

// The sprint report line for the live app. An empty deploy.url means not deployed too; the reason comes from deploy.error.
export function liveAppLine(store: Store): string {
  const url = store.meta("deploy.url")
  if (url) return `- The live app: ${url}.`
  const reason = store.meta(deployErrorKey)
  return reason ? `- The live app: not deployed (${reason.replace(/\.$/, "")}).` : "- The live app: not deployed."
}

function userRequests(context: PipelineContext): string[] {
  const messages = context.store.chatMessages(maxChatMessages, "all").filter((message) => message.author === "human")
  return messages.map((message) => `- ${message.at}: ${message.body.replace(/\s+/g, " ").slice(0, 400)}`)
}

function evaluatorPrompt(input: { context: PipelineContext; sprint: number; screenshots: string | null; previousError: string | null }): string {
  const { context, sprint } = input
  const { store } = context
  const previous = readPreviousEvaluation(context.projectDir, sprint)
  const requests = userRequests(context)
  const lines = [
    `Sprint ${sprint}. Project target: ${context.config.target}.`,
    "",
    "## Sources",
    "",
    "- The brief: `input.md`. The spec: `docs/spec.md`. Also read `docs/architecture.md`, `docs/design.md`, and the code.",
    liveAppLine(store),
    input.screenshots ? `- Screenshots of every route from the last QA round: \`${input.screenshots}/\` (report.json lists them). Open them.` : "- No QA screenshots are available.",
  ]
  if (previous) {
    lines.push("", `## Previous evaluation (sprint ${previous.sprint}, score ${previous.score})`, "", previous.summary, "", ...previous.gaps.map((gap) => `- [${gap.severity}] ${gap.title}`))
    lines.push("", "Check whether each previous gap is closed. Repeat a gap that is still open with the same title, and say in the detail what is still wrong.")
  }
  if (requests.length) lines.push("", "## What the user asked for in the project chat", "", ...requests)
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

// The newest evaluation before this sprint; evaluations from the evolve loop (cycle-<n>.json) count too.
function readPreviousEvaluation(projectDir: string, sprint: number): { sprint: number; score: number; summary: string; gaps: EvaluationGap[] } | null {
  const dir = join(projectDir, ".agent-team", "evaluations")
  if (!existsSync(dir)) return null
  const current = basename(evaluationPath(sprint))
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== current)
    .map((file) => join(dir, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      return { sprint: parsed.sprint ?? parsed.cycle ?? 0, score: parsed.score, summary: String(parsed.summary ?? ""), gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [] }
    } catch {}
  }
  return null
}

async function pickSprintItems(context: PipelineContext, sprint: number, evaluation: Evaluation | null): Promise<SprintPlanResult> {
  const { projectDir, store, config } = context
  const name = `sprint-plan-${sprint}`
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  try {
    let previousError: string | null = null
    for (let attempt = 1; attempt <= agentAttempts; attempt++) {
      const backlog = store.listFindings({ status: "open" })
      const prompt = sprintPlannerPrompt({ context, sprint, backlog, evaluation, previousError })
      const outcome = await runAgent(context, executor, "pm", `${name}-${attempt}`, readTools, prompt, { promptName: "sprint-planner" })
      if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `pm ${outcome.failureClass}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      try {
        return { kind: "planned", plan: parseSprintPlan(outcome.result.summary, backlog, config.sprints), evaluation }
      } catch (error) {
        previousError = (error as Error).message
        store.log("sprint", `sprint ${sprint}: plan rejected: ${previousError.slice(0, 300)}`)
      }
    }
    return { kind: "invalid", reason: previousError ?? "no plan" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

function sprintPlannerPrompt(input: { context: PipelineContext; sprint: number; backlog: Finding[]; evaluation: Evaluation | null; previousError: string | null }): string {
  const { context, sprint, backlog, evaluation } = input
  const { sprints } = context.config
  const done = context.store.sprints(6).filter((entry) => entry.number !== sprint && entry.goal)
  const requests = userRequests(context)
  const lines = [
    `Sprint ${sprint}. Pick at most ${sprints.maxItems} items and proposals together.`,
    sprints.newFeatures ? "You may propose new features the brief does not ask for." : "Do not propose new features: `proposals` must be empty.",
    "",
    "## Sources",
    "",
    "- The brief: `input.md`. The spec: `docs/spec.md`. The finished changes: `docs/changes/*/request.md`.",
    liveAppLine(context.store),
  ]
  if (evaluation) {
    lines.push("", `## This sprint's evaluation: ${evaluation.score}/100`, "", evaluation.summary, "", ...evaluationDimensions.map((dimension) => `- ${dimension}: ${evaluation.dimensions[dimension].score}. ${evaluation.dimensions[dimension].notes}`))
  }
  if (done.length) lines.push("", "## Earlier sprints (newest first)", "", ...done.map((entry) => `- Sprint ${entry.number} (${entry.status}${entry.score === null ? "" : `, score ${entry.score}`}): ${entry.goal}`))
  if (requests.length) lines.push("", "## What the user asked for in the project chat", "", ...requests)
  lines.push("", "## Open backlog", "")
  if (backlog.length) {
    for (const item of backlog) {
      lines.push(`### #${item.id} [${item.source}, ${item.severity}] ${item.title}`, "", `Evidence: ${item.evidence.slice(0, 600)}`, "", `Proposal: ${item.proposal.slice(0, 600)}`, "")
    }
  } else {
    lines.push("(empty)")
  }
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
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
          recordRetired(path, removedIds(result))
          store.setMeta(learnedAtKey, startedAt)
          store.log("learning", `${signals.length} signals: ${result.updates.filter((update) => update.id).length} lessons confirmed, ${result.updates.filter((update) => !update.id).length} new, ${result.weaken?.length ?? 0} weakened, ${(result.merge ?? []).reduce((sum, merge) => sum + merge.from.length, 0)} merged, ${result.retire.length} retired`)
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
