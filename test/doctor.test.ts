import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { checkOnce, commitTitle, detect, loadDoctorConfig, parseDoctorReport, type DoctorDeps } from "../src/doctor.ts"
import { commitAll } from "../src/git.ts"
import type { AgentJob, Harness, HarnessOutcome } from "../src/harness/harness.ts"
import { fingerprint, listIncidents } from "../src/incidents.ts"
import type { RunStop } from "../src/pipeline.ts"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { createProject, openProjectStore } from "../src/project.ts"
import { startUi } from "../src/ui/server.ts"
import type { Store } from "../src/store.ts"
import type { Task } from "../src/tasks.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-doctor-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, phase: "feature", dependsOn: [], allowedPaths: [`src/${id.toLowerCase()}/**`], readPaths: [], acceptance: ["works"], verify: "true", ...overrides }
}

function stop(store: Store, outcome: RunStop["outcome"], reason: string, kind: RunStop["kind"] = "other"): void {
  store.setMeta("run.stop", JSON.stringify({ outcome, kind, reason, at: new Date().toISOString() }))
  store.log("run", `finished: ${outcome}`)
}

let counter = 0

// A runs folder with one project and a source clone whose origin is a local bare repo.
function setup(options: { doctorYaml?: string; tasks?: Task[] } = {}) {
  const root = join(scratch, `case-${++counter}`)
  const runsDir = join(root, "runs")
  const projectDir = join(runsDir, "crm-test")
  createProject(projectDir, "brief")
  writeFileSync(join(projectDir, "pipeline.yaml"), readFileSync(join(projectDir, "pipeline.yaml"), "utf8").replace("isolation: docker", "isolation: none"))
  writeFileSync(join(projectDir, "tasks.json"), `${JSON.stringify(options.tasks ?? [task("T001", { phase: "foundation", allowedPaths: ["package.json", "src/app/**"] }), task("T005")], null, 2)}\n`)
  commitAll(projectDir, "plan")

  const seed = join(root, "seed")
  mkdirSync(join(seed, "src"), { recursive: true })
  mkdirSync(join(seed, "test"), { recursive: true })
  writeFileSync(join(seed, "package.json"), "{}\n")
  writeFileSync(join(seed, "src", "json.ts"), "export const version = 1\n\n// parser\n\nexport const name = \"json\"\n")
  writeFileSync(join(seed, "test", "json.test.ts"), "// placeholder\n")
  git(seed, ["init", "-q", "-b", "main"])
  git(seed, ["config", "user.name", "seed"])
  git(seed, ["config", "user.email", "seed@localhost"])
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-q", "-m", "chore: seed"])
  const origin = join(root, "origin.git")
  git(root, ["clone", "-q", "--bare", seed, origin])
  const sourceDir = join(root, "source")
  git(root, ["clone", "-q", origin, sourceDir])
  git(sourceDir, ["config", "user.name", "doctor"])
  git(sourceDir, ["config", "user.email", "doctor@localhost"])

  writeFileSync(join(runsDir, "doctor.yaml"), `sourceDir: ${sourceDir}\nrepo: owner/agent-team\n${options.doctorYaml ?? ""}`)
  const installDir = join(root, "install")
  mkdirSync(installDir)
  return { runsDir, projectDir, sourceDir, origin, installDir }
}

type Reply = (job: AgentJob, workdir: string) => { summary: string; costUsd?: number }

function stubDeps(installDir: string, replies: Reply[]) {
  const gh: string[][] = []
  const started: string[] = []
  const jobs: AgentJob[] = []
  let issue = 0
  const deps: Partial<DoctorDeps> = {
    gh: (args) => {
      gh.push(args)
      if (args[0] === "issue" && args[1] === "create") return `https://github.com/owner/agent-team/issues/${++issue}`
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/owner/agent-team/pull/99"
      if (args[0] === "pr" && args[1] === "list") return "[]"
      return ""
    },
    createHarness: (store) =>
      ({
        async run(_role: unknown, job: AgentJob, executor: { workdir: string }): Promise<HarnessOutcome> {
          jobs.push(job)
          const reply = (replies.length > 1 ? replies.shift()! : replies[0])(job, executor.workdir)
          const transcriptPath = job.transcriptPath({ runner: "claude", model: "stub" }, 1)
          store.recordAttempt({ subject: job.subject, role: job.role, runner: "claude", model: "stub", status: "done", failureClass: null, costUsd: reply.costUsd ?? 1, durationMs: 1, transcriptPath })
          return { result: { status: "done", summary: reply.summary, costUsd: reply.costUsd ?? 1, durationMs: 1, exitCode: 0, diagnostics: "" }, candidate: { runner: "claude", model: "stub" }, failureClass: null }
        },
      }) as unknown as Harness,
    runCommand: async () => ({ passed: true, output: "ok" }),
    startRun: (projectDir) => void started.push(projectDir),
    installDir,
  }
  return { deps, gh, started, jobs }
}

