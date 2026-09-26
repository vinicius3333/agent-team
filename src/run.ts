import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { cleanupOrphans } from "./harness/docker.ts"
import { judgeDesign, type DesignJudgeResult } from "./design-judge.ts"
import { createGitHub } from "./github.ts"
import { createHarness, liveAgentPrefix } from "./harness/harness.ts"
import { removeAllWorkspaces } from "./harness/workspace.ts"
import { startSprint } from "./improve.ts"
import { runPipeline, type PipelineContext, type RunOutcome } from "./pipeline.ts"
import { syncSprint } from "./sprint.ts"
import type { Store } from "./store.ts"

type Prepare = (context: PipelineContext) => Promise<RunOutcome | null>

// One pipeline run of a project, shared by `agent-team run` and the eval suite. The caller owns the store and the signal.
// prepare runs first, with the run recorded; an outcome from it ends the run without the pipeline.
export async function runProject(projectDir: string, store: Store, signal: AbortSignal, prepare?: Prepare): Promise<RunOutcome> {
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  removeAllWorkspaces(projectDir)
  if (config.harness.isolation === "docker") await cleanupOrphans()
  const harness = createHarness({ config: config.harness, store, signal })
  const github = createGitHub({ projectDir, config, store })
  for (const { key } of store.metaWithPrefix(liveAgentPrefix)) store.deleteMeta(key)
  store.setMeta("run.pid", String(process.pid))
  const context: PipelineContext = { projectDir, config, store, harness, github, signal }
  const outcome = await (async () => (await prepare?.(context)) ?? runPipeline(context))().finally(() => store.setMeta("run.pid", ""))
  store.log("run", `finished: ${outcome}`)
  return outcome
}

// Plans a sprint and opens its change, then runs the pipeline that builds it. early skips the wait for the due time.
export async function runSprint(projectDir: string, store: Store, signal: AbortSignal, options: { early: boolean }): Promise<RunOutcome> {
  const outcome = await runProject(projectDir, store, signal, (context) => startSprint(context, options))
  syncSprint(store)
  return outcome
}

// Scores the design of a finished project for the eval suite, outside a pipeline run.
export async function judgeProjectDesign(projectDir: string, store: Store, signal: AbortSignal): Promise<DesignJudgeResult> {
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  const harness = createHarness({ config: config.harness, store, signal })
  const github = createGitHub({ projectDir, config, store })
  return judgeDesign({ projectDir, config, store, harness, github, signal })
}
