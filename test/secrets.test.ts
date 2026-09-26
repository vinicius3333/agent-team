import assert from "node:assert/strict"
import { once } from "node:events"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { commitAll } from "../src/git.ts"
import { notificationFor } from "../src/notify/events.ts"
import { createProject, withProjectStore } from "../src/project.ts"
import {
  appSecretEnv,
  decryptSecret,
  encryptSecret,
  globalVaultPath,
  missingSecrets,
  parseEnvExample,
  projectSecretStatuses,
  readSecretsKey,
  releaseDeployGate,
  saveSecret,
  secretStatuses,
  secretsKeyEnv,
  setSecretSkipped,
  validateSecret,
  vaultPath,
} from "../src/secrets.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-secrets-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const key = randomBytes(32)
const env = { [secretsKeyEnv]: key.toString("base64") }

const envExample = `# Google OAuth client ID. Create a web client at https://console.cloud.google.com/apis/credentials
# Redirect URI: <APP_URL>/api/auth/callback/google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# optional: Sentry DSN for error reports
export SENTRY_DSN=https://example.invalid
APP_URL=http://localhost:3000
lower_case=1
`

function project(runsDir: string, name: string, example: string | null = envExample): string {
  const projectDir = join(runsDir, name)
  createProject(projectDir, "brief")
  if (example !== null) {
    writeFileSync(join(projectDir, ".env.example"), example)
    commitAll(projectDir, "chore: add .env.example")
  }
  return projectDir
}

test("parseEnvExample reads names, descriptions, and optional markers", () => {
  assert.deepEqual(parseEnvExample(envExample), [
    { name: "GOOGLE_CLIENT_ID", description: "Google OAuth client ID. Create a web client at https://console.cloud.google.com/apis/credentials Redirect URI: <APP_URL>/api/auth/callback/google", optional: false },
    { name: "GOOGLE_CLIENT_SECRET", description: "", optional: false },
    { name: "SENTRY_DSN", description: "Sentry DSN for error reports", optional: true },
  ])
  assert.deepEqual(parseEnvExample(""), [])
})

test("the secrets key must be 32 bytes of base64", () => {
  assert.equal(readSecretsKey({}).state, "missing")
  assert.equal(readSecretsKey({ [secretsKeyEnv]: "short" }).state, "invalid")
  assert.equal(readSecretsKey({ [secretsKeyEnv]: randomBytes(16).toString("base64") }).state, "invalid")
  assert.equal(readSecretsKey(env).state, "ready")
})

test("a secret decrypts only with the same key and name", () => {
  const stored = encryptSecret("API_KEY", "s3cret", key)
  assert.doesNotMatch(stored, /s3cret/)
  assert.equal(decryptSecret("API_KEY", stored, key), "s3cret")
  assert.throws(() => decryptSecret("OTHER_KEY", stored, key), /changed since it was saved/)
  assert.throws(() => decryptSecret("API_KEY", stored, randomBytes(32)), /changed since it was saved/)
})

test("validateSecret rejects bad names, reserved names, and empty values", () => {
  assert.throws(() => validateSecret("lower", "x"), /upper case/)
  assert.throws(() => validateSecret("APP_URL", "x"), /set by agent-team/)
  assert.throws(() => validateSecret("API_KEY", ""), /must not be empty/)
  assert.throws(() => validateSecret("API_KEY", "x".repeat(17 * 1024)), /under 16 KB/)
  assert.deepEqual(validateSecret("API_KEY", "x"), { name: "API_KEY", value: "x" })
})

test("project values win, global values count only when declared, and skipped ones are not missing", () => {
  const at = "2026-09-26T00:00:00.000Z"
  const statuses = secretStatuses({
    requirements: parseEnvExample(envExample),
    project: [{ name: "GOOGLE_CLIENT_ID", updatedAt: at }, { name: "EXTRA", updatedAt: at }],
    global: [{ name: "GOOGLE_CLIENT_ID", updatedAt: at }, { name: "UNRELATED", updatedAt: at }],
    skipped: [],
  })
  assert.deepEqual(statuses.map((status) => [status.name, status.source, status.declared]), [
    ["GOOGLE_CLIENT_ID", "project", true],
    ["GOOGLE_CLIENT_SECRET", null, true],
    ["SENTRY_DSN", null, true],
    ["EXTRA", "project", false],
  ])
  assert.deepEqual(missingSecrets(statuses), ["GOOGLE_CLIENT_SECRET"])
  assert.deepEqual(missingSecrets(statuses.map((status) => ({ ...status, skipped: status.name === "GOOGLE_CLIENT_SECRET" }))), [])
})

test("appSecretEnv merges global and project values and leaves out undeclared global ones", () => {
  const runsDir = join(scratch, "env")
  mkdirSync(runsDir)
  const projectDir = project(runsDir, "shop")
  assert.deepEqual(appSecretEnv(projectDir, parseEnvExample(envExample), {}), {})
  saveSecret(globalVaultPath(runsDir), "GOOGLE_CLIENT_ID", "global-id", env)
  saveSecret(globalVaultPath(runsDir), "UNRELATED", "nope", env)
  saveSecret(vaultPath("project", projectDir), "GOOGLE_CLIENT_SECRET", "own-secret", env)
  saveSecret(vaultPath("project", projectDir), "EXTRA", "extra", env)
  assert.deepEqual(appSecretEnv(projectDir, parseEnvExample(envExample), env), { GOOGLE_CLIENT_ID: "global-id", GOOGLE_CLIENT_SECRET: "own-secret", EXTRA: "extra" })
  saveSecret(vaultPath("project", projectDir), "GOOGLE_CLIENT_ID", "own-id", env)
  assert.equal(appSecretEnv(projectDir, parseEnvExample(envExample), env).GOOGLE_CLIENT_ID, "own-id")
  assert.throws(() => appSecretEnv(projectDir, parseEnvExample(envExample), {}), new RegExp(`Set ${secretsKeyEnv}`))
  assert.doesNotMatch(readFileSync(join(projectDir, ".agent-team", "state.db")).toString("latin1"), /own-secret/)
})

