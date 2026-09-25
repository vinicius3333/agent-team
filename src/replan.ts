import { matchesPath } from "./glob.ts"
import { extractJsonObject } from "./json.ts"
import { orderTasks, validateTasks, type Task } from "./tasks.ts"

// Workers start their final message with this when the task cannot be done within its scope.
export const blockedPrefix = "BLOCKED:"

export const blockKinds = ["scope", "dependency", "spec"] as const
export type BlockKind = (typeof blockKinds)[number]

export interface Block {
  kind: BlockKind
  needPaths: string[]
  reason: string
}

export type ReplanAction =
  | { action: "rebind"; allowedPaths: string[] }
  | { action: "prereq"; task: Task }
  | { action: "split"; tasks: Task[] }
  | { action: "escalate"; reason: string }

export type ReplanDecision = { kind: "apply"; tasks: Task[]; summary: string } | { kind: "human"; reason: string }

// The planner's convention (prompts/planner.md rule 3): these files belong to foundation tasks only.
export const sharedFoundationPatterns = [
  "package.json",
  "**/package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "src/main.*",
  "src/index.*",
  "src/App.*",
  "src/app.*",
  "src/server.*",
  "src/router.*",
  "src/routes.*",
  "src/routes/index.*",
  "app/layout.*",
  "**/migrations/index.*",
]

// Planning-phase outputs: no worker task may own them.
const protectedPrefixes = ["docs/", "contracts/", "design/", "AGENTS.md", "CLAUDE.md"]

// Accepts `BLOCKED: {"kind":...}` and the older free-text `BLOCKED: reason` (read as kind "spec").
// The line may come after other text: workers often explain first, and a missed block wasted a doctor call.
export function parseBlock(summary: string): Block | null {
  const start = summary.search(new RegExp(`^[ \\t>*_]*${blockedPrefix}`, "m"))
  if (start === -1) return null
  const text = summary.slice(start).replace(/^[ \t>*_]*/, "")
  // Workers sometimes name the kind before the JSON ("BLOCKED: spec: {...}"); the JSON's own kind wins.
  const rest = text.slice(blockedPrefix.length).replace(/^[*_]+/, "").trim().replace(/^(?:scope|dependency|spec)\s*:\s*(?=\{)/i, "")
  if (rest.startsWith("{") || rest.includes("```json")) {
    try {
      const parsed = extractJsonObject(rest) as any
      if (blockKinds.includes(parsed?.kind)) {
        return {
          kind: parsed.kind,
          needPaths: Array.isArray(parsed.needPaths) ? parsed.needPaths.filter((path: unknown) => typeof path === "string") : [],
          reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : rest,
        }
      }
    } catch {}
  }
  return { kind: "spec", needPaths: [], reason: rest || "no reason given" }
}

// The files a human-decision reason asks for: the "(needs a, b)" that formatBlock writes, or the needPaths of a
// BLOCKED line quoted in the reason. The dashboard offers them as a one-click scope change.
// The strings of the first "needPaths": [...] array, read with a small scanner so "]" inside a quoted path
// (src/app/[id]/route.ts) does not end the array.
function quotedNeedPaths(text: string): string[] {
  const start = /"needPaths"\s*:\s*\[/.exec(text)
  if (!start) return []
  const paths: string[] = []
  let index = start.index + start[0].length
  while (index < text.length) {
    const character = text[index]
    if (character === "]") break
    if (character !== '"') {
      index += 1
      continue
    }
    let value = ""
    index += 1
    while (index < text.length && text[index] !== '"') {
      if (text[index] === "\\" && index + 1 < text.length) index += 1
      value += text[index]
      index += 1
    }
    paths.push(value)
    index += 1
  }
  return paths
}

export function suggestedPaths(reason: string): string[] {
  const listed = /\(needs ([^)]+)\)/.exec(reason)?.[1]
  // needPaths is read straight from the text: a worker summary can hold a ```json commit plan that a JSON
  // extractor would pick instead of the BLOCKED object.
  const quoted = quotedNeedPaths(reason)
  const paths = listed ? listed.split(",").map((path) => path.trim()) : quoted.length ? quoted : (parseBlock(reason)?.needPaths ?? [])
  return [...new Set(paths.map((path) => path.replace(/\\([[\]])/g, "$1")).filter(Boolean))]
}

export function formatBlock(block: Block): string {
  const paths = block.needPaths.length ? ` (needs ${block.needPaths.join(", ")})` : ""
  return `${blockedPrefix} ${block.kind}${paths}: ${block.reason}`
}

export function parseReplanAction(text: string): ReplanAction {
  const parsed = extractJsonObject(text) as any
  switch (parsed?.action) {
    case "rebind":
      if (!isStringList(parsed.allowedPaths) || parsed.allowedPaths.length === 0) throw new Error("rebind needs a non-empty allowedPaths array of strings")
      return { action: "rebind", allowedPaths: parsed.allowedPaths }
    case "prereq":
      if (typeof parsed.task !== "object" || parsed.task === null || Array.isArray(parsed.task)) throw new Error("prereq needs a task object")
      return { action: "prereq", task: parsed.task }
    case "split":
      if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 2) throw new Error("split needs a tasks array with at least two tasks")
      return { action: "split", tasks: parsed.tasks }
    case "escalate":
      if (typeof parsed.reason !== "string" || !parsed.reason.trim()) throw new Error("escalate needs a reason")
      return { action: "escalate", reason: parsed.reason.trim() }
    default:
      throw new Error('action must be "rebind", "prereq", "split", or "escalate"')
  }
}

