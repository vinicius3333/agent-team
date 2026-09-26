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
  | { kind: "add_task"; task: TaskDraft }
  | { kind: "edit_task"; taskId: string; changes: TaskChanges }
)

// A task the lead proposes; applying it appends a full task to tasks.json.
export interface TaskDraft {
  title: string
  story: string
  allowedPaths: string[]
  readPaths: string[]
  acceptance: string[]
  dependsOn: string[]
  verify: string
  ui: boolean
}

export type TaskChanges = Partial<Pick<TaskDraft, "title" | "story" | "allowedPaths" | "readPaths" | "acceptance" | "verify">>

// Extra data kept with a chat message: images the person attached, what the lead read, and follow-up prompts.
export interface ChatDetails {
  attachments: string[]
  filesRead: string[]
  followUps: string[]
}

export const chatSessionMetaKey = "chat.session"

export interface ChatSession {
  id: number
  title: string
  startedAt: string
  updatedAt: string
  messages: number
}

export const emptyChatDetails: ChatDetails = { attachments: [], filesRead: [], followUps: [] }

export interface ChatMessage {
  id: number
  at: string
  author: ChatAuthor
  body: string
  actions: LeadAction[]
  details: ChatDetails
}

export type ChangeStatus = "open" | "merged" | "failed" | "abandoned"

export interface Change {
  id: string
  request: string
  status: ChangeStatus
  branch: string
  baseCommit: string
  prUrl: string | null
  createdAt: string
  finishedAt: string | null
}

export const currentChangeKey = "change.current"

export const insightAgents = ["monitoring", "analytics", "research"] as const
export type InsightAgent = (typeof insightAgents)[number]
// The backlog that sprints draw from: the Operate agents' findings, the evaluator's gaps, the product
// manager's feature proposals, items a person added by hand, and findings of custom routines.
export const findingSources = [...insightAgents, "evaluator", "product", "manual", "routine"] as const
export type FindingSource = (typeof findingSources)[number]
export const findingSeverities = ["high", "medium", "low"] as const
export type FindingSeverity = (typeof findingSeverities)[number]
export const findingStatuses = ["open", "approved", "dismissed"] as const
export type FindingStatus = (typeof findingStatuses)[number]

export interface Finding {
  id: number
  source: FindingSource
  severity: FindingSeverity
  title: string
  evidence: string
  proposal: string
  status: FindingStatus
  changeId: string | null
  createdAt: string
  updatedAt: string
}

export type NewFinding = Pick<Finding, "source" | "severity" | "title" | "evidence" | "proposal">

export const sprintStatuses = ["planning", "building", "done", "skipped", "failed", "abandoned"] as const
export type SprintStatus = (typeof sprintStatuses)[number]

export interface Sprint {
  number: number
  status: SprintStatus
  goal: string
  score: number | null
  changeId: string | null
  // Project cost when the sprint started; the sprint's cost is the growth from here.
  costAtStart: number
  costUsd: number | null
  note: string
  startedAt: string
  finishedAt: string | null
}

export interface HealthCheck {
  at: string
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
  error: string | null
}

export type InsightRunStatus = "running" | "done" | "failed"

export interface InsightRun {
  id: number
  agent: InsightAgent
  startedAt: string
  finishedAt: string | null
  status: InsightRunStatus
  summary: string
  findings: number
}

export interface RoutineFile {
  // Relative to the project folder.
  file: string
  caption: string
}

export interface RoutineRun {
  id: number
  routine: string
  startedAt: string
  finishedAt: string | null
  status: InsightRunStatus
  summary: string
  // null when the runner does not report cost (codex); spend then counts budgetUsd.
  costUsd: number | null
  budgetUsd: number
  findings: number
  files: RoutineFile[]
}

export interface Metric {
  at: string
  key: string
  value: number
}

const snapshotMetricPrefixes = ["funnel.", "event."]
const healthRetentionMs = 14 * 24 * 60 * 60_000

