import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import {
  insightBudgetUsd,
  isBuiltInRoutine,
  loadConfig,
  routineIdPattern,
  routineOutputs,
  routineRoles,
  routineTriggers,
  type PipelineConfig,
  type RoutineConfig,
  type RoutinesConfig,
} from "./config.ts"
import { commitPaths } from "./git.ts"
import { hostExecutor } from "./harness/executor.ts"
import { extractJsonObject } from "./json.ts"
import { savePipelineSetting } from "./lead-actions.ts"
import { insightRunActive, parseInsightReply, readBrief, runInsightAgent, type InsightFinding, type RunInsight } from "./operate/agents.ts"
import { projectLive } from "./operate/health.ts"
import { processAlive, ProjectError, runLogPath, startRun, withProjectStore } from "./project.ts"
import { sprintBlocker, syncSprint } from "./sprint.ts"
import { getRunner, type RunRequest, type RunResult } from "./runners/index.ts"
import type { InsightRun, RoutineFile, RoutineRun, Store } from "./store.ts"

const dayMs = 24 * 60 * 60_000
const routineTimeoutMs = 15 * 60_000
// A run row still "running" after this long belongs to a process that died.
const staleRunMs = routineTimeoutMs + 5 * 60_000
export const maxRoutineImages = 6
const maxImageBytes = 15 * 1024 * 1024
const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"]
const reportMaxLength = 40_000
export const routineReportDir = "docs/routines"
export const routineImageDir = "marketing/routines"
// Files a marketing routine gets in its stage folder, when the project has them.
const brandFiles = ["input.md", "docs/spec.md", "docs/design-system.md", "design/logo.svg", "design/logo-mark.svg", "design/tokens.css", "marketing/copy.json"]

// What each role can do, as the dashboard shows it; the tools follow from it.
export const roleCapabilities: Record<string, string[]> = {
  marketer: ["Image generation", "Web search"],
  researcher: ["Web search"],
  pm: ["Read code", "Web search"],
  designer: ["Read code"],
  monitor: ["Read logs"],
  analyst: ["PostHog"],
}
const roleTools: Record<(typeof routineRoles)[number], string[]> = {
  marketer: ["read", "write", "bash:mkdir", "bash:ls", "web_search", "web_fetch"],
  researcher: ["read", "web_search", "web_fetch"],
  pm: ["read", "web_search", "web_fetch"],
  designer: ["read"],
}

const baselineKey = (id: string) => `routine.${id}.since`

function routineActive(run: RoutineRun | null, now: number): boolean {
  return run?.status === "running" && now - Date.parse(run.startedAt) < staleRunMs
}

function lastStartedAt(store: Store, routine: RoutineConfig): string | null {
  return (isBuiltInRoutine(routine.id) ? store.lastInsightRun(routine.id) : store.lastRoutineRun(routine.id))?.startedAt ?? null
}

// The time of the last event that fires a sprint or deploy routine.
function triggerEventAt(store: Store, routine: RoutineConfig): string | null {
  if (routine.trigger === "deploy") return store.lastDeployAt()
  if (routine.trigger === "sprint") return store.sprints(20).find((sprint) => sprint.status === "done")?.finishedAt ?? null
  return null
}

// A sprint or deploy routine only follows events after it was first seen, so a new routine does not fire on an
// old deploy. Called by the doctor tick before dueRoutines.
export function markRoutineBaselines(store: Store, config: PipelineConfig, now = Date.now()): void {
  for (const routine of config.routines.list) {
    if ((routine.trigger === "sprint" || routine.trigger === "deploy") && store.meta(baselineKey(routine.id)) === null) {
      store.setMeta(baselineKey(routine.id), new Date(now).toISOString())
    }
  }
}

export function routineSpend(store: Store, now = Date.now()): number {
  return store.routineSpend(new Date(now - 30 * dayMs).toISOString(), insightBudgetUsd)
}

