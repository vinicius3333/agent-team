import { execFileSync } from "node:child_process"
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import { parseDocument } from "yaml"
import { importGitHubModes, type ImportGitHubMode, type PipelineConfig, type PlanningPhase } from "./config.ts"
import { commitAll, ensureIdentity, initRepository } from "./git.ts"
import { applyChoices, importCleanupKey, openChange, ProjectError, writeGitignore, type RoleModels } from "./project.ts"
import type { Change, Store } from "./store.ts"

const examplePipelinePath = new URL("../pipeline.example.yaml", import.meta.url)
const gitUrlPattern = /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/
const gitHubUrlPattern = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
// Gates that make sense for an import: the phases that write docs about the app.
export const importGates = ["spec", "architecture", "design"] as const satisfies readonly PlanningPhase[]
export const maxImportUrls = 10
// Folders a local copy leaves out: dependencies and build output are rebuilt, and the source's own state stays behind.
const skippedFolders = new Set(["node_modules", ".agent-team", ".next", "dist", "build", ".turbo", ".venv", "__pycache__"])

export interface ImportOptions {
  // A git URL, or the path of a local folder.
  source: string
  urls: string[]
  github: ImportGitHubMode
  target: PipelineConfig["target"]
  gates: PlanningPhase[]
  deploy: boolean
  roles?: RoleModels
}

export function parseGitHubRepository(url: string): { owner: string; name: string } | null {
  const match = gitHubUrlPattern.exec(url.trim())
  return match ? { owner: match[1], name: match[2] } : null
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim()
}

function commandError(error: unknown): string {
  const failure = error as { stderr?: string; message: string }
  return (failure.stderr || failure.message).trim().slice(0, 500)
}

export function validateImportOptions(options: ImportOptions): void {
  const source = options.source.trim()
  if (!source) throw new ProjectError(400, "Give the git URL or the folder to import.")
  const isUrl = gitUrlPattern.test(source)
  if (!isUrl) {
    if (!isAbsolute(source)) throw new ProjectError(400, "A local folder must be an absolute path.")
    if (!existsSync(source) || !statSync(source).isDirectory()) throw new ProjectError(400, `${source} is not a folder.`)
  }
  if (!(importGitHubModes as readonly string[]).includes(options.github)) throw new ProjectError(400, `The GitHub destination must be ${importGitHubModes.join(", ")}.`)
  if (options.github === "source" && !parseGitHubRepository(source)) throw new ProjectError(400, "Only a GitHub URL can use the source repository for pull requests. Pick a new repository or none.")
  if (options.urls.length > maxImportUrls) throw new ProjectError(400, `List at most ${maxImportUrls} extra URLs.`)
  for (const url of options.urls) {
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ProjectError(400, `"${url}" is not an http(s) URL.`)
  }
  for (const gate of options.gates) {
    if (!(importGates as readonly string[]).includes(gate)) throw new ProjectError(400, `An import can stop only at ${importGates.join(", ")}.`)
  }
}

