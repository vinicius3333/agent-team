export type ActivityKind = "command" | "edit" | "read" | "message" | "reasoning" | "tool"

export interface Activity {
  kind: ActivityKind
  text: string
}

const editTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const readTools = new Set(["Read", "Glob", "Grep", "LS"])
const maxTextLength = 240
const maxMessageLength = 2000

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > maxTextLength ? `${line.slice(0, maxTextLength - 1)}…` : line
}

// Agent messages keep their line breaks; they are the agent explaining what it is doing.
function message(kind: "message" | "reasoning", text: string): Activity {
  const trimmed = text.trim()
  return { kind, text: trimmed.length > maxMessageLength ? `${trimmed.slice(0, maxMessageLength - 1)}…` : trimmed }
}

function workspacePath(path: unknown): string {
  return String(path ?? "").replace(/^\/workspace\//, "")
}

function claudeToolActivity(name: string, input: Record<string, unknown>): Activity {
  if (name === "Bash") return { kind: "command", text: short(String(input.command ?? "")) }
  if (editTools.has(name)) return { kind: "edit", text: `${name} ${workspacePath(input.file_path ?? input.notebook_path)}` }
  if (readTools.has(name)) return { kind: "read", text: short(`${name} ${workspacePath(input.file_path ?? input.pattern ?? input.path ?? "")}`) }
  return { kind: "tool", text: short(`${name} ${JSON.stringify(input)}`) }
}

function codexCommand(command: string): string {
  return command.replace(/^\/bin\/(ba)?sh -lc ["']?/, "").replace(/["']$/, "")
}

// Turns Claude stream-json or Codex --json transcript lines into short, readable steps, oldest first.
export function summarizeActivity(transcript: string, limit = 15): Activity[] {
  const steps: Activity[] = []
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("{")) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") steps.push(claudeToolActivity(String(block.name), block.input ?? {}))
        else if (block.type === "text" && block.text?.trim()) steps.push(message("message", block.text))
      }
    } else if (event.type === "item.started" && event.item?.type === "command_execution") {
      steps.push({ kind: "command", text: short(codexCommand(String(event.item.command ?? ""))) })
    } else if (event.type === "item.completed" && event.item?.type === "file_change") {
      for (const change of event.item.changes ?? []) steps.push({ kind: "edit", text: `${change.kind ?? "update"} ${workspacePath(change.path)}` })
    } else if (event.type === "item.completed" && (event.item?.type === "agent_message" || event.item?.type === "reasoning") && event.item.text?.trim()) {
      steps.push(message(event.item.type === "reasoning" ? "reasoning" : "message", event.item.text))
    }
  }
  return steps.slice(-limit)
}
