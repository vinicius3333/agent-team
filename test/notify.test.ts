import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHmac } from "node:crypto"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { after, test } from "node:test"
import { withProjectStore } from "../src/project.ts"
import { ntfyRequest, signatureHeader, slackRequest, webhookRequest } from "../src/notify/channels.ts"
import { loadNotificationConfig, type NtfyChannel, type SlackChannel, type WebhookChannel } from "../src/notify/config.ts"
import { notificationFor, type ProjectEvent } from "../src/notify/events.ts"
import { acquireLock, checkNotifications, cursorKey, lockFile, notificationStatus, releaseLock, sendTest, type NotifyDeps } from "../src/notify/index.ts"
import { bodyMaxLength, buildMessage, titleMaxLength, type Message } from "../src/notify/message.ts"
import type { RunStop } from "../src/pipeline.ts"
import { startUi } from "../src/ui/server.ts"

const execFileAsync = promisify(execFile)
const scratch = mkdtempSync(join(tmpdir(), "agent-team-notify-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

let runsCount = 0
function makeRuns(yaml: string, projects: string[] = ["crm"]): string {
  const runsDir = join(scratch, `runs-${++runsCount}`)
  mkdirSync(runsDir, { recursive: true })
  writeFileSync(join(runsDir, "notifications.yaml"), yaml)
  for (const project of projects) {
    mkdirSync(join(runsDir, project), { recursive: true })
    writeFileSync(join(runsDir, project, "pipeline.yaml"), "target: web\n")
  }
  return runsDir
}

interface Sent {
  url: string
  headers: Record<string, string>
  body: string
}

function stubFetch(answer: (url: string) => Response | Promise<Response> = () => new Response("ok")) {
  const sent: Sent[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body ?? "") })
    return answer(url)
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

function deps(overrides: Partial<NotifyDeps> = {}): Partial<NotifyDeps> {
  return { sleep: async () => {}, log: () => {}, env: { HOOK_URL: "https://hooks.example.com/in", SLACK_URL: "https://hooks.slack.com/services/T0/B0/secretpath" }, ...overrides }
}

const hookYaml = "dashboardUrl: https://box.tailnet.ts.net:4400\nchannels:\n  - name: hook\n    type: webhook\n    url: ${HOOK_URL}\n"

function logEvents(runsDir: string, project: string, events: [string, string][]) {
  withProjectStore(join(runsDir, project), (store) => {
    for (const [type, message] of events) store.log(type, message)
  })
}

async function primeCursor(runsDir: string, overrides: Partial<NotifyDeps>) {
  await checkNotifications(runsDir, overrides)
}

const event = (type: string, message: string, id = 1): ProjectEvent => ({ id, at: new Date().toISOString(), type, message })
const noContext = { cooldowns: false, interrupted: false }
const stop = (reason: string, outcome: RunStop["outcome"] = "failed"): RunStop => ({ outcome, kind: "other", reason, at: new Date().toISOString() })

test("each trigger in the table maps to its notification", () => {
  const cases: [ProjectEvent, RunStop | null, string, string][] = [
    [event("gate", 'phase "spec" is ready for review: agent-team approve /p spec'), null, "gate", "action"],
    [event("budget", "run budget reached: $30.00 reported of $30.00"), null, "budget", "action"],
    [event("qa", "stopped after 3 failed rounds; the fix tasks are queued"), null, "qa_failed", "action"],
    [event("run", "finished: paused"), stop("T004 paused: disk full", "paused"), "paused", "action"],
    [event("run", "finished: failed"), stop("T004 failed after 3 attempts"), "failed", "action"],
    [event("run", "interrupt received; stopping agents"), null, "stopped", "info"],
    [event("run", "finished: completed"), null, "finished", "info"],
    [event("deploy", "live at https://x.trycloudflare.com; log in as demo@example.com (the password is on the dashboard)"), null, "live", "info"],
    [event("doctor", "opened incident 2026-09-24T12-00-00-000Z: T004 failed"), null, "incident", "info"],
    [event("doctor", "incident 2026-09-24T12-00-00-000Z: gave up: the limit is reached"), null, "incident", "action"],
  ]
  for (const [input, runStop, kind, severity] of cases) {
    const notification = notificationFor(input, runStop, noContext)
    assert.equal(notification?.kind, kind, input.message)
    assert.equal(notification?.severity, severity, input.message)
  }
  assert.equal(notificationFor(event("run", "finished: failed"), stop("T004 failed: boom"), noContext)?.reason, "T004 failed: boom")
})

test("non-events send nothing", () => {
  assert.equal(notificationFor(event("run", "finished: awaiting_approval"), stop("x", "awaiting_approval"), noContext), null)
  assert.equal(notificationFor(event("gate", 'phase "spec" is waiting for approval: agent-team approve /p spec'), null, noContext), null)
  const cooldown = stop("T004 paused: claude is cooling down until 12:00", "paused")
  assert.equal(notificationFor(event("run", "finished: paused"), cooldown, noContext), null)
  assert.equal(notificationFor(event("run", "finished: paused"), cooldown, { cooldowns: true, interrupted: false })?.kind, "paused")
  assert.equal(notificationFor(event("run", "finished: paused"), stop("x", "paused"), { cooldowns: false, interrupted: true }), null)
  assert.equal(notificationFor(event("task", "T004 started"), null, noContext), null)
})

test("the first pass sets the cursor and sends nothing, then new events send once", async () => {
  const runsDir = makeRuns(hookYaml)
  logEvents(runsDir, "crm", [["gate", 'phase "spec" is ready for review: agent-team approve /p spec']])
  const { fetch, sent } = stubFetch()
  await checkNotifications(runsDir, deps({ fetch }))
  assert.equal(sent.length, 0)
  const cursor = withProjectStore(join(runsDir, "crm"), (store) => store.meta(cursorKey))
  assert.equal(cursor, "1")

  logEvents(runsDir, "crm", [["budget", "run budget reached: $30.00 reported of $30.00 (budget.runUsd). Stopped before T004."]])
  await checkNotifications(runsDir, deps({ fetch }))
  await checkNotifications(runsDir, deps({ fetch }))
  assert.equal(sent.length, 1)
  const message = JSON.parse(sent[0].body) as Message
  assert.equal(message.kind, "budget")
  assert.equal(message.url, "https://box.tailnet.ts.net:4400/projects/crm")
  assert.equal(message.eventId, 2)
})

test("events older than 24 h are skipped with one summary line", async () => {
  const runsDir = makeRuns(hookYaml)
  const { fetch, sent } = stubFetch()
  await primeCursor(runsDir, deps({ fetch }))
  logEvents(runsDir, "crm", [["run", "finished: completed"], ["qa", "stopped after 3 failed rounds"]])
  const lines: string[] = []
  await checkNotifications(runsDir, deps({ fetch, now: () => Date.now() + 25 * 60 * 60_000, log: (line) => lines.push(line) }))
  assert.equal(sent.length, 0)
  assert.equal(lines.filter((line) => line.includes("older than 24 h")).length, 1)
})

test("the same stop is sent once within 6 h, and a new review round is sent again", async () => {
  const runsDir = makeRuns(hookYaml)
  const { fetch, sent } = stubFetch()
  await primeCursor(runsDir, deps({ fetch }))
  withProjectStore(join(runsDir, "crm"), (store) => store.setMeta("run.stop", JSON.stringify(stop("T004 failed after 3 attempts at 12:00:01"))))
  logEvents(runsDir, "crm", [["run", "finished: failed"]])
  await checkNotifications(runsDir, deps({ fetch }))
  withProjectStore(join(runsDir, "crm"), (store) => store.setMeta("run.stop", JSON.stringify(stop("T004 failed after 3 attempts at 12:40:09"))))
  logEvents(runsDir, "crm", [["run", "finished: failed"]])
  await checkNotifications(runsDir, deps({ fetch }))
  assert.equal(sent.length, 1)
  logEvents(runsDir, "crm", [["run", "finished: failed"]])
  await checkNotifications(runsDir, deps({ fetch, now: () => Date.now() + 7 * 60 * 60_000 }))
  assert.equal(sent.length, 2)

  logEvents(runsDir, "crm", [["gate", 'phase "spec" is ready for review: x']])
  await checkNotifications(runsDir, deps({ fetch }))
  logEvents(runsDir, "crm", [["gate", 'phase "spec" is ready for review: x']])
  await checkNotifications(runsDir, deps({ fetch }))
  assert.equal(sent.length, 4)
})

test("many notifications in one pass become one digest", async () => {
  const runsDir = makeRuns(`${hookYaml}throttle: { perProjectPerMinute: 6, digestAfter: 3 }\n`)
  const { fetch, sent } = stubFetch()
  await primeCursor(runsDir, deps({ fetch }))
  logEvents(runsDir, "crm", [
    ["gate", 'phase "spec" is ready for review: x'],
    ["budget", "run budget reached: $1"],
    ["qa", "stopped after 2 failed rounds"],
    ["run", "finished: completed"],
  ])
  await checkNotifications(runsDir, deps({ fetch }))
  assert.equal(sent.length, 1)
  const digest = JSON.parse(sent[0].body) as Message
  assert.equal(digest.kind, "digest")
  assert.equal(digest.severity, "action")
  assert.equal(digest.title, "crm: 4 updates")
  assert.match(digest.body, /spec is ready for review/)
})

test("info notifications are throttled per project; action ones are not", async () => {
  const runsDir = makeRuns(`${hookYaml}throttle: { perProjectPerMinute: 1, digestAfter: 10 }\n`)
  const { fetch, sent } = stubFetch()
  await primeCursor(runsDir, deps({ fetch }))
  logEvents(runsDir, "crm", [
    ["deploy", "live at https://a.example.com"],
    ["deploy", "live at https://b.example.com"],
    ["budget", "run budget reached: $1"],
  ])
  await checkNotifications(runsDir, deps({ fetch }))
  assert.deepEqual(sent.map((entry) => (JSON.parse(entry.body) as Message).kind), ["live", "budget"])
})

test("a failing channel does not stop others, the cursor moves, and it turns off after five failures", async () => {
  const runsDir = makeRuns(`${hookYaml}  - name: slack\n    type: slack\n    url: \${SLACK_URL}\n`)
  const { fetch, sent } = stubFetch((url) => {
    if (url.includes("hooks.example.com")) throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    return new Response("ok")
  })
  const sleeps: number[] = []
  const options = deps({ fetch, sleep: async (ms) => void sleeps.push(ms) })
  await primeCursor(runsDir, options)
  for (let round = 0; round < 3; round++) {
    logEvents(runsDir, "crm", [["gate", `phase "spec" is ready for review: round ${round}`], ["qa", `stopped after ${round + 2} failed rounds`]])
    await checkNotifications(runsDir, options)
  }
  const slack = sent.filter((entry) => entry.url.includes("slack"))
  const hook = sent.filter((entry) => entry.url.includes("hooks.example.com"))
  assert.equal(slack.length, 6)
  assert.equal(hook.length, 5 * 3)
  assert.deepEqual(sleeps.slice(0, 2), [5_000, 30_000])
  const cursor = withProjectStore(join(runsDir, "crm"), (store) => ({ cursor: Number(store.meta(cursorKey)), last: store.lastEventId() }))
  assert.equal(cursor.cursor, cursor.last)
  const status = notificationStatus(runsDir, options.env)
  const hookStatus = status.channels.find((channel) => channel.name === "hook")!
  assert.equal(hookStatus.enabled, false)
  assert.match(hookStatus.lastError!.message, /timeout/)
  assert.equal(status.channels.find((channel) => channel.name === "slack")!.enabled, true)
})

test("${NAME} expands from the environment; a missing variable turns off only that channel", async () => {
  const runsDir = makeRuns(`${hookYaml}  - name: phone\n    type: ntfy\n    topic: at-\${NTFY_SUFFIX}\n    token: \${NTFY_TOKEN}\n`)
  const lines: string[] = []
  const config = loadNotificationConfig(runsDir, { HOOK_URL: "https://hooks.example.com/in?key=abc123secret" })!
  assert.equal(config.channels.length, 1)
  assert.equal((config.channels[0] as WebhookChannel).url, "https://hooks.example.com/in?key=abc123secret")
  assert.deepEqual(config.unavailable, [{ name: "phone", type: "ntfy", reason: "missing environment variable NTFY_SUFFIX, NTFY_TOKEN" }])

  const { fetch } = stubFetch(() => new Response("bad key abc123secret", { status: 401 }))
  await sendTest(runsDir, null, deps({ fetch, env: { HOOK_URL: "https://hooks.example.com/in?key=abc123secret" }, log: (line) => lines.push(line) }))
  const status = notificationStatus(runsDir, { HOOK_URL: "https://hooks.example.com/in?key=abc123secret" })
  const text = JSON.stringify(status) + lines.join("\n") + readFileSync(join(runsDir, ".notify-state.json"), "utf8")
  assert.doesNotMatch(text, /abc123secret/)
  assert.equal(status.channels[0].target, "hooks.example.com/***")
  assert.equal(status.channels[0].lastError?.status, 401)
  assert.equal(status.channels[1].enabled, false)
})

test("config errors name the channel", () => {
  const bad = makeRuns("channels:\n  - name: pager\n    type: pager\n  - name: hook\n    type: webhook\n    events: [gate, everything]\n", [])
  assert.throws(() => loadNotificationConfig(bad, {}), /channel "pager": type must be one of[\s\S]*channel "hook": events must be[\s\S]*channel "hook": url is required/)
  assert.equal(loadNotificationConfig(join(scratch, "missing"), {}), null)
})

test("messages stay within limits, link per kind, and never carry the password", () => {
  const context = { dashboardUrl: "https://box.ts.net", costUsd: 12.4 }
  const long = `${"x".repeat(300)} failed\n${"npm error something broke\n".repeat(50)}`
  const build = (type: string, message: string, runStop: RunStop | null = null) => buildMessage("crm-test-with-a-very-long-project-name-that-goes-on", notificationFor(event(type, message), runStop, noContext)!, event(type, message), context)
  const failed = build("run", "finished: failed", stop(long))
  assert.ok(failed.title.length <= titleMaxLength)
  assert.ok(failed.body.length <= bodyMaxLength)
  const project = "https://box.ts.net/projects/crm-test-with-a-very-long-project-name-that-goes-on"
  assert.equal(build("gate", 'phase "spec" is ready for review: x').url, `${project}?tab=docs&doc=docs/spec.md`)
  assert.equal(build("qa", "stopped after 3 failed rounds").url, `${project}?tab=qa`)
  assert.equal(build("budget", "run budget reached: $1").url, project)
  assert.equal(build("doctor", "opened incident 2026-09-24T12-00-00-000Z: boom").url, "https://box.ts.net/incidents/crm-test-with-a-very-long-project-name-that-goes-on/2026-09-24T12-00-00-000Z")
  const live = build("deploy", "live at https://app.trycloudflare.com; log in as demo@example.com (the password is on the dashboard)")
  assert.equal(live.body, "Live at https://app.trycloudflare.com. The password is on the dashboard.")
  assert.equal(live.url, project)
  assert.equal(live.costUsd, 12.4)
  assert.equal(buildMessage("crm", notificationFor(event("run", "finished: completed"), null, noContext)!, event("run", "x"), { dashboardUrl: null, costUsd: null }).url, null)
})

const sample: Message = { kind: "gate", severity: "action", project: "crm", title: "crm: spec is ready for review…", body: "Approve <now> & more", url: "https://box.ts.net/projects/crm", at: "2026-09-24T12:00:00.000Z", eventId: 3, costUsd: 1 }
const base = { events: [], projects: null }

test("Slack payload has a section and a dashboard button", () => {
  const request = slackRequest({ ...base, name: "slack", type: "slack", url: "https://hooks.slack.com/x" } as SlackChannel, sample)
  const payload = JSON.parse(request.body)
  assert.equal(payload.blocks[0].type, "section")
  assert.equal(payload.blocks[0].text.text, "*crm: spec is ready for review…*\nApprove &lt;now&gt; &amp; more")
  assert.equal(payload.blocks[1].elements[0].url, sample.url)
  assert.match(payload.text, /spec is ready/)
})

test("ntfy headers carry title, priority, tags, click, and token", () => {
  const request = ntfyRequest({ ...base, name: "phone", type: "ntfy", server: "https://ntfy.sh", topic: "agent team", token: "tk_1" } as NtfyChannel, sample)
  assert.equal(request.url, "https://ntfy.sh/agent%20team")
  assert.deepEqual(request.headers, { Title: "crm: spec is ready for review?", Priority: "high", Tags: "agent-team,gate", Click: sample.url, Authorization: "Bearer tk_1" })
  assert.equal(request.body, sample.body)
  assert.equal(ntfyRequest({ ...base, name: "phone", type: "ntfy", server: "https://ntfy.sh", topic: "t", token: null } as NtfyChannel, { ...sample, severity: "info" }).headers.Priority, "default")
})

test("webhook signs the raw body with HMAC SHA-256", () => {
  const request = webhookRequest({ ...base, name: "hook", type: "webhook", url: "https://x.example.com", headers: { "X-Team": "a" }, secret: "s3cret" } as WebhookChannel, sample)
  assert.equal(request.headers[signatureHeader], `sha256=${createHmac("sha256", "s3cret").update(request.body).digest("hex")}`)
  assert.equal(request.headers["X-Team"], "a")
  assert.deepEqual(JSON.parse(request.body), sample)
})

test("email goes through the injected mailer", async () => {
  const runsDir = makeRuns("channels:\n  - name: mail\n    type: email\n    smtp: { host: smtp.example.com, port: 587, user: me, password: \"${SMTP_PASSWORD}\" }\n    from: at@example.com\n    to: you@example.com\n")
  const mails: unknown[] = []
  const results = await sendTest(runsDir, "mail", deps({ env: { SMTP_PASSWORD: "pw123456" }, mailer: async (smtp, mail) => void mails.push({ smtp, mail }) }))
  assert.deepEqual(results, [{ channel: "mail", ok: true, error: null }])
  assert.deepEqual(mails, [{ smtp: { host: "smtp.example.com", port: 587, user: "me", password: "pw123456" }, mail: { from: "at@example.com", to: ["you@example.com"], subject: "agent-team: test notification", text: "This channel works. You will get a message here when a run needs you." } }])
})

test("send test through the API returns one result per channel", async () => {
  const runsDir = makeRuns(`${hookYaml}  - name: slack\n    type: slack\n    url: \${SLACK_URL}\n`)
  const { fetch, sent } = stubFetch((url) => (url.includes("slack") ? new Response("no_team", { status: 404 }) : new Response("ok")))
  const server = startUi({ runsDir, port: 0, notifications: false, notifyDeps: deps({ fetch }) })
  await once(server, "listening")
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const post = (body: unknown) => globalThis.fetch(`${base}/api/notifications/test`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify(body) })
    const all = await (await post({})).json()
    assert.deepEqual(all, [{ channel: "hook", ok: true, error: null }, { channel: "slack", ok: false, error: "HTTP 404: no_team" }])
    const one = await (await post({ channel: "hook" })).json()
    assert.deepEqual(one, [{ channel: "hook", ok: true, error: null }])
    assert.equal((await post({ channel: "nope" })).status, 404)
    const status = await (await globalThis.fetch(`${base}/api/notifications`)).json()
    assert.deepEqual(status.channels.map((channel: { name: string; target: string }) => [channel.name, channel.target]), [["hook", "hooks.example.com/***"], ["slack", "hooks.slack.com/***"]])
    assert.doesNotMatch(JSON.stringify(status), /secretpath/)
  } finally {
    server.close()
  }
  assert.ok(sent.some((entry) => entry.url.includes("slack")))
})