// Stops before anything is copied when agent-team could not open pull requests on the source repository.
function requirePushAccess(source: string): void {
  const repository = parseGitHubRepository(source)!
  let canPush: string
  try {
    canPush = execFileSync("gh", ["api", `repos/${repository.owner}/${repository.name}`, "-q", ".permissions.push"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch (error) {
    throw new ProjectError(400, `Could not read ${repository.owner}/${repository.name} with gh: ${commandError(error)}`)
  }
  if (canPush !== "true") throw new ProjectError(400, `Your gh login cannot push to ${repository.owner}/${repository.name}. Pick a new repository or none.`)
}

function copyFolder(source: string, projectDir: string): void {
  cpSync(source, projectDir, {
    recursive: true,
    filter: (path) => !relative(source, path).split(/[\\/]/).some((segment) => skippedFolders.has(segment)),
  })
}

// Clones a git source (a URL or a local repository) or copies a plain folder, and leaves main checked out.
function bringSource(options: ImportOptions, projectDir: string): void {
  const source = options.source.trim()
  const localRepository = !gitUrlPattern.test(source) && existsSync(join(source, ".git"))
  if (gitUrlPattern.test(source) || localRepository) {
    try {
      execFileSync("git", ["clone", "-q", source, projectDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      throw new ProjectError(400, `Could not clone ${source}: ${commandError(error)}`)
    }
    const branch = git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])
    if (branch !== "main") {
      // Pull requests on the source repository target main, so its default branch must be main.
      if (options.github === "source") throw new ProjectError(400, `The default branch of ${source} is ${branch}, not main. Pick a new repository or none.`)
      git(projectDir, ["branch", "-m", branch, "main"])
    }
    // GitHub "new" creates origin itself, and "none" must never push, so only "source" keeps the clone's origin.
    if (options.github !== "source") git(projectDir, ["remote", "remove", "origin"])
    return
  }
  copyFolder(source, projectDir)
  initRepository(projectDir)
  commitAll(projectDir, `chore: import ${basename(source)}`)
}

function importBrief(options: ImportOptions): string {
  const lines = [
    "# Imported project",
    "",
    `This app already exists. It was imported from ${options.source.trim()}.`,
    "The importer describes it in docs/import/research.md. Later work comes in as change requests.",
  ]
  if (options.urls.length) lines.push("", "## Extra URLs", "", ...options.urls.map((url) => `- ${url}`))
  return `${lines.join("\n")}\n`
}

function importPipeline(options: ImportOptions, projectDir: string): string {
  const withChoices = applyChoices(readFileSync(examplePipelinePath, "utf8"), {
    target: options.target,
    gates: options.gates,
    github: options.github !== "none",
    deploy: options.deploy,
    branding: false,
    roles: options.roles,
  }, null)
  const document = parseDocument(withChoices)
  document.setIn(["marketing", "enabled"], false)
  const repository = options.github === "source" ? parseGitHubRepository(options.source) : null
  if (repository) {
    document.setIn(["publish", "github", "owner"], repository.owner)
    document.setIn(["publish", "github", "name"], repository.name)
    document.setIn(["publish", "github", "board"], false)
  } else if (options.github === "new") {
    document.setIn(["publish", "github", "name"], basename(projectDir))
  }
  // Agents in a container reach the internet only through the allowlist, so the importer needs the URLs' hosts on it.
  const hosts = [...new Set(options.urls.map((url) => new URL(url).hostname))]
  if (hosts.length) {
    const existing = (document.getIn(["harness", "network", "extraDomains"]) as { toJSON(): string[] } | undefined)?.toJSON() ?? []
    const domains = document.createNode([...new Set([...existing, ...hosts])])
    document.setIn(["harness", "network", "extraDomains"], domains)
  }
  document.set("import", document.createNode({ source: options.source.trim(), urls: options.urls, github: options.github }))
  return document.toString()
}

// Brings an existing app into projectDir as an agent-team project. The first run documents it instead of building it.
export function importProject(projectDir: string, options: ImportOptions): void {
  validateImportOptions(options)
  if (existsSync(projectDir) && readdirSync(projectDir).length > 0) throw new ProjectError(409, `${projectDir} already exists and is not empty`)
  if (options.github === "source") requirePushAccess(options.source)
  bringSource(options, projectDir)
  for (const file of ["pipeline.yaml", "input.md", "tasks.json"]) {
    if (existsSync(join(projectDir, file))) throw new ProjectError(409, `The source already has ${file}, which agent-team needs for itself.`)
  }
  writeGitignore(projectDir)
  writeFileSync(join(projectDir, "input.md"), importBrief(options))
  writeFileSync(join(projectDir, "pipeline.yaml"), importPipeline(options, projectDir))
  writeFileSync(join(projectDir, "tasks.json"), "[]\n")
  ensureIdentity(projectDir)
  commitAll(projectDir, "chore: import the project into agent-team")
}

// Opens the change the import baseline suggested. It never starts on its own.
export function startCleanupChange(projectDir: string, store: Store): Change {
  const request = store.meta(importCleanupKey)
  if (!request) throw new ProjectError(404, "There is no suggested cleanup change.")
  const change = openChange(projectDir, store, request)
  store.deleteMeta(importCleanupKey)
  return change
}

export function dismissCleanupChange(store: Store): void {
  if (!store.meta(importCleanupKey)) throw new ProjectError(404, "There is no suggested cleanup change.")
  store.deleteMeta(importCleanupKey)
  store.log("import", "suggested cleanup change dismissed")
}
