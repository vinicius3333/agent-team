import assert from "node:assert/strict"
import { test } from "node:test"
import type { HarnessConfig, RoleConfig } from "../src/config.ts"
import { classifyFailure } from "../src/harness/classify.ts"
import { hostExecutor } from "../src/harness/executor.ts"
import { createHarness } from "../src/harness/harness.ts"
import type { AgentRunner, RunResult } from "../src/runners/types.ts"
import { openStore } from "../src/store.ts"
import { filesOutsideScope, orderTasks, type Task } from "../src/tasks.ts"

const config: HarnessConfig = {
  isolation: "none",
  docker: { cpus: 1, memory: "1g", pidsLimit: 64 },
  transientRetries: 1,
  backoffMs: 1,
  cooldownMs: 60_000,
  agentTimeoutMs: 1000,
}

function result(overrides: Partial<RunResult>): RunResult {
  return { status: "done", summary: "ok", costUsd: null, durationMs: 1, exitCode: 0, diagnostics: "", ...overrides }
}

function scriptedRunner(name: "claude" | "codex", results: RunResult[]): AgentRunner & { calls: number } {
  const runner = {
    name,
    calls: 0,
    async run() {
      return results[Math.min(runner.calls++, results.length - 1)]
    },
  }
  return runner
}

const job = {
  role: "worker" as const,
  subject: "T001",
  systemPrompt: "",
  taskPrompt: "",
  allowedTools: [],
  budgetUsd: 1,
  transcriptPath: () => "/tmp/agent-team-test.log",
}
const role: RoleConfig = { runner: "codex", model: "a", fallbacks: [{ runner: "claude", model: "b" }] }

test("classifies common failures", () => {
  assert.equal(classifyFailure(result({ status: "failed", diagnostics: "Not logged in · Please run /login" })), "auth")
  assert.equal(classifyFailure(result({ status: "failed", diagnostics: "Failed to authenticate: OAuth session expired and could not be refreshed" })), "auth")
  assert.equal(classifyFailure(result({ status: "failed", diagnostics: "API Error: 429 Too Many Requests" })), "rate_limit")
  assert.equal(classifyFailure(result({ status: "failed", diagnostics: "spawn codex ENOENT" })), "missing_binary")
  assert.equal(classifyFailure(result({ status: "failed", diagnostics: "stream disconnected before completion" })), "unavailable")
  assert.equal(classifyFailure(result({ status: "timeout" })), "timeout")
  assert.equal(classifyFailure(result({ status: "failed", summary: "tests still failing" })), "agent_failure")
  assert.equal(classifyFailure(result({ status: "failed", summary: "GET /me returns 401 and hits the rate limit" })), "agent_failure")
  assert.equal(classifyFailure(result({})), null)
})

test("falls back and cools down the rate-limited runner", async () => {
  const store = openStore(":memory:")
  const codex = scriptedRunner("codex", [result({ status: "failed", diagnostics: "You have hit your usage limit" })])
  const claude = scriptedRunner("claude", [result({ summary: "done by claude" })])
  const harness = createHarness({ config, store, signal: new AbortController().signal, resolveRunner: (name) => (name === "codex" ? codex : claude) })
  const outcome = await harness.run(role, job, hostExecutor("/tmp"))
  assert.equal(outcome.candidate?.runner, "claude")
  assert.equal(outcome.result.summary, "done by claude")
  assert.ok(store.runnerCooldownUntil("codex") > Date.now())

  const again = await harness.run(role, job, hostExecutor("/tmp"))
  assert.equal(again.candidate?.runner, "claude")
  assert.equal(codex.calls, 1, "cooled-down runner is skipped")
})

test("retries the same runner on transient errors", async () => {
  const store = openStore(":memory:")
  const codex = scriptedRunner("codex", [result({ status: "failed", diagnostics: "ECONNRESET" }), result({ summary: "recovered" })])
  const claude = scriptedRunner("claude", [result({})])
  const harness = createHarness({ config, store, signal: new AbortController().signal, resolveRunner: (name) => (name === "codex" ? codex : claude) })
  const outcome = await harness.run(role, job, hostExecutor("/tmp"))
  assert.equal(outcome.result.summary, "recovered")
  assert.equal(claude.calls, 0)
})

test("a cooldown cleared during the wait lets the runner go again at once", async () => {
  const store = openStore(":memory:")
  const claude = scriptedRunner("claude", [result({ status: "failed", diagnostics: "Failed to authenticate: OAuth session expired" }), result({ summary: "logged in again" })])
  const harness = createHarness({ config, store, signal: new AbortController().signal, resolveRunner: () => claude, pollMs: 10 })
  setTimeout(() => store.clearCooldowns(), 50)
  const started = Date.now()
  const outcome = await harness.run({ runner: "claude", model: "b", fallbacks: [] }, job, hostExecutor("/tmp"))
  assert.equal(outcome.result.summary, "logged in again")
  assert.ok(Date.now() - started < 5_000, "the wait ends when the cooldown is cleared, not when it runs out")
})

test("agent failures go back to the caller without fallback", async () => {
  const store = openStore(":memory:")
  const codex = scriptedRunner("codex", [result({ status: "failed", summary: "could not make tests pass" })])
  const claude = scriptedRunner("claude", [result({})])
  const harness = createHarness({ config, store, signal: new AbortController().signal, resolveRunner: (name) => (name === "codex" ? codex : claude) })
  const outcome = await harness.run(role, job, hostExecutor("/tmp"))
  assert.equal(outcome.failureClass, "agent_failure")
  assert.equal(claude.calls, 0)
})

test("orders tasks and checks scope", () => {
  const task = (id: string, dependsOn: string[], phase: Task["phase"] = "feature"): Task => ({
    id, title: id, phase, dependsOn, allowedPaths: ["src/**"], readPaths: [], acceptance: ["x"], verify: "true",
  })
  assert.deepEqual(orderTasks([task("T2", ["T1"]), task("T1", [], "foundation")]).map((t) => t.id), ["T1", "T2"])
  assert.throws(() => orderTasks([task("A", ["B"]), task("B", ["A"])]), /cycle/)
  assert.deepEqual(filesOutsideScope(["src/a.ts", "package.json"], ["src/**"]), ["package.json"])
})
