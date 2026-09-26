import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { parseDocument } from "yaml"
import { loadConfig } from "../src/config.ts"
import { parseLeadSettings, saveLeadSettings } from "../src/lead-actions.ts"
import { ProjectError } from "../src/project.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-lead-actions-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const examplePipeline = readFileSync(join(import.meta.dirname, "..", "pipeline.example.yaml"), "utf8")
const baseBody = { actions: ["retry", "resume"], autoApply: ["retry"], chatBudgetUsd: 3 }

let count = 0
// A temp project whose pipeline.yaml has lead: { access: full, note: keep }, in a repo with its own git identity.
function project(): string {
  const dir = join(scratch, `project-${++count}`)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["init", "-q", dir])
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.com")
  const document = parseDocument(examplePipeline)
  document.set("lead", { access: "full", note: "keep" })
  writeFileSync(join(dir, "pipeline.yaml"), document.toString().replace("note: keep", "note: keep # operator note"))
  git("add", "pipeline.yaml")
  git("commit", "-q", "-m", "chore: start")
  return dir
}

function leadNode(dir: string): Record<string, unknown> {
  return parseDocument(readFileSync(join(dir, "pipeline.yaml"), "utf8")).toJS().lead
}

test("parseLeadSettings reads access read or full", () => {
  assert.equal(parseLeadSettings({ ...baseBody, access: "full" }).access, "full")
  assert.equal(parseLeadSettings({ ...baseBody, access: "read" }).access, "read")
})

test("parseLeadSettings leaves access out when the body has none", () => {
  assert.equal("access" in parseLeadSettings(baseBody), false)
})

test("parseLeadSettings rejects access admin with a 400", () => {
  assert.throws(
    () => parseLeadSettings({ ...baseBody, access: "admin" }),
    (error: unknown) => error instanceof ProjectError && error.status === 400 && error.message === "access must be read or full.",
  )
})

test("saving with access full keeps access full and other lead keys", () => {
  const dir = project()
  saveLeadSettings(dir, parseLeadSettings({ ...baseBody, access: "full" }))
  const lead = leadNode(dir)
  assert.equal(lead.access, "full")
  assert.equal(lead.note, "keep")
  assert.deepEqual(lead.actions, ["retry", "resume"])
  assert.deepEqual(lead.autoApply, ["retry"])
  assert.equal(lead.chatBudgetUsd, 3)
  assert.match(readFileSync(join(dir, "pipeline.yaml"), "utf8"), /note: keep # operator note/)
  assert.equal(loadConfig(join(dir, "pipeline.yaml")).lead.access, "full")
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })
  assert.equal(status.trim(), "")
})

test("saving with access read writes access read", () => {
  const dir = project()
  saveLeadSettings(dir, parseLeadSettings({ ...baseBody, access: "read" }))
  const lead = leadNode(dir)
  assert.equal(lead.access, "read")
  assert.equal(lead.note, "keep")
  assert.equal(loadConfig(join(dir, "pipeline.yaml")).lead.access, "read")
})

test("saving with no access keeps the old value", () => {
  const dir = project()
  saveLeadSettings(dir, parseLeadSettings(baseBody))
  const lead = leadNode(dir)
  assert.equal(lead.access, "full")
  assert.equal(lead.note, "keep")
  assert.equal(lead.chatBudgetUsd, 3)
})
