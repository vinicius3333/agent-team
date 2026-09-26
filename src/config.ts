import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { parse } from "yaml"
import { autoStyle, designStyleIds } from "./design-styles.ts"
import { insightAgents, type InsightAgent } from "./store.ts"
import { customTemplate, findTemplate, readStack, type StackManifest } from "./templates.ts"

export const planningPhases = ["spec", "architecture", "concepts", "branding", "design", "marketing", "plan"] as const
export type PlanningPhase = (typeof planningPhases)[number]

// Phase names used by older projects, mapped to their current name.
const legacyPhaseNames: Record<string, PlanningPhase> = { mockups: "branding" }

export function normalizePhaseName(name: string): string {
  return legacyPhaseNames[name] ?? name
}

export const roles = ["importer", "pm", "architect", "illustrator", "designer", "marketer", "planner", "worker", "reviewer", "qa", "doctor", "lead", "design-reviewer", "monitor", "analyst", "researcher", "evaluator", "curator"] as const
export type Role = (typeof roles)[number]

export const runnerNames = ["claude", "codex"] as const
export type RunnerName = (typeof runnerNames)[number]

export interface Candidate {
  runner: RunnerName
  model: string
}

export interface RoleConfig extends Candidate {
  maxRetries?: number
  fallbacks: Candidate[]
}

export interface HarnessConfig {
  isolation: "none" | "docker"
  docker: { cpus: number; memory: string; pidsLimit: number }
  network: { allowlist: boolean; extraDomains: string[] }
  transientRetries: number
  backoffMs: number
  cooldownMs: number
  agentTimeoutMs: number
}

export interface PublishConfig {
  // board false skips the project board and the build epic, for a repository agent-team does not own.
  // issues: poll open issues labeled agent-team into the backlog every everyMinutes (1 to 1440).
  github: { enabled: boolean; owner: string | null; visibility: "private" | "public"; name: string | null; board: boolean; issues: { enabled: boolean; everyMinutes: number } }
}

// An OpenAI-compatible endpoint for the codex runner. apiKeyEnv is the name of the env var that holds the key.
export interface CodexRunnerConfig {
  baseUrl: string
  apiKeyEnv: string | null
}

export interface RunnersConfig {
  codex: CodexRunnerConfig | null
}

export const importGitHubModes = ["source", "new", "none"] as const
export type ImportGitHubMode = (typeof importGitHubModes)[number]

// Set for a project imported from an existing repository instead of built from a brief.
export interface ImportConfig {
  source: string
  urls: string[]
  github: ImportGitHubMode
}

export { insightAgents, type InsightAgent }
export const insightAgentRoles: Record<InsightAgent, Role> = { monitoring: "monitor", analytics: "analyst", research: "researcher" }

export interface PosthogConfig {
  host: string
  projectId: string
  publicKey: string | null
  // The name of the env var that holds the personal API key; the key itself never goes in pipeline.yaml.
  apiKeyEnv: string
}

export interface OperateConfig {
  enabled: boolean
  healthPath: string
  // Hours between runs; 0 turns the agent off.
  schedule: Record<InsightAgent, number>
  posthog: PosthogConfig | null
  competitors: string[]
}

