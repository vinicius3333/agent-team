import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const deploy = JSON.parse(readFileSync(new URL("../deploy.json", import.meta.url), "utf8")) as { install: string; start: string; port: number }
const repoDir = fileURLToPath(new URL("..", import.meta.url))

// The host-list part of the start command: AGENT_TEAM_UI_HOSTS="$(...)" up to the next space.
function hostListPart(): string {
  const match = deploy.start.match(/AGENT_TEAM_UI_HOSTS="\$\(.*?\)" /)
  assert.ok(match, "deploy.json start command sets AGENT_TEAM_UI_HOSTS")
  return match[0].trim()
}

// Runs that part in a shell from the repository folder and prints the value it exports.
function hostsFor(env: Record<string, string>): string {
  const shellEnv: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...env }
  return execFileSync("sh", ["-c", `export ${hostListPart()}; printf %s "$AGENT_TEAM_UI_HOSTS"`], { cwd: repoDir, env: shellEnv, encoding: "utf8" })
}

test("the start command builds the host list with agent-team preview-hosts", () => {
  assert.equal(hostListPart(), 'AGENT_TEAM_UI_HOSTS="$(node --disable-warning=ExperimentalWarning src/cli.ts preview-hosts)"')
})

test("the start command keeps the hash step, the ui command, install, and port", () => {
  assert.match(deploy.start, /^AGENT_TEAM_UI_PASSWORD_HASH="\$\(printf %s "\$DEMO_PASSWORD" \| node --disable-warning=ExperimentalWarning src\/cli\.ts hash-password\)" /)
  assert.match(deploy.start, / node --disable-warning=ExperimentalWarning src\/cli\.ts ui \.agent-team-runs --host 0\.0\.0\.0 --port "\$\{PORT:-4400\}"$/)
  assert.equal(deploy.install, "npm ci && npm run build:ui")
  assert.equal(deploy.port, 4400)
})

test("the start command appends the APP_URL host to existing AGENT_TEAM_UI_HOSTS", () => {
  assert.equal(hostsFor({ AGENT_TEAM_UI_HOSTS: "a.example,b.example", APP_URL: "https://app.example:8443/path" }), "a.example,b.example,app.example")
})

test("the start command allows the container name from HOSTNAME when APP_URL is missing", () => {
  assert.equal(hostsFor({ HOSTNAME: "agent-team-qa-agent-team" }), "agent-team-qa-agent-team")
})

test("the start command lists each name once and skips bad values", () => {
  const hosts = hostsFor({ AGENT_TEAM_UI_HOSTS: ",Other.example,", APP_URL: "http://agent-team-qa-agent-team:4400", PUBLIC_URL: "not a url", HOSTNAME: "agent-team-qa-agent-team" })
  assert.equal(hosts, "other.example,agent-team-qa-agent-team")
})

test("the start command gives an empty list when nothing is set", () => {
  assert.equal(hostsFor({}), "")
  assert.equal(hostsFor({ AGENT_TEAM_UI_HOSTS: "", APP_URL: "", HOSTNAME: "" }), "")
})
