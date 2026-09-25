import { readFileSync } from "node:fs"
import { matchesPath } from "./glob.ts"

export interface Task {
  id: string
  title: string
  story?: string
  phase: "foundation" | "feature"
  dependsOn: string[]
  allowedPaths: string[]
  readPaths: string[]
  acceptance: string[]
  verify: string
  // Set by the planner when the task changes UI code; the orchestrator then loads `routes` in a browser after verify.
  ui?: boolean
  routes?: string[]
  // The change request (C001, ...) that added the task; unset for the first build.
  change?: string
  // Files the orchestrator copies into the worktree before the worker starts, for example a generated illustration
  // from design/illustrations/ into public/. Workers cannot copy them: their permissions only cover allowedPaths.
  copy?: TaskCopy[]
  // Illustrations the orchestrator has the illustrator (image generation) draw before the worker starts, when the
  // file is not in the repo yet. They land with the task, so QA and the evaluator can ask for new art on a live app.
  illustrations?: TaskIllustration[]
}

export interface TaskIllustration {
  // design/illustrations/<name>.png
  to: string
  prompt: string
  // A repo image the illustrator attaches as the style reference, usually a branding screen.
  reference?: string
}

export const illustrationTargetPattern = /^design\/illustrations\/[a-z0-9][a-z0-9-]*\.png$/

export interface TaskCopy {
  from: string
  to: string
}

export const changeIdPattern = /^C\d{3,}$/

const staticRoutePattern = /^\/[A-Za-z0-9\-._~/?=&%]*$/

// sharedPaths are the stack template's foundation-only files; a feature task may not touch them.
export function loadTasks(path: string, sharedPaths: string[] = []): Task[] {
  return parseTasks(readFileSync(path, "utf8"), sharedPaths)
}

export function parseTasks(text: string, sharedPaths: string[] = []): Task[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`tasks.json is not valid JSON: ${(error as Error).message}`)
  }
  return orderTasks(validateTasks(parsed, sharedPaths))
}

// QA fix ids (Q101) have their own prefix, so only T ids set the next number.
export function nextTaskId(tasks: Pick<Task, "id">[]): string {
  const highest = Math.max(0, ...tasks.map((task) => Number(/^T(\d+)/.exec(task.id)?.[1] ?? 0)))
  return `T${String(highest + 1).padStart(3, "0")}`
}

export function validateTasks(value: unknown, sharedPaths: string[] = []): Task[] {
  // An imported project starts with no tasks; the plan phase requires at least one on its own.
  if (!Array.isArray(value)) throw new Error("tasks.json must be an array")
  const errors: string[] = []
  const ids = new Set<string>()
  for (const [index, task] of value.entries()) {
    const label = task?.id ?? `#${index}`
    if (typeof task?.id !== "string") errors.push(`${label}: id must be a string`)
    else if (ids.has(task.id)) errors.push(`${label}: duplicate id`)
    else ids.add(task.id)
    if (typeof task?.title !== "string") errors.push(`${label}: title must be a string`)
    if (task?.phase !== "foundation" && task?.phase !== "feature") errors.push(`${label}: phase must be foundation or feature`)
    if (typeof task?.verify !== "string" || !task.verify.trim()) errors.push(`${label}: verify command is required`)
    for (const field of ["dependsOn", "allowedPaths", "readPaths", "acceptance"]) {
      if (!Array.isArray(task?.[field])) errors.push(`${label}: ${field} must be an array`)
    }
    if (Array.isArray(task?.allowedPaths) && task.allowedPaths.length === 0) errors.push(`${label}: allowedPaths is empty`)
    if (Array.isArray(task?.acceptance) && task.acceptance.length === 0) errors.push(`${label}: acceptance is empty`)
    if (task?.phase === "feature" && Array.isArray(task?.allowedPaths)) {
      const patterns = task.allowedPaths.filter((pattern: unknown) => typeof pattern === "string")
      for (const shared of sharedPaths.filter((path) => patterns.some((pattern: string) => pattern === path || matchesPath(path, pattern)))) {
        errors.push(`${label}: feature tasks may not touch the shared file ${shared}; give it to a foundation task`)
      }
    }
    if (task?.change !== undefined && (typeof task.change !== "string" || !changeIdPattern.test(task.change))) errors.push(`${label}: change must be a change id like C001`)
    if (task?.ui !== undefined && typeof task.ui !== "boolean") errors.push(`${label}: ui must be true or false`)
    if (task?.illustrations !== undefined) {
      const entries = Array.isArray(task.illustrations) ? task.illustrations : null
      if (!entries || !entries.every((entry: any) => typeof entry?.to === "string" && illustrationTargetPattern.test(entry.to) && typeof entry?.prompt === "string" && entry.prompt.trim().length >= 40 && (entry.reference === undefined || (typeof entry.reference === "string" && safeRelativePath(entry.reference))))) {
        errors.push(`${label}: illustrations must be an array of { to: "design/illustrations/<name>.png", prompt: a full image prompt, reference?: a repo image path }`)
      }
    }
    if (task?.copy !== undefined) {
      const entries = Array.isArray(task.copy) ? task.copy : null
      if (!entries || !entries.every((entry: any) => typeof entry?.from === "string" && typeof entry?.to === "string" && safeRelativePath(entry.from) && safeRelativePath(entry.to))) {
        errors.push(`${label}: copy must be an array of { from, to } relative paths inside the repo`)
      } else {
        const patterns = Array.isArray(task.allowedPaths) ? task.allowedPaths : []
        for (const entry of entries) {
          if (filesOutsideScope([entry.to], patterns).length) errors.push(`${label}: copy target ${entry.to} must be inside allowedPaths`)
        }
      }
    }
    if (task?.routes !== undefined && (!Array.isArray(task.routes) || !task.routes.every((route: unknown) => typeof route === "string" && staticRoutePattern.test(route)))) {
      errors.push(`${label}: routes must be an array of paths that start with /, without parameters`)
    }
  }
  for (const task of value) {
    for (const dependency of task?.dependsOn ?? []) {
      if (!ids.has(dependency)) errors.push(`${task.id}: depends on unknown task ${dependency}`)
    }
  }
  if (errors.length) throw new Error(`Invalid tasks.json:\n- ${errors.join("\n- ")}`)
  return value as Task[]
}