export interface PipelineConfig {
  target: "web" | "api" | "web+api"
  // changeMerge "manual" stops a change before its final merge into main until a person approves it.
  // autoApproveScope: a task blocked on files outside its scope gets them without stopping for a person (at most
  // twice per task); the same change the dashboard's Approve button makes.
  // decide "auto": every stop that would wait for a person decides by itself and logs why (see docs/architecture.md).
  autonomy: { gates: PlanningPhase[]; changeMerge: "auto" | "manual"; autoApproveScope: boolean; decide: DecideMode }
  // mobile: the illustrator also draws a phone version of every desktop screen.
  // variations: how many logo-and-style directions the concepts phase draws before branding (under 2 skips it).
  // dark: the illustrator also redraws the landing in a dark theme, and the designer takes the .dark tokens from it.
  // style: "auto" lets each concept direction pick a different style from knowledge/design-styles.json; a style id
  // makes every direction use that style.
  branding: { enabled: boolean; count: number; mobile: boolean; variations: number; dark: boolean; style: string }
  marketing: { enabled: boolean; pieces: number; formats: MarketingFormat[] }
  publish: PublishConfig
  runners: RunnersConfig
  deploy: { enabled: boolean }
  // resolveAll: a QA pass with open findings counts as a fail, so every finding, minor ones included, gets a fix task.
  qa: { enabled: boolean; maxRounds: number; resolveAll: boolean }
  sprints: SprintConfig
  learning: LearningConfig
  // runUsd caps the reported agent cost of the whole project; the run stops for a human when it is reached.
  budget: { perTaskUsd: number; runUsd: number }
  // How many tasks run at once. Tasks whose allowedPaths overlap never run together.
  parallelTasks: number
  roles: Record<Role, RoleConfig>
  stackHints: { prefer: string[]; avoid: string[] }
  // null is the custom stack: the architect chooses it.
  template: TemplatePin | null
  allowSameVendorReview: boolean
  harness: HarnessConfig
  lead: LeadConfig
  operate: OperateConfig
  routines: RoutinesConfig
  import: ImportConfig | null
}

export const routineTriggers = ["interval", "sprint", "deploy", "manual"] as const
export type RoutineTrigger = (typeof routineTriggers)[number]
// sprint: the findings join the backlog, then the routine starts a sprint that builds from it.
export const routineOutputs = ["backlog", "marketing", "report", "sprint"] as const
export type RoutineOutput = (typeof routineOutputs)[number]
// Roles a custom routine may use. The Operate agents are built-in routines instead, because the server gathers
// their data (health checks, logs, PostHog) before the call.
export const routineRoles = ["marketer", "researcher", "pm", "designer"] as const
export type RoutineRole = (typeof routineRoles)[number]

// A recurring job for one agent. The three Operate agents are built-in routines (id monitoring, analytics, or
// research): only enabled, trigger (interval or manual), and everyDays apply to them.
export interface RoutineConfig {
  id: string
  name: string
  role: Role
  instructions: string
  trigger: RoutineTrigger
  // Only for the interval trigger. Fractions work: 0.25 is every 6 hours.
  everyDays: number
  output: RoutineOutput
  budgetUsd: number
  enabled: boolean
}

export interface RoutinesConfig {
  // The most all routine runs of the last 30 days may spend together, built-in ones included.
  monthlyUsd: number
  list: RoutineConfig[]
}

// Once the app is live, the doctor starts a sprint every everyDays: the evaluator scores the app, the PM picks
// backlog items (and may propose new features), and they ship as one change request with QA and a redeploy.
export interface SprintConfig {
  enabled: boolean
  // Days from the end of one sprint to the start of the next.
  everyDays: number
  // The most one sprint may spend; budget.runUsd is raised to the project cost plus this when a sprint starts.
  budgetUsd: number
  // The most all sprints that started in the last 30 days may spend together.
  monthlyUsd: number
  // Backlog items per sprint.
  maxItems: number
  // The PM may propose features the brief does not ask for.
  newFeatures: boolean
}

// Lessons learned from reviews, QA, evaluations, and incidents, shared by every project in the runs folder.
export interface LearningConfig {
  enabled: boolean
  // How many lessons each role gets in its system prompt, highest weight first.
  maxLessonsPerRole: number
  // Solution memory: merged tasks from every project, searched for each new task (see src/memory.ts).
  memory: boolean
  // How many similar solutions a worker gets in its task prompt.
  maxSimilarTasks: number
}

export const defaultSprintConfig: SprintConfig = { enabled: false, everyDays: 7, budgetUsd: 25, monthlyUsd: 100, maxItems: 5, newFeatures: true }
export const defaultLearningConfig: LearningConfig = { enabled: true, maxLessonsPerRole: 20, memory: true, maxSimilarTasks: 2 }

