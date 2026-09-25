import { join } from "node:path"
import { loadConfig, type PipelineConfig, type SprintConfig } from "./config.ts"
import { extractJsonObject } from "./json.ts"
import { buildComplete, changeRequestMaxLength, listProjects, ProjectError, processAlive, runLogPath, startRun, withProjectStore, type RunCommand } from "./project.ts"
import { findingSeverities, type Finding, type FindingSeverity, type NewFinding, type Sprint, type Store } from "./store.ts"

// A sprint keeps a live project improving without a person: the evaluator scores the app and turns its gaps into
// backlog items, the PM picks the items worth building next (and may propose new features), and the picked items
// ship as one change request, with QA and a redeploy. The doctor starts one every sprints.everyDays.

export const evaluationDimensions = ["brief_coverage", "functionality", "monetization", "ux_and_branding", "quality_and_reliability"] as const
export type EvaluationDimension = (typeof evaluationDimensions)[number]

export interface EvaluationGap {
  title: string
  detail: string
  severity: FindingSeverity
}

export interface Evaluation {
  sprint: number
  // 0 to 100: the mean of the dimension scores, computed by the orchestrator so the agent cannot round it up.
  score: number
  dimensions: Record<EvaluationDimension, { score: number; notes: string }>
  summary: string
  gaps: EvaluationGap[]
}

// The evaluator shares its words with QA (blocker, major, minor); the backlog uses high, medium, low.
const gapSeverities: Record<string, FindingSeverity> = { blocker: "high", major: "medium", minor: "low", high: "high", medium: "medium", low: "low" }

export function parseEvaluation(text: string, sprint: number): Evaluation {
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
  const gaps: EvaluationGap[] = parsed.gaps
    .map((gap: any) => ({ title: String(gap?.title ?? "").trim().slice(0, 200), detail: String(gap?.detail ?? "").trim(), severity: gapSeverities[gap?.severity] ?? "medium" }))
    .filter((gap: EvaluationGap) => gap.title)
  const score = Math.round(evaluationDimensions.reduce((sum, dimension) => sum + dimensions[dimension].score, 0) / evaluationDimensions.length)
  return { sprint, score, dimensions, summary: String(parsed.summary ?? ""), gaps }
}

export function gapFinding(gap: EvaluationGap, evaluation: Evaluation): NewFinding {
  return {
    source: "evaluator",
    severity: gap.severity,
    title: gap.title,
    evidence: `${gap.detail || "No detail."} (evaluation of sprint ${evaluation.sprint}, score ${evaluation.score}/100)`.slice(0, 2000),
    proposal: gap.detail || gap.title,
  }
}

export interface SprintPlan {
  goal: string
  // Open backlog item ids the sprint builds.
  items: number[]
  // New features the PM proposes; each becomes a backlog item of source "product" and joins the sprint.
  proposals: Omit<NewFinding, "source">[]
  // Stale or duplicate items the PM closes, with the reason.
  dismiss: { id: number; reason: string }[]
  // The change request the PM wrote from the picked items.
  request: string
}

