import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { roles, type Role } from "./config.ts"
import { extractJsonObject } from "./json.ts"

// Lessons are rules the harness learned from earlier work: reviewer rejections, QA findings, evaluation gaps,
// and incidents. They live next to the projects (one file per runs folder), so every new project and every
// later task starts with what the earlier ones taught. The curator agent distills raw signals into lessons;
// the orchestrator injects the strongest lessons for a role into that role's system prompt.

export const lessonSources = ["seed", "review", "qa", "evaluation", "incident"] as const
export type LessonSource = (typeof lessonSources)[number]

export interface Lesson {
  id: string
  roles: Role[]
  rule: string
  // Short quotes of what went wrong, newest last; at most maxEvidence.
  evidence: string[]
  source: LessonSource
  // Stack tags the lesson is limited to (npm package names such as "next", or "python", "go"); empty means every stack.
  stacks: string[]
  // Where a standard lesson comes from (knowledge/seed-lessons.json); absent on learned lessons.
  sourceUrl?: string
  // How many times the curator saw this problem again. A lesson that keeps coming back weighs more.
  hits: number
  // How many times the curator found the lesson wrong or unhelpful; missing means 0. Each miss cancels a hit.
  misses?: number
  createdAt: string
  lastSeenAt: string
}

export interface LessonUpdate {
  // Present when the curator confirms an existing lesson; absent for a new one.
  id?: string
  roles: Role[]
  rule: string
  evidence: string
  source: LessonSource
  stacks: string[]
}

export interface LessonMerge {
  // The lesson that stays and takes the others' hits, misses, and evidence.
  into: string
  // Duplicates that are removed and remembered as retired.
  from: string[]
}

export interface CuratorResult {
  updates: LessonUpdate[]
  retire: string[]
  // Existing lessons the signals showed to be wrong or unhelpful; each gets one more miss.
  weaken?: string[]
  merge?: LessonMerge[]
}

export interface Signal {
  source: Exclude<LessonSource, "seed">
  subject: string
  text: string
}

const maxEvidence = 5
const maxEvidenceLength = 300
const maxSignalLength = 1500
// A lesson loses half its weight for every halfLifeDays it is not seen again, so stale rules fade out.
const halfLifeDays = 30
// npm names may carry a scope (@prisma/client); language tags are plain words.
export const stackTagPattern = /^[a-z0-9@][a-z0-9@/._-]{0,100}$/
export const lessonsEnv = "AGENT_TEAM_LESSONS"
// Standard lessons paraphrased from public sources (OWASP, WCAG, web.dev, 12-Factor, framework docs, Stripe, LGPD),
// each with its source URL. scripts/check-knowledge.ts checks that the sources still answer.
export const knowledgePath = new URL("../knowledge/seed-lessons.json", import.meta.url)

export interface KnowledgeLesson {
  id: string
  roles: Role[]
  stacks: string[]
  rule: string
  source: string
  sourceTitle: string
  license: string
  checkedAt: string | null
}

export function lessonsPath(projectDir: string): string {
  return process.env[lessonsEnv] || join(dirname(projectDir), ".agent-team-lessons", "lessons.json")
}

// A standard lesson added to the knowledge file after a store was created joins that store on the next load.
// Retired ids are remembered, so a standard lesson the curator retired does not come back.
export function loadLessons(path: string): Lesson[] {
  let stored: Lesson[] = []
  let retired: string[] = []
  try {
    const parsed = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
    if (Array.isArray(parsed)) stored = parsed
    retired = readJson(retiredPath(path)) ?? []
  } catch {}
  const known = new Set([...stored.map((lesson) => lesson.id), ...retired])
  const base = stored.length ? stored : seedLessons()
  return [...base, ...knowledgeLessons().filter((lesson) => !known.has(lesson.id))]
}

function retiredPath(path: string): string {
  return join(dirname(path), "retired.json")
}

