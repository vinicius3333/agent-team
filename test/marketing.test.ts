import assert from "node:assert/strict"
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { marketingPage, validateMarketing, type MarketingPiece } from "../src/marketing.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-marketing-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const stockPiece: MarketingPiece = {
  id: "launch",
  problem: "Clinics lose patients to double bookings.",
  headline: "Chega de agenda em papel",
  subtitle: "Pacientes marcam online e a equipe vê a semana inteira.",
  cta: "Comece grátis",
  layout: "overlay",
  image: { file: "marketing/art/launch.jpg", source: "stock", reason: "A real waiting room.", url: "https://www.flickr.com/photos/x/1", credit: "Photo by Jane", license: "CC BY 2.0" },
}

function project(name: string, copy: unknown, art: string[] = ["launch.jpg"]): string {
  const dir = join(scratch, name)
  mkdirSync(join(dir, "marketing/art"), { recursive: true })
  for (const file of art) writeFileSync(join(dir, "marketing/art", file), "image")
  writeFileSync(join(dir, "marketing/copy.json"), typeof copy === "string" ? copy : JSON.stringify(copy))
  return dir
}

test("validateMarketing accepts a complete copy file", () => {
  const copy = validateMarketing(project("valid", { language: "pt-BR", pieces: [stockPiece] }), 1)
  assert.equal(copy.pieces[0].headline, "Chega de agenda em papel")
})

test("validateMarketing lists every problem at once", () => {
  const generated = { ...stockPiece, id: "Bad Id", headline: "x".repeat(61), layout: "grid", image: { file: "marketing/art/missing.png", source: "generated", reason: "" } }
  const stockWithoutCredit = { ...stockPiece, id: "credit", image: { ...stockPiece.image, credit: undefined } }
  const dir = project("invalid", { language: "Portuguese", pieces: [generated, stockWithoutCredit] })
  assert.throws(() => validateMarketing(dir, 3), (error: Error) => {
    for (const expected of [/BCP 47/, /expected 3 pieces, found 2/, /id must be lowercase/, /headline has 61 characters/, /layout must be/, /missing\.png does not exist/, /reason is missing/, /url, credit, and license/]) {
      assert.match(error.message, expected)
    }
    return true
  })
})

test("validateMarketing rejects a file that is not JSON", () => {
  assert.throws(() => validateMarketing(project("broken", "{"), 1), /not valid JSON/)
})

test("marketingPage escapes the copy and credits stock photos", () => {
  const page = marketingPage({ piece: { ...stockPiece, headline: "<b>Fast</b> & calm" }, format: "story", language: "pt-BR", productName: "Agenda", hasTokens: true })
  assert.match(page, /<html lang="pt-BR">/)
  assert.match(page, /width: 1080px; height: 1920px/)
  assert.match(page, /&#60;b&#62;Fast&#60;\/b&#62; &#38; calm/)
  assert.match(page, /Photo by Jane · CC BY 2\.0/)
  assert.match(page, /href="tokens\.css"/)
  const generated = marketingPage({ piece: { ...stockPiece, layout: "split", image: { file: "marketing/art/launch.png", source: "generated", reason: "abstract" } }, format: "og", language: "en", productName: "Agenda", hasTokens: false })
  assert.doesNotMatch(generated, /class="credit"/)
  assert.doesNotMatch(generated, /tokens\.css/)
  assert.match(generated, /flex-direction: row/)
})

test("the marketing config has defaults and rejects unknown formats", () => {
  const path = join(scratch, "pipeline.yaml")
  const example = readFileSync(new URL("../pipeline.example.yaml", import.meta.url), "utf8").replace(/^marketing:[\s\S]*?\n\n/m, "")
  writeFileSync(path, example)
  assert.deepEqual(loadConfig(path).marketing, { enabled: true, pieces: 3, formats: ["og", "square", "story", "x"] })
  assert.equal(loadConfig(path).roles.marketer.runner, "codex")
  writeFileSync(path, `${example}\nmarketing: { formats: [banner] }\n`)
  assert.throws(() => loadConfig(path), /unknown marketing format "banner"/)
})
