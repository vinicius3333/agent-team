import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { insightAgentRoles, insightAgents, loadConfig, type InsightAgent, type PipelineConfig } from "../config.ts"
import { containerLogs, projectSlug } from "../deploy.ts"
import { hostExecutor } from "../harness/executor.ts"
import { listIncidents } from "../incidents.ts"
import { extractJsonObject } from "../json.ts"
import { processAlive, withProjectStore } from "../project.ts"
import { getRunner, type RunRequest, type RunResult } from "../runners/index.ts"
import { findingSeverities, type Finding, type FindingSeverity, type InsightRun, type Store } from "../store.ts"
import { healthSummary, projectLive } from "./health.ts"
import { fetchPosthogData, storePosthogData, type PosthogData } from "./posthog.ts"

export const maxFindingsPerRun = 5
const insightBudgetUsd = 1
const insightTimeoutMs = 10 * 60_000
// A run row still "running" after this long belongs to a process that died.
const staleRunMs = insightTimeoutMs + 5 * 60_000
const hourMs = 60 * 60_000
const logLines = 200
const failedProbeLimit = 20
const briefMaxLength = 6000
const fieldMaxLength = 2000

const prompts: Record<InsightAgent, string> = { monitoring: "monitor", analytics: "analyst", research: "researcher" }
const tools: Record<InsightAgent, string[]> = { monitoring: ["read"], analytics: ["read"], research: ["read", "web_search", "web_fetch"] }

export interface InsightFinding {
  severity: FindingSeverity
  title: string
  evidence: string
  proposal: string
}

export interface InsightReply {
  summary: string
  findings: InsightFinding[]
  // One line per finding that was left out, for the event log.
  dropped: string[]
}

export interface InsightOutcome {
  status: "done" | "failed"
  summary: string
  findings: Finding[]
}

export type RunInsight = (request: RunRequest, runner: string) => Promise<RunResult>

const runWithConfiguredRunner: RunInsight = (request, runner) => getRunner(runner as "claude" | "codex").run(request)

export function parseInsightReply(text: string): InsightReply {
  const parsed = extractJsonObject(text) as any
  if (typeof parsed?.summary !== "string" || !parsed.summary.trim()) throw new Error("the reply has no summary")
  const findings: InsightFinding[] = []
  const dropped: string[] = []
  for (const [index, raw] of (Array.isArray(parsed.findings) ? parsed.findings : []).entries()) {
    const missing = ["title", "evidence", "proposal"].filter((field) => typeof raw?.[field] !== "string" || !raw[field].trim())
    if (!findingSeverities.includes(raw?.severity)) missing.unshift("severity")
    if (missing.length) {
      dropped.push(`finding ${index + 1} has no valid ${missing.join(", ")}`)
      continue
    }
    if (findings.length === maxFindingsPerRun) {
      dropped.push(`finding ${index + 1} is over the limit of ${maxFindingsPerRun}: ${raw.title.trim().slice(0, 100)}`)
      continue
    }
    findings.push({
      severity: raw.severity,
      title: raw.title.trim().slice(0, 200),
      evidence: raw.evidence.trim().slice(0, fieldMaxLength),
      proposal: raw.proposal.trim().slice(0, fieldMaxLength),
    })
  }
  return { summary: parsed.summary.trim(), findings, dropped }
}

export function insightRunActive(run: InsightRun | null, now = Date.now()): boolean {
  return run?.status === "running" && now - Date.parse(run.startedAt) < staleRunMs
}

// Agents whose last run started longer ago than their schedule. None while the project is not live,
// Operate is off, or a build run is alive; an agent with a run in progress is never due.
export function dueAgents(store: Store, config: PipelineConfig, now = Date.now()): InsightAgent[] {
  if (!config.operate.enabled || !projectLive(store)) return []
  if (processAlive(Number(store.meta("run.pid")))) return []
  return insightAgents.filter((agent) => {
    const hours = config.operate.schedule[agent]
    if (!hours) return false
    const last = store.lastInsightRun(agent)
    if (insightRunActive(last, now)) return false
    return !last || now - Date.parse(last.startedAt) >= hours * hourMs
  })
}

