import { DatabaseSync } from "node:sqlite"

export type PhaseStatus = "pending" | "running" | "awaiting_approval" | "approved" | "failed"
export type TaskStatus = "pending" | "running" | "merged" | "blocked"

export interface TaskRow {
  id: string
  status: TaskStatus
  attempts: number
  lastFailure: string | null
}

export function openStore(path: string) {
  const db = new DatabaseSync(path)
  // WAL lets the dashboard read while a run writes; busy_timeout absorbs brief lock overlaps instead of crashing.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  db.exec(`
    CREATE TABLE IF NOT EXISTS phases (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_failure TEXT
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      runner TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_class TEXT,
      cost_usd REAL,
      duration_ms INTEGER NOT NULL,
      transcript_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runner_health (
      runner TEXT PRIMARY KEY,
      cooldown_until INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `)

  const attemptColumns = db.prepare("PRAGMA table_info(attempts)").all() as { name: string }[]
  if (!attemptColumns.some((column) => column.name === "failure_class")) db.exec("ALTER TABLE attempts ADD COLUMN failure_class TEXT")
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!taskColumns.some((column) => column.name === "issue_number")) db.exec("ALTER TABLE tasks ADD COLUMN issue_number INTEGER")

  // Projects created before the rename have a "mockups" phase row.
  db.exec("UPDATE OR IGNORE phases SET name = 'branding' WHERE name = 'mockups'")

  const now = () => new Date().toISOString()

  return {
    phaseStatus(name: string): PhaseStatus {
      const row = db.prepare("SELECT status FROM phases WHERE name = ?").get(name) as { status: PhaseStatus } | undefined
      return row?.status ?? "pending"
    },
    setPhase(name: string, status: PhaseStatus) {
      db.prepare(
        "INSERT INTO phases (name, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
      ).run(name, status, now())
    },
    phases() {
      return db.prepare("SELECT name, status, updated_at AS updatedAt FROM phases").all() as {
        name: string
        status: PhaseStatus
        updatedAt: string
      }[]
    },
    syncTasks(ids: string[]) {
      const insert = db.prepare("INSERT OR IGNORE INTO tasks (id, status) VALUES (?, 'pending')")
      for (const id of ids) insert.run(id)
    },
    task(id: string): TaskRow {
      return db
        .prepare("SELECT id, status, attempts, last_failure AS lastFailure FROM tasks WHERE id = ?")
        .get(id) as unknown as TaskRow
    },
    tasks(): TaskRow[] {
      return db
        .prepare("SELECT id, status, attempts, last_failure AS lastFailure FROM tasks ORDER BY id")
        .all() as unknown as TaskRow[]
    },
    updateTask(id: string, status: TaskStatus, lastFailure: string | null = null) {
      db.prepare("UPDATE tasks SET status = ?, last_failure = ? WHERE id = ?").run(status, lastFailure, id)
    },
    countAttempt(id: string) {
      db.prepare("UPDATE tasks SET attempts = attempts + 1 WHERE id = ?").run(id)
    },
    resetTask(id: string) {
      db.prepare("UPDATE tasks SET status = 'pending', attempts = 0, last_failure = NULL WHERE id = ?").run(id)
    },
    recordAttempt(attempt: {
      subject: string
      role: string
      runner: string
      model: string
      status: string
      failureClass: string | null
      costUsd: number | null
      durationMs: number
      transcriptPath: string
    }) {
      db.prepare(
        "INSERT INTO attempts (subject, role, runner, model, status, failure_class, cost_usd, duration_ms, transcript_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        attempt.subject,
        attempt.role,
        attempt.runner,
        attempt.model,
        attempt.status,
        attempt.failureClass,
        attempt.costUsd,
        attempt.durationMs,
        attempt.transcriptPath,
        now(),
      )
    },
    costByRole() {
      return db
        .prepare("SELECT role, COUNT(*) AS runs, ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS costUsd FROM attempts GROUP BY role")
        .all() as { role: string; runs: number; costUsd: number }[]
    },
    meta(key: string): string | null {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
      return row?.value ?? null
    },
    setMeta(key: string, value: string) {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
    },
    taskIssue(id: string): number | null {
      const row = db.prepare("SELECT issue_number AS issue FROM tasks WHERE id = ?").get(id) as { issue: number | null } | undefined
      return row?.issue ?? null
    },
    setTaskIssue(id: string, issue: number) {
      db.prepare("UPDATE tasks SET issue_number = ? WHERE id = ?").run(issue, id)
    },
    runnerCooldownUntil(runner: string): number {
      const row = db.prepare("SELECT cooldown_until AS until FROM runner_health WHERE runner = ?").get(runner) as { until: number } | undefined
      return row?.until ?? 0
    },
    coolDownRunner(runner: string, until: number, reason: string) {
      db.prepare(
        "INSERT INTO runner_health (runner, cooldown_until, reason) VALUES (?, ?, ?) ON CONFLICT(runner) DO UPDATE SET cooldown_until = excluded.cooldown_until, reason = excluded.reason",
      ).run(runner, until, reason)
    },
    runnerHealth() {
      return db.prepare("SELECT runner, cooldown_until AS until, reason FROM runner_health").all() as {
        runner: string
        until: number
        reason: string
      }[]
    },
    clearCooldowns() {
      db.exec("DELETE FROM runner_health")
    },
    close() {
      db.close()
    },
    log(type: string, message: string) {
      db.prepare("INSERT INTO events (at, type, message) VALUES (?, ?, ?)").run(now(), type, message)
      console.log(`[${type}] ${message}`)
    },
  }
}

export type Store = ReturnType<typeof openStore>
