import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { defaultLeadConfig, loadConfig } from "../src/config.ts"
import { createProject } from "../src/project.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-config-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function pipelineWithLead(name: string, lead: string): string {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  const path = join(projectDir, "pipeline.yaml")
  if (lead) writeFileSync(path, `${readFileSync(path, "utf8")}\nlead:\n${lead}`)
  return path
}

function pipelineWithDecide(name: string, decide: string | null): string {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  const path = join(projectDir, "pipeline.yaml")
  if (decide !== null) writeFileSync(path, readFileSync(path, "utf8").replace("autoApproveScope: false", `autoApproveScope: false\n  decide: ${decide}`))
  return path
}

test("autonomy.decide defaults to human and reads human or auto", () => {
  assert.equal(loadConfig(pipelineWithDecide("decide-default", null)).autonomy.decide, "human")
  assert.equal(loadConfig(pipelineWithDecide("decide-human", "human")).autonomy.decide, "human")
  assert.equal(loadConfig(pipelineWithDecide("decide-auto", "auto")).autonomy.decide, "auto")
})

test("config validation rejects any other autonomy.decide value", () => {
  for (const value of ["manual", "AUTO", "true", "\"\""]) {
    assert.throws(() => loadConfig(pipelineWithDecide(`decide-bad-${value.replace(/\W/g, "") || "empty"}`, value)), /autonomy\.decide must be human or auto/)
  }
})

test("this project's pipeline.yaml sets autonomy.decide to auto", () => {
  assert.equal(loadConfig(join(import.meta.dirname, "..", "pipeline.yaml")).autonomy.decide, "auto")
})

test("lead.access defaults to read", () => {
  assert.equal(defaultLeadConfig.access, "read")
  assert.equal(loadConfig(pipelineWithLead("default", "")).lead.access, "read")
  assert.equal(loadConfig(pipelineWithLead("other-keys", "  autoApply: []\n")).lead.access, "read")
})

test("loadConfig reads lead.access read or full next to the other lead keys", () => {
  assert.equal(loadConfig(pipelineWithLead("read", "  access: read\n")).lead.access, "read")
  const config = loadConfig(pipelineWithLead("full", "  actions: [retry]\n  autoApply: [retry]\n  access: full\n"))
  assert.equal(config.lead.access, "full")
  assert.deepEqual(config.lead.autoApply, ["retry"])
})

test("config validation rejects any other lead.access value", () => {
  for (const value of ["write", "FULL", "true", "\"\""]) {
    assert.throws(() => loadConfig(pipelineWithLead(`bad-${value.replace(/\W/g, "") || "empty"}`, `  access: ${value}\n`)), /lead\.access must be read or full/)
  }
})
