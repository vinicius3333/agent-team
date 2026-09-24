import { extractJsonObject } from "./json.ts"
import type { Store } from "./store.ts"
import { validateTasks, type Task } from "./tasks.ts"

export const designSystemRoute = "/design-system"

export interface QaScreen {
  route: string
  slug: string
  // Branding image file name (in design/branding/) the designer matched to this screen, if any.
  branding: string | null
  // From an `Access: signed in` line: the screenshot logs in with the demo account first.
  signedIn: boolean
}

export interface QaFinding {
  title: string
  detail: string
  screen: string
}

export type QaVerdict = { verdict: "pass"; findings: QaFinding[]; tasks: [] } | { verdict: "fail"; findings: QaFinding[]; tasks: Task[] }

export type QaRoundResult =
  | { kind: "pass"; findings: QaFinding[] }
  | { kind: "fail"; findings: QaFinding[]; tasks: Task[] }
  // The QA reviewer never produced a usable verdict; a human has to look.
  | { kind: "invalid"; reason: string }
  | { kind: "infrastructure"; reason: string }

export type QaOutcome = "completed" | "paused" | "failed" | "awaiting_approval"

const routeLinePattern = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*routes?\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?(.*)$/i
const brandingLinePattern = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*branding(?:\s+image)?\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?(.*)$/i
const accessLinePattern = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*access\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?(.*)$/i
const loginLinePattern = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*login(?:\s+route)?\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*`?(\/[A-Za-z0-9\-._~/]*)`?/i
const brandingFilePattern = /([A-Za-z0-9._-]+\.(?:png|jpe?g|webp))/i
// Static paths only: a route with a parameter (/tasks/:id, /tasks/[id], /tasks/{id}) has no single page to screenshot.
const staticRoutePattern = /^\/[A-Za-z0-9\-._~/]*$/

