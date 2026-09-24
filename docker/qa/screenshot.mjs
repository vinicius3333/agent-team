// Mounted read-only at /opt/qa/screenshot.mjs in the agent-team QA screenshot container.
// Input: BASE_URL and ROUTES ([{ "route": "/", "slug": "root" }]). Output: /out/<slug>.png and /out/report.json.
import { writeFileSync } from "node:fs"
import { chromium } from "playwright"

const outDir = process.env.OUT_DIR ?? "/out"
const baseUrl = process.env.BASE_URL
const routes = JSON.parse(process.env.ROUTES ?? "[]")
const viewport = { width: 1440, height: 900 }
const maxMessageLength = 500

const browser = await chromium.launch()
const results = []
try {
  for (const { route, slug } of routes) {
    const page = await browser.newPage({ viewport })
    const entry = { route, slug, file: null, status: null, consoleErrors: [], error: null }
    page.on("console", (message) => {
      if (message.type() === "error") entry.consoleErrors.push(message.text().slice(0, maxMessageLength))
    })
    page.on("pageerror", (error) => entry.consoleErrors.push(String(error.message).slice(0, maxMessageLength)))
    try {
      const response = await page.goto(new URL(route, baseUrl).href, { waitUntil: "load", timeout: 30_000 })
      entry.status = response?.status() ?? null
      // Apps that poll or hold a socket open never go idle; the screenshot is still useful.
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {})
      await page.screenshot({ path: `${outDir}/${slug}.png`, fullPage: true })
      entry.file = `${slug}.png`
    } catch (error) {
      entry.error = String(error.message).split("\n")[0].slice(0, maxMessageLength)
    } finally {
      await page.close()
    }
    results.push(entry)
  }
} finally {
  await browser.close()
}
writeFileSync(`${outDir}/report.json`, `${JSON.stringify({ baseUrl, viewport, routes: results }, null, 2)}\n`)
