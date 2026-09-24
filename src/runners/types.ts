import type { Role, RunnerName } from "../config.ts"
import type { Executor } from "../harness/executor.ts"

export interface RunRequest {
  role: Role
  model: string
  systemPrompt: string
  taskPrompt: string
  executor: Executor
  allowedTools: string[]
  budgetUsd: number
  timeoutMs: number
  transcriptPath: string
  signal?: AbortSignal
}

export interface RunResult {
  status: "done" | "failed" | "timeout" | "aborted"
  summary: string
  costUsd: number | null
  durationMs: number
  exitCode: number | null
  // Tail of raw stdout/stderr, used to classify failures (rate limit, auth, crash).
  diagnostics: string
}

export interface AgentRunner {
  readonly name: RunnerName
  run(request: RunRequest): Promise<RunResult>
}
