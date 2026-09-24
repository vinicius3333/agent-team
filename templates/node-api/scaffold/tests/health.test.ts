import assert from "node:assert/strict"
import { test } from "node:test"
import { buildApp } from "../src/app.ts"
import { openDatabase } from "../src/database.ts"

test("GET /api/health answers ok", async (t) => {
  const app = buildApp(openDatabase(":memory:"))
  t.after(() => app.close())
  const response = await app.inject({ method: "GET", url: "/api/health" })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: "ok" })
})
