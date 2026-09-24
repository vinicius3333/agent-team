import { execFileSync } from "node:child_process"
import { basename } from "node:path"
import type { PipelineConfig } from "./config.ts"
import type { Store } from "./store.ts"

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function hasOrigin(projectDir: string): boolean {
  try {
    run("git", ["remote", "get-url", "origin"], projectDir)
    return true
  } catch {
    return false
  }
}

// Runs on the host, never in a container, so GitHub credentials stay out of agent reach.
// A publish failure is logged and never fails the run: the code is safe in the local repo.
export function publishProject(context: { projectDir: string; config: PipelineConfig; store: Store }): void {
  const { projectDir, config, store } = context
  const github = config.publish.github
  if (!github.enabled) return
  try {
    if (hasOrigin(projectDir)) {
      run("git", ["push", "-q", "origin", "main"], projectDir)
      return
    }
    const name = github.name ?? basename(projectDir)
    const fullName = github.owner ? `${github.owner}/${name}` : name
    run("gh", ["repo", "create", fullName, `--${github.visibility}`, "--source", projectDir, "--remote", "origin", "--push"], projectDir)
    store.log("publish", `created ${github.visibility} GitHub repo ${run("gh", ["repo", "view", "--json", "url", "-q", ".url"], projectDir)}`)
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    store.log("publish", `GitHub publish failed: ${(failure.stderr || failure.message).trim().slice(0, 300)}`)
  }
}