// Projects from before sprints have an evolve block; its switch and cycle budget carry over.
function normalizeSprints(raw: any, legacyEvolve: any): SprintConfig {
  if (raw === undefined && legacyEvolve !== undefined) {
    return { ...defaultSprintConfig, enabled: legacyEvolve.enabled ?? false, budgetUsd: legacyEvolve.cycleBudgetUsd ?? defaultSprintConfig.budgetUsd }
  }
  return { ...defaultSprintConfig, ...raw }
}

function sprintProblems(sprints: SprintConfig): string[] {
  const problems: string[] = []
  if (typeof sprints.enabled !== "boolean") problems.push("sprints.enabled must be true or false")
  if (!(sprints.everyDays > 0)) problems.push("sprints.everyDays must be a number above 0")
  if (!(sprints.budgetUsd > 0)) problems.push("sprints.budgetUsd must be a number above 0")
  if (!(sprints.monthlyUsd >= sprints.budgetUsd)) problems.push("sprints.monthlyUsd must be at least sprints.budgetUsd")
  if (!Number.isInteger(sprints.maxItems) || sprints.maxItems < 1 || sprints.maxItems > 10) problems.push("sprints.maxItems must be a whole number from 1 to 10")
  if (typeof sprints.newFeatures !== "boolean") problems.push("sprints.newFeatures must be true or false")
  return problems
}

export interface TemplatePin {
  name: string
  version: number
}

export const leadActionKinds = ["retry", "resume", "approve", "request_changes", "raise_budget", "add_task", "edit_task"] as const
export type LeadActionKind = (typeof leadActionKinds)[number]

export const leadAccessModes = ["read", "full"] as const
export type LeadAccess = (typeof leadAccessModes)[number]
export const decideModes = ["human", "auto"] as const
export type DecideMode = (typeof decideModes)[number]

// What the project lead may suggest in the chat, and which of those apply without a click.
// access "full" lets the lead edit files and run commands in the project folder, with no review.
// loadConfig always sets access; it is optional so settings saved without it fall back to "read".
export interface LeadConfig {
  actions: LeadActionKind[]
  autoApply: LeadActionKind[]
  chatBudgetUsd: number
  access?: LeadAccess
}

export const defaultLeadConfig: LeadConfig = { actions: [...leadActionKinds], autoApply: [], chatBudgetUsd: 2, access: "read" }

export const marketingFormats = {
  og: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
  x: { width: 1600, height: 900 },
} as const
export type MarketingFormat = keyof typeof marketingFormats

export const defaultRunBudgetUsd = 30
export const defaultParallelTasks = 5

