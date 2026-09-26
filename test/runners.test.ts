import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { Executor } from "../src/harness/executor.ts"
import type { ProcessSpec } from "../src/runners/spawn.ts"
import { toClaudeTools } from "../src/runners/claude.ts"
import { codexRunner } from "../src/runners/codex.ts"
import type { RunRequest } from "../src/runners/types.ts"

const secret = "sk-test-secret-value-123"
const codexEvents = [
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "all done" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
].join("\n")

// Records each call and writes a transcript the way runProcess does: the command line, then the output.
function fakeExecutor(calls: Omit<ProcessSpec, "cwd">[]): Executor {
  return {
    kind: "host",
    workdir: "/work",
    hostDir: "/work",
    async exec(spec) {
      calls.push(spec)
      writeFileSync(spec.transcriptPath, `${spec.command} ${spec.args.join(" ")}\n${codexEvents}\n`)
      return { exitCode: 0, stdout: codexEvents, stderr: "", timedOut: false, aborted: false, durationMs: 1 }
    },
    dispose: async () => {},
  }
}

function codexRequest(calls: Omit<ProcessSpec, "cwd">[], codex?: RunRequest["codex"]): RunRequest {
  const dir = mkdtempSync(join(tmpdir(), "agent-team-codex-"))
  return {
    role: "worker",
    model: "gpt-test",
    systemPrompt: "system",
    taskPrompt: "task",
    executor: fakeExecutor(calls),
    allowedTools: ["read"],
    budgetUsd: 1,
    timeoutMs: 1000,
    transcriptPath: join(dir, "codex.log"),
    codex,
  }
}

const todayArgs = ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-C", "/work", "-m", "gpt-test", "-"]

test("codex runner args are unchanged without a base URL", async () => {
  const calls: Omit<ProcessSpec, "cwd">[] = []
  const result = await codexRunner.run(codexRequest(calls))
  assert.equal(result.status, "done")
  assert.deepEqual(calls[0].args, todayArgs)
})

test("codex runner passes a custom provider by env name and never the key", async (t) => {
  process.env.AGENT_TEAM_TEST_CODEX_KEY = secret
  t.after(() => delete process.env.AGENT_TEAM_TEST_CODEX_KEY)
  const calls: Omit<ProcessSpec, "cwd">[] = []
  const request = codexRequest(calls, { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "AGENT_TEAM_TEST_CODEX_KEY" })
  const result = await codexRunner.run(request)
  assert.equal(result.status, "done")
  const args = calls[0].args
  assert.ok(args.includes('model_provider="agent-team"'))
  assert.ok(args.includes('model_providers.agent-team={ name = "agent-team", base_url = "https://openrouter.ai/api/v1", env_key = "AGENT_TEAM_TEST_CODEX_KEY", wire_api = "chat" }'))
  assert.equal(args[args.indexOf('model_provider="agent-team"') - 1], "-c")
  assert.ok(!JSON.stringify(calls[0]).includes(secret), "the key is not in the args, env, or input")
  assert.ok(!readFileSync(request.transcriptPath, "utf8").includes(secret), "the key is not in the transcript")
  assert.ok(!JSON.stringify(result).includes(secret), "the key is not in the events or result")
})

test("codex runner fails before the agent starts when the key env var is unset", async () => {
  delete process.env.AGENT_TEAM_TEST_MISSING_KEY
  const calls: Omit<ProcessSpec, "cwd">[] = []
  await assert.rejects(
    codexRunner.run(codexRequest(calls, { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "AGENT_TEAM_TEST_MISSING_KEY" })),
    { message: "Set AGENT_TEAM_TEST_MISSING_KEY in the environment for the codex base URL." },
  )
  assert.equal(calls.length, 0)
})

test("toClaudeTools maps a plain bash tool to the unrestricted Bash tool", () => {
  assert.deepEqual(toClaudeTools(["bash"]), ["Bash"])
  assert.deepEqual(toClaudeTools(["read", "edit", "write", "bash"]), ["Read", "Glob", "Grep", "Edit", "Write", "Bash"])
})

test("toClaudeTools still maps bash:<prefix> to a prefix rule", () => {
  assert.deepEqual(toClaudeTools(["bash:npm test", "bash"]), ["Bash(npm test:*)", "Bash"])
  assert.deepEqual(toClaudeTools(["edit", "bash:git status"], ["src/**"]), ["Edit(./src/**)", "Bash(git status:*)"])
})
