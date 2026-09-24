export const planningPhases = ["spec", "architecture", "mockups", "design", "plan"] as const
export type PlanningPhase = (typeof planningPhases)[number]

export const pipelineSteps = [...planningPhases, "build", "deploy"] as const
export type PipelineStep = (typeof pipelineSteps)[number]

export type PhaseStatus = "pending" | "running" | "awaiting_approval" | "approved" | "failed" | "skipped"
export type TaskStatus = "pending" | "running" | "merged" | "blocked"
export type RunnerName = "claude" | "codex"
export type Target = "web" | "api" | "web+api"

export interface Phase {
  name: string
  status: PhaseStatus
  updatedAt?: string
}

export interface ProjectEvent {
  id: number
  at: string
  type: string
  message: string
}

export interface ProjectSummary {
  name: string
  phases: Phase[]
  counts: Partial<Record<TaskStatus, number>>
  lastEvent: Omit<ProjectEvent, "id"> | null
  current: string | null
  active: boolean
  costUsd: number
  costUnreported: boolean
  live: boolean
  liveUrl: string | null
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  attempts: number
  lastFailure: string | null
  issueNumber: number | null
  phase: string | null
  story: string | null
  dependsOn: string[]
  allowedPaths: string[]
  readPaths: string[]
  acceptance: string[]
  verify: string | null
}

export interface Attempt {
  id: number
  subject: string
  role: string
  runner: string
  model: string
  status: string
  failureClass: string | null
  durationMs: number | null
  costUsd: number | null
  createdAt: string
  transcript: string
}

export interface Cooldown {
  runner: string
  until: number
  reason: string
}

export interface RoleCandidate {
  runner: string
  model: string
}

export interface DefaultRole extends RoleCandidate {
  fallbacks: RoleCandidate[]
}

export interface Defaults {
  roles: Record<string, DefaultRole>
}

export interface RoleConfig extends RoleCandidate {
  fallbacks: RoleCandidate[]
  maxRetries: number | null
}

export interface ProjectConfig {
  target: Target
  gates: PlanningPhase[]
  roles: Record<string, RoleConfig>
  mockups: { enabled?: boolean; count?: number } | null
  publish: { github: { enabled: boolean } }
}

export interface PullRequest {
  number: number
  title: string
  url: string
  branch: string
  state: string
}

export interface GithubInfo {
  repoUrl: string | null
  owner: string | null
  epic: number | null
  projectUrl: string | null
  pullRequests: PullRequest[]
}

export interface Container {
  name: string
  status: string
  runningFor: string
}

export interface DeployInfo {
  url: string | null
  status: "live" | "starting" | "stopped" | "missing"
  appContainer: string
  tunnelContainer: string
  app: string
  tunnel: string
}

export interface ProjectDetail extends Omit<ProjectSummary, "live" | "liveUrl"> {
  tasks: Task[]
  attempts: Attempt[]
  events: ProjectEvent[]
  cooldowns: Cooldown[]
  config: ProjectConfig | null
  github: GithubInfo | null
  gitLog: string[]
  worktrees: string[]
  containers: Container[]
  deploy: DeployInfo | null
  feedback?: Partial<Record<string, string>>
}

export interface NewProjectRequest {
  name: string
  brief: string
  target: Target
  workerRunner: RunnerName
  gates: PlanningPhase[]
  github: boolean
  deploy: boolean
  mockups: boolean
}
