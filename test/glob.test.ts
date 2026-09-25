import assert from "node:assert/strict"
import { test } from "node:test"
import { matchesPath } from "../src/glob.ts"
import { toClaudeTools } from "../src/runners/claude.ts"
import { filesOutsideScope } from "../src/tasks.ts"

test("scope checks read Next.js bracket folders literally, escaped or not", () => {
  const file = "src/app/api/groups/[groupId]/exclusions/route.ts"
  assert.ok(matchesPath(file, "src/app/api/groups/[groupId]/exclusions/**"))
  assert.ok(matchesPath(file, "src/app/api/groups/\\[groupId\\]/exclusions/**"))
  assert.ok(matchesPath(file, "src/app/api/groups/*/exclusions/**"))
  assert.ok(!matchesPath("src/app/api/groups/g/route.ts", "src/app/api/groups/[groupId]/**"), "[groupId] is not a character class")
  assert.deepEqual(filesOutsideScope([file, "src/other.ts"], ["src/app/api/groups/[groupId]/**"]), ["src/other.ts"])
})

test("Claude edit rules escape brackets once", () => {
  assert.deepEqual(toClaudeTools(["edit"], ["src/app/[id]/**", "src/app/\\[id\\]/x/**"]), ["Edit(./src/app/\\[id\\]/**)", "Edit(./src/app/\\[id\\]/x/**)"])
})
