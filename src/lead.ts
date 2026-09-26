import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { summarizeActivity } from "./activity.ts"
import { leadActionKinds, loadConfig, planningPhases, type LeadAccess, type LeadActionKind } from "./config.ts"
import { readStop } from "./doctor.ts"
import { hostExecutor } from "./harness/executor.ts"
import { extractJsonObject } from "./json.ts"
import { processAlive, withProjectStore } from "./project.ts"
import { getRunner, type RunRequest, type RunResult } from "./runners/index.ts"
import type { ChatMessage, LeadAction, Store, TaskChanges, TaskDraft } from "./store.ts"

export const chatMessageMaxLength = 4000
const historyLimit = 20
const eventLimit = 40
const briefMaxLength = 3000
const maxActions = 3
const maxFollowUps = 3
const followUpMaxLength = 120
const maxFilesRead = 30
const leadTimeoutMs = 10 * 60_000
export const chatUploadsDir = join(".agent-team", "chat-uploads")

export interface LeadReply {
  reply: string
  actions: LeadAction[]
  followUps: string[]
}

export type RunLead = (request: RunRequest, runner: string) => Promise<RunResult>

const runWithConfiguredRunner: RunLead = (request, runner) => getRunner(runner as "claude" | "codex").run(request)

export interface AskLeadOptions {
  projectDir: string
  message: string
  // File names in .agent-team/chat-uploads that the person attached to this message.
  attachments?: string[]
  transcriptPath?: string
  signal?: AbortSignal
  runLead?: RunLead
}

// Returns the id of the lead's reply, so the caller can apply the actions the project allows without a click.
export async function askLead(options: AskLeadOptions): Promise<number> {
  const { projectDir, message, attachments = [] } = options
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const role = config.roles.lead
  const taskPrompt = withProjectStore(projectDir, (store) => {
    store.addChatMessage("human", message, [], { attachments })
    return leadTaskPrompt(projectDir, store, config.budget.runUsd)
  })
  const transcriptPath = options.transcriptPath ?? join(projectDir, ".agent-team", "transcripts", `lead-${Date.now()}.log`)
  const access = config.lead.access ?? "read"
  const template = readFileSync(new URL("../prompts/lead.md", import.meta.url), "utf8")
  const systemPrompt = forAccess(template, access).replace("{{actions}}", actionGuide(config.lead.actions))
  const request: RunRequest = {
    role: "lead",
    model: role.model,
    systemPrompt,
    taskPrompt,
    executor: hostExecutor(projectDir),
    allowedTools: leadTools(access),
    budgetUsd: config.lead.chatBudgetUsd,
    timeoutMs: leadTimeoutMs,
    transcriptPath,
    signal: options.signal,
  }
  let result: RunResult
  try {
    result = await (options.runLead ?? runWithConfiguredRunner)(request, role.runner)
  } catch (error) {
    result = { status: "failed", summary: (error as Error).message, costUsd: null, tokens: null, durationMs: 0, exitCode: null, diagnostics: "" }
  }
  const answer = result.status === "done" ? parseLeadReply(result.summary, config.lead.actions) : failedReply(result)
  const filesRead = readTranscriptFiles(transcriptPath)
  return withProjectStore(projectDir, (store) => {
    store.recordAttempt({
      subject: "lead-chat",
      role: "lead",
      runner: role.runner,
      model: role.model,
      status: result.status,
      failureClass: null,
      costUsd: result.costUsd,
      tokens: result.tokens,
      durationMs: result.durationMs,
      transcriptPath,
    })
    return store.addChatMessage("lead", answer.reply, answer.actions, { followUps: answer.followUps, filesRead })
  })
}

// Full access sets no writablePaths, so edit and write reach any file in the project folder and bash runs any command.
export function leadTools(access: LeadAccess): string[] {
  const readTools = ["read", "web_search", "web_fetch"]
  return access === "full" ? [...readTools, "edit", "write", "bash"] : readTools
}

// prompts/lead.md holds one block per access mode, from <!-- access:read --> or <!-- access:full --> to <!-- /access -->.
// Only the block for the project's mode stays in the prompt.
export function forAccess(template: string, access: LeadAccess): string {
  return template.replace(/<!-- access:(\w+) -->\n([\s\S]*?)<!-- \/access -->\n/g, (_, mode: string, body: string) => (mode === access ? body : ""))
}

