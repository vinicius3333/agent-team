import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { parse } from "yaml"
import { customTemplate, findTemplate, readStack, type StackManifest } from "./templates.ts"

export const planningPhases = ["spec", "architecture", "branding", "design", "marketing", "plan"] as const
export type PlanningPhase = (typeof planningPhases)[number]

// Phase names used by older projects, mapped to their current name.
const legacyPhaseNames: Record<string, PlanningPhase> = { mockups: "branding" }

export function normalizePhaseName(name: string): string {
  return legacyPhaseNames[name] ?? name
}

export const roles = ["pm", "architect", "illustrator", "designer", "marketer", "planner", "worker", "reviewer", "qa", "doctor", "lead", "design-reviewer"] as const
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
  github: { enabled: boolean; owner: string | null; visibility: "private" | "public"; name: string | null }
}

export interface PipelineConfig {
  target: "web" | "api" | "web+api"
  // changeMerge "manual" stops a change before its final merge into main until a person approves it.
  autonomy: { gates: PlanningPhase[]; changeMerge: "auto" | "manual" }
  // mobile: the illustrator also draws a phone version of every desktop screen.
  branding: { enabled: boolean; count: number; mobile: boolean }
  marketing: { enabled: boolean; pieces: number; formats: MarketingFormat[] }
  publish: PublishConfig
  deploy: { enabled: boolean }
  qa: { enabled: boolean; maxRounds: number }
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
}

export interface TemplatePin {
  name: string
  version: number
}

export const leadActionKinds = ["retry", "resume", "approve", "request_changes", "raise_budget", "add_task", "edit_task"] as const
export type LeadActionKind = (typeof leadActionKinds)[number]

// What the project lead may suggest in the chat, and which of those apply without a click.
export interface LeadConfig {
  actions: LeadActionKind[]
  autoApply: LeadActionKind[]
  chatBudgetUsd: number
}

export const defaultLeadConfig: LeadConfig = { actions: [...leadActionKinds], autoApply: [], chatBudgetUsd: 2 }

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
    autonomy: { gates: normalizeGates(raw.autonomy?.gates), changeMerge: raw.autonomy?.changeMerge ?? "auto" },
    branding: normalizeBranding(raw.branding ?? raw.mockups),
    marketing: {
      enabled: raw.marketing?.enabled ?? true,
      pieces: raw.marketing?.pieces ?? 3,
      formats: raw.marketing?.formats ?? Object.keys(marketingFormats),
    },
    deploy: { enabled: raw.deploy?.enabled ?? false },
    qa: { enabled: raw.qa?.enabled ?? true, maxRounds: raw.qa?.maxRounds ?? 3 },
    publish: {
      github: {
        enabled: raw.publish?.github?.enabled ?? false,
        owner: raw.publish?.github?.owner ?? null,
        visibility: raw.publish?.github?.visibility ?? "private",
        name: raw.publish?.github?.name ?? null,
      },
    },
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
    },
  }
  validateConfig(config, dirname(path))
  return config
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

function normalizeBranding(raw: { enabled?: boolean; count?: number; mobile?: boolean } | undefined): PipelineConfig["branding"] {
  return { enabled: raw?.enabled ?? true, count: raw?.count ?? 4, mobile: raw?.mobile ?? true }
}

// Roles added after a project was created get a default, so older pipeline.yaml files keep working.
export const defaultRoles: Partial<Record<Role, Candidate>> = {
  illustrator: { runner: "codex", model: "gpt-6-astra" },
  // Codex both searches stock photos with curl and generates images.
  marketer: { runner: "codex", model: "gpt-6-astra" },
  qa: { runner: "claude", model: "opus" },
  doctor: { runner: "claude", model: "opus" },
  lead: { runner: "claude", model: "opus" },
  "design-reviewer": { runner: "claude", model: "opus" },
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

function validateConfig(config: PipelineConfig, projectDir: string): void {
  const errors: string[] = templateProblems(config, projectDir)
  if (!["none", "docker"].includes(config.harness.isolation)) errors.push("harness.isolation must be none or docker")
  if (!["private", "public"].includes(config.publish.github.visibility)) errors.push("publish.github.visibility must be private or public")
  if (config.branding.count < 2 || config.branding.count > 6) errors.push("branding.count must be between 2 and 6")
  if (!Number.isInteger(config.marketing.pieces) || config.marketing.pieces < 1 || config.marketing.pieces > 6) errors.push("marketing.pieces must be a whole number between 1 and 6")
  if (!Array.isArray(config.marketing.formats) || !config.marketing.formats.length) errors.push("marketing.formats needs at least one format")
  for (const format of config.marketing.formats ?? []) {
    if (!(format in marketingFormats)) errors.push(`unknown marketing format "${format}"; use ${Object.keys(marketingFormats).join(", ")}`)
  }
  if (!Number.isInteger(config.qa.maxRounds) || config.qa.maxRounds < 1) errors.push("qa.maxRounds must be a whole number of 1 or more")
  if (!Number.isInteger(config.parallelTasks) || config.parallelTasks < 1) errors.push("parallelTasks must be a whole number of 1 or more")
  if (!(config.budget.runUsd > 0)) errors.push("budget.runUsd must be a number above 0")
  for (const field of ["actions", "autoApply"] as const) {
    const kinds = config.lead[field]
    if (!Array.isArray(kinds) || !kinds.every((kind) => (leadActionKinds as readonly string[]).includes(kind))) errors.push(`lead.${field} must list only ${leadActionKinds.join(", ")}`)
  }
  if (Array.isArray(config.lead.autoApply) && config.lead.autoApply.some((kind) => !config.lead.actions.includes(kind))) errors.push("lead.autoApply may only list kinds that lead.actions allows")
  if (!(config.lead.chatBudgetUsd > 0 && config.lead.chatBudgetUsd <= 20)) errors.push("lead.chatBudgetUsd must be above 0 and at most 20")
  if (!["web", "api", "web+api"].includes(config.target)) errors.push(`target must be web, api, or web+api`)
  if (config.autonomy.changeMerge !== "auto" && config.autonomy.changeMerge !== "manual") errors.push("autonomy.changeMerge must be auto or manual")
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
