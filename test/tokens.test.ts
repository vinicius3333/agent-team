import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { claudeTokens } from "../src/runners/claude.ts"
import { codexTokens } from "../src/runners/codex.ts"
import { openStore } from "../src/store.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-tokens-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

test("claudeTokens adds input, output, and both cache counts", () => {
  assert.equal(claudeTokens({ input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000 }), 43210)
  assert.equal(claudeTokens(undefined), null)
})

test("codexTokens sums every completed turn and ignores cached_input_tokens", () => {
  const jsonl = [
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50}}',
    "not json",
    '{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":25}}',
  ].join("\n")
  assert.equal(codexTokens(jsonl), 1575)
  assert.equal(codexTokens('{"type":"turn.failed"}'), null)
})

test("the store keeps tokens per attempt", () => {
  const store = openStore(join(scratch, "state.db"))
  store.recordAttempt({ subject: "T001-1", role: "worker", runner: "claude", model: "sonnet", status: "done", failureClass: null, costUsd: 0.1, tokens: 1234, durationMs: 1, transcriptPath: "x" })
  assert.equal(store.recentAttempts(null, 1)[0].subject, "T001-1")
  store.close()
})
