import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { cleanupRequest, createBaseline, failingTestNames, readBaseline, splitFailures, type Baseline } from "../src/baseline.ts"
import { loadConfig } from "../src/config.ts"
import { createGitHub } from "../src/github.ts"
import type { AgentJob, Harness, HarnessOutcome } from "../src/harness/harness.ts"
import { dismissCleanupChange, importProject, parseGitHubRepository, startCleanupChange, type ImportOptions } from "../src/import.ts"
import { runPipeline } from "../src/pipeline.ts"
import { buildComplete, importCleanupKey, importDoneKey, openChange, openProjectStore, ProjectError } from "../src/project.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-import-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function writeFile(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true })
  writeFileSync(join(dir, path), content)
}

function sourceRepository(name: string, branch = "master"): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ["init", "-q", "-b", branch])
  git(dir, ["config", "user.name", "test"])
  git(dir, ["config", "user.email", "test@localhost"])
  writeFile(dir, "package.json", '{"name":"invoicer","scripts":{"start":"node server.js"}}\n')
  writeFile(dir, "server.js", "console.log('hi')\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "initial"])
  return dir
}

const options = (source: string, overrides: Partial<ImportOptions> = {}): ImportOptions => ({ source, urls: [], github: "none", target: "api", gates: [], deploy: false, ...overrides })

test("failingTestNames reads the common reporters", () => {
  const output = [
    "not ok 3 - totals include tax",
    "✖ overdue invoices are filtered (1.2ms)",
    "  ✕ exports CSV (3 ms)",
    "FAILED tests/test_api.py::test_login - AssertionError",
    "--- FAIL: TestHealth (0.00s)",
    "  1) reports load",
    "ok 4 - passes",
  ].join("\n")
  assert.deepEqual(failingTestNames(output), ["totals include tax", "overdue invoices are filtered", "exports CSV", "tests/test_api.py::test_login", "TestHealth", "reports load"])
})

const failedRun = (output: string) => ({ install: null, command: "npm test", passed: false, output })

test("splitFailures keeps baseline failures out of the regressions", () => {
  const visual = { baseUrl: null, viewport: { width: 1, height: 1 }, startError: null, routes: [{ route: "/reports", slug: "reports", file: null, status: 500, consoleErrors: [], error: null, branding: null, mobileBranding: null }] }
  const baseline = createBaseline({ commit: "abc", tests: failedRun("not ok 1 - totals"), visual, summary: "" })
  assert.deepEqual(baseline.tests.failing, ["totals"])
  assert.deepEqual(baseline.failures.map((failure) => failure.key), ["tests", "route:/reports"])

  const same = splitFailures(baseline.failures, "not ok 1 - totals", baseline)
  assert.equal(same.regressions.length, 0)
  assert.equal(same.preexisting.length, 2)

  const newTest = splitFailures(baseline.failures, "not ok 1 - totals\nnot ok 2 - login", baseline)
  assert.deepEqual(newTest.regressions.map((failure) => failure.message), ["tests that passed at import now fail: login"])

  const newRoute = splitFailures([{ key: "route:/", message: "/ answered HTTP 500" }], "", baseline)
  assert.deepEqual(newRoute.regressions.map((failure) => failure.key), ["route:/"])

  assert.deepEqual(splitFailures(baseline.failures, "", null).regressions, baseline.failures)
})

test("cleanupRequest names each failing test and broken route, and is null when clean", () => {
  const clean: Baseline = { commit: "a", createdAt: "", tests: { command: null, passed: true, failing: [], summary: "" }, app: { started: true, error: null }, routes: [], failures: [] }
  assert.equal(cleanupRequest(clean), null)
  const broken = { ...clean, tests: { ...clean.tests, passed: false, failing: ["totals"] }, failures: [{ key: "tests", message: "tests failed" }, { key: "route:/reports", message: "/reports answered HTTP 500" }] }
  assert.match(cleanupRequest(broken)!, /the failing test "totals"[\s\S]*\/reports answered HTTP 500/)
})

test("parseGitHubRepository reads https and ssh URLs", () => {
  assert.deepEqual(parseGitHubRepository("https://github.com/acme/invoicer.git"), { owner: "acme", name: "invoicer" })
  assert.deepEqual(parseGitHubRepository("git@github.com:acme/invoicer.git"), { owner: "acme", name: "invoicer" })
  assert.equal(parseGitHubRepository("https://gitlab.com/acme/invoicer"), null)
})

