import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface GitIdentity {
  name: string
  email: string
}

const emailPattern = /^[^\s@<>]+@[^\s@<>]+$/

function identityPath(runsDir: string): string {
  return join(runsDir, "git-identity.json")
}

export function readGitIdentity(runsDir: string): GitIdentity | null {
  const path = identityPath(runsDir)
  if (!existsSync(path)) return null
  try {
    return parseGitIdentity(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return null
  }
}

export function parseGitIdentity(body: unknown): GitIdentity {
  const { name, email } = (body ?? {}) as { name?: unknown; email?: unknown }
  if (typeof name !== "string" || !name.trim() || /[<>\n]/.test(name)) throw new Error("The name must be a non-empty line without < or >.")
  if (typeof email !== "string" || !emailPattern.test(email.trim())) throw new Error("The email must look like name@example.com.")
  return { name: name.trim(), email: email.trim() }
}

// Git reads these variables before any config, so every commit this process or its children make
// (runs, agents, the doctor) uses the identity, whatever the project's git config says.
export function applyGitIdentity(identity: GitIdentity | null): void {
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const
  for (const key of keys) {
    if (!identity) delete process.env[key]
    else process.env[key] = key.endsWith("NAME") ? identity.name : identity.email
  }
}

export function saveGitIdentity(runsDir: string, identity: GitIdentity): void {
  writeFileSync(identityPath(runsDir), JSON.stringify(identity, null, 2) + "\n")
  applyGitIdentity(identity)
}
