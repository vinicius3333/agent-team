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

function pipelineWith(name: string, extra: string): string {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  const path = join(projectDir, "pipeline.yaml")
  if (extra) writeFileSync(path, `${readFileSync(path, "utf8")}\n${extra}`)
  return path
}

function pipelineWithIssues(name: string, issues: string): string {
  const projectDir = join(scratch, name)
  createProject(projectDir, "brief")
  const path = join(projectDir, "pipeline.yaml")
  writeFileSync(path, readFileSync(path, "utf8").replace("    name: null", `    name: null\n    issues:\n${issues}`))
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

test("a pipeline.yaml with neither block loads with issue polling on every 10 minutes and no codex endpoint", () => {
  const config = loadConfig(pipelineWith("no-new-blocks", ""))
  assert.deepEqual(config.publish.github.issues, { enabled: true, everyMinutes: 10 })
  assert.equal(config.runners.codex, null)
  assert.equal(config.publish.github.enabled, false)
})

test("loadConfig reads publish.github.issues", () => {
  const config = loadConfig(pipelineWithIssues("issues-set", "      enabled: false\n      everyMinutes: 30\n"))
  assert.deepEqual(config.publish.github.issues, { enabled: false, everyMinutes: 30 })
  assert.equal(loadConfig(pipelineWithIssues("issues-min", "      everyMinutes: 1\n")).publish.github.issues.everyMinutes, 1)
  assert.equal(loadConfig(pipelineWithIssues("issues-max", "      everyMinutes: 1440\n")).publish.github.issues.everyMinutes, 1440)
})

test("config validation rejects publish.github.issues.everyMinutes outside 1 to 1440", () => {
  for (const value of ["0", "1441", "-5", "ten"]) {
    assert.throws(
      () => loadConfig(pipelineWithIssues(`issues-bad-${value.replace(/\W/g, "")}`, `      everyMinutes: ${value}\n`)),
      /publish\.github\.issues\.everyMinutes must be a number from 1 to 1440/,
    )
  }
})

test("loadConfig reads runners.codex with baseUrl and apiKeyEnv", () => {
  const config = loadConfig(pipelineWith("codex-full", "runners:\n  codex:\n    baseUrl: https://openrouter.ai/api/v1\n    apiKeyEnv: OPENROUTER_API_KEY\n"))
  assert.deepEqual(config.runners.codex, { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" })
  const local = loadConfig(pipelineWith("codex-url-only", "runners:\n  codex:\n    baseUrl: http://gpu-box:11434/v1\n"))
  assert.deepEqual(local.runners.codex, { baseUrl: "http://gpu-box:11434/v1", apiKeyEnv: null })
})

test("config validation rejects a codex base URL that is not http or https", () => {
  for (const value of ["ftp://x", "\"not a url\"", "openrouter.ai/api/v1"]) {
    assert.throws(
      () => loadConfig(pipelineWith(`codex-bad-url-${value.replace(/\W/g, "")}`, `runners:\n  codex:\n    baseUrl: ${value}\n`)),
      /Set codex base URL to a full http or https URL\./,
    )
  }
})

test("config validation rejects a codex apiKeyEnv that is not an env var name", () => {
  assert.throws(
    () => loadConfig(pipelineWith("codex-bad-env", "runners:\n  codex:\n    baseUrl: https://openrouter.ai/api/v1\n    apiKeyEnv: \"sk-123 abc\"\n")),
    /runners\.codex\.apiKeyEnv must be the name of an environment variable, not the key/,
  )
})

test("config validation rejects a codex apiKeyEnv without a baseUrl", () => {
  assert.throws(
    () => loadConfig(pipelineWith("codex-env-only", "runners:\n  codex:\n    apiKeyEnv: OPENROUTER_API_KEY\n")),
    /runners\.codex\.apiKeyEnv needs runners\.codex\.baseUrl/,
  )
})

test("pipeline.example.yaml shows both blocks commented, with an env var name for the key", () => {
  const example = readFileSync(join(import.meta.dirname, "..", "pipeline.example.yaml"), "utf8")
  assert.match(example, /^ {4}# issues:\n {4}# {3}enabled: true.*\n {4}# {3}everyMinutes: 10/m)
  assert.match(example, /^# runners:\n# {3}codex:\n# {5}baseUrl: https:\/\/\S+.*\n# {5}apiKeyEnv: [A-Z_][A-Z0-9_]*\s/m)
})
