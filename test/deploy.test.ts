import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { appRunArgs, deployErrorText, type DeployResult } from "../src/deploy.ts"
import { createGitHub } from "../src/github.ts"
import type { Harness } from "../src/harness/harness.ts"
import { ensureDeployed, type PipelineContext } from "../src/pipeline.ts"
import { createProject } from "../src/project.ts"
import { openStore } from "../src/store.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-deploy-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

// A project whose deploy phase was approved with no URL, with deploy.enabled and a fake deploy.
function deployContext(name: string, deploy: (projectDir: string) => DeployResult, options: { running?: boolean } = {}) {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  config.deploy.enabled = true
  config.publish.github.enabled = false
  mkdirSync(join(projectDir, ".agent-team"), { recursive: true })
  const store = openStore(join(projectDir, ".agent-team", "state.db"))
  store.setPhase("deploy", "approved")
  const calls: string[] = []
  const context: PipelineContext = {
    projectDir,
    config,
    store,
    harness: {} as Harness,
    github: createGitHub({ projectDir, config, store }),
    signal: new AbortController().signal,
    deploy: async (dir) => {
      calls.push(dir)
      return deploy(dir)
    },
    appRunning: () => options.running ?? false,
  }
  return { context, store, calls, projectDir }
}

test("ensureDeployed deploys an approved phase with no URL once and saves the URL", async () => {
  const { context, store, calls } = deployContext("ensure-ok", () => ({ url: "https://a-b.trycloudflare.com", error: null }))
  store.setMeta("deploy.error", "The app did not answer on port 3000. Old failure.")
  const result = await ensureDeployed(context)
  assert.equal(calls.length, 1)
  assert.equal(result?.outcome, "completed")
  assert.equal(store.meta("deploy.url"), "https://a-b.trycloudflare.com")
  assert.equal(store.phaseStatus("deploy"), "approved")
  assert.equal(store.meta("deploy.error"), "")
})

test("ensureDeployed saves the failure as a sentence plus the next step and leaves the URL empty", async () => {
  const { context, store, projectDir } = deployContext("ensure-fail", () => ({ url: null, error: "tunnel URL https://x.trycloudflare.com did not answer", stage: "tunnel" }))
  const result = await ensureDeployed(context)
  assert.equal(result?.outcome, "paused")
  assert.ok(!store.meta("deploy.url"))
  assert.match(store.meta("deploy.error") ?? "", /^The app runs, but its public URL did not answer/)
  assert.ok((store.meta("deploy.error") ?? "").endsWith(`then run: agent-team deploy ${projectDir}.`))
})

test("ensureDeployed does nothing when the app is live or deploy is off", async () => {
  const live = deployContext("ensure-live", () => ({ url: "https://new.trycloudflare.com", error: null }), { running: true })
  live.store.setMeta("deploy.url", "https://old.trycloudflare.com")
  assert.equal(await ensureDeployed(live.context), null)
  assert.equal(live.calls.length, 0)
  const off = deployContext("ensure-off", () => ({ url: "https://new.trycloudflare.com", error: null }))
  off.context.config.deploy.enabled = false
  assert.equal(await ensureDeployed(off.context), null)
  assert.equal(off.calls.length, 0)
  assert.equal(off.store.phaseStatus("deploy"), "approved")
})

test("ensureDeployed deploys again when the URL is set but the app container stopped", async () => {
  const { context, store, calls } = deployContext("ensure-stopped", () => ({ url: "https://new.trycloudflare.com", error: null }), { running: false })
  store.setMeta("deploy.url", "https://old.trycloudflare.com")
  await ensureDeployed(context)
  assert.equal(calls.length, 1)
  assert.equal(store.meta("deploy.url"), "https://new.trycloudflare.com")
})

test("deployErrorText names the port and the next step", () => {
  const text = deployErrorText("/runs/app", { url: null, error: "app did not answer on port 4400 within 240s", stage: "app" })
  assert.equal(text, "The app did not answer on port 4400. Check the start command in deploy.json, then run: agent-team deploy /runs/app.")
})

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
