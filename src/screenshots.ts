import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { commandFailure, detectDeployPlan, ensureNetwork, projectSlug, removeContainers, removeNetwork, snapshotMain, startAppContainer, waitForApp } from "./deploy.ts"
import { demoAccessEnv, type DemoAccess } from "./access.ts"
import type { QaScreen } from "./qa.ts"

const execFileAsync = promisify(execFile)
const qaContext = fileURLToPath(new URL("../docker/qa/", import.meta.url))
const screenshotTimeoutMs = 10 * 60_000

export interface LayoutReport {
  // Pixels the page scrolls sideways; any amount breaks a phone layout.
  horizontalOverflow: number
  overflowing: string[]
  // Under 24px (WCAG 2.2 AA): a defect. Tight: 24px or more but under the design system's 44px.
  smallTargets: string[]
  tightTargets: string[]
}

export interface MobileCapture {
  file: string | null
  status: number | null
  consoleErrors: string[]
  error: string | null
  layout: LayoutReport | null
}

export interface RouteReport {
  route: string
  slug: string
  file: string | null
  status: number | null
  consoleErrors: string[]
  error: string | null
  branding: string | null
  mobileBranding: string | null
  signedIn?: boolean
  // Missing in reports written before mobile capture existed.
  mobile?: MobileCapture
}

export interface VisualReport {
  baseUrl: string | null
  viewport: { width: number; height: number }
  mobileViewport?: { width: number; height: number }
  // Set when a signed-in route needed the demo account; ok false means those screenshots show the logged-out page.
  login?: { route: string; ok: boolean; error: string | null } | null
  // Set when the app never answered, so there are no screenshots.
  startError: string | null
  routes: RouteReport[]
}

export function qaContainerNames(projectDir: string) {
  const slug = projectSlug(projectDir)
  return { app: `agent-team-qa-${slug}`, shot: `agent-team-qa-shot-${slug}`, network: `agent-team-qa-net-${slug}` }
}

export async function ensureScreenshotImage(): Promise<string> {
  // The scripts are copied into the image, so they are part of what makes a build unique.
  const hash = createHash("sha256")
  for (const file of ["Dockerfile", "screenshot.mjs", "render-icons.mjs", "render-marketing.mjs"]) hash.update(readFileSync(join(qaContext, file)))
  const tag = `agent-team-qa-shot:${hash.digest("hex").slice(0, 12)}`
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

export interface LoginOptions {
  // The app's login page, from the `Login:` line of docs/design.md. Without it, signed-in routes load logged out.
  route: string | null
  access: DemoAccess
}

export interface ScreenshotContainers {
  app: string
  shot: string
  network: string
}

// Starts main the way deploy does, but without a tunnel, and screenshots every screen with Playwright.
export async function captureScreenshots(options: { projectDir: string; outDir: string; screens: QaScreen[]; signal: AbortSignal; login?: LoginOptions; ref?: string }): Promise<VisualReport> {
  const names = qaContainerNames(options.projectDir)
  removeContainers(names.app, names.shot)
  try {
    const dir = snapshotMain(options.projectDir, "qa", options.ref)
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
  screens: { route: string; slug: string; branding?: string | null; mobileBranding?: string | null; signedIn?: boolean }[]
  signal: AbortSignal
  login?: LoginOptions
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
    startAppContainer({ name: names.app, dir, plan, label: options.label, restart: false, env: demoAccessEnv(options.login?.access ?? null) })
    await execFileAsync("docker", ["network", "connect", ...(options.alias ? ["--alias", options.alias] : []), names.network, names.app])
    await waitForApp(names.app, plan.port)
  } catch (error) {
    return writeReport(outDir, { ...empty, baseUrl, startError: commandFailure(error).slice(-4000) })
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
      "-e", `ROUTES=${JSON.stringify(screens.map(({ route, slug, signedIn }) => ({ route, slug, signedIn: Boolean(signedIn) })))}`,
      ...(options.login?.route ? ["-e", `LOGIN=${JSON.stringify({ route: options.login.route, ...options.login.access })}`] : []),
      "-v", `${outDir}:/out`,
      image, "node", "/opt/qa/screenshot.mjs",
    ],
    { timeout: screenshotTimeoutMs, signal: options.signal, maxBuffer: 16 * 1024 * 1024 },
  )
  const reportPath = join(outDir, "report.json")
  if (!existsSync(reportPath)) throw new Error("the screenshot container wrote no report.json")
  const raw = JSON.parse(readFileSync(reportPath, "utf8"))
  const screensByRoute = new Map(screens.map((screen) => [screen.route, screen]))
  const routes: RouteReport[] = (raw.routes ?? []).map((entry: RouteReport) => ({
    ...entry,
    branding: screensByRoute.get(entry.route)?.branding ?? null,
    mobileBranding: screensByRoute.get(entry.route)?.mobileBranding ?? null,
  }))
  return writeReport(outDir, { ...empty, baseUrl, viewport: raw.viewport ?? empty.viewport, mobileViewport: raw.mobileViewport, login: raw.login ?? null, routes })
}

// Mobile defects that fail a check on their own, with no agent judgement: sideways scroll and tap targets under 24px.
export function mobileFailures(report: VisualReport): string[] {
  const failures: string[] = []
  const width = report.mobileViewport?.width ?? "phone"
  for (const route of report.routes) {
    const mobile = route.mobile
    if (!mobile) continue
    if (mobile.error) {
      failures.push(`${route.route} did not load on mobile: ${mobile.error}`)
      continue
    }
    const layout = mobile.layout
    if (!layout) continue
    if (layout.horizontalOverflow > 0) {
      const culprits = layout.overflowing.length ? `: ${layout.overflowing.join("; ")}` : ""
      failures.push(`${route.route} scrolls sideways by ${layout.horizontalOverflow}px at ${width}px wide${culprits}`)
    }
    if (layout.smallTargets.length) failures.push(`${route.route} has tap targets under 24px on mobile: ${layout.smallTargets.join("; ")}`)
  }
  return failures
}

// Signed-in screens are worthless when the demo account cannot log in, so that fails a check on its own.
export function loginFailures(report: VisualReport): string[] {
  const signedIn = report.routes.filter((route) => route.signedIn).map((route) => route.route)
  if (!signedIn.length) return []
  if (!report.login) return [`${signedIn.join(", ")} need a signed-in user, but docs/design.md has no \`Login: /path\` line`]
  if (!report.login.ok) return [`the demo account (DEMO_EMAIL, DEMO_PASSWORD) could not log in at ${report.login.route}: ${report.login.error}`]
  return []
}
