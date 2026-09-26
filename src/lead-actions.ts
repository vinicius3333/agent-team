import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isSeq, parseDocument } from "yaml"
import { leadAccessModes, leadActionKinds, loadConfig, planningPhases, type LeadConfig, type PlanningPhase, type SprintConfig } from "./config.ts"
import { commitPaths, fileAtRef } from "./git.ts"
import { commitAndRebase, createWorkspace, fastForward, removeWorkspace } from "./harness/workspace.ts"
import { approvePhase, ProjectError, raiseRunBudget, requestChanges, retryTask } from "./project.ts"
import type { LeadAction, Store, TaskChanges, TaskDraft } from "./store.ts"
import { suggestedPaths } from "./replan.ts"
import { orderTasks, validateTasks, widenTask, type Task } from "./tasks.ts"

// Applies a lead action on the server, so auto-apply and the dashboard button share one path.
// Returns whether the action wants the run started when it is idle.
export function applyLeadAction(projectDir: string, store: Store, action: LeadAction): { startRun: boolean; note: string } {
  switch (action.kind) {
    case "retry":
      retryTask(store, action.taskId)
      return { startRun: true, note: `${action.taskId} reset for retry` }
    case "resume":
      return { startRun: true, note: "run resumed" }
    case "approve":
      approvePhase(projectDir, store, action.phase)
      return { startRun: true, note: `${action.phase} approved` }
    case "request_changes":
      requestChanges(projectDir, store, action.phase, action.message)
      return { startRun: true, note: `${action.phase} sent back` }
    case "raise_budget": {
      const runUsd = raiseRunBudget(projectDir, store)
      return { startRun: true, note: `budget raised to $${runUsd.toFixed(2)}` }
    }
    case "add_task": {
      const id = addTask(projectDir, store, action.task)
      return { startRun: true, note: `${id} added` }
    }
    case "edit_task":
      editTask(projectDir, store, action.taskId, action.changes)
      return { startRun: true, note: `${action.taskId} changed` }
  }
}

function tasksPath(projectDir: string): string {
  return join(projectDir, "tasks.json")
}

// During an open change, main keeps the tasks from before it and the change branch holds the live ones,
// so lead edits read and land there.
function readTasks(projectDir: string, store: Store): Task[] {
  const change = store.currentChange()
  try {
    const text = change ? fileAtRef(projectDir, change.branch, "tasks.json") : readFileSync(tasksPath(projectDir), "utf8")
    return JSON.parse(text ?? "") as Task[]
  } catch {
    throw new ProjectError(409, "tasks.json is missing or not valid JSON. Wait until the plan phase is done.")
  }
}

// Validates before writing, so a bad draft never lands; a running build reloads tasks.json when it changes.
function writeTasks(projectDir: string, store: Store, tasks: Task[], message: string): void {
  try {
    orderTasks(validateTasks(tasks))
  } catch (error) {
    throw new ProjectError(400, (error as Error).message)
  }
  const text = `${JSON.stringify(tasks, null, 2)}\n`
  const change = store.currentChange()
  if (!change) {
    writeFileSync(tasksPath(projectDir), text)
    commitPaths(projectDir, ["tasks.json"], message)
    return
  }
  const workspace = createWorkspace(projectDir, `lead-${change.id}`, change.branch)
  try {
    writeFileSync(join(workspace.path, "tasks.json"), text)
    commitAndRebase(workspace, message)
    fastForward(projectDir, workspace.branch, change.branch)
  } finally {
    removeWorkspace(projectDir, workspace)
  }
}

// Lead tasks get L-prefixed ids so they are easy to tell apart from planned (T) and QA (Q) tasks.
export function nextLeadTaskId(tasks: Task[]): string {
  const numbers = tasks.map((task) => /^L(\d+)$/.exec(task.id)?.[1]).filter(Boolean).map(Number)
  return `L${String(Math.max(0, ...numbers) + 1).padStart(3, "0")}`
}

export function addTask(projectDir: string, store: Store, draft: TaskDraft): string {
  const tasks = readTasks(projectDir, store)
  const id = nextLeadTaskId(tasks)
  const change = store.currentChange()
  const verify = draft.verify.trim() || tasks.at(-1)?.verify || ""
  const task: Task = {
    id,
    title: draft.title,
    story: draft.story,
    phase: "feature",
    dependsOn: draft.dependsOn.filter((dependency) => tasks.some((existing) => existing.id === dependency)),
    allowedPaths: draft.allowedPaths,
    readPaths: draft.readPaths,
    acceptance: draft.acceptance,
    verify,
    ...(draft.ui ? { ui: true } : {}),
    ...(change ? { change: change.id } : {}),
  }
  writeTasks(projectDir, store, [...tasks, task], `chore(plan): add ${id} from the project lead`)
  store.log("task", `${id} added by the project lead: ${draft.title}`)
  return id
}

