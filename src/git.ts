import { execFileSync } from "node:child_process"

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

export function initRepository(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"])
  const hasIdentity = (() => {
    try {
      return Boolean(git(dir, ["config", "user.email"]).trim())
    } catch {
      return false
    }
  })()
  if (!hasIdentity) {
    git(dir, ["config", "user.name", "agent-team"])
    git(dir, ["config", "user.email", "agent-team@localhost"])
  }
}

export function changedFiles(dir: string): string[] {
  return git(dir, ["status", "--porcelain", "-uall", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
}

export function stagedDiff(dir: string): string {
  git(dir, ["add", "-A"])
  return git(dir, ["diff", "--cached"])
}

export function commitAll(dir: string, message: string): boolean {
  git(dir, ["add", "-A"])
  const hasChanges = git(dir, ["diff", "--cached", "--name-only"]).trim().length > 0
  if (hasChanges) git(dir, ["commit", "-q", "-m", message])
  return hasChanges
}
