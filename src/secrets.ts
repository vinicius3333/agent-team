import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { dirname, join } from "node:path"
import { fileAtRef } from "./git.ts"
import type { Store } from "./store.ts"

// Secrets the generated app needs at deploy (API keys, OAuth clients). The app declares them in .env.example
// on main; a person enters the values on the dashboard; deploy passes them to the app container.
// Values are encrypted with AES-256-GCM under a key that lives only in the host environment.

export const secretsKeyEnv = "AGENT_TEAM_SECRETS_KEY"
export const envExamplePath = ".env.example"
export const skippedSecretsKey = "secrets.skipped"
// Logged by the deploy gate; the notifier matches on it.
export const secretsWaitingText = "waits for secrets"

export const secretScopes = ["project", "global"] as const
export type SecretScope = (typeof secretScopes)[number]

const namePattern = /^[A-Z][A-Z0-9_]{0,127}$/
const valueMaxLength = 16 * 1024
const keyHint = `Make one with: openssl rand -base64 32`

// The orchestrator sets these on every app container (src/deploy.ts), so a secret may not replace them.
export const reservedNames: ReadonlySet<string> = new Set([
  "HOME", "PORT", "HOST", "NODE_ENV", "NPM_CONFIG_INCLUDE",
  "APP_URL", "PUBLIC_URL", "BASE_URL", "NEXT_PUBLIC_APP_URL", "NEXTAUTH_URL", "ORIGIN",
  "DEMO_EMAIL", "DEMO_PASSWORD",
  "POSTHOG_KEY", "VITE_POSTHOG_KEY", "POSTHOG_HOST",
])

export interface SecretRequirement {
  name: string
  description: string
  // Declared with a comment that starts with "optional": deploy does not wait for it.
  optional: boolean
}

export interface SecretStatus extends SecretRequirement {
  // False for a project secret that .env.example does not list: it is still passed to the app.
  declared: boolean
  // Where the value comes from; null when no value is set.
  source: SecretScope | null
  skipped: boolean
  updatedAt: string | null
}

export type SecretsKey = { state: "ready"; key: Buffer } | { state: "missing" | "invalid"; error: string }

export class SecretError extends Error {}

// Each KEY= line is one secret; the comment lines right above it describe it.
export function parseEnvExample(text: string): SecretRequirement[] {
  const requirements = new Map<string, SecretRequirement>()
  let comments: string[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) {
      comments = []
      continue
    }
    if (line.startsWith("#")) {
      comments.push(line.replace(/^#+\s*/, ""))
      continue
    }
    const name = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
    if (name && namePattern.test(name) && !reservedNames.has(name) && !requirements.has(name)) {
      const optional = /^optional\b/i.test(comments[0] ?? "")
      const description = comments.join(" ").replace(/^optional\b[:\s-]*/i, "").trim()
      requirements.set(name, { name, description, optional })
    }
    comments = []
  }
  return [...requirements.values()]
}

export function secretRequirements(projectDir: string, ref = "main"): SecretRequirement[] {
  return parseEnvExample(fileAtRef(projectDir, ref, envExamplePath) ?? "")
}

export function readSecretsKey(env: NodeJS.ProcessEnv = process.env): SecretsKey {
  const value = env[secretsKeyEnv]?.trim()
  if (!value) return { state: "missing", error: `Set ${secretsKeyEnv} on the host to store secrets. ${keyHint}` }
  const key = Buffer.from(value, "base64")
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    return { state: "invalid", error: `${secretsKeyEnv} must be 32 random bytes in base64. ${keyHint}` }
  }
  return { state: "ready", key }
}

function requireKey(env: NodeJS.ProcessEnv): Buffer {
  const key = readSecretsKey(env)
  if (key.state !== "ready") throw new SecretError(key.error)
  return key.key
}

// The secret's name is authenticated data, so a stored value cannot be moved to another name.
export function encryptSecret(name: string, value: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(name))
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return ["v1", iv, cipher.getAuthTag(), data].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".")
}

