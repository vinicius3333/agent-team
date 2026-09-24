import type { RunnerName } from "../config.ts"
import { claudeRunner } from "./claude.ts"
import { codexRunner } from "./codex.ts"
import type { AgentRunner } from "./types.ts"

const runners: Record<RunnerName, AgentRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
}

export function getRunner(name: RunnerName): AgentRunner {
  return runners[name]
}

export type { AgentRunner, RunRequest, RunResult } from "./types.ts"