export function findingFingerprint(source: string, title: string): string {
  return `${source}:${title.toLowerCase().replace(/\s+/g, " ").trim()}`
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

// A per-task budget raised by a person, and the limit a task stopped at while it waits for that approval.
export const taskBudgetKey = (taskId: string) => `task.budgetUsd.${taskId}`
export const taskBudgetStopKey = (taskId: string) => `task.budgetStop.${taskId}`

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
      actions TEXT NOT NULL DEFAULT '[]',
      details TEXT NOT NULL DEFAULT '{}',
      session INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY,
      request TEXT NOT NULL,
      status TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      pr_url TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS phase_history (
      change_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      evidence TEXT NOT NULL,
      proposal TEXT NOT NULL,
      status TEXT NOT NULL,
      change_id TEXT,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_checks (
      at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      status_code INTEGER,
      latency_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS health_checks_at ON health_checks (at);
    CREATE TABLE IF NOT EXISTS insight_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      findings INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS routine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      cost_usd REAL,
      budget_usd REAL NOT NULL,
      findings INTEGER NOT NULL DEFAULT 0,
      files TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS metrics (
      at TEXT NOT NULL,
      key TEXT NOT NULL,
      value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS metrics_key_at ON metrics (key, at);
    CREATE TABLE IF NOT EXISTS sprints (
      number INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      score INTEGER,
      change_id TEXT,
      cost_at_start REAL NOT NULL,
      cost_usd REAL,
      note TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
  `)

  const attemptColumns = db.prepare("PRAGMA table_info(attempts)").all() as { name: string }[]
  if (!attemptColumns.some((column) => column.name === "failure_class")) db.exec("ALTER TABLE attempts ADD COLUMN failure_class TEXT")
  if (!attemptColumns.some((column) => column.name === "tokens")) db.exec("ALTER TABLE attempts ADD COLUMN tokens INTEGER")
  if (!attemptColumns.some((column) => column.name === "change_id")) db.exec("ALTER TABLE attempts ADD COLUMN change_id TEXT")
  const chatColumns = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]
  if (!chatColumns.some((column) => column.name === "details")) db.exec("ALTER TABLE chat_messages ADD COLUMN details TEXT NOT NULL DEFAULT '{}'")
  if (!chatColumns.some((column) => column.name === "session")) db.exec("ALTER TABLE chat_messages ADD COLUMN session INTEGER NOT NULL DEFAULT 1")
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!taskColumns.some((column) => column.name === "issue_number")) db.exec("ALTER TABLE tasks ADD COLUMN issue_number INTEGER")
  if (!taskColumns.some((column) => column.name === "replans")) db.exec("ALTER TABLE tasks ADD COLUMN replans INTEGER NOT NULL DEFAULT 0")
  if (!taskColumns.some((column) => column.name === "human_reason")) db.exec("ALTER TABLE tasks ADD COLUMN human_reason TEXT")

  // Projects created before the rename have a "mockups" phase row.
  db.exec("UPDATE OR IGNORE phases SET name = 'branding' WHERE name = 'mockups'")

  const taskColumnsSql = "id, status, attempts, last_failure AS lastFailure, replans, human_reason AS humanReason"
  const now = () => new Date().toISOString()
  const changeColumnsSql = "id, request, status, branch, base_commit AS baseCommit, pr_url AS prUrl, created_at AS createdAt, finished_at AS finishedAt"
  // phase_history rows are keyed by the change whose build they describe; "" is the first build.
  const lastMergedChangeId = () => (db.prepare("SELECT id FROM changes WHERE status = 'merged' ORDER BY id DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? ""
  const findingColumnsSql = "id, source, severity, title, evidence, proposal, status, change_id AS changeId, created_at AS createdAt, updated_at AS updatedAt"
  const insightRunColumnsSql = "id, agent, started_at AS startedAt, finished_at AS finishedAt, status, summary, findings"
  const routineRunColumnsSql = "id, routine, started_at AS startedAt, finished_at AS finishedAt, status, summary, cost_usd AS costUsd, budget_usd AS budgetUsd, findings, files"
  const routineRun = (row: unknown) => (row ? { ...(row as RoutineRun), files: JSON.parse((row as { files: string }).files) as RoutineFile[] } : null)
  const sprintColumnsSql = "number, status, goal, score, change_id AS changeId, cost_at_start AS costAtStart, cost_usd AS costUsd, note, started_at AS startedAt, finished_at AS finishedAt"
  const metaValue = (key: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null

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
    // Back to pending with the attempt count and last failure kept, so the next attempt builds on the saved diff.
    resumeTask(id: string) {
      db.prepare("UPDATE tasks SET status = 'pending', human_reason = NULL WHERE id = ?").run(id)
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
        "INSERT INTO attempts (subject, role, runner, model, status, failure_class, cost_usd, tokens, duration_ms, transcript_path, created_at, change_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        metaValue(currentChangeKey) || null,
      )
    },
    // Cost of every agent call the run made; codex reports none, so its calls are counted instead.
    // Doctor calls have their own limit (doctor.maxUsdPerIncident) and lead chats are started by a person, so neither uses up the run budget.
    projectCost(): { usd: number; unreportedCalls: number } {
      const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(cost_usd IS NULL), 0) AS unreported FROM attempts WHERE role NOT IN ('doctor', 'lead')").get() as { usd: number; unreported: number }
      return { usd: row.usd, unreportedCalls: row.unreported }
    },
    // Store-backed numbers for one eval brief, so the eval code writes no SQL.
    evalSummary() {
      const tasks = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'merged'), 0) AS merged, COALESCE(SUM(status = 'blocked'), 0) AS blocked, COALESCE(SUM(replans), 0) AS replans, COALESCE(SUM(id LIKE 'Q%'), 0) AS qaFixes FROM tasks").get() as { total: number; merged: number; blocked: number; replans: number; qaFixes: number }
      const attempts = db.prepare("SELECT role, runner, model, COUNT(*) AS count FROM attempts GROUP BY role, runner, model").all() as { role: string; runner: string; model: string; count: number }[]
      const reviews = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(verdict = 'fail'), 0) AS fail FROM reviews").get() as { total: number; fail: number }
      const tokens = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS tokens FROM attempts WHERE role NOT IN ('doctor', 'lead')").get() as { tokens: number }
      const cost = this.projectCost()
      return { tasks, attempts, reviews, tokens: tokens.tokens, costUsd: cost.usd, unreportedCalls: cost.unreportedCalls }
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
      return metaValue(key)
    },
    // Oldest first.
    changes(): Change[] {
      return db.prepare(`SELECT ${changeColumnsSql} FROM changes ORDER BY id`).all() as unknown as Change[]
    },
    change(id: string): Change | null {
      return (db.prepare(`SELECT ${changeColumnsSql} FROM changes WHERE id = ?`).get(id) as unknown as Change | undefined) ?? null
    },
    currentChange(): Change | null {
      const id = metaValue(currentChangeKey)
      return id ? this.change(id) : null
    },
    // Archives the finished phase rows under the change that produced them ("" for the first build),
    // records the new change, and resets the phases it reruns. One transaction, so a crash leaves no half-open change.
    openChange(change: { id: string; request: string; branch: string; baseCommit: string }, resetPhases: string[]) {
      const previous = lastMergedChangeId()
      db.exec("BEGIN")
      try {
        db.prepare("DELETE FROM phase_history WHERE change_id = ?").run(previous)
        db.prepare("INSERT INTO phase_history (change_id, name, status, updated_at) SELECT ?, name, status, updated_at FROM phases").run(previous)
        db.prepare("INSERT INTO changes (id, request, status, branch, base_commit, created_at) VALUES (?, ?, 'open', ?, ?, ?)").run(change.id, change.request, change.branch, change.baseCommit, now())
        for (const phase of resetPhases) this.setPhase(phase, "pending")
        this.setMeta(currentChangeKey, change.id)
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    finishChange(id: string, status: Exclude<ChangeStatus, "open">, prUrl: string | null = null) {
      db.prepare("UPDATE changes SET status = ?, pr_url = COALESCE(?, pr_url), finished_at = ? WHERE id = ?").run(status, prUrl, now(), id)
      if (metaValue(currentChangeKey) === id) this.setMeta(currentChangeKey, "")
    },
    setChangePullRequest(id: string, prUrl: string) {
      db.prepare("UPDATE changes SET pr_url = ? WHERE id = ?").run(prUrl, id)
    },
    // Puts back the phase rows archived when the open change started.
    restorePhases() {
      const archived = db.prepare("SELECT name, status, updated_at AS updatedAt FROM phase_history WHERE change_id = ?").all(lastMergedChangeId()) as { name: string; status: string; updatedAt: string }[]
      for (const row of archived) {
        db.prepare("INSERT INTO phases (name, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").run(row.name, row.status, row.updatedAt)
      }
    },
    deleteMeta(key: string) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key)
    },
    metaWithPrefix(prefix: string): { key: string; value: string }[] {
      return db.prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as { key: string; value: string }[]
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
    // Oldest first.
    eventsAfter(id: number, limit: number): { id: number; at: string; type: string; message: string }[] {
      return db.prepare("SELECT id, at, type, message FROM events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit) as { id: number; at: string; type: string; message: string }[]
    },
    lastEventId(): number {
      const row = db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null }
      return row.id ?? 0
    },
    chatSession(): number {
      return Number(this.meta(chatSessionMetaKey) ?? 1)
    },
    // Reuses the current session when it has no messages yet, so repeated clicks do not pile up empty sessions.
    startChatSession(): number {
      const current = this.chatSession()
      const used = db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE session = ?").get(current) as { count: number }
      if (!used.count) return current
      const latest = db.prepare("SELECT COALESCE(MAX(session), 1) AS session FROM chat_messages").get() as { session: number }
      const next = Math.max(latest.session, current) + 1
      this.setMeta(chatSessionMetaKey, String(next))
      return next
    },
    openChatSession(session: number): boolean {
      const exists = db.prepare("SELECT 1 FROM chat_messages WHERE session = ? LIMIT 1").get(session)
      if (!exists && session !== this.chatSession()) return false
      this.setMeta(chatSessionMetaKey, String(session))
      return true
    },
    // Newest first; the title is the first human message.
    chatSessions(): ChatSession[] {
      return db
        .prepare(
          `SELECT session AS id, MIN(at) AS startedAt, MAX(at) AS updatedAt, COUNT(*) AS messages,
             (SELECT body FROM chat_messages first WHERE first.session = chat_messages.session AND first.author = 'human' ORDER BY first.id LIMIT 1) AS title
           FROM chat_messages GROUP BY session ORDER BY session DESC`,
        )
        .all()
        .map((row) => ({ ...(row as Omit<ChatSession, "title">), title: String((row as { title: string | null }).title ?? "").split("\n")[0].slice(0, 80) }))
    },
    addChatMessage(author: ChatAuthor, body: string, actions: LeadAction[] = [], details: Partial<ChatDetails> = {}): number {
      const result = db
        .prepare("INSERT INTO chat_messages (at, author, body, actions, details, session) VALUES (?, ?, ?, ?, ?, ?)")
        .run(now(), author, body, JSON.stringify(actions), JSON.stringify({ ...emptyChatDetails, ...details }), this.chatSession())
      return Number(result.lastInsertRowid)
    },
    // Oldest first. Reads the current session unless told otherwise.
    chatMessages(limit: number, scope?: number | "all"): ChatMessage[] {
      const session = scope ?? this.chatSession()
      const filter = session === "all" ? "" : "WHERE session = ?"
      const parameters = session === "all" ? [limit] : [session, limit]
      const rows = db.prepare(`SELECT id, at, author, body, actions, details FROM chat_messages ${filter} ORDER BY id DESC LIMIT ?`).all(...parameters) as { id: number; at: string; author: ChatAuthor; body: string; actions: string; details: string }[]
      return rows.reverse().map((row) => ({ ...row, actions: JSON.parse(row.actions) as LeadAction[], details: { ...emptyChatDetails, ...JSON.parse(row.details) } }))
    },
    chatAction(messageId: number, index: number): LeadAction | null {
      const row = db.prepare("SELECT actions FROM chat_messages WHERE id = ? AND author = 'lead'").get(messageId) as { actions: string } | undefined
      return row ? ((JSON.parse(row.actions) as LeadAction[])[index] ?? null) : null
    },
    setChatActionState(messageId: number, index: number, state: LeadActionState): boolean {
      const row = db.prepare("SELECT actions FROM chat_messages WHERE id = ? AND author = 'lead'").get(messageId) as { actions: string } | undefined
      const actions = row ? (JSON.parse(row.actions) as LeadAction[]) : []
      if (!actions[index]) return false
      actions[index].state = state
      db.prepare("UPDATE chat_messages SET actions = ? WHERE id = ?").run(JSON.stringify(actions), messageId)
      return true
    },
    // An open finding with the same fingerprint takes the new evidence instead of a duplicate row.
    addFinding(finding: NewFinding): { id: number; created: boolean } {
      const fingerprint = findingFingerprint(finding.source, finding.title)
      const existing = db.prepare("SELECT id FROM findings WHERE fingerprint = ? AND status = 'open'").get(fingerprint) as { id: number } | undefined
      if (existing) {
        db.prepare("UPDATE findings SET evidence = ?, updated_at = ? WHERE id = ?").run(finding.evidence, now(), existing.id)
        return { id: existing.id, created: false }
      }
      const at = now()
      const result = db
        .prepare("INSERT INTO findings (source, severity, title, evidence, proposal, status, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)")
        .run(finding.source, finding.severity, finding.title, finding.evidence, finding.proposal, fingerprint, at, at)
      return { id: Number(result.lastInsertRowid), created: true }
    },
    // Highest severity first, then newest first.
    listFindings(filter: { status?: FindingStatus; source?: FindingSource } = {}): Finding[] {
      const filters = Object.entries(filter).filter(([, value]) => value !== undefined)
      const where = filters.length ? `WHERE ${filters.map(([column]) => `${column} = ?`).join(" AND ")}` : ""
      const params = filters.map(([, value]) => value as string)
      const order = "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC, id DESC"
      return db.prepare(`SELECT ${findingColumnsSql} FROM findings ${where} ORDER BY ${order}`).all(...params) as unknown as Finding[]
    },
    finding(id: number): Finding | null {
      return (db.prepare(`SELECT ${findingColumnsSql} FROM findings WHERE id = ?`).get(id) as unknown as Finding | undefined) ?? null
    },
    setFindingStatus(id: number, status: FindingStatus, changeId: string | null = null) {
      db.prepare("UPDATE findings SET status = ?, change_id = COALESCE(?, change_id), updated_at = ? WHERE id = ?").run(status, changeId, now(), id)
    },
    openFindingCount(): number {
      return (db.prepare("SELECT COUNT(*) AS count FROM findings WHERE status = 'open'").get() as { count: number }).count
    },
    startSprint(costAtStart: number): Sprint {
      const number = ((db.prepare("SELECT MAX(number) AS last FROM sprints").get() as { last: number | null }).last ?? 0) + 1
      db.prepare("INSERT INTO sprints (number, status, cost_at_start, started_at) VALUES (?, 'planning', ?, ?)").run(number, costAtStart, now())
      return this.sprint(number)!
    },
    updateSprint(number: number, fields: Partial<Pick<Sprint, "status" | "goal" | "score" | "changeId" | "note">>) {
      const columns: Record<string, string> = { status: "status", goal: "goal", score: "score", changeId: "change_id", note: "note" }
      const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
      if (!entries.length) return
      db.prepare(`UPDATE sprints SET ${entries.map(([field]) => `${columns[field]} = ?`).join(", ")} WHERE number = ?`).run(...entries.map(([, value]) => value as string | number | null), number)
    },
    finishSprint(number: number, status: Exclude<SprintStatus, "planning" | "building">, note?: string) {
      const sprint = this.sprint(number)
      if (!sprint) return
      const costUsd = Math.max(0, this.projectCost().usd - sprint.costAtStart)
      db.prepare("UPDATE sprints SET status = ?, cost_usd = ?, note = COALESCE(?, note), finished_at = ? WHERE number = ?").run(status, costUsd, note ?? null, now(), number)
    },
    sprint(number: number): Sprint | null {
      return (db.prepare(`SELECT ${sprintColumnsSql} FROM sprints WHERE number = ?`).get(number) as unknown as Sprint | undefined) ?? null
    },
    // Newest first.
    sprints(limit = 50): Sprint[] {
      return db.prepare(`SELECT ${sprintColumnsSql} FROM sprints ORDER BY number DESC LIMIT ?`).all(limit) as unknown as Sprint[]
    },
    addHealthCheck(check: Omit<HealthCheck, "at">, at = new Date()) {
      db.prepare("INSERT INTO health_checks (at, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?)").run(at.toISOString(), check.ok ? 1 : 0, check.statusCode, check.latencyMs, check.error)
      db.prepare("DELETE FROM health_checks WHERE at < ?").run(new Date(at.getTime() - healthRetentionMs).toISOString())
    },
    // Oldest first.
    healthChecks(since: string): HealthCheck[] {
      const rows = db.prepare("SELECT at, ok, status_code AS statusCode, latency_ms AS latencyMs, error FROM health_checks WHERE at >= ? ORDER BY at").all(since) as unknown as (Omit<HealthCheck, "ok"> & { ok: number })[]
      return rows.map((row) => ({ ...row, ok: row.ok === 1 }))
    },
    // Newest first.
    recentHealthChecks(limit: number, onlyFailed = false): HealthCheck[] {
      const rows = db.prepare(`SELECT at, ok, status_code AS statusCode, latency_ms AS latencyMs, error FROM health_checks ${onlyFailed ? "WHERE ok = 0" : ""} ORDER BY at DESC LIMIT ?`).all(limit) as unknown as (Omit<HealthCheck, "ok"> & { ok: number })[]
      return rows.map((row) => ({ ...row, ok: row.ok === 1 }))
    },
    startInsightRun(agent: InsightAgent): number {
      const result = db.prepare("INSERT INTO insight_runs (agent, started_at, status) VALUES (?, ?, 'running')").run(agent, now())
      return Number(result.lastInsertRowid)
    },
    finishInsightRun(id: number, status: Exclude<InsightRunStatus, "running">, summary: string, findings: number) {
      db.prepare("UPDATE insight_runs SET status = ?, summary = ?, findings = ?, finished_at = ? WHERE id = ?").run(status, summary, findings, now(), id)
    },
    lastInsightRun(agent: InsightAgent): InsightRun | null {
      return (db.prepare(`SELECT ${insightRunColumnsSql} FROM insight_runs WHERE agent = ? ORDER BY id DESC LIMIT 1`).get(agent) as unknown as InsightRun | undefined) ?? null
    },
    lastInsightRuns(): InsightRun[] {
      return db.prepare(`SELECT ${insightRunColumnsSql} FROM insight_runs WHERE id IN (SELECT MAX(id) FROM insight_runs GROUP BY agent) ORDER BY agent`).all() as unknown as InsightRun[]
    },
    startRoutineRun(routine: string, budgetUsd: number): number {
      const result = db.prepare("INSERT INTO routine_runs (routine, started_at, status, budget_usd) VALUES (?, ?, 'running', ?)").run(routine, now(), budgetUsd)
      return Number(result.lastInsertRowid)
    },
    finishRoutineRun(id: number, result: { status: Exclude<InsightRunStatus, "running">; summary: string; costUsd: number | null; findings: number; files: RoutineFile[] }) {
      db.prepare("UPDATE routine_runs SET status = ?, summary = ?, cost_usd = ?, findings = ?, files = ?, finished_at = ? WHERE id = ?").run(
        result.status,
        result.summary,
        result.costUsd,
        result.findings,
        JSON.stringify(result.files),
        now(),
        id,
      )
    },
    lastRoutineRun(routine: string): RoutineRun | null {
      return routineRun(db.prepare(`SELECT ${routineRunColumnsSql} FROM routine_runs WHERE routine = ? ORDER BY id DESC LIMIT 1`).get(routine))
    },
    // What routines spent since the given time: custom runs count their budget when the runner reports no cost,
    // and built-in runs (the insight-<agent> attempts) count the fallback.
    routineSpend(since: string, insightFallbackUsd: number): number {
      const custom = db.prepare("SELECT COALESCE(SUM(COALESCE(cost_usd, budget_usd)), 0) AS usd FROM routine_runs WHERE started_at >= ?").get(since) as { usd: number }
      const builtIn = db.prepare("SELECT COALESCE(SUM(COALESCE(cost_usd, ?)), 0) AS usd FROM attempts WHERE subject LIKE 'insight-%' AND created_at >= ?").get(insightFallbackUsd, since) as { usd: number }
      return custom.usd + builtIn.usd
    },
    // When the app last went live, from the deploy log; routines with the deploy trigger follow it.
    lastDeployAt(): string | null {
      return (db.prepare("SELECT at FROM events WHERE type = 'deploy' AND message LIKE 'live at %' ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined)?.at ?? null
    },
    // Funnel and top-event rows describe only the latest run, so new ones replace the old ones.
    // Rows with the same key and time replace each other, so a daily series can be written again.
    recordMetrics(metrics: Metric[]) {
      db.exec("BEGIN")
      try {
        for (const prefix of snapshotMetricPrefixes) {
          if (metrics.some((metric) => metric.key.startsWith(prefix))) db.prepare("DELETE FROM metrics WHERE substr(key, 1, ?) = ?").run(prefix.length, prefix)
        }
        const remove = db.prepare("DELETE FROM metrics WHERE key = ? AND at = ?")
        const insert = db.prepare("INSERT INTO metrics (at, key, value) VALUES (?, ?, ?)")
        for (const metric of metrics) {
          remove.run(metric.key, metric.at)
          insert.run(metric.at, metric.key, metric.value)
        }
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    // Oldest first.
    metricSeries(key: string, since = ""): Metric[] {
      return db.prepare("SELECT at, key, value FROM metrics WHERE key = ? AND at >= ? ORDER BY at").all(key, since) as unknown as Metric[]
    },
    // Rows under a prefix in the order they were written, prefix removed; for the funnel steps and top events.
    metricsWithPrefix(prefix: string): { name: string; value: number }[] {
      const rows = db.prepare("SELECT key, value FROM metrics WHERE substr(key, 1, ?) = ? ORDER BY rowid").all(prefix.length, prefix) as { key: string; value: number }[]
      return rows.map((row) => ({ name: row.key.slice(prefix.length), value: row.value }))
    },
    // The newest value per key and the one before it.
    latestMetrics(): Record<string, { value: number; previous: number | null; at: string }> {
      const rows = db
        .prepare("SELECT key, value, at, ROW_NUMBER() OVER (PARTITION BY key ORDER BY at DESC, rowid DESC) AS rank FROM metrics")
        .all() as { key: string; value: number; at: string; rank: number }[]
      const latest: Record<string, { value: number; previous: number | null; at: string }> = {}
      for (const row of rows.filter((row) => row.rank <= 2).sort((a, b) => a.rank - b.rank)) {
        if (row.rank === 1) latest[row.key] = { value: row.value, previous: null, at: row.at }
        else if (latest[row.key]) latest[row.key].previous = row.value
      }
      return latest
    },
    log(type: string, message: string) {
      db.prepare("INSERT INTO events (at, type, message) VALUES (?, ?, ?)").run(now(), type, message)
      console.log(`[${type}] ${message}`)
    },
  }
}

export type Store = ReturnType<typeof openStore>
