import { test } from "node:test"
import assert from "node:assert/strict"
import { claudeErrorText, claudeRunner, toClaudeTools } from "../src/runners/claude.ts"
import { classifyFailure } from "../src/harness/classify.ts"
import type { Executor } from "../src/harness/executor.ts"
import type { RunRequest } from "../src/runners/types.ts"

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

function fakeExecutor(stdout: string, stderr: string, exitCode: number | null): Executor {
  return {
    kind: "host",
    workdir: "/tmp",
    hostDir: "/tmp",
    exec: async () => ({ exitCode, stdout, stderr, timedOut: false, aborted: false, durationMs: 1 }),
    dispose: async () => {},
  }
}

function request(executor: Executor): RunRequest {
  return { role: "planner", model: "opus", systemPrompt: "", taskPrompt: "", executor, allowedTools: ["read"], budgetUsd: 1, timeoutMs: 1000, transcriptPath: "/tmp/t.log" }
}

test("a Claude process that ends mid-run without a result is retried as unavailable, not blamed on the agent", async () => {
  const stdout = [
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "src/app/cadastro:\npage.tsx" }] } }),
    JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }),
  ].join("\n")
  const result = await claudeRunner.run(request(fakeExecutor(stdout, "", 137)))
  assert.equal(result.status, "failed")
  assert.match(result.summary, /ended without a result event \(exit code 137\)/)
  assert.doesNotMatch(result.summary, /tool_result/)
  assert.equal(classifyFailure(result), "unavailable")
})

test("Claude keeps Bash in the working directory so ./ path rules keep matching", async () => {
  let env: Record<string, string> | undefined
  const executor = fakeExecutor(JSON.stringify({ type: "result", result: "ok" }), "", 0)
  executor.exec = async (spec) => {
    env = spec.env
    return { exitCode: 0, stdout: JSON.stringify({ type: "result", result: "ok" }), stderr: "", timedOut: false, aborted: false, durationMs: 1 }
  }
  await claudeRunner.run(request(executor))
  assert.equal(env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, "1")
})

test("a Claude process that ends without a result keeps auth errors from stderr", async () => {
  const result = await claudeRunner.run(request(fakeExecutor("", "Not logged in. Please run /login", 1)))
  assert.equal(classifyFailure(result), "auth")
})
