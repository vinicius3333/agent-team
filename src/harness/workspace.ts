import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function worktreeRoot(repoDir: string): string {
  return join(repoDir, ".agent-team", "worktrees")
}

export interface Workspace {
  path: string
  branch: string
  // The branch the workspace starts from and lands on: main, or the open change's branch.
  base: string
}

// One fresh worktree per attempt, branched from the current base, so a failed attempt never touches it.
export function createWorkspace(repoDir: string, name: string, base = "main"): Workspace {
  const path = join(worktreeRoot(repoDir), name)
  const branch = `agent/${name}`
  removeWorkspace(repoDir, { path, branch, base })
  git(repoDir, ["worktree", "add", "-q", "-b", branch, path, base])
  return { path, branch, base }
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

export interface CommitGroup {
  message: string
  files: string[]
}

// Commits the attempt as one commit per group, then the files no group claimed under `message`,
// and rebases it on the base branch, so it can be merged fast-forward (locally or through a pull request).
export function commitAndRebase(workspace: Workspace, message: string, groups: CommitGroup[] = []): void {
  git(workspace.path, ["add", "-A"])
  for (const group of groups) {
    if (!group.files.length) continue
    const staged = git(workspace.path, ["diff", "--cached", "--name-only", "--", ...group.files]).trim()
    if (staged) git(workspace.path, ["commit", "-q", "-m", group.message, "--", ...group.files])
  }
  const hasChanges = git(workspace.path, ["diff", "--cached", "--name-only"]).trim().length > 0
  if (hasChanges) git(workspace.path, ["commit", "-q", "-m", message])
  try {
    git(workspace.path, ["rebase", "-q", workspace.base])
  } catch (error) {
    git(workspace.path, ["rebase", "--abort"])
    throw new Error(`rebase onto ${workspace.base} failed: ${(error as Error).message}`)
  }
}

// Folds the files written after the rebase into the task commit, or makes one if the task changed nothing.
export function amendCommit(workspace: Workspace, message: string): void {
  git(workspace.path, ["add", "-A"])
  const committed = git(workspace.path, ["rev-parse", "HEAD"]).trim() !== git(workspace.path, ["rev-parse", workspace.base]).trim()
  git(workspace.path, committed ? ["commit", "-q", "--amend", "--no-edit"] : ["commit", "-q", "-m", message])
}

// main is checked out in the project folder, so it moves by a merge; any other branch moves by a fetch, which refuses non fast-forward updates.
export function fastForward(repoDir: string, ref: string, base = "main"): void {
  if (base === "main") git(repoDir, ["merge", "-q", "--ff-only", ref])
  else git(repoDir, ["fetch", "-q", ".", `${ref}:${base}`])
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
