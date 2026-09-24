import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { projectSlug, removeContainers, removeNetwork } from "./deploy.ts"
import type { DemoAccess } from "./access.ts"
import { parseDesignScreens, parseLoginRoute, routeSlug, type QaScreen } from "./qa.ts"
import { captureApp, loginFailures, mobileFailures, type ScreenshotContainers, type VisualReport } from "./screenshots.ts"
import type { Task } from "./tasks.ts"
import { stackFile } from "./templates.ts"

// outDir holds the screenshots and report.json of a passed check, for the visual review.
export type SmokeResult = { kind: "passed"; routes: number; outDir?: string } | { kind: "failed"; reason: string } | { kind: "skipped"; reason: string }

export type SmokeCheck = (input: { projectDir: string; worktree: string; task: Task; attempt: number; signal: AbortSignal; access?: DemoAccess }) => Promise<SmokeResult>

const appAlias = "app"
const maxConsoleErrors = 5

// Underscores never appear in QA, deploy, or agent container names (their slugs keep only [a-z0-9-]), so these cannot clash.
export function smokeContainerNames(projectDir: string): ScreenshotContainers {
  const slug = projectSlug(projectDir)
  return { app: `agent-team_smoke_${slug}_app`, shot: `agent-team_smoke_${slug}_shot`, network: `agent-team_smoke_${slug}_net` }
}

// designScreens marks which routes need the demo account; a route docs/design.md does not list loads logged out.
export function smokeScreens(task: Task, designScreens: QaScreen[] = []): { route: string; slug: string; signedIn: boolean }[] {
  const routes = task.routes?.length ? [...new Set(task.routes)] : ["/"]
  return routes.map((route, index) => ({
    route,
    slug: `${String(index + 1).padStart(2, "0")}-${routeSlug(route)}`,
    signedIn: designScreens.some((screen) => screen.route === route && screen.signedIn),
  }))
}

export function smokeFailures(report: VisualReport): string[] {
  const failures: string[] = []
  for (const route of report.routes) {
    if (route.error) failures.push(`${route.route} did not load: ${route.error}`)
    else if ((route.status ?? 0) >= 400) failures.push(`${route.route} answered HTTP ${route.status}`)
    if (route.consoleErrors.length) {
      const shown = route.consoleErrors.slice(0, maxConsoleErrors).map((message) => `  - ${message}`)
      const more = route.consoleErrors.length > maxConsoleErrors ? [`  - and ${route.consoleErrors.length - maxConsoleErrors} more`] : []
      failures.push([`${route.route} logged console errors:`, ...shown, ...more].join("\n"))
    }
  }
  return [...failures, ...loginFailures(report), ...mobileFailures(report)]
}

// Copies the worktree's tracked and new files (not ignored ones such as node_modules), so installing and building
// the app never writes into the worktree that is about to be committed.
function snapshotWorktree(worktree: string, target: string): void {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const files = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean)
  for (const file of files) {
    if (!existsSync(join(worktree, file))) continue
    mkdirSync(dirname(join(target, file)), { recursive: true })
    cpSync(join(worktree, file), join(target, file))
  }
}

// Starts the task's worktree as deploy would and loads the task's routes in a browser, on desktop and mobile.
// Output goes to .agent-team/smoke/<task>-<attempt>/.
export const runUiSmoke: SmokeCheck = async ({ projectDir, worktree, task, attempt, signal, access }) => {
  if (!existsSync(join(worktree, "deploy.json")) && !existsSync(join(worktree, stackFile))) return { kind: "skipped", reason: "the worktree has no deploy.json" }
  const names = smokeContainerNames(projectDir)
  const appDir = join(projectDir, ".agent-team", "smoke", "app")
  const outDir = join(projectDir, ".agent-team", "smoke", `${task.id}-${attempt}`)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  removeContainers(names.app, names.shot)
  removeNetwork(names.network)
  try {
    snapshotWorktree(worktree, appDir)
    const designPath = join(worktree, "docs/design.md")
    const design = existsSync(designPath) ? readFileSync(designPath, "utf8") : ""
    const login = access ? { route: parseLoginRoute(design), access } : undefined
    const screens = smokeScreens(task, parseDesignScreens(design))
    const report = await captureApp({ dir: appDir, outDir, screens, signal, names, label: "agent-team-smoke=1", alias: appAlias, login })
    if (report.startError) return { kind: "skipped", reason: `the app did not start: ${report.startError}` }
    const failures = smokeFailures(report)
    if (failures.length) return { kind: "failed", reason: failures.join("\n") }
    return { kind: "passed", routes: report.routes.length, outDir }
  } finally {
    removeContainers(names.app, names.shot)
    removeNetwork(names.network)
    try {
      rmSync(appDir, { recursive: true, force: true })
    } catch {}
  }
}