function readBrief(projectDir: string): string {
  for (const file of ["docs/spec.md", "input.md"]) {
    const path = join(projectDir, file)
    if (existsSync(path)) return readFileSync(path, "utf8").slice(0, briefMaxLength)
  }
  return "(no spec)"
}

function earlierFindings(store: Store, agent: InsightAgent): string[] {
  const rows = store.listFindings({ source: agent }).slice(0, 30)
  return rows.length ? rows.map((finding) => `- [${finding.status}] ${finding.severity}: ${finding.title}`) : ["(none)"]
}

export interface InsightDeps {
  runAgent?: RunInsight
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  logs?: (projectDir: string) => string
  now?: () => number
}

function monitoringInput(projectDir: string, store: Store, deps: InsightDeps): string[] {
  const now = (deps.now ?? Date.now)()
  const weekAgo = new Date(now - 7 * 24 * hourMs).toISOString()
  const failures = store.recentHealthChecks(failedProbeLimit, true).map((check) => `- ${check.at}: ${check.error ?? "failed"}${check.statusCode ? ` (HTTP ${check.statusCode})` : ""}`)
  const incidents = listIncidents(projectDir)
    .filter((incident) => incident.status === "open" || incident.status === "diagnosing")
    .map((incident) => `- ${incident.id} ${incident.kind}: ${incident.reason.split("\n")[0].slice(0, 300)}`)
  const events = store
    .recentEvents(500)
    .filter((event) => event.at >= weekAgo && ["deploy", "operate", "doctor"].includes(event.type))
    .slice(0, 100)
    .reverse()
    .map((event) => `- ${event.at} [${event.type}] ${event.message.split("\n")[0].slice(0, 300)}`)
  const logs = (deps.logs ?? ((dir) => containerLogs(`agent-team-app-${projectSlug(dir)}`, logLines)))(projectDir)
  return [
    "## Health summary",
    "```json",
    JSON.stringify(healthSummary(store, now), null, 2),
    "```",
    `## Last ${failedProbeLimit} failed probes (newest first)`,
    ...(failures.length ? failures : ["(none)"]),
    `## Last ${logLines} lines of the app container log`,
    "```",
    logs.trim() || "(no logs)",
    "```",
    "## Open incidents",
    ...(incidents.length ? incidents : ["(none)"]),
    "## Deploy, operate, and doctor events from the last 7 days (oldest first)",
    ...(events.length ? events : ["(none)"]),
  ]
}

function analyticsInput(data: PosthogData): string[] {
  return ["## PostHog data", "```json", JSON.stringify(data, null, 2), "```"]
}

function researchInput(projectDir: string, config: PipelineConfig): string[] {
  const competitors = config.operate.competitors
  return [
    "## Spec",
    readBrief(projectDir),
    "## Competitors",
    ...(competitors.length ? competitors.map((url) => `- ${url}`) : ["(none listed; search for the closest products yourself)"]),
  ]
}

function writeReport(projectDir: string, agent: InsightAgent, status: string, summary: string, findings: InsightFinding[]): void {
  const dir = join(projectDir, "docs", "operate")
  mkdirSync(dir, { recursive: true })
  const lines = [
    `# ${agent[0].toUpperCase()}${agent.slice(1)} agent`,
    "",
    `Last run: ${new Date().toISOString()} (${status})`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Findings",
    "",
    ...(findings.length ? findings.flatMap((finding) => [`### ${finding.severity}: ${finding.title}`, "", `Evidence: ${finding.evidence}`, "", `Proposal: ${finding.proposal}`, ""]) : ["None.", ""]),
  ]
  writeFileSync(join(dir, `${agent}.md`), lines.join("\n"))
}

const posthogSetupFinding: InsightFinding = {
  severity: "low",
  title: "Set up PostHog analytics",
  evidence: "pipeline.yaml has no operate.posthog block, so the analytics agent has no usage data.",
  proposal: "Create a PostHog project and add operate.posthog (host, projectId, publicKey, apiKeyEnv) to pipeline.yaml, then redeploy so the app sends events.",
}

