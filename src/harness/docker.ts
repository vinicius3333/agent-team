import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { runProcess } from "../runners/spawn.ts"
import type { Executor } from "./executor.ts"

const execFileAsync = promisify(execFile)
const dockerContext = fileURLToPath(new URL("../../docker/", import.meta.url))
const containerLabel = "agent-team=1"
const containerUser = "1000:1000"

export type CredentialName = "claude" | "codex"

export interface DockerLimits {
  cpus: number
  memory: string
  pidsLimit: number
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

export async function ensureImage(): Promise<string> {
  const dockerfile = readFileSync(join(dockerContext, "Dockerfile"))
  const tag = `agent-team-runner:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`
  try {
    await docker(["image", "inspect", tag])
  } catch {
    await docker(["build", "-t", tag, dockerContext])
  }
  return tag
}

export async function cleanupOrphans(): Promise<void> {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${containerLabel}`])).split("\n").filter(Boolean)
  if (ids.length) await docker(["rm", "-f", ...ids]).catch(() => {})
}

interface RotatingFile {
  source: string
  copy: string
  originalContent: string
}

// OAuth CLIs rotate refresh tokens. A token refreshed inside a container must be written back to the host,
// or the host's copy is invalidated and the next run fails to authenticate.
function copyCredentials(credentials: CredentialName[]): { dir: string; mounts: string[]; env: string[]; rotating: RotatingFile[] } {
  const dir = mkdtempSync(join(tmpdir(), "agent-team-creds-"))
  chmodSync(dir, 0o700)
  const home = homedir()
  const mounts: string[] = []
  const env: string[] = []
  const rotating: RotatingFile[] = []
  const copyInto = (target: string, files: string[]) => {
    const targetDir = join(dir, target)
    mkdirSync(targetDir, { recursive: true, mode: 0o700 })
    for (const file of files) {
      const source = join(home, target, file)
      if (!existsSync(source)) continue
      const copy = join(targetDir, file)
      copyFileSync(source, copy)
      rotating.push({ source, copy, originalContent: readFileSync(source, "utf8") })
    }
    mounts.push("-v", `${targetDir}:/home/agent/${target}`)
  }
  if (credentials.includes("claude")) {
    // A long-lived token from `claude setup-token` does not rotate; pass it by name so it never appears in argv.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.push("-e", "CLAUDE_CODE_OAUTH_TOKEN")
    else copyInto(".claude", [".credentials.json"])
    const claudeConfig = join(home, ".claude.json")
    if (existsSync(claudeConfig)) {
      copyFileSync(claudeConfig, join(dir, "claude.json"))
      mounts.push("-v", `${join(dir, "claude.json")}:/home/agent/.claude.json`)
    }
  }
  // Only auth.json: the host config.toml carries MCP servers the egress proxy would block.
  if (credentials.includes("codex")) copyInto(".codex", ["auth.json"])
  return { dir, mounts, env, rotating }
}

function writeBackRotatedTokens(rotating: RotatingFile[]): void {
  for (const file of rotating) {
    if (!existsSync(file.copy)) continue
    const current = readFileSync(file.copy, "utf8")
    const hostUnchanged = readFileSync(file.source, "utf8") === file.originalContent
    if (current !== file.originalContent && hostUnchanged) writeFileSync(file.source, current, { mode: 0o600 })
  }
}

// Files the agent writes are owned by uid 1000 on the host; the host user must be uid 1000 (opc on the VPS) to manage them.
export function createDockerExecutor(options: {
  hostDir: string
  image: string
  name: string
  limits: DockerLimits
  credentials: CredentialName[]
  // Host paths mounted read-only at the same path, e.g. the main repo's .git that a worktree's .git file points to.
  readOnlyPaths?: string[]
  // Joins this network and routes traffic through the proxy; absent = Docker's default network.
  network?: { name: string; proxyUrl: string }
}): Executor {
  const { dir: credentialsDir, mounts, env: credentialEnv, rotating } = copyCredentials(options.credentials)
  let execCount = 0

  return {
    kind: "docker",
    workdir: "/workspace",
    hostDir: options.hostDir,
    async exec(spec) {
      execCount += 1
      const containerName = `${options.name}-${execCount}`
      const envArgs = Object.entries(spec.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`])
      const args = [
        "run", "--rm", "-i",
        "--name", containerName,
        "--label", containerLabel,
        "--cpus", String(options.limits.cpus),
        "--memory", options.limits.memory,
        "--pids-limit", String(options.limits.pidsLimit),
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:exec",
        "--tmpfs", "/home/agent:uid=1000,gid=1000,exec",
        ...mounts,
        ...credentialEnv,
        ...(options.readOnlyPaths ?? []).flatMap((path) => ["-v", `${path}:${path}:ro`]),
        "-v", `${options.hostDir}:/workspace`,
        "-w", "/workspace",
        "--user", containerUser,
        ...envArgs,
        ...networkArgs(options.network),
        options.image,
        spec.command,
        ...spec.args,
      ]
      const result = await runProcess({ ...spec, env: undefined, command: "docker", args, cwd: options.hostDir })
      // Killing the docker client does not stop the container.
      if (result.timedOut || result.aborted) await docker(["kill", containerName]).catch(() => {})
      return result
    },
    async dispose() {
      const ids = (await docker(["ps", "-aq", "--filter", `label=${containerLabel}`, "--filter", `name=^${options.name}-`]).catch(() => ""))
        .split("\n")
        .filter(Boolean)
      if (ids.length) await docker(["rm", "-f", ...ids]).catch(() => {})
      writeBackRotatedTokens(rotating)
      rmSync(credentialsDir, { recursive: true, force: true })
    },
  }
}

function networkArgs(network: { name: string; proxyUrl: string } | undefined): string[] {
  if (!network) return []
  const proxyEnv = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].flatMap((key) => ["-e", `${key}=${network.proxyUrl}`])
  return ["--network", network.name, ...proxyEnv, "-e", "NO_PROXY=localhost,127.0.0.1", "-e", "no_proxy=localhost,127.0.0.1"]
}