test("the notify-test command sends to a real endpoint and reports failures", async () => {
  const received: string[] = []
  const endpoint = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      received.push(body)
      response.end("ok")
    })
  }).listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  const runsDir = makeRuns(`channels:\n  - name: local\n    type: webhook\n    url: http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/hook\n  - name: off\n    type: slack\n    url: \${UNSET_SLACK_URL}\n`)
  const cli = join(import.meta.dirname, "..", "src", "cli.ts")
  try {
    const run = (args: string[]) => execFileAsync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "notify-test", runsDir, ...args]).then((result) => ({ ...result, code: 0 }), (error) => ({ stdout: error.stdout as string, code: error.code as number }))
    const one = await run(["--channel", "local"])
    assert.equal(one.code, 0)
    assert.match(one.stdout, /sent\s+local/)
    const all = await run([])
    assert.equal(all.code, 1)
    assert.match(all.stdout, /failed off: missing environment variable UNSET_SLACK_URL/)
    assert.equal(received.length, 2)
    assert.equal(JSON.parse(received[0]).kind, "test")
  } finally {
    endpoint.close()
  }
})

test("only the lock holder sends", async () => {
  const runsDir = makeRuns(hookYaml)
  const first = stubFetch()
  const second = stubFetch()
  await primeCursor(runsDir, deps({ fetch: first.fetch }))
  assert.equal(readFileSync(join(runsDir, lockFile), "utf8"), String(process.pid))
  logEvents(runsDir, "crm", [["budget", "run budget reached: $1"]])
  await checkNotifications(runsDir, deps({ fetch: second.fetch, pid: 999_999_1 }))
  assert.equal(second.sent.length, 0)
  await checkNotifications(runsDir, deps({ fetch: first.fetch }))
  assert.equal(first.sent.length, 1)
  assert.equal(acquireLock(runsDir, 999_999_1), false)
  releaseLock(runsDir, process.pid)
  assert.equal(acquireLock(runsDir, 999_999_1), true)
})

test("the example config loads", () => {
  const runsDir = makeRuns(readFileSync(join(import.meta.dirname, "..", "notifications.example.yaml"), "utf8"), [])
  const config = loadNotificationConfig(runsDir, { NTFY_TOPIC_SUFFIX: "abc" })!
  assert.deepEqual(config.channels.map((channel) => [channel.name, channel.type]), [["phone", "ntfy"]])
  assert.equal((config.channels[0] as NtfyChannel).topic, "agent-team-abc")
})
