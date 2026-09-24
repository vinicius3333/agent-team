#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { loadConfig, planningPhases, type PlanningPhase } from "./config.ts"
import { commitAll, initRepository } from "./git.ts"
import { cleanupOrphans } from "./harness/docker.ts"
import { createHarness } from "./harness/harness.ts"
import { removeAllWorkspaces } from "./harness/workspace.ts"
import { runPipeline } from "./pipeline.ts"
import { openStore } from "./store.ts"
import { startUi } from "./ui/server.ts"

const usage = `Usage:
  agent-team init <projectDir> --brief <file>
  agent-team run <projectDir>
  agent-team status <projectDir>
  agent-team approve <projectDir> <phase>
  agent-team retry <projectDir> <taskId>
  agent-team reset-cooldowns <projectDir>
  agent-team ui <runsDir> [--port 4400]`

function stateDir(projectDir: string): string {
  const dir = join(projectDir, ".agent-team")
  mkdirSync(dir, { recursive: true })
  return dir
}

function openProjectStore(projectDir: string) {
  if (!existsSync(join(projectDir, "pipeline.yaml"))) throw new Error(`${projectDir} is not an agent-team project (no pipeline.yaml)`)
  return openStore(join(stateDir(projectDir), "state.db"))
}

function init(projectDir: string, briefPath: string | undefined): void {
  if (!briefPath) throw new Error("init needs --brief <file>")
  if (existsSync(projectDir) && readdirSync(projectDir).length > 0) throw new Error(`${projectDir} already exists and is not empty`)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, "input.md"), readFileSync(briefPath, "utf8"))
  copyFileSync(new URL("../pipeline.example.yaml", import.meta.url), join(projectDir, "pipeline.yaml"))
  writeFileSync(join(projectDir, ".gitignore"), ".agent-team/\nnode_modules/\n")
  initRepository(projectDir)
  commitAll(projectDir, "chore: start project from brief")
  console.log(`Created ${projectDir}. Edit pipeline.yaml if needed, then: agent-team run ${projectDir}`)
}

async function run(projectDir: string): Promise<void> {
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const store = openProjectStore(projectDir)
  const controller = new AbortController()
  const onInterrupt = () => {
    if (controller.signal.aborted) process.exit(130)
    store.log("run", "interrupt received; stopping agents and cleaning up (press Ctrl+C again to force)")
    controller.abort()
  }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onInterrupt)

  removeAllWorkspaces(projectDir)
  if (config.harness.isolation === "docker") await cleanupOrphans()
  const harness = createHarness({ config: config.harness, store, signal: controller.signal })
  const outcome = await runPipeline({ projectDir, config, store, harness, signal: controller.signal })
  store.log("run", `finished: ${outcome}`)
  process.exitCode = outcome === "failed" ? 1 : outcome === "paused" ? 75 : 0
}

function status(projectDir: string): void {
  const store = openProjectStore(projectDir)
  const phases = new Map(store.phases().map((phase) => [phase.name, phase.status]))
  console.log("Phases")
  for (const phase of planningPhases) console.log(`  ${phase.padEnd(13)} ${phases.get(phase) ?? "pending"}`)
  const tasks = store.tasks()
  if (tasks.length) {
    console.log("Tasks")
    for (const task of tasks) {
      const failure = task.status === "blocked" && task.lastFailure ? `  ${task.lastFailure.split("\n")[0].slice(0, 100)}` : ""
      console.log(`  ${task.id.padEnd(6)} ${task.status.padEnd(8)} attempts=${task.attempts}${failure}`)
    }
  }
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
  if (!planningPhases.includes(phase as PlanningPhase)) throw new Error(`phase must be one of ${planningPhases.join(", ")}`)
  const store = openProjectStore(projectDir)
  if (store.phaseStatus(phase!) !== "awaiting_approval") throw new Error(`phase "${phase}" is not waiting for approval`)
  commitAll(projectDir, `docs(${phase}): apply human edits`)
  store.setPhase(phase!, "approved")
  store.log("gate", `phase "${phase}" approved`)
}

function retry(projectDir: string, taskId: string | undefined): void {
  if (!taskId) throw new Error("retry needs a task id")
  const store = openProjectStore(projectDir)
  store.resetTask(taskId)
  store.log("task", `${taskId} reset for retry`)
}

function resetCooldowns(projectDir: string): void {
  const store = openProjectStore(projectDir)
  store.clearCooldowns()
  store.log("harness", "runner cooldowns cleared")
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { brief: { type: "string" }, port: { type: "string" } } })
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
    case "ui":
      startUi({ runsDir: projectDir, port: Number(values.port ?? 4400) })
      return
    default:
      console.log(usage)
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
