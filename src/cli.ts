#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { loadConfig, planningPhases } from "./config.ts"
import { runDoctor } from "./doctor.ts"
import { currentTunnelUrl, deployProject, undeployProject } from "./deploy.ts"
import { approvePhase, createProject, openProjectStore, retryTask, withProjectStore } from "./project.ts"
import { compareResults, defaultEvalsDir, evalTiers, formatComparison, hasRegressions, listBriefs, readBaseYaml, runEval, type EvalResult, type EvalTier } from "./evals.ts"
import { runProject } from "./run.ts"
import { startUi } from "./ui/server.ts"

const usage = `Usage:
  agent-team init <projectDir> --brief <file>
  agent-team run <projectDir>
  agent-team status <projectDir>
  agent-team approve <projectDir> <phase>
  agent-team retry <projectDir> <taskId>
  agent-team reset-cooldowns <projectDir>
  agent-team deploy <projectDir>
  agent-team undeploy <projectDir>
  agent-team ui <runsDir> [--port 4400] [--host 127.0.0.1]
  agent-team doctor <runsDir> [--once]
  agent-team eval run [--tier smoke|full] [--brief <id>]... [--config <file>] [--label <name>] [--out <evalsDir>] [--max-usd <n>] [--clean] [--yes]
  agent-team eval compare <resultA.json> <resultB.json> [--allow-brief-change]`

function init(projectDir: string, briefPath: string | undefined): void {
  if (!briefPath) throw new Error("init needs --brief <file>")
  createProject(projectDir, readFileSync(briefPath, "utf8"))
  console.log(`Created ${projectDir}. Edit pipeline.yaml if needed, then: agent-team run ${projectDir}`)
}

async function run(projectDir: string): Promise<void> {
  const store = openProjectStore(projectDir)
  const controller = new AbortController()
  const onInterrupt = () => {
    if (controller.signal.aborted) process.exit(130)
    store.log("run", "interrupt received; stopping agents and cleaning up (press Ctrl+C again to force)")
    controller.abort()
  }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onInterrupt)

  const outcome = await runProject(projectDir, store, controller.signal)
  process.exitCode = outcome === "failed" ? 1 : outcome === "paused" ? 75 : 0
}

function status(projectDir: string): void {
  const store = openProjectStore(projectDir)
  const phases = new Map(store.phases().map((phase) => [phase.name, phase.status]))
  console.log("Phases")
  for (const phase of [...planningPhases, "qa", "deploy"]) console.log(`  ${phase.padEnd(13)} ${phases.get(phase) ?? "pending"}`)
  const tasks = store.tasks()
  if (tasks.length) {
    console.log("Tasks")
    for (const task of tasks) {
      const failure = task.status === "blocked" && task.lastFailure ? `  ${task.lastFailure.split("\n")[0].slice(0, 100)}` : ""
      console.log(`  ${task.id.padEnd(6)} ${task.status.padEnd(8)} attempts=${task.attempts}${failure}`)
    }
  }
  const liveUrl = currentTunnelUrl(projectDir)
  if (liveUrl) console.log(`Live preview: ${liveUrl}`)
  const cooling = store.runnerHealth().filter((entry) => entry.until > Date.now())
  if (cooling.length) {
    console.log("Runners cooling down")
    for (const entry of cooling) console.log(`  ${entry.runner.padEnd(8)} until ${new Date(entry.until).toISOString()} (${entry.reason})`)
  }
  const costs = store.costByRole()
  if (costs.length) {
    console.log("Cost (reported by runners; codex reports none)")
    for (const cost of costs) console.log(`  ${cost.role.padEnd(10)} runs=${cost.runs} usd=${cost.costUsd}`)
  }
}

function approve(projectDir: string, phase: string | undefined): void {
  withProjectStore(projectDir, (store) => approvePhase(projectDir, store, phase))
}

function retry(projectDir: string, taskId: string | undefined): void {
  withProjectStore(projectDir, (store) => retryTask(store, taskId))
}

async function deploy(projectDir: string): Promise<void> {
  const store = openProjectStore(projectDir)
  const { url } = await deployProject(projectDir, store)
  if (!url) process.exitCode = 1
}

function resetCooldowns(projectDir: string): void {
  const store = openProjectStore(projectDir)
  store.clearCooldowns()
  store.log("harness", "runner cooldowns cleared")
}

