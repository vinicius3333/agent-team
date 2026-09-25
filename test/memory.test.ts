import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { formatSolutions, recordSolution, searchQuery, searchSolutions } from "../src/memory.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-memory-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function solution(project: string, taskId: string, title: string, stacks: string[], overrides = {}) {
  return { project, taskId, title, acceptance: [`${title} works`], files: [`src/${taskId}.ts`], summary: `Built ${title}.`, diff: `+ // ${title}`, stacks, ...overrides }
}

test("searchQuery keeps distinct meaningful words and quotes them", () => {
  assert.equal(searchQuery("Build the checkout page with Stripe; checkout must work"), '"build" OR "checkout" OR "stripe" OR "work"')
  assert.equal(searchQuery("a to of"), null)
})

test("searchSolutions ranks by text, skips the current project, and prefers a shared stack", () => {
  const path = join(scratch, "memory.db")
  recordSolution(path, solution("shop", "T010", "Add the checkout flow with a fake payment provider", ["node", "express"]))
  recordSolution(path, solution("santa", "T020", "Fake checkout for the premium upgrade", ["node", "next"]))
  recordSolution(path, solution("blog", "T003", "Render markdown posts", ["node", "next"]))
  recordSolution(path, solution("current", "T001", "Checkout page", ["node", "next"]))
  const found = searchSolutions(path, { text: "Build the checkout with a fake payment provider", excludeProject: "current", stacks: ["node", "next"], limit: 2 })
  assert.deepEqual(found.map((entry) => `${entry.project} ${entry.taskId}`), ["santa T020", "shop T010"])
  assert.deepEqual(found[0].acceptance, ["Fake checkout for the premium upgrade works"])
  assert.deepEqual(searchSolutions(path, { text: "unrelated quantum topics", excludeProject: "x", stacks: [], limit: 2 }), [])
})

test("recording a task again replaces it, and the prompt section caps the diff", () => {
  const path = join(scratch, "replace.db")
  recordSolution(path, solution("shop", "T010", "Invite links", ["node"]))
  recordSolution(path, solution("shop", "T010", "Invite links with the public APP_URL", ["node"], { diff: "x".repeat(9000) }))
  const found = searchSolutions(path, { text: "invite links", excludeProject: "other", stacks: [], limit: 5 })
  assert.equal(found.length, 1)
  assert.equal(found[0].title, "Invite links with the public APP_URL")
  const section = formatSolutions(found, 100)!
  assert.match(section, /## Similar tasks from earlier projects[\s\S]*### shop T010/)
  assert.match(section, /\[diff truncated\]/)
  assert.equal(formatSolutions([]), null)
})
