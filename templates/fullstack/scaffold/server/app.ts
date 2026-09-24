import { existsSync } from "node:fs"
import { resolve } from "node:path"
import fastifyStatic from "@fastify/static"
import Fastify from "fastify"
import { openDatabase, type Database } from "./database.ts"
import { registerRoutes } from "./routes/index.ts"

export function buildApp(database: Database = openDatabase(), clientDir = resolve("dist/client")) {
  const app = Fastify({ logger: process.env.NODE_ENV === "production" })
  app.addHook("onClose", async () => database.close())
  registerRoutes(app, database)
  if (existsSync(clientDir)) {
    app.register(fastifyStatic, { root: clientDir })
    // Client-side routes: any unknown GET outside /api gets the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) return reply.sendFile("index.html")
      return reply.code(404).send({ error: "not found" })
    })
  }
  return app
}
