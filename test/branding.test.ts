import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { validateBranding } from "../src/pipeline.ts"
import { openStore } from "../src/store.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-branding-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const examplePipeline = readFileSync(new URL("../pipeline.example.yaml", import.meta.url), "utf8")

function writePipeline(name: string, yaml: string): string {
  const path = join(scratch, `${name}.yaml`)
  writeFileSync(path, yaml)
  return path
}

test("the old mockups key and gate map to branding", () => {
  const legacy = examplePipeline
    .replace(/^branding:\n  enabled: true.*\n  count: 4.*$/m, "mockups:\n  enabled: false\n  count: 5")
    .replace("gates: [spec, architecture]", "gates: [spec, mockups, branding]")
  assert.match(legacy, /^mockups:/m)
  const config = loadConfig(writePipeline("legacy", legacy))
  assert.deepEqual(config.branding, { enabled: false, count: 5, mobile: true })
  assert.deepEqual(config.autonomy.gates, ["spec", "branding"])
})

test("the branding key wins over mockups and defaults to 4 images", () => {
  const config = loadConfig(writePipeline("current", examplePipeline))
  assert.deepEqual(config.branding, { enabled: true, count: 4, mobile: true })
  const both = loadConfig(writePipeline("both", `${examplePipeline}\nmockups:\n  count: 6\n`))
  assert.equal(both.branding.count, 4)
})

test("branding.count must be between 2 and 6", () => {
  for (const count of [1, 7]) {
    const yaml = examplePipeline.replace(/count: 4 /, `count: ${count} `)
    assert.throws(() => loadConfig(writePipeline(`count-${count}`, yaml)), /branding.count must be between 2 and 6/)
  }
})

test("opening an old state DB renames the mockups phase row to branding", () => {
  const path = join(scratch, "state.db")
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE phases (name TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL)")
  db.prepare("INSERT INTO phases VALUES (?, ?, ?)").run("mockups", "approved", "2026-01-01T00:00:00.000Z")
  db.close()

  const store = openStore(path)
  assert.equal(store.phaseStatus("branding"), "approved")
  assert.deepEqual(store.phases().map((phase) => phase.name), ["branding"])
  const reopened = openStore(path)
  assert.equal(reopened.phaseStatus("branding"), "approved")
})

test("validateBranding needs the logo, count - 1 screens, and a README", () => {
  const dir = join(scratch, "project")
  const brandingDir = join(dir, "design/branding")
  mkdirSync(brandingDir, { recursive: true })
  assert.throws(() => validateBranding(dir, 3), /01-logo\.png/)
  writeFileSync(join(brandingDir, "01-logo.png"), "")
  writeFileSync(join(brandingDir, "README.md"), "")
  writeFileSync(join(brandingDir, "02-dashboard.png"), "")
  assert.throws(() => validateBranding(dir, 3), /expected at least 2/)
  writeFileSync(join(brandingDir, "03-settings.png"), "")
  validateBranding(dir, 3)
})
