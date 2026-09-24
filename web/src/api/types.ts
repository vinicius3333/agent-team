export const planningPhases = ["spec", "architecture", "branding", "design", "marketing", "plan"] as const
export type PlanningPhase = (typeof planningPhases)[number]

export const pipelineSteps = [...planningPhases, "build", "qa", "deploy"] as const
export type PipelineStep = (typeof pipelineSteps)[number]

export type MarketingFormat = "og" | "square" | "story" | "x"

export interface MarketingPiece {
  id: string
  problem: string
  headline: string
  subtitle: string
  cta: string
  layout: "overlay" | "split"
  image: { file: string; source: "stock" | "generated"; reason: string; url?: string; credit?: string; license?: string }
  files: { format: MarketingFormat; file: string; width: number; height: number }[]
}

export interface MarketingManifest {
  language: string
  pieces: MarketingPiece[]
}

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
  tokens?: number
  live: boolean
  liveUrl: string | null
  stop?: RunStop | null
  // An incident the doctor is working on, shown as a banner.
  incident?: IncidentBanner | null
  // Absent on servers from before the Operate phase.
  openFindings?: number
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  attempts: number
  lastFailure: string | null
  // Why the orchestrator stopped and wants a person to decide (for example a replan that touches shared files).
  needsHuman: string | null
  issueNumber: number | null
  phase: string | null
  story: string | null
  dependsOn: string[]
  allowedPaths: string[]
  readPaths: string[]
  acceptance: string[]
  verify: string | null
  // The change request that added the task; null for the first build.
  change?: string | null
}

export type ChangeStatus = "open" | "merged" | "failed" | "abandoned"

export interface ChangeSummary {
  id: string
  title: string
  request: string
  status: ChangeStatus
  branch: string
  prUrl: string | null
  createdAt: string
  finishedAt: string | null
  costUsd: number
}

export interface OpenChange {
  id: string
  branch: string
  specDelta: string | null
  architectureDelta: string | null
  // autonomy.changeMerge is manual and QA passed: the change waits for Approve before it merges into main.
  mergeWaiting: boolean
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
  tokens?: number | null
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
  budget?: { perTaskUsd: number; runUsd: number }
  // null is the custom stack. latest is null when this server no longer has the template.
  template?: { name: string; version: number; latest: number | null } | null
}

export interface StackTemplate {
  name: string
  version: number
  title: string
  description: string
  targets: Target[]
}

// Why the last run stopped. kind "budget" means the run budget was reached.
export interface RunStop {
  outcome: "awaiting_approval" | "paused" | "failed"
  kind: "budget" | "other"
  reason: string
  at: string
}

export interface RunBudget {
  runUsd: number
  spentUsd: number
  spentTokens?: number
  // Codex calls report no cost, so they are not in spentUsd.
  unreportedCalls: number
}

