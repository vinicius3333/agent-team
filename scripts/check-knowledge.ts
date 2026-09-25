// Checks that every source URL in knowledge/seed-lessons.json still answers, and with --write stamps checkedAt
// on the lessons whose source answered. Run it monthly: a dead or moved source means the lesson needs a human look.
// Usage: node scripts/check-knowledge.ts [--write]
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { knowledgePath, type KnowledgeLesson } from "../src/lessons.ts"

const write = process.argv.includes("--write")
const lessons = JSON.parse(readFileSync(knowledgePath, "utf8")) as KnowledgeLesson[]
const sources = [...new Set(lessons.map((lesson) => lesson.source.split("#")[0]))]
const status = new Map<string, string>()
await Promise.all(
  sources.map(async (url) => {
    try {
      const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "agent-team knowledge check" }, signal: AbortSignal.timeout(20_000) })
      status.set(url, response.ok ? "ok" : `HTTP ${response.status}`)
    } catch (error) {
      status.set(url, curlStatus(url) ?? (error as Error).message)
    }
  }),
)
// Node's fetch rejects servers with an incomplete certificate chain (planalto.gov.br) that curl accepts.
function curlStatus(url: string): string | null {
  try {
    const code = execFileSync("curl", ["-sS", "-L", "-A", "Mozilla/5.0", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "30", url], { encoding: "utf8" }).trim()
    return code.startsWith("2") ? "ok" : `HTTP ${code}`
  } catch {
    return null
  }
}

const today = new Date().toISOString().slice(0, 10)
let failed = 0
for (const url of sources) {
  const result = status.get(url)!
  if (result !== "ok") failed += 1
  console.log(`${result === "ok" ? "ok  " : "FAIL"} ${url}${result === "ok" ? "" : ` (${result})`}`)
}
if (write) {
  for (const lesson of lessons) if (status.get(lesson.source.split("#")[0]) === "ok") lesson.checkedAt = today
  writeFileSync(knowledgePath, `${JSON.stringify(lessons, null, 2)}\n`)
}
console.log(`${sources.length - failed}/${sources.length} sources answered`)
process.exit(failed ? 1 : 0)