export function editTask(projectDir: string, store: Store, taskId: string, changes: TaskChanges): void {
  const tasks = readTasks(projectDir, store)
  const index = tasks.findIndex((task) => task.id === taskId)
  if (index === -1) throw new ProjectError(404, `unknown task "${taskId}"`)
  const status = store.task(taskId)?.status ?? "pending"
  if (status === "merged") throw new ProjectError(409, `${taskId} is already merged. Add a new task instead.`)
  if (status === "running") throw new ProjectError(409, `${taskId} is running. Change it after the attempt ends.`)
  tasks[index] = { ...tasks[index], ...changes }
  writeTasks(projectDir, store, tasks, `chore(plan): change ${taskId} from the project lead`)
  if (status === "blocked") store.resetTask(taskId)
  store.log("task", `${taskId} changed by the project lead: ${Object.keys(changes).join(", ")}`)
}

// Approves the scope a blocked task asked for: adds the files to allowedPaths, makes the task wait for any
// unmerged task that owns one of them (so the two never run at once), and resets it for a retry.
export function approveTaskSuggestion(projectDir: string, store: Store, taskId: string): string[] {
  const row = store.task(taskId)
  if (row?.status !== "blocked" || !row.humanReason) throw new ProjectError(409, `${taskId} is not waiting for a decision.`)
  const paths = suggestedPaths(row.humanReason)
  if (!paths.length) throw new ProjectError(409, `${taskId} has no suggested files. Edit tasks.json, then retry it.`)
  const current = readTasks(projectDir, store)
  if (!current.some((entry) => entry.id === taskId)) throw new ProjectError(404, `unknown task "${taskId}"`)
  const { tasks, owners } = widenTask(current, taskId, paths, (id) => store.task(id)?.status === "merged")
  writeTasks(projectDir, store, tasks, `chore(plan): widen ${taskId} as approved`)
  store.resetTask(taskId)
  store.log("task", `${taskId}: scope approved (${paths.join(", ")})${owners.length ? `; it now waits for ${owners.join(", ")}` : ""}`)
  return paths
}

// Drops a task that waits for a decision. A task other tasks depend on stays, because removing it would strand them.
export function dropTask(projectDir: string, store: Store, taskId: string): void {
  const row = store.task(taskId)
  if (row?.status === "merged") throw new ProjectError(409, `${taskId} is already merged.`)
  if (row?.status === "running") throw new ProjectError(409, `${taskId} is running. Drop it after the attempt ends.`)
  const tasks = readTasks(projectDir, store)
  if (!tasks.some((entry) => entry.id === taskId)) throw new ProjectError(404, `unknown task "${taskId}"`)
  const dependents = tasks.filter((entry) => entry.dependsOn.includes(taskId)).map((entry) => entry.id)
  if (dependents.length) throw new ProjectError(409, `${dependents.join(", ")} ${dependents.length === 1 ? "depends" : "depend"} on ${taskId}. Drop or change ${dependents.length === 1 ? "it" : "them"} first.`)
  writeTasks(projectDir, store, tasks.filter((entry) => entry.id !== taskId), `chore(plan): drop ${taskId} by request`)
  store.removeTask(taskId)
  store.log("task", `${taskId} dropped by request`)
}

// The dashboard's switch for autonomy.autoApproveScope; a running build reads it at its next decision.
export function savePipelineSetting(projectDir: string, key: string[], value: unknown, message: string, replaces: string[][] = []): void {
  const path = join(projectDir, "pipeline.yaml")
  const original = readFileSync(path, "utf8")
  const document = parseDocument(original)
  const node = document.createNode(value)
  if (isSeq(node)) node.flow = true
  document.setIn(key, node)
  for (const legacy of replaces) document.deleteIn(legacy)
  writeFileSync(path, document.toString())
  try {
    loadConfig(path)
  } catch (error) {
    writeFileSync(path, original)
    throw new ProjectError(400, (error as Error).message)
  }
  commitPaths(projectDir, ["pipeline.yaml"], message)
}

