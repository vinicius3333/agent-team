import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parse, parseDocument } from "yaml"
import { loadConfig, type PipelineConfig } from "./config.ts"
import type { DesignJudgeResult, DesignScore } from "./design-judge.ts"
import { commitPaths } from "./git.ts"
import type { RunOutcome, RunStop } from "./pipeline.ts"
import { createProject, installDir, openProjectStore } from "./project.ts"
import type { Store } from "./store.ts"

export const evalTiers = ["smoke", "full"] as const
export type EvalTier = (typeof evalTiers)[number]

export const briefsDir = join(installDir, "evals", "briefs")
export const defaultEvalsDir = join(installDir, "evals")
const examplePipelinePath = join(installDir, "pipeline.example.yaml")

export interface EvalBrief {
  id: string
  brief: string
  tier: EvalTier
  target: PipelineConfig["target"]
  pipeline: Record<string, unknown>
  budgetUsd: number
  timeoutMinutes: number
  briefHash: string
}

export interface BriefResult {
  id: string
  briefHash: string
  outcome: RunOutcome | "timeout"
  stop: RunStop | null
  phases: Record<string, string>
  tasks: { total: number; merged: number; blocked: number; replans: number }
  attempts: { total: number; byRole: Record<string, number>; fallbacks: number }
  reviews: { total: number; fail: number }
  qa: { rounds: number; verdict: string | null; fixTasks: number }
  costUsd: number
  unreportedCalls: number
  tokens: number
  wallMs: number
  // The design judge's score of the screenshots; null when it skipped. Missing in results from before the judge.
  design?: DesignScore | null
}

export interface EvalResult {
  resultId: string
  gitSha: string
  dirty: boolean
  label: string | null
  tier: EvalTier
  configHash: string
  config: Record<string, unknown>
  runnerVersions: Record<string, string | null>
  aborted: "budget" | "interrupt" | null
  briefs: BriefResult[]
}

// Runs one project to its end. Injected so tests use a stub instead of real agents.
export type ProjectRunner = (projectDir: string, store: Store, signal: AbortSignal) => Promise<RunOutcome>
// Scores the built app's screenshots after the run. Injected for the same reason.
export type DesignJudge = (projectDir: string, store: Store, signal: AbortSignal) => Promise<DesignJudgeResult>

const defaultTimeoutMinutes = 90

// Tier settings sit between the forced settings and the brief's own overrides.
const tierSettings: Record<EvalTier, Record<string, unknown>> = {
  smoke: { branding: { enabled: false }, marketing: { enabled: false }, qa: { maxRounds: 1 }, parallelTasks: 2 },
  full: {},
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export function loadBrief(dir: string, id: string): EvalBrief {
  const briefPath = join(dir, "brief.md")
  const settingsPath = join(dir, "eval.yaml")
  if (!existsSync(briefPath) || !existsSync(settingsPath)) throw new Error(`brief "${id}" needs brief.md and eval.yaml`)
  const brief = readFileSync(briefPath, "utf8")
  const settingsText = readFileSync(settingsPath, "utf8")
  const settings = parse(settingsText) ?? {}
  const tier = settings.tier
  if (!evalTiers.includes(tier)) throw new Error(`brief "${id}": tier must be ${evalTiers.join(" or ")}`)
  if (!(typeof settings.budgetUsd === "number" && settings.budgetUsd > 0)) throw new Error(`brief "${id}": budgetUsd must be a number above 0`)
  const target = settings.target ?? "web"
  if (!["web", "api", "web+api"].includes(target)) throw new Error(`brief "${id}": target must be web, api, or web+api`)
  return {
    id,
    brief,
    tier,
    target,
    pipeline: settings.pipeline ?? {},
    budgetUsd: settings.budgetUsd,
    timeoutMinutes: settings.timeoutMinutes ?? defaultTimeoutMinutes,
    briefHash: sha256(`${brief}\n---\n${settingsText}`),
  }
}

// The full tier includes the smoke briefs. Named ids win over the tier filter.
export function listBriefs(tier: EvalTier, ids: string[], dir = briefsDir): EvalBrief[] {
  const all = existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "brief.md"))).sort() : []
  for (const id of ids) if (!all.includes(id)) throw new Error(`unknown brief "${id}"; briefs are ${all.join(", ") || "none"}`)
  const briefs = (ids.length ? ids : all).map((id) => loadBrief(join(dir, id), id))
  return ids.length ? briefs : briefs.filter((brief) => tier === "full" || brief.tier === "smoke")
}

function applySettings(document: ReturnType<typeof parseDocument>, settings: Record<string, unknown>, path: string[] = []): void {
  for (const [key, value] of Object.entries(settings)) {
    if (value && typeof value === "object" && !Array.isArray(value)) applySettings(document, value as Record<string, unknown>, [...path, key])
    else document.setIn([...path, key], value)
  }
}