export function loadConfig(path: string): PipelineConfig {
  const raw = parse(readFileSync(path, "utf8")) ?? {}
  const config: PipelineConfig = {
    target: raw.target ?? "web",
    autonomy: { gates: normalizeGates(raw.autonomy?.gates), changeMerge: raw.autonomy?.changeMerge ?? "auto", autoApproveScope: raw.autonomy?.autoApproveScope ?? false, decide: raw.autonomy?.decide ?? "human" },
    branding: normalizeBranding(raw.branding ?? raw.mockups),
    marketing: {
      enabled: raw.marketing?.enabled ?? true,
      pieces: raw.marketing?.pieces ?? 3,
      formats: raw.marketing?.formats ?? Object.keys(marketingFormats),
    },
    deploy: { enabled: raw.deploy?.enabled ?? false },
    qa: { enabled: raw.qa?.enabled ?? true, maxRounds: raw.qa?.maxRounds ?? 3, resolveAll: raw.qa?.resolveAll ?? false },
    sprints: normalizeSprints(raw.sprints, raw.evolve),
    learning: { ...defaultLearningConfig, ...raw.learning },
    publish: {
      github: {
        enabled: raw.publish?.github?.enabled ?? false,
        owner: raw.publish?.github?.owner ?? null,
        visibility: raw.publish?.github?.visibility ?? "private",
        name: raw.publish?.github?.name ?? null,
        board: raw.publish?.github?.board ?? true,
        issues: {
          enabled: raw.publish?.github?.issues?.enabled ?? true,
          everyMinutes: raw.publish?.github?.issues?.everyMinutes ?? 10,
        },
      },
    },
    runners: { codex: normalizeCodexRunner(raw.runners?.codex) },
    budget: { perTaskUsd: raw.budget?.perTaskUsd ?? 2, runUsd: raw.budget?.runUsd ?? defaultRunBudgetUsd },
    parallelTasks: raw.parallelTasks ?? defaultParallelTasks,
    roles: normalizeRoles(raw.roles),
    stackHints: { prefer: raw.stackHints?.prefer ?? [], avoid: raw.stackHints?.avoid ?? [] },
    template: normalizeTemplate(raw.template, dirname(path)),
    allowSameVendorReview: raw.allowSameVendorReview ?? false,
    harness: {
      isolation: raw.harness?.isolation ?? "none",
      docker: {
        cpus: raw.harness?.docker?.cpus ?? 2,
        memory: raw.harness?.docker?.memory ?? "4g",
        pidsLimit: raw.harness?.docker?.pidsLimit ?? 512,
      },
      network: {
        allowlist: raw.harness?.network?.allowlist ?? true,
        extraDomains: raw.harness?.network?.extraDomains ?? [],
      },
      transientRetries: raw.harness?.transientRetries ?? 2,
      backoffMs: raw.harness?.backoffMs ?? 15_000,
      cooldownMs: raw.harness?.cooldownMs ?? 15 * 60_000,
      agentTimeoutMs: raw.harness?.agentTimeoutMs ?? 30 * 60_000,
    },
    lead: {
      actions: raw.lead?.actions ?? defaultLeadConfig.actions,
      autoApply: raw.lead?.autoApply ?? defaultLeadConfig.autoApply,
      chatBudgetUsd: raw.lead?.chatBudgetUsd ?? defaultLeadConfig.chatBudgetUsd,
      access: raw.lead?.access ?? defaultLeadConfig.access,
    },
    operate: normalizeOperate(raw.operate),
    routines: normalizeRoutines(raw.routines, raw.operate?.schedule),
    import: raw.import ? { source: raw.import.source, urls: raw.import.urls ?? [], github: raw.import.github ?? "none" } : null,
  }
  config.operate.schedule = scheduleFromRoutines(config.routines)
  validateConfig(config, dirname(path))
  return config
}

export const defaultSchedule: Record<InsightAgent, number> = { monitoring: 24, analytics: 24, research: 168 }

function normalizeOperate(raw: any): OperateConfig {
  const posthog = raw?.posthog
  return {
    enabled: raw?.enabled ?? true,
    healthPath: raw?.healthPath ?? "/",
    schedule: { ...defaultSchedule, ...raw?.schedule },
    posthog: posthog?.projectId
      ? {
          host: String(posthog.host ?? "https://us.posthog.com").replace(/\/+$/, ""),
          projectId: String(posthog.projectId),
          publicKey: posthog.publicKey ? String(posthog.publicKey) : null,
          apiKeyEnv: posthog.apiKeyEnv ?? "POSTHOG_API_KEY",
        }
      : null,
    competitors: raw?.competitors ?? [],
  }
}

const builtInRoutineDefaults: Record<InsightAgent, Pick<RoutineConfig, "name" | "instructions">> = {
  monitoring: { name: "Health check review", instructions: "Read health probes, logs, and incidents." },
  analytics: { name: "Funnel review", instructions: "Read PostHog numbers and find drop-offs." },
  research: { name: "Competitor research", instructions: "Compare the app with its competitors and log gaps." },
}
export const insightBudgetUsd = 1
export const defaultRoutinesMonthlyUsd = 40

export function isBuiltInRoutine(id: string): id is InsightAgent {
  return (insightAgents as readonly string[]).includes(id)
}

// Projects from before routines set the Operate agents in operate.schedule, in hours; 0 turned an agent off.
function builtInRoutine(agent: InsightAgent, raw: any, legacyHours: unknown): RoutineConfig {
  const hours = typeof legacyHours === "number" ? legacyHours : defaultSchedule[agent]
  // A negative value stays negative, so validation still rejects it.
  const legacy = { enabled: hours !== 0, everyDays: hours !== 0 ? hours / 24 : defaultSchedule[agent] / 24 }
  return {
    ...builtInRoutineDefaults[agent],
    id: agent,
    role: insightAgentRoles[agent],
    trigger: raw?.trigger ?? "interval",
    everyDays: raw?.everyDays ?? legacy.everyDays,
    output: "backlog",
    budgetUsd: insightBudgetUsd,
    enabled: raw?.enabled ?? legacy.enabled,
  }
}