test("importProject clones a local repository onto main without its origin", () => {
  const source = sourceRepository("clone-source")
  const projectDir = join(scratch, "clone")
  importProject(projectDir, options(source, { urls: ["https://invoicer.example.com/about"], gates: ["spec"] }))
  assert.equal(git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(git(projectDir, ["remote"]), "")
  assert.equal(git(projectDir, ["status", "--porcelain"]), "")
  assert.match(git(projectDir, ["log", "--format=%s"]), /chore: import the project into agent-team\ninitial/)
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  assert.deepEqual(config.import, { source, urls: ["https://invoicer.example.com/about"], github: "none" })
  assert.equal(config.branding.enabled, false)
  assert.equal(config.marketing.enabled, false)
  assert.deepEqual(config.autonomy.gates, ["spec"])
  assert.ok(config.harness.network.extraDomains.includes("invoicer.example.com"))
  assert.equal(readFileSync(join(projectDir, "tasks.json"), "utf8"), "[]\n")
  assert.match(readFileSync(join(projectDir, "input.md"), "utf8"), /imported from/)
})

test("importProject copies a plain folder without its dependencies", () => {
  const source = join(scratch, "plain-source")
  writeFile(source, "index.html", "<h1>hi</h1>\n")
  writeFile(source, "node_modules/left-pad/index.js", "\n")
  const projectDir = join(scratch, "plain")
  importProject(projectDir, options(source))
  assert.ok(existsSync(join(projectDir, "index.html")))
  assert.ok(!existsSync(join(projectDir, "node_modules")))
  assert.equal(git(projectDir, ["status", "--porcelain"]), "")
})

test("importProject rejects what it cannot import", () => {
  const source = sourceRepository("reject-source")
  assert.throws(() => importProject(join(scratch, "reject-1"), options(source, { github: "source" })), /Only a GitHub URL/)
  assert.throws(() => importProject(join(scratch, "reject-2"), options(source, { gates: ["plan"] })), /only at spec, architecture, design/)
  assert.throws(() => importProject(join(scratch, "reject-3"), options("relative/path")), /absolute path/)
  assert.throws(() => importProject(join(scratch, "reject-4"), options(source, { urls: ["ftp://x"] })), /not an http/)
  writeFile(source, "pipeline.yaml", "target: web\n")
  git(source, ["add", "-A"])
  git(source, ["commit", "-q", "-m", "own pipeline"])
  assert.throws(() => importProject(join(scratch, "reject-5"), options(source)), (error: unknown) => error instanceof ProjectError && /already has pipeline.yaml/.test(error.message))
})

type Reply = (job: AgentJob, workdir: string) => string

function stubHarness(replies: Partial<Record<string, Reply>>) {
  const jobs: AgentJob[] = []
  const harness = {
    async run(_role: unknown, job: AgentJob, executor: { workdir: string }): Promise<HarnessOutcome> {
      jobs.push(job)
      const summary = replies[job.role]?.(job, executor.workdir) ?? "ok"
      return { result: { status: "done", summary, costUsd: null, tokens: null, durationMs: 1, exitCode: 0, diagnostics: "" }, candidate: { runner: "claude", model: "stub" }, failureClass: null }
    },
  }
  return { harness: harness as unknown as Harness, jobs }
}

function importAgents(testCommand: string) {
  return stubHarness({
    importer: (_job, dir) => {
      writeFile(dir, "docs/import/research.md", ["## Product", "## Users", "## Stack", "## Routes", "## Commands", "## Sources", "## Open questions"].join("\n\n") + "\n")
      return "done"
    },
    pm: (_job, dir) => {
      writeFile(dir, "docs/spec.md", "# Invoicer\n\n## Problem\n\n## Users\n\n## User stories\n\n## Out of scope\n\n## Open questions\n")
      return "done"
    },
    architect: (_job, dir) => {
      writeFile(dir, "docs/architecture.md", `# Architecture\n\n## Commands\n\n- test: ${testCommand}\n`)
      writeFile(dir, "AGENTS.md", `# Agents\n\n## Commands\n\n- test: ${testCommand}\n`)
      writeFile(dir, "deploy.json", '{"install":"true","start":"node server.js","port":3000}\n')
      return "done"
    },
  })
}

async function runImportPipeline(name: string, testCommand: string) {
  const projectDir = join(scratch, name)
  importProject(projectDir, options(sourceRepository(`${name}-source`)))
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  config.learning.enabled = false
  config.harness.isolation = "none"
  const store = openProjectStore(projectDir)
  const { harness, jobs } = importAgents(testCommand)
  const outcome = await runPipeline({ projectDir, config, store, harness, github: createGitHub({ projectDir, config, store }), signal: new AbortController().signal })
  return { projectDir, store, jobs, outcome }
}

test("an import run documents the app, records the baseline, and opens the project to changes", async () => {
  const { projectDir, store, jobs, outcome } = await runImportPipeline("run-clean", "true")
  assert.equal(outcome, "completed")
  assert.deepEqual(jobs.map((job) => job.role), ["importer", "pm", "architect"])
  assert.ok(jobs[0].allowedTools.includes("web_fetch"))
  assert.match(jobs[1].taskPrompt, /Import mode/)
  for (const phase of ["research", "spec", "architecture", "design", "baseline", "branding", "marketing", "plan", "qa", "deploy"]) assert.equal(store.phaseStatus(phase), "approved", phase)
  assert.equal(store.meta(importDoneKey), "1")
  assert.equal(store.meta(importCleanupKey), null)
  assert.equal(readBaseline(projectDir)!.failures.length, 0)
  assert.ok(buildComplete(store))
  assert.ok(existsSync(join(projectDir, "docs/import/research.md")))
  assert.equal(git(projectDir, ["ls-files", "package-lock.json"]), "package-lock.json", "the install's lockfile is kept")
  assert.equal(git(projectDir, ["status", "--porcelain"]), "")
  store.close()
})

test("a failing baseline suggests a cleanup change that opens only on request", async () => {
  const { projectDir, store, outcome } = await runImportPipeline("run-broken", "false")
  assert.equal(outcome, "completed")
  const baseline = readBaseline(projectDir)!
  assert.deepEqual(baseline.failures.map((failure) => failure.key), ["tests"])
  assert.match(store.meta(importCleanupKey)!, /tests failed/)
  assert.equal(store.currentChange(), null)
  const change = startCleanupChange(projectDir, store)
  assert.equal(change.id, "C001")
  assert.match(change.request, /^Fix the problems the import baseline found/)
  assert.equal(store.meta(importCleanupKey), null)
  assert.throws(() => dismissCleanupChange(store), /no suggested cleanup/)
  store.close()
})

test("a change on an imported app passes QA despite a pre-existing failure, then advances the baseline", async () => {
  const { projectDir, store } = await runImportPipeline("run-change", "false")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  config.learning.enabled = false
  config.harness.isolation = "none"
  const importCommit = readBaseline(projectDir)!.commit
  const change = openProjectStoreChange(projectDir, store)
  const { harness, jobs } = stubHarness({
    pm: (_job, dir) => {
      writeFile(dir, `docs/changes/${change}/spec.md`, "## Change\n\n## New or changed user stories\n\n## Out of scope\n\n## Open questions\n")
      return "done"
    },
    architect: (_job, dir) => {
      writeFile(dir, `docs/changes/${change}/architecture.md`, "## Changes\n\n## New dependencies\n\n## Data migrations\n\n## Risks\n")
      return "done"
    },
    planner: (_job, dir) => {
      const task = { id: "T001", title: "health route", phase: "feature", dependsOn: [], allowedPaths: ["src/health/**"], readPaths: [], acceptance: ["works"], verify: "true" }
      writeFile(dir, `docs/changes/${change}/tasks.json`, JSON.stringify([task]))
      return "done"
    },
    worker: (_job, dir) => {
      writeFile(dir, "src/health/index.js", "export const ok = true\n")
      return "done"
    },
    reviewer: () => '```json\n{"verdict":"pass","reasons":[],"fixes":[]}\n```',
    qa: () => '```json\n{"verdict":"pass","findings":[],"tasks":[]}\n```',
  })
  const outcome = await runPipeline({ projectDir, config, store, harness, github: createGitHub({ projectDir, config, store }), signal: new AbortController().signal })
  assert.equal(outcome, "completed")
  const qaJob = jobs.find((job) => job.role === "qa")!
  assert.match(qaJob.taskPrompt, /already there when the app was imported[\s\S]*tests failed \(false\)/)
  assert.doesNotMatch(qaJob.taskPrompt, /These gates failed/)
  const verdict = JSON.parse(readFileSync(join(projectDir, ".agent-team/qa", change, "round-1/verdict.json"), "utf8"))
  assert.deepEqual(verdict.preexisting, ["tests failed (false)"])
  assert.equal(store.change(change)!.status, "merged")
  const baseline = readBaseline(projectDir)!
  assert.notEqual(baseline.commit, importCommit, "the baseline follows the merged change")
  assert.ok(!existsSync(join(projectDir, ".agent-team/import/baseline.next.json")))
  assert.match(store.meta(importCleanupKey)!, /tests failed/, "the cleanup suggestion stays while the failure does")
  store.close()
})

function openProjectStoreChange(projectDir: string, store: ReturnType<typeof openProjectStore>): string {
  return openChange(projectDir, store, "Add a health route").id
}
