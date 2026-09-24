import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Candidate, PipelineConfig, PlanningPhase, Role } from "./config.ts"
import { changedFiles, stagedDiff } from "./git.ts"
import { createDockerExecutor, ensureImage } from "./harness/docker.ts"
import { hostExecutor, type Executor } from "./harness/executor.ts"
import { defaultAllowlist, ensureEgressProxy } from "./harness/network.ts"
import type { Harness, HarnessOutcome } from "./harness/harness.ts"
import { commitAndRebase, createWorkspace, detectSetupCommand, fastForwardMain, removeWorkspace } from "./harness/workspace.ts"
import { deployProject } from "./deploy.ts"
import type { GitHub } from "./github.ts"
import type { Store } from "./store.ts"
import { filesOutsideScope, loadTasks, type Task } from "./tasks.ts"

const phaseAttempts = 2
const deployAttempts = 3
const commandTimeoutMs = 10 * 60 * 1000
const planningTools = ["read", "edit", "write", "bash:mkdir", "bash:ls"]
const reviewerTools = ["read"]
// Workers start their final message with this when the task cannot be done within its scope.
const blockedPrefix = "BLOCKED:"

interface PhaseDefinition {
  role: Role
  inputs: string[]
  outputs: string[]
  validate: (projectDir: string) => void
}

const phaseDefinitions: Record<PlanningPhase, PhaseDefinition> = {
  spec: {
    role: "pm",
    inputs: ["input.md"],
    outputs: ["docs/spec.md"],
    validate: (dir) =>
      requireHeadings(join(dir, "docs/spec.md"), ["## Problem", "## Users", "## User stories", "## Out of scope", "## Open questions"]),
  },
  architecture: {
    role: "architect",
    inputs: ["input.md", "docs/spec.md"],
    outputs: ["docs/architecture.md", "docs/adr/", "contracts/openapi.yaml (if the app has an API)"],
    validate: (dir) => requireHeadings(join(dir, "docs/architecture.md"), ["## Commands"]),
  },
  mockups: {
    role: "illustrator",
    inputs: ["input.md", "docs/spec.md", "docs/architecture.md"],
    outputs: ["design/mockups/*.png", "design/mockups/README.md"],
    validate: (dir) => {
      const mockupDir = join(dir, "design/mockups")
      const images = existsSync(mockupDir) ? readdirSync(mockupDir).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)) : []
      if (images.length === 0) throw new Error("no mockup images in design/mockups/")
    },
  },
  design: {
    role: "designer",
    inputs: ["docs/spec.md", "docs/architecture.md", "contracts/", "design/mockups/ (UI mockup images: open and study them, use them as visual reference)"],
    outputs: ["docs/design.md", "design/tokens.css"],
    validate: (dir) => {
      requireFile(join(dir, "docs/design.md"))
      const tokens = readFileSync(requireFile(join(dir, "design/tokens.css")), "utf8")
      if (!tokens.includes("--primary:")) throw new Error("design/tokens.css has no --primary variable")
    },
  },
  plan: {
    role: "planner",
    inputs: ["docs/spec.md", "docs/architecture.md", "docs/design.md", "contracts/"],
    outputs: ["tasks.json"],
    validate: (dir) => void loadTasks(join(dir, "tasks.json")),
  },
}

// "paused" = stopped for a reason outside the agents' work (operator abort, no runner available); rerun to resume.
export type RunOutcome = "completed" | "awaiting_approval" | "paused" | "failed"

export interface PipelineContext {
  projectDir: string
  config: PipelineConfig
  store: Store
  harness: Harness
  github: GitHub
  signal: AbortSignal
}

type AttemptResult = { kind: "passed" } | { kind: "failed"; reason: string } | { kind: "blocked"; reason: string } | { kind: "infrastructure"; reason: string }

export async function runPipeline(context: PipelineContext): Promise<RunOutcome> {
  for (const phase of Object.keys(phaseDefinitions) as PlanningPhase[]) {
    const outcome = await runPlanningPhase(context, phase)
    if (outcome !== "completed") return outcome
  }
  return runTasks(context)
}