function normalizeRoutines(raw: any, legacySchedule: any): RoutinesConfig {
  const entries: any[] = Array.isArray(raw?.list) ? raw.list : []
  const custom = entries
    .filter((entry) => !isBuiltInRoutine(entry?.id))
    .map((entry) => ({ trigger: "interval", everyDays: 7, output: "report", budgetUsd: 2, enabled: true, instructions: "", ...entry }) as RoutineConfig)
  const builtIns = insightAgents.map((agent) => builtInRoutine(agent, entries.find((entry) => entry?.id === agent), legacySchedule?.[agent]))
  return { monthlyUsd: raw?.monthlyUsd ?? defaultRoutinesMonthlyUsd, list: [...builtIns, ...custom] }
}

// The Operate code still reads operate.schedule, so it is derived from the built-in routines.
function scheduleFromRoutines(routines: RoutinesConfig): Record<InsightAgent, number> {
  const hours = (agent: InsightAgent) => {
    const routine = routines.list.find((entry) => entry.id === agent)
    return routine?.enabled && routine.trigger === "interval" ? routine.everyDays * 24 : 0
  }
  return Object.fromEntries(insightAgents.map((agent) => [agent, hours(agent)])) as Record<InsightAgent, number>
}

export const routineIdPattern = /^[a-z0-9][a-z0-9-]{0,39}$/

function routineProblems(routines: RoutinesConfig, roleConfigs: Record<Role, RoleConfig>): string[] {
  const problems: string[] = []
  if (!(routines.monthlyUsd > 0)) problems.push("routines.monthlyUsd must be a number above 0")
  const seen = new Set<string>()
  for (const routine of routines.list) {
    const label = `routine "${routine.id}"`
    if (typeof routine.id !== "string" || !routineIdPattern.test(routine.id)) problems.push(`${label}: id must be lowercase letters, digits, and dashes, at most 40 characters`)
    if (seen.has(routine.id)) problems.push(`${label}: the id is used twice`)
    seen.add(routine.id)
    if (typeof routine.enabled !== "boolean") problems.push(`${label}: enabled must be true or false`)
    if (!routineTriggers.includes(routine.trigger)) problems.push(`${label}: trigger must be one of ${routineTriggers.join(", ")}`)
    if (routine.trigger === "interval" && !(routine.everyDays > 0)) problems.push(`${label}: everyDays must be a number above 0`)
    if (isBuiltInRoutine(routine.id)) {
      if (routine.trigger !== "interval" && routine.trigger !== "manual") problems.push(`${label}: a built-in routine runs on an interval or by hand only`)
      continue
    }
    if (typeof routine.name !== "string" || !routine.name.trim()) problems.push(`${label}: name is missing`)
    if (typeof routine.instructions !== "string" || !routine.instructions.trim()) problems.push(`${label}: instructions are missing`)
    if (!(routineRoles as readonly string[]).includes(routine.role)) problems.push(`${label}: role must be one of ${routineRoles.join(", ")}`)
    if (!routineOutputs.includes(routine.output)) problems.push(`${label}: output must be one of ${routineOutputs.join(", ")}`)
    if (!(routine.budgetUsd > 0 && routine.budgetUsd <= 10)) problems.push(`${label}: budgetUsd must be above 0 and at most 10`)
    if (routine.output === "marketing" && roleConfigs[routine.role]?.runner !== "codex") problems.push(`${label}: marketing images need a role on the codex runner, which can generate images`)
  }
  return problems
}