export function parseSprintPlan(text: string, backlog: Finding[], config: SprintConfig): SprintPlan {
  const parsed = extractJsonObject(text) as any
  const errors: string[] = []
  const open = new Set(backlog.filter((item) => item.status === "open").map((item) => item.id))
  const items: number[] = Array.isArray(parsed?.items) ? [...new Set<number>(parsed.items.map(Number))] : []
  const unknown = items.filter((id) => !open.has(id))
  if (unknown.length) errors.push(`items lists ids that are not open backlog items: ${unknown.join(", ")}`)
  const rawProposals: any[] = Array.isArray(parsed?.proposals) ? parsed.proposals : []
  if (rawProposals.length && !config.newFeatures) errors.push("proposals must be empty: sprints.newFeatures is off")
  const proposals: SprintPlan["proposals"] = []
  for (const [index, raw] of rawProposals.entries()) {
    const missing = ["title", "evidence", "proposal"].filter((field) => typeof raw?.[field] !== "string" || !raw[field].trim())
    if (!(findingSeverities as readonly string[]).includes(raw?.severity)) missing.unshift("severity")
    if (missing.length) {
      errors.push(`proposals[${index}] has no valid ${missing.join(", ")}`)
      continue
    }
    proposals.push({ severity: raw.severity, title: raw.title.trim().slice(0, 200), evidence: raw.evidence.trim().slice(0, 2000), proposal: raw.proposal.trim().slice(0, 2000) })
  }
  if (items.length + proposals.length > config.maxItems) errors.push(`pick at most ${config.maxItems} items and proposals together (sprints.maxItems); you picked ${items.length + proposals.length}`)
  const dismiss: SprintPlan["dismiss"] = (Array.isArray(parsed?.dismiss) ? parsed.dismiss : [])
    .map((entry: any) => ({ id: Number(entry?.id), reason: String(entry?.reason ?? "").trim() }))
    .filter((entry: { id: number }) => open.has(entry.id) && !items.includes(entry.id))
  const goal = typeof parsed?.goal === "string" ? parsed.goal.trim().slice(0, 300) : ""
  const request = typeof parsed?.request === "string" ? parsed.request.trim() : ""
  const building = items.length + proposals.length > 0
  if (building && !goal) errors.push("goal is missing")
  if (building && !request) errors.push("request is missing")
  if (errors.length) throw new Error(`invalid sprint plan:\n- ${errors.join("\n- ")}`)
  return { goal, items, proposals, dismiss, request }
}

// The PM's request, followed by the list of backlog items it covers, so the change keeps its trail back to the backlog.
export function sprintRequest(sprint: number, plan: SprintPlan, picked: Finding[]): string {
  const header = `Sprint ${sprint}: ${plan.goal}`
  const trail = ["", "Backlog items:", ...picked.map((item) => `- #${item.id} [${item.source}, ${item.severity}] ${item.title}`)].join("\n")
  const room = changeRequestMaxLength - header.length - trail.length - 4
  const body = plan.request.length > room ? `${plan.request.slice(0, Math.max(room - 1, 0))}…` : plan.request
  return `${header}\n\n${body}\n${trail}`
}

const dayMs = 24 * 60 * 60_000
const monthMs = 30 * dayMs

// What the sprints that started in the last 30 days cost; a sprint still going counts what it spent so far.
export function sprintSpend(store: Store, now = Date.now()): number {
  const projectCost = store.projectCost().usd
  return store
    .sprints()
    .filter((sprint) => now - Date.parse(sprint.startedAt) < monthMs)
    .reduce((sum, sprint) => sum + (sprint.costUsd ?? Math.max(0, projectCost - sprint.costAtStart)), 0)
}

export function activeSprint(store: Store): Sprint | null {
  const last = store.sprints(1)[0]
  return last && (last.status === "planning" || last.status === "building") ? last : null
}

// Closes the active sprint once its change is merged or abandoned, or once its planning run died before a change opened.
export function syncSprint(store: Store): void {
  const sprint = activeSprint(store)
  if (!sprint) return
  if (sprint.status === "planning") {
    if (!processAlive(Number(store.meta("run.pid")))) store.finishSprint(sprint.number, "failed", sprint.note || "the run stopped before the sprint opened its change")
    return
  }
  const change = sprint.changeId ? store.change(sprint.changeId) : null
  if (change?.status === "merged") {
    store.finishSprint(sprint.number, "done")
    store.log("sprint", `sprint ${sprint.number} done: change ${change.id} is merged`)
  } else if (change?.status === "abandoned" || change?.status === "failed") {
    store.finishSprint(sprint.number, "abandoned", `change ${change.id} was ${change.status}`)
    store.log("sprint", `sprint ${sprint.number} closed: change ${change.id} was ${change.status}`)
  }
}

