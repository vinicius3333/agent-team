import assert from "node:assert/strict"
import { test } from "node:test"
import { toClaudeTools } from "../src/runners/claude.ts"

test("toClaudeTools maps a plain bash tool to the unrestricted Bash tool", () => {
  assert.deepEqual(toClaudeTools(["bash"]), ["Bash"])
  assert.deepEqual(toClaudeTools(["read", "edit", "write", "bash"]), ["Read", "Glob", "Grep", "Edit", "Write", "Bash"])
})

test("toClaudeTools still maps bash:<prefix> to a prefix rule", () => {
  assert.deepEqual(toClaudeTools(["bash:npm test", "bash"]), ["Bash(npm test:*)", "Bash"])
  assert.deepEqual(toClaudeTools(["edit", "bash:git status"], ["src/**"]), ["Edit(./src/**)", "Bash(git status:*)"])
})