async function doctor(runsDir: string, once: boolean): Promise<void> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  console.log(`[doctor] watching ${runsDir}${once ? " (one check)" : ""}`)
  await runDoctor({ runsDir, once, signal: controller.signal })
}

interface EvalFlags {
  tier?: string
  brief?: string[]
  config?: string
  label?: string
  out?: string
  "max-usd"?: string
  clean?: boolean
  yes?: boolean
  "allow-brief-change"?: boolean
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim())
  } finally {
    prompt.close()
  }
}

async function evalRun(flags: EvalFlags): Promise<void> {
  const tier = (flags.tier ?? "smoke") as EvalTier
  if (!evalTiers.includes(tier)) throw new Error(`--tier must be ${evalTiers.join(" or ")}`)
  const maxUsd = flags["max-usd"] === undefined ? null : Number(flags["max-usd"])
  if (maxUsd !== null && !(maxUsd > 0)) throw new Error("--max-usd must be a number above 0")
  if (flags.label !== undefined && !/^[A-Za-z0-9._-]{1,40}$/.test(flags.label)) throw new Error("--label must be 1 to 40 letters, digits, dots, dashes, or underscores")
  const briefs = listBriefs(tier, flags.brief ?? [])
  if (!briefs.length) throw new Error("no briefs selected")
  const plannedUsd = briefs.reduce((sum, brief) => sum + brief.budgetUsd, 0)
  console.log(`[eval] ${briefs.length} briefs (${briefs.map((brief) => brief.id).join(", ")}), planned maximum spend $${plannedUsd.toFixed(2)}${maxUsd !== null ? `, capped at $${maxUsd}` : ""}`)
  if (!flags.yes && !(await confirm("Start? [y/N] "))) return

  const controller = new AbortController()
  const onInterrupt = () => {
    if (controller.signal.aborted) process.exit(130)
    console.log("[eval] interrupt received; stopping the current brief (press Ctrl+C again to force)")
    controller.abort()
  }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onInterrupt)
  const { result, path } = await runEval({
    evalsDir: resolve(flags.out ?? defaultEvalsDir),
    tier,
    briefs,
    baseYaml: readBaseYaml(flags.config),
    label: flags.label ?? null,
    maxUsd,
    clean: flags.clean ?? false,
    signal: controller.signal,
    runProject,
  })
  console.log(`[eval] result: ${path}`)
  process.exitCode = !result.aborted && result.briefs.every((brief) => brief.outcome === "completed") ? 0 : 1
}

function evalCompare(paths: string[], flags: EvalFlags): void {
  if (paths.length !== 2) throw new Error("eval compare needs two result files")
  const [before, after] = paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as EvalResult)
  const comparison = compareResults(before, after, flags["allow-brief-change"] ?? false)
  console.log(formatComparison(comparison, before, after))
  if (hasRegressions(comparison)) process.exitCode = 1
}

async function main(): Promise<void> {
  if (process.argv[2] === "eval") return evalCommand()
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { brief: { type: "string" }, port: { type: "string" }, host: { type: "string" }, once: { type: "boolean" } } })
  const [command, target, extra] = positionals
  if (!command || !target) {
    console.log(usage)
    process.exitCode = 1
    return
  }
  const projectDir = resolve(target)
  switch (command) {
    case "init":
      return init(projectDir, values.brief)
    case "run":
      return run(projectDir)
    case "status":
      return status(projectDir)
    case "approve":
      return approve(projectDir, extra)
    case "retry":
      return retry(projectDir, extra)
    case "reset-cooldowns":
      return resetCooldowns(projectDir)
    case "deploy":
      return deploy(projectDir)
    case "undeploy":
      return undeployProject(projectDir, openProjectStore(projectDir))
    case "ui":
      startUi({ runsDir: projectDir, port: Number(values.port ?? 4400), host: values.host })
      return
    case "doctor":
      return doctor(projectDir, values.once ?? false)
    default:
      console.log(usage)
      process.exitCode = 1
  }
}

async function evalCommand(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      tier: { type: "string" },
      brief: { type: "string", multiple: true },
      config: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      "max-usd": { type: "string" },
      clean: { type: "boolean" },
      yes: { type: "boolean" },
      "allow-brief-change": { type: "boolean" },
    },
  })
  const [subcommand, ...rest] = positionals
  if (subcommand === "run") return evalRun(values)
  if (subcommand === "compare") return evalCompare(rest, values)
  console.log(usage)
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