// A failed sprint (a planning error, a runner outage) is tried again sooner than the regular cadence.
const failedRetryMs = 6 * 60 * 60_000

// Why a sprint may not start now, or null when it may. early skips the wait for the next due time, for "Start sprint now".
// insideRun: the caller is the sprint run itself, so its own run.pid does not block.
export function sprintBlocker(store: Store, config: PipelineConfig, options: { now?: number; early?: boolean; insideRun?: boolean } = {}): string | null {
  const { sprints } = config
  const now = options.now ?? Date.now()
  if (!sprints.enabled) return "sprints are off (sprints.enabled)"
  if (!config.deploy.enabled) return "sprints judge the live app, so they need deploy.enabled"
  if (!options.insideRun && processAlive(Number(store.meta("run.pid")))) return "a run is in progress"
  const open = store.currentChange()
  if (open) return `change ${open.id} is still open`
  if (!buildComplete(store)) return "the build is not finished"
  const active = activeSprint(store)
  if (active) return `sprint ${active.number} is still ${active.status}`
  const last = store.sprints(1)[0]
  if (last?.finishedAt && !options.early) {
    const next = Date.parse(last.finishedAt) + Math.min(sprints.everyDays * dayMs, last.status === "failed" ? failedRetryMs : Infinity)
    if (now < next) return `the next sprint is due at ${new Date(next).toISOString()}`
  }
  const spent = sprintSpend(store, now)
  if (spent + sprints.budgetUsd > sprints.monthlyUsd) return `sprints spent $${spent.toFixed(2)} in the last 30 days; another one could pass sprints.monthlyUsd ($${sprints.monthlyUsd.toFixed(2)})`
  return null
}

export interface SprintTickOptions {
  runsDir: string
  now?: number
  startRun?: (projectDir: string, logPath: string, command: RunCommand) => number
}

// Closes finished sprints and starts the ones that are due, as a detached `agent-team sprint` run per project.
export function sprintTick(options: SprintTickOptions): void {
  const launch = options.startRun ?? startRun
  for (const name of listProjects(options.runsDir)) {
    const projectDir = join(options.runsDir, name)
    try {
      const config = loadConfig(join(projectDir, "pipeline.yaml"))
      if (!config.sprints.enabled) continue
      const due = withProjectStore(projectDir, (store) => {
        syncSprint(store)
        return sprintBlocker(store, config, { now: options.now }) === null
      })
      if (due) launch(projectDir, runLogPath(options.runsDir, name), ["sprint"])
    } catch (error) {
      console.error(`[sprint] ${name}: ${(error as Error).message}`)
    }
  }
}

export const backlogTitleMaxLength = 200
export const backlogDetailMaxLength = 2000

// An item a person adds by hand; the next sprint's PM weighs it with the rest of the backlog.
export function addBacklogItem(store: Store, input: { title: unknown; detail?: unknown; severity?: unknown }, author: string): Finding {
  const title = typeof input.title === "string" ? input.title.trim() : ""
  const detail = typeof input.detail === "string" ? input.detail.trim() : ""
  const severity = input.severity ?? "medium"
  if (!title) throw new ProjectError(400, "Give the backlog item a title.")
  if (title.length > backlogTitleMaxLength) throw new ProjectError(400, `Keep the title under ${backlogTitleMaxLength} characters.`)
  if (detail.length > backlogDetailMaxLength) throw new ProjectError(400, `Keep the detail under ${backlogDetailMaxLength} characters.`)
  if (!(findingSeverities as readonly unknown[]).includes(severity)) throw new ProjectError(400, `Severity must be ${findingSeverities.join(", ")}.`)
  const { id } = store.addFinding({ source: "manual", severity: severity as FindingSeverity, title, evidence: `Added by ${author}.`, proposal: detail || title })
  store.log("sprint", `${author} added backlog item ${id}: ${title}`)
  return store.finding(id)!
}
