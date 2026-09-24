export const planningPhases = ["spec", "architecture", "branding", "design", "plan"] as const
export type PlanningPhase = (typeof planningPhases)[number]

export const pipelineSteps = [...planningPhases, "build", "qa", "deploy"] as const
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
  branding: { enabled?: boolean; count?: number } | null
  qa: { enabled: boolean; maxRounds: number }
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
  qa?: { round: number | null }
  feedback?: Partial<Record<string, string>>
}

export interface QaFinding {
  title: string
  detail: string
  screen: string
}

export interface QaRouteReport {
  route: string
  slug: string
  file: string | null
  status: number | null
  consoleErrors: string[]
  error: string | null
  branding: string | null
}

export interface QaRound {
  round: number
  tests: { install: string | null; command: string | null; passed: boolean; output: string } | null
  report: { baseUrl: string | null; viewport: { width: number; height: number }; startError: string | null; routes: QaRouteReport[] } | null
  verdict: { verdict: "pass" | "fail" | "invalid"; reason?: string | null; findings: QaFinding[]; tasks: { id: string; title: string }[] } | null
  images: string[]
}

export interface NewProjectRequest {
  name: string
  brief: string
  target: Target
  workerRunner: RunnerName
  gates: PlanningPhase[]
  github: boolean
  deploy: boolean
  branding: boolean
}
