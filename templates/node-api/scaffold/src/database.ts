import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type Database = DatabaseSync

export function openDatabase(path = process.env.DATABASE_PATH ?? "data/app.db"): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  database.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
  return database
}