test("releaseDeployGate reopens deploy only when nothing is missing", () => {
  const runsDir = join(scratch, "gate")
  mkdirSync(runsDir)
  const projectDir = project(runsDir, "shop")
  withProjectStore(projectDir, (store) => {
    assert.equal(releaseDeployGate(projectDir, store), false)
    store.setPhase("deploy", "awaiting_approval")
    saveSecret(vaultPath("project", projectDir), "GOOGLE_CLIENT_ID", "id", env)
    assert.equal(releaseDeployGate(projectDir, store), false)
    setSecretSkipped(store, "GOOGLE_CLIENT_SECRET", true)
    assert.deepEqual(missingSecrets(projectSecretStatuses(projectDir, store)), [])
    assert.equal(releaseDeployGate(projectDir, store), true)
    assert.equal(store.phaseStatus("deploy"), "pending")
  })
})

test("the deploy secrets gate notifies like any other gate", () => {
  const event = { id: 1, at: "", type: "gate", message: 'phase "deploy" waits for secrets: GOOGLE_CLIENT_ID' }
  const notification = notificationFor(event, null, { cooldowns: false, interrupted: false })
  assert.equal(notification?.kind, "gate")
  assert.equal(notification?.phase, "deploy")
})

test("secrets routes save, mask, skip, and resume a waiting deploy", async (t) => {
  const runsDir = join(scratch, "routes")
  mkdirSync(runsDir)
  const projectDir = project(runsDir, "shop")
  project(runsDir, "blog", null)
  const started: { projectDir: string; command?: string[] }[] = []
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, notifications: false, secretsEnv: env, startRun: (dir, _log, command) => void started.push({ projectDir: dir, command }) })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify(body) })
  const view = async () => (await (await fetch(`${base}/api/projects/shop/secrets`)).json()) as any

  withProjectStore(projectDir, (store) => store.setPhase("deploy", "awaiting_approval"))
  const initial = await view()
  assert.equal(initial.key.state, "ready")
  assert.deepEqual(initial.missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])
  assert.equal(initial.deployWaiting, true)

  assert.equal((await post("/api/projects/shop/secrets", { name: "APP_URL", value: "x" })).status, 400)
  const saved = await post("/api/projects/shop/secrets", { name: "GOOGLE_CLIENT_ID", value: "client-id-value" })
  assert.deepEqual(await saved.json(), { started: false })
  const afterSave = await view()
  assert.equal(afterSave.secrets[0].source, "project")
  assert.doesNotMatch(JSON.stringify(afterSave), /client-id-value/)

  const global = await post("/api/secrets", { name: "GOOGLE_CLIENT_SECRET", value: "shared-secret" })
  assert.deepEqual(await global.json(), { resumed: ["shop"] })
  assert.deepEqual(started, [{ projectDir, command: undefined }])
  assert.equal(withProjectStore(projectDir, (store) => store.phaseStatus("deploy")), "pending")

  const globalView = (await (await fetch(`${base}/api/secrets`)).json()) as any
  assert.deepEqual(globalView.secrets.map((secret: any) => [secret.name, secret.usedBy]), [["GOOGLE_CLIENT_SECRET", ["shop"]]])
  assert.deepEqual(globalView.wanted.map((secret: any) => secret.name), ["GOOGLE_CLIENT_ID", "SENTRY_DSN"])
  assert.doesNotMatch(JSON.stringify(globalView), /shared-secret/)

  assert.equal((await post("/api/projects/shop/secrets/skip", { name: "SENTRY_DSN", skipped: true })).status, 200)
  assert.equal((await view()).secrets.find((secret: any) => secret.name === "SENTRY_DSN").skipped, true)
  assert.equal((await post("/api/projects/shop/secrets/delete", { name: "GOOGLE_CLIENT_ID" })).status, 200)
  assert.deepEqual((await view()).missing, ["GOOGLE_CLIENT_ID"])

  assert.equal((await post("/api/projects/shop/secrets/redeploy", {})).status, 409)
  withProjectStore(projectDir, (store) => store.setMeta("deploy.url", "https://shop.trycloudflare.com"))
  assert.equal((await post("/api/projects/shop/secrets/redeploy", {})).status, 202)
  assert.deepEqual(started.at(-1), { projectDir, command: ["deploy"] })
})

test("saving a secret without the key explains how to set it", async (t) => {
  const runsDir = join(scratch, "no-key")
  mkdirSync(runsDir)
  project(runsDir, "shop")
  const server = startUi({ runsDir, port: 0, auth: { mode: "none" }, notifications: false, secretsEnv: {}, startRun: () => {} })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const response = await fetch(`${base}/api/projects/shop/secrets`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify({ name: "API_KEY", value: "x" }) })
  assert.equal(response.status, 400)
  assert.match(((await response.json()) as any).error, /openssl rand -base64 32/)
  assert.equal(((await (await fetch(`${base}/api/projects/shop/secrets`)).json()) as any).key.state, "missing")
})
