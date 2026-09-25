import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { commitAll } from "../src/git.ts"
import { approveTaskSuggestion, dropTask } from "../src/lead-actions.ts"
import { createProject, withProjectStore } from "../src/project.ts"
import { suggestedPaths } from "../src/replan.ts"
import type { Task } from "../src/tasks.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-decision-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id}/**`], readPaths: [], acceptance: ["works"], verify: "npm test", ...overrides }
}

function project(name: string, tasks: Task[]): string {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  writeFileSync(join(projectDir, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`)
  commitAll(projectDir, "plan")
  return projectDir
}

const readTasksFile = (projectDir: string) => JSON.parse(readFileSync(join(projectDir, "tasks.json"), "utf8")) as Task[]

test("suggestedPaths reads formatBlock output and a quoted BLOCKED JSON line", () => {
  assert.deepEqual(suggestedPaths("E202 was already replanned. BLOCKED: scope (needs src/a.ts, src/app/[id]/b.test.ts): needs them"), ["src/a.ts", "src/app/[id]/b.test.ts"])
  assert.deepEqual(suggestedPaths('E202 was replanned.\nBLOCKED: spec: {"kind":"scope","needPaths":["src/app/api/groups/\\\\[groupId\\\\]/route.test.ts"],"reason":"breaks"}'), ["src/app/api/groups/[groupId]/route.test.ts"])
  const withCommitPlan = 'BLOCKED: spec: {"kind":"scope","needPaths":["src/app/[id]/route.test.ts","src/b.ts"],"reason":"x\n```json\n{\\"commits\\":[{\\"files\\":[\\"src/x.ts\\"]}]}\n```"}'
  assert.deepEqual(suggestedPaths(withCommitPlan), ["src/app/[id]/route.test.ts", "src/b.ts"], "a commit plan inside the reason does not hide needPaths")
  assert.deepEqual(suggestedPaths("The worker ran out of budget."), [])
})

test("approving a suggestion widens the scope, waits for the task that owns a file, and resets the task", () => {
  const projectDir = project("approve", [task("E103", { allowedPaths: ["src/draw/**"] }), task("E102")])
  withProjectStore(projectDir, (store) => {
    store.syncTasks(["E103", "E102"])
    store.requireHuman("E102", "BLOCKED: scope (needs src/draw/section.tsx): the panel lives in the draw section")
    assert.deepEqual(approveTaskSuggestion(projectDir, store, "E102"), ["src/draw/section.tsx"])
    assert.equal(store.task("E102").status, "pending")
    assert.throws(() => approveTaskSuggestion(projectDir, store, "E102"), /not waiting for a decision/)
  })
  const e102 = readTasksFile(projectDir).find((entry) => entry.id === "E102")!
  assert.deepEqual(e102.allowedPaths, ["src/E102/**", "src/draw/section.tsx"])
  assert.deepEqual(e102.dependsOn, ["E103"])
})

test("rejecting drops the task, unless another task depends on it", () => {
  const projectDir = project("drop", [task("E201"), task("E202"), task("E203", { dependsOn: ["E201"] })])
  withProjectStore(projectDir, (store) => {
    store.syncTasks(["E201", "E202", "E203"])
    store.requireHuman("E202", "needs a decision")
    dropTask(projectDir, store, "E202")
    assert.throws(() => dropTask(projectDir, store, "E201"), /E203 depends on E201/)
  })
  assert.deepEqual(readTasksFile(projectDir).map((entry) => entry.id), ["E201", "E203"])
})
