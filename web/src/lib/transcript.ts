export type TranscriptEntry =
  | { kind: "meta"; stats: Record<string, string | number | boolean | null | undefined> }
  | { kind: "message"; text: string }
  | { kind: "error"; text: string }
  | { kind: "raw"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "command"; command: string; output: string; exitCode: number | null }
  | { kind: "files"; changes: { kind: string; path: string }[] }
  | { kind: "tool"; name: string; detail: string }

interface CodexItem {
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  changes?: { kind: string; path: string }[]
}

interface ClaudeBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface TranscriptLine {
  message?: string | { content?: ClaudeBlock[] }
  subtype?: string
  type?: string
  item?: CodexItem
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  error?: { message?: string }
  result?: unknown
  errors?: unknown[]
  num_turns?: number
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
}

function claudeTokens(usage: TranscriptLine["usage"]): number | undefined {
  if (!usage) return undefined
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
}

// Limit errors such as error_max_budget_usd carry their message in `errors`, not `result`.
function errorText(line: TranscriptLine, result: string): string {
  if (result.trim()) return result
  const errors = (line.errors ?? []).map(String).join("\n").trim()
  return errors || line.subtype || "unknown error"
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
  const isClaude = parsed.some((line) => line.type === "result" || line.type === "assistant" || (parsed.length === 1 && "result" in line))
  if (isClaude) {
    entries.push(...claudeEntries(parsed))
  } else {
    for (const event of parsed) {
      const item = event.item
      if (event.type === "item.completed" && item?.type === "agent_message") entries.push({ kind: "message", text: item.text ?? "" })
      else if (event.type === "item.completed" && item?.type === "reasoning" && item.text?.trim()) entries.push({ kind: "tool", name: "Reasoning", detail: item.text })
      else if (event.type === "item.completed" && item?.type === "command_execution")
        entries.push({ kind: "command", command: item.command ?? "", output: item.aggregated_output ?? "", exitCode: item.exit_code ?? null })
      else if (event.type === "item.completed" && item?.type === "file_change") entries.push({ kind: "files", changes: item.changes ?? [] })
      else if (event.type === "turn.completed") entries.push({ kind: "meta", stats: { input: event.usage?.input_tokens, output: event.usage?.output_tokens } })
      else if (event.type === "error" || event.type === "turn.failed")
        entries.push({ kind: "error", text: (typeof event.message === "string" ? event.message : undefined) ?? event.error?.message ?? JSON.stringify(event) })
    }
  }
  if (!parsed.length && stdout.trim()) entries.push({ kind: "raw", text: stdout })
  if (stderr.trim()) entries.push({ kind: "stderr", text: stderr.trim() })
  return entries
}

const claudeEditTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  return ""
}

// Claude stream-json: assistant turns hold text and tool calls, user turns hold tool results, the last line is the result.
// Older transcripts hold only the result line.
function claudeEntries(lines: TranscriptLine[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const pendingCommands = new Map<string, Extract<TranscriptEntry, { kind: "command" }>>()
  let lastMessage = ""
  for (const line of lines) {
    const blocks = typeof line.message === "object" ? (line.message.content ?? []) : []
    if (line.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          lastMessage = block.text
          entries.push({ kind: "message", text: block.text })
        } else if (block.type === "tool_use") {
          const input = block.input ?? {}
          const name = block.name ?? "tool"
          if (name === "Bash") {
            const entry = { kind: "command" as const, command: String(input.command ?? ""), output: "", exitCode: null as number | null }
            if (block.id) pendingCommands.set(block.id, entry)
            entries.push(entry)
          } else if (claudeEditTools.has(name)) {
            entries.push({ kind: "files", changes: [{ kind: name === "Write" ? "add" : "update", path: String(input.file_path ?? input.notebook_path ?? "") }] })
          } else {
            entries.push({ kind: "tool", name, detail: String(input.file_path ?? input.pattern ?? input.path ?? JSON.stringify(input)) })
          }
        }
      }
    } else if (line.type === "user") {
      for (const block of blocks) {
        const command = block.type === "tool_result" && block.tool_use_id ? pendingCommands.get(block.tool_use_id) : undefined
        if (!command) continue
        command.output = toolResultText(block.content)
        command.exitCode = block.is_error ? 1 : 0
      }
    } else if (line.type === "result" || "result" in line) {
      entries.push({ kind: "meta", stats: { turns: line.num_turns, tokens: claudeTokens(line.usage), cost: line.total_cost_usd, duration: line.duration_ms, error: line.is_error } })
      const text = String(line.result ?? "")
      if (line.is_error) entries.push({ kind: "error", text: errorText(line, text) })
      else if (text.trim() && text !== lastMessage) entries.push({ kind: "message", text })
    }
  }
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
