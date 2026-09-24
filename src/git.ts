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

export function commitPaths(dir: string, paths: string[], message: string): boolean {
  git(dir, ["add", "--", ...paths])
  const hasChanges = git(dir, ["diff", "--cached", "--name-only", "--", ...paths]).trim().length > 0
  if (hasChanges) git(dir, ["commit", "-q", "-m", message, "--", ...paths])
  return hasChanges
}

export function trackedFiles(dir: string): string[] {
  return git(dir, ["ls-files"]).split("\n").filter(Boolean)
}

// A file as committed on a branch, or null when the branch or the file does not exist there.
export function fileAtRef(dir: string, ref: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    return null
  }
}

export function commitOf(dir: string, ref: string): string {
  return git(dir, ["rev-parse", ref]).trim()
}

export function isAncestor(dir: string, ancestor: string, ref: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, ref], { cwd: dir, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function createBranch(dir: string, name: string, from: string): void {
  git(dir, ["branch", "-q", name, from])
}
