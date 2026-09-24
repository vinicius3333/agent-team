export type TranscriptEntry =
  | { kind: "meta"; stats: Record<string, string | number | boolean | null | undefined> }
  | { kind: "message"; text: string }
  | { kind: "error"; text: string }
  | { kind: "raw"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "command"; command: string; output: string; exitCode: number | null }
  | { kind: "files"; changes: { kind: string; path: string }[] }

interface CodexItem {
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  changes?: { kind: string; path: string }[]
}

interface TranscriptLine {
  type?: string
  item?: CodexItem
  usage?: { input_tokens?: number; output_tokens?: number }
  message?: string
  error?: { message?: string }
  result?: unknown
  num_turns?: number
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
}

export function parseTranscript(text: string): TranscriptEntry[] {
  const [stdout, stderr = ""] = text.split("\n--- stderr ---\n")
  const parsed = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptLine
      } catch {
        return null
      }
    })
    .filter((line): line is TranscriptLine => line !== null)
  const entries: TranscriptEntry[] = []
  if (parsed.length === 1 && "result" in parsed[0]) {
    const result = parsed[0]
    entries.push({ kind: "meta", stats: { turns: result.num_turns, cost: result.total_cost_usd, duration: result.duration_ms, error: result.is_error } })
    entries.push({ kind: result.is_error ? "error" : "message", text: String(result.result ?? "") })
  } else {
    for (const event of parsed) {
      const item = event.item
      if (event.type === "item.completed" && item?.type === "agent_message") entries.push({ kind: "message", text: item.text ?? "" })
      else if (event.type === "item.completed" && item?.type === "command_execution")
        entries.push({ kind: "command", command: item.command ?? "", output: item.aggregated_output ?? "", exitCode: item.exit_code ?? null })
      else if (event.type === "item.completed" && item?.type === "file_change") entries.push({ kind: "files", changes: item.changes ?? [] })
      else if (event.type === "turn.completed") entries.push({ kind: "meta", stats: { input: event.usage?.input_tokens, output: event.usage?.output_tokens } })
      else if (event.type === "error" || event.type === "turn.failed")
        entries.push({ kind: "error", text: event.message ?? event.error?.message ?? JSON.stringify(event) })
    }
  }
  if (!parsed.length && stdout.trim()) entries.push({ kind: "raw", text: stdout })
  if (stderr.trim()) entries.push({ kind: "stderr", text: stderr.trim() })
  return entries
}

export interface Verdict {
  pass: boolean
  reasons: string[]
  fixes: string[]
}

export function parseVerdict(text: string): Verdict | null {
  const match = /\{[\s\S]*"verdict"[\s\S]*\}/.exec(text)
  if (!match) return null
  try {
    const verdict = JSON.parse(match[0]) as { verdict?: string; reasons?: string[]; fixes?: string[] }
    return { pass: verdict.verdict === "pass", reasons: verdict.reasons ?? [], fixes: verdict.fixes ?? [] }
  } catch {
    return null
  }
}

export function cleanCommand(command: string): string {
  return command.replace(/^\/bin\/(ba)?sh -lc ["']?/, "").replace(/["']$/, "")
}
