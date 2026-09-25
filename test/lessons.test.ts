import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { applyCuratorResult, collectSignals, formatLessons, knowledgeLessons, recordRetired, lessonsFor, lessonsPath, loadLessons, parseCuratorResult, projectStacks, saveLessons, type Lesson } from "../src/lessons.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-lessons-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function lesson(id: string, overrides: Partial<Lesson> = {}): Lesson {
  return { id, roles: ["worker"], rule: `rule ${id} for workers`, evidence: [], source: "review", stacks: [], hits: 1, createdAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:00.000Z", ...overrides }
}

test("a new runs folder starts with the seed lessons, next to the projects", () => {
  const path = lessonsPath(join(scratch, "runs", "shop"))
  assert.equal(path, join(scratch, "runs", ".agent-team-lessons", "lessons.json"))
  const seeds = loadLessons(path)
  assert.ok(seeds.length > 5)
  assert.ok(lessonsFor(seeds, "worker", 20).some((entry) => /dev server/.test(entry.rule)))
})

test("standard knowledge joins an existing store, keeps its source, and stays out once retired", () => {
  const knowledge = knowledgeLessons()
  assert.ok(knowledge.length >= 40)
  assert.ok(knowledge.every((entry) => entry.id.startsWith("K-") && entry.sourceUrl?.startsWith("https://")))
  const path = join(scratch, "merge", "lessons.json")
  saveLessons(path, [lesson("L1")])
  assert.equal(loadLessons(path).length, 1 + knowledge.length)
  recordRetired(path, ["K-sec-csrf"])
  const ids = loadLessons(path).map((entry) => entry.id)
  assert.ok(ids.includes("K-sec-xss"))
  assert.ok(!ids.includes("K-sec-csrf"))
  assert.ok(lessonsFor(loadLessons(path), "worker", 50, ["node", "react"]).every((entry) => !entry.stacks.includes("next")))
})

test("lessonsFor ranks by hits, fades old lessons, and keeps each role's own", () => {
  const now = Date.parse("2026-09-25T00:00:00.000Z")
  const lessons = [
    lesson("L1", { hits: 4, lastSeenAt: "2026-06-01T00:00:00.000Z" }),
    lesson("L2", { hits: 2, lastSeenAt: "2026-09-24T00:00:00.000Z" }),
    lesson("L3", { roles: ["qa"], hits: 9 }),
  ]
  assert.deepEqual(lessonsFor(lessons, "worker", 5, [], now).map((entry) => entry.id), ["L2", "L1"])
  assert.deepEqual(lessonsFor(lessons, "worker", 1, [], now).map((entry) => entry.id), ["L2"])
  assert.match(formatLessons(lessonsFor(lessons, "qa", 5, [], now)), /## Lessons from earlier work\n[\s\S]*- rule L3/)
  assert.equal(formatLessons([]), "")
})

test("the curator confirms, adds, and retires lessons", () => {
  const known = [lesson("L1"), lesson("L7")]
  const result = parseCuratorResult(
    'Done.\n```json\n{"updates":[{"id":"L1","roles":["planner"],"rule":"Sharper rule for L1 here","evidence":"T016 outside scope","source":"review"},{"roles":["qa"],"rule":"Check invite links for localhost","evidence":"invite used localhost","source":"qa","stacks":["next"]}],"retire":["L7","L99"]}\n```',
    known,
  )
  assert.deepEqual(result.retire, ["L7"])
  const next = applyCuratorResult(known, result, new Date("2026-09-25T00:00:00.000Z"))
  assert.deepEqual(next.map((entry) => entry.id), ["L1", "L8"])
  assert.equal(next[0].hits, 2)
  assert.deepEqual(next[0].roles, ["worker", "planner"])
  assert.deepEqual(next[0].evidence, ["T016 outside scope"])
  assert.equal(next[1].source, "qa")
  assert.deepEqual(next[1].stacks, ["next"])
  assert.equal(known[0].hits, 1)
})

test("lessons tied to a stack reach only projects with that stack", () => {
  const lessons = [lesson("L1", { stacks: ["next"] }), lesson("L2", { stacks: ["python"] }), lesson("L3")]
  assert.deepEqual(lessonsFor(lessons, "worker", 5, ["node", "next", "react"]).map((entry) => entry.id).sort(), ["L1", "L3"])
  assert.deepEqual(lessonsFor(lessons, "worker", 5, []).map((entry) => entry.id).sort(), ["L1", "L2", "L3"])
  const dir = join(scratch, "stack")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15", "@prisma/client": "6" }, devDependencies: { Vitest: "3" } }))
  writeFileSync(join(dir, "requirements.txt"), "")
  assert.deepEqual(projectStacks(dir).sort(), ["@prisma/client", "next", "node", "python", "vitest"])
})

test("parseCuratorResult rejects unknown ids, roles, and sources", () => {
  assert.throws(() => parseCuratorResult('{"updates":[{"id":"L5","roles":["worker"],"rule":"a long enough rule","source":"review"}]}', []), /not an existing lesson/)
  assert.throws(() => parseCuratorResult('{"updates":[{"roles":["intern"],"rule":"a long enough rule","source":"review"}]}', []), /roles must list/)
  assert.throws(() => parseCuratorResult('{"updates":[{"roles":["worker"],"rule":"a long enough rule","source":"seed"}]}', []), /source/)
  assert.throws(() => parseCuratorResult('{"updates":[{"roles":["worker"],"rule":"a long enough rule","source":"qa","stacks":["Next JS"]}]}', []), /stacks/)
})

test("saveLessons round-trips, and collectSignals reads only files newer than the last curation", () => {
  const path = join(scratch, "store", "lessons.json")
  saveLessons(path, [lesson("L1")])
  assert.deepEqual(loadLessons(path).filter((entry) => !entry.id.startsWith("K-")).map((entry) => entry.id), ["L1"])

  const project = join(scratch, "project")
  const base = join(project, ".agent-team")
  mkdirSync(join(base, "attempts"), { recursive: true })
  mkdirSync(join(base, "qa", "round-1"), { recursive: true })
  mkdirSync(join(base, "incidents"), { recursive: true })
  writeFileSync(join(base, "attempts", "T004-1.diff"), "# Attempt 1 of T004 was rejected.\n# Reason:\n# edited files that only the orchestrator writes: AGENTS.md\n\ndiff --git a b\n")
  writeFileSync(join(base, "attempts", "T001-1.diff"), "# Attempt 1 of T001 was rejected.\n# Reason:\n# old\n\n")
  const old = new Date("2026-01-01T00:00:00.000Z")
  utimesSync(join(base, "attempts", "T001-1.diff"), old, old)
  writeFileSync(join(base, "qa", "round-1", "verdict.json"), JSON.stringify({ verdict: "pass", findings: [{ title: "No hero", detail: "landing", severity: "minor" }] }))
  writeFileSync(join(base, "incidents", "x.json"), JSON.stringify({ cause: "agent_team_bug", reason: "qa stopped", diagnosis: "app capped at 512m" }))
  const signals = collectSignals(project, Date.parse("2026-06-01T00:00:00.000Z"))
  assert.deepEqual(signals.map((signal) => signal.source).sort(), ["incident", "qa", "review"])
  assert.match(signals.find((signal) => signal.source === "review")!.text, /AGENTS\.md/)
  assert.match(signals.find((signal) => signal.source === "qa")!.text, /\[minor\] No hero/)
})
