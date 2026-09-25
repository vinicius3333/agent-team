import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { lessonsPath } from "./lessons.ts"

// Solution memory: every merged task from every project, searchable by text (SQLite FTS5, BM25 ranking).
// A worker gets the closest solutions from other projects, so a problem solved once is not solved from scratch.
// Plain keyword search on purpose: it needs no embedding provider, and swapping in vectors later only changes search().

export interface Solution {
  project: string
  taskId: string
  title: string
  acceptance: string[]
  files: string[]
  summary: string
  diff: string
  stacks: string[]
  at: string
}

const maxDiffLength = 12_000
const maxSummaryLength = 2_000
const maxQueryTerms = 24
// Common words that match almost every task and would drown the useful terms.
const stopWords = new Set(["the", "and", "with", "that", "this", "from", "into", "each", "when", "then", "every", "page", "task", "user", "users", "shows", "show", "must", "should", "have", "their", "there", "which", "about", "only", "after", "before"])

export function memoryPath(projectDir: string): string {
  return join(dirname(lessonsPath(projectDir)), "memory.db")
}

function openMemory(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS solutions (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      acceptance TEXT NOT NULL,
      files TEXT NOT NULL,
      summary TEXT NOT NULL,
      diff TEXT NOT NULL,
      stacks TEXT NOT NULL,
      at TEXT NOT NULL,
      UNIQUE (project, task_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS solutions_search USING fts5(title, acceptance, files, summary, content='solutions', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS solutions_insert AFTER INSERT ON solutions BEGIN
      INSERT INTO solutions_search (rowid, title, acceptance, files, summary) VALUES (new.id, new.title, new.acceptance, new.files, new.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS solutions_delete AFTER DELETE ON solutions BEGIN
      INSERT INTO solutions_search (solutions_search, rowid, title, acceptance, files, summary) VALUES ('delete', old.id, old.title, old.acceptance, old.files, old.summary);
    END;
  `)
  return db
}

// A task merged again (a change request reusing an id, or a rerun) replaces its earlier entry.
export function recordSolution(path: string, solution: Omit<Solution, "at">): void {
  const db = openMemory(path)
  try {
    db.prepare("DELETE FROM solutions WHERE project = ? AND task_id = ?").run(solution.project, solution.taskId)
    db.prepare("INSERT INTO solutions (project, task_id, title, acceptance, files, summary, diff, stacks, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      solution.project,
      solution.taskId,
      solution.title,
      solution.acceptance.join("\n"),
      solution.files.join("\n"),
      solution.summary.slice(0, maxSummaryLength),
      solution.diff.length > maxDiffLength ? `${solution.diff.slice(0, maxDiffLength)}\n[diff truncated]` : solution.diff,
      JSON.stringify(solution.stacks),
      new Date().toISOString(),
    )
  } finally {
    db.close()
  }
}

export function searchQuery(text: string): string | null {
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].filter((term) => !stopWords.has(term)).slice(0, maxQueryTerms)
  return terms.length ? terms.map((term) => `"${term}"`).join(" OR ") : null
}

// Best matches first. Solutions from the same project are left out: the worker already sees that code.
// With stack tags, solutions that share at least one tag come first; the rest only fill the remaining slots.
export function searchSolutions(path: string, input: { text: string; excludeProject: string; stacks: string[]; limit: number }): Solution[] {
  const query = searchQuery(input.text)
  if (!query || input.limit <= 0) return []
  const db = openMemory(path)
  try {
    const rows = db
      .prepare(
        `SELECT s.project, s.task_id AS taskId, s.title, s.acceptance, s.files, s.summary, s.diff, s.stacks, s.at
         FROM solutions_search JOIN solutions s ON s.id = solutions_search.rowid
         WHERE solutions_search MATCH ? AND s.project != ?
         ORDER BY bm25(solutions_search, 4.0, 2.0, 1.0, 1.0) LIMIT ?`,
      )
      .all(query, input.excludeProject, input.limit * 5) as Record<string, string>[]
    const solutions = rows.map((row) => ({
      project: row.project,
      taskId: row.taskId,
      title: row.title,
      acceptance: row.acceptance ? row.acceptance.split("\n") : [],
      files: row.files ? row.files.split("\n") : [],
      summary: row.summary,
      diff: row.diff,
      stacks: JSON.parse(row.stacks) as string[],
      at: row.at,
    }))
    const shared = (solution: Solution) => solution.stacks.some((tag) => input.stacks.includes(tag) && tag !== "node")
    return [...solutions.filter(shared), ...solutions.filter((solution) => !shared(solution))].slice(0, input.limit)
  } finally {
    db.close()
  }
}

export function formatSolutions(solutions: Solution[], maxDiffShown = 4_000): string | null {
  if (!solutions.length) return null
  return [
    "## Similar tasks from earlier projects",
    "",
    "Other projects solved tasks like this one. Reuse what fits this project's stack and conventions, and ignore the rest. You cannot open their files: everything you get is below.",
    ...solutions.map((solution) => {
      const diff = solution.diff.length > maxDiffShown ? `${solution.diff.slice(0, maxDiffShown)}\n[diff truncated]` : solution.diff
      return [
        "",
        `### ${solution.project} ${solution.taskId}: ${solution.title}`,
        "",
        `Stack: ${solution.stacks.slice(0, 12).join(", ") || "unknown"}. Files: ${solution.files.slice(0, 15).join(", ")}.`,
        "",
        solution.summary.trim(),
        ...(diff.trim() ? ["", "```diff", diff.trim(), "```"] : []),
      ].join("\n")
    }),
  ].join("\n")
}
