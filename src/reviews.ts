import { createHash } from "node:crypto"

export interface ReviewRow {
  taskId: string
  attempt: number
  verdict: "pass" | "fail"
  flaggedFiles: string[]
  fileHashes: Record<string, string>
}

export interface ReviewerMetrics {
  reviews: number
  fails: number
  // Fails followed by a later reviewed attempt of the same task; only these can be confirmed or not.
  followedFails: number
  // Fails where the next reviewed attempt changed at least one flagged file.
  confirmedFails: number
}

const fileHeaderPattern = /^diff --git a\/(.+?) b\/(.+)$/

export function diffFileHashes(diff: string): Record<string, string> {
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of diff.split("\n")) {
    const header = fileHeaderPattern.exec(line)
    if (header) {
      current = []
      sections.set(header[2], current)
    }
    current?.push(line)
  }
  return Object.fromEntries([...sections].map(([file, lines]) => [file, createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16)]))
}

// The files a fail verdict points at: those named in its reasons or fixes, else every file in the diff.
export function flaggedFiles(files: string[], verdict: { reasons: string[]; fixes: string[] }): string[] {
  const text = [...verdict.reasons, ...verdict.fixes].join("\n")
  const named = files.filter((file) => text.includes(file))
  return named.length ? named : files
}

export function reviewerMetrics(rows: ReviewRow[]): ReviewerMetrics {
  const metrics: ReviewerMetrics = { reviews: rows.length, fails: 0, followedFails: 0, confirmedFails: 0 }
  for (const [index, row] of rows.entries()) {
    if (row.verdict !== "fail") continue
    metrics.fails++
    const next = rows.slice(index + 1).find((later) => later.taskId === row.taskId && later.attempt > row.attempt)
    if (!next) continue
    metrics.followedFails++
    if (row.flaggedFiles.some((file) => next.fileHashes[file] !== row.fileHashes[file])) metrics.confirmedFails++
  }
  return metrics
}
