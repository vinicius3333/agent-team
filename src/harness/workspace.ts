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

// The branch checked out in the project folder (usually main) moves by a merge, because git refuses to fetch into it;
// any other branch moves by a fetch, which refuses non fast-forward updates.
export function fastForward(repoDir: string, ref: string, base = "main"): void {
  if (base === "main" || checkedOutBranch(repoDir) === base) git(repoDir, ["merge", "-q", "--ff-only", ref])
  else git(repoDir, ["fetch", "-q", ".", `${ref}:${base}`])
}

function checkedOutBranch(repoDir: string): string | null {
  try {
    return git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]).trim() || null
  } catch {
    return null
  }
}

// Merges ref into the workspace branch with a merge commit (history of a shared branch is never rewritten).
// Returns the conflicting files; on a conflict the merge is aborted and the workspace is left as it was.
export function mergeInto(workspace: Workspace, ref: string, message: string): string[] {
  try {
    git(workspace.path, ["merge", "-q", "--no-ff", "-m", message, ref])
    return []
  } catch (error) {
    const conflicts = git(workspace.path, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean)
    try {
      git(workspace.path, ["merge", "--abort"])
    } catch {}
    if (!conflicts.length) throw error
    return conflicts
  }
}

// Tracked files with local edits (staged or not). Untracked files do not count: git only refuses
// a merge for them when the merge would overwrite one, and that failure is reported like a conflict.
function dirtyTrackedFiles(repoDir: string): string[] {
  return git(repoDir, ["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, ""))
}

// Merges a branch into the checked-out main of the project folder with a merge commit.
// Local edits to tracked files are stashed first under a named message and stay in the stash list;
// if the merge fails, it is aborted and the stash is restored, so the folder is left as it was.
export function mergeIntoMain(repoDir: string, branch: string, message: string): void {
  const dirty = dirtyTrackedFiles(repoDir)
  if (dirty.length) {
    git(repoDir, ["stash", "push", "-q", "-m", `agent-team: auto-stash before merging ${branch}`])
    console.log(`[merge] stashed local changes: ${dirty.join(", ")}`)
  }
  try {
    git(repoDir, ["merge", "-q", "--no-ff", "-m", message, branch])
  } catch (error) {
    const conflicts = git(repoDir, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean)
    try {
      git(repoDir, ["merge", "--abort"])
    } catch {}
    if (dirty.length) git(repoDir, ["stash", "pop", "-q", "--index"])
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message
    const files = conflicts.length ? ` Conflicting files: ${conflicts.join(", ")}.` : ""
    const restored = dirty.length ? ` The local changes were restored: ${dirty.join(", ")}.` : ""
    throw new Error(`Merging ${branch} into main failed.${files}${restored} Git said: ${detail}`)
  }
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
