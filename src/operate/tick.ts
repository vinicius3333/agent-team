import { join } from "node:path"
import { loadConfig, type InsightAgent } from "../config.ts"
import { listProjects, openProjectStore } from "../project.ts"
import { dueRoutines, markRoutineBaselines, runRoutine } from "../routines.ts"
import { dueAgents, runInsightAgent } from "./agents.ts"
import { probe, probeProject } from "./health.ts"

export interface OperateTickOptions {
  runsDir: string
  now?: number
  probe?: typeof probe
  runAgent?: (projectDir: string, agent: InsightAgent) => Promise<unknown>
  runRoutine?: (projectDir: string, id: string) => Promise<unknown>
}

// Projects whose agents are running in this process; their queue finishes before the next one starts.
const busyProjects = new Set<string>()

// Probes every live project and starts its due agents and routines in the background, one at a time per project,
// so a 10-minute agent call does not hold up the doctor's incident checks.
export async function operateTick(options: OperateTickOptions): Promise<void> {
  const runAgent = options.runAgent ?? ((projectDir: string, agent: InsightAgent) => runInsightAgent({ projectDir, agent }))
  const runCustom = options.runRoutine ?? ((projectDir: string, id: string) => runRoutine({ projectDir, id }))
  for (const name of listProjects(options.runsDir)) {
    const projectDir = join(options.runsDir, name)
    try {
      const config = loadConfig(join(projectDir, "pipeline.yaml"))
      const store = openProjectStore(projectDir)
      const due: (() => Promise<unknown>)[] = []
      try {
        if (config.operate.enabled) {
          await probeProject(store, config.operate.healthPath, { now: options.now, probe: options.probe })
          for (const agent of dueAgents(store, config, options.now)) due.push(() => runAgent(projectDir, agent))
        }
        markRoutineBaselines(store, config, options.now)
        for (const routine of dueRoutines(store, config, options.now)) due.push(() => runCustom(projectDir, routine.id))
      } finally {
        store.close()
      }
      if (!due.length || busyProjects.has(projectDir)) continue
      busyProjects.add(projectDir)
      void (async () => {
        for (const run of due) {
          try {
            await run()
          } catch (error) {
            console.error(`[operate] ${name}: ${(error as Error).message}`)
          }
        }
      })().finally(() => busyProjects.delete(projectDir))
    } catch (error) {
      console.error(`[operate] ${name}: ${(error as Error).message}`)
    }
  }
}