function report(fields: Record<string, unknown>): string {
  return `I checked the evidence.\n\n\`\`\`json\n${JSON.stringify({ diagnosis: "parseVerdict misread passing reviews.", cause: "agent_team_bug", projectActions: [], codeFix: false, summary: "", ...fields })}\n\`\`\``
}

const blockedReason = 'T005 blocked after 3 attempts: the reviewer gave no valid verdict: verdict must be "pass" or "fail"'

test("detection ignores completed runs, gates, and operator stops", () => {
  const { runsDir, projectDir } = setup()
  const config = loadDoctorConfig(runsDir)
  const store = openProjectStore(projectDir)
  try {
    assert.equal(detect(projectDir, store, config).kind, "none", "a project that never ran")
    store.log("run", "finished: completed")
    assert.equal(detect(projectDir, store, config).kind, "none")

    store.setPhase("spec", "awaiting_approval")
    stop(store, "awaiting_approval", 'phase "spec" is ready for review')
    assert.equal(detect(projectDir, store, config).kind, "none")
    store.setPhase("spec", "approved")

    store.log("run", "interrupt received; stopping agents and cleaning up (press Ctrl+C again to force)")
    stop(store, "paused", "T005 paused: worker aborted: ")
    assert.equal(detect(projectDir, store, config).kind, "none")
  } finally {
    store.close()
  }
})

test("detection ignores projects that stopped before run.stop existed, but not a first run that crashed", () => {
  const { runsDir, projectDir } = setup()
  const config = loadDoctorConfig(runsDir)
  const store = openProjectStore(projectDir)
  try {
    store.log("phase", "spec: attempt 1 with pm")
    assert.equal(detect(projectDir, store, config).kind, "incident", "a first run that exited without a stop record")
    store.log("run", "finished: completed")
    store.log("deploy", "live at https://example.trycloudflare.com")
    assert.equal(detect(projectDir, store, config).kind, "none")
  } finally {
    store.close()
  }
})

test("detection sends budget stops and human replans to a notice, not an incident", () => {
  const { runsDir, projectDir } = setup()
  const config = loadDoctorConfig(runsDir)
  const store = openProjectStore(projectDir)
  try {
    stop(store, "awaiting_approval", "run budget reached: $30.10 reported of $30.00 (budget.runUsd). Stopped before T005-worker-1", "budget")
    assert.equal(detect(projectDir, store, config).kind, "notice")
    stop(store, "awaiting_approval", "T005 needs a human decision: the replanner wants to widen T005 to package.json")
    assert.equal(detect(projectDir, store, config).kind, "notice")
  } finally {
    store.close()
  }
})

test("a cooldown pause waits for the cooldown, resumes once, then becomes an incident", () => {
  const { runsDir, projectDir } = setup()
  const config = loadDoctorConfig(runsDir)
  const store = openProjectStore(projectDir)
  try {
    stop(store, "paused", "T005 paused: worker rate_limit: no runner available: all candidates are cooling down")
    store.coolDownRunner("claude", Date.now() + 60_000, "rate_limit")
    assert.equal(detect(projectDir, store, config).kind, "none")
    store.clearCooldowns()
    const first = detect(projectDir, store, config)
    assert.equal(first.kind, "cooldown_resume")
    store.setMeta("doctor.cooldownResume", first.kind === "cooldown_resume" ? first.fingerprint : "")
    assert.equal(detect(projectDir, store, config).kind, "incident")
  } finally {
    store.close()
  }
})

test("a live run counts as stalled only after stallMinutes and the agent timeout", () => {
  const { runsDir, projectDir } = setup()
  const config = loadDoctorConfig(runsDir)
  const store = openProjectStore(projectDir)
  try {
    store.setMeta("run.pid", String(process.pid))
    store.log("task", 'T005 "task T005": attempt 1/3')
    assert.equal(detect(projectDir, store, config, Date.now() + 40 * 60_000).kind, "none", "the agent call may still be inside its 30 min timeout plus grace")
    const stalled = detect(projectDir, store, config, Date.now() + 50 * 60_000)
    assert.equal(stalled.kind, "incident")
    assert.equal(stalled.kind === "incident" && stalled.incidentKind, "stalled")
    store.setMeta("run.pid", "")
  } finally {
    store.close()
  }
})

