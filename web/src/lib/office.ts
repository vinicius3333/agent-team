import type { PipelineStep, ProjectDetail, Task } from "@/api/types"
import { stepStates, type StepStatus } from "@/lib/pipeline"

export type DeskState = "idle" | "working" | "waiting" | "done" | "failed" | "skipped"

export type DeskRole = "pm" | "architect" | "illustrator" | "designer" | "planner" | "worker" | "reviewer" | "qa" | "deploy" | "doctor"

export interface Desk {
  role: DeskRole
  label: string
  step: PipelineStep | null
  state: DeskState
  bubble: string | null
  task: Task | null
}

const stepDeskStates: Record<StepStatus, DeskState> = {
  pending: "idle",
  running: "working",
  awaiting_approval: "waiting",
  approved: "done",
  done: "done",
  failed: "failed",
  skipped: "skipped",
}

const planningDesks: { role: DeskRole; label: string; step: PipelineStep }[] = [
  { role: "pm", label: "PM", step: "spec" },
  { role: "architect", label: "Architect", step: "architecture" },
  { role: "illustrator", label: "Illustrator", step: "branding" },
  { role: "designer", label: "Designer", step: "design" },
  { role: "planner", label: "Planner", step: "plan" },
]

function latestEvent(detail: ProjectDetail, type: string, mention?: string): string | null {
  const event = detail.events.findLast((entry) => entry.type === type && (!mention || entry.message.startsWith(mention)))
  return event?.message ?? null
}

function bubbleFor(state: DeskState, working: string | null): string | null {
  if (state === "working") return working
  if (state === "waiting") return "Waiting for your approval"
  if (state === "failed") return "Needs attention"
  return null
}

// A task runs the worker first, then the reviewer. Attempts are recorded only when a call ends,
// so a finished worker call for the current attempt means the reviewer (or verify) is now running.
function buildDesks(detail: ProjectDetail, buildStatus: StepStatus): Desk[] {
  const running = detail.active ? (detail.tasks.find((task) => task.status === "running") ?? null) : null
  const blocked = detail.tasks.find((task) => task.status === "blocked") ?? null
  let worker: DeskState = stepDeskStates[buildStatus]
  let reviewer: DeskState = worker === "failed" ? "idle" : worker
  if (running) {
    const workerFinished = detail.attempts.some((attempt) => attempt.subject === `${running.id}-worker-${running.attempts + 1}`)
    worker = workerFinished ? "idle" : "working"
    reviewer = workerFinished ? "working" : "idle"
  } else if (worker === "working") {
    worker = "idle"
    reviewer = "idle"
  }
  const task = running ?? blocked
  return [
    { role: "worker", label: "Worker", step: "build", state: worker, task, bubble: bubbleFor(worker, running && `${running.id}: ${running.title}`) },
    { role: "reviewer", label: "Reviewer", step: "build", state: reviewer, task, bubble: bubbleFor(reviewer, running && `Reviewing ${running.id}`) },
  ]
}

export function officeDesks(detail: ProjectDetail): Desk[] {
  const steps = new Map(stepStates(detail).map((entry) => [entry.step, entry]))
  const status = (step: PipelineStep) => steps.get(step)?.status ?? "pending"

  const planning = planningDesks.map((desk): Desk => {
    const state = stepDeskStates[status(desk.step)]
    return { ...desk, state, task: null, bubble: bubbleFor(state, latestEvent(detail, "phase", desk.step)) }
  })

  const qaState = stepDeskStates[status("qa")]
  const deployState = stepDeskStates[status("deploy")]
  const incident = detail.incident
  const doctorState: DeskState = !incident ? "idle" : incident.status === "gave_up" ? "failed" : incident.status === "fixed" ? "done" : "working"

  return [
    ...planning,
    ...buildDesks(detail, status("build")),
    { role: "qa", label: "QA", step: "qa", state: qaState, task: null, bubble: bubbleFor(qaState, latestEvent(detail, "qa")) },
    { role: "deploy", label: "Deploy", step: "deploy", state: deployState, task: null, bubble: bubbleFor(deployState, latestEvent(detail, "deploy")) ?? (detail.deploy?.status === "live" ? "Live" : null) },
    { role: "doctor", label: "Doctor", step: null, state: doctorState, task: null, bubble: bubbleFor(doctorState, incident ? `Diagnosing: ${incident.reason}` : null) },
  ]
}
