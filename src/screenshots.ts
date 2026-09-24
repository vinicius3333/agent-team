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

// Starts main the way deploy does, but without a tunnel, and screenshots every screen with Playwright.
// The app joins the apps network to install its dependencies, plus a per-project internal network.
// The browser joins only that internal network: it reaches the app and nothing else, not the internet.
export async function captureScreenshots(options: { projectDir: string; outDir: string; screens: QaScreen[]; signal: AbortSignal }): Promise<VisualReport> {
  const { projectDir, outDir, screens } = options
  const names = qaContainerNames(projectDir)
  const empty: VisualReport = { baseUrl: null, viewport: { width: 1440, height: 900 }, startError: null, routes: [] }
  removeContainers(names.app, names.shot)
  try {
    const dir = snapshotMain(projectDir, "qa")
    const plan = detectDeployPlan(dir)
    if (!plan) return writeReport(outDir, { ...empty, startError: "no deploy.json, npm start script, or index.html to serve" })
    const baseUrl = `http://${names.app}:${plan.port}`
    try {
      ensureNetwork()
      ensureNetwork(names.network, { internal: true })
      startAppContainer({ name: names.app, dir, plan, label: "agent-team-qa=1", restart: false })
      await execFileAsync("docker", ["network", "connect", names.network, names.app])
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
        "--label", "agent-team-qa=1",
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
    const brandingByRoute = new Map(screens.map((screen) => [screen.route, screen.branding]))
    const routes: RouteReport[] = (raw.routes ?? []).map((entry: RouteReport) => ({ ...entry, branding: brandingByRoute.get(entry.route) ?? null }))
    return writeReport(outDir, { ...empty, baseUrl, viewport: raw.viewport ?? empty.viewport, routes })
  } finally {
    removeContainers(names.app, names.shot)
    removeNetwork(names.network)
  }
}
