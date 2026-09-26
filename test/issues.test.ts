import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PipelineConfig } from "../src/config.ts"
import { issueComment, issueFingerprint, issuesPolledAtKey, issuesTick, syncIssues } from "../src/operate/issues.ts"
import { createProject, withProjectStore } from "../src/project.ts"
import { openStore, type Store } from "../src/store.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-issues-"))
let count = 0

function project(): { projectDir: string; store: Store } {
  const projectDir = join(scratch, `shop-${++count}`)
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  store.setMeta("github.repo", "acme/shop")
  return { projectDir, store }
}

function configWith(github: { enabled?: boolean; issues?: boolean } = {}): PipelineConfig {
  return { publish: { github: { enabled: github.enabled ?? true, issues: { enabled: github.issues ?? true, everyMinutes: 10 } } } } as PipelineConfig
}

const issues = [
  { number: 7, title: "Add dark mode", body: "Please add a dark theme.", url: "https://github.com/acme/shop/issues/7" },
  { number: 9, title: "x".repeat(300), body: "y".repeat(9000), url: "https://github.com/acme/shop/issues/9" },
]

function fakeGh(options: { failComments?: number } = {}) {
  const calls: string[][] = []
  let failures = options.failComments ?? 0
  const gh = (args: string[]) => {
    calls.push(args)
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues)
    if (args[0] === "issue" && args[1] === "comment" && failures > 0) {
      failures--
      throw new Error("HTTP 502")
    }
    return ""
  }
  const comments = () => calls.filter((args) => args[1] === "comment")
  return { gh, calls, comments }
}

test("issueFingerprint names the repo and issue number", () => {
  assert.equal(issueFingerprint("acme/shop", 7), "github-issue:acme/shop#7")
})

test("two labeled issues become two open findings with one comment each", () => {
  const { projectDir, store } = project()
  const { gh, calls, comments } = fakeGh()
  const result = syncIssues({ projectDir, store, config: configWith(), gh, appUrl: "https://team.example.com/", now: Date.now() })
  assert.deepEqual(result, { added: 2, commented: 2 })
  assert.deepEqual(calls[0], ["issue", "list", "--repo", "acme/shop", "--label", "agent-team", "--state", "open", "--json", "number,title,body,url", "--limit", "100"])

  const first = store.findingByFingerprint(issueFingerprint("acme/shop", 7))!
  const second = store.findingByFingerprint(issueFingerprint("acme/shop", 9))!
  assert.equal(first.source, "github")
  assert.equal(first.severity, "medium")
  assert.equal(first.status, "open")
  assert.equal(first.title, "Add dark mode")
  assert.equal(first.evidence, "https://github.com/acme/shop/issues/7")
  assert.equal(first.proposal, "Please add a dark theme.")
  assert.equal(second.title.length, 200)
  assert.equal(second.proposal.length, 8000)
  assert.equal(store.listFindings({ status: "open" }).length, 2)

  const name = projectDir.split("/").pop()
  assert.deepEqual(comments(), [
    ["issue", "comment", "7", "--repo", "acme/shop", "--body", `agent-team added this issue to the backlog of ${name} as item #${first.id}: https://team.example.com/projects/${name}/operate/next-steps#finding-${first.id}`],
    ["issue", "comment", "9", "--repo", "acme/shop", "--body", `agent-team added this issue to the backlog of ${name} as item #${second.id}: https://team.example.com/projects/${name}/operate/next-steps#finding-${second.id}`],
  ])
  assert.ok(store.meta("github.issue.7.commented"))
  assert.ok(store.meta("github.issue.9.commented"))
})

test("a second sync adds nothing and comments nothing", () => {
  const { projectDir, store } = project()
  const { gh, comments } = fakeGh()
  syncIssues({ projectDir, store, config: configWith(), gh, appUrl: "https://team.example.com" })
  assert.deepEqual(syncIssues({ projectDir, store, config: configWith(), gh, appUrl: "https://team.example.com" }), { added: 0, commented: 0 })
  assert.equal(comments().length, 2)
  assert.equal(store.listFindings().length, 2)
})

