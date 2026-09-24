#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { loadConfig, planningPhases } from "./config.ts"
import { cleanupOrphans } from "./harness/docker.ts"
import { runDoctor } from "./doctor.ts"
import { currentTunnelUrl, deployProject, undeployProject } from "./deploy.ts"
import { createGitHub } from "./github.ts"
import { createHarness } from "./harness/harness.ts"
import { removeAllWorkspaces } from "./harness/workspace.ts"
import { runPipeline } from "./pipeline.ts"
import { approvePhase, createProject, openProjectStore, retryTask, withProjectStore } from "./project.ts"
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
  agent-team ui <runsDir> [--port 4400]
  agent-team doctor <runsDir> [--once]`

function init(projectDir: string, briefPath: string | undefined): void {
  if (!briefPath) throw new Error("init needs --brief <file>")
  createProject(projectDir, readFileSync(briefPath, "utf8"))
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
  const github = createGitHub({ projectDir, config, store })
  store.setMeta("run.pid", String(process.pid))
  const outcome = await runPipeline({ projectDir, config, store, harness, github, signal: controller.signal }).finally(() => store.setMeta("run.pid", ""))
  store.log("run", `finished: ${outcome}`)
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

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { brief: { type: "string" }, port: { type: "string" }, once: { type: "boolean" } } })
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
      startUi({ runsDir: projectDir, port: Number(values.port ?? 4400) })
      return
    case "doctor":
      return doctor(projectDir, values.once ?? false)
    default:
      console.log(usage)
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
