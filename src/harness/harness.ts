import { basename } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Candidate, HarnessConfig, Role, RoleConfig } from "../config.ts"
import { getRunner } from "../runners/index.ts"
import type { AgentRunner, RunRequest, RunResult } from "../runners/types.ts"
import type { Store } from "../store.ts"
import { classifyFailure, cooldownMultiplier, type FailureClass } from "./classify.ts"
import type { Executor } from "./executor.ts"

export interface AgentJob {
  role: Role
  subject: string
  systemPrompt: string
  taskPrompt: string
  allowedTools: string[]
  writablePaths?: string[]
  budgetUsd: number
  transcriptPath: (candidate: Candidate, attempt: number) => string
}

// An agent call in progress, kept in the meta table under liveAgentPrefix so the dashboard can follow it.
export interface LiveAgent {
  subject: string
  role: string
  runner: string
  model: string
  startedAt: string
  transcript: string
  hostDir: string
}

export const liveAgentPrefix = "agent.live."

export interface HarnessOutcome {
  result: RunResult
  candidate: Candidate | null
  failureClass: FailureClass | null
}

// Longest time the harness waits for a cooled-down runner (e.g. a subscription limit resetting) before giving up.
const maxCooldownWaitMs = 60 * 60_000
const cooldownPollMs = 60_000

export function createHarness(options: {
  config: HarnessConfig
  store: Store
  signal: AbortSignal
  resolveRunner?: (name: Candidate["runner"]) => AgentRunner
  pollMs?: number
}) {
  const { config, store, signal, resolveRunner = getRunner, pollMs = cooldownPollMs } = options

  async function runCandidate(candidate: Candidate, job: AgentJob, executor: Executor): Promise<HarnessOutcome> {
    let outcome: HarnessOutcome | null = null
    for (let attempt = 1; attempt <= config.transientRetries + 1; attempt++) {
      const request: RunRequest = {
        role: job.role,
        model: candidate.model,
        systemPrompt: job.systemPrompt,
        taskPrompt: job.taskPrompt,
        executor,
        allowedTools: job.allowedTools,
        writablePaths: job.writablePaths,
        budgetUsd: job.budgetUsd,
        timeoutMs: config.agentTimeoutMs,
        transcriptPath: job.transcriptPath(candidate, attempt),
        signal,
      }
      const liveKey = `${liveAgentPrefix}${basename(request.transcriptPath)}`
      const live: LiveAgent = { subject: job.subject, role: job.role, runner: candidate.runner, model: candidate.model, startedAt: new Date().toISOString(), transcript: basename(request.transcriptPath), hostDir: executor.hostDir }
      store.setMeta(liveKey, JSON.stringify(live))
      const result = await resolveRunner(candidate.runner).run(request).finally(() => store.deleteMeta(liveKey))
      const failureClass = classifyFailure(result)
      store.recordAttempt({
        subject: job.subject,
        role: job.role,
        runner: candidate.runner,
        model: candidate.model,
        status: result.status,
        failureClass,
        costUsd: result.costUsd,
        tokens: result.tokens,
        durationMs: result.durationMs,
        transcriptPath: request.transcriptPath,
      })
      outcome = { result, candidate, failureClass }
      if (failureClass !== "unavailable" || signal.aborted) return outcome
      const delay = config.backoffMs * 2 ** (attempt - 1)
      store.log("harness", `${candidate.runner}/${candidate.model} unavailable; retrying in ${Math.round(delay / 1000)}s`)
      await sleep(delay, undefined, { signal }).catch(() => {})
    }
    return outcome!
  }

  async function waitForCandidate(chain: Candidate[]): Promise<boolean> {
    const soonestAvailable = () => Math.min(...chain.map((candidate) => store.runnerCooldownUntil(candidate.runner)))
    const waitMs = soonestAvailable() - Date.now()
    if (waitMs <= 0 || waitMs > maxCooldownWaitMs) return false
    store.log("harness", `all runners cooling down; waiting ${Math.round(waitMs / 60_000)} min`)
    // Polls instead of one long sleep, so a cooldown cleared from the dashboard or the CLI takes effect at once.
    while (!signal.aborted && soonestAvailable() > Date.now()) {
      await sleep(Math.min(pollMs, soonestAvailable() - Date.now()), undefined, { signal }).catch(() => {})
    }
    return !signal.aborted
  }

  return {
    // Runs a job through the role's candidate chain: primary first, then fallbacks.
    async run(roleConfig: RoleConfig, job: AgentJob, executor: Executor): Promise<HarnessOutcome> {
      const chain: Candidate[] = [{ runner: roleConfig.runner, model: roleConfig.model }, ...roleConfig.fallbacks]
      let last: HarnessOutcome | null = null
      for (let round = 0; round < 2; round++) {
        for (const candidate of chain) {
          if (signal.aborted) break
          if (store.runnerCooldownUntil(candidate.runner) > Date.now()) continue
          last = await runCandidate(candidate, job, executor)
          const failureClass = last.failureClass
          if (failureClass === null || failureClass === "agent_failure" || failureClass === "budget" || failureClass === "aborted") return last
          const multiplier = cooldownMultiplier[failureClass]
          if (multiplier) {
            store.coolDownRunner(candidate.runner, Date.now() + config.cooldownMs * multiplier, failureClass)
            store.log("harness", `${candidate.runner} cooling down after ${failureClass}`)
          }
          store.log("harness", `${candidate.runner}/${candidate.model} failed (${failureClass}); trying next candidate`)
        }
        if (signal.aborted || !(await waitForCandidate(chain))) break
      }
      return (
        last ?? {
          result: { status: "failed", summary: "no runner available: all candidates are cooling down", costUsd: null, tokens: null, durationMs: 0, exitCode: null, diagnostics: "" },
          candidate: null,
          failureClass: "rate_limit",
        }
      )
    },
  }
}

export type Harness = ReturnType<typeof createHarness>
