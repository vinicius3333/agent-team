import { test } from "node:test"
import assert from "node:assert/strict"
import { appRunArgs } from "../src/deploy.ts"

const plan = { install: "npm ci", start: "npm start", port: 3000 }

function args(name: string): string[] {
  return appRunArgs({ name, dir: "/tmp/app", plan, label: "agent-team-qa=1", restart: false, env: { APP_URL: "http://x:3000" }, secrets: { TOKEN: "s3cret" } })
}

function hostnameValue(list: string[]): string | undefined {
  const index = list.indexOf("--hostname")
  return index === -1 ? undefined : list[index + 1]
}

test("appRunArgs sets the host name to the container name", () => {
  const list = args("agent-team-qa-agent-team")
  assert.equal(hostnameValue(list), "agent-team-qa-agent-team")
  assert.equal(list[list.indexOf("--name") + 1], "agent-team-qa-agent-team")
})

test("appRunArgs leaves out the host name when the name is over 63 characters", () => {
  const name = "a".repeat(70)
  const list = args(name)
  assert.equal(list.includes("--hostname"), false)
  assert.equal(list[list.indexOf("--name") + 1], name)
})

test("appRunArgs leaves out the host name when the name has other characters", () => {
  assert.equal(args("agent_team.qa").includes("--hostname"), false)
  assert.equal(args("-leading").includes("--hostname"), false)
})

test("appRunArgs only adds the host name flag and keeps the other arguments", () => {
  const withHost = args("agent-team-qa-app")
  const without = args("agent_team_qa_app")
  const stripped = withHost.filter((_, i) => i !== withHost.indexOf("--hostname") && i !== withHost.indexOf("--hostname") + 1)
  assert.deepEqual(stripped.map((a) => a.replace("agent-team-qa-app", "agent_team_qa_app")), without)
  assert.ok(withHost.includes("-e") && withHost.includes("TOKEN"))
  assert.equal(withHost.some((a) => a.includes("s3cret")), false)
  assert.deepEqual(withHost.slice(-4), ["node:24-bookworm", "sh", "-c", "npm ci && npm start"])
})
