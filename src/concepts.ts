import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

// The concepts phase draws a few logo and style directions in design/concepts/<a|b|c|d>/; the chosen one
// (picked by a person at the gate, or by the design reviewer) is kept in this meta key for the branding phase.
export const conceptsDir = "design/concepts"
export const conceptChoiceKey = "concepts.choice"
const conceptIdPattern = /^[a-d]$/

export function conceptIds(dir: string): string[] {
  const path = join(dir, conceptsDir)
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && conceptIdPattern.test(entry.name)).map((entry) => entry.name).sort()
}
