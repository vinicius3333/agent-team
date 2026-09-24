import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

export interface Workspace {
  path: string
  branch: string
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function worktreeRoot(repoDir: string): string {
  return join(repoDir, ".agent-team", "worktrees")
}

// One fresh worktree per attempt, branched from the current main, so a failed attempt never touches main.
export function createWorkspace(repoDir: string, name: string): Workspace {
  const path = join(worktreeRoot(repoDir), name)
  const branch = `agent/${name}`
  removeWorkspace(repoDir, { path, branch })
  git(repoDir, ["worktree", "add", "-q", "-b", branch, path, "main"])
  return { path, branch }
}

export function removeWorkspace(repoDir: string, workspace: Workspace): void {
  if (existsSync(workspace.path)) {
    try {
      git(repoDir, ["worktree", "remove", "--force", workspace.path])
    } catch {
      rmSync(workspace.path, { recursive: true, force: true })
    }
  }
  git(repoDir, ["worktree", "prune"])
  try {
    git(repoDir, ["branch", "-q", "-D", workspace.branch])
  } catch {}
}

// Commits the attempt and brings it into main. Rebases first when main moved since the worktree was created.
export function mergeWorkspace(repoDir: string, workspace: Workspace, message: string): void {
  git(workspace.path, ["add", "-A"])
  const hasChanges = git(workspace.path, ["diff", "--cached", "--name-only"]).trim().length > 0
  if (hasChanges) git(workspace.path, ["commit", "-q", "-m", message])
  try {
    git(workspace.path, ["rebase", "-q", "main"])
  } catch (error) {
    git(workspace.path, ["rebase", "--abort"])
    throw new Error(`rebase onto main failed: ${(error as Error).message}`)
  }
  git(repoDir, ["merge", "-q", "--ff-only", workspace.branch])
}

export function removeAllWorkspaces(repoDir: string): void {
  const root = worktreeRoot(repoDir)
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  git(repoDir, ["worktree", "prune"])
  const branches = git(repoDir, ["branch", "--list", "agent/*", "--format=%(refname:short)"]).split("\n").filter(Boolean)
  for (const branch of branches) git(repoDir, ["branch", "-q", "-D", branch])
}

export function detectSetupCommand(dir: string): string | null {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "corepack enable >/dev/null 2>&1; pnpm install --frozen-lockfile"
  if (existsSync(join(dir, "yarn.lock"))) return "corepack enable >/dev/null 2>&1; yarn install --frozen-lockfile"
  if (existsSync(join(dir, "package-lock.json"))) return "npm ci --no-audit --no-fund"
  if (existsSync(join(dir, "package.json"))) return "npm install --no-audit --no-fund"
  return null
}
