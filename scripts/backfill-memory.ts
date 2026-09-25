// Fills the solution memory from projects built before it existed: one entry per task in docs/progress.md,
// with the acceptance criteria from tasks.json and the diff of the task's feat(<id>) commits on main.
// Usage: node scripts/backfill-memory.ts <runsDir>
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { projectStacks } from "../src/lessons.ts"
import { memoryPath, recordSolution } from "../src/memory.ts"
import type { Task } from "../src/tasks.ts"

const runsDir = resolve(process.argv[2] ?? "")
if (!process.argv[2]) {
  console.error("Usage: node scripts/backfill-memory.ts <runsDir>")
  process.exit(1)
}

interface ProgressEntry {
  id: string
  title: string
  files: string[]
  summary: string
}

function parseProgress(markdown: string): ProgressEntry[] {
  const entries: ProgressEntry[] = []
  for (const block of markdown.split(/^## (?=[A-Z]+\d+: )/m).slice(1)) {
    const [heading, ...rest] = block.split("\n")
    const match = /^([A-Z]+\d+): (.*)$/.exec(heading.trim())
    if (!match) continue
    const filesLine = rest.find((line) => line.startsWith("Files: ")) ?? ""
    const files = [...filesLine.matchAll(/`([^`]+)`/g)].map((file) => file[1])
    const summary = rest.filter((line) => line.startsWith("> ")).map((line) => line.slice(2)).join("\n")
    entries.push({ id: match[1], title: match[2], files, summary })
  }
  return entries
}

// Tasks land either as a pull request merge (branch agent/<id>-<attempt>) or as commits named feat(<id>).
function taskDiff(projectDir: string, taskId: string): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  try {
    const [merge] = git(["log", "main", "--merges", "--format=%H", "--fixed-strings", `--grep=/agent/${taskId}-`]).split("\n").filter(Boolean)
    if (merge) return git(["diff", "--no-color", `${merge}^1`, merge])
    const commits = git(["log", "main", "--no-merges", "--format=%H", "--fixed-strings", `--grep=(${taskId})`]).split("\n").filter(Boolean)
    return commits.length ? git(["show", "--format=", "--no-color", ...commits.reverse()]) : ""
  } catch {
    return ""
  }
}

function readTasks(projectDir: string): Task[] {
  try {
    return JSON.parse(readFileSync(join(projectDir, "tasks.json"), "utf8"))
  } catch {
    return []
  }
}

let total = 0
for (const project of readdirSync(runsDir).sort()) {
  const projectDir = join(runsDir, project)
  const progress = join(projectDir, "docs", "progress.md")
  if (!existsSync(progress) || !existsSync(join(projectDir, ".git"))) continue
  const tasks = readTasks(projectDir)
  const stacks = projectStacks(projectDir)
  const entries = parseProgress(readFileSync(progress, "utf8"))
  for (const entry of entries) {
    const task = tasks.find((candidate) => candidate.id === entry.id)
    recordSolution(memoryPath(projectDir), {
      project,
      taskId: entry.id,
      title: entry.title,
      acceptance: task?.acceptance ?? [],
      files: entry.files,
      summary: entry.summary,
      diff: taskDiff(projectDir, entry.id),
      stacks,
    })
  }
  total += entries.length
  console.log(`${project}: ${entries.length} tasks (${stacks.slice(0, 8).join(", ") || "no stack tags"})`)
}
console.log(`recorded ${total} solutions in ${memoryPath(join(runsDir, "x"))}`)