export function decryptSecret(name: string, stored: string, key: Buffer): string {
  const [version, iv, tag, data] = stored.split(".")
  try {
    if (version !== "v1") throw new Error(`unknown format ${version}`)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
    decipher.setAAD(Buffer.from(name))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")
  } catch {
    throw new SecretError(`Cannot decrypt ${name}: ${secretsKeyEnv} changed since it was saved. Enter the value again.`)
  }
}

export function validateSecret(name: unknown, value: unknown): { name: string; value: string } {
  if (typeof name !== "string" || !namePattern.test(name)) throw new SecretError("The name must be upper case letters, digits, and underscores, starting with a letter.")
  if (reservedNames.has(name)) throw new SecretError(`${name} is set by agent-team on every app, so it cannot be a secret.`)
  if (typeof value !== "string" || !value.length) throw new SecretError("The value must not be empty.")
  if (value.length > valueMaxLength || value.includes("\0")) throw new SecretError(`The value must be text under ${valueMaxLength / 1024} KB.`)
  return { name, value }
}

// Project secrets share state.db with the project store; global secrets sit next to the projects,
// like the shared lessons, and reach an app only when its .env.example declares them.
export function vaultPath(scope: SecretScope, projectDir: string): string {
  return scope === "project" ? join(projectDir, ".agent-team", "state.db") : globalVaultPath(dirname(projectDir))
}

export function globalVaultPath(runsDir: string): string {
  return join(runsDir, ".agent-team-secrets.db")
}

export function withVault<T>(path: string, use: (vault: Vault) => T): T {
  const vault = openVault(path)
  try {
    return use(vault)
  } finally {
    vault.close()
  }
}

export type Vault = ReturnType<typeof openVault>

export function openVault(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  db.exec("CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)")
  return {
    entries(): { name: string; updatedAt: string }[] {
      return db.prepare("SELECT name, updated_at AS updatedAt FROM secrets ORDER BY name").all() as { name: string; updatedAt: string }[]
    },
    values(key: Buffer, names?: string[]): Record<string, string> {
      const rows = db.prepare("SELECT name, value FROM secrets ORDER BY name").all() as { name: string; value: string }[]
      return Object.fromEntries(rows.filter((row) => !names || names.includes(row.name)).map((row) => [row.name, decryptSecret(row.name, row.value, key)]))
    },
    write(name: string, value: string, key: Buffer) {
      db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(
        name,
        encryptSecret(name, value, key),
        new Date().toISOString(),
      )
    },
    remove(name: string): boolean {
      return Number(db.prepare("DELETE FROM secrets WHERE name = ?").run(name).changes) > 0
    },
    close() {
      db.close()
    },
  }
}