async function runPlanningPhase(context: PipelineContext, phase: PlanningPhase): Promise<RunOutcome> {
  const { projectDir, config, store } = context
  const status = store.phaseStatus(phase)
  if (status === "approved") return "completed"
  if (status === "awaiting_approval") {
    store.log("gate", `phase "${phase}" is waiting for approval: agent-team approve ${projectDir} ${phase}`)
    return "awaiting_approval"
  }
  const skipReason =
    (phase === "design" || phase === "mockups") && config.target === "api"
      ? "api-only target"
      : phase === "mockups" && !config.mockups.enabled
        ? "mockups disabled in pipeline.yaml"
        : null
  if (skipReason) {
    store.setPhase(phase, "approved")
    store.log("phase", `${phase} skipped: ${skipReason}`)
    return "completed"
  }

  const definition = phaseDefinitions[phase]
  store.setPhase(phase, "running")
  let previousError: string | null = null
  for (let attempt = 1; attempt <= phaseAttempts; attempt++) {
    store.log("phase", `${phase}: attempt ${attempt} with ${definition.role}`)
    const result = await attemptPhase(context, phase, definition, attempt, previousError)
    if (result.kind === "infrastructure") {
      store.setPhase(phase, "pending")
      store.log("phase", `${phase}: paused: ${result.reason.slice(0, 300)}`)
      return "paused"
    }
    if (result.kind === "failed" || result.kind === "blocked") {
      previousError = result.reason
      store.log("phase", `${phase}: output rejected: ${previousError}`)
      continue
    }
    if (config.autonomy.gates.includes(phase)) {
      store.setPhase(phase, "awaiting_approval")
      store.log("gate", `phase "${phase}" is ready for review: agent-team approve ${projectDir} ${phase}`)
      return "awaiting_approval"
    }
    store.setPhase(phase, "approved")
    return "completed"
  }
  store.setPhase(phase, "failed")
  return "failed"
}

