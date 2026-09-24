import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { groupPhaseFiles, parseCommitPlan } from "../src/commits.ts"
import { packIco, themeColor, validateMark, webManifest } from "../src/favicon.ts"
import { validateBranding } from "../src/pipeline.ts"
import { ensureDemoAccess, readDemoAccess } from "../src/access.ts"
import { openStore } from "../src/store.ts"
import { loginFailures, mobileFailures, type RouteReport } from "../src/screenshots.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-design-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const fence = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

test("parseCommitPlan keeps valid groups and rejects bad ones", () => {
  const changed = ["src/a.ts", "src/a.test.ts", "src/b.ts"]
  assert.deepEqual(parseCommitPlan("no block here", changed), { kind: "none" })
  assert.deepEqual(parseCommitPlan(fence({ verdict: "pass" }), changed), { kind: "none" })
  assert.deepEqual(parseCommitPlan(fence({ commits: [{ message: "feat(a): add a", files: ["src/a.ts", "src/a.test.ts"] }, { message: "fix(b): handle b", files: ["src/a.ts", "src/b.ts"] }] }), changed), {
    kind: "groups",
    groups: [
      { message: "feat(a): add a", files: ["src/a.ts", "src/a.test.ts"] },
      { message: "fix(b): handle b", files: ["src/b.ts"] },
    ],
  })
  assert.equal(parseCommitPlan(fence({ commits: [{ message: "Added a", files: ["src/a.ts"] }] }), changed).kind, "invalid")
  assert.match((parseCommitPlan(fence({ commits: [{ message: "feat: a", files: ["src/c.ts"] }] }), changed) as { reason: string }).reason, /did not change: src\/c\.ts/)
})

test("groupPhaseFiles gives each file to the first matching commit, minus exclusions", () => {
  const groups = groupPhaseFiles(["design/branding/01-logo.png", "design/branding/02-a.png", "design/branding/02-a.mobile.png", "design/branding/README.md"], [
    { message: "logo", matches: ["design/branding/01-logo.*"] },
    { message: "desktop", matches: ["design/branding/*"], exclude: ["design/branding/*.mobile.*", "design/branding/*.md"] },
    { message: "mobile", matches: ["design/branding/*.mobile.*"] },
  ])
  assert.deepEqual(groups.map((group) => group.files), [["design/branding/01-logo.png"], ["design/branding/02-a.png"], ["design/branding/02-a.mobile.png"]])
})

test("packIco writes a header, one entry per PNG, and the PNG data", () => {
  const ico = packIco([{ size: 16, data: Buffer.from("aaaa") }, { size: 32, data: Buffer.from("bbbbbb") }])
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 2)
  assert.equal(ico.readUInt8(6), 16)
  assert.equal(ico.readUInt32LE(6 + 8), 4)
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32)
  assert.equal(ico.readUInt32LE(22 + 12), 6 + 32 + 4)
  assert.equal(ico.subarray(-6).toString(), "bbbbbb")
})

test("validateMark needs literal colors and a square viewBox", () => {
  const dir = join(scratch, "mark")
  mkdirSync(join(dir, "design"), { recursive: true })
  const write = (svg: string) => writeFileSync(join(dir, "design/logo-mark.svg"), svg)
  write('<svg viewBox="0 0 32 32"><rect fill="currentColor"/></svg>')
  assert.throws(() => validateMark(dir), /literal colors/)
  write('<svg viewBox="0 0 64 32"><rect fill="#000"/></svg>')
  assert.throws(() => validateMark(dir), /square viewBox/)
  write('<svg viewBox="0 0 32 32"><rect fill="#000"/></svg>')
  validateMark(dir)
})

test("the manifest takes the theme color from the primary token", () => {
  assert.equal(themeColor(":root {\n  --primary: oklch(0.5 0.1 180);\n}"), "oklch(0.5 0.1 180)")
  const manifest = JSON.parse(webManifest("Task Board", "#0f766e"))
  assert.equal(manifest.theme_color, "#0f766e")
  assert.deepEqual(manifest.icons.map((icon: { src: string }) => icon.src), ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"])
})

test("mobileFailures flags sideways scroll and tap targets under 24px, not tight ones", () => {
  const route = (path: string, layout: object): RouteReport => ({
    route: path, slug: "x", file: "x.png", status: 200, consoleErrors: [], error: null, branding: null, mobileBranding: null,
    mobile: { file: "x.mobile.png", status: 200, consoleErrors: [], error: null, layout: { horizontalOverflow: 0, overflowing: [], smallTargets: [], tightTargets: [], ...layout } },
  })
  const failures = mobileFailures({
    baseUrl: null,
    viewport: { width: 1440, height: 900 },
    mobileViewport: { width: 390, height: 664 },
    startError: null,
    routes: [route("/", { horizontalOverflow: 120, overflowing: ['table "Items" ends at 510px'] }), route("/a", { smallTargets: ["a is 16x16"] }), route("/b", { tightTargets: ["button is 80x32"] })],
  })
  assert.deepEqual(failures, ['/ scrolls sideways by 120px at 390px wide: table "Items" ends at 510px', "/a has tap targets under 24px on mobile: a is 16x16"])
})

test("validateBranding needs a mobile version of each desktop screen when mobile is on", () => {
  const dir = join(scratch, "branding")
  const brandingDir = join(dir, "design/branding")
  mkdirSync(brandingDir, { recursive: true })
  for (const file of ["01-logo.png", "README.md", "02-board.png", "03-settings.png", "02-board.mobile.png"]) writeFileSync(join(brandingDir, file), "")
  validateBranding(dir, 3)
  assert.throws(() => validateBranding(dir, 3, true), /no mobile version of: 03-settings\.png \(expected 03-settings\.mobile\.png\)/)
  writeFileSync(join(brandingDir, "03-settings.mobile.png"), "")
  validateBranding(dir, 3, true)
})

test("the demo account is made once per project and kept out of git", () => {
  const dir = join(scratch, "access")
  mkdirSync(dir, { recursive: true })
  const store = openStore(join(dir, "state.db"))
  const first = ensureDemoAccess(store)
  assert.equal(first.email, "demo@example.com")
  assert.ok(first.password.length >= 20)
  assert.deepEqual(ensureDemoAccess(store), first)
  assert.equal(readDemoAccess("not json"), null)
})

test("loginFailures flags signed-in screens without a login line or with a failed login", () => {
  const base = { baseUrl: null, viewport: { width: 1440, height: 900 }, startError: null }
  const route = (signedIn: boolean): RouteReport => ({ route: signedIn ? "/app" : "/", slug: "x", file: null, status: 200, consoleErrors: [], error: null, branding: null, mobileBranding: null, signedIn })
  assert.deepEqual(loginFailures({ ...base, routes: [route(false)] }), [])
  assert.match(loginFailures({ ...base, routes: [route(true)], login: null })[0], /no `Login: \/path` line/)
  assert.match(loginFailures({ ...base, routes: [route(true)], login: { route: "/login", ok: false, error: "still on /login" } })[0], /could not log in at \/login: still on \/login/)
  assert.deepEqual(loginFailures({ ...base, routes: [route(true)], login: { route: "/login", ok: true, error: null } }), [])
})
