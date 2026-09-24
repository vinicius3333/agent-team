import { readFileSync } from "node:fs"
import { matchesGlob } from "node:path"

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
}

const staticRoutePattern = /^\/[A-Za-z0-9\-._~/?=&%]*$/

// sharedPaths are the stack template's foundation-only files; a feature task may not touch them.
export function loadTasks(path: string, sharedPaths: string[] = []): Task[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`tasks.json is not valid JSON: ${(error as Error).message}`)
  }
  const tasks = validateTasks(parsed, sharedPaths)
  return orderTasks(tasks)
}

export function validateTasks(value: unknown, sharedPaths: string[] = []): Task[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("tasks.json must be a non-empty array")
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
      for (const shared of sharedPaths.filter((path) => patterns.some((pattern: string) => pattern === path || matchesGlob(path, pattern)))) {
        errors.push(`${label}: feature tasks may not touch the shared file ${shared}; give it to a foundation task`)
      }
    }
    if (task?.ui !== undefined && typeof task.ui !== "boolean") errors.push(`${label}: ui must be true or false`)
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

export function filesOutsideScope(files: string[], allowedPaths: string[]): string[] {
  return files.filter((file) => !allowedPaths.some((pattern) => file === pattern || matchesGlob(file, pattern)))
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