// Order: base config, forced safety settings, tier, brief overrides, then gates and budget, which a brief cannot change.
export function suiteConfig(baseYaml: string, tier: EvalTier, brief: EvalBrief): string {
  const document = parseDocument(baseYaml)
  applySettings(document, { target: brief.target, deploy: { enabled: false }, publish: { github: { enabled: false } } })
  applySettings(document, tierSettings[tier])
  applySettings(document, brief.pipeline)
  document.setIn(["autonomy", "gates"], [])
  document.setIn(["budget", "runUsd"], brief.budgetUsd)
  return document.toString()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}

export function hashConfig(config: unknown): string {
  return sha256(stableJson(config))
}

function commandOutput(command: string, args: string[], cwd = installDir): string | null {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

function qaSummary(projectDir: string): { rounds: number; verdict: string | null } {
  const qaDir = join(projectDir, ".agent-team", "qa")
  const rounds = existsSync(qaDir) ? readdirSync(qaDir).filter((name) => /^round-\d+$/.test(name)).map((name) => Number(name.slice(6))) : []
  if (!rounds.length) return { rounds: 0, verdict: null }
  const verdictPath = join(qaDir, `round-${Math.max(...rounds)}`, "verdict.json")
  const verdict = existsSync(verdictPath) ? (JSON.parse(readFileSync(verdictPath, "utf8")).verdict as string) : null
  return { rounds: rounds.length, verdict }
}

export function summarizeBrief(options: { brief: EvalBrief; projectDir: string; store: Store; config: PipelineConfig; outcome: BriefResult["outcome"]; wallMs: number; design?: DesignScore | null }): BriefResult {
  const { brief, projectDir, store, config, outcome, wallMs } = options
  const summary = store.evalSummary()
  const byRole: Record<string, number> = {}
  let fallbacks = 0
  for (const row of summary.attempts) {
    byRole[row.role] = (byRole[row.role] ?? 0) + row.count
    const primary = config.roles[row.role as keyof PipelineConfig["roles"]]
    if (primary && (primary.runner !== row.runner || primary.model !== row.model)) fallbacks += row.count
  }
  const stopText = store.meta("run.stop")
  return {
    id: brief.id,
    briefHash: brief.briefHash,
    outcome,
    stop: stopText ? (JSON.parse(stopText) as RunStop) : null,
    phases: Object.fromEntries(store.phases().map((phase) => [phase.name, phase.status])),
    tasks: { total: summary.tasks.total, merged: summary.tasks.merged, blocked: summary.tasks.blocked, replans: summary.tasks.replans },
    attempts: { total: Object.values(byRole).reduce((sum, count) => sum + count, 0), byRole, fallbacks },
    reviews: { total: summary.reviews.total, fail: summary.reviews.fail },
    qa: { ...qaSummary(projectDir), fixTasks: summary.tasks.qaFixes },
    costUsd: Math.round(summary.costUsd * 10_000) / 10_000,
    unreportedCalls: summary.unreportedCalls,
    tokens: summary.tokens,
    wallMs,
    design: options.design ?? null,
  }
}

export interface EvalOptions {
  evalsDir: string
  tier: EvalTier
  briefs: EvalBrief[]
  baseYaml: string
  label: string | null
  maxUsd: number | null
  clean: boolean
  signal: AbortSignal
  runProject: ProjectRunner
  judgeDesign?: DesignJudge
  log?: (message: string) => void
  now?: () => Date
}

export function resultIdFor(date: Date, gitSha: string, label: string | null): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  return [stamp, gitSha, label].filter(Boolean).join("-")
}

