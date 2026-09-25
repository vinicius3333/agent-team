import type { Attempt, PhaseStatus, PipelineStep, ProjectDetail, ProjectSummary, RoleConfig, Task, TaskStatus } from "@/api/types"
import { pipelineSteps } from "@/api/types"

export const stepLabels: Record<PipelineStep, string> = {
  research: "Research",
  spec: "Spec",
  architecture: "Architecture",
  branding: "Branding",
  design: "Design",
  marketing: "Marketing",
  plan: "Plan",
  baseline: "Baseline",
  build: "Build",
  qa: "QA",
  deploy: "Deploy",
}

export const phaseRoles: Record<string, string> = {
  research: "importer",
  spec: "pm",
  architecture: "architect",
  branding: "illustrator",
  design: "designer",
  marketing: "marketer",
  plan: "planner",
  qa: "qa",
}

export const phaseOutputs: Record<string, string[]> = {
  research: ["docs/import/research.md"],
  spec: ["docs/spec.md"],
  architecture: ["docs/architecture.md", "docs/adr/", "contracts/openapi.yaml"],
  branding: ["design/branding/01-logo.png", "design/branding/*.png", "design/branding/README.md"],
  design: ["design/tokens.css", "design/logo.svg", "design/logo-mark.svg", "docs/design-system.md", "docs/design.md"],
  marketing: ["marketing/copy.json", "marketing/art/*", "marketing/<piece>-<format>.png", "marketing/manifest.json"],
  plan: ["tasks.json"],
  baseline: [".agent-team/import/baseline.json", "design/branding/<route>.png"],
  build: ["code and tests, one merge per task"],
  qa: [".agent-team/qa/round-<n>/: tests.json, report.json, <route>.png, verdict.json"],
}

export const phaseDocuments: Record<string, string[]> = {
  research: ["docs/import/research.md"],
  spec: ["docs/spec.md"],
  architecture: ["docs/architecture.md"],
  branding: ["design/branding/README.md"],
  design: ["docs/design-system.md", "docs/design.md"],
  plan: ["tasks.json"],
}

export const pinnedDocuments = ["input.md", "docs/spec.md", "docs/architecture.md", "docs/design.md", "tasks.json"]

export type ProjectStatus = "blocked" | "awaiting_approval" | "running" | "done" | "failed" | "idle"

export function projectStatus(project: Pick<ProjectSummary, "counts" | "phases" | "active" | "stop">): ProjectStatus {
  if (project.counts.blocked) return "blocked"
  if (project.phases.some((phase) => phase.status === "awaiting_approval")) return "awaiting_approval"
  if (!project.active && project.stop?.outcome === "awaiting_approval") return "awaiting_approval"
  if (project.active) return "running"
  const phasesDone = project.phases.length > 0 && project.phases.every((phase) => phase.status === "approved" || phase.status === "skipped")
  const total = Object.values(project.counts).reduce((sum, count) => sum + (count ?? 0), 0)
  // An imported project is done with no tasks once its baseline ran.
  const imported = project.phases.some((phase) => phase.name === "baseline")
  if (phasesDone && (total ? project.counts.merged === total : imported)) return "done"
  if (project.phases.some((phase) => phase.status === "failed")) return "failed"
  return "idle"
}

export const projectStatusLabels: Record<ProjectStatus, string> = {
  blocked: "Blocked",
  awaiting_approval: "Needs approval",
  running: "Running",
  done: "Done",
  failed: "Failed",
  idle: "Stopped",
}

export function taskCounts(tasks: Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { pending: 0, running: 0, merged: 0, blocked: 0 }
  for (const task of tasks) counts[task.status in counts ? task.status : "pending"]++
  return counts
}

export function skippedPhases(detail: ProjectDetail): Set<string> {
  const skipped = new Set<string>()
  for (const event of detail.events) {
    const match = /^(\w+) skipped/.exec(event.message)
    if (event.type === "phase" && match) skipped.add(match[1])
  }
  return skipped
}

export type StepStatus = PhaseStatus | "done"

export interface StepState {
  step: PipelineStep
  status: StepStatus
  note: string
}

// The deploy phase row wins when the orchestrator writes one; otherwise it is derived from the containers and deploy events.
export function deployState(detail: ProjectDetail): { status: StepStatus; note: string } {
  const row = detail.phases.find((phase) => phase.name === "deploy")?.status
  const deploy = detail.deploy
  const lastEvent = detail.events.filter((event) => event.type === "deploy").at(-1)
  if (row) {
    const notes: Partial<Record<PhaseStatus, string>> = {
      approved: deploy?.status === "live" ? "live" : "deployed",
      running: "starting",
      skipped: "skipped",
      failed: "failed",
    }
    return { status: row, note: notes[row] ?? "" }
  }
  if (deploy?.status === "live") return { status: "approved", note: "live" }
  if (lastEvent && /^failed/.test(lastEvent.message)) return { status: "failed", note: "failed" }
  if (lastEvent && /^skipped/.test(lastEvent.message)) return { status: "skipped", note: "skipped" }
  if (deploy?.status === "starting" || (lastEvent && /^starting/.test(lastEvent.message))) return { status: "running", note: "starting" }
  if (deploy?.status === "stopped") return { status: "pending", note: "stopped" }
  return { status: "pending", note: "" }
}

