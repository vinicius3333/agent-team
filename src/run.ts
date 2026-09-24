import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { cleanupOrphans } from "./harness/docker.ts"
import { createGitHub } from "./github.ts"
import { createHarness, liveAgentPrefix } from "./harness/harness.ts"
import { removeAllWorkspaces } from "./harness/workspace.ts"
import { runPipeline, type RunOutcome } from "./pipeline.ts"
import type { Store } from "./store.ts"

// One pipeline run of a project, shared by `agent-team run` and the eval suite. The caller owns the store and the signal.
export async function runProject(projectDir: string, store: Store, signal: AbortSignal): Promise<RunOutcome> {
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  removeAllWorkspaces(projectDir)
  if (config.harness.isolation === "docker") await cleanupOrphans()
  const harness = createHarness({ config: config.harness, store, signal })
  const github = createGitHub({ projectDir, config, store })
  for (const { key } of store.metaWithPrefix(liveAgentPrefix)) store.deleteMeta(key)
  store.setMeta("run.pid", String(process.pid))
  const outcome = await runPipeline({ projectDir, config, store, harness, github, signal }).finally(() => store.setMeta("run.pid", ""))
  store.log("run", `finished: ${outcome}`)
  return outcome
}
