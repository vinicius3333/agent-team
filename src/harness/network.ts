import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const proxyContext = fileURLToPath(new URL("../../docker/proxy/", import.meta.url))
const internalNetwork = "agent-team-internal"
const egressNetwork = "agent-team-egress"
const proxyName = "agent-team-proxy"
const proxyPort = 8888

export const defaultAllowlist = [
  "api.anthropic.com",
  "*.anthropic.com",
  "claude.ai",
  "*.claude.ai",
  "statsig.anthropic.com",
  "api.openai.com",
  "*.openai.com",
  "auth.openai.com",
  "chatgpt.com",
  "*.chatgpt.com",
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "nodejs.org",
  // Stock photos for the marketing phase: the Openverse search API and the hosts its images live on.
  "api.openverse.org",
  "upload.wikimedia.org",
  "live.staticflickr.com",
  "*.staticflickr.com",
  "images.pexels.com",
  "images.unsplash.com",
]

// The allowlist entry for runners.codex.baseUrl: the host, plus the port when the URL names one.
export function codexEndpointHosts(codex: { baseUrl: string } | null | undefined): string[] {
  if (!codex?.baseUrl) return []
  const url = new URL(codex.baseUrl)
  return [url.port ? `${url.hostname}:${url.port}` : url.hostname]
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

function toPattern(domain: string): string {
  const escaped = domain.replace(/^\*\./, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  return domain.startsWith("*.") ? `^.+\\.${escaped}$` : `^${escaped}$`
}

// An entry may name a port ("host.ts.net:4400"); the proxy then also allows CONNECT to that port.
export function proxyRules(allow: string[]): { filter: string; ports: number[] } {
  const hosts = new Set<string>()
  const ports = new Set([443, 80])
  for (const entry of allow) {
    const match = /^(.+):(\d{1,5})$/.exec(entry)
    hosts.add(match ? match[1] : entry)
    if (match) ports.add(Number(match[2]))
  }
  return { filter: `${[...hosts].sort().map(toPattern).join("\n")}\n`, ports: [...ports] }
}

function renderConfig(allow: string[]): { dir: string; hash: string } {
  const { filter, ports } = proxyRules(allow)
  const config = [
    `Port ${proxyPort}`,
    "Listen 0.0.0.0",
    "Timeout 600",
    "MaxClients 100",
    "LogLevel Warning",
    "FilterDefaultDeny Yes",
    "FilterType ere",
    "FilterURLs Off",
    'Filter "/etc/tinyproxy/filter"',
    ...ports.map((port) => `ConnectPort ${port}`),
    "",
  ].join("\n")
  const hash = createHash("sha256").update(config).update(filter).update(readFileSync(join(proxyContext, "Dockerfile"))).digest("hex").slice(0, 12)
  const dir = join(homedir(), ".agent-team", "proxy", hash)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "tinyproxy.conf"), config)
  writeFileSync(join(dir, "filter"), filter)
  return { dir, hash }
}

async function ensureNetwork(name: string, internal: boolean): Promise<void> {
  try {
    await docker(["network", "inspect", name])
  } catch {
    await docker(["network", "create", ...(internal ? ["--internal"] : []), "--label", "agent-team-network=1", name])
  }
}

async function ensureProxyImage(hash: string): Promise<string> {
  const tag = `agent-team-proxy:${hash}`
  try {
    await docker(["image", "inspect", tag])
  } catch {
    await docker(["build", "-t", tag, proxyContext])
  }
  return tag
}

// Agents join only the internal network (no route out); the proxy sits on both networks and allows only listed domains.
export async function ensureEgressProxy(allow: string[]): Promise<{ name: string; proxyUrl: string }> {
  const { dir, hash } = renderConfig(allow)
  await ensureNetwork(internalNetwork, true)
  await ensureNetwork(egressNetwork, false)

  const current = await docker(["inspect", "-f", '{{index .Config.Labels "agent-team-proxy.hash"}} {{.State.Running}}', proxyName]).catch(() => "")
  if (current !== `${hash} true`) {
    const image = await ensureProxyImage(hash)
    await docker(["rm", "-f", proxyName]).catch(() => {})
    await docker([
      "run", "-d",
      "--name", proxyName,
      "--label", "agent-team-proxy=1",
      "--label", `agent-team-proxy.hash=${hash}`,
      "--restart", "unless-stopped",
      "--network", egressNetwork,
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", "128m",
      "-v", `${dir}:/etc/tinyproxy:ro`,
      image,
    ])
    await docker(["network", "connect", internalNetwork, proxyName])
  }
  return { name: internalNetwork, proxyUrl: `http://${proxyName}:${proxyPort}` }
}
