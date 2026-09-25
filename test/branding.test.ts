import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { execFileSync } from "node:child_process"
import { conceptChoiceKey, conceptIds } from "../src/concepts.ts"
import { designReviewPrompt, parseConceptPick, validateBranding, validateConcepts } from "../src/pipeline.ts"
import { approvePhase } from "../src/project.ts"
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
    .replace("gates: [spec, architecture, concepts]", "gates: [spec, mockups, branding]")
  assert.match(legacy, /^mockups:/m)
  const config = loadConfig(writePipeline("legacy", legacy))
  assert.deepEqual(config.branding, { enabled: false, count: 5, mobile: true, variations: 3, dark: true })
  assert.deepEqual(config.autonomy.gates, ["spec", "branding"])
})

test("the branding key wins over mockups and defaults to 4 images", () => {
  const config = loadConfig(writePipeline("current", examplePipeline))
  assert.deepEqual(config.branding, { enabled: true, count: 4, mobile: true, variations: 3, dark: true })
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
  assert.throws(() => validateBranding(dir, 3), /design\/illustrations\/ has no hero\.png/)
  mkdirSync(join(dir, "design/illustrations"))
  writeFileSync(join(dir, "design/illustrations/hero.png"), "")
  validateBranding(dir, 3)
})

test("validateBranding with dark on needs the dark landing, which does not count as a screen", () => {
  const dir = join(scratch, "dark")
  const brandingDir = join(dir, "design/branding")
  mkdirSync(brandingDir, { recursive: true })
  for (const file of ["01-logo.png", "README.md", "02-landing.png", "02-landing.mobile.png"]) writeFileSync(join(brandingDir, file), "")
  mkdirSync(join(dir, "design/illustrations"))
  writeFileSync(join(dir, "design/illustrations/hero.png"), "")
  validateBranding(dir, 2, true)
  assert.throws(() => validateBranding(dir, 2, true, true), /02-landing\.dark\.png/)
  writeFileSync(join(brandingDir, "02-landing.dark.png"), "")
  validateBranding(dir, 2, true, true)
  assert.throws(() => validateBranding(dir, 3, true, true), /expected at least 2/)
})

test("validateConcepts needs every direction with its logo, landing, and style", () => {
  const dir = join(scratch, "concepts")
  const conceptsDir = join(dir, "design/concepts")
  mkdirSync(conceptsDir, { recursive: true })
  writeFileSync(join(conceptsDir, "README.md"), "")
  for (const id of ["a", "b"]) {
    mkdirSync(join(conceptsDir, id))
    for (const file of ["logo.png", "landing.png", "style.md"]) writeFileSync(join(conceptsDir, id, file), "")
  }
  assert.throws(() => validateConcepts(dir, 3), /has 2 directions \(a, b\); expected 3/)
  mkdirSync(join(conceptsDir, "c"))
  writeFileSync(join(conceptsDir, "c", "logo.png"), "")
  assert.throws(() => validateConcepts(dir, 3), /c\/landing\.png/)
  writeFileSync(join(conceptsDir, "c", "landing.png"), "")
  writeFileSync(join(conceptsDir, "c", "style.md"), "")
  assert.deepEqual(validateConcepts(dir, 3), ["a", "b", "c"])
  assert.deepEqual(conceptIds(dir), ["a", "b", "c"])
})

test("parseConceptPick accepts only a listed direction", () => {
  assert.deepEqual(parseConceptPick('Done.\n```json\n{"choice":"b","reason":"warm"}\n```', ["a", "b", "c"]), { choice: "b", reason: "warm" })
  assert.throws(() => parseConceptPick('{"choice":"d"}', ["a", "b", "c"]), /one of a, b, c/)
})

test("approving concepts needs a direction that exists, and records it for the branding phase", () => {
  const dir = join(scratch, "approve")
  mkdirSync(join(dir, "design/concepts/a"), { recursive: true })
  mkdirSync(join(dir, "design/concepts/b"), { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: dir })
  const store = openStore(join(scratch, "approve.db"))
  store.setPhase("concepts", "awaiting_approval")
  assert.throws(() => approvePhase(dir, store, "concepts"), /Choose a direction to approve the concepts: a, b/)
  assert.throws(() => approvePhase(dir, store, "concepts", "z"), /Choose a direction/)
  approvePhase(dir, store, "concepts", "b")
  assert.equal(store.meta(conceptChoiceKey), "b")
  assert.equal(store.phaseStatus("concepts"), "approved")
})

test("the design review of concepts asks for distinct directions, and a change's branding for matching screens", () => {
  const config = loadConfig(writePipeline("review", examplePipeline))
  assert.match(designReviewPrompt({ phase: "concepts", config, files: ["design/concepts/a/landing.png"], previousError: null }), /3 directions[\s\S]*truly different[\s\S]*- design\/concepts\/a\/landing\.png/)
  assert.match(designReviewPrompt({ phase: "branding", config, files: [], previousError: null, changeId: "C002" }), /Change C002: expected new screen images/)
})
