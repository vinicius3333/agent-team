import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectSetupCommand } from "./harness/workspace.ts"
import { parseArchitectureCommands } from "./qa.ts"

export const templatesDir = fileURLToPath(new URL("../templates/", import.meta.url))
// The tracked copy of the manifest in a project; .agent-team/ is gitignored, so it cannot live there.
export const stackFile = "stack.json"
export const customTemplate = "custom"
export const templateTargets = ["web", "api", "web+api"] as const
export type TemplateTarget = (typeof templateTargets)[number]

const templateNamePattern = /^[a-z0-9][a-z0-9-]{0,40}$/
const requiredCommands = ["install", "test", "dev", "start"] as const
const optionalCommands = ["build", "typecheck"] as const
const defaultPort = 3000

export interface TemplateCommands {
  install: string
  build?: string
  typecheck?: string
  test: string
  dev: string
  start: string
}

export interface StackManifest {
  name: string
  version: number
  title: string
  description: string
  targets: TemplateTarget[]
  commands: TemplateCommands
  port: number
  // Tools the template fixes; an `avoid` stack hint that names one of them loses to the template.
  stack: string[]
  sharedPaths: string[]
  featureLayout: string
  conventions: string[]
}

export interface StackTemplate extends StackManifest {
  dir: string
}

export interface DeployPlan {
  install: string | null
  start: string
  port: number
}

export type CommandSource = "template" | "architecture" | "detected"

export interface ResolvedCommands {
  source: CommandSource
  install: string | null
  build: string | null
  typecheck: string | null
  test: string | null
  deploy: DeployPlan | null
}

// deploy.json in a scaffold must equal this, so deploy runs the same commands the manifest names.
export function templateDeployPlan(manifest: StackManifest): DeployPlan {
  return { install: [manifest.commands.install, manifest.commands.build].filter(Boolean).join(" && "), start: manifest.commands.start, port: manifest.port }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function manifestProblems(raw: any, dir: string): string[] {
  const problems: string[] = []
  if (typeof raw?.name !== "string" || raw.name !== basename(dir)) problems.push(`name must be "${basename(dir)}", the folder name`)
  if (!Number.isInteger(raw?.version) || raw.version < 1) problems.push("version must be a whole number of 1 or more")
  for (const field of ["title", "description", "featureLayout"]) {
    if (typeof raw?.[field] !== "string" || !raw[field].trim()) problems.push(`${field} is required`)
  }
  if (!Array.isArray(raw?.targets) || !raw.targets.length) problems.push("targets needs at least one of web, api, web+api")
  for (const target of Array.isArray(raw?.targets) ? raw.targets : []) {
    if (!(templateTargets as readonly unknown[]).includes(target)) problems.push(`unknown target "${target}"; use web, api, or web+api`)
  }
  for (const command of requiredCommands) {
    if (typeof raw?.commands?.[command] !== "string" || !raw.commands[command].trim()) problems.push(`commands.${command} is required`)
  }
  for (const command of optionalCommands) {
    if (raw?.commands?.[command] !== undefined && typeof raw.commands[command] !== "string") problems.push(`commands.${command} must be a string`)
  }
  if (!Number.isInteger(raw?.port) || raw.port < 1 || raw.port > 65535) problems.push("port must be a whole number from 1 to 65535")
  for (const field of ["stack", "sharedPaths", "conventions"]) {
    if (!isStringArray(raw?.[field])) problems.push(`${field} must be an array of strings`)
  }
  const scaffold = join(dir, "scaffold")
  if (!existsSync(scaffold) || !statSync(scaffold).isDirectory()) {
    problems.push("scaffold/ is missing")
    return problems
  }
  if (!existsSync(join(scaffold, "package-lock.json"))) problems.push("scaffold/package-lock.json is missing")
  const deployPath = join(scaffold, "deploy.json")
  if (!existsSync(deployPath)) problems.push("scaffold/deploy.json is missing")
  else if (!problems.some((problem) => problem.startsWith("commands.") || problem.startsWith("port"))) {
    const expected = templateDeployPlan(raw)
    let actual: any
    try {
      actual = JSON.parse(readFileSync(deployPath, "utf8"))
    } catch {
      actual = null
    }
    if (actual?.install !== expected.install || actual?.start !== expected.start || actual?.port !== expected.port) {
      problems.push(`scaffold/deploy.json must be ${JSON.stringify(expected)}`)
    }
  }
  return problems
}

export function loadTemplate(name: string, root = templatesDir): StackTemplate {
  const dir = join(root, name)
  if (!templateNamePattern.test(name) || !existsSync(join(dir, "template.json"))) {
    const known = listTemplateNames(root)
    throw new Error(`Unknown stack template "${name}". Templates: ${known.length ? known.join(", ") : "none"}.`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, "template.json"), "utf8"))
  } catch (error) {
    throw new Error(`Invalid template ${name}:\n- template.json is not valid JSON: ${(error as Error).message}`)
  }
  const problems = manifestProblems(raw, dir)
  if (problems.length) throw new Error(`Invalid template ${name}:\n- ${problems.join("\n- ")}`)
  return { ...(raw as StackManifest), dir }
}

