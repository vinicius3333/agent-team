import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, planningPhases } from "./config.ts"
import { readStop } from "./doctor.ts"
import { hostExecutor } from "./harness/executor.ts"
import { extractJsonObject } from "./json.ts"
import { processAlive, withProjectStore } from "./project.ts"
import { getRunner, type RunRequest, type RunResult } from "./runners/index.ts"
import type { ChatMessage, LeadAction, Store } from "./store.ts"

export const chatMessageMaxLength = 4000
const historyLimit = 20
const eventLimit = 40
const briefMaxLength = 3000
const maxActions = 3
const leadTimeoutMs = 10 * 60_000
const leadBudgetUsd = 2

export interface LeadReply {
  reply: string
  actions: LeadAction[]
}

export type RunLead = (request: RunRequest, runner: string) => Promise<RunResult>

const runWithConfiguredRunner: RunLead = (request, runner) => getRunner(runner as "claude" | "codex").run(request)

export async function askLead(options: { projectDir: string; message: string; runLead?: RunLead }): Promise<void> {
  const { projectDir, message } = options
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const role = config.roles.lead
  const taskPrompt = withProjectStore(projectDir, (store) => {
    store.addChatMessage("human", message)
    return leadTaskPrompt(projectDir, store, config.budget.runUsd)
  })
  const transcriptPath = join(projectDir, ".agent-team", "transcripts", `lead-${Date.now()}.log`)
  const request: RunRequest = {
    role: "lead",
    model: role.model,
    systemPrompt: readFileSync(new URL("../prompts/lead.md", import.meta.url), "utf8"),
    taskPrompt,
    executor: hostExecutor(projectDir),
    allowedTools: ["read"],
    budgetUsd: leadBudgetUsd,
    timeoutMs: leadTimeoutMs,
    transcriptPath,
  }
  let result: RunResult
  try {
    result = await (options.runLead ?? runWithConfiguredRunner)(request, role.runner)
  } catch (error) {
    result = { status: "failed", summary: (error as Error).message, costUsd: null, tokens: null, durationMs: 0, exitCode: null, diagnostics: "" }
  }
  const answer = result.status === "done" ? parseLeadReply(result.summary) : failedReply(result)
  withProjectStore(projectDir, (store) => {
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
    store.addChatMessage("lead", answer.reply, answer.actions)
  })
}

function failedReply(result: RunResult): LeadReply {
  const detail = (result.diagnostics || result.summary).trim().split("\n").at(-1)?.slice(0, 300)
  return { reply: `I could not answer (${result.status}${detail ? `: ${detail}` : ""}). Try again in a moment.`, actions: [] }
}

// A reply without a valid JSON block is still shown, as plain text with no actions.
export function parseLeadReply(text: string): LeadReply {
  let parsed: any
  try {
    parsed = extractJsonObject(text)
  } catch {
    return { reply: text.trim() || "(empty reply)", actions: [] }
  }
  const reply = typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : text.replace(/```json[\s\S]*```\s*$/, "").trim()
  const actions = (Array.isArray(parsed?.actions) ? parsed.actions : []).map(toAction).filter((action: LeadAction | null): action is LeadAction => action !== null)
  return { reply: reply || "(empty reply)", actions: actions.slice(0, maxActions) }
}

function toAction(raw: any): LeadAction | null {
  const reason = typeof raw?.reason === "string" ? raw.reason.slice(0, 300) : ""
  const base = { state: "proposed" as const, reason }
  const phase = planningPhases.includes(raw?.phase) ? (raw.phase as string) : null
  switch (raw?.kind) {
    case "retry":
      return typeof raw.taskId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.taskId) ? { ...base, kind: "retry", taskId: raw.taskId } : null
    case "resume":
      return { ...base, kind: "resume" }
    case "raise_budget":
      return { ...base, kind: "raise_budget" }
    case "approve":
      return phase ? { ...base, kind: "approve", phase } : null
    case "request_changes":
      return phase && typeof raw.message === "string" && raw.message.trim() ? { ...base, kind: "request_changes", phase, message: raw.message.slice(0, chatMessageMaxLength) } : null
    default:
      return null
  }
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
  return `### ${message.author === "human" ? "Person" : "You"} (${message.at})\n${message.body}`
}
