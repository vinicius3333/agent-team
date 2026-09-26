// Mounted read-only at /opt/qa/screenshot.mjs in the agent-team QA screenshot container.
// Input: BASE_URL, ROUTES ([{ "route": "/", "slug": "root", "signedIn": false }]),
// and optional LOGIN ({ "route": "/login", "email": "...", "password": "..." }) for signed-in routes.
// Output: /out/<slug>.png (desktop), /out/<slug>.mobile.png, and /out/report.json.
import { writeFileSync } from "node:fs"
import { chromium, devices } from "playwright"

const outDir = process.env.OUT_DIR ?? "/out"
const baseUrl = process.env.BASE_URL
const routes = JSON.parse(process.env.ROUTES ?? "[]")
const login = process.env.LOGIN ? JSON.parse(process.env.LOGIN) : null
const viewport = { width: 1440, height: 900 }
const mobileDevice = devices["iPhone 13"]
const maxMessageLength = 500
const maxListed = 8
// WCAG 2.2 AA (2.5.8) asks for 24px; 44px is the comfortable size the design system asks for.
const minimumTarget = 24
const comfortableTarget = 44

// Runs in the page. Lists what breaks a phone layout: sideways scroll, elements past the right edge, small tap targets.
function measureLayout({ maxListed, minimumTarget, comfortableTarget }) {
  const describe = (element) => {
    const id = element.id ? `#${element.id}` : ""
    const text = (element.innerText || element.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40)
    return `${element.tagName.toLowerCase()}${id}${text ? ` "${text}"` : ""}`
  }
  const visible = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
  }
  const width = document.documentElement.clientWidth
  const overflowing = []
  for (const element of document.body.querySelectorAll("*")) {
    if (overflowing.length >= maxListed) break
    if (!visible(element)) continue
    const rect = element.getBoundingClientRect()
    // Report the outermost offender only: its children overflow with it.
    if (rect.right > width + 1 && !(element.parentElement && element.parentElement.getBoundingClientRect().right > width + 1)) {
      overflowing.push(`${describe(element)} ends at ${Math.round(rect.right)}px`)
    }
  }
  const smallTargets = []
  const tightTargets = []
  for (const element of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox]")) {
    if (!visible(element)) continue
    // Links inside running text are exempt from the target size rule.
    if (element.tagName === "A" && element.closest("p, li") && getComputedStyle(element).display === "inline") continue
    const rect = element.getBoundingClientRect()
    const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`
    if (rect.width < minimumTarget || rect.height < minimumTarget) {
      if (smallTargets.length < maxListed) smallTargets.push(`${describe(element)} is ${size}`)
    } else if (rect.height < comfortableTarget && tightTargets.length < maxListed) {
      tightTargets.push(`${describe(element)} is ${size}`)
    }
  }
  return {
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - width),
    overflowing,
    smallTargets,
    tightTargets,
  }
}

// Fills the first email (or text) field when the form has one, then the password field, submits, and keeps the session cookies.
// A password-only form (one shared password) has no email field, so the email is optional.
async function signIn(browser) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  try {
    await page.goto(new URL(login.route, baseUrl).href, { waitUntil: "load", timeout: 30_000 })
    const email = page.locator('input[type=email], input[name*=email i], input[autocomplete=username], input[type=text]').first()
    const password = page.locator("input[type=password]").first()
    // Wait for the form to render before checking whether it has an email field.
    await password.waitFor({ state: "visible", timeout: 10_000 })
    if (login.email && (await email.count())) await email.fill(login.email, { timeout: 10_000 })
    await password.fill(login.password, { timeout: 10_000 })
    const submit = page.locator('button[type=submit], input[type=submit], form button').first()
    await Promise.all([page.waitForLoadState("load").catch(() => {}), (await submit.count()) ? submit.click() : password.press("Enter")])
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {})
    const stillOnLogin = new URL(page.url()).pathname === login.route && (await password.isVisible().catch(() => false))
    if (stillOnLogin) return { ok: false, error: `still on ${login.route} after submitting the demo account`, storageState: null }
    return { ok: true, error: null, storageState: await context.storageState() }
  } catch (error) {
    return { ok: false, error: String(error.message).split("\n")[0].slice(0, maxMessageLength), storageState: null }
  } finally {
    await context.close()
  }
}

async function capture(browser, options, route, file) {
  const context = await browser.newContext(options)
  const page = await context.newPage()
  const entry = { file: null, status: null, consoleErrors: [], error: null, layout: null }
  page.on("console", (message) => {
    if (message.type() === "error") entry.consoleErrors.push(message.text().slice(0, maxMessageLength))
  })
  page.on("pageerror", (error) => entry.consoleErrors.push(String(error.message).slice(0, maxMessageLength)))
  try {
    const response = await page.goto(new URL(route, baseUrl).href, { waitUntil: "load", timeout: 30_000 })
    entry.status = response?.status() ?? null
    // Apps that poll or hold a socket open never go idle; the screenshot is still useful.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {})
    entry.layout = await page.evaluate(measureLayout, { maxListed, minimumTarget, comfortableTarget })
    await page.screenshot({ path: `${outDir}/${file}`, fullPage: true })
    entry.file = file
  } catch (error) {
    entry.error = String(error.message).split("\n")[0].slice(0, maxMessageLength)
  } finally {
    await context.close()
  }
  return entry
}

const browser = await chromium.launch()
const results = []
let session = null
try {
  if (login && routes.some((entry) => entry.signedIn)) session = { route: login.route, ...(await signIn(browser)) }
  for (const { route, slug, signedIn } of routes) {
    const storageState = signedIn && session?.storageState ? session.storageState : undefined
    const { layout: _desktopLayout, ...desktop } = await capture(browser, { viewport, storageState }, route, `${slug}.png`)
    const mobile = await capture(browser, { ...mobileDevice, storageState }, route, `${slug}.mobile.png`)
    results.push({ route, slug, signedIn: Boolean(signedIn), ...desktop, mobile })
  }
} finally {
  await browser.close()
}
const mobileViewport = mobileDevice.viewport
writeFileSync(`${outDir}/report.json`, `${JSON.stringify({ baseUrl, viewport, mobileViewport, login: session && { route: session.route, ok: session.ok, error: session.error }, routes: results }, null, 2)}\n`)
