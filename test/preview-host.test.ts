import assert from "node:assert/strict"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-preview-host-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const builtWebDir = fileURLToPath(new URL("../web/dist/", import.meta.url))
const dashboardPages = ["/", "/login", "/new", "/import", "/incidents", "/settings", "/not-found"]

// fetch drops a custom Host header, so the requests go through node:http.
function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      response.on("error", reject)
    })
    outgoing.on("error", reject)
    outgoing.end()
  })
}

// AGENT_TEAM_UI_HOSTS is read when the server starts, so it is set only for that moment.
async function startPreview(t: { after: (fn: () => void) => void }, name: string, webDir?: string) {
  const previous = process.env.AGENT_TEAM_UI_HOSTS
  process.env.AGENT_TEAM_UI_HOSTS = "app.example"
  try {
    const server = startUi({ runsDir: join(scratch, name), port: 0, host: "127.0.0.1", auth: { mode: "none" }, startRun: () => {}, notifications: false, webDir })
    await once(server, "listening")
    t.after(() => server.close())
    return (server.address() as AddressInfo).port
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_UI_HOSTS
    else process.env.AGENT_TEAM_UI_HOSTS = previous
  }
}

test("the AGENT_TEAM_UI_HOSTS host gets the dashboard and an unknown host gets 403", async (t) => {
  const webDir = join(scratch, "web-dist")
  mkdirSync(webDir, { recursive: true })
  writeFileSync(join(webDir, "index.html"), "<div id=root></div>")
  const port = await startPreview(t, "hosts-runs", webDir)

  const allowed = await get(port, "/", "app.example")
  assert.equal(allowed.status, 200)
  assert.equal(allowed.body, "<div id=root></div>")

  const withPort = await get(port, "/", `app.example:${port}`)
  assert.equal(withPort.status, 200)

  const denied = await get(port, "/", "evil.example")
  assert.equal(denied.status, 403)
  assert.deepEqual(JSON.parse(denied.body), { error: "This host name is not allowed. Add it to AGENT_TEAM_UI_HOSTS." })

  const deniedApi = await get(port, "/api/projects", "evil.example")
  assert.equal(deniedApi.status, 403)
})

test("every dashboard page answers 200 with the built shell on the AGENT_TEAM_UI_HOSTS host", async (t) => {
  const indexPath = join(builtWebDir, "index.html")
  if (!existsSync(indexPath)) return t.skip("web/dist is missing. Run: npm run build:ui")
  const shell = readFileSync(indexPath, "utf8")
  const port = await startPreview(t, "shell-runs")
  for (const page of dashboardPages) {
    const response = await get(port, page, "app.example")
    assert.equal(response.status, 200, `${page} answered ${response.status}`)
    assert.equal(response.body, shell, `${page} did not answer with web/dist/index.html`)
    const denied = await get(port, page, "evil.example")
    assert.equal(denied.status, 403, `${page} with an unknown host answered ${denied.status}`)
  }
})