export function qaState(detail: ProjectDetail): { status: StepStatus; note: string } {
  if (skippedPhases(detail).has("qa") || detail.config?.qa.enabled === false) return { status: "skipped", note: "skipped" }
  const status = detail.phases.find((phase) => phase.name === "qa")?.status ?? "pending"
  const round = detail.qa?.round
  const notes: Partial<Record<PhaseStatus, string>> = { running: round ? `round ${round}` : "working", approved: "passed", failed: "failed", pending: round ? `round ${round}` : "" }
  return { status, note: notes[status] ?? "" }
}

const importedSteps: PipelineStep[] = ["research", "spec", "architecture", "design", "baseline", "build", "qa", "deploy"]

// An imported project documents the app and takes a baseline instead of branding, marketing, and a plan.
export function projectSteps(detail: Pick<ProjectDetail, "import">): PipelineStep[] {
  return detail.import ? importedSteps : pipelineSteps.filter((step) => step !== "research" && step !== "baseline")
}

export function stepStates(detail: ProjectDetail): StepState[] {
  const byName = new Map(detail.phases.map((phase) => [phase.name, phase.status]))
  const skipped = skippedPhases(detail)
  const counts = taskCounts(detail.tasks)
  const total = detail.tasks.length
  return projectSteps(detail).map((step) => {
    // Right after an import nothing was built, tested, or deployed yet; the first change does that.
    if (detail.import?.done && !total && (step === "build" || step === "qa" || step === "deploy")) return { step, status: "skipped", note: "first change" }
    if (step === "build") {
      const planningDone = detail.phases.filter((phase) => phase.name !== "deploy" && phase.name !== "qa").every((phase) => phase.status === "approved" || phase.status === "skipped")
      const status: StepStatus = !total
        ? "pending"
        : counts.merged === total
          ? "done"
          : counts.blocked
            ? "failed"
            : counts.running || planningDone
              ? "running"
              : "pending"
      return { step, status, note: total ? `${counts.merged}/${total} tasks` : "" }
    }
    if (step === "deploy") return { step, ...deployState(detail) }
    if (step === "qa") return { step, ...qaState(detail) }
    if (skipped.has(step)) return { step, status: "skipped", note: "skipped" }
    const status = byName.get(step) ?? "pending"
    const notes: Partial<Record<PhaseStatus, string>> = { awaiting_approval: "needs approval", running: "working", approved: "done", failed: "failed" }
    return { step, status, note: notes[status] ?? "" }
  })
}

export function maxRetries(detail: ProjectDetail): number {
  return detail.config?.roles.worker?.maxRetries ?? 3
}

export function totalCost(attempts: Attempt[]): number {
  return attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0)
}

export function totalTokens(attempts: Attempt[]): number {
  return attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0)
}

export interface CostByRole {
  role: string
  cost: number
  tokens: number
  // Calls saved before token tracking.
  untracked: number
  calls: number
  unreported: number
  runners: string[]
}

export function costByRole(attempts: Attempt[]): CostByRole[] {
  const byRole = new Map<string, CostByRole>()
  for (const attempt of attempts) {
    const entry = byRole.get(attempt.role) ?? { role: attempt.role, cost: 0, tokens: 0, untracked: 0, calls: 0, unreported: 0, runners: [] }
    entry.calls++
    entry.tokens += attempt.tokens ?? 0
    if (attempt.tokens == null) entry.untracked++
    if (attempt.costUsd == null) entry.unreported++
    else entry.cost += attempt.costUsd
    if (!entry.runners.includes(attempt.runner)) entry.runners.push(attempt.runner)
    byRole.set(attempt.role, entry)
  }
  return [...byRole.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost)
}

export function elapsedMs(detail: ProjectDetail): number | null {
  const { ms, openSince } = detail.activeTime
  const lastEvent = detail.events.at(-1)?.at
  if (!openSince) return ms || null
  const end = detail.active ? Date.now() : Date.parse(lastEvent ?? openSince)
  return ms + end - Date.parse(openSince)
}

export function describeCandidate(role: RoleConfig | undefined): string {
  if (!role) return "not configured"
  const main = `${role.runner} ${role.model}`
  return role.fallbacks.length ? `${main} → ${role.fallbacks.map((fallback) => `${fallback.runner} ${fallback.model}`).join(" → ")}` : main
}

export function awaitingPhase(detail: ProjectDetail): string | null {
  return detail.phases.find((phase) => phase.status === "awaiting_approval")?.name ?? null
}

export function attemptNumber(subject: string): number {
  return Number(/-(\d+)$/.exec(subject)?.[1] ?? 0)
}
