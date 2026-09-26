import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { createGitHub } from "../src/github.ts"
import { createProject } from "../src/project.ts"
import { openStore } from "../src/store.ts"
import type { Task } from "../src/tasks.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-github-"))
const originalPath = process.env.PATH
after(() => {
  process.env.PATH = originalPath
  rmSync(scratch, { recursive: true, force: true })
})

// A fake gh: logs every call as one JSON line, and fails the way the real one does when told to.
const fakeGh = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs")
const { join } = require("node:path")
const dir = __dirname
const args = process.argv.slice(2)
appendFileSync(join(dir, "calls.log"), JSON.stringify(args) + "\\n")
if (args[0] === "label" && existsSync(join(dir, "fail-labels"))) {
  process.stderr.write("HTTP 403: Resource not accessible by integration\\n")
  process.exit(1)
}
if (args[0] === "issue" && args[1] === "create") {
  if (args.includes("--label") && existsSync(join(dir, "missing-labels"))) {
    process.stderr.write("could not add label: 'agent-team' not found\\n")
    process.exit(1)
  }
  process.stdin.resume()
  process.stdin.on("end", () => process.stdout.write("https://github.com/acme/app/issues/7\\n"))
  process.stdin.on("data", () => {})
} else {
  process.stdout.write("\\n")
}
`

function task(id: string): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: ["src/**"], readPaths: [], acceptance: ["works"], verify: "true" }
}

function setup(name: string, flags: string[] = []) {
  const bin = join(scratch, name, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "gh"), fakeGh)
  chmodSync(join(bin, "gh"), 0o755)
  for (const flag of flags) writeFileSync(join(bin, flag), "")
  process.env.PATH = `${bin}${delimiter}${originalPath}`

  const projectDir = join(scratch, name, "app")
  createProject(projectDir, "brief")
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: projectDir })
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  config.publish.github.enabled = true
  config.publish.github.owner = "acme"
  config.publish.github.name = "app"
  config.publish.github.board = false
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  const github = createGitHub({ projectDir, config, store })
  const calls = (): string[][] => {
    const log = join(bin, "calls.log")
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : []
  }
  return { store, github, calls }
}

test("creates the labels once on a repository that already has an origin", () => {
  const { store, github, calls } = setup("existing-origin")
  store.syncTasks(["T001", "T002"])

  github.syncTaskIssues([task("T001")])
  github.syncTaskIssues([task("T001"), task("T002")])

  const labelCalls = calls().filter((args) => args[0] === "label")
  assert.deepEqual(
    labelCalls.map((args) => args[2]),
    ["agent-team", "phase:foundation", "phase:feature", "planning", "blocked", "change"],
  )
  for (const args of labelCalls) {
    assert.ok(args.includes("--force"))
    assert.deepEqual(args.slice(-2), ["-R", "acme/app"])
  }
  assert.equal(store.meta("github.labels"), "1")
  assert.ok(!calls().some((args) => args[0] === "repo" && args[1] === "create"))
  assert.equal(store.taskIssue("T001"), 7)
  assert.equal(store.taskIssue("T002"), 7)
})

test("a failed label creation is logged and the run continues", () => {
  const { store, github, calls } = setup("label-failure", ["fail-labels"])
  store.syncTasks(["T001"])

  github.syncTaskIssues([task("T001")])

  assert.equal(store.meta("github.labels"), null)
  assert.ok(store.recentEvents(20).some((event) => event.type === "github" && event.message.startsWith("create labels failed: HTTP 403")))
  assert.equal(store.taskIssue("T001"), 7)
  assert.ok(calls().some((args) => args[0] === "issue" && args[1] === "create"))
})

test("creates the issue without labels when a label is missing", () => {
  const { store, github, calls } = setup("missing-label", ["missing-labels"])
  store.setMeta("github.labels", "1")
  store.syncTasks(["T001"])

  github.syncTaskIssues([task("T001")])

  const issueCalls = calls().filter((args) => args[0] === "issue" && args[1] === "create")
  assert.equal(issueCalls.length, 2)
  assert.ok(issueCalls[0].includes("--label"))
  assert.ok(!issueCalls[1].includes("--label"))
  assert.equal(store.taskIssue("T001"), 7)
  assert.ok(!calls().some((args) => args[0] === "label"))
  assert.ok(store.recentEvents(20).some((event) => event.message.includes("without labels")))
})