export async function runEval(options: EvalOptions): Promise<{ result: EvalResult; path: string }> {
  const { evalsDir, tier, briefs, baseYaml, label, maxUsd, clean, signal, runProject } = options
  const log = options.log ?? console.log
  const gitSha = commandOutput("git", ["rev-parse", "--short", "HEAD"]) ?? "unknown"
  const resultId = resultIdFor((options.now ?? (() => new Date()))(), gitSha, label)
  const runsDir = join(evalsDir, "runs", resultId)
  const configSample = parse(baseYaml) ?? {}
  const result: EvalResult = {
    resultId,
    gitSha,
    dirty: Boolean(commandOutput("git", ["status", "--porcelain"])),
    label,
    tier,
    configHash: hashConfig({ roles: configSample.roles, harness: configSample.harness, tier: tierSettings[tier] }),
    config: { roles: configSample.roles, harness: configSample.harness },
    runnerVersions: { claude: commandOutput("claude", ["--version"]), codex: commandOutput("codex", ["--version"]) },
    aborted: null,
    briefs: [],
  }

  for (const brief of briefs) {
    const spent = result.briefs.reduce((sum, entry) => sum + entry.costUsd, 0)
    if (maxUsd !== null && spent + brief.budgetUsd > maxUsd) {
      log(`[eval] stopping before ${brief.id}: $${spent.toFixed(2)} spent + $${brief.budgetUsd} budget passes --max-usd ${maxUsd}`)
      result.aborted = "budget"
      break
    }
    if (signal.aborted) {
      result.aborted = "interrupt"
      break
    }
    const projectDir = join(runsDir, brief.id)
    createProject(projectDir, brief.brief)
    writeFileSync(join(projectDir, "pipeline.yaml"), suiteConfig(baseYaml, tier, brief))
    const config = loadConfig(join(projectDir, "pipeline.yaml"))
    commitPaths(projectDir, ["pipeline.yaml"], "chore: apply eval settings")

    const timeout = AbortSignal.timeout(brief.timeoutMinutes * 60_000)
    const briefSignal = AbortSignal.any([signal, timeout])
    log(`[eval] ${brief.id}: running (budget $${brief.budgetUsd}, timeout ${brief.timeoutMinutes} min)`)
    const started = Date.now()
    const entry = await withProjectStoreAsync(projectDir, async (store) => {
      let outcome: BriefResult["outcome"]
      try {
        outcome = await runProject(projectDir, store, briefSignal)
      } catch (error) {
        store.log("eval", `run threw: ${error instanceof Error ? error.message : String(error)}`)
        outcome = "failed"
      }
      if (timeout.aborted && !signal.aborted) {
        store.log("eval", `stopped after the ${brief.timeoutMinutes} minute timeout`)
        outcome = "timeout"
      }
      const wallMs = Date.now() - started
      const design = await scoreDesign(options.judgeDesign, brief, projectDir, store, signal)
      return summarizeBrief({ brief, projectDir, store, config, outcome, wallMs, design })
    })
    result.briefs.push(entry)
    log(`[eval] ${brief.id}: ${entry.outcome}, ${entry.tasks.merged}/${entry.tasks.total} tasks merged, $${entry.costUsd.toFixed(2)}${entry.design ? `, design ${entry.design.score}/100` : ""}`)
    if (signal.aborted) {
      result.aborted = "interrupt"
      break
    }
  }

  const resultsDir = join(evalsDir, "results")
  mkdirSync(resultsDir, { recursive: true })
  const path = join(resultsDir, `${resultId}.json`)
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`)
  if (clean) rmSync(runsDir, { recursive: true, force: true })
  return { result, path }
}

// The judge runs after a timeout too, on whatever the last QA round captured; only an interrupt skips it.
async function scoreDesign(judge: DesignJudge | undefined, brief: EvalBrief, projectDir: string, store: Store, signal: AbortSignal): Promise<DesignScore | null> {
  if (!judge || brief.target === "api" || signal.aborted) return null
  try {
    const result = await judge(projectDir, store, signal)
    if (result.kind === "scored") return result.design
    store.log("eval", `design judge skipped: ${result.reason.slice(0, 300)}`)
  } catch (error) {
    store.log("eval", `design judge threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  return null
}

async function withProjectStoreAsync<T>(projectDir: string, use: (store: Store) => Promise<T>): Promise<T> {
  const store = openProjectStore(projectDir)
  try {
    return await use(store)
  } finally {
    store.close()
  }
}

export function readBaseYaml(configPath: string | undefined): string {
  return readFileSync(configPath ?? examplePipelinePath, "utf8")
}

const outcomeRank: Record<BriefResult["outcome"], number> = { completed: 0, awaiting_approval: 1, paused: 2, timeout: 3, failed: 4 }
const costRegressionRatio = 1.25
// Judge scores move a few points between identical runs; a drop larger than this is a regression.
const designRegressionPoints = 10

export interface BriefComparison {
  id: string
  before: BriefResult
  after: BriefResult
  regressions: string[]
}

export interface Comparison {
  briefs: BriefComparison[]
  missing: string[]
  warnings: string[]
  changedConfigKeys: string[]
}

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { [prefix]: JSON.stringify(value) }
  const entries: Record<string, string> = {}
  for (const [key, child] of Object.entries(value)) Object.assign(entries, flatten(child, prefix ? `${prefix}.${key}` : key))
  return entries
}

function mergedShare(brief: BriefResult): number {
  return brief.tasks.total ? brief.tasks.merged / brief.tasks.total : 0
}

