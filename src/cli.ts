#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { loadConfig, planningPhases } from "./config.ts"
import { cleanupOrphans } from "./harness/docker.ts"
import { runDoctor } from "./doctor.ts"
import { currentTunnelUrl, deployProject, undeployProject } from "./deploy.ts"
import { createGitHub } from "./github.ts"
import { createHarness, liveAgentPrefix } from "./harness/harness.ts"
import { removeAllWorkspaces } from "./harness/workspace.ts"
import { interruptPrefix } from "./notify/events.ts"
import { sendTest } from "./notify/index.ts"
import { runPipeline } from "./pipeline.ts"
import { approvePhase, createProject, openProjectStore, retryTask, withProjectStore } from "./project.ts"
import { generateSessionSecret, hashPassword, passwordMinLength } from "./ui/auth.ts"
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
  agent-team ui <runsDir> [--port 4400] [--host 127.0.0.1] [--insecure-no-auth]
  agent-team doctor <runsDir> [--once]
  agent-team notify-test <runsDir> [--channel <name>]
  agent-team hash-password
  agent-team session-secret`

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
    store.log("run", `${interruptPrefix}; stopping agents and cleaning up (press Ctrl+C again to force)`)
    controller.abort()
  }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onInterrupt)

  removeAllWorkspaces(projectDir)
  if (config.harness.isolation === "docker") await cleanupOrphans()
  const harness = createHarness({ config: config.harness, store, signal: controller.signal })
  const github = createGitHub({ projectDir, config, store })
  for (const { key } of store.metaWithPrefix(liveAgentPrefix)) store.deleteMeta(key)
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

function readHidden(question: string): Promise<string> {
  const input = process.stdin
  process.stderr.write(question)
  input.setRawMode(true)
  input.setEncoding("utf8")
  input.resume()
  return new Promise((resolve, reject) => {
    let value = ""
    const finish = (error?: Error) => {
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      process.stderr.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish()
        if (character === "\u0003" || character === "\u0004") return finish(new Error("Cancelled."))
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1)
        else value += character
      }
    }
    input.on("data", onData)
  })
}

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")
}

async function printPasswordHash(): Promise<void> {
  let password: string
  if (process.stdin.isTTY) {
    password = await readHidden("Password: ")
    if ((await readHidden("Password again: ")) !== password) throw new Error("The passwords do not match.")
  } else {
    password = await readPiped()
  }
  if (password.length < passwordMinLength) throw new Error(`Use a password of at least ${passwordMinLength} characters.`)
  console.log(hashPassword(password))
}

async function doctor(runsDir: string, once: boolean): Promise<void> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  console.log(`[doctor] watching ${runsDir}${once ? " (one check)" : ""}`)
  await runDoctor({ runsDir, once, signal: controller.signal })
}

async function notifyTest(runsDir: string, channel: string | undefined): Promise<void> {
  const results = await sendTest(runsDir, channel ?? null)
  for (const result of results) console.log(`${result.ok ? "sent  " : "failed"} ${result.channel}${result.error ? `: ${result.error}` : ""}`)
  if (!results.length) console.log("No channels in notifications.yaml")
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { brief: { type: "string" }, port: { type: "string" }, host: { type: "string" }, once: { type: "boolean" }, "insecure-no-auth": { type: "boolean" }, channel: { type: "string" } } })
  const [command, target, extra] = positionals
  if (command === "hash-password") return printPasswordHash()
  if (command === "session-secret") return console.log(generateSessionSecret())
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
      startUi({ runsDir: projectDir, port: Number(values.port ?? 4400), host: values.host, allowInsecureBind: values["insecure-no-auth"] ?? false })
      return
    case "doctor":
      return doctor(projectDir, values.once ?? false)
    case "notify-test":
      return notifyTest(projectDir, values.channel)
    default:
      console.log(usage)
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
