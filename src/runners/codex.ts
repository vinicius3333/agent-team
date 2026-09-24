import type { AgentRunner, RunRequest, RunResult } from "./types.ts"

// Codex has no per-tool allowlist; its workspace-write sandbox (and the container, when used) is the limit.
export const codexRunner: AgentRunner = {
  name: "codex",
  async run(request: RunRequest): Promise<RunResult> {
    const result = await request.executor.exec({
      command: "codex",
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        ...sandboxArgs(request),
        "-C", request.executor.workdir,
        "-m", request.model,
        "-",
      ],
      input: `${request.systemPrompt}\n\n${request.taskPrompt}`,
      timeoutMs: request.timeoutMs,
      transcriptPath: request.transcriptPath,
      signal: request.signal,
    })
    const base = { durationMs: result.durationMs, exitCode: result.exitCode, diagnostics: errorEvents(result.stdout, result.stderr), costUsd: null, tokens: codexTokens(result.stdout) }
    if (result.aborted) return { ...base, status: "aborted", summary: "" }
    if (result.timedOut) return { ...base, status: "timeout", summary: "" }

    const summary = lastAgentMessage(result.stdout)
    const completed = result.stdout.includes('"type":"turn.completed"')
    return {
      ...base,
      status: result.exitCode === 0 && completed ? "done" : "failed",
      summary: summary ?? result.stderr.slice(-2000),
    }
  },
}

// Codex's own sandbox (bwrap) cannot create namespaces inside our locked-down container, so there the container is the limit.
function sandboxArgs(request: RunRequest): string[] {
  if (request.executor.kind === "docker") return ["-s", "danger-full-access"]
  return ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"]
}

// Codex counts cached tokens inside input_tokens, so input plus output is the total.
export function codexTokens(jsonl: string): number | null {
  let total: number | null = null
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"turn.completed"')) continue
    try {
      const usage = JSON.parse(line).usage
      if (usage) total = (total ?? 0) + (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    } catch {}
  }
  return total
}

function errorEvents(jsonl: string, stderr: string): string {
  const errors = jsonl.split("\n").filter((line) => /"type":"(error|turn\.failed)"/.test(line))
  return `${errors.join("\n").slice(-3000)}\n${stderr.slice(-3000)}`
}

function lastAgentMessage(jsonl: string): string | null {
  let message: string | null = null
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"agent_message"')) continue
    try {
      const event = JSON.parse(line)
      if (event.type === "item.completed" && event.item?.type === "agent_message") message = event.item.text
    } catch {}
  }
  return message
}