function saveAutonomySetting(projectDir: string, key: string, value: unknown, message: string): void {
  savePipelineSetting(projectDir, ["autonomy", key], value, message)
}

export function saveAutoApproveScope(projectDir: string, enabled: boolean): void {
  saveAutonomySetting(projectDir, "autoApproveScope", enabled, `chore: ${enabled ? "approve" : "stop approving"} scope requests automatically`)
}

// A phase already waiting for approval keeps waiting: removing its gate only affects phases that have not finished yet.
export function saveGates(projectDir: string, gates: PlanningPhase[]): void {
  const ordered = planningPhases.filter((phase) => gates.includes(phase))
  saveAutonomySetting(projectDir, "gates", ordered, `chore: set approval gates to ${ordered.join(", ") || "none"}`)
}

export function parseGates(value: unknown): PlanningPhase[] {
  if (!Array.isArray(value) || !value.every((gate) => (planningPhases as readonly unknown[]).includes(gate))) {
    throw new ProjectError(400, `Each gate must be one of ${planningPhases.join(", ")}.`)
  }
  return value as PlanningPhase[]
}

// The doctor reads sprints on every tick, so a new interval moves the next due time at once. The whole block is
// written, and a legacy evolve block goes away because sprints would override it anyway.
export function saveSprintSettings(projectDir: string, settings: SprintConfig): void {
  savePipelineSetting(projectDir, ["sprints"], settings, `chore: run sprints ${settings.enabled ? `every ${settings.everyDays} days` : "no more"}`, [["evolve"]])
}

export function parseSprintSettings(value: unknown): SprintConfig {
  const raw = (value ?? {}) as Record<string, unknown>
  const flag = (field: string) => {
    if (typeof raw[field] !== "boolean") throw new ProjectError(400, `${field} must be true or false.`)
    return raw[field] as boolean
  }
  const number = (field: string) => {
    if (typeof raw[field] !== "number" || !Number.isFinite(raw[field])) throw new ProjectError(400, `${field} must be a number.`)
    return raw[field] as number
  }
  return { enabled: flag("enabled"), everyDays: number("everyDays"), budgetUsd: number("budgetUsd"), monthlyUsd: number("monthlyUsd"), maxItems: number("maxItems"), newFeatures: flag("newFeatures") }
}

export function parseLeadSettings(value: unknown): LeadConfig {
  const raw = (value ?? {}) as Record<string, unknown>
  const kinds = (field: string) => {
    const list = raw[field]
    if (!Array.isArray(list) || !list.every((kind) => (leadActionKinds as readonly unknown[]).includes(kind))) {
      throw new ProjectError(400, `${field} must list only ${leadActionKinds.join(", ")}.`)
    }
    return [...new Set(list)] as LeadConfig["actions"]
  }
  const actions = kinds("actions")
  const autoApply = kinds("autoApply")
  if (autoApply.some((kind) => !actions.includes(kind))) throw new ProjectError(400, "Auto-apply may only list actions the lead may suggest.")
  const chatBudgetUsd = raw.chatBudgetUsd
  if (typeof chatBudgetUsd !== "number" || !(chatBudgetUsd > 0 && chatBudgetUsd <= 20)) throw new ProjectError(400, "The chat budget must be above $0 and at most $20.")
  // An older client sends no access, so the save keeps the current value.
  if (raw.access === undefined) return { actions, autoApply, chatBudgetUsd }
  if (!(leadAccessModes as readonly unknown[]).includes(raw.access)) throw new ProjectError(400, `access must be ${leadAccessModes.join(" or ")}.`)
  return { actions, autoApply, chatBudgetUsd, access: raw.access as LeadConfig["access"] }
}

export function saveLeadSettings(projectDir: string, settings: LeadConfig): void {
  const path = join(projectDir, "pipeline.yaml")
  const original = readFileSync(path, "utf8")
  const document = parseDocument(original)
  // Sets each managed key on its own, so lead keys the form does not know, and their comments, stay.
  const values: [string, unknown][] = [["actions", settings.actions], ["autoApply", settings.autoApply], ["chatBudgetUsd", settings.chatBudgetUsd]]
  if (settings.access !== undefined) values.push(["access", settings.access])
  for (const [key, value] of values) document.setIn(["lead", key], value)
  writeFileSync(path, document.toString())
  try {
    loadConfig(path)
  } catch (error) {
    writeFileSync(path, original)
    throw new ProjectError(400, (error as Error).message)
  }
  commitPaths(projectDir, ["pipeline.yaml"], "chore: change project lead permissions")
}
