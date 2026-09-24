import assert from "node:assert/strict"
import { test } from "node:test"
import { summarizeActivity } from "../src/activity.ts"

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n")

test("summarizeActivity reads Claude tool calls and text", () => {
  const transcript = lines(
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "Writing the tokens.\nThen the logo." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/workspace/design/tokens.css" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "docs/spec.md" } }] } },
  )
  assert.deepEqual(summarizeActivity(transcript), [
    { kind: "message", text: "Writing the tokens.\nThen the logo." },
    { kind: "edit", text: "Write design/tokens.css" },
    { kind: "command", text: "npm test" },
    { kind: "read", text: "Read docs/spec.md" },
  ])
})

test("summarizeActivity reads Codex commands, file changes, messages, and reasoning", () => {
  const transcript = lines(
    { type: "item.started", item: { type: "command_execution", command: "/bin/bash -lc 'ls design'" } },
    { type: "item.completed", item: { type: "reasoning", text: "Check the brand first." } },
    { type: "item.completed", item: { type: "file_change", changes: [{ kind: "add", path: "/workspace/design/logo.svg" }] } },
    { type: "item.completed", item: { type: "agent_message", text: "I added the logo." } },
  )
  assert.deepEqual(summarizeActivity(transcript), [
    { kind: "command", text: "ls design" },
    { kind: "reasoning", text: "Check the brand first." },
    { kind: "edit", text: "add design/logo.svg" },
    { kind: "message", text: "I added the logo." },
  ])
})

test("summarizeActivity skips a partial first line from a tail read", () => {
  assert.deepEqual(summarizeActivity(`ext":"cut"}]}}\n${lines({ type: "item.completed", item: { type: "agent_message", text: "done" } })}`), [{ kind: "message", text: "done" }])
})
