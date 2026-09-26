import {
  Activity,
  Bot,
  Building,
  CalendarClock,
  ChartColumn,
  Cpu,
  FileText,
  GitPullRequest,
  House,
  KeyRound,
  ListChecks,
  ListTodo,
  MessagesSquare,
  Megaphone,
  Palette,
  Repeat,
  ShieldCheck,
  SlidersHorizontal,
  Swords,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import type { ProjectSummary } from "@/api/types"
import { projectStatus } from "@/lib/pipeline"

export const projectPhases = ["build", "launch", "operate", "system"] as const
export type ProjectPhase = (typeof projectPhases)[number]

export interface ViewDefinition {
  id: string
  label: string
  icon: LucideIcon
}

export const phaseLabels: Record<ProjectPhase, string> = {
  build: "Build",
  launch: "Launch",
  operate: "Operate",
  system: "System",
}

export const phaseViews: Record<ProjectPhase, ViewDefinition[]> = {
  build: [
    { id: "overview", label: "Overview", icon: House },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "office", label: "Office", icon: Building },
    { id: "docs", label: "Docs", icon: FileText },
    { id: "branding", label: "Branding", icon: Palette },
    { id: "tasks", label: "Tasks", icon: ListChecks },
    { id: "qa", label: "QA", icon: ShieldCheck },
  ],
  launch: [
    { id: "overview", label: "Overview", icon: House },
    { id: "marketing", label: "Marketing", icon: Megaphone },
    { id: "secrets", label: "Secrets", icon: KeyRound },
  ],
  operate: [
    { id: "overview", label: "Overview", icon: House },
    { id: "health", label: "Health", icon: Activity },
    { id: "analytics", label: "Analytics", icon: ChartColumn },
    { id: "competitors", label: "Competitors", icon: Swords },
    { id: "next-steps", label: "Backlog", icon: ListTodo },
    { id: "sprints", label: "Sprints", icon: CalendarClock },
    { id: "routines", label: "Routines", icon: Repeat },
    { id: "changes", label: "Changes", icon: GitPullRequest },
  ],
  system: [
    { id: "calls", label: "Agent calls", icon: Bot },
    { id: "runtime", label: "Runtime", icon: Cpu },
    { id: "budget", label: "Budget", icon: Wallet },
    { id: "config", label: "Config", icon: SlidersHorizontal },
  ],
}

export const legacyTabs: Record<string, [ProjectPhase, string]> = {
  overview: ["build", "overview"],
  lead: ["build", "chat"],
  chat: ["build", "chat"],
  office: ["build", "office"],
  docs: ["build", "docs"],
  branding: ["build", "branding"],
  qa: ["build", "qa"],
  marketing: ["launch", "marketing"],
  attempts: ["system", "calls"],
  system: ["system", "runtime"],
  config: ["system", "config"],
}

export function isPhase(value: string | undefined): value is ProjectPhase {
  return projectPhases.includes(value as ProjectPhase)
}

export function findView(phase: ProjectPhase, view: string | undefined): ViewDefinition | undefined {
  return phaseViews[phase].find((entry) => entry.id === view)
}

export function defaultView(phase: ProjectPhase): string {
  return phaseViews[phase][0].id
}

export function projectPath(name: string, phase?: ProjectPhase, view?: string): string {
  const base = `/projects/${encodeURIComponent(name)}`
  if (!phase) return base
  return `${base}/${phase}/${view ?? defaultView(phase)}`
}

type PhaseSource = Pick<ProjectSummary, "counts" | "phases" | "active" | "stop"> & { deployed: boolean }

const finished = (status: string | undefined) => status === "approved" || status === "skipped"

// The phase a person most likely wants to see; System is never current.
export function currentPhase(project: PhaseSource): ProjectPhase {
  const byName = new Map(project.phases.map((phase) => [phase.name, phase.status]))
  // An approved deploy counts even when the container is down, so a broken live app still opens on Operate.
  const deployed = project.deployed || byName.get("deploy") === "approved"
  if (projectStatus(project) === "done" && deployed) return "operate"
  const deployPending = !deployed && !finished(byName.get("deploy"))
  const marketingPending = byName.has("marketing") && !finished(byName.get("marketing"))
  if (finished(byName.get("qa")) && (deployPending || marketingPending)) return "launch"
  return "build"
}

export type PhaseProgress = "done" | "current" | "future"

export function phaseProgress(phase: ProjectPhase, current: ProjectPhase): PhaseProgress {
  if (phase === "system") return "future"
  const order = projectPhases.indexOf(phase) - projectPhases.indexOf(current)
  return order < 0 ? "done" : order === 0 ? "current" : "future"
}
