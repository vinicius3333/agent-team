// Mounted read-only at /opt/qa/render-marketing.mjs in the agent-team QA screenshot container.
// Input: /in/<page>.html with its art, logo, and tokens beside it, and JOBS ([{ "page", "file", "width", "height" }]). Output: /out/<file>.
import { chromium } from "playwright"

const outDir = process.env.OUT_DIR ?? "/out"
const jobs = JSON.parse(process.env.JOBS ?? "[]")

const browser = await chromium.launch()
try {
  for (const { page: name, file, width, height } of jobs) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(`file:///in/${name}`, { waitUntil: "load" })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${outDir}/${file}` })
    await page.close()
  }
} finally {
  await browser.close()
}
