import Fastify from "fastify"
import { openDatabase, type Database } from "./database.ts"
import { registerRoutes } from "./routes/index.ts"

export function buildApp(database: Database = openDatabase()) {
  const app = Fastify({ logger: process.env.NODE_ENV === "production" })
  app.addHook("onClose", async () => database.close())
  registerRoutes(app, database)
  return app
}
