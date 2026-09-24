import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { commandFailure, detectDeployPlan, ensureNetwork, projectSlug, removeContainers, removeNetwork, snapshotMain, startAppContainer, waitForApp } from "./deploy.ts"
import type { QaScreen } from "./qa.ts"

const execFileAsync = promisify(execFile)
const qaContext = fileURLToPath(new URL("../docker/qa/", import.meta.url))
const screenshotScript = join(qaContext, "screenshot.mjs")
const screenshotTimeoutMs = 10 * 60_000

export interface RouteReport {
  route: string
  slug: string
  file: string | null
  status: number | null
  consoleErrors: string[]
  error: string | null
  branding: string | null
}

export interface VisualReport {
  baseUrl: string | null
  viewport: { width: number; height: number }
  // Set when the app never answered, so there are no screenshots.
  startError: string | null
  routes: RouteReport[]
}

export function qaContainerNames(projectDir: string) {
  const slug = projectSlug(projectDir)
  return { app: `agent-team-qa-${slug}`, shot: `agent-team-qa-shot-${slug}`, network: `agent-team-qa-net-${slug}` }
}

async function ensureScreenshotImage(): Promise<string> {
  const dockerfile = readFileSync(join(qaContext, "Dockerfile"))
  const tag = `agent-team-qa-shot:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`
  try {
    await execFileAsync("docker", ["image", "inspect", tag])
  } catch {
    await execFileAsync("docker", ["build", "-t", tag, qaContext], { maxBuffer: 64 * 1024 * 1024 })
  }
  return tag
}

function writeReport(outDir: string, report: VisualReport): VisualReport {
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

export interface ScreenshotContainers {
  app: string
  shot: string
  network: string
}

// Starts main the way deploy does, but without a tunnel, and screenshots every screen with Playwright.
export async function captureScreenshots(options: { projectDir: string; outDir: string; screens: QaScreen[]; signal: AbortSignal }): Promise<VisualReport> {
  const names = qaContainerNames(options.projectDir)
  removeContainers(names.app, names.shot)
  try {
    const dir = snapshotMain(options.projectDir, "qa")
    return await captureApp({ ...options, dir, names, label: "agent-team-qa=1" })
  } finally {
    removeContainers(names.app, names.shot)
    removeNetwork(names.network)
  }
}

// Runs the app in `dir` and screenshots every screen. The caller removes the containers and the network.
// The app joins the apps network to install its dependencies, plus the internal network `names.network`.
// The browser joins only that internal network: it reaches the app and nothing else, not the internet.
// With `alias`, the browser reaches the app by that name instead of the container name.
export async function captureApp(options: {
  dir: string
  outDir: string
  screens: { route: string; slug: string; branding?: string | null }[]
  signal: AbortSignal
  names: ScreenshotContainers
  label: string
  alias?: string
}): Promise<VisualReport> {
  const { dir, outDir, screens, names } = options
  const empty: VisualReport = { baseUrl: null, viewport: { width: 1440, height: 900 }, startError: null, routes: [] }
  const plan = detectDeployPlan(dir)
  if (!plan) return writeReport(outDir, { ...empty, startError: "no deploy.json, npm start script, or index.html to serve" })
  const baseUrl = `http://${options.alias ?? names.app}:${plan.port}`
  try {
    ensureNetwork()
    ensureNetwork(names.network, { internal: true })
    startAppContainer({ name: names.app, dir, plan, label: options.label, restart: false })
    await execFileAsync("docker", ["network", "connect", ...(options.alias ? ["--alias", options.alias] : []), names.network, names.app])
    await waitForApp(names.app, plan.port)
  } catch (error) {
    return writeReport(outDir, { ...empty, baseUrl, startError: commandFailure(error).slice(0, 4000) })
  }

  const image = await ensureScreenshotImage()
  await execFileAsync(
    "docker",
    [
      "run",
      "--name", names.shot,
      "--label", options.label,
      "--network", names.network,
      "--init",
      "--memory", "2g", "--cpus", "2", "--pids-limit", "512", "--shm-size", "512m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000",
      "-e", "HOME=/tmp",
      "-e", `BASE_URL=${baseUrl}`,
      "-e", `ROUTES=${JSON.stringify(screens.map(({ route, slug }) => ({ route, slug })))}`,
      "-v", `${screenshotScript}:/opt/qa/screenshot.mjs:ro`,
      "-v", `${outDir}:/out`,
      image, "node", "/opt/qa/screenshot.mjs",
    ],
    { timeout: screenshotTimeoutMs, signal: options.signal, maxBuffer: 16 * 1024 * 1024 },
  )
  const reportPath = join(outDir, "report.json")
  if (!existsSync(reportPath)) throw new Error("the screenshot container wrote no report.json")
  const raw = JSON.parse(readFileSync(reportPath, "utf8"))
  const brandingByRoute = new Map(screens.map((screen) => [screen.route, screen.branding ?? null]))
  const routes: RouteReport[] = (raw.routes ?? []).map((entry: RouteReport) => ({ ...entry, branding: brandingByRoute.get(entry.route) ?? null }))
  return writeReport(outDir, { ...empty, baseUrl, viewport: raw.viewport ?? empty.viewport, routes })
}
