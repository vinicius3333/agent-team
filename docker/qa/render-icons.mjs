// Mounted read-only at /opt/qa/render-icons.mjs in the agent-team QA screenshot container.
// Input: /in/mark.svg and ICONS ([{ "file": "icon-192.png", "size": 192, "background": null }]). Output: /out/<file>.
import { readFileSync } from "node:fs"
import { chromium } from "playwright"

const outDir = process.env.OUT_DIR ?? "/out"
const svg = readFileSync("/in/mark.svg", "utf8")
const icons = JSON.parse(process.env.ICONS ?? "[]")

const browser = await chromium.launch()
try {
  for (const { file, size, background, padding } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    const inset = Math.round(size * (padding ?? 0))
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    await page.setContent(
      `<html><body style="margin:0;background:${background ?? "transparent"}"><img src="${source}" style="position:absolute;inset:${inset}px;width:${size - 2 * inset}px;height:${size - 2 * inset}px;object-fit:contain"></body></html>`,
    )
    await page.waitForFunction(() => document.images[0]?.complete)
    await page.screenshot({ path: `${outDir}/${file}`, omitBackground: !background })
    await page.close()
  }
} finally {
  await browser.close()
}
