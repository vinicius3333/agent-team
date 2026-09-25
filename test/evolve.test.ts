import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { defaultEvolveConfig } from "../src/config.ts"
import { parseEvaluation, runEvolveLoop, type EvaluateResult, type EvolveSteps } from "../src/evolve.ts"
import { openStore } from "../src/store.ts"
import type { Task } from "../src/tasks.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-evolve-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id}/**`], readPaths: [], acceptance: ["works"], verify: "npm test", ...overrides }
}

const existing = [task("T001", { phase: "foundation" })]

function evaluationJson(scores: number[], tasks: Partial<Task>[] = [], gaps = [{ title: "No checkout", detail: "404", severity: "blocker" }]) {
  const names = ["brief_coverage", "functionality", "monetization", "ux_and_branding", "quality_and_reliability"]
  return JSON.stringify({ summary: "ok", dimensions: Object.fromEntries(names.map((name, index) => [name, { score: scores[index], notes: "" }])), gaps, tasks })
}

test("parseEvaluation averages the dimensions and numbers the tasks E<cycle><nn>", () => {
  const evaluation = parseEvaluation(evaluationJson([80, 60, 20, 70, 70], [task("X"), task("Y")]), 2, existing)
  assert.equal(evaluation.score, 60)
  assert.deepEqual(evaluation.tasks.map((entry) => entry.id), ["E201", "E202"])
  assert.equal(evaluation.gaps[0].severity, "blocker")
})

test("parseEvaluation rejects missing scores and major gaps without tasks", () => {
  assert.throws(() => parseEvaluation(JSON.stringify({ dimensions: {}, gaps: [] }), 1, existing), /brief_coverage/)
  assert.throws(() => parseEvaluation(evaluationJson([50, 50, 50, 50, 50]), 1, existing), /need at least one task/)
  const polishOnly = parseEvaluation(evaluationJson([95, 95, 95, 95, 95], [], [{ title: "Spacing", detail: "", severity: "minor" }]), 1, existing)
  assert.equal(polishOnly.tasks.length, 0)
})

function evaluated(score: number, tasks: Task[] = []): EvaluateResult {
  return { kind: "evaluated", evaluation: { cycle: 0, score, dimensions: {} as never, summary: "", gaps: [], tasks } }
}

function stubSteps(results: EvaluateResult[], options: { spent?: number; budget?: number; ship?: "completed" | "paused" } = {}) {
  const calls: string[] = []
  const steps: EvolveSteps = {
    spentUsd: () => options.spent ?? 0,
    runBudgetUsd: () => options.budget ?? 1000,
    evaluate: async (cycle) => {
      calls.push(`evaluate ${cycle}`)
      return results.shift()!
    },
    learn: async () => {
      calls.push("learn")
    },
    addTasks: async (cycle, tasks) => {
      calls.push(`add ${cycle}: ${tasks.map((entry) => entry.id).join(",")}`)
    },
    ship: async () => {
      calls.push("ship")
      return options.ship ?? "completed"
    },
    noteStop: (reason) => calls.push(`stop: ${reason.slice(0, 20)}`),
  }
  return { steps, calls }
}

test("runEvolveLoop builds gap tasks until the target score, learning every cycle", async () => {
  const store = openStore(join(scratch, "target.db"))
  const { steps, calls } = stubSteps([evaluated(60, [task("E101")]), evaluated(92)])
  assert.equal(await runEvolveLoop(store, { ...defaultEvolveConfig, enabled: true }, steps), "completed")
  assert.deepEqual(calls, ["evaluate 1", "learn", "add 1: E101", "ship", "evaluate 2", "learn"])
  assert.equal(store.meta("evolve.score"), "92")
  assert.equal(store.meta("evolve.cycle"), "2")
})

test("runEvolveLoop stops at maxCycles, with nothing to build, and when the budget has no room for a cycle", async () => {
  const capped = openStore(join(scratch, "capped.db"))
  capped.setMeta("evolve.cycle", "3")
  assert.equal(await runEvolveLoop(capped, { ...defaultEvolveConfig, maxCycles: 3 }, stubSteps([]).steps), "completed")

  const empty = openStore(join(scratch, "empty.db"))
  const { steps, calls } = stubSteps([evaluated(50)])
  assert.equal(await runEvolveLoop(empty, defaultEvolveConfig, steps), "completed")
  assert.deepEqual(calls, ["evaluate 1", "learn"])

  const broke = openStore(join(scratch, "broke.db"))
  const tight = stubSteps([evaluated(50, [task("E101")])], { spent: 90, budget: 100 })
  assert.equal(await runEvolveLoop(broke, { ...defaultEvolveConfig, cycleBudgetUsd: 20 }, tight.steps), "awaiting_approval")
  assert.deepEqual(tight.calls, ["stop: evolve cycle 1 needs"])
})

test("runEvolveLoop passes on a paused ship and pauses on infrastructure", async () => {
  const store = openStore(join(scratch, "paused.db"))
  assert.equal(await runEvolveLoop(store, defaultEvolveConfig, stubSteps([evaluated(40, [task("E101")])], { ship: "paused" }).steps), "paused")
  assert.equal(store.meta("evolve.cycle"), "1")
  const infra = openStore(join(scratch, "infra.db"))
  assert.equal(await runEvolveLoop(infra, defaultEvolveConfig, stubSteps([{ kind: "infrastructure", reason: "docker down" }]).steps), "paused")
})
