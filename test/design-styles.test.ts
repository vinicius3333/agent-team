import assert from "node:assert/strict"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { catalogProblems, chosenStyleId, conceptStyle, conceptSwatches, contrastRatio, designStyleIds, loadDesignCatalog, styleCatalogDir, styleNotes, type DesignCatalog } from "../src/design-styles.ts"
import { designReviewPrompt } from "../src/pipeline.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-styles-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const examplePipeline = readFileSync(new URL("../pipeline.example.yaml", import.meta.url), "utf8")
const noteInput = { phase: "design", role: "designer", choice: null, configured: "auto", variations: 3 }

function freshDir(name: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeConceptStyle(dir: string, id: string, text: string): void {
  mkdirSync(join(dir, "design/concepts", id), { recursive: true })
  writeFileSync(join(dir, "design/concepts", id, "style.md"), text)
}

test("the shipped catalog passes every check, with WCAG AA palettes", () => {
  const catalog = loadDesignCatalog()
  assert.deepEqual(catalogProblems(catalog), [])
  assert.ok(catalog.styles.length >= 10)
  assert.ok(catalog.styles.some((style) => style.webgl))
})

test("contrastRatio follows WCAG", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#FFFFFF") * 100) / 100, 21)
  assert.equal(contrastRatio("#777777", "#777777"), 1)
  assert.equal(Math.round(contrastRatio("#FFFFFF", "#58CC02") * 100) / 100, 2.09)
})