// Why a routine may not run now, or null when it may. manual is the Run now button: it skips the switch, the
// trigger, and the live check, but keeps the money cap and never runs beside a build.
export function routineBlocker(store: Store, config: PipelineConfig, routine: RoutineConfig, options: { now?: number; manual?: boolean } = {}): string | null {
  const now = options.now ?? Date.now()
  const running = isBuiltInRoutine(routine.id) ? insightRunActive(store.lastInsightRun(routine.id), now) : routineActive(store.lastRoutineRun(routine.id), now)
  if (running) return "it is already running"
  if (processAlive(Number(store.meta("run.pid")))) return "a build run is in progress"
  const spent = routineSpend(store, now)
  if (spent + routine.budgetUsd > config.routines.monthlyUsd) {
    return `routines spent $${spent.toFixed(2)} in the last 30 days; another run could pass routines.monthlyUsd ($${config.routines.monthlyUsd.toFixed(2)})`
  }
  if (routine.output === "sprint") {
    const sprint = sprintBlocker(store, config, { now, early: true })
    if (sprint) return `no sprint can start: ${sprint}`
  }
  if (options.manual) return null
  if (!routine.enabled) return "it is off"
  if (routine.trigger === "manual") return "it runs by hand only"
  if (isBuiltInRoutine(routine.id) && !config.operate.enabled) return "Operate is off (operate.enabled)"
  if (!projectLive(store)) return "the app is not live"
  const last = lastStartedAt(store, routine)
  if (routine.trigger === "interval") {
    const next = last ? Date.parse(last) + routine.everyDays * dayMs : now
    return now < next ? `the next run is due at ${new Date(next).toISOString()}` : null
  }
  const eventAt = triggerEventAt(store, routine)
  const since = [last, store.meta(baselineKey(routine.id))].filter((value): value is string => Boolean(value)).sort().at(-1)
  if (!eventAt || (since && eventAt <= since)) return routine.trigger === "sprint" ? "it waits for the next finished sprint" : "it waits for the next deploy"
  return null
}

// Custom routines that are due; the built-in ones go through dueAgents in src/operate/agents.ts.
export function dueRoutines(store: Store, config: PipelineConfig, now = Date.now()): RoutineConfig[] {
  return config.routines.list.filter((routine) => !isBuiltInRoutine(routine.id) && routineBlocker(store, config, routine, { now }) === null)
}

export interface RoutineReply {
  summary: string
  findings: InsightFinding[]
  report: string | null
  images: RoutineFile[]
  dropped: string[]
}

export function parseRoutineReply(text: string, output: RoutineConfig["output"]): RoutineReply {
  if (output === "backlog" || output === "sprint") {
    const { summary, findings, dropped } = parseInsightReply(text)
    return { summary, findings, dropped, report: null, images: [] }
  }
  const parsed = extractJsonObject(text) as any
  if (typeof parsed?.summary !== "string" || !parsed.summary.trim()) throw new Error("the reply has no summary")
  const summary = parsed.summary.trim()
  if (output === "report") {
    if (typeof parsed.report !== "string" || !parsed.report.trim()) throw new Error("the reply has no report")
    return { summary, findings: [], dropped: [], report: parsed.report.trim().slice(0, reportMaxLength), images: [] }
  }
  const images: RoutineFile[] = []
  const dropped: string[] = []
  for (const [index, raw] of (Array.isArray(parsed.images) ? parsed.images : []).entries()) {
    if (typeof raw?.file !== "string" || !raw.file.trim()) dropped.push(`image ${index + 1} has no file`)
    else if (images.length === maxRoutineImages) dropped.push(`image ${index + 1} is over the limit of ${maxRoutineImages}`)
    else images.push({ file: raw.file.trim(), caption: typeof raw.caption === "string" ? raw.caption.trim().slice(0, 2000) : "" })
  }
  if (!images.length) throw new Error("the reply lists no images")
  return { summary, findings: [], dropped, report: null, images }
}

// Keeps only images inside the stage's out/ folder, so a reply cannot point the server at other files.
export function checkStageImages(stageDir: string, images: RoutineFile[]): { kept: RoutineFile[]; dropped: string[] } {
  const outDir = resolve(stageDir, "out")
  const kept: RoutineFile[] = []
  const dropped: string[] = []
  for (const image of images) {
    const path = resolve(stageDir, image.file)
    if (!path.startsWith(outDir + sep)) dropped.push(`${image.file} is not in out/`)
    else if (!imageExtensions.includes(extname(path).toLowerCase())) dropped.push(`${image.file} is not a png, jpg, or webp image`)
    else if (!existsSync(path)) dropped.push(`${image.file} does not exist`)
    else if (statSync(path).size > maxImageBytes) dropped.push(`${image.file} is over 15 MB`)
    else kept.push({ file: path, caption: image.caption })
  }
  return { kept, dropped }
}

function earlierOutput(projectDir: string, store: Store, routine: RoutineConfig): string[] {
  if (routine.output === "report") {
    const path = join(projectDir, routineReportDir, `${routine.id}.md`)
    return existsSync(path) ? [readFileSync(path, "utf8").slice(0, 6000)] : ["(none)"]
  }
  if (routine.output === "marketing") {
    const captions = store.lastRoutineRun(routine.id)?.files.map((file) => `- ${file.caption}`) ?? []
    return captions.length ? captions : ["(none)"]
  }
  const findings = store.listFindings({ source: "routine" }).filter((finding) => finding.evidence.startsWith(`[${routine.name}]`)).slice(0, 30)
  return findings.length ? findings.map((finding) => `- [${finding.status}] ${finding.severity}: ${finding.title}`) : ["(none)"]
}

