import { extractJsonObject } from "./json.ts"
import { findingSeverities, validateFixTasks, type FindingSeverity } from "./qa.ts"
import type { Store } from "./store.ts"
import type { Task } from "./tasks.ts"
import type { EvolveConfig } from "./config.ts"

// The evolve loop keeps a finished project improving: after each deploy the evaluator scores the live app against
// the brief, and while the score is under the target its gap tasks are built, checked by QA, and deployed again.

export const evaluationDimensions = ["brief_coverage", "functionality", "monetization", "ux_and_branding", "quality_and_reliability"] as const
export type EvaluationDimension = (typeof evaluationDimensions)[number]

export interface EvaluationGap {
  title: string
  detail: string
  severity: FindingSeverity
}

export interface Evaluation {
  cycle: number
  // 0 to 100: the mean of the dimension scores, computed by the orchestrator so the agent cannot round it up.
  score: number
  dimensions: Record<EvaluationDimension, { score: number; notes: string }>
  summary: string
  gaps: EvaluationGap[]
  tasks: Task[]
}

export type EvaluateResult = { kind: "evaluated"; evaluation: Evaluation } | { kind: "invalid"; reason: string } | { kind: "infrastructure"; reason: string }

export type EvolveOutcome = "completed" | "paused" | "failed" | "awaiting_approval"

export function parseEvaluation(text: string, cycle: number, existing: Task[]): Evaluation {
  const parsed = extractJsonObject(text) as any
  const errors: string[] = []
  const dimensions = {} as Evaluation["dimensions"]
  for (const dimension of evaluationDimensions) {
    const entry = parsed?.dimensions?.[dimension]
    const score = Number(entry?.score)
    if (!Number.isFinite(score) || score < 0 || score > 100) errors.push(`dimensions.${dimension}.score must be a number from 0 to 100`)
    dimensions[dimension] = { score: Math.round(score), notes: String(entry?.notes ?? "") }
  }
  if (!Array.isArray(parsed?.gaps)) errors.push("gaps must be an array")
  if (errors.length) throw new Error(`invalid evaluation:\n- ${errors.join("\n- ")}`)
  const gaps: EvaluationGap[] = parsed.gaps.map((gap: any) => ({
    title: String(gap?.title ?? ""),
    detail: String(gap?.detail ?? ""),
    severity: (findingSeverities as readonly string[]).includes(gap?.severity) ? gap.severity : "major",
  }))
  const score = Math.round(evaluationDimensions.reduce((sum, dimension) => sum + dimensions[dimension].score, 0) / evaluationDimensions.length)
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
  if (gaps.some((gap) => gap.severity !== "minor") && !rawTasks.length) throw new Error("blocker and major gaps need at least one task")
  const tasks = rawTasks.length ? validateFixTasks(rawTasks, cycle, existing, "E") : []
  return { cycle, score, dimensions, summary: String(parsed.summary ?? ""), gaps, tasks }
}

export interface EvolveSteps {
  // Reported agent cost of the project so far, and the run budget, for the per-cycle headroom check.
  spentUsd(): number
  runBudgetUsd(): number
  evaluate(cycle: number): Promise<EvaluateResult>
  // Distills lessons from the cycle; failures are logged and never stop the loop.
  learn(): Promise<void>
  addTasks(cycle: number, tasks: Task[]): Promise<void>
  // Builds the pending tasks, runs QA, and deploys again.
  ship(): Promise<EvolveOutcome>
  // kind "budget" lets the dashboard offer "Raise budget and resume".
  noteStop(reason: string, kind?: "budget"): void
}

export const evolveCycleKey = "evolve.cycle"
export const evolveScoreKey = "evolve.score"

export async function runEvolveLoop(store: Store, config: EvolveConfig, steps: EvolveSteps): Promise<EvolveOutcome> {
  for (;;) {
    const cycle = Number(store.meta(evolveCycleKey) ?? 0) + 1
    if (config.maxCycles && cycle > config.maxCycles) {
      store.log("evolve", `stopped after ${config.maxCycles} cycles (evolve.maxCycles); last score ${store.meta(evolveScoreKey) ?? "none"}`)
      return "completed"
    }
    const headroom = steps.runBudgetUsd() - steps.spentUsd()
    if (headroom < config.cycleBudgetUsd) {
      const reason = `evolve cycle ${cycle} needs $${config.cycleBudgetUsd.toFixed(2)} (evolve.cycleBudgetUsd) but only $${Math.max(headroom, 0).toFixed(2)} of budget.runUsd is left. Raise budget.runUsd, then resume`
      steps.noteStop(reason, "budget")
      store.log("evolve", reason)
      return "awaiting_approval"
    }
    store.log("evolve", `cycle ${cycle}: evaluating the live app against the brief`)
    const result = await steps.evaluate(cycle)
    if (result.kind === "infrastructure") {
      steps.noteStop(`evolve cycle ${cycle} paused: ${result.reason}`)
      store.log("evolve", `cycle ${cycle}: paused: ${result.reason.slice(0, 300)}`)
      return "paused"
    }
    if (result.kind === "invalid") {
      steps.noteStop(`evolve cycle ${cycle}: the evaluator gave no usable result: ${result.reason}`)
      store.log("evolve", `cycle ${cycle}: no usable evaluation: ${result.reason.slice(0, 500)}`)
      return "failed"
    }
    const { evaluation } = result
    store.setMeta(evolveScoreKey, String(evaluation.score))
    store.setMeta(evolveCycleKey, String(cycle))
    store.log("evolve", `cycle ${cycle}: score ${evaluation.score}/100 (target ${config.targetScore}), ${evaluation.gaps.length} gaps, ${evaluation.tasks.length} tasks. ${evaluation.summary.slice(0, 500)}`)
    await steps.learn()
    if (evaluation.score >= config.targetScore) {
      store.log("evolve", `cycle ${cycle}: target score reached`)
      return "completed"
    }
    if (!evaluation.tasks.length) {
      store.log("evolve", `cycle ${cycle}: under the target, but the evaluator found nothing to build`)
      return "completed"
    }
    try {
      await steps.addTasks(cycle, evaluation.tasks)
    } catch (error) {
      steps.noteStop(`evolve cycle ${cycle} could not add its tasks: ${(error as Error).message}`)
      store.log("evolve", `cycle ${cycle}: could not add the tasks: ${(error as Error).message.slice(0, 300)}`)
      return "paused"
    }
    const shipped = await steps.ship()
    if (shipped !== "completed") return shipped
  }
}