function listTemplateNames(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => templateNamePattern.test(name) && existsSync(join(root, name, "template.json")))
    .sort()
}

export function listTemplates(root = templatesDir): StackTemplate[] {
  return listTemplateNames(root).map((name) => loadTemplate(name, root))
}

// Returns null when the template folder is gone; a project then keeps working from its own stack.json.
export function findTemplate(name: string, root = templatesDir): StackTemplate | null {
  return listTemplateNames(root).includes(name) ? loadTemplate(name, root) : null
}

export function manifestOf(template: StackTemplate): StackManifest {
  const { dir: _dir, ...manifest } = template
  return manifest
}

// Copies the scaffold into a new project and writes stack.json next to it.
export function applyTemplate(template: StackTemplate, projectDir: string): void {
  cpSync(join(template.dir, "scaffold"), projectDir, {
    recursive: true,
    filter: (source) => !["node_modules", "dist"].includes(basename(source)),
  })
  writeFileSync(join(projectDir, stackFile), `${JSON.stringify(manifestOf(template), null, 2)}\n`)
}

export function readStack(dir: string): StackManifest | null {
  const path = join(dir, stackFile)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StackManifest
  } catch (error) {
    throw new Error(`${stackFile} is not valid JSON: ${(error as Error).message}`)
  }
}

function packageScripts(dir: string): Record<string, string> {
  const path = join(dir, "package.json")
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf8")).scripts ?? {}
}

function readDeployManifest(dir: string): DeployPlan | null {
  const path = join(dir, "deploy.json")
  if (!existsSync(path)) return null
  const manifest = JSON.parse(readFileSync(path, "utf8"))
  if (typeof manifest.start !== "string") throw new Error("deploy.json needs a start command")
  return { install: manifest.install ?? null, start: manifest.start, port: manifest.port ?? defaultPort }
}

// The fallback when neither stack.json nor deploy.json exists: npm start, then a static index.html.
function detectDeployFromFiles(dir: string): DeployPlan | null {
  const hasPackage = existsSync(join(dir, "package.json"))
  const install = existsSync(join(dir, "package-lock.json")) ? "npm ci --no-audit --no-fund" : hasPackage ? "npm install --no-audit --no-fund" : null
  if (packageScripts(dir).start) return { install, start: "npm start", port: defaultPort }
  for (const staticDir of ["dist", "public", "."]) {
    if (existsSync(join(dir, staticDir, "index.html"))) {
      return { install: null, start: `npx --yes serve -s ${staticDir} -l tcp://0.0.0.0:${defaultPort}`, port: defaultPort }
    }
  }
  return null
}

// One place for install, test, and start commands: stack.json, then docs/architecture.md and deploy.json, then detection.
export function resolveCommands(dir: string): ResolvedCommands {
  const stack = readStack(dir)
  if (stack) {
    return {
      source: "template",
      install: stack.commands.install,
      build: stack.commands.build ?? null,
      typecheck: stack.commands.typecheck ?? null,
      test: stack.commands.test,
      deploy: templateDeployPlan(stack),
    }
  }
  const architecturePath = join(dir, "docs/architecture.md")
  const architecture = parseArchitectureCommands(existsSync(architecturePath) ? readFileSync(architecturePath, "utf8") : "")
  const deployManifest = readDeployManifest(dir)
  const scripts = packageScripts(dir)
  return {
    source: architecture.install || architecture.test || deployManifest ? "architecture" : "detected",
    install: architecture.install ?? detectSetupCommand(dir),
    build: scripts.build ? "npm run build" : null,
    typecheck: scripts.typecheck ? "npm run typecheck" : null,
    test: architecture.test ?? (scripts.test ? "npm test" : null),
    deploy: deployManifest ?? detectDeployFromFiles(dir),
  }
}