export function recordRetired(path: string, ids: string[]): void {
  if (!ids.length) return
  const retired = new Set<string>(readJson(retiredPath(path)) ?? [])
  for (const id of ids) retired.add(id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(retiredPath(path), `${JSON.stringify([...retired].sort(), null, 2)}\n`)
}

export function knowledgeLessons(): Lesson[] {
  const entries = (readJson(knowledgePath.pathname) ?? []) as KnowledgeLesson[]
  const at = "2026-09-25T00:00:00.000Z"
  // hits 1: learned lessons (hits 2 and up) outrank general standards when a role has more than it can take.
  return entries.map((entry) => ({ id: entry.id, roles: entry.roles, rule: entry.rule, evidence: [], source: "seed", stacks: entry.stacks, sourceUrl: entry.source, hits: 1, createdAt: at, lastSeenAt: entry.checkedAt ? `${entry.checkedAt}T00:00:00.000Z` : at }))
}

// Written through a temporary file, so two projects curating at once never leave a half-written file.
export function saveLessons(path: string, lessons: Lesson[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(lessons, null, 2)}\n`)
  renameSync(temporary, path)
}

export function lessonWeight(lesson: Lesson, now = Date.now()): number {
  const ageDays = Math.max(0, (now - Date.parse(lesson.lastSeenAt)) / 86_400_000)
  return Math.max(0, lesson.hits - (lesson.misses ?? 0)) * 0.5 ** (ageDays / halfLifeDays)
}

// stacks are the project's tags (projectStacks); a lesson tied to other stacks is left out. With no project tags yet
// (before the scaffold), every lesson applies. With a query (the task prompt), lessons are ordered by reciprocal rank
// fusion of their keyword relevance to the query and their weight; lessons that match no query word keep only their
// weight rank. Without a query, or when nothing matches, the order is by weight alone.
export function lessonsFor(lessons: Lesson[], role: Role, limit: number, stacks: string[] = [], now = Date.now(), query = ""): Lesson[] {
  const byWeight = lessons
    .filter((lesson) => lesson.roles.includes(role))
    .filter((lesson) => !lesson.stacks?.length || !stacks.length || lesson.stacks.some((tag) => stacks.includes(tag)))
    .sort((left, right) => lessonWeight(right, now) - lessonWeight(left, now))
  return rankByRelevance(byWeight, query).slice(0, limit)
}

// Reciprocal rank fusion constant: the usual 60 keeps one list's top rank from drowning the other list.
const fusionK = 60
const bm25K1 = 1.2
const bm25B = 0.75
const stopWords = new Set("the and for are but not you your all any can has have had was were will with this that these those from into onto than then them they their there when what which while who how its our out own too very just also only each every other some such more most less one two before after about above below over under again once here where why use used using does did done make made must should would could may might both few same off per via yes nor him her his she".split(" "))

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word))
}

// BM25 of each lesson's rule and evidence against the query, with the candidates as the corpus. One score per lesson.
export function relevanceScores(lessons: Lesson[], query: string): number[] {
  const terms = [...new Set(tokenize(query))]
  if (!terms.length || !lessons.length) return lessons.map(() => 0)
  const documents = lessons.map((lesson) => tokenize([lesson.rule, ...(lesson.evidence ?? [])].join(" ")))
  const averageLength = documents.reduce((sum, words) => sum + words.length, 0) / documents.length || 1
  const counts = documents.map((words) => {
    const count = new Map<string, number>()
    for (const word of words) count.set(word, (count.get(word) ?? 0) + 1)
    return count
  })
  const idf = new Map(terms.map((term) => {
    const df = counts.filter((count) => count.has(term)).length
    return [term, Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))]
  }))
  return counts.map((count, index) => {
    const lengthNorm = bm25K1 * (1 - bm25B + (bm25B * documents[index].length) / averageLength)
    return terms.reduce((score, term) => {
      const frequency = count.get(term) ?? 0
      return frequency ? score + (idf.get(term) ?? 0) * ((frequency * (bm25K1 + 1)) / (frequency + lengthNorm)) : score
    }, 0)
  })
}

// byWeight is already ordered by weight; ties in the fused score keep that order.
function rankByRelevance(byWeight: Lesson[], query: string): Lesson[] {
  if (!query.trim()) return byWeight
  const scores = relevanceScores(byWeight, query)
  const matching = byWeight.map((_, index) => index).filter((index) => scores[index] > 0)
  if (!matching.length) return byWeight
  const relevanceRank = new Map(matching.sort((left, right) => scores[right] - scores[left] || left - right).map((index, rank) => [index, rank + 1]))
  const fused = byWeight.map((_, index) => {
    const relevance = relevanceRank.get(index)
    return 1 / (fusionK + index + 1) + (relevance ? 1 / (fusionK + relevance) : 0)
  })
  return byWeight.map((_, index) => index).sort((left, right) => fused[right] - fused[left] || left - right).map((index) => byWeight[index])
}

export function formatLessons(lessons: Lesson[]): string {
  if (!lessons.length) return ""
  return [
    "## Lessons from earlier work",
    "",
    "The team learned these rules from earlier tasks and projects. Follow them unless the task prompt says otherwise.",
    "",
    ...lessons.map((lesson) => `- ${lesson.rule}`),
  ].join("\n")
}

export function applyCuratorResult(lessons: Lesson[], result: CuratorResult, now = new Date()): Lesson[] {
  const at = now.toISOString()
  const retired = new Set(result.retire)
  // Counted before retiring, so a retired id is never reused for a different rule.
  let counter = lessons.reduce((max, lesson) => Math.max(max, Number(/^L(\d+)$/.exec(lesson.id)?.[1] ?? 0)), 0)
  let next = lessons.filter((lesson) => !retired.has(lesson.id)).map((lesson) => ({ ...lesson, evidence: [...lesson.evidence] }))
  // A merged-away id points to the lesson it went into, so an update or weaken on it lands there.
  const mergedInto = new Map<string, string>()
  for (const merge of result.merge ?? []) {
    const into = next.find((lesson) => lesson.id === merge.into)
    if (!into) continue
    for (const id of merge.from) {
      const from = next.find((lesson) => lesson.id === id)
      if (!from || from === into) continue
      into.hits += from.hits
      const misses = (into.misses ?? 0) + (from.misses ?? 0)
      if (misses) into.misses = misses
      into.evidence = [...into.evidence, ...from.evidence].slice(-maxEvidence)
      into.roles = [...new Set([...into.roles, ...from.roles])]
      // An empty stack list means every stack, so the union stays empty when either side is empty.
      into.stacks = into.stacks.length && from.stacks.length ? [...new Set([...into.stacks, ...from.stacks])] : []
      if (Date.parse(from.lastSeenAt) > Date.parse(into.lastSeenAt)) into.lastSeenAt = from.lastSeenAt
      mergedInto.set(id, into.id)
      next = next.filter((lesson) => lesson !== from)
    }
  }
  const resolve = (id: string) => mergedInto.get(id) ?? id
  for (const id of result.weaken ?? []) {
    const lesson = next.find((entry) => entry.id === resolve(id))
    if (lesson) lesson.misses = (lesson.misses ?? 0) + 1
  }
  for (const update of result.updates) {
    const evidence = update.evidence.trim().slice(0, maxEvidenceLength)
    const existing = update.id ? next.find((lesson) => lesson.id === resolve(update.id!)) : undefined
    if (existing) {
      existing.hits += 1
      existing.lastSeenAt = at
      existing.rule = update.rule.trim() || existing.rule
      existing.roles = [...new Set([...existing.roles, ...update.roles])]
      existing.stacks = update.stacks
      if (evidence) existing.evidence = [...existing.evidence, evidence].slice(-maxEvidence)
      continue
    }
    counter += 1
    next.push({ id: `L${counter}`, roles: [...new Set(update.roles)], rule: update.rule.trim(), evidence: evidence ? [evidence] : [], source: update.source, stacks: update.stacks, hits: 1, createdAt: at, lastSeenAt: at })
  }
  return next
}

export function parseCuratorResult(text: string, known: Lesson[]): CuratorResult {
  const parsed = extractJsonObject(text) as any
  if (!Array.isArray(parsed?.updates)) throw new Error("updates must be an array")
  const knownIds = new Set(known.map((lesson) => lesson.id))
  const errors: string[] = []
  const updates: LessonUpdate[] = parsed.updates.map((update: any, index: number) => {
    const updateRoles = Array.isArray(update?.roles) ? update.roles : []
    if (typeof update?.rule !== "string" || update.rule.trim().length < 10) errors.push(`updates[${index}].rule must be a sentence`)
    if (!updateRoles.length || updateRoles.some((role: unknown) => !(roles as readonly unknown[]).includes(role))) errors.push(`updates[${index}].roles must list roles from: ${roles.join(", ")}`)
    if (update?.id !== undefined && !knownIds.has(update.id)) errors.push(`updates[${index}].id ${update.id} is not an existing lesson; leave id out for a new lesson`)
    if (!(lessonSources as readonly unknown[]).includes(update?.source) || update.source === "seed") errors.push(`updates[${index}].source must be review, qa, evaluation, or incident`)
    const stacks = update?.stacks ?? []
    if (!Array.isArray(stacks) || !stacks.every((tag: unknown) => typeof tag === "string" && stackTagPattern.test(tag))) errors.push(`updates[${index}].stacks must be a list of lowercase stack tags`)
    return { id: update?.id, roles: updateRoles, rule: String(update?.rule ?? ""), evidence: String(update?.evidence ?? ""), source: update?.source, stacks: Array.isArray(stacks) ? stacks : [] }
  })
  const retire = Array.isArray(parsed.retire) ? parsed.retire.filter((id: unknown): id is string => typeof id === "string" && knownIds.has(id)) : []
  const weaken: string[] = []
  if (parsed.weaken !== undefined) {
    if (!Array.isArray(parsed.weaken)) errors.push("weaken must be a list of existing lesson ids")
    else
      parsed.weaken.forEach((id: unknown, index: number) => {
        if (typeof id === "string" && knownIds.has(id)) weaken.push(id)
        else errors.push(`weaken[${index}] ${String(id)} is not an existing lesson`)
      })
  }
  const merge: LessonMerge[] = []
  if (parsed.merge !== undefined) {
    if (!Array.isArray(parsed.merge)) errors.push("merge must be a list of { into, from } objects")
    else {
      const used = new Set<string>()
      parsed.merge.forEach((entry: any, index: number) => {
        const into = entry?.into
        const from: unknown[] = Array.isArray(entry?.from) ? entry.from : []
        if (typeof into !== "string" || !knownIds.has(into)) errors.push(`merge[${index}].into ${String(into)} is not an existing lesson`)
        if (!from.length) errors.push(`merge[${index}].from must list at least one existing lesson id`)
        from.forEach((id, fromIndex) => {
          if (typeof id !== "string" || !knownIds.has(id)) errors.push(`merge[${index}].from[${fromIndex}] ${String(id)} is not an existing lesson`)
          else if (id === into) errors.push(`merge[${index}].from[${fromIndex}] ${id} cannot merge into itself`)
        })
        for (const id of [into, ...from]) {
          if (typeof id !== "string" || !knownIds.has(id)) continue
          if (used.has(id)) errors.push(`merge[${index}] uses ${id}, which another merge already uses`)
          if (retire.includes(id)) errors.push(`merge[${index}] uses ${id}, which is also retired`)
          used.add(id)
        }
        merge.push({ into: String(into), from: from.map(String) })
      })
    }
  }
  if (errors.length) throw new Error(`invalid curator result:\n- ${errors.join("\n- ")}`)
  return { updates, retire, weaken, merge }
}

// Ids that leave the store for good: retired lessons plus the duplicates merged into another lesson.
export function removedIds(result: CuratorResult): string[] {
  return [...result.retire, ...(result.merge ?? []).flatMap((merge) => merge.from)]
}

// Raw signals a run wrote since `sinceMs`: rejected attempts, QA verdicts, evaluations, and incidents.
export function collectSignals(projectDir: string, sinceMs: number): Signal[] {
  const base = join(projectDir, ".agent-team")
  const signals: Signal[] = []
  for (const file of changedFiles(join(base, "attempts"), sinceMs, /\.diff$/)) {
    const header = readFileSync(file, "utf8").split("\n").filter((line) => line.startsWith("#")).map((line) => line.replace(/^# ?/, ""))
    const reasonStart = header.indexOf("Reason:")
    const reason = reasonStart === -1 ? "" : header.slice(reasonStart + 1).join("\n").trim()
    if (reason) signals.push({ source: "review", subject: relative(base, file), text: reason.slice(0, maxSignalLength) })
  }
  for (const file of changedFiles(join(base, "qa"), sinceMs, /verdict\.json$/)) {
    const verdict = readJson(file)
    const findings = Array.isArray(verdict?.findings) ? verdict.findings : []
    if (!findings.length) continue
    const text = findings.map((finding: any) => `${finding.severity ? `[${finding.severity}] ` : ""}${finding.title}: ${finding.detail}`).join("\n")
    signals.push({ source: "qa", subject: relative(base, file), text: `verdict ${verdict.verdict}\n${text}`.slice(0, maxSignalLength) })
  }
  for (const file of changedFiles(join(base, "evaluations"), sinceMs, /\.json$/)) {
    const evaluation = readJson(file)
    const gaps = Array.isArray(evaluation?.gaps) ? evaluation.gaps : []
    if (!gaps.length) continue
    const text = gaps.map((gap: any) => `[${gap.severity}] ${gap.title}: ${gap.detail}`).join("\n")
    signals.push({ source: "evaluation", subject: relative(base, file), text: `score ${evaluation.score}\n${text}`.slice(0, maxSignalLength) })
  }
  for (const file of changedFiles(join(base, "incidents"), sinceMs, /\.json$/)) {
    const incident = readJson(file)
    if (!incident?.diagnosis) continue
    signals.push({ source: "incident", subject: relative(base, file), text: `${incident.cause ?? "unknown"}: ${incident.reason}\nDiagnosis: ${incident.diagnosis}`.slice(0, maxSignalLength) })
  }
  return signals
}

function changedFiles(dir: string, sinceMs: number, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...changedFiles(path, sinceMs, pattern))
    else if (pattern.test(entry.name) && statSync(path).mtimeMs > sinceMs) found.push(path)
  }
  return found.sort()
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// Tags that describe a project's stack: its npm dependencies, plus a language tag for non-Node projects.
export function projectStacks(dir: string): string[] {
  const tags = new Set<string>()
  const manifest = readJson(join(dir, "package.json"))
  if (manifest) {
    tags.add("node")
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) tags.add(name.toLowerCase())
  }
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "requirements.txt"))) tags.add("python")
  if (existsSync(join(dir, "go.mod"))) tags.add("go")
  if (existsSync(join(dir, "Cargo.toml"))) tags.add("rust")
  return [...tags].filter((tag) => stackTagPattern.test(tag))
}

export function curatorPrompt(input: { project: string; lessons: Lesson[]; signals: Signal[]; stacks?: string[] }): string {
  return [
    `Project: ${input.project}. Stack tags: ${input.stacks?.length ? input.stacks.join(", ") : "none yet"}.`,
    "",
    "## Current lessons",
    "",
    input.lessons.length ? input.lessons.map((lesson) => `- ${lesson.id} (${lesson.roles.join(", ")}; ${lesson.stacks?.length ? `stacks ${lesson.stacks.join(", ")}` : "any stack"}; seen ${lesson.hits}x${lesson.misses ? `, missed ${lesson.misses}x` : ""}): ${lesson.rule}`).join("\n") : "none",
    "",
    "## New signals",
    "",
    ...input.signals.map((signal) => [`### ${signal.source}: ${signal.subject}`, "", "```", signal.text, "```", ""].join("\n")),
  ].join("\n")
}