// Topological order; foundation tasks come before feature tasks whenever dependencies allow.
export function orderTasks(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const ordered: Task[] = []
  const done = new Set<string>()
  const remaining = [...tasks].sort((a, b) => Number(a.phase === "feature") - Number(b.phase === "feature"))
  while (remaining.length) {
    const nextIndex = remaining.findIndex((task) => task.dependsOn.every((dependency) => done.has(dependency)))
    if (nextIndex === -1) {
      throw new Error(`tasks.json has a dependency cycle among: ${remaining.map((task) => task.id).join(", ")}`)
    }
    const [next] = remaining.splice(nextIndex, 1)
    ordered.push(next)
    done.add(next.id)
  }
  if (ordered.length !== byId.size) throw new Error("tasks.json ordering lost tasks")
  return ordered
}

// Adds paths to a task's scope and makes it wait for every unfinished task that already owns one of them, so the
// two never run at once. Shared by the dashboard's Approve button and autonomy.autoApproveScope.
export function widenTask(tasks: Task[], taskId: string, paths: string[], isFinished: (id: string) => boolean): { tasks: Task[]; owners: string[] } {
  const index = tasks.findIndex((entry) => entry.id === taskId)
  if (index === -1) throw new Error(`unknown task "${taskId}"`)
  const task = tasks[index]
  const owners = tasks.filter((other) => other.id !== taskId && !isFinished(other.id) && pathsOverlap(other.allowedPaths, paths)).map((other) => other.id)
  const widened = { ...task, allowedPaths: [...new Set([...task.allowedPaths, ...paths])], dependsOn: [...new Set([...task.dependsOn, ...owners])] }
  return { tasks: tasks.map((entry, position) => (position === index ? widened : entry)), owners }
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..")
}

export function filesOutsideScope(files: string[], allowedPaths: string[]): string[] {
  return files.filter((file) => !allowedPaths.some((pattern) => file === pattern || matchesPath(file, pattern)))
}

// Conservative: two patterns overlap when the literal part before the first wildcard of one is a prefix of the other's.
export function pathsOverlap(first: string[], second: string[]): boolean {
  const literalPrefix = (pattern: string) => pattern.split(/[*?[{]/, 1)[0]
  return first.some((a) =>
    second.some((b) => {
      const [prefixA, prefixB] = [literalPrefix(a), literalPrefix(b)]
      if (prefixA === a && prefixB === b) return a === b
      if (prefixA === a) return a.startsWith(prefixB)
      if (prefixB === b) return b.startsWith(prefixA)
      return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)
    }),
  )
}