function operateProblems(operate: OperateConfig): string[] {
  const problems: string[] = []
  if (typeof operate.enabled !== "boolean") problems.push("operate.enabled must be true or false")
  if (typeof operate.healthPath !== "string" || !operate.healthPath.startsWith("/")) problems.push("operate.healthPath must start with /")
  for (const [agent, hours] of Object.entries(operate.schedule)) {
    if (!(insightAgents as readonly string[]).includes(agent)) problems.push(`unknown operate.schedule agent "${agent}"; use ${insightAgents.join(", ")}`)
    else if (typeof hours !== "number" || !(hours >= 0)) problems.push(`operate.schedule.${agent} must be a number of hours, 0 or more`)
  }
  if (operate.posthog) {
    if (!/^https?:\/\//.test(operate.posthog.host)) problems.push("operate.posthog.host must be an http(s) URL")
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(operate.posthog.apiKeyEnv)) problems.push("operate.posthog.apiKeyEnv must be the name of an environment variable, not the key")
  }
  if (!Array.isArray(operate.competitors) || !operate.competitors.every((url) => typeof url === "string" && /^https?:\/\//.test(url))) {
    problems.push("operate.competitors must be a list of http(s) URLs")
  }
  return problems
}

// `template: <name>` pins the version in the project's stack.json, else the current version of the template.
function normalizeTemplate(raw: unknown, projectDir: string): TemplatePin | null {
  if (raw === undefined || raw === null || raw === customTemplate) return null
  if (typeof raw === "string") {
    const pinned = readStack(projectDir)
    const version = pinned?.name === raw ? pinned.version : (findTemplate(raw)?.version ?? 0)
    return { name: raw, version }
  }
  const { name, version } = raw as Record<string, unknown>
  return { name: name as string, version: version as number }
}

function templateProblems(config: PipelineConfig, projectDir: string): string[] {
  if (!config.template) return []
  const { name, version } = config.template
  if (typeof name !== "string" || !name) return ["template.name must be a template name, or set template: custom"]
  const problems = Number.isInteger(version) && version >= 1 ? [] : ["template.version must be a whole number of 1 or more"]
  let manifest: StackManifest | null
  try {
    // A pinned project reads its own stack.json, so it keeps working after the template folder is deleted.
    manifest = readStack(projectDir) ?? findTemplate(name)
  } catch (error) {
    return [...problems, (error as Error).message]
  }
  if (!manifest) return [...problems, `unknown template "${name}"; run agent-team templates to list them`]
  if (!manifest.targets.includes(config.target)) problems.push(`template "${name}" serves ${manifest.targets.join(", ")}, not target ${config.target}`)
  return problems
}

function normalizeGates(rawGates: unknown): PlanningPhase[] {
  if (!Array.isArray(rawGates)) return []
  return [...new Set(rawGates.map((gate) => normalizePhaseName(String(gate))))] as PlanningPhase[]
}

function normalizeBranding(raw: { enabled?: boolean; count?: number; mobile?: boolean; variations?: number; dark?: boolean; style?: string } | undefined): PipelineConfig["branding"] {
  return { enabled: raw?.enabled ?? true, count: raw?.count ?? 4, mobile: raw?.mobile ?? true, variations: raw?.variations ?? 3, dark: raw?.dark ?? true, style: raw?.style ?? autoStyle }
}

// Roles added after a project was created get a default, so older pipeline.yaml files keep working.
export const defaultRoles: Partial<Record<Role, Candidate>> = {
  importer: { runner: "claude", model: "opus" },
  illustrator: { runner: "codex", model: "gpt-6-astra" },
  // Codex both searches stock photos with curl and generates images.
  marketer: { runner: "codex", model: "gpt-6-astra" },
  qa: { runner: "claude", model: "opus" },
  doctor: { runner: "claude", model: "opus" },
  lead: { runner: "claude", model: "opus" },
  "design-reviewer": { runner: "claude", model: "opus" },
  monitor: { runner: "claude", model: "claude-opus-5-5" },
  analyst: { runner: "claude", model: "claude-opus-5-5" },
  researcher: { runner: "claude", model: "claude-opus-5-5" },
  evaluator: { runner: "claude", model: "claude-opus-5-5" },
  curator: { runner: "claude", model: "claude-opus-5-5" },
}

function normalizeRoles(rawRoles: Record<string, any> | undefined): Record<Role, RoleConfig> {
  const normalized: Record<string, RoleConfig> = {}
  for (const [role, candidate] of Object.entries(defaultRoles)) {
    if (!rawRoles?.[role]) normalized[role] = { ...candidate, fallbacks: [] }
  }
  for (const [role, value] of Object.entries(rawRoles ?? {})) {
    normalized[role] = { ...value, fallbacks: value?.fallbacks ?? [] }
  }
  return normalized as Record<Role, RoleConfig>
}

// A block with neither key counts as unset. Validation checks the raw values, so they are kept as they are.
function normalizeCodexRunner(raw: any): CodexRunnerConfig | null {
  if (raw === undefined || raw === null) return null
  const baseUrl = raw.baseUrl ?? null
  const apiKeyEnv = raw.apiKeyEnv ?? null
  if (baseUrl === null && apiKeyEnv === null) return null
  return { baseUrl, apiKeyEnv }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function runnerProblems(runners: RunnersConfig): string[] {
  const codex = runners.codex
  if (!codex) return []
  const problems: string[] = []
  if (codex.baseUrl === null) problems.push("runners.codex.apiKeyEnv needs runners.codex.baseUrl; set the base URL or remove apiKeyEnv")
  else if (!isHttpUrl(codex.baseUrl)) problems.push("Set codex base URL to a full http or https URL.")
  if (codex.apiKeyEnv !== null && (typeof codex.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(codex.apiKeyEnv))) {
    problems.push("runners.codex.apiKeyEnv must be the name of an environment variable, not the key")
  }
  return problems
}

function issuesProblems(issues: PublishConfig["github"]["issues"]): string[] {
  const problems: string[] = []
  if (typeof issues.enabled !== "boolean") problems.push("publish.github.issues.enabled must be true or false")
  if (typeof issues.everyMinutes !== "number" || !(issues.everyMinutes >= 1 && issues.everyMinutes <= 1440)) {
    problems.push("publish.github.issues.everyMinutes must be a number from 1 to 1440")
  }
  return problems
}

function importProblems(config: ImportConfig | null): string[] {
  if (!config) return []
  const problems: string[] = []
  if (typeof config.source !== "string" || !config.source) problems.push("import.source must be the git URL or folder the project came from")
  if (!Array.isArray(config.urls) || !config.urls.every((url) => typeof url === "string" && /^https?:\/\//.test(url))) problems.push("import.urls must be a list of http(s) URLs")
  if (!(importGitHubModes as readonly string[]).includes(config.github)) problems.push(`import.github must be ${importGitHubModes.join(", ")}`)
  return problems
}

function validateConfig(config: PipelineConfig, projectDir: string): void {
  const errors: string[] = [...templateProblems(config, projectDir), ...operateProblems(config.operate), ...importProblems(config.import), ...issuesProblems(config.publish.github.issues), ...runnerProblems(config.runners)]
  if (!["none", "docker"].includes(config.harness.isolation)) errors.push("harness.isolation must be none or docker")
  if (!["private", "public"].includes(config.publish.github.visibility)) errors.push("publish.github.visibility must be private or public")
  if (config.branding.count < 2 || config.branding.count > 6) errors.push("branding.count must be between 2 and 6")
  if (!Number.isInteger(config.branding.variations) || config.branding.variations < 0 || config.branding.variations > 4) errors.push("branding.variations must be a whole number from 0 to 4 (under 2 skips the concepts phase)")
  if (typeof config.branding.dark !== "boolean") errors.push("branding.dark must be true or false")
  if (config.branding.style !== autoStyle && !designStyleIds().includes(config.branding.style)) errors.push(`branding.style must be ${autoStyle} or one of ${designStyleIds().join(", ")}`)
  if (!Number.isInteger(config.marketing.pieces) || config.marketing.pieces < 1 || config.marketing.pieces > 6) errors.push("marketing.pieces must be a whole number between 1 and 6")
  if (!Array.isArray(config.marketing.formats) || !config.marketing.formats.length) errors.push("marketing.formats needs at least one format")
  for (const format of config.marketing.formats ?? []) {
    if (!(format in marketingFormats)) errors.push(`unknown marketing format "${format}"; use ${Object.keys(marketingFormats).join(", ")}`)
  }
  if (!Number.isInteger(config.qa.maxRounds) || config.qa.maxRounds < 1) errors.push("qa.maxRounds must be a whole number of 1 or more")
  if (typeof config.qa.resolveAll !== "boolean") errors.push("qa.resolveAll must be true or false")
  errors.push(...sprintProblems(config.sprints))
  errors.push(...routineProblems(config.routines, config.roles))
  if (typeof config.learning.enabled !== "boolean") errors.push("learning.enabled must be true or false")
  if (typeof config.learning.memory !== "boolean") errors.push("learning.memory must be true or false")
  if (!Number.isInteger(config.learning.maxSimilarTasks) || config.learning.maxSimilarTasks < 0) errors.push("learning.maxSimilarTasks must be a whole number of 0 or more")
  if (!Number.isInteger(config.learning.maxLessonsPerRole) || config.learning.maxLessonsPerRole < 0) errors.push("learning.maxLessonsPerRole must be a whole number of 0 or more")
  if (!Number.isInteger(config.parallelTasks) || config.parallelTasks < 1) errors.push("parallelTasks must be a whole number of 1 or more")
  if (!(config.budget.runUsd > 0)) errors.push("budget.runUsd must be a number above 0")
  for (const field of ["actions", "autoApply"] as const) {
    const kinds = config.lead[field]
    if (!Array.isArray(kinds) || !kinds.every((kind) => (leadActionKinds as readonly string[]).includes(kind))) errors.push(`lead.${field} must list only ${leadActionKinds.join(", ")}`)
  }
  if (Array.isArray(config.lead.autoApply) && config.lead.autoApply.some((kind) => !config.lead.actions.includes(kind))) errors.push("lead.autoApply may only list kinds that lead.actions allows")
  if (!(config.lead.chatBudgetUsd > 0 && config.lead.chatBudgetUsd <= 20)) errors.push("lead.chatBudgetUsd must be above 0 and at most 20")
  if (!(leadAccessModes as readonly unknown[]).includes(config.lead.access ?? defaultLeadConfig.access)) errors.push(`lead.access must be ${leadAccessModes.join(" or ")}`)
  if (!["web", "api", "web+api"].includes(config.target)) errors.push(`target must be web, api, or web+api`)
  if (config.autonomy.changeMerge !== "auto" && config.autonomy.changeMerge !== "manual") errors.push("autonomy.changeMerge must be auto or manual")
  if (typeof config.autonomy.autoApproveScope !== "boolean") errors.push("autonomy.autoApproveScope must be true or false")
  if (!(decideModes as readonly unknown[]).includes(config.autonomy.decide)) errors.push(`autonomy.decide must be ${decideModes.join(" or ")}`)
  for (const gate of config.autonomy.gates) {
    if (!planningPhases.includes(gate)) errors.push(`unknown gate "${gate}"`)
  }
  for (const role of roles) {
    const roleConfig = config.roles?.[role]
    if (!roleConfig) {
      errors.push(`roles.${role} is missing`)
      continue
    }
    if (!runnerNames.includes(roleConfig.runner)) errors.push(`roles.${role}.runner must be one of ${runnerNames.join(", ")}`)
    if (!roleConfig.model) errors.push(`roles.${role}.model is missing`)
    for (const [index, fallback] of roleConfig.fallbacks.entries()) {
      if (!runnerNames.includes(fallback?.runner)) errors.push(`roles.${role}.fallbacks[${index}].runner is invalid`)
      if (!fallback?.model) errors.push(`roles.${role}.fallbacks[${index}].model is missing`)
    }
  }
  if (
    !config.allowSameVendorReview &&
    config.roles?.worker?.runner === config.roles?.reviewer?.runner
  ) {
    errors.push("worker and reviewer use the same runner; set allowSameVendorReview: true to allow it")
  }
  if (errors.length) throw new Error(`Invalid pipeline.yaml:\n- ${errors.join("\n- ")}`)
}