// Lessons from the first long project (a secret-santa web app), so a new runs folder starts with them.
function seedLessons(): Lesson[] {
  const at = "2026-09-25T00:00:00.000Z"
  const seeds: [Role[], string, string[]?][] = [
    [["worker"], "Never start a dev server (next dev, vite, npm run dev) in the worktree. Dev servers rewrite AGENTS.md and other orchestrator files, and the task is rejected. Check your work with the verify command, the tests, and the production build.", ["node"]],
    [["worker"], "If the task needs a file outside allowedPaths, stop and answer with a BLOCKED: line as the first line of your final message. Do not edit the file anyway."],
    [["planner"], "Every API route, page, or module a task title names must be in that task's allowedPaths, together with its test file. Missing route files forced four replans in one project."],
    [["planner"], "Give the task that owns the app shell (layout, header, navigation) every nav link and tap target; later tasks that add a screen must not need to edit the shell."],
    [["architect"], "Derive the session cookie Secure flag from the public APP_URL (https means Secure). A Secure cookie on the plain-http preview breaks the demo login."],
    [["architect"], "Read the public base URL from APP_URL for every absolute link (invites, emails, payment returns). Never fall back to localhost in a link a user can copy."],
    [["architect"], "Prefer libraries without native builds (for example the built-in node:sqlite or a pure-JS driver over better-sqlite3), so npm ci works in slim containers and on arm64.", ["node"]],
    [["architect", "planner"], "When the brief asks to make money, plan a payment flow that works end to end in the preview: a fake provider with a working checkout page and a success return, plus the real provider behind an env key."],
    [["qa"], "A missing hero illustration, logo, or header navigation on the landing page is at least a major finding, never a minor note."],
    [["qa"], "Before blaming the app for a crash or out-of-memory error in the test or build gate, check whether the container limits in the task prompt explain it; say so in the finding instead of writing a workaround task."],
    [["qa", "evaluator"], "Check every link the app generates for others (invites, shares, payments). A link to localhost or 127.0.0.1 is a blocker."],
    [["designer"], "Keep docs/design.md consistent: each screen names one branding image and the same illustration tokens as design/tokens.css."],
    [["evaluator", "pm"], "When the user approves new scope in the chat, it must end up as tasks. Check that every approved request is built."],
  ]
  return seeds.map(([seedRoles, rule, stacks = []], index) => ({ id: `L${index + 1}`, roles: seedRoles, rule, evidence: [], source: "seed", stacks, hits: 2, createdAt: at, lastSeenAt: at }))
}
