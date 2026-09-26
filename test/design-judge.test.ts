import assert from "node:assert/strict"
import { test } from "node:test"
import { designJudgePrompt, parseDesignScore } from "../src/design-judge.ts"

const dimensions = { hierarchy: 80, typography: 70, color: 90, layout: 60, style_fidelity: 75, originality: 50, mobile: 85, polish: 70 }

function reply(overrides: Record<string, unknown> = {}): string {
  const body = { summary: "Solid.", dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, score]) => [key, { score, notes: "" }])), issues: ["/ hero: CTA below the fold"], ...overrides }
  return `Done.\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``
}

test("parseDesignScore computes the mean itself and keeps the style", () => {
  const design = parseDesignScore(reply(), "swiss-grid")
  assert.equal(design.score, 73)
  assert.equal(design.style, "swiss-grid")
  assert.deepEqual(design.issues, ["/ hero: CTA below the fold"])
})

test("parseDesignScore lists every problem at once", () => {
  const broken = reply({ dimensions: { hierarchy: { score: 120 } }, issues: "none" })
  assert.throws(() => parseDesignScore(broken, null), (error: Error) => {
    assert.match(error.message, /hierarchy\.score must be a number from 0 to 100/)
    assert.match(error.message, /typography\.score/)
    assert.match(error.message, /issues must be an array/)
    return true
  })
})

test("the judge prompt names the screenshots, the style file, and the branding", () => {
  const withStyle = designJudgePrompt({ screenshots: ".agent-team/qa/round-2", branding: ["02-landing.png"], style: "editorial-serif", previousError: null })
  assert.match(withStyle, /\.agent-team\/qa\/round-2\//)
  assert.match(withStyle, /\.agent-team\/design-styles\/editorial-serif\.md/)
  assert.match(withStyle, /design\/branding\/02-landing\.png/)
  const plain = designJudgePrompt({ screenshots: "x", branding: [], style: null, previousError: "bad json" })
  assert.match(plain, /No catalog style was chosen/)
  assert.match(plain, /Fix this: bad json/)
})
