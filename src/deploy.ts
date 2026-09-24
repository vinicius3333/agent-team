import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { Resolver } from "node:dns/promises"
import { request } from "node:https"
import { setTimeout as sleep } from "node:timers/promises"
import { basename, join } from "node:path"
import { demoAccessEnv, ensureDemoAccess } from "./access.ts"
import { loadConfig, type PipelineConfig } from "./config.ts"
import type { Store } from "./store.ts"
import { resolveCommands, type DeployPlan } from "./templates.ts"

export type { DeployPlan }

// Runs the finished app from main in a container and exposes it through a Cloudflare quick tunnel,
// which gives a random https://<words>.trycloudflare.com URL with no account, domain, or open port.
// Quick tunnels have no uptime guarantee and get a new URL when the tunnel container restarts.

const appImage = "node:22-bookworm-slim"
const tunnelImage = "cloudflare/cloudflared:latest"
export const appNetwork = "agent-team-apps"
const startTimeoutMs = 4 * 60_000
const tunnelTimeoutMs = 90_000
const tunnelUrlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim()
}

// The app's own errors go to stderr, which docker logs replays on its stderr.
export function containerLogs(container: string, lines = 60): string {
  const result = spawnSync("docker", ["logs", "--tail", String(lines), container], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
}

export function projectSlug(projectDir: string): string {
  return basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, "-")
}

function names(projectDir: string) {
  const slug = projectSlug(projectDir)
  return { app: `agent-team-app-${slug}`, tunnel: `agent-team-tunnel-${slug}` }
}

// stack.json wins, then deploy.json (written by the architect), then package.json or a static index.html.
export function detectDeployPlan(dir: string): DeployPlan | null {
  return resolveCommands(dir).deploy
}

export function removeContainers(...containers: string[]): void {
  for (const container of containers) {
    try {
      run("docker", ["rm", "-f", container])
    } catch {}
  }
}

export function ensureNetwork(name = appNetwork, options: { internal?: boolean } = {}): void {
  try {
    run("docker", ["network", "inspect", name])
  } catch {
    run("docker", ["network", "create", ...(options.internal ? ["--internal", "--label", "agent-team-network=1"] : []), name])
  }
}

export function removeNetwork(name: string): void {
  try {
    run("docker", ["network", "rm", name])
  } catch {}
}

// Copies main (committed files only) to .agent-team/<purpose>/app, so the app never runs from a worktree agents edit.
// QA of an open change snapshots the change branch; deploy always runs main.
export function snapshotMain(projectDir: string, purpose: "deploy" | "qa", ref = "main"): string {
  const dir = join(projectDir, ".agent-team", purpose, "app")
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execFileSync("sh", ["-c", `git archive "${ref}" | tar -x -C "${dir}"`], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] })
  return dir
}

export async function waitForApp(container: string, port: number): Promise<void> {
  const probe = `fetch("http://127.0.0.1:${port}").then(() => process.exit(0), () => process.exit(1))`
  const deadline = Date.now() + startTimeoutMs
  while (Date.now() < deadline) {
    const state = run("docker", ["inspect", "-f", "{{.State.Status}}", container])
    if (state === "exited" || state === "dead") throw new Error(`app exited:\n${containerLogs(container)}`)
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

export function startAppContainer(options: { name: string; dir: string; plan: DeployPlan; label: string; restart: boolean; env?: Record<string, string> }): void {
  const { name, dir, plan } = options
  const command = [plan.install, plan.start].filter(Boolean).join(" && ")
  run("docker", [
    "run", "-d",
    "--name", name,
    "--label", options.label,
    "--network", appNetwork,
    ...(options.restart ? ["--restart", "unless-stopped"] : []),
    "--memory", "512m", "--cpus", "1", "--pids-limit", "256",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "1000:1000",
    "-e", "HOME=/tmp", "-e", `PORT=${plan.port}`, "-e", "HOST=0.0.0.0", "-e", "NODE_ENV=production",
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-v", `${dir}:/app`, "-w", "/app",
    appImage, "sh", "-c", command,
  ])
}

export function commandFailure(error: unknown): string {
  const failure = error as { stderr?: string; message: string }
  return (failure.stderr || failure.message).trim()
}

// "tunnel" means the app answered inside Docker but the public URL did not: no code change can fix that.
export type DeployResult = { url: string; error: null } | { url: null; error: string; stage: "app" | "tunnel" }

// A fresh quick-tunnel hostname can take a few seconds to resolve; wait so the URL we report works.
// It resolves through public DNS because the first lookup happens before the name exists, and the
// host resolver (for example Tailscale MagicDNS) caches that NXDOMAIN for the zone's 30-minute negative TTL.
async function waitForPublicUrl(url: string): Promise<void> {
  const deadline = Date.now() + tunnelTimeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await publicStatus(url)) < 500) return
    } catch {}
    await sleep(3000)
  }
  throw new Error(`tunnel URL ${url} did not answer`)
}

const publicResolver = new Resolver()
publicResolver.setServers(["1.1.1.1", "8.8.8.8"])

async function publicStatus(url: string): Promise<number> {
  const [address] = await publicResolver.resolve4(new URL(url).hostname)
  return new Promise((resolve, reject) => {
    const probe = request(url, { lookup: (_host, _options, callback) => callback(null, [{ address, family: 4 }]), timeout: 10_000 }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    probe.on("timeout", () => probe.destroy(new Error("timed out")))
    probe.on("error", reject)
    probe.end()
  })
}

// The app reads the public key at build time (VITE_POSTHOG_KEY) or at runtime (POSTHOG_KEY); no key, no tracking.
export function posthogEnv(config: PipelineConfig): Record<string, string> {
  const posthog = config.operate.posthog
  if (!posthog?.publicKey) return {}
  return { POSTHOG_KEY: posthog.publicKey, VITE_POSTHOG_KEY: posthog.publicKey, POSTHOG_HOST: posthog.host }
}

export async function deployProject(projectDir: string, store: Store): Promise<DeployResult> {
  const { app, tunnel } = names(projectDir)
  let stage: "app" | "tunnel" = "app"
  try {
    const dir = snapshotMain(projectDir, "deploy")
    const plan = detectDeployPlan(dir)
    if (!plan) {
      const error = "no deploy.json, npm start script, or index.html to serve"
      store.log("deploy", `failed: ${error}`)
      return { url: null, error, stage }
    }
    store.log("deploy", `starting app: ${plan.install ? `${plan.install} && ` : ""}${plan.start} (port ${plan.port})`)
    ensureNetwork()
    removeContainers(app, tunnel)
    startAppContainer({ name: app, dir, plan, label: "agent-team-app=1", restart: true, env: { ...demoAccessEnv(ensureDemoAccess(store)), ...posthogEnv(loadConfig(join(projectDir, "pipeline.yaml"))) } })
    await waitForApp(app, plan.port)
    stage = "tunnel"
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
    const reason = commandFailure(error)
    store.log("deploy", `failed: ${reason.slice(0, 500)}`)
    return { url: null, error: reason.slice(0, 4000), stage }
  }
}

export function undeployProject(projectDir: string, store: Store): void {
  const { app, tunnel } = names(projectDir)
  removeContainers(app, tunnel)
  store.setMeta("deploy.url", "")
  store.log("deploy", "stopped app and tunnel")
}
