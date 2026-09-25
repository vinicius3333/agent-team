import { matchesPath } from "./glob.ts"
import type { CommitGroup } from "./harness/workspace.ts"
import { extractJsonObject } from "./json.ts"

const conventionalPattern = /^(feat|fix|test|refactor|docs|style|chore|perf)(\([a-z0-9._/-]+\))?!?: \S.{0,71}$/i
const maxCommits = 8

export type CommitPlan = { kind: "none" } | { kind: "groups"; groups: CommitGroup[] } | { kind: "invalid"; reason: string }

// Reads the optional {"commits":[{"message","files"}]} block that ends a worker's final message.
// Each file lands in the first commit that lists it; changed files that no commit lists go into the task commit.
export function parseCommitPlan(summary: string, changed: string[]): CommitPlan {
  let parsed: any
  try {
    parsed = extractJsonObject(summary)
  } catch {
    return { kind: "none" }
  }
  if (!Array.isArray(parsed?.commits)) return { kind: "none" }
  const commits = parsed.commits as unknown[]
  if (!commits.length) return { kind: "none" }
  if (commits.length > maxCommits) return { kind: "invalid", reason: `${commits.length} commits; the limit is ${maxCommits}` }
  const changedSet = new Set(changed)
  const claimed = new Set<string>()
  const groups: CommitGroup[] = []
  for (const [index, commit] of commits.entries()) {
    const { message, files } = (commit ?? {}) as { message?: unknown; files?: unknown }
    if (typeof message !== "string" || !conventionalPattern.test(message.trim())) {
      return { kind: "invalid", reason: `commit ${index + 1}: message must be "<type>(<scope>): <subject>" with at most 72 characters of subject` }
    }
    if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) return { kind: "invalid", reason: `commit ${index + 1}: files must be an array of paths` }
    const unknown = files.filter((file) => !changedSet.has(file))
    if (unknown.length) return { kind: "invalid", reason: `commit ${index + 1} lists files the task did not change: ${unknown.join(", ")}` }
    const own = files.filter((file) => !claimed.has(file))
    for (const file of own) claimed.add(file)
    if (own.length) groups.push({ message: message.trim(), files: own })
  }
  return { kind: "groups", groups }
}

export interface PhaseCommit {
  message: string
  matches: string[]
  exclude?: string[]
}

// Sorts the phase's changed files into its commits by glob, in order; the first commit that matches a file takes it.
export function groupPhaseFiles(changed: string[], commits: PhaseCommit[]): CommitGroup[] {
  const claimed = new Set<string>()
  const matchesAny = (file: string, patterns: string[]) => patterns.some((pattern) => file === pattern || matchesPath(file, pattern))
  return commits.map(({ message, matches, exclude = [] }) => {
    const files = changed.filter((file) => !claimed.has(file) && matchesAny(file, matches) && !matchesAny(file, exclude))
    for (const file of files) claimed.add(file)
    return { message, files }
  })
}
