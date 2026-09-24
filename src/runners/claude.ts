import type { AgentRunner, RunRequest, RunResult } from "./types.ts"

const toolNames: Record<string, string[]> = {
  read: ["Read", "Glob", "Grep"],
  edit: ["Edit"],
  write: ["Write"],
}

const editTools = new Set(["edit", "write"])

// With writablePaths, edit and write become path rules such as Edit(./src/auth/**), so Claude denies other paths at once.
export function toClaudeTools(allowedTools: string[], writablePaths?: string[]): string[] {
  return allowedTools.flatMap((tool) => {
    if (tool.startsWith("bash:")) return [`Bash(${tool.slice("bash:".length)}:*)`]
    if (writablePaths && editTools.has(tool)) return writablePaths.flatMap((path) => toolNames[tool].map((name) => `${name}(${relativeRule(path)})`))
    return toolNames[tool] ?? []
  })
}

// `./` anchors the rule to the working directory; a leading `/` would mean the settings file's directory.
// Rules are globs, so literal brackets such as Next.js `[groupId]` folders must be escaped or they match nothing.
function relativeRule(path: string): string {
  const escaped = path.replace(/[[\]]/g, "\\$&")
  return escaped.startsWith("./") || escaped.startsWith("/") ? escaped : `./${escaped}`
}

// Claude reports cache reads and writes apart from input_tokens.
export function claudeTokens(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null
  const fields = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
  return fields.reduce((sum, field) => sum + (typeof usage[field] === "number" ? (usage[field] as number) : 0), 0)
}

// The final "result" event carries the answer, cost, and usage; with plain json output it is the only line.
export function claudeResult(stdout: string): Record<string, any> {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const event = JSON.parse(line)
      if (event?.type === "result") return event
    } catch {}
  }
  throw new Error("no result event in the Claude output")
}

// Limit errors such as error_max_budget_usd carry their message in `errors`, not `result`.
export function claudeErrorText(output: Record<string, any>): string {
  const result = String(output.result ?? "").trim()
  if (result) return result
  const errors = Array.isArray(output.errors) ? output.errors.map(String).join("\n").trim() : ""
  return errors || String(output.subtype ?? "unknown Claude error")
}

export const claudeRunner: AgentRunner = {
  name: "claude",
  async run(request: RunRequest): Promise<RunResult> {
    const args = [
      "-p",
      // stream-json writes each tool call as it happens, so the dashboard can follow a running agent.
      "--output-format", "stream-json",
      "--verbose",
      "--model", request.model,
      "--append-system-prompt", request.systemPrompt,
      // acceptEdits approves any edit in the working directory, which would bypass the path rules.
      "--permission-mode", request.writablePaths ? "default" : "acceptEdits",
      "--max-budget-usd", String(request.budgetUsd),
      "--allowedTools", ...toClaudeTools(request.allowedTools, request.writablePaths),
    ]
    const result = await request.executor.exec({
      command: "claude",
      args,
      input: request.taskPrompt,
      timeoutMs: request.timeoutMs,
      transcriptPath: request.transcriptPath,
      signal: request.signal,
    })
    const base = { durationMs: result.durationMs, exitCode: result.exitCode, diagnostics: result.stderr.slice(-3000) }
    if (result.aborted) return { ...base, status: "aborted", summary: "", costUsd: null, tokens: null }
    if (result.timedOut) return { ...base, status: "timeout", summary: "", costUsd: null, tokens: null }

    try {
      const output = claudeResult(result.stdout)
      return {
        status: output.is_error || result.exitCode !== 0 ? "failed" : "done",
        summary: String(output.result ?? ""),
        costUsd: typeof output.total_cost_usd === "number" ? output.total_cost_usd : null,
        tokens: claudeTokens(output.usage),
        ...base,
        // A Claude error result is the CLI's own message (auth, limits), not the agent's work.
        diagnostics: output.is_error ? `${claudeErrorText(output)}\n${base.diagnostics}` : base.diagnostics,
      }
    } catch {
      return {
        status: "failed",
        summary: (result.stderr || result.stdout).slice(-2000),
        costUsd: null,
        tokens: null,
        ...base,
      }
    }
  },
}
