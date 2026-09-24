import { DatabaseSync } from "node:sqlite"

export type PhaseStatus = "pending" | "running" | "awaiting_approval" | "approved" | "failed"
export type TaskStatus = "pending" | "running" | "merged" | "blocked"

export type ChatAuthor = "human" | "lead"
export type LeadActionState = "proposed" | "applied" | "dismissed"

// An action the lead suggests. It only runs when a person applies it from the dashboard.
export type LeadAction = { state: LeadActionState; reason: string } & (
  | { kind: "retry"; taskId: string }
  | { kind: "resume" }
  | { kind: "approve"; phase: string }
  | { kind: "request_changes"; phase: string; message: string }
  | { kind: "raise_budget" }
)

export interface ChatMessage {
  id: number
  at: string
  author: ChatAuthor
  body: string
  actions: LeadAction[]
}

export interface TaskRow {
  id: string
  status: TaskStatus
  attempts: number
  lastFailure: string | null
  replans: number
  // Set when an automatic decision needs a person (a replan that widens scope into shared files, or an escalation).
  humanReason: string | null
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
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      flagged_files TEXT NOT NULL,
      file_hashes TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      actions TEXT NOT NULL DEFAULT '[]'
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
  if (!attemptColumns.some((column) => column.name === "tokens")) db.exec("ALTER TABLE attempts ADD COLUMN tokens INTEGER")
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!taskColumns.some((column) => column.name === "issue_number")) db.exec("ALTER TABLE tasks ADD COLUMN issue_number INTEGER")
  if (!taskColumns.some((column) => column.name === "replans")) db.exec("ALTER TABLE tasks ADD COLUMN replans INTEGER NOT NULL DEFAULT 0")
  if (!taskColumns.some((column) => column.name === "human_reason")) db.exec("ALTER TABLE tasks ADD COLUMN human_reason TEXT")

  // Projects created before the rename have a "mockups" phase row.
  db.exec("UPDATE OR IGNORE phases SET name = 'branding' WHERE name = 'mockups'")

  const taskColumnsSql = "id, status, attempts, last_failure AS lastFailure, replans, human_reason AS humanReason"
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
        .prepare(`SELECT ${taskColumnsSql} FROM tasks WHERE id = ?`)
        .get(id) as unknown as TaskRow
    },
    tasks(): TaskRow[] {
      return db
        .prepare(`SELECT ${taskColumnsSql} FROM tasks ORDER BY id`)
        .all() as unknown as TaskRow[]
    },
    updateTask(id: string, status: TaskStatus, lastFailure: string | null = null) {
      db.prepare("UPDATE tasks SET status = ?, last_failure = ? WHERE id = ?").run(status, lastFailure, id)
    },
    countAttempt(id: string) {
      db.prepare("UPDATE tasks SET attempts = attempts + 1 WHERE id = ?").run(id)
    },
    // Keeps the replan count, so an automatic replan cannot loop; a human retry clears it with resetReplans.
    resetTask(id: string) {
      db.prepare("UPDATE tasks SET status = 'pending', attempts = 0, last_failure = NULL, human_reason = NULL WHERE id = ?").run(id)
    },
    resetReplans(id: string) {
      db.prepare("UPDATE tasks SET replans = 0 WHERE id = ?").run(id)
    },
    countReplan(id: string) {
      db.prepare("UPDATE tasks SET replans = replans + 1 WHERE id = ?").run(id)
    },
    requireHuman(id: string, reason: string) {
      db.prepare("UPDATE tasks SET status = 'blocked', last_failure = ?, human_reason = ? WHERE id = ?").run(reason, reason, id)
    },
    removeTask(id: string) {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
    },
    recordAttempt(attempt: {
      subject: string
      role: string
      runner: string
      model: string
      status: string
      failureClass: string | null
      costUsd: number | null
      tokens: number | null
      durationMs: number
      transcriptPath: string
    }) {
      db.prepare(
        "INSERT INTO attempts (subject, role, runner, model, status, failure_class, cost_usd, tokens, duration_ms, transcript_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        attempt.subject,
        attempt.role,
        attempt.runner,
        attempt.model,
        attempt.status,
        attempt.failureClass,
        attempt.costUsd,
        attempt.tokens ?? null,
        attempt.durationMs,
        attempt.transcriptPath,
        now(),
      )
    },
    // Cost of every agent call the run made; codex reports none, so its calls are counted instead.
    // Doctor calls have their own limit (doctor.maxUsdPerIncident) and lead chats are started by a person, so neither uses up the run budget.
    projectCost(): { usd: number; unreportedCalls: number } {
      const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(cost_usd IS NULL), 0) AS unreported FROM attempts WHERE role NOT IN ('doctor', 'lead')").get() as { usd: number; unreported: number }
      return { usd: row.usd, unreportedCalls: row.unreported }
    },
    // fileHashes maps each file in the reviewed diff to a hash of its part of the diff, so a later attempt can be compared.
    recordReview(review: { taskId: string; attempt: number; verdict: "pass" | "fail"; flaggedFiles: string[]; fileHashes: Record<string, string> }) {
      db.prepare("INSERT INTO reviews (task_id, attempt, verdict, flagged_files, file_hashes, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        review.taskId,
        review.attempt,
        review.verdict,
        JSON.stringify(review.flaggedFiles),
        JSON.stringify(review.fileHashes),
        now(),
      )
    },
    setTaskFiles(id: string, files: string[]) {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`task.files.${id}`, JSON.stringify(files))
    },
    taskFiles(id: string): string[] {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`task.files.${id}`) as { value: string } | undefined
      return row ? (JSON.parse(row.value) as string[]) : []
    },
    // Newest first. subjectPrefix narrows to one task or phase, for example "T005-".
    recentAttempts(subjectPrefix: string | null, limit: number) {
      const columns = "subject, role, runner, model, status, failure_class AS failureClass, cost_usd AS costUsd, transcript_path AS transcriptPath, created_at AS createdAt"
      const rows = subjectPrefix
        ? db.prepare(`SELECT ${columns} FROM attempts WHERE subject LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`).all(`${subjectPrefix.replace(/[\\%_]/g, "\\$&")}%`, limit)
        : db.prepare(`SELECT ${columns} FROM attempts ORDER BY id DESC LIMIT ?`).all(limit)
      return rows as unknown as { subject: string; role: string; runner: string; model: string; status: string; failureClass: string | null; costUsd: number | null; transcriptPath: string; createdAt: string }[]
    },
    lastAttemptAt(): string | null {
      const row = db.prepare("SELECT created_at AS at FROM attempts ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined
      return row?.at ?? null
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
    lastEvent(): { at: string; type: string; message: string } | null {
      return (db.prepare("SELECT at, type, message FROM events ORDER BY id DESC LIMIT 1").get() as { at: string; type: string; message: string } | undefined) ?? null
    },
    // Newest first.
    recentEvents(limit: number): { at: string; type: string; message: string }[] {
      return db.prepare("SELECT at, type, message FROM events ORDER BY id DESC LIMIT ?").all(limit) as { at: string; type: string; message: string }[]
    },
    addChatMessage(author: ChatAuthor, body: string, actions: LeadAction[] = []): number {
      const result = db.prepare("INSERT INTO chat_messages (at, author, body, actions) VALUES (?, ?, ?, ?)").run(now(), author, body, JSON.stringify(actions))
      return Number(result.lastInsertRowid)
    },
    // Oldest first.
    chatMessages(limit: number): ChatMessage[] {
      const rows = db.prepare("SELECT id, at, author, body, actions FROM chat_messages ORDER BY id DESC LIMIT ?").all(limit) as { id: number; at: string; author: ChatAuthor; body: string; actions: string }[]
      return rows.reverse().map((row) => ({ ...row, actions: JSON.parse(row.actions) as LeadAction[] }))
    },
    setChatActionState(messageId: number, index: number, state: LeadActionState): boolean {
      const row = db.prepare("SELECT actions FROM chat_messages WHERE id = ? AND author = 'lead'").get(messageId) as { actions: string } | undefined
      const actions = row ? (JSON.parse(row.actions) as LeadAction[]) : []
      if (!actions[index]) return false
      actions[index].state = state
      db.prepare("UPDATE chat_messages SET actions = ? WHERE id = ?").run(JSON.stringify(actions), messageId)
      return true
    },
    log(type: string, message: string) {
      db.prepare("INSERT INTO events (at, type, message) VALUES (?, ?, ?)").run(now(), type, message)
      console.log(`[${type}] ${message}`)
    },
  }
}

export type Store = ReturnType<typeof openStore>