function stageBrandFiles(projectDir: string, stageDir: string): string[] {
  const copied = brandFiles.filter((file) => existsSync(join(projectDir, file)))
  for (const file of copied) cpSync(join(projectDir, file), join(stageDir, "context", file))
  mkdirSync(join(stageDir, "out"), { recursive: true })
  return copied.map((file) => `context/${file}`)
}

function routineTaskPrompt(routine: RoutineConfig, brief: string, files: string[], earlier: string[]): string {
  return [
    `# Routine: ${routine.name}`,
    `Your role: ${routine.role}. The output the server expects: ${routine.output}.`,
    "## Instructions",
    routine.instructions,
    "## Files to read",
    ...(files.length ? files.map((file) => `- ${file}`) : ["- The project's docs/ and code, in your working directory."]),
    "## Spec",
    brief,
    "## Your earlier output for this routine",
    ...earlier,
  ].join("\n")
}

export interface RoutineOutcome {
  status: "done" | "failed"
  summary: string
}

export interface RoutineDeps {
  runAgent?: RunInsight
  now?: () => number
  // The monitoring routine's container logs; tests pass a fake so no Docker call runs.
  logs?: (projectDir: string) => string
  // Starts the sprint a routine with output sprint asks for; the default is a detached `agent-team sprint --now` run.
  startSprint?: (projectDir: string) => void | Promise<void>
}

const runWithConfiguredRunner: RunInsight = (request, runner) => getRunner(runner as "claude" | "codex").run(request)

const startSprintRun = (projectDir: string) => void startRun(projectDir, runLogPath(dirname(projectDir), basename(projectDir)), ["sprint", "--now"])

// Starts a sprint for a routine with output sprint. Returns the blocker in plain words, or null once the sprint started.
export async function startRoutineSprint(projectDir: string, config: PipelineConfig, deps: RoutineDeps = {}): Promise<string | null> {
  const now = (deps.now ?? Date.now)()
  const blocker = withProjectStore(projectDir, (store) => {
    syncSprint(store, now)
    return sprintBlocker(store, config, { now, early: true })
  })
  if (blocker) return blocker
  await (deps.startSprint ?? startSprintRun)(projectDir)
  return null
}

// Stores the reply where the routine's output goes: backlog findings, a committed report, or committed images.
function applyReply(projectDir: string, store: Store, routine: RoutineConfig, reply: RoutineReply, stageDir: string | null): { findings: number; files: RoutineFile[]; dropped: string[] } {
  if (routine.output === "backlog" || routine.output === "sprint") {
    for (const finding of reply.findings) store.addFinding({ source: "routine", ...finding, evidence: `[${routine.name}] ${finding.evidence}` })
    return { findings: reply.findings.length, files: [], dropped: reply.dropped }
  }
  if (routine.output === "report") {
    const file = `${routineReportDir}/${routine.id}.md`
    mkdirSync(join(projectDir, routineReportDir), { recursive: true })
    writeFileSync(join(projectDir, file), [`# ${routine.name}`, "", `Last run: ${new Date().toISOString()}`, "", reply.report, ""].join("\n"))
    commitPaths(projectDir, [file], `docs(routines): update ${routine.id}`)
    return { findings: 0, files: [{ file, caption: reply.summary }], dropped: reply.dropped }
  }
  const { kept, dropped } = checkStageImages(stageDir!, reply.images)
  if (!kept.length) throw new Error(`no usable images: ${dropped.join("; ")}`)
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)
  const dir = `${routineImageDir}/${routine.id}`
  mkdirSync(join(projectDir, dir), { recursive: true })
  const files = kept.map((image) => {
    const file = `${dir}/${stamp}-${basename(image.file).toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`
    copyFileSync(image.file, join(projectDir, file))
    return { file, caption: image.caption }
  })
  commitPaths(projectDir, files.map((entry) => entry.file), `design(marketing): add ${files.length} image${files.length === 1 ? "" : "s"} from ${routine.id}`)
  return { findings: 0, files, dropped: [...reply.dropped, ...dropped] }
}

