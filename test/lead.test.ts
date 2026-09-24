import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { askLead, parseLeadReply } from "../src/lead.ts"
import { createProject, withProjectStore } from "../src/project.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-lead-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const reply = (body: object) => `Checked the transcripts.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``

test("parseLeadReply keeps valid actions and drops unknown or malformed ones", () => {
  const parsed = parseLeadReply(
    reply({
      reply: "T005 is blocked.",
      actions: [
        { kind: "retry", taskId: "T005", reason: "The fix is ready." },
        { kind: "retry", taskId: "../etc" },
        { kind: "approve", phase: "nonsense" },
        { kind: "delete_everything" },
        { kind: "request_changes", phase: "spec", message: "Add login." },
        { kind: "resume" },
      ],
    }),
  )
  assert.equal(parsed.reply, "T005 is blocked.")
  assert.deepEqual(
    parsed.actions.map((action) => action.kind),
    ["retry", "request_changes", "resume"],
  )
  assert.ok(parsed.actions.every((action) => action.state === "proposed"))
})

test("parseLeadReply shows a reply without a JSON block as plain text", () => {
  assert.deepEqual(parseLeadReply("Just prose."), { reply: "Just prose.", actions: [] })
})

test("askLead stores both messages and keeps lead cost out of the run budget", async () => {
  const projectDir = join(scratch, "ask")
  createProject(projectDir, "Build a joke app")
  let prompt = ""
  await askLead({
    projectDir,
    message: "Why is T005 blocked?",
    runLead: async (request, runner) => {
      prompt = request.taskPrompt
      assert.equal(request.role, "lead")
      assert.equal(runner, "claude")
      assert.deepEqual(request.allowedTools, ["read"])
      return { status: "done", summary: reply({ reply: "Review failed.", actions: [{ kind: "retry", taskId: "T005", reason: "r" }] }), costUsd: 0.5, durationMs: 10, exitCode: 0, diagnostics: "" }
    },
  })
  assert.match(prompt, /Build a joke app/)
  assert.match(prompt, /Why is T005 blocked\?/)
  withProjectStore(projectDir, (store) => {
    const messages = store.chatMessages(10)
    assert.deepEqual(messages.map((message) => message.author), ["human", "lead"])
    assert.equal(messages[1].actions[0].kind, "retry")
    assert.equal(store.projectCost().usd, 0)
    assert.ok(store.setChatActionState(messages[1].id, 0, "applied"))
    assert.equal(store.setChatActionState(messages[0].id, 0, "applied"), false)
    assert.equal(store.chatMessages(10)[1].actions[0].state, "applied")
  })
})

test("askLead records a failed call as a lead message", async () => {
  const projectDir = join(scratch, "fail")
  createProject(projectDir, "brief")
  await askLead({ projectDir, message: "hi", runLead: async () => ({ status: "timeout", summary: "", costUsd: null, durationMs: 1, exitCode: null, diagnostics: "" }) })
  const last = withProjectStore(projectDir, (store) => store.chatMessages(10).at(-1)!)
  assert.equal(last.author, "lead")
  assert.match(last.body, /could not answer \(timeout/)
})

test("POST /chat answers 202, locks while the lead thinks, and shows the chat in the detail", async (t) => {
  const runsDir = join(scratch, "runs")
  createProject(join(runsDir, "chat-app"), "brief")
  let release = () => {}
  const server = startUi({
    runsDir,
    port: 0,
    startRun: () => {},
    askLead: (projectDir, message) =>
      new Promise((resolve) => {
        withProjectStore(projectDir, (store) => store.addChatMessage("human", message))
        release = () => resolve()
      }),
  })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/chat-app`
  const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify(body) })

  assert.equal((await post("chat", { message: "  " })).status, 400)
  assert.equal((await post("chat", { message: "x".repeat(5000) })).status, 400)
  assert.equal((await post("chat", { message: "Status?" })).status, 202)
  assert.equal((await post("chat", { message: "Again?" })).status, 409)
  let detail = await (await fetch(base)).json()
  assert.equal(detail.chat.thinking, true)
  assert.equal(detail.chat.messages[0].body, "Status?")
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  detail = await (await fetch(base)).json()
  assert.equal(detail.chat.thinking, false)
  assert.equal((await post("chat-action", { messageId: 1, index: 0, state: "maybe" })).status, 400)
  assert.equal((await post("chat-action", { messageId: 1, index: 0, state: "applied" })).status, 404)
})