// Records the run, stores the findings, and writes docs/operate/<agent>.md.
function finish(projectDir: string, agent: InsightAgent, runId: number, status: "done" | "failed", summary: string, parsed: InsightFinding[]): InsightOutcome {
  return withProjectStore(projectDir, (store) => {
    const ids = parsed.map((finding) => store.addFinding({ source: agent, ...finding }).id)
    store.finishInsightRun(runId, status, summary, ids.length)
    store.log("operate", `${agent} agent ${status === "done" ? "finished" : "failed"}: ${ids.length} finding${ids.length === 1 ? "" : "s"}${status === "failed" ? ` (${summary.split("\n")[0].slice(0, 200)})` : ""}`)
    writeReport(projectDir, agent, status, summary, parsed)
    return { status, summary, findings: ids.map((id) => store.finding(id)!) }
  })
}

export async function runInsightAgent(options: { projectDir: string; agent: InsightAgent } & InsightDeps): Promise<InsightOutcome> {
  const { projectDir, agent } = options
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const role = config.roles[insightAgentRoles[agent]]
  const { runId, earlier } = withProjectStore(projectDir, (store) => {
    store.log("operate", `${agent} agent started`)
    return { runId: store.startInsightRun(agent), earlier: earlierFindings(store, agent) }
  })

  let input: string[]
  try {
    if (agent === "monitoring") input = withProjectStore(projectDir, (store) => monitoringInput(projectDir, store, options))
    else if (agent === "research") input = researchInput(projectDir, config)
    else {
      if (!config.operate.posthog) return finish(projectDir, agent, runId, "failed", "posthog not configured", [posthogSetupFinding])
      const data = await fetchPosthogData({ projectDir, config: config.operate.posthog, env: options.env, fetch: options.fetch })
      withProjectStore(projectDir, (store) => storePosthogData(store, data, new Date((options.now ?? Date.now)())))
      input = analyticsInput(data)
    }
  } catch (error) {
    return finish(projectDir, agent, runId, "failed", `could not gather data: ${(error as Error).message}`, [])
  }

  const transcriptPath = join(projectDir, ".agent-team", "transcripts", `insight-${agent}-${Date.now()}.log`)
  const request: RunRequest = {
    role: insightAgentRoles[agent],
    model: role.model,
    systemPrompt: readFileSync(new URL(`../../prompts/${prompts[agent]}.md`, import.meta.url), "utf8"),
    taskPrompt: ["# Data the server gathered", ...input, "# Earlier findings from you (do not repeat open ones)", ...earlier].join("\n"),
    executor: hostExecutor(projectDir),
    allowedTools: tools[agent],
    budgetUsd: insightBudgetUsd,
    timeoutMs: insightTimeoutMs,
    transcriptPath,
  }
  let result: RunResult
  try {
    result = await (options.runAgent ?? runWithConfiguredRunner)(request, role.runner)
  } catch (error) {
    result = { status: "failed", summary: (error as Error).message, costUsd: null, tokens: null, durationMs: 0, exitCode: null, diagnostics: "" }
  }
  withProjectStore(projectDir, (store) =>
    store.recordAttempt({
      subject: `insight-${agent}`,
      role: insightAgentRoles[agent],
      runner: role.runner,
      model: role.model,
      status: result.status,
      failureClass: null,
      costUsd: result.costUsd,
      tokens: result.tokens,
      durationMs: result.durationMs,
      transcriptPath,
    }),
  )
  if (result.status !== "done") {
    const detail = (result.diagnostics || result.summary).trim().split("\n").at(-1)?.slice(0, 300)
    return finish(projectDir, agent, runId, "failed", `the agent ${result.status}${detail ? `: ${detail}` : ""}`, [])
  }
  let reply: InsightReply
  try {
    reply = parseInsightReply(result.summary)
  } catch (error) {
    return finish(projectDir, agent, runId, "failed", `the reply is not valid: ${(error as Error).message}`, [])
  }
  if (reply.dropped.length) withProjectStore(projectDir, (store) => store.log("operate", `${agent} agent: dropped ${reply.dropped.join("; ")}`))
  return finish(projectDir, agent, runId, "done", reply.summary, reply.findings)
}