test("fingerprints ignore times and amounts but tell different stops apart", () => {
  assert.equal(fingerprint("failed", "T005 failed at 2026-09-24T10:00:00Z after 3s"), fingerprint("failed", "T005 failed at 2026-09-25T11:30:00Z after 9s"))
  assert.notEqual(fingerprint("failed", "T005 blocked"), fingerprint("failed", "T006 blocked"))
  assert.notEqual(fingerprint("failed", "T005 blocked"), fingerprint("paused", "T005 blocked"))
})

test("parseDoctorReport enforces the JSON contract", () => {
  const parsed = parseDoctorReport(report({ projectActions: [{ action: "retry", taskId: "T005" }, { action: "reset_cooldowns" }, { action: "edit_task", taskId: "T005", allowedPaths: ["src/x/**"] }, { action: "resume" }], codeFix: true, summary: "Fixed." }))
  assert.equal(parsed.cause, "agent_team_bug")
  assert.equal(parsed.projectActions.length, 4)
  assert.throws(() => parseDoctorReport(report({ cause: "gremlins" })), /cause must be one of/)
  assert.throws(() => parseDoctorReport(report({ codeFix: "yes" })), /codeFix must be true or false/)
  assert.throws(() => parseDoctorReport(report({ projectActions: [{ action: "delete_project" }] })), /action must be/)
  assert.throws(() => parseDoctorReport(report({ projectActions: [{ action: "edit_task", taskId: "T005", allowedPaths: [] }] })), /non-empty allowedPaths/)
  assert.throws(() => parseDoctorReport("I could not decide."), /no ```json block/)
})

test("commit titles are conventional and short", () => {
  assert.equal(commitTitle("Prefer the last json block. Added a test."), "fix(doctor): prefer the last json block")
  assert.ok(commitTitle("x".repeat(200)).length <= 72)
})

test("a code fix is tested, pushed, opened as a PR, copied into the live install, and the run resumes", async () => {
  const { runsDir, projectDir, sourceDir, origin, installDir } = setup()
  const store = openProjectStore(projectDir)
  store.syncTasks(["T001", "T005"])
  store.updateTask("T005", "blocked", blockedReason)
  stop(store, "failed", blockedReason)
  store.close()

  let evidence = ""
  let evidenceWritable = true
  const { deps, gh, started, jobs } = stubDeps(installDir, [
    (_job, workdir) => {
      evidence = readFileSync(join(workdir, ".incident", "stop.txt"), "utf8")
      try {
        writeFileSync(join(workdir, ".incident", "stop.txt"), "changed")
      } catch {
        evidenceWritable = false
      }
      writeFileSync(join(workdir, "src", "json.ts"), "export const version = 2\n")
      writeFileSync(join(workdir, "test", "json.test.ts"), "// regression test\n")
      return { summary: report({ projectActions: [{ action: "retry", taskId: "T005" }], codeFix: true, summary: "Prefer the last json block over a balanced object. Added a regression test." }) }
    },
  ])
  await checkOnce({ runsDir, deps })

  const [incident] = listIncidents(projectDir)
  assert.equal(incident.status, "fixed")
  assert.equal(incident.cause, "agent_team_bug")
  assert.equal(incident.subject, "T005")
  assert.equal(incident.prUrl, "https://github.com/owner/agent-team/pull/99")
  assert.equal(incident.issueUrl, "https://github.com/owner/agent-team/issues/1")
  assert.match(evidence, /T005 blocked after 3 attempts/)
  if (process.getuid?.() !== 0) assert.equal(evidenceWritable, false, ".incident/ is read-only")
  assert.equal(jobs[0].role, "doctor")
  assert.match(jobs[0].systemPrompt, /You are the doctor/)
  assert.ok(!jobs[0].writablePaths?.some((path) => path.startsWith(".incident")))

  const branch = incident.branch!
  assert.match(branch, /^doctor\/crm-test-/)
  const message = git(origin, ["log", "-1", "--format=%B", branch])
  assert.match(message, /^fix\(doctor\): prefer the last json block over a balanced object/)
  assert.doesNotMatch(message, /Co-Authored-By|Claude|Generated with/i)
  assert.deepEqual(git(origin, ["diff", "--name-only", "main", branch]).split("\n").sort(), ["src/json.ts", "test/json.test.ts"])

  assert.equal(readFileSync(join(installDir, "src", "json.ts"), "utf8"), "export const version = 2\n")

  const prCreate = gh.find((args) => args[0] === "pr" && args[1] === "create")!
  assert.deepEqual(prCreate.slice(prCreate.indexOf("--base"), prCreate.indexOf("--base") + 2), ["--base", "main"])
  assert.ok(gh.some((args) => args[0] === "issue" && args[1] === "create" && args.includes("incident")))
  assert.deepEqual(started, [projectDir])
  assert.equal(readdirSync(join(sourceDir, ".agent-team", "worktrees")).length, 0, "the worktree is removed")

  const after = openProjectStore(projectDir)
  try {
    assert.equal(after.task("T005").status, "pending")
    assert.equal(after.task("T005").attempts, 0)
  } finally {
    after.close()
  }
})

test("a fix without a test change is rejected, the incident is not duplicated, and the doctor gives up at the limit", async () => {
  const { runsDir, projectDir, origin, installDir } = setup({ doctorYaml: "maxAttempts: 2\n" })
  const store = openProjectStore(projectDir)
  stop(store, "failed", blockedReason)
  store.close()
  const { deps, gh, started } = stubDeps(installDir, [
    (_job, workdir) => {
      writeFileSync(join(workdir, "src", "json.ts"), "export const version = 3\n")
      return { summary: report({ codeFix: true, summary: "Changed the parser." }) }
    },
  ])

  await checkOnce({ runsDir, deps })
  let incidents = listIncidents(projectDir)
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0].status, "open")
  assert.match(incidents[0].actions.find((action) => action.action === "fix_rejected")?.detail ?? "", /no regression test under test\//)
  assert.doesNotMatch(git(origin, ["branch", "--list"]), /doctor\//, "nothing was pushed")
  assert.ok(!existsSync(join(installDir, "src", "json.ts")), "no hotfix")

  await checkOnce({ runsDir, deps })
  incidents = listIncidents(projectDir)
  assert.equal(incidents.length, 1, "the same fingerprint reuses the open incident")
  assert.equal(incidents[0].attempts, 2)
  assert.equal(incidents[0].status, "gave_up")
  assert.ok(gh.some((args) => args[0] === "issue" && args[1] === "comment" && args.includes("https://github.com/owner/agent-team/issues/1")))

  await checkOnce({ runsDir, deps })
  assert.equal(listIncidents(projectDir)[0].attempts, 2, "no more attempts after giving up")
  assert.deepEqual(started, [])
})

test("the cost limit stops the doctor after one expensive attempt", async () => {
  const { runsDir, projectDir, installDir } = setup({ doctorYaml: "maxUsdPerIncident: 5\n" })
  const store = openProjectStore(projectDir)
  stop(store, "failed", blockedReason)
  store.close()
  const { deps } = stubDeps(installDir, [() => ({ summary: "I am not sure.", costUsd: 6 })])
  await checkOnce({ runsDir, deps })
  const [incident] = listIncidents(projectDir)
  assert.equal(incident.status, "gave_up")
  assert.equal(incident.costUsd, 6)
  assert.ok(incident.actions.some((action) => action.action === "report_rejected"))
})

test("project actions: edit_task lands through tasks.json, shared files need a human, cooldowns reset", async () => {
  const { runsDir, projectDir, installDir } = setup()
  const store = openProjectStore(projectDir)
  store.syncTasks(["T001", "T005"])
  store.updateTask("T005", "blocked", "edited files outside allowedPaths: src/extra/x.ts")
  store.coolDownRunner("codex", Date.now() + 60_000, "auth")
  stop(store, "failed", "T005 blocked after 3 attempts: edited files outside allowedPaths: src/extra/x.ts")
  store.close()
  const { deps, started } = stubDeps(installDir, [
    () => ({
      summary: report({
        cause: "project_state",
        projectActions: [
          { action: "edit_task", taskId: "T005", allowedPaths: ["src/extra/**"] },
          { action: "reset_cooldowns" },
        ],
      }),
    }),
  ])
  await checkOnce({ runsDir, deps })
  const tasks = JSON.parse(git(projectDir, ["show", "main:tasks.json"])) as Task[]
  assert.deepEqual(tasks.find((entry) => entry.id === "T005")?.allowedPaths, ["src/t005/**", "src/extra/**"])
  const after = openProjectStore(projectDir)
  try {
    assert.equal(after.task("T005").status, "pending")
    assert.equal(after.runnerHealth().length, 0)
  } finally {
    after.close()
  }
  assert.equal(listIncidents(projectDir)[0].status, "fixed")
  assert.deepEqual(started, [projectDir])

  const second = setup()
  const secondStore = openProjectStore(second.projectDir)
  secondStore.syncTasks(["T001", "T005"])
  stop(secondStore, "failed", "T005 blocked after 3 attempts: edited files outside allowedPaths: package.json")
  secondStore.close()
  const shared = stubDeps(second.installDir, [() => ({ summary: report({ cause: "project_state", projectActions: [{ action: "edit_task", taskId: "T005", allowedPaths: ["package.json"] }] }) })])
  await checkOnce({ runsDir: second.runsDir, deps: shared.deps })
  const humanStore = openProjectStore(second.projectDir)
  try {
    assert.match(humanStore.task("T005").humanReason ?? "", /shared foundation file/)
  } finally {
    humanStore.close()
  }
  assert.match(listIncidents(second.projectDir)[0].actions.find((action) => action.action === "edit_task")?.detail ?? "", /needs a human/)
})

test("a decision for the user opens one issue and never runs the agent", async () => {
  const { runsDir, projectDir, installDir } = setup()
  const store = openProjectStore(projectDir)
  stop(store, "awaiting_approval", "run budget reached: $30.10 reported of $30.00 (budget.runUsd)", "budget")
  store.close()
  const { deps, gh, jobs } = stubDeps(installDir, [() => ({ summary: "unused" })])
  await checkOnce({ runsDir, deps })
  await checkOnce({ runsDir, deps })
  assert.equal(gh.filter((args) => args[0] === "issue" && args[1] === "create").length, 1)
  assert.equal(jobs.length, 0)
  assert.equal(listIncidents(projectDir).length, 0)
})

test("a fix that touches the files of an open doctor PR is stacked on that PR's branch", async () => {
  const { runsDir, projectDir, sourceDir, installDir } = setup()
  git(sourceDir, ["checkout", "-q", "-b", "doctor/earlier"])
  writeFileSync(join(sourceDir, "src", "json.ts"), readFileSync(join(sourceDir, "src", "json.ts"), "utf8").replace('"json"', '"json5"'))
  git(sourceDir, ["commit", "-q", "-am", "fix(doctor): earlier fix"])
  git(sourceDir, ["push", "-q", "origin", "doctor/earlier"])
  git(sourceDir, ["checkout", "-q", "main"])
  const store = openProjectStore(projectDir)
  stop(store, "failed", blockedReason)
  store.close()
  const { deps, gh } = stubDeps(installDir, [
    (_job, workdir) => {
      writeFileSync(join(workdir, "src", "json.ts"), readFileSync(join(workdir, "src", "json.ts"), "utf8").replace("version = 1", "version = 2"))
      writeFileSync(join(workdir, "test", "json.test.ts"), "// regression test\n")
      return { summary: report({ codeFix: true, summary: "Fix the parser again." }) }
    },
  ])
  const listPullRequests = deps.gh!
  deps.gh = (args, cwd, input) =>
    args[0] === "pr" && args[1] === "list"
      ? JSON.stringify([{ headRefName: "doctor/earlier", url: "https://github.com/owner/agent-team/pull/7", files: [{ path: "src/json.ts" }] }])
      : listPullRequests(args, cwd, input)
  await checkOnce({ runsDir, deps })
  const [incident] = listIncidents(projectDir)
  assert.equal(incident.status, "fixed", JSON.stringify(incident.actions))
  const prCreate = gh.find((args) => args[0] === "pr" && args[1] === "create")!
  assert.equal(prCreate[prCreate.indexOf("--base") + 1], "doctor/earlier")
})

test("the dashboard lists incidents, shows one with its transcripts, and flags the project", async (t) => {
  const { runsDir, projectDir, installDir } = setup()
  const store = openProjectStore(projectDir)
  stop(store, "failed", blockedReason)
  store.close()
  const { deps } = stubDeps(installDir, [() => ({ summary: "no answer" })])
  await checkOnce({ runsDir, deps })
  const [incident] = listIncidents(projectDir)
  const server = startUi({ runsDir, port: 0, startRun: () => {} })
  t.after(() => server.close())
  await once(server, "listening")
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const list = await (await fetch(`${base}/api/incidents`)).json()
  assert.equal(list.length, 1)
  assert.equal(list[0].project, "crm-test")
  const detail = await (await fetch(`${base}/api/incidents/crm-test/${incident.id}`)).json()
  assert.equal(detail.calls[0].role, "doctor")
  assert.match(detail.calls[0].transcript, /^doctor-/)
  assert.equal((await fetch(`${base}/api/incidents/crm-test/nope`)).status, 404)
  const projects = await (await fetch(`${base}/api/projects`)).json()
  assert.equal(projects[0].incident?.id, incident.id)
})