export interface ReviewerMetrics {
  reviews: number
  fails: number
  followedFails: number
  confirmedFails: number
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

export type LeadActionState = "proposed" | "applied" | "dismissed"

export type LeadAction = { state: LeadActionState; reason: string } & (
  | { kind: "retry"; taskId: string }
  | { kind: "resume" }
  | { kind: "approve"; phase: string }
  | { kind: "request_changes"; phase: string; message: string }
  | { kind: "raise_budget" }
)

export interface ChatMessage {
  id: number
  at: string
  author: "human" | "lead"
  body: string
  actions: LeadAction[]
}

export interface LiveActivity {
  kind: "command" | "edit" | "read" | "message" | "reasoning" | "tool"
  text: string
}

export interface LiveAgent {
  subject: string
  role: string
  runner: string
  model: string
  startedAt: string
  // When the transcript last grew; a long gap means the agent is thinking or stuck.
  updatedAt: string | null
  transcript: string
  activity: LiveActivity[]
  changedFiles: { status: string; path: string }[]
}

export interface ProjectDetail extends Omit<ProjectSummary, "live" | "liveUrl"> {
  tasks: Task[]
  attempts: Attempt[]
  events: ProjectEvent[]
  activeTime: { ms: number; openSince: string | null }
  cooldowns: Cooldown[]
  config: ProjectConfig | null
  github: GithubInfo | null
  gitLog: string[]
  worktrees: string[]
  containers: Container[]
  // Absent on servers from before live agent tracking.
  liveAgents?: LiveAgent[]
  deploy: DeployInfo | null
  // The demo account the app seeds from DEMO_EMAIL and DEMO_PASSWORD.
  access?: { email: string; password: string } | null
  qa?: { round: number | null }
  feedback?: Partial<Record<string, string>>
  budget?: RunBudget
  reviewer?: ReviewerMetrics
  chat?: { messages: ChatMessage[]; thinking: boolean }
  // Absent on servers from before change requests. Newest first.
  changes?: ChangeSummary[]
  change?: OpenChange | null
  canRequestChange?: boolean
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
  roles: Record<string, RoleCandidate>
  gates: PlanningPhase[]
  github: boolean
  deploy: boolean
  branding: boolean
  // Left out for the custom stack.
  template?: string
}

export type IncidentStatus = "open" | "diagnosing" | "fixed" | "gave_up"

export interface IncidentBanner {
  id: string
  status: IncidentStatus
  reason: string
  attempts: number
  issueUrl: string | null
  createdAt: string
}

export interface IncidentAction {
  at: string
  action: string
  detail: string
}

export interface Incident {
  id: string
  project: string
  fingerprint: string
  kind: "failed" | "paused" | "stalled" | "crashed"
  reason: string
  subject: string | null
  status: IncidentStatus
  attempts: number
  costUsd: number
  tokens?: number
  diagnosis: string | null
  cause: "agent_team_bug" | "project_state" | "external" | "unknown" | null
  actions: IncidentAction[]
  branch: string | null
  prUrl: string | null
  issueUrl: string | null
  createdAt: string
  updatedAt: string
  resumedAt: string | null
  succeededAt: string | null
  closedAt: string | null
}

export interface IncidentCall {
  subject: string
  role: string
  runner: string
  model: string
  status: string
  failureClass: string | null
  costUsd: number | null
  tokens?: number | null
  durationMs: number | null
  createdAt: string
  transcript: string
}

export interface IncidentDetail extends Incident {
  calls: IncidentCall[]
}

export interface NotificationChannel {
  name: string
  type: "webhook" | "slack" | "ntfy" | "email"
  target: string | null
  events: string[]
  projects: string[] | null
  enabled: boolean
  offReason: string | null
  lastSuccessAt: string | null
  lastError: { at: string; status: number | null; message: string } | null
}

export interface NotificationStatus {
  configured: boolean
  error: string | null
  channels: NotificationChannel[]
}

export interface NotificationTestResult {
  channel: string
  ok: boolean
  error: string | null
}

export const insightAgents = ["monitoring", "analytics", "research"] as const
export type InsightAgent = (typeof insightAgents)[number]
export type FindingSeverity = "high" | "medium" | "low"
export type FindingStatus = "open" | "approved" | "dismissed"

export interface Finding {
  id: number
  source: InsightAgent
  severity: FindingSeverity
  title: string
  evidence: string
  proposal: string
  status: FindingStatus
  changeId: string | null
  createdAt: string
  updatedAt: string
}

export interface InsightRun {
  id: number
  agent: InsightAgent
  startedAt: string
  finishedAt: string | null
  status: "running" | "done" | "failed"
  summary: string
  findings: number
}

export type HealthState = "up" | "down" | "unknown"

export interface HealthCheckPoint {
  at: string
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
}

export interface MetricPoint {
  at: string
  value: number
}

export interface OperateSnapshot {
  enabled: boolean
  live: boolean
  health: { uptime7d: number | null; p95LatencyMs24h: number | null; lastCheckAt: string | null; state: HealthState }
  checks: HealthCheckPoint[]
  // Headline keys: wau, signups, signup_conversion (a percent), pageviews.
  metrics: Record<string, { value: number; previous: number | null; at: string }>
  series: { wau: MetricPoint[]; pageviews: MetricPoint[] }
  funnel: { step: string; count: number }[]
  topEvents: { event: string; count: number }[]
  runs: Record<InsightAgent, InsightRun | null>
  config: { posthog: boolean; competitors: string[]; schedule: Record<InsightAgent, number> }
}
