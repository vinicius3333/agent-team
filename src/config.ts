import { readFileSync } from "node:fs"
import { parse } from "yaml"

export const planningPhases = ["spec", "architecture", "design", "plan"] as const
export type PlanningPhase = (typeof planningPhases)[number]

export const roles = ["pm", "architect", "designer", "planner", "worker", "reviewer"] as const
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
  transientRetries: number
  backoffMs: number
  cooldownMs: number
  agentTimeoutMs: number
}

export interface PipelineConfig {
  target: "web" | "api" | "web+api"
  autonomy: { gates: PlanningPhase[] }
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
    autonomy: { gates: raw.autonomy?.gates ?? [] },
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
      transientRetries: raw.harness?.transientRetries ?? 2,
      backoffMs: raw.harness?.backoffMs ?? 15_000,
      cooldownMs: raw.harness?.cooldownMs ?? 15 * 60_000,
      agentTimeoutMs: raw.harness?.agentTimeoutMs ?? 30 * 60_000,
    },
  }
  validateConfig(config)
  return config
}

function normalizeRoles(rawRoles: Record<string, any> | undefined): Record<Role, RoleConfig> {
  const normalized: Record<string, RoleConfig> = {}
  for (const [role, value] of Object.entries(rawRoles ?? {})) {
    normalized[role] = { ...value, fallbacks: value?.fallbacks ?? [] }
  }
  return normalized as Record<Role, RoleConfig>
}

function validateConfig(config: PipelineConfig): void {
  const errors: string[] = []
  if (!["none", "docker"].includes(config.harness.isolation)) errors.push("harness.isolation must be none or docker")
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
