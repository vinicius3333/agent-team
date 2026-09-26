import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { cliPath, runContainerArgs, runContainerName, startRunContainer, withProjectStore } from "../src/project.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-run-container-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function fakeProject(name: string, runPid: string): string {
  const projectDir = join(scratch, name)
  execFileSync("mkdir", ["-p", projectDir])
  writeFileSync(join(projectDir, "pipeline.yaml"), "")
  withProjectStore(projectDir, (store) => store.setMeta("run.pid", runPid))
  return projectDir
}

// Answers each inspect from the list in order ("missing" throws, like docker does), then with the new run's pid.
function fakeDocker(inspects: Array<"found" | "missing">) {
  const calls: string[] = []
  const docker = (args: string[]) => {
    if (args[0] === "inspect") {
      const answer = inspects.shift() ?? "found"
      calls.push(`inspect (${answer})`)
      if (answer === "missing") throw new Error("Error: No such object")
      return "4242"
    }
    calls.push(args[0] === "rm" ? args.slice(0, 2).join(" ") : args[0])
    return ""
  }
  return { calls, docker }
}

test("a dead run's old container is removed and docker run waits until it is gone", () => {
  const projectDir = fakeProject("dead-run", "999999")
  const { calls, docker } = fakeDocker(["found", "found", "found", "missing"])
  const sleeps: number[] = []
  const pid = startRunContainer(projectDir, join(scratch, "dead-run.log"), "agent-team:latest", ["run"], {
    docker,
    processAlive: () => false,
    sleep: (ms) => { sleeps.push(ms) },
  })
  assert.deepEqual(calls, ["inspect (found)", "rm -f", "inspect (found)", "inspect (found)", "inspect (missing)", "run", "inspect (found)"])
  assert.deepEqual(sleeps, [250, 250])
  assert.equal(pid, 4242)
  assert.equal(withProjectStore(projectDir, (store) => store.meta("run.pid")), "4242")
})

test("with no old container, docker run starts right away", () => {
  const projectDir = fakeProject("no-container", "")
  const { calls, docker } = fakeDocker(["missing"])
  startRunContainer(projectDir, join(scratch, "no-container.log"), "agent-team:latest", ["run"], {
    docker,
    processAlive: () => { throw new Error("processAlive should not be called") },
    sleep: () => { throw new Error("sleep should not be called") },
  })
  assert.deepEqual(calls, ["inspect (missing)", "run", "inspect (found)"])
})

test("a live run keeps its container: no rm and no run", () => {
  const projectDir = fakeProject("live-run", "4242")
  const { calls, docker } = fakeDocker(["found"])
  assert.throws(
    () => startRunContainer(projectDir, join(scratch, "live-run.log"), "agent-team:latest", ["run"], { docker, processAlive: (pid) => pid === 4242, sleep: () => {} }),
    { message: "A run for this project is still going. Stop it before you resume." },
  )
  assert.deepEqual(calls, ["inspect (found)"])
})

test("an old container that never goes away stops the start after 30 seconds", () => {
  const projectDir = fakeProject("stuck", "")
  const { calls, docker } = fakeDocker([])
  let slept = 0
  const name = runContainerName(projectDir)
  assert.throws(
    () => startRunContainer(projectDir, join(scratch, "stuck.log"), "agent-team:latest", ["run"], { docker, processAlive: () => false, sleep: (ms) => { slept += ms } }),
    { message: `The old run container ${name} did not go away. Remove it with: docker rm -f ${name}` },
  )
  assert.equal(slept, 30_000)
  assert.ok(!calls.includes("run"))
})

const options = { image: "agent-team:latest", projectDir: "/home/opc/agent-team-runs/Fim de Ano", logPath: "/home/opc/agent-team-runs/Fim de Ano.log", home: "/home/opc", uid: 1000, gid: 1000, groups: [1000, 989, 989] }

test("a run container mirrors the ui service: host network and PIDs, the same user, home, and Docker socket", () => {
  const args = runContainerArgs(options)
  const flag = (name: string) => args.filter((_, index) => args[index - 1] === name)
  assert.deepEqual(args.slice(0, 3), ["run", "-d", "--rm"])
  assert.deepEqual(flag("--name"), ["agent-team-run-fim-de-ano"])
  assert.deepEqual(flag("--user"), ["1000:1000"])
  assert.deepEqual(flag("--group-add"), ["989"])
  assert.deepEqual(flag("--network"), ["host"])
  assert.deepEqual(flag("--pid"), ["host"])
  assert.deepEqual(flag("--env"), ["HOME=/home/opc", "AGENT_TEAM_SECRETS_KEY"])
  assert.deepEqual(flag("--volume"), ["/var/run/docker.sock:/var/run/docker.sock", "/tmp:/tmp", "/home/opc:/home/opc"])
  assert.equal(args[args.indexOf("agent-team:latest") + 1], "sh")
  assert.equal(runContainerName("/runs/crm-test"), "agent-team-run-crm-test")
})

test("the run container's command runs the CLI on the project and appends to the run log", () => {
  const bin = join(scratch, "bin")
  execFileSync("mkdir", ["-p", bin])
  writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  chmodSync(join(bin, "node"), 0o755)
  const logPath = join(scratch, "run.log")
  writeFileSync(logPath, "earlier\n")
  const args = runContainerArgs({ ...options, logPath })
  const command = args.slice(args.indexOf("sh") + 1)
  execFileSync("sh", command, { env: { PATH: `${bin}:/usr/bin:/bin` } })
  assert.equal(readFileSync(logPath, "utf8"), ["earlier", "--disable-warning=ExperimentalWarning", cliPath, "run", options.projectDir, ""].join("\n"))
})