// Planning agents also work in a throwaway worktree, so they never see the orchestrator state or write to main's .git.
async function attemptPhase(context: PipelineContext, phase: PlanningPhase, definition: PhaseDefinition, attempt: number, previousError: string | null): Promise<AttemptResult> {
  const { projectDir } = context
  const workspace = createWorkspace(projectDir, `phase-${phase}-${attempt}`)
  const executor = await createExecutor(context, workspace.path, `phase-${phase}-${attempt}`)
  try {
    const outcome = await runAgent(context, executor, definition.role, `phase-${phase}-${attempt}`, planningTools, phasePrompt(context, definition, previousError))
    if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `${outcome.failureClass}: ${outcome.result.summary}` }
    if (outcome.result.status !== "done") return { kind: "failed", reason: `agent ${outcome.result.status}: ${outcome.result.summary}` }
    try {
      definition.validate(workspace.path)
    } catch (error) {
      return { kind: "failed", reason: (error as Error).message }
    }
    const title = `docs(${phase}): add ${phase} artifacts`
    commitAndRebase(workspace, title)
    context.github.land({
      branch: workspace.branch,
      title,
      body: `Planning phase **${phase}**, written by the ${definition.role} agent (attempt ${attempt}).\n\nOutputs: ${definition.outputs.join(", ")}.`,
      localMerge: () => fastForwardMain(projectDir, workspace.branch),
    })
    return { kind: "passed" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

function phasePrompt(context: PipelineContext, definition: PhaseDefinition, previousError: string | null): string {
  const { config } = context
  const lines = [
    `Project target: ${config.target}.`,
    `Read these inputs: ${definition.inputs.join(", ")}.`,
    `Write these outputs: ${definition.outputs.join(", ")}.`,
  ]
  if (definition.role === "illustrator") lines.push(`Generate ${config.mockups.count} mockup images.`)
  if (config.stackHints.prefer.length) lines.push(`Preferred technologies: ${config.stackHints.prefer.join(", ")}.`)
  if (config.stackHints.avoid.length) lines.push(`Avoid: ${config.stackHints.avoid.join(", ")}.`)
  if (previousError) lines.push(`Your previous output was rejected. Fix this: ${previousError}`)
  return lines.join("\n")
}

async function runTasks(context: PipelineContext): Promise<RunOutcome> {
  const { projectDir, store } = context
  const tasks = loadTasks(join(projectDir, "tasks.json"))
  store.syncTasks(tasks.map((task) => task.id))
  context.github.syncTaskIssues(tasks)
  for (const task of tasks) {
    const row = store.task(task.id)
    if (row.status === "merged") continue
    if (row.status === "blocked") {
      store.log("task", `${task.id} is blocked: ${row.lastFailure}. Fix it, then: agent-team retry ${projectDir} ${task.id}`)
      return "failed"
    }
    const outcome = await runTask(context, task)
    if (outcome !== "completed") return outcome
  }
  store.log("run", "all tasks merged")
  const deploy = await runDeployPhase(context)
  if (deploy.outcome !== "completed") return deploy.outcome
  context.github.runCompleted(deploy.url)
  return "completed"
}

async function runTask(context: PipelineContext, task: Task): Promise<RunOutcome> {
  const { config, store } = context
  const maxRetries = config.roles.worker.maxRetries ?? 3
  while (store.task(task.id).attempts < maxRetries) {
    const { attempts, lastFailure } = store.task(task.id)
    const attempt = attempts + 1
    store.updateTask(task.id, "running", lastFailure)
    store.log("task", `${task.id} "${task.title}": attempt ${attempt}/${maxRetries}`)
    context.github.taskStarted(task, attempt)

    const result = await attemptTask(context, task, attempt, lastFailure)
    switch (result.kind) {
      case "passed":
        store.countAttempt(task.id)
        store.updateTask(task.id, "merged")
        store.log("task", `${task.id} merged`)
        context.github.taskMerged(task)
        return "completed"
      case "infrastructure":
        store.updateTask(task.id, "pending", lastFailure)
        store.log("task", `${task.id} paused, attempt not counted: ${result.reason.slice(0, 300)}`)
        return "paused"
      case "blocked":
        store.countAttempt(task.id)
        store.updateTask(task.id, "blocked", result.reason)
        store.log("task", `${task.id} blocked by worker: ${result.reason.slice(0, 300)}`)
        context.github.taskBlocked(task, result.reason)
        return "failed"
      case "failed":
        store.countAttempt(task.id)
        store.updateTask(task.id, "pending", result.reason)
        store.log("task", `${task.id} failed: ${result.reason.slice(0, 500)}`)
        context.github.attemptFailed(task, attempt, result.reason)
    }
  }
  store.updateTask(task.id, "blocked", store.task(task.id).lastFailure)
  store.log("task", `${task.id} blocked after ${maxRetries} attempts`)
  context.github.taskBlocked(task, store.task(task.id).lastFailure ?? "max attempts reached")
  return "failed"
}

async function attemptTask(context: PipelineContext, task: Task, attempt: number, lastFailure: string | null): Promise<AttemptResult> {
  const { projectDir, store } = context
  const workspace = createWorkspace(projectDir, `${task.id}-${attempt}`)
  const executor = await createExecutor(context, workspace.path, `${task.id}-${attempt}`)
  try {
    const setupCommand = detectSetupCommand(workspace.path)
    if (setupCommand) {
      const setup = await runCommand(context, executor, setupCommand, `${task.id}-${attempt}-setup`)
      if (!setup.passed) return { kind: "infrastructure", reason: `workspace setup failed (${setupCommand}):\n${setup.output}` }
    }

    const worker = await runAgent(context, executor, "worker", `${task.id}-worker-${attempt}`, workerTools(task), workerPrompt(task, lastFailure))
    if (isInfrastructureFailure(worker)) return { kind: "infrastructure", reason: `worker ${worker.failureClass}: ${worker.result.summary}` }
    if (worker.result.status !== "done") return { kind: "failed", reason: `worker ${worker.result.status}: ${worker.result.summary}` }
    const summary = worker.result.summary.trimStart()
    if (summary.startsWith(blockedPrefix)) return { kind: "blocked", reason: summary }

    const outside = filesOutsideScope(changedFiles(workspace.path), task.allowedPaths)
    if (outside.length) return { kind: "failed", reason: `edited files outside allowedPaths: ${outside.join(", ")}` }

    const verification = await runCommand(context, executor, task.verify, `${task.id}-${attempt}-verify`)
    if (!verification.passed) return { kind: "failed", reason: `verify command failed:\n${verification.output}` }

    const reviewPromptText = reviewPrompt(task, stagedDiff(workspace.path), verification.output)
    const review = await runAgent(context, executor, "reviewer", `${task.id}-review-${attempt}`, reviewerTools, reviewPromptText)
    if (isInfrastructureFailure(review)) return { kind: "infrastructure", reason: `reviewer ${review.failureClass}: ${review.result.summary}` }
    if (review.result.status !== "done") return { kind: "failed", reason: `reviewer ${review.result.status}: ${review.result.summary}` }
    const verdict = parseVerdict(review.result.summary)
    if (verdict.verdict !== "pass") {
      return { kind: "failed", reason: `reviewer rejected the change.\nReasons: ${verdict.reasons.join("; ")}\nFixes: ${verdict.fixes.join("; ")}` }
    }

    const title = `feat(${task.id}): ${task.title}`
    try {
      commitAndRebase(workspace, title)
      context.github.land({
        branch: workspace.branch,
        title,
        body: pullRequestBody(context, task, attempt, verdict),
        localMerge: () => fastForwardMain(projectDir, workspace.branch),
      })
    } catch (error) {
      return { kind: "failed", reason: `merge failed: ${(error as Error).message}` }
    }
    return { kind: "passed" }
  } catch (error) {
    store.log("harness", `${task.id} attempt ${attempt} crashed: ${(error as Error).message}`)
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

// Deploy is the last phase. When the app does not come up, a worker agent gets the failure and fixes
// the start setup (deploy.json, start script), the fix lands through the normal merge path, and deploy retries.
async function runDeployPhase(context: PipelineContext): Promise<{ outcome: RunOutcome; url: string | null }> {
  const { projectDir, config, store } = context
  if (!config.deploy.enabled) {
    store.setPhase("deploy", "approved")
    return { outcome: "completed", url: null }
  }
  if (store.phaseStatus("deploy") === "approved" && store.meta("deploy.url")) return { outcome: "completed", url: store.meta("deploy.url") }
  store.setPhase("deploy", "running")
  let failure: string | null = null
  for (let attempt = 1; attempt <= deployAttempts; attempt++) {
    if (failure) {
      store.log("deploy", `attempt ${attempt}: asking the worker to fix the deploy`)
      const fix = await attemptDeployFix(context, attempt, failure)
      if (fix.kind === "infrastructure") {
        store.setPhase("deploy", "pending")
        store.log("deploy", `paused: ${fix.reason.slice(0, 300)}`)
        return { outcome: "paused", url: null }
      }
      if (fix.kind !== "passed") {
        failure = `${failure}\n\nThe previous fix attempt failed: ${fix.reason}`
        continue
      }
    }
    const result = await deployProject(projectDir, store)
    if (result.url) {
      store.setPhase("deploy", "approved")
      return { outcome: "completed", url: result.url }
    }
    failure = result.error
  }
  store.setPhase("deploy", "failed")
  store.log("deploy", `gave up after ${deployAttempts} attempts. Fix it, then: agent-team run ${projectDir}`)
  return { outcome: "failed", url: null }
}

async function attemptDeployFix(context: PipelineContext, attempt: number, failure: string): Promise<AttemptResult> {
  const { projectDir } = context
  const name = `deploy-fix-${attempt}`
  const workspace = createWorkspace(projectDir, name)
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const setupCommand = detectSetupCommand(workspace.path)
    if (setupCommand) {
      const setup = await runCommand(context, executor, setupCommand, `${name}-setup`)
      if (!setup.passed) return { kind: "infrastructure", reason: `workspace setup failed (${setupCommand}):\n${setup.output}` }
    }
    const prompt = [
      "The finished app failed to start in production. Make it deployable without changing its features.",
      "",
      "The platform runs `<install> && <start>` from deploy.json in a node:22 container with PORT=3000, HOST=0.0.0.0, and NODE_ENV=production, then probes http://127.0.0.1:$PORT.",
      "Without deploy.json it falls back to `npm start`, then to serving a static index.html.",
      "",
      "Write or fix deploy.json at the repository root ({ \"install\": ..., \"start\": ..., \"port\": 3000 }) and the start script so the app serves on 0.0.0.0:$PORT. Keep the tests passing. Do not edit docs/ or contracts/.",
      "",
      "Deploy failure:",
      failure,
    ].join("\n")
    const worker = await runAgent(context, executor, "worker", `${name}-worker`, ["read", "edit", "write", "bash:npm", "bash:npx", "bash:node", "bash:ls"], prompt)
    if (isInfrastructureFailure(worker)) return { kind: "infrastructure", reason: `worker ${worker.failureClass}: ${worker.result.summary}` }
    if (worker.result.status !== "done") return { kind: "failed", reason: `worker ${worker.result.status}: ${worker.result.summary}` }

    const forbidden = changedFiles(workspace.path).filter((file) => file.startsWith("docs/") || file.startsWith("contracts/"))
    if (forbidden.length) return { kind: "failed", reason: `edited files outside the deploy scope: ${forbidden.join(", ")}` }
    const packagePath = join(workspace.path, "package.json")
    const hasTests = existsSync(packagePath) && Boolean(JSON.parse(readFileSync(packagePath, "utf8")).scripts?.test)
    if (hasTests) {
      const tests = await runCommand(context, executor, "npm test", `${name}-verify`)
      if (!tests.passed) return { kind: "failed", reason: `npm test failed after the deploy fix:\n${tests.output}` }
    }

    const title = "fix(deploy): make the app start in production"
    commitAndRebase(workspace, title)
    context.github.land({
      branch: workspace.branch,
      title,
      body: ["The deploy phase could not start the app. The worker agent changed the start setup.", "", "```", failure.slice(0, 3000), "```"].join("\n"),
      localMerge: () => fastForwardMain(projectDir, workspace.branch),
    })
    return { kind: "passed" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

function pullRequestBody(context: PipelineContext, task: Task, attempt: number, verdict: { reasons: string[] }): string {
  const issue = context.github.taskIssue(task)
  const worker = context.config.roles.worker
  return [
    issue ? `Closes #${issue}.` : "",
    "",
    `Built by the worker agent (${worker.runner} ${worker.model}) on attempt ${attempt}. \`${task.verify}\` passed.`,
    "",
    "## Review",
    "",
    "Verdict: **pass**",
    ...verdict.reasons.map((reason) => `- ${reason}`),
    "",
    "## Acceptance criteria",
    "",
    ...task.acceptance.map((criterion) => `- [x] ${criterion}`),
  ].join("\n")
}

function isInfrastructureFailure(outcome: HarnessOutcome): boolean {
  return outcome.failureClass !== null && outcome.failureClass !== "agent_failure"
}

let egressProxy: ReturnType<typeof ensureEgressProxy> | null = null

async function createExecutor(context: PipelineContext, hostDir: string, name: string): Promise<Executor> {
  const { config, projectDir } = context
  if (config.harness.isolation === "none") return hostExecutor(hostDir)
  const { allowlist, extraDomains } = config.harness.network
  if (allowlist) egressProxy ??= ensureEgressProxy([...defaultAllowlist, ...extraDomains])
  const credentials = [...new Set(Object.values(config.roles).flatMap((role) => [role.runner, ...role.fallbacks.map((fallback) => fallback.runner)]))]
  return createDockerExecutor({
    hostDir,
    image: await ensureImage(),
    name: `agent-team-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    limits: config.harness.docker,
    credentials,
    readOnlyPaths: hostDir === projectDir ? [] : [join(projectDir, ".git")],
    network: allowlist ? await egressProxy! : undefined,
  })
}

async function runCommand(context: PipelineContext, executor: Executor, command: string, subject: string): Promise<{ passed: boolean; output: string }> {
  const result = await executor.exec({
    command: "sh",
    args: ["-c", command],
    input: "",
    timeoutMs: commandTimeoutMs,
    transcriptPath: transcriptPath(context, `${subject}.log`),
    signal: context.signal,
  })
  const output = `${result.stdout}\n${result.stderr}`.slice(-4000)
  if (result.timedOut) return { passed: false, output: `timed out after ${commandTimeoutMs / 1000}s\n${output}` }
  return { passed: result.exitCode === 0 && !result.aborted, output }
}

function workerTools(task: Task): string[] {
  const verifyExecutable = task.verify.trim().split(/\s+/)[0]
  return [...new Set(["read", "edit", "write", "bash:npm", "bash:npx", "bash:node", "bash:mkdir", "bash:ls", `bash:${verifyExecutable}`])]
}

function workerPrompt(task: Task, lastFailure: string | null): string {
  const lines = [`Implement this task:`, JSON.stringify(task, null, 2)]
  if (lastFailure) lines.push(`Your previous attempt failed. Address this:\n${lastFailure}`)
  return lines.join("\n\n")
}

function reviewPrompt(task: Task, diff: string, verifyOutput: string): string {
  const maxDiffLength = 60_000
  const shownDiff = diff.length > maxDiffLength ? `${diff.slice(0, maxDiffLength)}\n[diff truncated]` : diff
  return [`Task:`, JSON.stringify(task, null, 2), `Verify output (passed):`, verifyOutput, `Diff:`, shownDiff].join("\n\n")
}

export function parseVerdict(text: string): { verdict: string; reasons: string[]; fixes: string[] } {
  const match = text.match(/\{[\s\S]*\}/)
  try {
    const parsed = JSON.parse(match?.[0] ?? "")
    return { verdict: parsed.verdict, reasons: parsed.reasons ?? [], fixes: parsed.fixes ?? [] }
  } catch {
    return { verdict: "fail", reasons: ["reviewer did not return a JSON verdict"], fixes: [] }
  }
}

function runAgent(context: PipelineContext, executor: Executor, role: Role, subject: string, allowedTools: string[], taskPrompt: string): Promise<HarnessOutcome> {
  const { config, harness } = context
  return harness.run(
    config.roles[role],
    {
      role,
      subject,
      systemPrompt: loadPrompt(role),
      taskPrompt,
      allowedTools,
      budgetUsd: config.budget.perTaskUsd,
      transcriptPath: (candidate: Candidate, attempt: number) => transcriptPath(context, `${subject}-${candidate.runner}-${attempt}.log`),
    },
    executor,
  )
}

function transcriptPath(context: PipelineContext, fileName: string): string {
  const dir = join(context.projectDir, ".agent-team", "transcripts")
  mkdirSync(dir, { recursive: true })
  return join(dir, fileName)
}

function loadPrompt(role: Role): string {
  return readFileSync(new URL(`../prompts/${role}.md`, import.meta.url), "utf8")
}

function requireFile(path: string): string {
  if (!existsSync(path)) throw new Error(`missing required file ${path}`)
  return path
}

function requireHeadings(path: string, headings: string[]): void {
  const lines = readFileSync(requireFile(path), "utf8").split("\n").map((line) => line.trim())
  const missing = headings.filter((heading) => !lines.includes(heading))
  if (missing.length) throw new Error(`${path} is missing headings: ${missing.join(", ")}`)
}