test("an approved issue item is not added again", () => {
  const { projectDir, store } = project()
  const { gh } = fakeGh()
  syncIssues({ projectDir, store, config: configWith(), gh, appUrl: null })
  store.setFindingStatus(store.findingByFingerprint(issueFingerprint("acme/shop", 7))!.id, "dismissed")
  assert.deepEqual(syncIssues({ projectDir, store, config: configWith(), gh, appUrl: null }), { added: 0, commented: 0 })
  assert.equal(store.listFindings().length, 2)
})

test("a comment that fails once is posted exactly once on the next sync", () => {
  const { projectDir, store } = project()
  const { gh, comments } = fakeGh({ failComments: 1 })
  assert.equal(syncIssues({ projectDir, store, config: configWith(), gh, appUrl: "https://team.example.com" }), null)
  assert.equal(store.meta("github.issue.7.commented") ?? "", "")
  assert.deepEqual(syncIssues({ projectDir, store, config: configWith(), gh, appUrl: "https://team.example.com" }), { added: 1, commented: 2 })
  assert.deepEqual(syncIssues({ projectDir, store, config: configWith(), gh, appUrl: "https://team.example.com" }), { added: 0, commented: 0 })
  const issue7 = comments().filter((args) => args[2] === "7")
  // The failed attempt plus the one that posted.
  assert.equal(issue7.length, 2)
  assert.equal(comments().filter((args) => args[2] === "9").length, 1)
  assert.equal(store.listFindings().length, 2)
})

test("with no appUrl the comment ends at the item number with no link", () => {
  const { projectDir, store } = project()
  const { gh, comments } = fakeGh()
  syncIssues({ projectDir, store, config: configWith(), gh, appUrl: undefined })
  const body = comments()[0].at(-1)!
  const id = store.findingByFingerprint(issueFingerprint("acme/shop", 7))!.id
  assert.equal(body, `agent-team added this issue to the backlog of ${projectDir.split("/").pop()} as item #${id}.`)
  assert.doesNotMatch(body, /http|localhost/)
  assert.equal(issueComment("shop", 3, ""), "agent-team added this issue to the backlog of shop as item #3.")
})

test("syncIssues makes no gh call when GitHub, issue polling, or the repo is missing", () => {
  const { projectDir, store } = project()
  const { gh, calls } = fakeGh()
  assert.equal(syncIssues({ projectDir, store, config: configWith({ enabled: false }), gh, appUrl: null }), null)
  assert.equal(syncIssues({ projectDir, store, config: configWith({ issues: false }), gh, appUrl: null }), null)
  store.setMeta("github.repo", "")
  assert.equal(syncIssues({ projectDir, store, config: configWith(), gh, appUrl: null }), null)
  assert.equal(calls.length, 0)
})

test("issuesTick polls a project only once per everyMinutes", () => {
  const runsDir = mkdtempSync(join(scratch, "runs-"))
  const projectDir = join(runsDir, "shop")
  createProject(projectDir, "A shop")
  const pipeline = join(projectDir, "pipeline.yaml")
  const text = readFileSync(pipeline, "utf8")
  assert.match(text, /github:\n\s+enabled: false/)
  writeFileSync(pipeline, text.replace(/(github:\n\s+enabled:) false/, "$1 true"))
  withProjectStore(projectDir, (store) => store.setMeta("github.repo", "acme/shop"))
  const lists: number[] = []
  const gh = (args: string[]) => (args[1] === "list" && lists.push(1), "[]")
  const start = Date.parse("2026-09-26T10:00:00Z")
  issuesTick({ runsDir, now: start, gh, appUrl: null })
  issuesTick({ runsDir, now: start + 5 * 60_000, gh, appUrl: null })
  issuesTick({ runsDir, now: start + 11 * 60_000, gh, appUrl: null })
  assert.equal(lists.length, 2)
  assert.equal(withProjectStore(projectDir, (store) => store.meta(issuesPolledAtKey)), new Date(start + 11 * 60_000).toISOString())
})
