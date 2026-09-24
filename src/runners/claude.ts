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
function relativeRule(path: string): string {
  return path.startsWith("./") || path.startsWith("/") ? path : `./${path}`
}

export const claudeRunner: AgentRunner = {
  name: "claude",
  async run(request: RunRequest): Promise<RunResult> {
    const args = [
      "-p",
      "--output-format", "json",
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
    if (result.aborted) return { ...base, status: "aborted", summary: "", costUsd: null }
    if (result.timedOut) return { ...base, status: "timeout", summary: "", costUsd: null }

    try {
      const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")
      return {
        status: output.is_error || result.exitCode !== 0 ? "failed" : "done",
        summary: String(output.result ?? ""),
        costUsd: typeof output.total_cost_usd === "number" ? output.total_cost_usd : null,
        ...base,
        // A Claude error result is the CLI's own message (auth, limits), not the agent's work.
        diagnostics: output.is_error ? `${String(output.result ?? "")}\n${base.diagnostics}` : base.diagnostics,
      }
    } catch {
      return {
        status: "failed",
        summary: (result.stderr || result.stdout).slice(-2000),
        costUsd: null,
        ...base,
      }
    }
  },
}
