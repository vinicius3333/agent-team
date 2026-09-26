import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeIntoMain } from "../src/harness/workspace.ts"

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

// A repo on main with app.txt and notes.txt, plus a branch `feature` that changes app.txt.
function setup(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-team-workspace-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.name", "Test"])
  git(dir, ["config", "user.email", "test@example.com"])
  writeFileSync(join(dir, "app.txt"), "one\n")
  writeFileSync(join(dir, "notes.txt"), "notes\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "init"])
  git(dir, ["checkout", "-q", "-b", "feature"])
  writeFileSync(join(dir, "app.txt"), "two\n")
  git(dir, ["commit", "-q", "-am", "feature"])
  git(dir, ["checkout", "-q", "main"])
  return dir
}

function captureLogs(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")) }
  t.after(() => { console.log = original })
  return lines
}

test("mergeIntoMain merges a clean main without stashing", (t) => {
  const dir = setup(t)
  const logs = captureLogs(t)
  mergeIntoMain(dir, "feature", "feat: feature")
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "two\n")
  assert.equal(git(dir, ["log", "-1", "--format=%s"]).trim(), "feat: feature")
  assert.equal(git(dir, ["stash", "list"]).trim(), "")
  assert.equal(logs.length, 0)
})

test("mergeIntoMain stashes dirty tracked files, merges, and logs them", (t) => {
  const dir = setup(t)
  const logs = captureLogs(t)
  writeFileSync(join(dir, "notes.txt"), "local edit\n")
  mergeIntoMain(dir, "feature", "feat: feature")
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "two\n")
  assert.equal(git(dir, ["log", "-1", "--format=%s"]).trim(), "feat: feature")
  assert.match(git(dir, ["stash", "list"]), /agent-team: auto-stash before merging feature/)
  assert.equal(git(dir, ["stash", "show", "--name-only", "stash@{0}"]).trim(), "notes.txt")
  assert.ok(logs.includes("[merge] stashed local changes: notes.txt"))
})

test("mergeIntoMain ignores untracked files the merge does not touch", (t) => {
  const dir = setup(t)
  captureLogs(t)
  writeFileSync(join(dir, "scratch.txt"), "untracked\n")
  mergeIntoMain(dir, "feature", "feat: feature")
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "two\n")
  assert.equal(readFileSync(join(dir, "scratch.txt"), "utf8"), "untracked\n")
  assert.equal(git(dir, ["stash", "list"]).trim(), "")
})

test("mergeIntoMain aborts a conflicting merge and restores the stash", (t) => {
  const dir = setup(t)
  captureLogs(t)
  writeFileSync(join(dir, "app.txt"), "main\n")
  git(dir, ["commit", "-q", "-am", "main change"])
  const head = git(dir, ["rev-parse", "HEAD"]).trim()
  writeFileSync(join(dir, "notes.txt"), "local edit\n")
  assert.throws(
    () => mergeIntoMain(dir, "feature", "feat: feature"),
    (error: Error) => error.message.includes("app.txt") && error.message.includes("notes.txt"),
  )
  assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), head)
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "main\n")
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "local edit\n")
  assert.equal(git(dir, ["stash", "list"]).trim(), "")
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), "M notes.txt")
})
