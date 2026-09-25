import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loginFailures, mobileFailures, type VisualReport } from "./screenshots.ts"

// An imported app can be broken before agent-team touches it. The baseline records how it stood at import,
// so QA fails a change only on what the change made worse.

export const baselinePath = join(".agent-team", "import", "baseline.json")
// Written when a change's QA passes; it becomes the baseline once the change merges.
export const nextBaselinePath = join(".agent-team", "import", "baseline.next.json")

export interface TestRun {
  install: string | null
  command: string | null
  passed: boolean
  output: string
}

// key is stable across runs (tests, start, route:/x, ...); message is what a person reads.
export interface GateFailure {
  key: string
  message: string
}

export interface Baseline {
  commit: string
  createdAt: string
  tests: { command: string | null; passed: boolean; failing: string[]; summary: string }
  app: { started: boolean; error: string | null }
  routes: { route: string; status: number | null; error: string | null }[]
  failures: GateFailure[]
}

export function gateFailures(tests: TestRun, visual: VisualReport | null): GateFailure[] {
  const failures: GateFailure[] = []
  if (!tests.passed) failures.push({ key: "tests", message: `tests failed (${tests.command})` })
  if (visual?.startError) failures.push({ key: "start", message: "the app did not start" })
  for (const route of visual?.routes ?? []) {
    if (route.error) failures.push({ key: `route:${route.route}`, message: `${route.route} did not load: ${route.error}` })
    else if ((route.status ?? 0) >= 400) failures.push({ key: `route:${route.route}`, message: `${route.route} answered HTTP ${route.status}` })
  }
  if (visual) {
    for (const message of loginFailures(visual)) failures.push({ key: "login", message })
    for (const message of mobileFailures(visual)) failures.push({ key: `mobile:${message.split(" ")[0]}`, message })
  }
  return failures
}

const failingTestPatterns = [
  /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/,
  /^\s*[✖✕×]\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?$/,
  /^\s*FAIL(?:ED)?\s+(\S+::\S+)/,
  /^\s*--- FAIL: (\S+)/,
  /^\s*\d+\) (.+)$/,
]

// Best effort across node:test, jest, vitest, mocha, pytest, and go. Empty when the output names no failing test.
export function failingTestNames(output: string): string[] {
  const names = new Set<string>()
  for (const line of output.split("\n")) {
    for (const pattern of failingTestPatterns) {
      const match = pattern.exec(line)
      if (match) {
        names.add(match[1].trim())
        break
      }
    }
  }
  return [...names]
}

export function createBaseline(input: { commit: string; tests: TestRun; visual: VisualReport | null; summary: string }): Baseline {
  const { tests, visual } = input
  return {
    commit: input.commit,
    createdAt: new Date().toISOString(),
    tests: { command: tests.command, passed: tests.passed, failing: tests.passed ? [] : failingTestNames(tests.output), summary: input.summary },
    app: { started: !visual?.startError, error: visual?.startError ?? null },
    routes: (visual?.routes ?? []).map((route) => ({ route: route.route, status: route.status, error: route.error })),
    failures: gateFailures(tests, visual),
  }
}

// A failure is a regression unless the baseline had the same key. Failing tests compare by name when both runs name
// them; when either run names none, a failing suite that already failed counts as pre-existing.
export function splitFailures(current: GateFailure[], testOutput: string, baseline: Baseline | null): { regressions: GateFailure[]; preexisting: GateFailure[] } {
  if (!baseline) return { regressions: current, preexisting: [] }
  const known = new Set(baseline.failures.map((failure) => failure.key))
  const regressions: GateFailure[] = []
  const preexisting: GateFailure[] = []
  for (const failure of current) {
    if (!known.has(failure.key)) {
      regressions.push(failure)
      continue
    }
    if (failure.key !== "tests") {
      preexisting.push(failure)
      continue
    }
    const failing = failingTestNames(testOutput)
    const newlyFailing = baseline.tests.failing.length ? failing.filter((name) => !baseline.tests.failing.includes(name)) : []
    if (newlyFailing.length) regressions.push({ key: "tests", message: `tests that passed at import now fail: ${newlyFailing.join("; ")}` })
    else preexisting.push(failure)
  }
  return { regressions, preexisting }
}

export function readBaseline(projectDir: string): Baseline | null {
  const path = join(projectDir, baselinePath)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as Baseline
}

export function writeBaseline(projectDir: string, baseline: Baseline, path = baselinePath): void {
  const target = join(projectDir, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`)
}

// Called after a change merges: the QA result it passed with becomes the new baseline.
export function promoteNextBaseline(projectDir: string): boolean {
  const next = join(projectDir, nextBaselinePath)
  if (!existsSync(next)) return false
  renameSync(next, join(projectDir, baselinePath))
  return true
}

// The text of the suggested cleanup change, or null when the baseline is clean.
export function cleanupRequest(baseline: Baseline): string | null {
  if (!baseline.failures.length) return null
  const lines = ["Fix the problems the import baseline found, without changing features:", ""]
  for (const failure of baseline.failures) {
    if (failure.key === "tests" && baseline.tests.failing.length) lines.push(...baseline.tests.failing.map((name) => `- the failing test "${name}"`))
    else lines.push(`- ${failure.message}`)
  }
  return lines.join("\n")
}
