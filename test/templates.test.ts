import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { loadConfig } from "../src/config.ts"
import { detectDeployPlan } from "../src/deploy.ts"
import { deployFixTemplateLines, phasePrompt } from "../src/pipeline.ts"
import { createProject } from "../src/project.ts"
import { validateTasks } from "../src/tasks.ts"
import { commandMismatches, conflictingHints, listTemplates, loadTemplate, readStack, resolveCommands, stackFile, templatesDir, workspaceSetupCommand } from "../src/templates.ts"
import { startUi } from "../src/ui/server.ts"

const scratch = mkdtempSync(join(tmpdir(), "agent-team-templates-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
}

// A copy of the shipped node-api template in its own root, so a test can break it.
function copyTemplate(label: string): { root: string; dir: string } {
  const root = join(scratch, label)
  const dir = join(root, "node-api")
  cpSync(join(templatesDir, "node-api"), dir, { recursive: true, filter: (source) => !source.includes("node_modules") })
  return { root, dir }
}

function editManifest(dir: string, change: (manifest: any) => void): void {
  const path = join(dir, "template.json")
  const manifest = JSON.parse(readFileSync(path, "utf8"))
  change(manifest)
  writeFileSync(path, JSON.stringify(manifest))
}

test("every shipped template loads and its deploy.json matches the manifest", () => {
  const names = listTemplates().map((template) => template.name)
  assert.deepEqual(names, ["fullstack", "node-api", "react-vite"])
  for (const name of names) {
    const template = loadTemplate(name)
    assert.ok(template.commands.install && template.commands.test && template.commands.start)
    assert.ok(existsSync(join(template.dir, "scaffold", "package-lock.json")))
  }
  assert.deepEqual(loadTemplate("react-vite").targets, ["web"])
  assert.deepEqual(loadTemplate("fullstack").targets, ["web+api"])
})

test("loadTemplate lists every problem of a broken manifest", () => {
  const missingCommand = copyTemplate("missing-command")
  editManifest(missingCommand.dir, (manifest) => {
    delete manifest.commands.test
    manifest.targets = ["api", "desktop"]
  })
  assert.throws(() => loadTemplate("node-api", missingCommand.root), (error: Error) => {
    assert.match(error.message, /Invalid template node-api/)
    assert.match(error.message, /commands\.test is required/)
    assert.match(error.message, /unknown target "desktop"/)
    return true
  })

  const noScaffold = copyTemplate("no-scaffold")
  rmSync(join(noScaffold.dir, "scaffold"), { recursive: true })
  assert.throws(() => loadTemplate("node-api", noScaffold.root), /scaffold\/ is missing/)

  const wrongDeploy = copyTemplate("wrong-deploy")
  writeFileSync(join(wrongDeploy.dir, "scaffold", "deploy.json"), JSON.stringify({ install: "npm ci", start: "npm start", port: 3000 }))
  assert.throws(() => loadTemplate("node-api", wrongDeploy.root), /scaffold\/deploy\.json must be/)

  assert.throws(() => loadTemplate("nope", wrongDeploy.root), /Unknown stack template "nope"/)
})

test("resolveCommands prefers stack.json, then the architecture, then detection", () => {
  const dir = join(scratch, "resolve")
  mkdirSync(join(dir, "docs"), { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", start: "node server.js" } }))
  writeFileSync(join(dir, "package-lock.json"), "{}")

  const detected = resolveCommands(dir)
  assert.equal(detected.source, "detected")
  assert.equal(detected.install, "npm ci --no-audit --no-fund")
  assert.equal(detected.test, "npm test")
  assert.deepEqual(detected.deploy, { install: "npm ci --no-audit --no-fund", start: "npm start", port: 3000 })

  writeFileSync(join(dir, "docs/architecture.md"), "## Commands\n\n- install: npm install\n- test: npm run test:unit\n- dev: npm run dev\n")
  writeFileSync(join(dir, "deploy.json"), JSON.stringify({ install: "npm ci && npm run build", start: "node dist/server.js", port: 8080 }))
  const architecture = resolveCommands(dir)
  assert.equal(architecture.source, "architecture")
  assert.equal(architecture.install, "npm install")
  assert.equal(architecture.test, "npm run test:unit")
  assert.deepEqual(architecture.deploy, { install: "npm ci && npm run build", start: "node dist/server.js", port: 8080 })
  assert.equal(workspaceSetupCommand(dir), "npm ci --no-audit --no-fund")

  const template = loadTemplate("node-api")
  const { dir: _dir, ...manifest } = template
  writeFileSync(join(dir, stackFile), JSON.stringify(manifest))
  const pinned = resolveCommands(dir)
  assert.equal(pinned.source, "template")
  assert.equal(pinned.install, template.commands.install)
  assert.equal(pinned.test, "npm test")
  assert.equal(pinned.typecheck, "npm run typecheck")
  assert.deepEqual(detectDeployPlan(dir), { install: `${template.commands.install} && npm run build`, start: "npm start", port: 3000 })
  assert.equal(workspaceSetupCommand(dir), template.commands.install)
})

test("createProject with a template commits the scaffold first and pins the version", () => {
  const projectDir = join(scratch, "from-template")
  createProject(projectDir, "An API for notes", { target: "api", template: "node-api" })
  const version = loadTemplate("node-api").version
  assert.deepEqual(git(projectDir, ["log", "--format=%s"]).split("\n"), ["chore: start project from brief", `chore: start from node-api template v${version}`])
  const firstCommit = git(projectDir, ["show", "--name-only", "--format=", "HEAD~1"]).split("\n")
  for (const file of ["stack.json", "package.json", "package-lock.json", "deploy.json", "src/app.ts", "tests/health.test.ts", ".gitignore"]) assert.ok(firstCommit.includes(file), `${file} is in the first commit`)
  assert.ok(!firstCommit.includes("input.md"))
  assert.match(readFileSync(join(projectDir, ".gitignore"), "utf8"), /^\.agent-team\/\nnode_modules\/\ndist\//)
  assert.equal(readStack(projectDir)?.version, version)
  const config = loadConfig(join(projectDir, "pipeline.yaml"))
  assert.deepEqual(config.template, { name: "node-api", version })
  assert.equal(config.target, "api")
})

test("createProject without a template keeps today's layout", () => {
  const projectDir = join(scratch, "custom")
  createProject(projectDir, "brief")
  assert.deepEqual(git(projectDir, ["log", "--format=%s"]).split("\n"), ["chore: start project from brief"])
  assert.equal(readStack(projectDir), null)
  assert.equal(loadConfig(join(projectDir, "pipeline.yaml")).template, null)
  assert.throws(() => createProject(join(scratch, "mismatch"), "brief", { target: "web", template: "node-api" }), /serves api, not web/)
  assert.throws(() => createProject(join(scratch, "unknown"), "brief", { template: "rails" }), /Unknown stack template "rails"/)
})

test("a pinned project loads after its template folder is gone", () => {
  const projectDir = join(scratch, "orphan")
  createProject(projectDir, "brief", { target: "api", template: "node-api" })
  const path = join(projectDir, "pipeline.yaml")
  writeFileSync(path, readFileSync(path, "utf8").replace(/template: .*/, "template: { name: retired-template, version: 3 }"))
  const stack = readStack(projectDir)!
  writeFileSync(join(projectDir, stackFile), JSON.stringify({ ...stack, name: "retired-template", version: 3 }))
  assert.deepEqual(loadConfig(path).template, { name: "retired-template", version: 3 })
  rmSync(join(projectDir, stackFile))
  assert.throws(() => loadConfig(path), /unknown template "retired-template"/)
})

test("the architect and planner prompts carry the template only when one is set", () => {
  const customDir = join(scratch, "prompt-custom")
  createProject(customDir, "brief")
  const custom = { projectDir: customDir, config: loadConfig(join(customDir, "pipeline.yaml")) }
  assert.doesNotMatch(phasePrompt(custom, "architecture", null), /Stack template/)
  assert.doesNotMatch(phasePrompt(custom, "plan", null), /scaffold is already committed/)

  const templateDir = join(scratch, "prompt-template")
  createProject(templateDir, "brief", { target: "api", template: "node-api" })
  const config = loadConfig(join(templateDir, "pipeline.yaml"))
  const pinned = { projectDir: templateDir, config: { ...config, stackHints: { prefer: ["zod"], avoid: ["fastify", "redis"] } } }
  const architect = phasePrompt(pinned, "architecture", null)
  assert.match(architect, /Stack template: Node\.js \+ TypeScript API \(node-api v1\)/)
  assert.match(architect, /Do not replace the framework, test runner, or database/)
  assert.match(architect, /- test: npm test/)
  assert.match(architect, /Do not write deploy\.json or stack\.json/)
  assert.match(architect, /Avoid: redis\./)
  assert.doesNotMatch(architect, /Avoid: .*fastify/)
  const planner = phasePrompt(pinned, "plan", null)
  assert.match(planner, /The scaffold is already committed\. Do not add a scaffold task\./)
  assert.match(planner, /The foundation-only files are: package\.json, package-lock\.json/)
  assert.doesNotMatch(phasePrompt(pinned, "spec", null), /Stack template/)
  assert.deepEqual(conflictingHints(readStack(templateDir)!, ["fastify", "redis", "SQLite"]), ["fastify", "SQLite"])
  assert.match(deployFixTemplateLines(templateDir).join("\n"), /Keep deploy\.json equal to/)
  assert.deepEqual(deployFixTemplateLines(customDir), [])
})

test("the architecture must copy the template commands", () => {
  const stack = readStack(join(scratch, "from-template"))!
  const matching = `## Commands\n\n- install: ${stack.commands.install}\n- test: npm test\n- dev: npm run dev\n`
  assert.deepEqual(commandMismatches(matching, stack), [])
  const changed = commandMismatches("## Commands\n\n- install: pnpm install\n- test: npx jest\n", stack)
  assert.equal(changed.length, 3)
  assert.match(changed[0], /install must be/)
  assert.match(changed[2], /dev must be `npm run dev`, not missing/)
})

test("a feature task may not touch the template's shared paths", () => {
  const task = (id: string, phase: string, allowedPaths: string[]) => ({ id, title: id, phase, dependsOn: [], allowedPaths, readPaths: [], acceptance: ["works"], verify: "npm test" })
  const shared = ["package.json", "src/routes/index.ts"]
  assert.doesNotThrow(() => validateTasks([task("T001", "foundation", ["package.json", "src/**"])], shared))
  assert.throws(() => validateTasks([task("T002", "feature", ["src/**", "tests/**"])], shared), /T002: feature tasks may not touch the shared file src\/routes\/index\.ts/)
  assert.doesNotThrow(() => validateTasks([task("T003", "feature", ["src/features/notes/**"])], shared))
  assert.doesNotThrow(() => validateTasks([task("T004", "feature", ["src/**"])]))
})

test("the server lists templates and rejects bad template choices", async (t) => {
  const runsDir = join(scratch, "runs")
  const server = startUi({ runsDir, port: 0, startRun: () => {} })
  await once(server, "listening")
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const templates = await (await fetch(`${base}/api/templates`)).json()
  assert.deepEqual(templates.map((template: { name: string }) => template.name), ["fullstack", "node-api", "react-vite"])
  assert.deepEqual(Object.keys(templates[0]).sort(), ["description", "name", "targets", "title", "version"])

  const post = (body: Record<string, unknown>) =>
    fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-agent-team": "1" }, body: JSON.stringify({ name: "notes", brief: "Notes", gates: [], github: false, deploy: false, branding: false, ...body }) })
  const unknown = await post({ target: "api", template: "rails" })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /Unknown stack template "rails"/)
  const mismatch = await post({ target: "web", template: "node-api" })
  assert.equal(mismatch.status, 400)
  assert.match((await mismatch.json()).error, /serves api, not web/)
  assert.equal((await post({ target: "api", template: 7 })).status, 400)

  assert.equal((await post({ target: "api", template: "node-api" })).status, 201)
  const detail = await (await fetch(`${base}/api/projects/notes`)).json()
  assert.deepEqual(detail.config.template, { name: "node-api", version: 1, latest: 1 })
})