// Custom projects keep lockfile detection for worktree setup, as before templates existed.
export function workspaceSetupCommand(dir: string): string | null {
  return readStack(dir)?.commands.install ?? detectSetupCommand(dir)
}

export function formatCommands(commands: ResolvedCommands): string {
  const deploy = commands.deploy ? `${commands.deploy.install ? `${commands.deploy.install} && ` : ""}${commands.deploy.start} (port ${commands.deploy.port})` : "none"
  return `source ${commands.source}; install: ${commands.install ?? "none"}; test: ${commands.test ?? "none"}; build: ${commands.build ?? "none"}; typecheck: ${commands.typecheck ?? "none"}; deploy: ${deploy}`
}

// Reads every `- name: command` line under `## Commands`.
export function parseCommandLines(markdown: string): Record<string, string> {
  const commands: Record<string, string> = {}
  let inSection = false
  for (const line of markdown.split("\n")) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s+Commands\s*$/i.test(line.trim())
      continue
    }
    const match = inSection ? /^\s*[-*]?\s*([a-z]+)\s*:\s*`?(.+?)`?\s*$/i.exec(line) : null
    if (match) commands[match[1].toLowerCase()] = match[2].trim()
  }
  return commands
}

// The architect copies install, test, and dev into `## Commands`; any other value means it changed the stack.
export function commandMismatches(markdown: string, stack: StackManifest): string[] {
  const written = parseCommandLines(markdown)
  return (["install", "test", "dev"] as const)
    .filter((name) => written[name] !== stack.commands[name])
    .map((name) => `${name} must be \`${stack.commands[name]}\`, not ${written[name] ? `\`${written[name]}\`` : "missing"}`)
}

// `avoid` hints that name a tool the template fixes. The template wins; the caller logs each one.
export function conflictingHints(stack: StackManifest, avoid: string[]): string[] {
  const tools = stack.stack.map((tool) => tool.toLowerCase())
  return avoid.filter((hint) => {
    const normalized = hint.toLowerCase().trim()
    return normalized && tools.some((tool) => tool.includes(normalized) || normalized.includes(tool))
  })
}

export function templatePromptLines(stack: StackManifest, role: "architect" | "planner"): string[] {
  if (role === "planner") {
    return [
      `Stack template: ${stack.title} (${stack.name} v${stack.version}).`,
      "The scaffold is already committed. Do not add a scaffold task.",
      `The foundation-only files are: ${stack.sharedPaths.join(", ")}.`,
      `Feature layout: ${stack.featureLayout}.`,
      `Use these commands in verify: typecheck \`${stack.commands.typecheck ?? "none"}\`, test \`${stack.commands.test}\`, build \`${stack.commands.build ?? "none"}\`.`,
      `${stackFile} and deploy.json are never in allowedPaths.`,
      ...(readTemplateNotes(stack.name)?.includes("track(") ? ["The template has a track() analytics helper: apply rule 16."] : []),
    ]
  }
  const readme = readTemplateNotes(stack.name)
  return [
    `Stack template: ${stack.title} (${stack.name} v${stack.version}). ${stack.description}`,
    "Keep the stack, commands, and shared paths of the template. Design features inside it. Do not replace the framework, test runner, or database. If the spec cannot fit, explain why in an ADR and stop.",
    "Copy these commands into `## Commands` of docs/architecture.md and AGENTS.md exactly:",
    `- install: ${stack.commands.install}`,
    `- test: ${stack.commands.test}`,
    `- dev: ${stack.commands.dev}`,
    `Other commands: build \`${stack.commands.build ?? "none"}\`, typecheck \`${stack.commands.typecheck ?? "none"}\`, start \`${stack.commands.start}\` on port ${stack.port}.`,
    `Shared paths (foundation only): ${stack.sharedPaths.join(", ")}.`,
    `Feature layout: ${stack.featureLayout}.`,
    ...stack.conventions.map((convention) => `Convention: ${convention}`),
    `Do not write deploy.json or ${stackFile}: the scaffold owns them.`,
    ...(readme ? ["", "Template notes:", readme.trim()] : []),
  ]
}

function readTemplateNotes(name: string): string | null {
  const path = join(templatesDir, name, "architecture.md")
  return existsSync(path) ? readFileSync(path, "utf8") : null
}