function readTranscriptFiles(transcriptPath: string): string[] {
  if (!existsSync(transcriptPath)) return []
  const reads = summarizeActivity(readFileSync(transcriptPath, "utf8"), Number.MAX_SAFE_INTEGER)
    .filter((step) => step.kind === "read")
    .map((step) => step.text)
  return [...new Set(reads)].slice(0, maxFilesRead)
}

function failedReply(result: RunResult): LeadReply {
  if (result.status === "aborted") return { reply: "Stopped before I finished answering.", actions: [], followUps: [] }
  const detail = (result.diagnostics || result.summary).trim().split("\n").at(-1)?.slice(0, 300)
  return { reply: `I could not answer (${result.status}${detail ? `: ${detail}` : ""}). Try again in a moment.`, actions: [], followUps: [] }
}

// A reply without a valid JSON block is still shown, as plain text with no actions and without the broken block.
// Actions the project does not allow are dropped, even when the lead suggests them.
export function parseLeadReply(text: string, allowed: readonly LeadActionKind[] = leadActionKinds): LeadReply {
  let parsed: any
  try {
    parsed = extractJsonObject(text)
  } catch {
    return { reply: text.replace(/```json[\s\S]*$/, "").trim() || "(empty reply)", actions: [], followUps: [] }
  }
  const reply = typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : text.replace(/```json[\s\S]*```\s*$/, "").trim()
  const actions = (Array.isArray(parsed?.actions) ? parsed.actions : [])
    .map(toAction)
    .filter((action: LeadAction | null): action is LeadAction => action !== null && allowed.includes(action.kind))
  const followUps = (Array.isArray(parsed?.followUps) ? parsed.followUps : [])
    .filter((prompt: unknown): prompt is string => typeof prompt === "string" && prompt.trim().length > 0)
    .map((prompt: string) => prompt.trim().slice(0, followUpMaxLength))
    .slice(0, maxFollowUps)
  return { reply: reply || "(empty reply)", actions: actions.slice(0, maxActions), followUps }
}

const taskIdPattern = /^[A-Za-z0-9_-]{1,40}$/

function stringList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string" && item.trim() && item.length <= maxLength)) return null
  return value.map((item: string) => item.trim())
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null
}

function toTaskDraft(raw: any): TaskDraft | null {
  const title = text(raw?.title, 120)
  const allowedPaths = stringList(raw?.allowedPaths, 20, 200)
  const acceptance = stringList(raw?.acceptance, 10, 400)
  if (!title || !allowedPaths?.length || !acceptance?.length) return null
  return {
    title,
    story: text(raw?.story, 2000) ?? "",
    allowedPaths,
    readPaths: stringList(raw?.readPaths ?? [], 20, 200) ?? [],
    acceptance,
    dependsOn: (stringList(raw?.dependsOn ?? [], 20, 40) ?? []).filter((id) => taskIdPattern.test(id)),
    verify: text(raw?.verify, 400) ?? "",
    ui: raw?.ui === true,
  }
}

function toTaskChanges(raw: any): TaskChanges | null {
  const changes: TaskChanges = {}
  const title = text(raw?.title, 120)
  if (title) changes.title = title
  const story = text(raw?.story, 2000)
  if (story) changes.story = story
  const verify = text(raw?.verify, 400)
  if (verify) changes.verify = verify
  for (const field of ["allowedPaths", "readPaths", "acceptance"] as const) {
    if (raw?.[field] === undefined) continue
    const list = stringList(raw[field], 20, 400)
    if (!list || (field !== "readPaths" && !list.length)) return null
    changes[field] = list
  }
  return Object.keys(changes).length ? changes : null
}

function toAction(raw: any): LeadAction | null {
  const reason = typeof raw?.reason === "string" ? raw.reason.slice(0, 300) : ""
  const base = { state: "proposed" as const, reason }
  const phase = planningPhases.includes(raw?.phase) ? (raw.phase as string) : null
  switch (raw?.kind) {
    case "retry":
      return typeof raw.taskId === "string" && taskIdPattern.test(raw.taskId) ? { ...base, kind: "retry", taskId: raw.taskId } : null
    case "resume":
      return { ...base, kind: "resume" }
    case "raise_budget":
      return { ...base, kind: "raise_budget" }
    case "approve":
      return phase ? { ...base, kind: "approve", phase } : null
    case "request_changes":
      return phase && typeof raw.message === "string" && raw.message.trim() ? { ...base, kind: "request_changes", phase, message: raw.message.slice(0, chatMessageMaxLength) } : null
    case "add_task": {
      const task = toTaskDraft(raw.task)
      return task ? { ...base, kind: "add_task", task } : null
    }
    case "edit_task": {
      const changes = toTaskChanges(raw.changes)
      return typeof raw.taskId === "string" && taskIdPattern.test(raw.taskId) && changes ? { ...base, kind: "edit_task", taskId: raw.taskId, changes } : null
    }
    default:
      return null
  }
}

const actionDescriptions: Record<LeadActionKind, string> = {
  retry: '- `{"kind": "retry", "taskId": "T005", "reason": "..."}`: resets a blocked task so it runs again.',
  resume: '- `{"kind": "resume", "reason": "..."}`: starts the run again when it stopped.',
  approve: '- `{"kind": "approve", "phase": "spec", "reason": "..."}`: approves a phase that waits at a gate.',
  request_changes: '- `{"kind": "request_changes", "phase": "spec", "message": "...", "reason": "..."}`: sends a phase back to its agent with these notes.',
  raise_budget: '- `{"kind": "raise_budget", "reason": "..."}`: adds 50% to the run budget. A live run uses it before its next agent call; a stopped run resumes.',
  add_task: [
    '- `{"kind": "add_task", "task": {"title": "...", "story": "...", "allowedPaths": ["src/x/**"], "readPaths": [], "acceptance": ["..."], "dependsOn": ["T004"], "verify": "npm test", "ui": false}, "reason": "..."}`:',
    "  adds a task to tasks.json. A worker builds it in its own worktree and a reviewer checks it, like any planned task.",
    "  Use it for any change the person asks for in the code. Keep allowedPaths narrow and copy the verify command other tasks use.",
  ].join("\n"),
  edit_task: [
    '- `{"kind": "edit_task", "taskId": "T012", "changes": {"acceptance": ["..."]}, "reason": "..."}`: changes a pending or blocked task.',
    "  `changes` may hold title, story, allowedPaths, readPaths, acceptance, and verify. Merged and running tasks cannot change.",
  ].join("\n"),
}

function actionGuide(allowed: readonly LeadActionKind[]): string {
  if (!allowed.length) return "This project allows no actions. Leave `actions` empty and tell the person what to do instead."
  return allowed.map((kind) => actionDescriptions[kind]).join("\n")
}

export function leadTaskPrompt(projectDir: string, store: Store, runBudgetUsd: number): string {
  const brief = existsSync(join(projectDir, "input.md")) ? readFileSync(join(projectDir, "input.md"), "utf8").slice(0, briefMaxLength) : "(no brief)"
  const phases = new Map(store.phases().map((phase) => [phase.name, phase.status]))
  const phaseLines = [...planningPhases, "qa", "deploy"].map((phase) => `- ${phase}: ${phases.get(phase) ?? "pending"}`)
  const taskLines = store.tasks().map((task) => {
    const failure = task.lastFailure ? ` - last failure: ${task.lastFailure.split("\n")[0].slice(0, 200)}` : ""
    const human = task.humanReason ? ` - needs a person: ${task.humanReason.slice(0, 200)}` : ""
    return `- ${task.id}: ${task.status}, attempts ${task.attempts}${failure}${human}`
  })
  const stop = readStop(store)
  const spend = store.projectCost()
  const events = store.recentEvents(eventLimit).reverse().map((event) => `- ${event.at} [${event.type}] ${event.message.split("\n")[0].slice(0, 200)}`)
  const history = store.chatMessages(historyLimit)
  return [
    "# Project state",
    "## Brief",
    brief,
    "## Phases",
    ...phaseLines,
    "## Tasks",
    ...(taskLines.length ? taskLines : ["(no tasks yet)"]),
    "## Run",
    `- running: ${processAlive(Number(store.meta("run.pid")))}`,
    `- last stop: ${stop ? JSON.stringify(stop) : "none"}`,
    `- spend: $${spend.usd.toFixed(2)} of $${runBudgetUsd.toFixed(2)}${spend.unreportedCalls ? ` (${spend.unreportedCalls} calls report no cost)` : ""}`,
    "## Recent events (oldest first)",
    ...(events.length ? events : ["(none)"]),
    "# Chat (oldest first; answer the last human message)",
    ...history.map(formatMessage),
  ].join("\n")
}

function formatMessage(message: ChatMessage): string {
  const images = message.details.attachments.map((name) => `- ${join(chatUploadsDir, name)}`)
  const attached = images.length ? `\n\nAttached images (open each one with the Read tool):\n${images.join("\n")}` : ""
  return `### ${message.author === "human" ? "Person" : "You"} (${message.at})\n${message.body}${attached}`
}