export function compareResults(before: EvalResult, after: EvalResult, allowBriefChange = false): Comparison {
  const warnings: string[] = []
  const flatBefore = flatten(before.config)
  const flatAfter = flatten(after.config)
  const changedConfigKeys = [...new Set([...Object.keys(flatBefore), ...Object.keys(flatAfter)])].filter((key) => flatBefore[key] !== flatAfter[key]).sort()
  if (before.configHash !== after.configHash) warnings.push(`config differs: ${changedConfigKeys.join(", ") || "tier settings"}`)
  if (before.tier !== after.tier) warnings.push(`tiers differ: ${before.tier} vs ${after.tier}`)
  const afterById = new Map(after.briefs.map((brief) => [brief.id, brief]))
  const briefs: BriefComparison[] = []
  const missing: string[] = []
  for (const previous of before.briefs) {
    const next = afterById.get(previous.id)
    if (!next) {
      missing.push(previous.id)
      continue
    }
    if (previous.briefHash !== next.briefHash) {
      if (!allowBriefChange) throw new Error(`brief "${previous.id}" changed between the two results; pass --allow-brief-change to compare anyway`)
      warnings.push(`brief "${previous.id}" changed between the two results`)
    }
    const regressions: string[] = []
    if (outcomeRank[next.outcome] > outcomeRank[previous.outcome]) regressions.push(`outcome ${previous.outcome} -> ${next.outcome}`)
    // The planner makes a different number of tasks each run, so the share merged is compared, not the count.
    if (mergedShare(next) < mergedShare(previous)) regressions.push(`merged tasks ${previous.tasks.merged}/${previous.tasks.total} -> ${next.tasks.merged}/${next.tasks.total}`)
    if (previous.costUsd > 0 && next.costUsd > previous.costUsd * costRegressionRatio) regressions.push(`cost +${Math.round((next.costUsd / previous.costUsd - 1) * 100)}%`)
    if (previous.tokens > 0 && next.tokens > previous.tokens * costRegressionRatio) regressions.push(`tokens +${Math.round((next.tokens / previous.tokens - 1) * 100)}%`)
    if (previous.design && next.design && next.design.score < previous.design.score - designRegressionPoints) regressions.push(`design score ${previous.design.score} -> ${next.design.score}`)
    briefs.push({ id: previous.id, before: previous, after: next, regressions })
  }
  for (const next of after.briefs) if (!before.briefs.some((brief) => brief.id === next.id)) missing.push(next.id)
  return { briefs, missing, warnings, changedConfigKeys }
}

function row(cells: string[], widths: number[]): string {
  return cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()
}

function briefCells(label: string, brief: BriefResult): string[] {
  const cost = `$${brief.costUsd.toFixed(2)}${brief.unreportedCalls ? ` (+${brief.unreportedCalls} unreported)` : ""}`
  return [label, brief.outcome, `${brief.tasks.merged}/${brief.tasks.total}`, String(brief.attempts.total), cost, String(brief.tokens), `${Math.round(brief.wallMs / 60_000)}m`, `${brief.qa.rounds} ${brief.qa.verdict ?? "-"}`, String(brief.reviews.fail), brief.design ? String(brief.design.score) : "-"]
}

export function formatComparison(comparison: Comparison, before: EvalResult, after: EvalResult): string {
  const header = ["brief", "outcome", "merged", "attempts", "cost", "tokens", "wall", "qa", "rejections", "design"]
  const lines: string[][] = []
  for (const brief of comparison.briefs) {
    lines.push(briefCells(`${brief.id} A`, brief.before))
    lines.push(briefCells(`${brief.id} B`, brief.after))
  }
  const widths = header.map((cell, index) => Math.max(cell.length, ...lines.map((line) => line[index].length)))
  const output = [`A: ${before.resultId}`, `B: ${after.resultId}`, ...comparison.warnings.map((warning) => `warning: ${warning}`), "", row(header, widths), ...lines.map((line) => row(line, widths))]
  const total = (result: EvalResult, ids: Set<string>) => result.briefs.filter((brief) => ids.has(brief.id)).reduce((sum, brief) => sum + brief.costUsd, 0)
  const ids = new Set(comparison.briefs.map((brief) => brief.id))
  output.push("", `total cost: A $${total(before, ids).toFixed(2)}, B $${total(after, ids).toFixed(2)}`)
  if (comparison.missing.length) output.push(`only in one result: ${comparison.missing.join(", ")}`)
  const regressed = comparison.briefs.filter((brief) => brief.regressions.length)
  output.push(regressed.length ? `regressions:\n${regressed.map((brief) => `  ${brief.id}: ${brief.regressions.join("; ")}`).join("\n")}` : "no regressions")
  return output.join("\n")
}

export function hasRegressions(comparison: Comparison): boolean {
  return comparison.briefs.some((brief) => brief.regressions.length > 0)
}
