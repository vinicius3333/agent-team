import type { FastifyInstance } from "fastify"
import type { Database } from "../database.ts"

export function registerRoutes(app: FastifyInstance, database: Database): void {
  app.get("/api/health", async () => {
    database.prepare("SELECT 1").get()
    return { status: "ok" }
  })
}
