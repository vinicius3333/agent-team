// Copies each stack template's scaffold to a temp folder and runs install, typecheck, test, build, and start.
// It needs network access for npm, so it is not part of npm test. Usage: npm run test:templates [-- <name>...]
import { spawn, spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { listTemplates, type StackTemplate } from "../src/templates.ts"

const startTimeoutMs = 60_000
const firstPort = 43_100

// Deploy installs and builds with NODE_ENV=production; workers and QA run the tests without it.
function runStep(dir: string, label: string, command: string, production: boolean): void {
  console.log(`  ${label}: ${command}`)
  const { NODE_ENV: _nodeEnv, ...baseEnv } = process.env
  const result = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8", env: production ? { ...baseEnv, NODE_ENV: "production" } : baseEnv })
  if (result.status !== 0) throw new Error(`${label} failed:\n${result.stdout}${result.stderr}`)
}

async function probeStart(dir: string, command: string, port: number): Promise<void> {
  console.log(`  start: ${command} (port ${port})`)
  const child = spawn("sh", ["-c", command], { cwd: dir, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production" }, detached: true, stdio: "ignore" })
  try {
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        if (response.status < 500) return
      } catch {}
      await sleep(500)
    }
    throw new Error(`start did not answer on port ${port} within ${startTimeoutMs / 1000}s`)
  } finally {
    // The start command runs under sh and npm, so stop the whole process group.
    if (child.pid) process.kill(-child.pid, "SIGTERM")
  }
}

async function checkTemplate(template: StackTemplate, port: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `agent-team-template-${template.name}-`))
  try {
    cpSync(join(template.dir, "scaffold"), dir, { recursive: true, filter: (source) => !["node_modules", "dist"].includes(basename(source)) })
    const { commands } = template
    runStep(dir, "install", commands.install, true)
    if (commands.typecheck) runStep(dir, "typecheck", commands.typecheck, false)
    runStep(dir, "test", commands.test, false)
    if (commands.build) runStep(dir, "build", commands.build, true)
    await probeStart(dir, commands.start, port)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const requested = process.argv.slice(2)
const templates = listTemplates().filter((template) => !requested.length || requested.includes(template.name))
let failures = 0
for (const [index, template] of templates.entries()) {
  console.log(`${template.name} v${template.version}`)
  try {
    await checkTemplate(template, firstPort + index)
    console.log("  ok")
  } catch (error) {
    failures += 1
    console.error(`  FAILED: ${(error as Error).message}`)
  }
}
if (!templates.length) console.error("no templates matched")
process.exitCode = failures || !templates.length ? 1 : 0