// Turns the replanner's action into the new tasks.json content, or says why a human must decide.
// Throws when the action is malformed, so the replanner can be asked again.
// Tasks in mergedIds are finished, so their files are free for the replanned work to change.
export function decideReplan(tasks: Task[], taskId: string, action: ReplanAction, mergedIds: ReadonlySet<string> = new Set()): ReplanDecision {
  const blocked = tasks.find((task) => task.id === taskId)
  if (!blocked) throw new Error(`unknown task ${taskId}`)
  const existingIds = new Set(tasks.map((task) => task.id))

  switch (action.action) {
    case "escalate":
      return { kind: "human", reason: `the replanner escalated: ${action.reason}` }
    case "rebind": {
      const added = action.allowedPaths.filter((path) => !blocked.allowedPaths.includes(path))
      const conflict = scopeConflict(added, tasks, [taskId, ...mergedIds])
      if (conflict) return { kind: "human", reason: `the replanner wants to widen ${taskId} to ${added.join(", ")}, but ${conflict}` }
      const allowedPaths = [...new Set([...blocked.allowedPaths, ...action.allowedPaths])]
      return apply(
        tasks.map((task) => (task.id === taskId ? { ...task, allowedPaths } : task)),
        `widened ${taskId} allowedPaths with ${added.join(", ") || "nothing new"}`,
      )
    }
    case "prereq": {
      const prereq = action.task
      if (existingIds.has(prereq.id)) throw new Error(`prereq id ${prereq.id} already exists`)
      const conflict = scopeConflict(newPaths(prereq, blocked), tasks, [taskId, ...mergedIds])
      if (conflict) return { kind: "human", reason: `the replanner wants a prerequisite task ${prereq.id} for ${taskId}, but ${conflict}` }
      const index = tasks.findIndex((task) => task.id === taskId)
      const updated = tasks.map((task) => (task.id === taskId ? { ...task, dependsOn: [...task.dependsOn, prereq.id] } : task))
      updated.splice(index, 0, prereq)
      return apply(updated, `added prerequisite ${prereq.id} "${prereq.title}" before ${taskId}`)
    }
    case "split": {
      const reused = action.tasks.filter((task) => existingIds.has(task?.id))
      if (reused.length) throw new Error(`split task ids must be new: ${reused.map((task) => task.id).join(", ")}`)
      for (const part of action.tasks) {
        const conflict = scopeConflict(newPaths(part, blocked), tasks, [taskId, ...mergedIds])
        if (conflict) return { kind: "human", reason: `the replanner wants to split ${taskId}, but ${conflict}` }
      }
      const partIds = action.tasks.map((task) => task.id)
      const index = tasks.findIndex((task) => task.id === taskId)
      const updated = tasks
        .filter((task) => task.id !== taskId)
        .map((task) => (task.dependsOn.includes(taskId) ? { ...task, dependsOn: [...new Set(task.dependsOn.flatMap((id) => (id === taskId ? partIds : [id])))] } : task))
      updated.splice(index, 0, ...action.tasks)
      return apply(updated, `split ${taskId} into ${partIds.join(", ")}`)
    }
  }
}

function apply(tasks: Task[], summary: string): ReplanDecision {
  orderTasks(validateTasks(tasks))
  return { kind: "apply", tasks, summary }
}

function newPaths(task: Task, blocked: Task): string[] {
  if (!isStringList(task?.allowedPaths)) return []
  return task.allowedPaths.filter((path) => !blocked.allowedPaths.includes(path))
}

// Paths owned by the blocked task or a merged task are fine; anything else an active task owns, a shared foundation file,
// or a planning output needs a human.
export function scopeConflict(paths: string[], tasks: Task[], exceptIds: string[]): string | null {
  for (const path of paths) {
    if (protectedPrefixes.some((prefix) => path.startsWith(prefix))) return `${path} is a planning document that workers may not edit`
    const foundation = sharedFoundationPatterns.find((pattern) => globsOverlap(path, pattern))
    if (foundation) return `${path} is a shared foundation file (${foundation})`
    const owner = tasks.find((task) => !exceptIds.includes(task.id) && task.allowedPaths.some((owned) => globsOverlap(path, owned)))
    if (owner) return `${path} is owned by ${owner.id}`
  }
  return null
}

function globsOverlap(first: string, second: string): boolean {
  return first === second || matchesPath(first, second) || matchesPath(second, first)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

// Two failures count as the same when they differ only in timestamps, durations, or temp paths.
export function normalizeFailure(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min)\b/g, "<duration>")
    .replace(/(?:\/private)?\/tmp\/[^\s:'"`)\]]*/g, "<tmp>")
    .replace(/\s+/g, " ")
    .trim()
}

// A change task may take over files that merged tasks owned. Planning outputs stay off limits, shared foundation
// files need a foundation task, and files of a task that is not merged yet stay with that task.
export function changeTaskConflict(task: Task, tasks: Task[], mergedIds: ReadonlySet<string>): string | null {
  const open = tasks.filter((entry) => entry.id !== task.id && !mergedIds.has(entry.id))
  const paths = task.phase === "foundation" ? task.allowedPaths.filter((path) => !sharedFoundationPatterns.some((pattern) => globsOverlap(path, pattern))) : task.allowedPaths
  return scopeConflict(paths, open, [])
}
