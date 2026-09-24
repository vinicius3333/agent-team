import { runProcess, type ProcessResult, type ProcessSpec } from "../runners/spawn.ts"

// Where an agent process runs. `workdir` is the path the agent sees, which differs from the host path inside a container.
export interface Executor {
  readonly kind: "host" | "docker"
  readonly workdir: string
  // The same folder as seen from the orchestrator, used to show which files the agent changed.
  readonly hostDir: string
  exec(spec: Omit<ProcessSpec, "cwd">): Promise<ProcessResult>
  dispose(): Promise<void>
}

export function hostExecutor(hostDir: string): Executor {
  return {
    kind: "host",
    workdir: hostDir,
    hostDir,
    exec: (spec) => runProcess({ ...spec, cwd: hostDir }),
    dispose: async () => {},
  }
}
