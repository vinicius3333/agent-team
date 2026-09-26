import type { Role, RunnerName } from "../config.ts"
import type { Executor } from "../harness/executor.ts"

export interface RunRequest {
  role: Role
  model: string
  systemPrompt: string
  taskPrompt: string
  executor: Executor
  allowedTools: string[]
  // Globs the agent may edit. Runners that support path rules deny edits elsewhere; the rest rely on the post-run check.
  writablePaths?: string[]
  budgetUsd: number
  timeoutMs: number
  transcriptPath: string
  signal?: AbortSignal
  // An OpenAI-compatible endpoint for the codex runner; apiKeyEnv names the env var that holds the key.
  codex?: { baseUrl: string; apiKeyEnv: string | null }
}

export interface RunResult {
  status: "done" | "failed" | "timeout" | "aborted"
  summary: string
  costUsd: number | null
  // Input, output, and cache tokens together; null when the runner did not report usage.
  tokens: number | null
  durationMs: number
  exitCode: number | null
  // Tail of raw stdout/stderr, used to classify failures (rate limit, auth, crash).
  diagnostics: string
}

export interface AgentRunner {
  readonly name: RunnerName
  run(request: RunRequest): Promise<RunResult>
}
