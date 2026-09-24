import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs"
import { join } from "node:path"

function feedbackDir(projectDir: string): string {
  return join(projectDir, ".agent-team", "feedback")
}

function feedbackPath(projectDir: string, phase: string): string {
  return join(feedbackDir(projectDir), `${phase}.md`)
}

export function readFeedback(projectDir: string, phase: string): string | null {
  const path = feedbackPath(projectDir, phase)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

export function pendingFeedback(projectDir: string): Record<string, string> {
  const dir = feedbackDir(projectDir)
  if (!existsSync(dir)) return {}
  const entries = readdirSync(dir).filter((file) => /^[a-z]+\.md$/.test(file))
  const pending: Record<string, string> = {}
  for (const file of entries) {
    try {
      pending[file.slice(0, -".md".length)] = readFileSync(join(dir, file), "utf8")
    } catch {
      // A run archived the file between listing and reading it.
    }
  }
  return pending
}

export function appendFeedback(projectDir: string, phase: string, message: string): void {
  mkdirSync(feedbackDir(projectDir), { recursive: true })
  appendFileSync(feedbackPath(projectDir, phase), `## ${new Date().toISOString()}\n\n${message.trim()}\n\n`)
}

export function archiveFeedback(projectDir: string, phase: string): void {
  const path = feedbackPath(projectDir, phase)
  if (!existsSync(path)) return
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  renameSync(path, join(feedbackDir(projectDir), `${phase}.${timestamp}.done.md`))
}