async function runCustomRoutine(projectDir: string, config: PipelineConfig, routine: RoutineConfig, deps: RoutineDeps): Promise<RoutineOutcome> {
  const role = config.roles[routine.role]
  const { runId, earlier } = withProjectStore(projectDir, (store) => {
    store.log("routine", `${routine.id} started (${routine.role})`)
    return { runId: store.startRoutineRun(routine.id, routine.budgetUsd), earlier: earlierOutput(projectDir, store, routine) }
  })
  const finish = (status: RoutineOutcome["status"], summary: string, costUsd: number | null, applied = { findings: 0, files: [] as RoutineFile[] }) =>
    withProjectStore(projectDir, (store) => {
      store.finishRoutineRun(runId, { status, summary, costUsd, ...applied })
      const outputs = applied.files.length ? `${applied.files.length} file${applied.files.length === 1 ? "" : "s"}` : `${applied.findings} finding${applied.findings === 1 ? "" : "s"}`
      store.log("routine", `${routine.id} ${status === "done" ? "finished" : "failed"}: ${status === "done" ? outputs : summary.split("\n")[0].slice(0, 200)}`)
      return { status, summary }
    })

  const stageDir = routine.output === "marketing" ? mkdtempSync(join(tmpdir(), "agent-team-routine-")) : null
  try {
    const files = stageDir ? stageBrandFiles(projectDir, stageDir) : []
    const transcriptPath = join(projectDir, ".agent-team", "transcripts", `routine-${routine.id}-${(deps.now ?? Date.now)()}.log`)
    const request: RunRequest = {
      role: routine.role,
      model: role.model,
      systemPrompt: readFileSync(new URL("../prompts/routine.md", import.meta.url), "utf8"),
      taskPrompt: routineTaskPrompt(routine, readBrief(projectDir), files, earlier),
      executor: hostExecutor(stageDir ?? projectDir),
      allowedTools: roleTools[routine.role as keyof typeof roleTools] ?? ["read"],
      budgetUsd: routine.budgetUsd,
      timeoutMs: routineTimeoutMs,
      transcriptPath,
    }
    let result: RunResult
    try {
      result = await (deps.runAgent ?? runWithConfiguredRunner)(request, role.runner)
    } catch (error) {
      result = { status: "failed", summary: (error as Error).message, costUsd: null, tokens: null, durationMs: 0, exitCode: null, diagnostics: "" }
    }
    withProjectStore(projectDir, (store) =>
      store.recordAttempt({
        subject: `routine-${routine.id}`,
        role: routine.role,
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
      return finish("failed", `the agent ${result.status}${detail ? `: ${detail}` : ""}`, result.costUsd)
    }
    try {
      const reply = parseRoutineReply(result.summary, routine.output)
      const applied = withProjectStore(projectDir, (store) => applyReply(projectDir, store, routine, reply, stageDir))
      if (applied.dropped.length) withProjectStore(projectDir, (store) => store.log("routine", `${routine.id}: dropped ${applied.dropped.join("; ")}`))
      if (routine.output === "sprint") {
        const blocker = await startRoutineSprint(projectDir, config, deps)
        if (blocker) return finish("failed", `no sprint started: ${blocker}`, result.costUsd, applied)
        return finish("done", `${reply.summary} A sprint started to build the backlog.`, result.costUsd, applied)
      }
      return finish("done", reply.summary, result.costUsd, applied)
    } catch (error) {
      return finish("failed", `the reply is not usable: ${(error as Error).message}`, result.costUsd)
    }
  } finally {
    if (stageDir) rmSync(stageDir, { recursive: true, force: true })
  }
}

export async function runRoutine(options: { projectDir: string; id: string } & RoutineDeps): Promise<RoutineOutcome> {
  const { projectDir, id } = options
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const routine = config.routines.list.find((entry) => entry.id === id)
  if (!routine) throw new ProjectError(404, `unknown routine "${id}"`)
  if (isBuiltInRoutine(routine.id)) {
    const outcome = await runInsightAgent({ projectDir, agent: routine.id, runAgent: options.runAgent, now: options.now, logs: options.logs })
    return { status: outcome.status, summary: outcome.summary }
  }
  return runCustomRoutine(projectDir, config, routine, options)
}

export interface RoutineLastRun {
  status: RoutineRun["status"]
  startedAt: string
  finishedAt: string | null
  summary: string
  costUsd: number | null
  findings: number
  files: RoutineFile[]
}

export interface RoutineView extends RoutineConfig {
  builtIn: boolean
  runner: string
  model: string
  capabilities: string[]
  lastRun: RoutineLastRun | null
  running: boolean
  // For the interval trigger only.
  nextDueAt: string | null
  // Why Run now is not possible, or null.
  runBlocker: string | null
}

export interface RoutinesSnapshot {
  monthlyUsd: number
  spentUsd30d: number
  live: boolean
  routines: RoutineView[]
  // The roles a custom routine may use, for the form.
  roles: { role: string; runner: string; model: string; capabilities: string[] }[]
}

function builtInLastRun(run: InsightRun | null): RoutineLastRun | null {
  return run && { status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary, costUsd: null, findings: run.findings, files: [] }
}

export function routinesSnapshot(store: Store, config: PipelineConfig, now = Date.now()): RoutinesSnapshot {
  const routines = config.routines.list.map((routine): RoutineView => {
    const { id } = routine
    const builtIn = isBuiltInRoutine(id)
    const lastRun = isBuiltInRoutine(id) ? builtInLastRun(store.lastInsightRun(id)) : store.lastRoutineRun(id)
    const running = isBuiltInRoutine(id) ? insightRunActive(store.lastInsightRun(id), now) : routineActive(store.lastRoutineRun(id), now)
    const nextDueAt = routine.enabled && routine.trigger === "interval" ? new Date(lastRun ? Date.parse(lastRun.startedAt) + routine.everyDays * dayMs : now).toISOString() : null
    const role = config.roles[routine.role]
    return {
      ...routine,
      builtIn,
      runner: role.runner,
      model: role.model,
      capabilities: roleCapabilities[routine.role] ?? [],
      lastRun: lastRun && { status: lastRun.status, startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt, summary: lastRun.summary, costUsd: lastRun.costUsd, findings: lastRun.findings, files: lastRun.files },
      running,
      nextDueAt,
      runBlocker: routineBlocker(store, config, routine, { now, manual: true }),
    }
  })
  const roles = routineRoles.map((role) => ({ role, runner: config.roles[role].runner, model: config.roles[role].model, capabilities: roleCapabilities[role] }))
  return { monthlyUsd: config.routines.monthlyUsd, spentUsd30d: Math.round(routineSpend(store, now) * 100) / 100, live: projectLive(store), routines, roles }
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "routine"
  )
}

// Reads the dashboard's routine list. A new routine has no id yet; it gets one from its name.
export function parseRoutines(value: unknown): RoutinesConfig {
  const raw = (value ?? {}) as Record<string, unknown>
  if (typeof raw.monthlyUsd !== "number") throw new ProjectError(400, "monthlyUsd must be a number.")
  if (!Array.isArray(raw.list)) throw new ProjectError(400, "list must be a list of routines.")
  const used = new Set<string>()
  const list = raw.list.map((entry: any, index: number): RoutineConfig => {
    if (typeof entry !== "object" || entry === null) throw new ProjectError(400, `Routine ${index + 1} is not an object.`)
    let id = typeof entry.id === "string" && routineIdPattern.test(entry.id) ? entry.id : slugify(String(entry.name ?? ""))
    if (!entry.id) for (let suffix = 2; used.has(id) || isBuiltInRoutine(id); suffix++) id = `${slugify(String(entry.name ?? "")).slice(0, 36)}-${suffix}`
    used.add(id)
    if (!(routineTriggers as readonly unknown[]).includes(entry.trigger)) throw new ProjectError(400, `Routine ${index + 1}: trigger must be one of ${routineTriggers.join(", ")}.`)
    if (!isBuiltInRoutine(id) && !(routineOutputs as readonly unknown[]).includes(entry.output)) throw new ProjectError(400, `Routine ${index + 1}: output must be one of ${routineOutputs.join(", ")}.`)
    return { id, name: String(entry.name ?? ""), role: entry.role, instructions: String(entry.instructions ?? ""), trigger: entry.trigger, everyDays: Number(entry.everyDays), output: entry.output, budgetUsd: Number(entry.budgetUsd), enabled: entry.enabled === true }
  })
  return { monthlyUsd: raw.monthlyUsd, list }
}

// Writes the whole routines block. Built-in routines keep only the fields a person can change, and the legacy
// operate.schedule goes away because the built-in routines replace it.
export function saveRoutines(projectDir: string, routines: RoutinesConfig): void {
  const list = routines.list.map((routine) => {
    if (isBuiltInRoutine(routine.id)) return { id: routine.id, enabled: routine.enabled, trigger: routine.trigger, everyDays: routine.everyDays }
    const { id, name, role, instructions, trigger, everyDays, output, budgetUsd, enabled } = routine
    return { id, name, role, instructions, trigger, ...(trigger === "interval" ? { everyDays } : {}), output, budgetUsd, enabled }
  })
  savePipelineSetting(projectDir, ["routines"], { monthlyUsd: routines.monthlyUsd, list }, `chore: save ${list.length} routines`, [["operate", "schedule"]])
}