test("catalogProblems names duplicate ids, bad hex values, and low contrast", () => {
  const [style] = loadDesignCatalog().styles
  const palette = { ...style.palettes[0], roles: { ...style.palettes[0].roles, muted: "#CCCCCC", background: "#FFFFFF", onPrimary: "#FFFFFF", primary: "#58CC02" } }
  const broken: DesignCatalog = {
    updated: "2026-09-25",
    fundamentals: [],
    sources: [],
    styles: [
      { ...style, palettes: [palette] },
      { ...style, palettes: [{ ...palette, roles: { ...palette.roles, ink: "black" } }] },
    ],
  }
  const problems = catalogProblems(broken).join("\n")
  assert.match(problems, /muted on background is 1\.61:1, under the 4\.5:1 WCAG AA minimum/)
  assert.match(problems, /onPrimary on primary is 2\.09:1/)
  assert.match(problems, /the id is used twice/)
  assert.match(problems, /ink must be #RRGGBB/)
  assert.match(problems, /fundamentals needs at least one entry/)
})

test("conceptStyle reads the Style line in plain or bold Markdown", () => {
  assert.equal(conceptStyle("Style: bento-grid\nColors: ..."), "bento-grid")
  assert.equal(conceptStyle("# Direction a\n\n- **Style:** `swiss-grid`"), "swiss-grid")
  assert.equal(conceptStyle("Colors: warm"), null)
})

test("the concepts agent gets the catalog and one style per direction, or the fixed style", () => {
  const dir = freshDir("concepts")
  const auto = styleNotes({ ...noteInput, phase: "concepts", role: "illustrator", dir }).join("\n")
  assert.match(auto, /Pick 3 different styles/)
  assert.match(auto, /Style: <id>/)
  assert.ok(existsSync(join(dir, styleCatalogDir, "README.md")))
  for (const id of designStyleIds()) assert.ok(existsSync(join(dir, styleCatalogDir, `${id}.md`)), id)
  assert.match(readFileSync(join(dir, styleCatalogDir, "neo-brutalism.md"), "utf8"), /## Failure modes[\s\S]*## References/)

  const fixed = styleNotes({ ...noteInput, phase: "concepts", role: "illustrator", dir, configured: "editorial-serif" }).join("\n")
  assert.match(fixed, /chose the "editorial-serif" style for every direction/)
  assert.match(fixed, /Style: editorial-serif/)
})

test("later phases follow the chosen concept's style, and only a WebGL style adds a 3D task", () => {
  const dir = freshDir("chosen")
  writeConceptStyle(dir, "a", "Style: immersive-3d-webgl\n")
  writeConceptStyle(dir, "b", "Style: bento-grid\n")
  assert.equal(chosenStyleId(dir, "a", "auto"), "immersive-3d-webgl")
  assert.equal(chosenStyleId(dir, null, "auto"), null)
  assert.equal(chosenStyleId(dir, null, "swiss-grid"), "swiss-grid")

  const designer = styleNotes({ ...noteInput, dir, choice: "a" }).join("\n")
  assert.match(designer, /"immersive-3d-webgl"[\s\S]*real-time 3D hero[\s\S]*static poster/)
  assert.match(styleNotes({ ...noteInput, role: "planner", dir, choice: "a" }).join("\n"), /@react-three\/fiber[\s\S]*QA browser has no internet/)
  assert.deepEqual(styleNotes({ ...noteInput, role: "planner", dir, choice: "b" }), [])
  assert.match(styleNotes({ ...noteInput, phase: "branding", role: "illustrator", dir, choice: "b" }).join("\n"), /follows the "bento-grid" style/)
  assert.deepEqual(styleNotes({ ...noteInput, role: "designer", dir: freshDir("no-choice") }), [])
})

test("the architect hears about 3D only when the person fixed a WebGL style up front", () => {
  const dir = freshDir("architect")
  assert.deepEqual(styleNotes({ ...noteInput, phase: "architecture", role: "architect", dir }), [])
  assert.match(styleNotes({ ...noteInput, phase: "architecture", role: "architect", dir, configured: "immersive-3d-webgl" }).join("\n"), /Add three, @react-three\/fiber/)
})

test("branding.style must be auto or a catalog id", () => {
  const path = join(freshDir("config"), "pipeline.yaml")
  writeFileSync(path, examplePipeline.replace("style: auto", "style: bento-grid"))
  assert.equal(loadConfig(path).branding.style, "bento-grid")
  writeFileSync(path, examplePipeline.replace("style: auto", "style: made-up"))
  assert.throws(() => loadConfig(path), /branding\.style must be auto or one of .*bento-grid/)
})

test("the design review checks each direction against its style, and later phases against the chosen one", () => {
  const path = join(freshDir("review"), "pipeline.yaml")
  writeFileSync(path, examplePipeline)
  const config = loadConfig(path)
  assert.match(designReviewPrompt({ phase: "concepts", config, files: [], previousError: null }), /names a different style from the catalog[\s\S]*failure modes/)
  assert.match(designReviewPrompt({ phase: "design", config, files: [], previousError: null, style: "swiss-grid" }), /chosen visual style is "swiss-grid"/)
  assert.doesNotMatch(designReviewPrompt({ phase: "design", config, files: [], previousError: null }), /chosen visual style/)
})

test("the server lists the styles and saves the chosen one in pipeline.yaml", async (t) => {
  const runsDir = freshDir("runs")
  const server = startUi({ runsDir, port: 0, startRun: () => {} })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const styles = await (await fetch(`${base}/api/design-styles`)).json()
  assert.deepEqual(styles.map((style: { id: string }) => style.id), designStyleIds())
  assert.equal(styles.find((style: { id: string }) => style.id === "immersive-3d-webgl").webgl, true)
  assert.match(styles[0].palette.background, /^#[0-9A-F]{6}$/i)

  const post = (body: Record<string, unknown>) =>
    fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify({ name: "ring", brief: "A ring", target: "web", gates: [], github: false, deploy: false, branding: true, ...body }) })
  const unknown = await post({ designStyle: "made-up" })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /The design style must be auto or one of/)
  assert.equal((await post({ designStyle: "swiss-grid" })).status, 201)
  assert.equal(loadConfig(join(runsDir, "ring", "pipeline.yaml")).branding.style, "swiss-grid")

  writeConceptStyle(join(runsDir, "ring"), "a", "Style: immersive-3d-webgl\n- Background #07070A\n")
  writeConceptStyle(join(runsDir, "ring"), "b", "- Background #FFFFFF\n")
  const { concepts } = await (await fetch(`${base}/api/projects/ring/concepts`)).json()
  assert.equal(concepts[0].catalogStyle.name, "3D / WebGL immersive")
  assert.equal(concepts[0].catalogStyle.webgl, true)
  assert.equal(concepts[1].catalogStyle, null)
  assert.match(concepts[1].style, /#FFFFFF/)
})

test("conceptSwatches reads the direction's own colors by role and skips muted, border, and status colors", () => {
  const block = ["Style: luxury-premium-dark", "- Background: #0b0b0a", "- Surface #151513", "- Border #2A2A26", "- Ink text: #EDE8DF", "- Muted text #9A958A", "- Primary accent #C8A96A", "- Success #1F7A4D", "- Dark background #000000"].join("\n")
  assert.deepEqual(conceptSwatches(block), ["#0B0B0A", "#151513", "#EDE8DF", "#C8A96A"])
  assert.deepEqual(conceptSwatches("- Background #FFFFFF\n- Primary #7C3AED"), [])
})
