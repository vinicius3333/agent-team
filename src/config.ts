import { readFileSync } from "node:fs"
import { parse } from "yaml"

export const planningPhases = ["spec", "architecture", "branding", "design", "plan"] as const
export type PlanningPhase = (typeof planningPhases)[number]

// Phase names used by older projects, mapped to their current name.
const legacyPhaseNames: Record<string, PlanningPhase> = { mockups: "branding" }

export function normalizePhaseName(name: string): string {
  return legacyPhaseNames[name] ?? name
}

export const roles = ["pm", "architect", "illustrator", "designer", "planner", "worker", "reviewer", "qa"] as const
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
  autonomy: { gates: PlanningPhase[] }
  branding: { enabled: boolean; count: number }
  publish: PublishConfig
  deploy: { enabled: boolean }
  qa: { enabled: boolean; maxRounds: number }
  budget: { perTaskUsd: number }
  roles: Record<Role, RoleConfig>
  stackHints: { prefer: string[]; avoid: string[] }
  allowSameVendorReview: boolean
  harness: HarnessConfig
}

export function loadConfig(path: string): PipelineConfig {
  const raw = parse(readFileSync(path, "utf8")) ?? {}
  const config: PipelineConfig = {
    target: raw.target ?? "web",
    autonomy: { gates: normalizeGates(raw.autonomy?.gates) },
    branding: normalizeBranding(raw.branding ?? raw.mockups),
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
    budget: { perTaskUsd: raw.budget?.perTaskUsd ?? 2 },
    roles: normalizeRoles(raw.roles),
    stackHints: { prefer: raw.stackHints?.prefer ?? [], avoid: raw.stackHints?.avoid ?? [] },
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
  }
  validateConfig(config)
  return config
}

function normalizeGates(rawGates: unknown): PlanningPhase[] {
  if (!Array.isArray(rawGates)) return []
  return [...new Set(rawGates.map((gate) => normalizePhaseName(String(gate))))] as PlanningPhase[]
}

function normalizeBranding(raw: { enabled?: boolean; count?: number } | undefined): PipelineConfig["branding"] {
  return { enabled: raw?.enabled ?? true, count: raw?.count ?? 4 }
}

// Roles added after a project was created get a default, so older pipeline.yaml files keep working.
const defaultRoles: Partial<Record<Role, Candidate>> = {
  illustrator: { runner: "codex", model: "gpt-6-astra" },
  qa: { runner: "claude", model: "opus" },
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

function validateConfig(config: PipelineConfig): void {
  const errors: string[] = []
  if (!["none", "docker"].includes(config.harness.isolation)) errors.push("harness.isolation must be none or docker")
  if (!["private", "public"].includes(config.publish.github.visibility)) errors.push("publish.github.visibility must be private or public")
  if (config.branding.count < 2 || config.branding.count > 6) errors.push("branding.count must be between 2 and 6")
  if (!Number.isInteger(config.qa.maxRounds) || config.qa.maxRounds < 1) errors.push("qa.maxRounds must be a whole number of 1 or more")
  if (!["web", "api", "web+api"].includes(config.target)) errors.push(`target must be web, api, or web+api`)
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
