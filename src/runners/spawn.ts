import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export interface ProcessSpec {
  command: string
  args: string[]
  cwd: string
  input: string
  timeoutMs: number
  transcriptPath: string
  env?: Record<string, string>
  signal?: AbortSignal
}

const killGraceMs = 10_000

export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let aborted = false

    const stop = () => {
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, spec.timeoutMs)
    const onAbort = () => {
      aborted = true
      stop()
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))

    const finish = (exitCode: number | null, spawnError?: Error) => {
      clearTimeout(timer)
      spec.signal?.removeEventListener("abort", onAbort)
      if (spawnError) stderr += `\n${spawnError.message}`
      mkdirSync(dirname(spec.transcriptPath), { recursive: true })
      writeFileSync(spec.transcriptPath, `${stdout}\n--- stderr ---\n${stderr}`)
      resolve({ exitCode, stdout, stderr, timedOut, aborted, durationMs: Date.now() - startedAt })
    }
    child.on("error", (error) => finish(null, error))
    child.on("close", (code) => finish(code))

    child.stdin.on("error", () => {})
    child.stdin.end(spec.input)
  })
}

