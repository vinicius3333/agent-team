import type { RunResult } from "../runners/types.ts"

export type FailureClass =
  | "rate_limit" // quota or usage limit: cool the runner down, try the next candidate
  | "auth" // not logged in or bad key: cool down longer, try the next candidate
  | "unavailable" // network or provider overload: retry the same candidate with backoff
  | "missing_binary" // CLI not installed where it runs: try the next candidate
  | "timeout" // agent ran too long: try the next candidate
  | "aborted" // operator stopped the run: stop everything
  | "budget" // agent spent its whole per-call budget: hand back to the caller, a person decides whether to spend more
  | "agent_failure" // agent ran and failed on its own: hand back to the caller

const patterns: [FailureClass, RegExp][] = [
  ["budget", /reached maximum budget/i],
  ["auth", /not logged in|please run \/login|failed to authenticate|oauth session expired|invalid api key|api error: 401|refresh token/i],
  ["rate_limit", /rate limit (reached|exceeded)|usage limit|too many requests|api error: 429|quota exceeded|hit your limit|credit balance is too low/i],
  ["missing_binary", /spawn \S+ ENOENT|executable file not found/i],
  ["unavailable", /overloaded_error|api error: 5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|stream disconnected/i],
]

// Only runner-level output is scanned (stderr, error events), never the agent's own work, which may mention "401" or "rate limit".
export function classifyFailure(result: RunResult): FailureClass | null {
  if (result.status === "done") return null
  if (result.status === "aborted") return "aborted"
  if (result.status === "timeout") return "timeout"
  for (const [failureClass, pattern] of patterns) {
    if (pattern.test(result.diagnostics)) return failureClass
  }
  return "agent_failure"
}

export const cooldownMultiplier: Partial<Record<FailureClass, number>> = {
  rate_limit: 1,
  auth: 4,
  missing_binary: 4,
}
