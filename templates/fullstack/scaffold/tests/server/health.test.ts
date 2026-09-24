import { expect, test } from "vitest"
import { buildApp } from "../../server/app.ts"
import { openDatabase } from "../../server/database.ts"

test("GET /api/health answers ok", async () => {
  const app = buildApp(openDatabase(":memory:"))
  const response = await app.inject({ method: "GET", url: "/api/health" })
  await app.close()
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ status: "ok" })
})
