import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { basename, join } from "node:path"
import type { Store } from "./store.ts"

// Runs the finished app from main in a container and exposes it through a Cloudflare quick tunnel,
// which gives a random https://<words>.trycloudflare.com URL with no account, domain, or open port.
// Quick tunnels have no uptime guarantee and get a new URL when the tunnel container restarts.

const appImage = "node:22-bookworm-slim"
const tunnelImage = "cloudflare/cloudflared:latest"
const appNetwork = "agent-team-apps"
const defaultPort = 3000
const startTimeoutMs = 4 * 60_000
const tunnelTimeoutMs = 90_000
const tunnelUrlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

interface DeployPlan {
  install: string | null
  start: string
  port: number
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim()
}

function names(projectDir: string) {
  const slug = basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, "-")
  return { app: `agent-team-app-${slug}`, tunnel: `agent-team-tunnel-${slug}` }
}

// deploy.json (written by the architect) wins; otherwise infer from package.json or a static index.html.
export function detectDeployPlan(dir: string): DeployPlan | null {
  const manifestPath = join(dir, "deploy.json")
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (typeof manifest.start !== "string") throw new Error("deploy.json needs a start command")
    return { install: manifest.install ?? null, start: manifest.start, port: manifest.port ?? defaultPort }
  }
  const packagePath = join(dir, "package.json")
  const install = existsSync(join(dir, "package-lock.json")) ? "npm ci --no-audit --no-fund" : existsSync(packagePath) ? "npm install --no-audit --no-fund" : null
  if (existsSync(packagePath)) {
    const scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts ?? {}
    if (scripts.start) return { install, start: "npm start", port: defaultPort }
  }
  for (const staticDir of ["dist", "public", "."]) {
    if (existsSync(join(dir, staticDir, "index.html"))) {
      return { install: null, start: `npx --yes serve -s ${staticDir} -l tcp://0.0.0.0:${defaultPort}`, port: defaultPort }
    }
  }
  return null
}

function removeContainers(...containers: string[]): void {
  for (const container of containers) {
    try {
      run("docker", ["rm", "-f", container])
    } catch {}
  }
}

function ensureNetwork(): void {
  try {
    run("docker", ["network", "inspect", appNetwork])
  } catch {
    run("docker", ["network", "create", appNetwork])
  }
}

function snapshot(projectDir: string): string {
  const dir = join(projectDir, ".agent-team", "deploy", "app")
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execFileSync("sh", ["-c", `git archive main | tar -x -C "${dir}"`], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] })
  return dir
}

async function waitForApp(container: string, port: number): Promise<void> {
  const probe = `fetch("http://127.0.0.1:${port}").then(() => process.exit(0), () => process.exit(1))`
  const deadline = Date.now() + startTimeoutMs
  while (Date.now() < deadline) {
    const state = run("docker", ["inspect", "-f", "{{.State.Status}}", container])
    if (state === "exited" || state === "dead") throw new Error(`app exited:\n${run("docker", ["logs", "--tail", "40", container])}`)
    try {
      run("docker", ["exec", container, "node", "-e", probe])
      return
    } catch {
      await sleep(3000)
    }
  }
  throw new Error(`app did not answer on port ${port} within ${startTimeoutMs / 1000}s`)
}

export function currentTunnelUrl(projectDir: string): string | null {
  // cloudflared logs to stderr, so read both streams.
  const logs = spawnSync("docker", ["logs", names(projectDir).tunnel], { encoding: "utf8" })
  const matches = `${logs.stdout ?? ""}${logs.stderr ?? ""}`.match(new RegExp(tunnelUrlPattern, "g"))
  return matches?.at(-1) ?? null
}

async function waitForTunnelUrl(projectDir: string): Promise<string> {
  const deadline = Date.now() + tunnelTimeoutMs
  while (Date.now() < deadline) {
    const url = currentTunnelUrl(projectDir)
    if (url) return url
    await sleep(2000)
  }
  throw new Error("tunnel did not report a URL")
}

export type DeployResult = { url: string; error: null } | { url: null; error: string }

// A fresh quick-tunnel hostname can take a few seconds to resolve; wait so the URL we report works.
async function waitForPublicUrl(url: string): Promise<void> {
  const deadline = Date.now() + tunnelTimeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (response.status < 500) return
    } catch {}
    await sleep(3000)
  }
  throw new Error(`tunnel URL ${url} did not answer`)
}

export async function deployProject(projectDir: string, store: Store): Promise<DeployResult> {
  const { app, tunnel } = names(projectDir)
  try {
    const dir = snapshot(projectDir)
    const plan = detectDeployPlan(dir)
    if (!plan) {
      const error = "no deploy.json, npm start script, or index.html to serve"
      store.log("deploy", `failed: ${error}`)
      return { url: null, error }
    }
    store.log("deploy", `starting app: ${plan.install ? `${plan.install} && ` : ""}${plan.start} (port ${plan.port})`)
    ensureNetwork()
    removeContainers(app, tunnel)
    const command = [plan.install, plan.start].filter(Boolean).join(" && ")
    run("docker", [
      "run", "-d",
      "--name", app,
      "--label", "agent-team-app=1",
      "--network", appNetwork,
      "--restart", "unless-stopped",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000",
      "-e", "HOME=/tmp", "-e", `PORT=${plan.port}`, "-e", "HOST=0.0.0.0", "-e", "NODE_ENV=production",
      "-v", `${dir}:/app`, "-w", "/app",
      appImage, "sh", "-c", command,
    ])
    await waitForApp(app, plan.port)
    run("docker", [
      "run", "-d",
      "--name", tunnel,
      "--label", "agent-team-app=1",
      "--network", appNetwork,
      "--restart", "unless-stopped",
      "--memory", "128m",
      tunnelImage, "tunnel", "--no-autoupdate", "--url", `http://${app}:${plan.port}`,
    ])
    const url = await waitForTunnelUrl(projectDir)
    await waitForPublicUrl(url)
    store.setMeta("deploy.url", url)
    store.log("deploy", `live at ${url}`)
    return { url, error: null }
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    const reason = (failure.stderr || failure.message).trim()
    store.log("deploy", `failed: ${reason.slice(0, 500)}`)
    return { url: null, error: reason.slice(0, 4000) }
  }
}

export function undeployProject(projectDir: string, store: Store): void {
  const { app, tunnel } = names(projectDir)
  removeContainers(app, tunnel)
  store.setMeta("deploy.url", "")
  store.log("deploy", "stopped app and tunnel")
}
