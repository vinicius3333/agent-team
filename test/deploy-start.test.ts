import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { test } from "node:test"

const deploy = JSON.parse(readFileSync(new URL("../deploy.json", import.meta.url), "utf8")) as { start: string }

// The host-list part of the start command: AGENT_TEAM_UI_HOSTS="$(...)" up to the next space.
function hostListPart(): string {
  const match = deploy.start.match(/AGENT_TEAM_UI_HOSTS="\$\(.*?\)" /)
  assert.ok(match, "deploy.json start command sets AGENT_TEAM_UI_HOSTS")
  return match[0].trim()
}

// Runs that part in a shell and prints the value it exports.
function hostsFor(env: { AGENT_TEAM_UI_HOSTS?: string; APP_URL?: string }): string {
  const shellEnv: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }
  if (env.AGENT_TEAM_UI_HOSTS !== undefined) shellEnv.AGENT_TEAM_UI_HOSTS = env.AGENT_TEAM_UI_HOSTS
  if (env.APP_URL !== undefined) shellEnv.APP_URL = env.APP_URL
  return execFileSync("sh", ["-c", `export ${hostListPart()}; printf %s "$AGENT_TEAM_UI_HOSTS"`], { env: shellEnv, encoding: "utf8" })
}

test("the start command appends the APP_URL host to existing AGENT_TEAM_UI_HOSTS", () => {
  const hosts = hostsFor({ AGENT_TEAM_UI_HOSTS: "other.example", APP_URL: "https://app.example" })
  assert.deepEqual(hosts.split(","), ["other.example", "app.example"])
})

test("the start command keeps every host of a multi-host AGENT_TEAM_UI_HOSTS", () => {
  const hosts = hostsFor({ AGENT_TEAM_UI_HOSTS: "a.example,b.example", APP_URL: "https://app.example:8443/path" })
  assert.equal(hosts, "a.example,b.example,app.example")
})

test("the start command uses only the APP_URL host when AGENT_TEAM_UI_HOSTS is empty or unset", () => {
  assert.equal(hostsFor({ AGENT_TEAM_UI_HOSTS: "", APP_URL: "https://app.example" }), "app.example")
  assert.equal(hostsFor({ APP_URL: "https://app.example" }), "app.example")
})

test("the start command keeps AGENT_TEAM_UI_HOSTS when APP_URL is unset, empty, or invalid", () => {
  assert.equal(hostsFor({ AGENT_TEAM_UI_HOSTS: "other.example" }), "other.example")
  assert.equal(hostsFor({ AGENT_TEAM_UI_HOSTS: "other.example", APP_URL: "" }), "other.example")
  assert.equal(hostsFor({ AGENT_TEAM_UI_HOSTS: "other.example", APP_URL: "not a url" }), "other.example")
})

test("the start command gives an empty list when both values are unset", () => {
  assert.equal(hostsFor({}), "")
  assert.equal(hostsFor({ AGENT_TEAM_UI_HOSTS: "", APP_URL: "" }), "")
})

test("the start command never leaves a leading, trailing, or doubled comma", () => {
  const hosts = hostsFor({ AGENT_TEAM_UI_HOSTS: ",other.example,", APP_URL: "https://app.example" })
  assert.equal(hosts, "other.example,app.example")
})
