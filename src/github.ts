import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { PipelineConfig } from "./config.ts"
import { fastForward, type Workspace } from "./harness/workspace.ts"
import type { Change, Store } from "./store.ts"
import type { Task } from "./tasks.ts"

// Everything here runs on the host, never in a container, so GitHub credentials stay out of agent reach.
// Every GitHub step is best effort: a failure is logged and the run continues on the local repo.

export type ProjectStatus = "Todo" | "In Progress" | "Done"

interface GitHubContext {
  projectDir: string
  config: PipelineConfig
  store: Store
}

const labels: [name: string, color: string, description: string][] = [
  ["agent-team", "7c3aed", "Created by the agent-team orchestrator"],
  ["phase:foundation", "0ea5e9", "Foundation task, runs in sequence"],
  ["phase:feature", "22c55e", "Feature task"],
  ["planning", "a855f7", "Planning artifact"],
  ["blocked", "ef4444", "Needs a human"],
  ["change", "f59e0b", "Change request to a finished app"],
]

export function changeTitle(change: Pick<Change, "request">): string {
  return change.request.trim().split("\n")[0].slice(0, 100)
}

function run(command: string, args: string[], cwd: string, input?: string): string {
  return execFileSync(command, args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
}

function issueNumberFromUrl(url: string): number {
  const number = Number(url.trim().split("/").pop())
  if (!Number.isInteger(number)) throw new Error(`unexpected gh output: ${url}`)
  return number
}

export function createGitHub(context: GitHubContext) {
  const { projectDir, config, store } = context
  const settings = config.publish.github
  const enabled = settings.enabled

  function attempt<T>(what: string, action: () => T): T | null {
    try {
      return action()
    } catch (error) {
      const failure = error as { stderr?: string; message: string }
      store.log("github", `${what} failed: ${(failure.stderr || failure.message).trim().slice(0, 300)}`)
      return null
    }
  }

  function owner(): string {
    const cached = store.meta("github.owner")
    if (cached) return cached
    const login = settings.owner ?? run("gh", ["api", "user", "-q", ".login"], projectDir)
    store.setMeta("github.owner", login)
    return login
  }

  function repo(): string {
    return `${owner()}/${settings.name ?? basename(projectDir)}`
  }

  function hasOrigin(): boolean {
    try {
      run("git", ["remote", "get-url", "origin"], projectDir)
      return true
    } catch {
      return false
    }
  }

  function ensureRepository(): boolean {
    if (hasOrigin()) return true
    const created = attempt("create repository", () => {
      run("gh", ["repo", "create", repo(), `--${settings.visibility}`, "--source", projectDir, "--remote", "origin", "--push"], projectDir)
      for (const [name, color, description] of labels) {
        run("gh", ["label", "create", name, "--color", color, "--description", description, "--force", "-R", repo()], projectDir)
      }
      store.log("github", `created ${settings.visibility} repository https://github.com/${repo()}`)
      return true
    })
    return created === true
  }

  function ensureProject(): { number: string; id: string } | null {
    const number = store.meta("github.project.number")
    const id = store.meta("github.project.id")
    if (number && id) return { number, id }
    return attempt("create project board", () => {
      const project = JSON.parse(run("gh", ["project", "create", "--owner", owner(), "--title", basename(projectDir), "--format", "json"], projectDir))
      run("gh", ["project", "link", String(project.number), "--owner", owner(), "--repo", repo()], projectDir)
      const fields = JSON.parse(run("gh", ["project", "field-list", String(project.number), "--owner", owner(), "--format", "json"], projectDir))
      const status = fields.fields.find((field: { name: string }) => field.name === "Status")
      store.setMeta("github.project.number", String(project.number))
      store.setMeta("github.project.id", project.id)
      store.setMeta("github.project.statusField", status.id)
      for (const option of status.options) store.setMeta(`github.project.status.${option.name}`, option.id)
      store.log("github", `created project board ${project.url}`)
      return { number: String(project.number), id: project.id as string }
    })
  }

  function addToBoard(url: string, status: ProjectStatus): void {
    const project = ensureProject()
    if (!project) return
    attempt("add item to project board", () => {
      const item = JSON.parse(run("gh", ["project", "item-add", project.number, "--owner", owner(), "--url", url, "--format", "json"], projectDir))
      store.setMeta(`github.item.${url}`, item.id)
      setBoardStatus(url, status)
    })
  }

  function setBoardStatus(url: string, status: ProjectStatus): void {
    const project = ensureProject()
    const itemId = store.meta(`github.item.${url}`)
    const fieldId = store.meta("github.project.statusField")
    const optionId = store.meta(`github.project.status.${status}`)
    if (!project || !itemId || !fieldId || !optionId) return
    attempt(`set board status to ${status}`, () =>
      run("gh", ["project", "item-edit", "--id", itemId, "--project-id", project.id, "--field-id", fieldId, "--single-select-option-id", optionId], projectDir),
    )
  }

  function issueUrl(number: number): string {
    return `https://github.com/${repo()}/issues/${number}`
  }

  function createIssue(title: string, body: string, issueLabels: string[]): number | null {
    return attempt(`create issue "${title}"`, () =>
      issueNumberFromUrl(run("gh", ["issue", "create", "-R", repo(), "--title", title, "--body-file", "-", ...issueLabels.flatMap((label) => ["--label", label])], projectDir, body)),
    )
  }

  function comment(issue: number, body: string): void {
    attempt(`comment on #${issue}`, () => run("gh", ["issue", "comment", String(issue), "-R", repo(), "--body-file", "-"], projectDir, body))
  }

  function ensureEpic(): number | null {
    const cached = store.meta("github.epic")
    if (cached) return Number(cached)
    const brief = existsSync(join(projectDir, "input.md")) ? readFileSync(join(projectDir, "input.md"), "utf8") : ""
    const body = [
      "## Brief",
      "",
      brief.trim(),
      "",
      "## Process",
      "",
      "The agent-team orchestrator builds this project. Each planning phase and each task lands through a pull request.",
      "Task issues are listed below as the plan is written.",
    ].join("\n")
    const number = createIssue(`Build ${basename(projectDir)}`, body, ["agent-team"])
    if (number === null) return null
    store.setMeta("github.epic", String(number))
    addToBoard(issueUrl(number), "In Progress")
    return number
  }

  function changeIssue(id: string): number | null {
    const cached = store.meta(`github.change.${id}`)
    return cached ? Number(cached) : null
  }

  function taskBody(task: Task, epic: number | null): string {
    const dependencies = task.dependsOn.map((id) => {
      const issue = store.taskIssue(id)
      return issue ? `#${issue} (${id})` : id
    })
    return [
      epic ? `Part of #${epic}.` : "",
      "",
      "## Acceptance criteria",
      "",
      ...task.acceptance.map((criterion) => `- [ ] ${criterion}`),
      "",
      "## Scope",
      "",
      `- Allowed paths: ${task.allowedPaths.map((path) => `\`${path}\``).join(", ")}`,
      `- Reads: ${task.readPaths.map((path) => `\`${path}\``).join(", ") || "none"}`,
      `- Verify: \`${task.verify}\``,
      `- Depends on: ${dependencies.join(", ") || "nothing"}`,
      task.story ? `- Story: ${task.story}` : "",
    ]
      .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
      .join("\n")
  }

  // Pushes the rebased branch, opens a pull request into base, merges it on GitHub, and brings the local base up to date.
  function mergeThroughPullRequest(branch: string, base: string, title: string, body: string): string | null {
    return attempt(`pull request "${title}"`, () => {
      run("git", ["push", "-q", "-f", "origin", `${branch}:${branch}`], projectDir)
      if (base !== "main") run("git", ["push", "-q", "origin", `${base}:${base}`], projectDir)
      const url = run("gh", ["pr", "create", "-R", repo(), "--base", base, "--head", branch, "--title", title, "--body-file", "-"], projectDir, body)
      run("gh", ["pr", "merge", url, "-R", repo(), "--merge"], projectDir)
      run("git", ["push", "-q", "origin", "--delete", branch], projectDir)
      run("git", ["fetch", "-q", "origin", base], projectDir)
      fastForward(projectDir, `origin/${base}`, base)
      store.log("github", `merged ${url}`)
      return url
    })
  }

  return {
    enabled,

    // Merges a finished workspace into its base branch: through a pull request when GitHub is on, locally otherwise.
    land(options: { workspace: Workspace; title: string; body: string }): void {
      const { branch, base } = options.workspace
      if (enabled && ensureRepository() && mergeThroughPullRequest(branch, base, options.title, options.body)) return
      fastForward(projectDir, branch, base)
      if (enabled && hasOrigin()) attempt(`push ${base}`, () => run("git", ["push", "-q", "origin", base], projectDir))
    },

    syncTaskIssues(tasks: Task[]): void {
      if (!enabled || !ensureRepository()) return
      const change = store.currentChange()
      const epic = change ? changeIssue(change.id) : ensureEpic()
      const created: string[] = []
      for (const task of tasks) {
        if (store.taskIssue(task.id)) continue
        const number = createIssue(`${task.id}: ${task.title}`, taskBody(task, epic), ["agent-team", `phase:${task.phase}`])
        if (number === null) continue
        store.setTaskIssue(task.id, number)
        addToBoard(issueUrl(number), "Todo")
        created.push(`- [ ] #${number} ${task.id}: ${task.title}`)
      }
      if (epic && created.length) comment(epic, ["## Plan", "", ...created].join("\n"))
    },

    taskStarted(task: Task, attempt: number): void {
      const issue = store.taskIssue(task.id)
      if (!enabled || !issue) return
      if (attempt === 1) setBoardStatus(issueUrl(issue), "In Progress")
      else comment(issue, `Starting attempt ${attempt}.`)
    },

    attemptFailed(task: Task, attempt: number, reason: string): void {
      const issue = store.taskIssue(task.id)
      if (!enabled || !issue) return
      comment(issue, [`### Attempt ${attempt} failed`, "", "```", reason.slice(0, 6000), "```"].join("\n"))
    },

    taskBlocked(task: Task, reason: string): void {
      const issue = store.taskIssue(task.id)
      if (!enabled || !issue) return
      attempt(`label #${issue} blocked`, () => run("gh", ["issue", "edit", String(issue), "-R", repo(), "--add-label", "blocked"], projectDir))
      comment(issue, [`### Blocked`, "", "The orchestrator stopped on this task and needs a human.", "", "```", reason.slice(0, 6000), "```"].join("\n"))
    },

    taskMerged(task: Task): void {
      const issue = store.taskIssue(task.id)
      if (!enabled || !issue) return
      setBoardStatus(issueUrl(issue), "Done")
    },

    runCompleted(deployUrl: string | null): void {
      if (enabled && deployUrl) attempt("set repository homepage", () => run("gh", ["repo", "edit", repo(), "--homepage", deployUrl], projectDir))
      const epic = store.meta("github.epic")
      if (!enabled || !epic || store.meta("github.epic.closed")) return
      store.setMeta("github.epic.closed", "1")
      comment(Number(epic), ["All tasks are merged. The build is complete.", deployUrl ? `\nLive preview: ${deployUrl}` : ""].join(""))
      setBoardStatus(issueUrl(Number(epic)), "Done")
      attempt("close epic", () => run("gh", ["issue", "close", epic, "-R", repo()], projectDir))
    },

    // Pushes the change branch and opens the change's issue, which task issues link instead of the build epic.
    changeOpened(change: Change): void {
      if (!enabled || !ensureRepository()) return
      attempt(`push ${change.branch}`, () => run("git", ["push", "-q", "origin", `${change.branch}:${change.branch}`], projectDir))
      attempt("create the change label", () => run("gh", ["label", "create", "change", "--color", "f59e0b", "--description", "Change request to a finished app", "--force", "-R", repo()], projectDir))
      const body = ["## Request", "", change.request.trim(), "", `Built on the branch \`${change.branch}\` and merged into main once QA passes.`].join("\n")
      const number = createIssue(`Change ${change.id}: ${changeTitle(change)}`, body, ["agent-team", "change"])
      if (number === null) return
      store.setMeta(`github.change.${change.id}`, String(number))
      addToBoard(issueUrl(number), "In Progress")
    },

    // Opens the one pull request from the change branch into main and merges it with a merge commit.
    // Returns its URL, or null when GitHub is off or a step failed, so the caller merges locally.
    mergeChange(change: Change, body: string): string | null {
      if (!enabled || !ensureRepository()) return null
      return attempt(`merge ${change.branch}`, () => {
        run("git", ["push", "-q", "origin", `${change.branch}:${change.branch}`], projectDir)
        const url = run("gh", ["pr", "create", "-R", repo(), "--base", "main", "--head", change.branch, "--title", `feat: ${changeTitle(change)}`, "--body-file", "-"], projectDir, body)
        store.setChangePullRequest(change.id, url)
        run("gh", ["pr", "merge", url, "-R", repo(), "--merge"], projectDir)
        run("git", ["fetch", "-q", "origin", "main"], projectDir)
        fastForward(projectDir, "origin/main")
        store.log("github", `merged ${url}`)
        return url
      })
    },

    changeFinished(change: Change, summary: string): void {
      const issue = changeIssue(change.id)
      if (!enabled || !issue) return
      comment(issue, summary)
      setBoardStatus(issueUrl(issue), "Done")
      attempt(`close #${issue}`, () => run("gh", ["issue", "close", String(issue), "-R", repo()], projectDir))
    },

    // Closes the change's open pull requests, including the one into main, and its issue.
    changeAbandoned(change: Change): void {
      if (!enabled || !hasOrigin()) return
      const open = attempt("list change pull requests", () => JSON.parse(run("gh", ["pr", "list", "-R", repo(), "--base", change.branch, "--state", "open", "--json", "url"], projectDir)) as { url: string }[]) ?? []
      const intoMain = attempt("find the change pull request", () => JSON.parse(run("gh", ["pr", "list", "-R", repo(), "--head", change.branch, "--state", "open", "--json", "url"], projectDir)) as { url: string }[]) ?? []
      for (const { url } of [...open, ...intoMain]) attempt(`close ${url}`, () => run("gh", ["pr", "close", url, "-R", repo()], projectDir))
      const issue = changeIssue(change.id)
      if (issue) {
        comment(issue, "The change was abandoned from the dashboard.")
        attempt(`close #${issue}`, () => run("gh", ["issue", "close", String(issue), "-R", repo(), "--reason", "not planned"], projectDir))
      }
    },

    taskIssue(task: Task): number | null {
      return store.taskIssue(task.id)
    },
  }
}

export type GitHub = ReturnType<typeof createGitHub>

