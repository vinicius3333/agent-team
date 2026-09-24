import { test } from "node:test"
import assert from "node:assert/strict"
import { claudeErrorText, toClaudeTools } from "../src/runners/claude.ts"

test("claudeErrorText prefers the result text", () => {
  assert.equal(claudeErrorText({ is_error: true, result: "Invalid API key" }), "Invalid API key")
})

test("claudeErrorText falls back to the errors array when result is missing", () => {
  const output = { is_error: true, subtype: "error_max_budget_usd", errors: ["Reached maximum budget ($2)"] }
  assert.equal(claudeErrorText(output), "Reached maximum budget ($2)")
})

test("claudeErrorText falls back to the subtype when there is no message", () => {
  assert.equal(claudeErrorText({ is_error: true, subtype: "error_max_turns" }), "error_max_turns")
})

test("toClaudeTools escapes literal brackets in path rules", () => {
  assert.deepEqual(toClaudeTools(["edit"], ["src/app/api/groups/[groupId]/route.ts"]), ["Edit(./src/app/api/groups/\\[groupId\\]/route.ts)"])
})