export function skippedSecrets(store: Store): string[] {
  try {
    const parsed = JSON.parse(store.meta(skippedSecretsKey) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : []
  } catch {
    return []
  }
}

export function setSecretSkipped(store: Store, name: string, skipped: boolean): void {
  if (!namePattern.test(name)) throw new SecretError("Unknown secret name.")
  const names = new Set(skippedSecrets(store))
  if (skipped) names.add(name)
  else names.delete(name)
  store.setMeta(skippedSecretsKey, JSON.stringify([...names].sort()))
  store.log("secrets", skipped ? `${name} skipped: deploy goes on without it` : `${name} no longer skipped`)
}

export function secretStatuses(options: {
  requirements: SecretRequirement[]
  project: { name: string; updatedAt: string }[]
  global: { name: string; updatedAt: string }[]
  skipped: string[]
}): SecretStatus[] {
  const { requirements, project, global, skipped } = options
  const declared = requirements.map((requirement) => {
    const own = project.find((entry) => entry.name === requirement.name)
    const shared = global.find((entry) => entry.name === requirement.name)
    const entry = own ?? shared
    return { ...requirement, declared: true, source: own ? ("project" as const) : shared ? ("global" as const) : null, skipped: skipped.includes(requirement.name), updatedAt: entry?.updatedAt ?? null }
  })
  const extra = project
    .filter((entry) => !requirements.some((requirement) => requirement.name === entry.name))
    .map((entry) => ({ name: entry.name, description: "", optional: true, declared: false, source: "project" as const, skipped: false, updatedAt: entry.updatedAt }))
  return [...declared, ...extra]
}

export function missingSecrets(statuses: SecretStatus[]): string[] {
  return statuses.filter((status) => status.declared && !status.optional && !status.source && !status.skipped).map((status) => status.name)
}

export function projectSecretStatuses(projectDir: string, store: Store): SecretStatus[] {
  return secretStatuses({
    requirements: secretRequirements(projectDir),
    project: withVault(vaultPath("project", projectDir), (vault) => vault.entries()),
    global: withVault(vaultPath("global", projectDir), (vault) => vault.entries()),
    skipped: skippedSecrets(store),
  })
}

// The values deploy passes to the app: global ones the app declares, then the project's own, which win.
export function appSecretEnv(projectDir: string, requirements: SecretRequirement[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const declared = requirements.map((requirement) => requirement.name)
  const project = withVault(vaultPath("project", projectDir), (vault) => vault.entries())
  const global = withVault(vaultPath("global", projectDir), (vault) => vault.entries()).filter((entry) => declared.includes(entry.name))
  if (!project.length && !global.length) return {}
  const key = requireKey(env)
  return {
    ...withVault(vaultPath("global", projectDir), (vault) => vault.values(key, declared)),
    ...withVault(vaultPath("project", projectDir), (vault) => vault.values(key)),
  }
}

export function saveSecret(path: string, name: unknown, value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const secret = validateSecret(name, value)
  const key = requireKey(env)
  withVault(path, (vault) => vault.write(secret.name, secret.value, key))
  return secret.name
}

export function removeSecret(path: string, name: unknown): boolean {
  if (typeof name !== "string" || !namePattern.test(name)) throw new SecretError("Unknown secret name.")
  return withVault(path, (vault) => vault.remove(name))
}

export function secretsKeyStatus(env: NodeJS.ProcessEnv = process.env): { state: SecretsKey["state"]; error: string | null } {
  const key = readSecretsKey(env)
  return { state: key.state, error: key.state === "ready" ? null : key.error }
}

// Moves a deploy that waits for secrets back to pending once none is missing; the caller starts the run.
export function releaseDeployGate(projectDir: string, store: Store): boolean {
  if (store.phaseStatus("deploy") !== "awaiting_approval") return false
  if (missingSecrets(projectSecretStatuses(projectDir, store)).length) return false
  store.setPhase("deploy", "pending")
  store.log("gate", `phase "deploy" has every secret it needs; deploy resumes`)
  return true
}

export function projectSecretsView(projectDir: string, store: Store, env: NodeJS.ProcessEnv = process.env) {
  const secrets = projectSecretStatuses(projectDir, store)
  return {
    key: secretsKeyStatus(env),
    secrets,
    missing: missingSecrets(secrets),
    deployWaiting: store.phaseStatus("deploy") === "awaiting_approval",
    live: Boolean(store.meta("deploy.url")),
    // Where the app was last deployed; OAuth redirect URIs in the descriptions point here.
    url: store.meta("deploy.url") || null,
  }
}

// Global values, which projects declare each one, and the names projects declare that have no global value yet.
export function globalSecretsView(runsDir: string, projects: string[], env: NodeJS.ProcessEnv = process.env) {
  const entries = withVault(globalVaultPath(runsDir), (vault) => vault.entries())
  const declared = projects.map((project) => ({ project, requirements: secretRequirements(join(runsDir, project)) }))
  const usedBy = (name: string) => declared.filter(({ requirements }) => requirements.some((requirement) => requirement.name === name)).map(({ project }) => project)
  const wanted = [...new Set(declared.flatMap(({ requirements }) => requirements.map((requirement) => requirement.name)))]
    .filter((name) => !entries.some((entry) => entry.name === name))
    .sort()
    .map((name) => ({ name, usedBy: usedBy(name) }))
  return { key: secretsKeyStatus(env), secrets: entries.map((entry) => ({ ...entry, usedBy: usedBy(entry.name) })), wanted }
}
