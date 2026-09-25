import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { cliPath, runContainerArgs, runContainerName } from "../src/project.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-run-container-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

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
  assert.deepEqual(flag("--env"), ["HOME=/home/opc"])
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
