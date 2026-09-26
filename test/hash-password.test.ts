import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { verifyPassword } from "../src/ui/auth.ts"

const repoDir = fileURLToPath(new URL("..", import.meta.url))

// Same pipe as the deploy.json start command: printf %s "$DEMO_PASSWORD" sends no trailing newline.
function hashFromCli(password: string): string {
  return execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "hash-password"], { cwd: repoDir, input: password, encoding: "utf8" }).trim()
}

test("hash-password makes a hash the login check accepts for exactly that password", () => {
  const password = "demo-password-2026"
  const hash = hashFromCli(password)
  assert.equal(verifyPassword(password, hash), true)
  assert.equal(verifyPassword(`${password} `, hash), false)
})