// Reads `Route: /path` lines from docs/design.md (bold, list bullets, backticks, and several routes per line are fine),
// pairs each with the `Branding: 02-x.png` line of the same screen section, and always adds /design-system.
export function parseDesignScreens(markdown: string): QaScreen[] {
  const found: { route: string; branding: string | null; signedIn: boolean }[] = []
  let sectionStart = 0
  let sectionBranding: string | null = null
  let sectionSignedIn = false
  const assignBranding = () => {
    for (const screen of found.slice(sectionStart)) {
      screen.branding ??= sectionBranding
      screen.signedIn ||= sectionSignedIn
    }
  }
  for (const line of markdown.split("\n")) {
    if (/^#{1,3}\s/.test(line)) {
      assignBranding()
      sectionStart = found.length
      sectionBranding = null
      sectionSignedIn = false
      continue
    }
    const access = accessLinePattern.exec(line)
    if (access) {
      sectionSignedIn = /signed[\s-]*in|logged[\s-]*in|auth|private|protected/i.test(access[1]) && !/public/i.test(access[1])
      continue
    }
    const branding = brandingLinePattern.exec(line)
    if (branding) {
      sectionBranding = brandingFilePattern.exec(branding[1])?.[1] ?? sectionBranding
      continue
    }
    const route = routeLinePattern.exec(line)
    if (!route) continue
    for (const token of route[1].replace(/[`*_]/g, " ").split(/[\s,;|]+/)) {
      const cleaned = token.replace(/[.)]+$/, "")
      const normalized = cleaned.length > 1 ? cleaned.replace(/\/+$/, "") : cleaned
      if (staticRoutePattern.test(normalized) && !found.some((screen) => screen.route === normalized)) found.push({ route: normalized, branding: null, signedIn: false })
    }
  }
  assignBranding()
  if (!found.some((screen) => screen.route === designSystemRoute)) found.push({ route: designSystemRoute, branding: null, signedIn: false })
  const slugs = new Set<string>()
  return found.map((screen) => {
    const base = routeSlug(screen.route)
    let slug = base
    for (let suffix = 2; slugs.has(slug); suffix++) slug = `${base}-${suffix}`
    slugs.add(slug)
    return { ...screen, slug }
  })
}

// The `Login: /login` line of docs/design.md: the page the screenshot fills with the demo account.
export function parseLoginRoute(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const match = loginLinePattern.exec(line)
    if (match) return match[1].length > 1 ? match[1].replace(/\/+$/, "") : match[1]
  }
  return null
}

export function routeSlug(route: string): string {
  const slug = route.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "root"
}

// Reads `- install: <cmd>` and `- test: <cmd>` from the `## Commands` section the architect writes.
export function parseArchitectureCommands(markdown: string): { install: string | null; test: string | null } {
  const commands: { install: string | null; test: string | null } = { install: null, test: null }
  let inSection = false
  for (const line of markdown.split("\n")) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s+Commands\s*$/i.test(line.trim())
      continue
    }
    if (!inSection) continue
    const match = /^\s*[-*]?\s*(install|test)\s*:\s*`?(.+?)`?\s*$/i.exec(line)
    if (match) commands[match[1].toLowerCase() as "install" | "test"] = match[2].trim()
  }
  return commands
}

// Fix tasks may only touch app code: docs, contracts, and design are inputs owned by the planning phases.
const protectedPrefixes = ["docs/", "contracts/", "design/", "AGENTS.md", "CLAUDE.md"]

export function parseQaVerdict(text: string, round: number, existing: Task[]): QaVerdict {
  const parsed = extractJsonObject(text) as any
  if (parsed?.verdict !== "pass" && parsed?.verdict !== "fail") throw new Error('verdict must be "pass" or "fail"')
  if (!Array.isArray(parsed.findings ?? [])) throw new Error("findings must be an array")
  const findings: QaFinding[] = (parsed.findings ?? []).map((finding: any) => ({
    title: String(finding?.title ?? ""),
    detail: String(finding?.detail ?? ""),
    screen: String(finding?.screen ?? ""),
  }))
  if (parsed.verdict === "pass") return { verdict: "pass", findings, tasks: [] }
  if (!findings.length) throw new Error("a fail verdict needs at least one finding")
  return { verdict: "fail", findings, tasks: validateFixTasks(parsed.tasks, round, existing) }
}

// The harness numbers fix tasks itself, so a missing or odd id from the reviewer cannot fail the round.
export function validateFixTasks(value: unknown, round: number, existing: Task[]): Task[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("a fail verdict needs at least one fix task")
  const tasks = value.map((task, index) => ({ ...(task ?? {}), id: `Q${round}${String(index + 1).padStart(2, "0")}` }))
  const existingIds = new Set(existing.map((task) => task.id))
  const errors: string[] = []
  for (const task of tasks) {
    for (const dependency of Array.isArray(task.dependsOn) ? task.dependsOn : []) {
      if (!existingIds.has(dependency)) errors.push(`${task.id}: may depend only on existing tasks, not ${dependency}`)
    }
    for (const path of Array.isArray(task.allowedPaths) ? task.allowedPaths : []) {
      if (typeof path !== "string" || protectedPrefixes.some((prefix) => path.startsWith(prefix))) errors.push(`${task.id}: allowedPaths may not include ${path}`)
    }
  }
  if (errors.length) throw new Error(`invalid fix tasks:\n- ${errors.join("\n- ")}`)
  validateTasks([...existing, ...tasks])
  return tasks as Task[]
}

export function formatFindings(findings: QaFinding[]): string {
  return findings.map((finding) => `${finding.screen ? `[${finding.screen}] ` : ""}${finding.title}: ${finding.detail}`).join("\n")
}

export interface QaLoopSteps {
  runRound(round: number): Promise<QaRoundResult>
  // Appends the fix tasks to tasks.json on main.
  applyFixes(round: number, tasks: Task[]): Promise<void>
  // Runs every pending task through the worker and reviewer.
  build(): Promise<QaOutcome>
  deploy(): Promise<QaOutcome>
}

// Rounds are numbered across runs (meta qa.round), but maxRounds counts failures in this run only,
// so resuming after "failed" gives QA a fresh set of rounds.
export async function runQaLoop(store: Store, maxRounds: number, steps: QaLoopSteps): Promise<QaOutcome> {
  if (store.phaseStatus("qa") === "approved") return steps.deploy()
  store.setPhase("qa", "running")
  for (let failures = 0; ; ) {
    const round = Number(store.meta("qa.round") ?? 0) + 1
    store.setMeta("qa.round", String(round))
    store.log("qa", `round ${round}: running tests and screenshots`)
    const result = await steps.runRound(round)
    if (result.kind === "infrastructure") {
      store.setPhase("qa", "pending")
      store.log("qa", `round ${round}: paused: ${result.reason.slice(0, 300)}`)
      return "paused"
    }
    if (result.kind === "invalid") {
      store.setPhase("qa", "failed")
      store.log("qa", `round ${round}: no usable verdict: ${result.reason.slice(0, 500)}`)
      return "failed"
    }
    if (result.kind === "pass") {
      store.setPhase("qa", "approved")
      store.log("qa", `round ${round}: pass`)
      return steps.deploy()
    }
    failures += 1
    store.log("qa", `round ${round}: fail, ${result.findings.length} findings, ${result.tasks.length} fix tasks (${result.tasks.map((task) => task.id).join(", ")})\n${formatFindings(result.findings).slice(0, 3000)}`)
    // The fix tasks are recorded even on the last round, so a resumed run builds them before QA runs again.
    try {
      await steps.applyFixes(round, result.tasks)
    } catch (error) {
      store.setPhase("qa", "pending")
      store.log("qa", `round ${round}: could not add the fix tasks: ${(error as Error).message.slice(0, 300)}`)
      return "paused"
    }
    if (failures >= maxRounds) {
      store.setPhase("qa", "failed")
      store.log("qa", `stopped after ${failures} failed rounds; the fix tasks from round ${round} are queued. Review them, then resume the run`)
      return "failed"
    }
    const built = await steps.build()
    if (built !== "completed") {
      store.setPhase("qa", "pending")
      return built
    }
  }
}
