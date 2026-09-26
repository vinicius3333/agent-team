import { execFileSync } from "node:child_process"
import { basename, join } from "node:path"
import { loadConfig, type PipelineConfig } from "../config.ts"
import { parseGitHubRepository } from "../import.ts"
import { listProjects, withProjectStore } from "../project.ts"
import { backlogTitleMaxLength } from "../sprint.ts"
import type { Store } from "../store.ts"

// Open GitHub issues labeled agent-team become open backlog items, never change requests: a person approves them.
// The doctor polls with the gh CLI; the fingerprint keeps a second poll from adding the same issue twice.

export const issueLabel = "agent-team"
export const issueProposalMaxLength = 8000
export const issuesPolledAtKey = "github.issues.polledAt"

export type Gh = (args: string[]) => string

interface GitHubIssue {
  number: number
  title: string
  body: string
  url: string
}

export function issueFingerprint(repo: string, number: number): string {
  return `github-issue:${repo}#${number}`
}

export function issueCommentedKey(number: number): string {
  return `github.issue.${number}.commented`
}

function realGh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 })
}

function originRepo(projectDir: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const parsed = parseGitHubRepository(url)
    return parsed ? `${parsed.owner}/${parsed.name}` : null
  } catch {
    return null
  }
}

// owner/name from the github.repo meta, else from an origin remote on github.com.
export function projectRepo(projectDir: string, store: Store): string | null {
  const stored = store.meta("github.repo")?.trim()
  return stored || originRepo(projectDir)
}

export function issueComment(project: string, id: number, appUrl: string | null | undefined): string {
  const base = (appUrl ?? "").trim().replace(/\/+$/, "")
  const lead = `agent-team added this issue to the backlog of ${project} as item #${id}`
  return base ? `${lead}: ${base}/projects/${project}/operate/next-steps#finding-${id}` : `${lead}.`
}

function parseIssues(text: string): GitHubIssue[] {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error("gh issue list did not return a list.")
  return parsed
    .filter((issue) => Number.isInteger(issue?.number) && issue.number > 0)
    .map((issue) => ({ number: issue.number, title: String(issue.title ?? ""), body: String(issue.body ?? ""), url: String(issue.url ?? "") }))
}

function errorLine(error: unknown): string {
  const failure = error as { stderr?: string; message?: string }
  return String(failure.stderr || failure.message || error).trim().split("\n")[0].slice(0, 300)
}

export interface SyncIssuesOptions {
  projectDir: string
  store: Store
  config: PipelineConfig
  gh?: Gh
  appUrl?: string | null
  now?: number
}

// Returns null when the project is skipped or gh fails; otherwise the counts it logged.
export function syncIssues(options: SyncIssuesOptions): { added: number; commented: number } | null {
  const { projectDir, store, config } = options
  const gh = options.gh ?? realGh
  const project = basename(projectDir)
  const github = config.publish.github
  if (!github.enabled || !github.issues.enabled) return null
  const repo = projectRepo(projectDir, store)
  if (!repo) return null
  let added = 0
  let commented = 0
  try {
    const issues = parseIssues(gh(["issue", "list", "--repo", repo, "--label", issueLabel, "--state", "open", "--json", "number,title,body,url", "--limit", "100"]))
    for (const issue of issues) {
      const fingerprint = issueFingerprint(repo, issue.number)
      let finding = store.findingByFingerprint(fingerprint)
      if (!finding) {
        const title = issue.title.trim().slice(0, backlogTitleMaxLength) || `GitHub issue #${issue.number}`
        const { id } = store.addFinding({ source: "github", severity: "medium", title, evidence: issue.url, proposal: issue.body.slice(0, issueProposalMaxLength) || title, fingerprint })
        store.log("operate", `added GitHub issue #${issue.number} to the backlog as item ${id}`)
        finding = store.finding(id)!
        added++
      }
      // The meta is set only after the comment posts, so a crash in between comments on the next poll instead.
      if (store.meta(issueCommentedKey(issue.number))) continue
      gh(["issue", "comment", String(issue.number), "--repo", repo, "--body", issueComment(project, finding.id, options.appUrl)])
      store.setMeta(issueCommentedKey(issue.number), new Date(options.now ?? Date.now()).toISOString())
      commented++
    }
  } catch (error) {
    console.error(`[issues] ${project}: gh failed, retrying at the next poll: ${errorLine(error)}`)
    return null
  }
  console.log(`[issues] ${project}: added ${added}, commented ${commented}`)
  return { added, commented }
}

export interface IssuesTickOptions {
  runsDir: string
  now?: number
  gh?: Gh
  appUrl?: string | null
}

// Polls each project whose last poll is older than publish.github.issues.everyMinutes.
export function issuesTick(options: IssuesTickOptions): void {
  const now = options.now ?? Date.now()
  const appUrl = options.appUrl === undefined ? process.env.APP_URL : options.appUrl
  for (const name of listProjects(options.runsDir)) {
    const projectDir = join(options.runsDir, name)
    try {
      const config = loadConfig(join(projectDir, "pipeline.yaml"))
      const github = config.publish.github
      if (!github.enabled || !github.issues.enabled) continue
      withProjectStore(projectDir, (store) => {
        const polledAt = Date.parse(store.meta(issuesPolledAtKey) ?? "")
        if (Number.isFinite(polledAt) && now - polledAt < github.issues.everyMinutes * 60_000) return
        store.setMeta(issuesPolledAtKey, new Date(now).toISOString())
        syncIssues({ projectDir, store, config, gh: options.gh, appUrl, now })
      })
    } catch (error) {
      console.error(`[issues] ${name}: ${errorLine(error)}`)
    }
  }
}
