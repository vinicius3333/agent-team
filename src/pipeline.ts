import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { ensureDemoAccess } from "./access.ts"
import { loadConfig, type Candidate, type PipelineConfig, type PlanningPhase, type Role } from "./config.ts"
import { groupPhaseFiles, parseCommitPlan, type PhaseCommit } from "./commits.ts"
import { faviconDir, faviconFiles, generateFavicons, markPath, validateMark } from "./favicon.ts"
import { copyPath, manifestPath, marketingDir, renderMarketing, validateMarketing } from "./marketing.ts"
import { baselinePath, cleanupRequest, createBaseline, gateFailures, nextBaselinePath, promoteNextBaseline, readBaseline, splitFailures, writeBaseline } from "./baseline.ts"
import { changedFiles, commitOf, commitPaths, fileAtRef, isAncestor, restorePaths, stagedDiff, trackedFiles } from "./git.ts"
import { createDockerExecutor, ensureImage } from "./harness/docker.ts"
import { hostExecutor, type Executor } from "./harness/executor.ts"
import { defaultAllowlist, ensureEgressProxy } from "./harness/network.ts"
import type { Harness, HarnessOutcome } from "./harness/harness.ts"
import { amendCommit, commitAndRebase, createWorkspace, fastForward, mergeInto, mergeIntoMain, removeWorkspace, type Workspace } from "./harness/workspace.ts"
import { appContainerRunning, appLimitsText, deployErrorKey, deployProject, recordDeployResult } from "./deploy.ts"
import { missingSecrets, projectSecretStatuses, secretsWaitingText } from "./secrets.ts"
import { archiveFeedback, readFeedback } from "./feedback.ts"
import { changeTitle, type GitHub } from "./github.ts"
import { changePath, importCleanupKey, importDoneKey } from "./project.ts"
import { designSystemRoute, noPageRendered, noPageRenderedMessage, parseDesignScreens, parseLoginRoute, parseQaVerdict, runQaLoop, type QaRoundResult, type QaScreen } from "./qa.ts"
import { extractJsonObject } from "./json.ts"
import { conceptChoiceKey, conceptIds, conceptsDir } from "./concepts.ts"
import { autoStyle, chosenStyleId, conceptStyleProblems, styleCatalogDir, styleNotes, writeStyleCatalog } from "./design-styles.ts"
import { learnLessons } from "./improve.ts"
import { formatLessons, lessonsFor, lessonsPath, loadLessons, projectStacks } from "./lessons.ts"
import { formatSolutions, memoryPath, recordSolution, searchSolutions, type Solution } from "./memory.ts"
import { changeTaskConflict, decideReplan, formatBlock, normalizeFailure, parseBlock, parseReplanAction, suggestedPaths, type Block, type ReplanDecision } from "./replan.ts"
import { budgetReachedPrefix, changeMergedPrefix, changeOpenedPrefix, changeWaitingText, gateReadyText, humanDecisionText } from "./notify/events.ts"
import { diffFileHashes, flaggedFiles } from "./reviews.ts"
import { captureScreenshots, type VisualReport } from "./screenshots.ts"
import { runUiSmoke, type SmokeCheck } from "./smoke.ts"
import { taskBudgetKey, taskBudgetStopKey, type Change, type Store } from "./store.ts"
import { filesOutsideScope, loadTasks, nextTaskId, orderTasks, parseTasks, pathsOverlap, validateTasks, widenTask, type Task } from "./tasks.ts"
import { commandMismatches, conflictingHints, formatCommands, readStack, resolveCommands, stackFile, templateDeployPlan, templatePromptLines, workspaceSetupCommand } from "./templates.ts"

const phaseAttempts = 2
const deployAttempts = 3
const commandTimeoutMs = 10 * 60 * 1000
const planningTools = ["read", "edit", "write", "bash:mkdir", "bash:ls"]
const reviewerTools = ["read"]
const qaTools = ["read"]
const replannerTools = ["read"]
const reviewAttempts = 2
// Design review rounds per phase attempt: review, fix, review again.
const designReviewRounds = 2
const maxReplansPerTask = 1
const maxAttemptDiffLength = 40_000
const maxListedFiles = 300
const maxCodeMapLines = 200
const maxSummaryLines = 3
const progressPath = "docs/progress.md"
const smokePassedKey = "smoke.passedOnce"
// Illustration files drawn by the illustrator; workers copy them into the app instead of drawing their own.
const illustrationsDir = "design/illustrations"
// Screenshots of the running app, copied into a change's branding worktree as the style reference and removed before the commit.
const appReferenceDir = ".reference"
// Written by the architect and the orchestrator; no worker may edit them, whatever its allowedPaths say.
const orchestratorFiles = ["AGENTS.md", "CLAUDE.md", progressPath, stackFile]
const lockfileNames = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum"])
const assetPattern = /\.(png|jpe?g|gif|webp|avif|ico|svg|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|pdf|zip|gz)$/i

interface PhaseDefinition {
  role: Role
  inputs: string[]
  outputs: string[]
  validate: (projectDir: string, config: PipelineConfig) => void
  // One commit per entry, in order; files no entry matches land in the phase commit.
  commits?: PhaseCommit[]
  // The design reviewer approves the output before it lands; on a rejection the phase agent fixes it in place.
  reviewed?: boolean
  // Replaces the planning tools, for a phase that also reads the web.
  tools?: string[]
  // System prompt file in prompts/, when it differs from the role name.
  promptName?: string
}

// research runs only while a project is imported; the others are the planning phases.
type PhaseName = PlanningPhase | "research"

// A phase agent run that writes part of the outputs. Phases without steps run their agent once.
interface PhaseStep {
  name: string
  instructions: string
  validate: (dir: string, config: PipelineConfig) => void
  // Runs before the agent, for files the orchestrator puts in the worktree for it to read.
  before?: (context: PipelineContext, dir: string) => void
  // Runs after the step's output is valid, for work the orchestrator does itself.
  after?: (context: PipelineContext, dir: string) => Promise<void>
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
    outputs: ["docs/architecture.md", "docs/adr/", "contracts/openapi.yaml (if the app has an API)", "AGENTS.md"],
    validate: (dir, config) => {
      requireHeadings(join(dir, "docs/architecture.md"), ["## Commands"])
      requireHeadings(join(dir, "AGENTS.md"), ["## Commands"])
      validateTemplateArchitecture(dir, config)
    },
  },
  concepts: {
    role: "illustrator",
    promptName: "concepts",
    inputs: ["input.md", "docs/spec.md", "docs/architecture.md"],
    outputs: [
      `${conceptsDir}/<a, b, c...>/logo.png`,
      `${conceptsDir}/<a, b, c...>/landing.png`,
      `${conceptsDir}/<a, b, c...>/style.md`,
      `${conceptsDir}/README.md`,
    ],
    validate: (dir, config) => void validateConcepts(dir, config.branding.variations, config.branding.style),
    commits: [{ message: "design(concepts): add the logo and style directions", matches: [`${conceptsDir}/**`] }],
    reviewed: true,
  },
  branding: {
    role: "illustrator",
    inputs: ["input.md", "docs/spec.md", "docs/architecture.md"],
    outputs: [
      "design/branding/01-logo.png",
      "design/branding/02-<screen>.png and later desktop screens",
      "design/branding/02-<screen>.mobile.png and so on, when mobile screens are on",
      "design/branding/README.md",
      `${illustrationsDir}/hero.png and the other illustrations the screens show`,
    ],
    validate: (dir, config) => validateBranding(dir, config.branding.count, config.branding.mobile, config.branding.dark),
    commits: [
      { message: "design(branding): add the logo", matches: ["design/branding/01-logo.*"] },
      { message: "design(branding): add the desktop screens", matches: ["design/branding/*"], exclude: ["design/branding/*.mobile.*", "design/branding/*.dark.*", "design/branding/*.md"] },
      { message: "design(branding): add the mobile screens", matches: ["design/branding/*.mobile.*"] },
      { message: "design(branding): add the dark landing", matches: ["design/branding/*.dark.*"] },
      { message: "design(illustrations): add the illustrations", matches: [`${illustrationsDir}/*`] },
    ],
    reviewed: true,
  },
  design: {
    role: "designer",
    inputs: [
      "docs/spec.md",
      "docs/architecture.md",
      "contracts/",
      "design/branding/ (logo, desktop and mobile screen images: open and study every one, build the design system from them)",
    ],
    outputs: ["design/tokens.css", "design/logo.svg", "design/logo-mark.svg", "docs/design-system.md", "docs/design.md"],
    validate: (dir, config) => {
      validateDesignSystem(dir, config)
      if (!config.import) for (const file of faviconFiles) requireFile(join(dir, faviconDir, file))
      validateScreens(dir, config)
    },
    commits: [
      { message: "design(tokens): add the theme tokens", matches: ["design/tokens.css"] },
      { message: "design(logo): add the logo and the mark", matches: ["design/logo.svg", "design/logo-mark.svg"] },
      { message: "design(favicon): add the favicon set", matches: [`${faviconDir}/**`] },
      { message: "docs(design): add the design system", matches: ["docs/design-system.md"] },
      { message: "docs(design): add the screen designs", matches: ["docs/design.md"] },
    ],
    reviewed: true,
  },
  marketing: {
    role: "marketer",
    inputs: [
      "input.md",
      "docs/spec.md",
      "design/logo.svg",
      "design/tokens.css",
      "docs/design-system.md",
      "design/branding/ (for the look, not for the art)",
    ],
    outputs: [copyPath, `${marketingDir}/art/<piece>.png or .jpg`],
    validate: (dir, config) => void validateMarketing(dir, config.marketing.pieces),
    commits: [
      { message: "design(marketing): add the copy and the art", matches: [copyPath, `${marketingDir}/art/*`] },
      { message: "design(marketing): add the rendered pieces", matches: [`${marketingDir}/*`] },
    ],
    reviewed: true,
  },
  plan: {
    role: "planner",
    inputs: ["docs/spec.md", "docs/architecture.md", "docs/design.md", "contracts/"],
    outputs: ["tasks.json", "docs/analytics.md (only when the stack template has a track() helper)"],
    validate: (dir) => {
      if (!loadTasks(join(dir, "tasks.json"), readStack(dir)?.sharedPaths).length) throw new Error("tasks.json must list at least one task")
    },
  },
}

const designSteps: PhaseStep[] = [
  {
    name: "system",
    instructions: [
      "Step 1 of 2: the design system.",
      "Write design/tokens.css, design/logo.svg, design/logo-mark.svg, and docs/design-system.md. Do not write docs/design.md yet.",
      `After this step the orchestrator renders the favicon set in ${faviconDir}/ from design/logo-mark.svg.`,
    ].join("\n"),
    validate: validateDesignSystem,
    after: async (context, dir) => {
      await (context.renderFavicons ?? generateFavicons)({ dir, name: productName(context.projectDir, dir), signal: context.signal })
      context.store.log("phase", `design: rendered ${faviconFiles.length} favicon files from ${markPath}`)
    },
  },
  {
    name: "screens",
    instructions: [
      "Step 2 of 2: the screens.",
      `design/tokens.css, the logos, docs/design-system.md, and ${faviconDir}/ exist. Read them, then write docs/design.md.`,
      "Change the step 1 files only to fix a real mistake.",
    ].join("\n"),
    validate: validateScreens,
  },
]

const marketingSteps: PhaseStep[] = [
  {
    name: "marketing",
    instructions: `After you finish, the orchestrator renders every piece into ${marketingDir}/<piece>-<format>.png from your copy, your art, design/logo.svg, and design/tokens.css. Do not render them yourself.`,
    validate: (dir, config) => void validateMarketing(dir, config.marketing.pieces),
    after: async (context, dir) => {
      const { marketing } = context.config
      const manifest = await (context.renderMarketing ?? renderMarketing)({ dir, productName: productName(context.projectDir, dir), formats: marketing.formats, expectedPieces: marketing.pieces, signal: context.signal })
      context.store.log("phase", `marketing: rendered ${manifest.pieces.length} pieces in ${marketing.formats.length} formats`)
    },
  },
]

const specDeltaHeadings = ["## Change", "## New or changed user stories", "## Out of scope", "## Open questions"]
const architectureDeltaHeadings = ["## Changes", "## New dependencies", "## Data migrations", "## Risks"]
const designNeededPattern = /^\s*Design:\s*needed\b/i

// A change reruns spec, architecture, and plan (and design when the architecture delta asks for it) against the app as it is.
// The agents write a delta under docs/changes/<id>/ and edit the full documents in place.
function changePhaseDefinition(context: PipelineContext, phase: PlanningPhase, change: Change): PhaseDefinition {
  const base = phaseDefinitions[phase]
  const { id } = change
  switch (phase) {
    case "spec":
      return {
        ...base,
        inputs: ["input.md", "docs/spec.md", changePath(id, "request.md")],
        outputs: [changePath(id, "spec.md"), "docs/spec.md (edited in place)"],
        validate: (dir, config) => {
          base.validate(dir, config)
          validateSpecDelta(dir, id)
        },
      }
    case "architecture":
      return {
        ...base,
        inputs: [changePath(id, "spec.md"), "docs/spec.md", "docs/architecture.md", "AGENTS.md", "contracts/"],
        outputs: [changePath(id, "architecture.md"), "docs/architecture.md and AGENTS.md (edited only where they change)", "docs/adr/ (a new ADR when a decision changes)"],
        validate: (dir, config) => {
          base.validate(dir, config)
          requireHeadings(join(dir, changePath(id, "architecture.md")), architectureDeltaHeadings)
        },
      }
    case "branding": {
      const before = brandingImages(context.projectDir)
      return {
        ...base,
        inputs: [changePath(id, "spec.md"), changePath(id, "architecture.md"), "design/branding/ (existing images, their .prompt.txt files, and the README Style section)", `${appReferenceDir}/ (screenshots of the running app)`],
        outputs: ["design/branding/<next number>-<screen>.png for each new or changed screen, with a .mobile version and a .prompt.txt", "design/branding/README.md (new lines)"],
        validate: (dir) => {
          requireFile(join(dir, "design/branding/README.md"))
          const added = brandingImages(dir).filter((file) => !before.includes(file))
          if (!added.length) throw new Error("design/branding/ has no new screen image for the change")
        },
      }
    }
    case "design": {
      const tokensBefore = cssVariables(fileAtRef(context.projectDir, change.branch, "design/tokens.css") ?? "")
      return {
        ...base,
        inputs: [changePath(id, "spec.md"), changePath(id, "architecture.md"), "docs/design.md", "docs/design-system.md", "design/tokens.css", "design/branding/ (the new screen images for this change, when there are any: follow them)"],
        outputs: ["docs/design.md (new Route: lines)", "design/tokens.css (new tokens only)"],
        validate: (dir, config) => {
          base.validate(dir, config)
          const missing = tokensBefore.filter((name) => !cssVariables(readFileSync(join(dir, "design/tokens.css"), "utf8")).includes(name))
          if (missing.length) throw new Error(`design/tokens.css lost existing tokens: ${missing.join(", ")}. Keep every existing token.`)
        },
      }
    }
    case "plan": {
      const mergedIds = new Set(context.store.tasks().filter((task) => task.status === "merged").map((task) => task.id))
      return {
        ...base,
        inputs: [changePath(id, "spec.md"), changePath(id, "architecture.md"), "docs/spec.md", "docs/architecture.md", "docs/design.md", "contracts/", "tasks.json", progressPath],
        outputs: [`${changePath(id, "tasks.json")} (a JSON array of the new tasks only; [] when the change needs no code)`],
        validate: (dir) => void validateChangePlan(dir, id, mergedIds),
      }
    }
    default:
      return base
  }
}

function promptFileOf(image: string): string {
  return image.replace(/\.png$/, ".prompt.txt")
}

// Draws each illustration the task asks for that the repo does not have yet. Drawn files are cached in
// .agent-team/illustrations/<task>/, so a retry reuses them instead of paying for new images.
async function drawTaskIllustrations(context: PipelineContext, executor: Executor, dir: string, task: Task): Promise<AttemptResult | null> {
  const cacheDir = join(context.projectDir, ".agent-team", "illustrations", task.id)
  for (const entry of task.illustrations ?? []) {
    const target = join(dir, entry.to)
    const cached = join(cacheDir, basename(entry.to))
    if (existsSync(target)) continue
    mkdirSync(join(target, ".."), { recursive: true })
    if (existsSync(cached)) {
      cpSync(cached, target)
      if (existsSync(promptFileOf(cached))) cpSync(promptFileOf(cached), join(dir, promptFileOf(entry.to)))
      continue
    }
    writeFileSync(join(dir, promptFileOf(entry.to)), `${entry.prompt.trim()}\n`)
    const prompt = [
      `Draw one illustration for task ${task.id}. Follow the prompt in ${promptFileOf(entry.to)} exactly and save the image to ${entry.to}.`,
      entry.reference ? `Attach ${entry.reference} to the image generation as the brand and style reference.` : "Attach design/branding/02-landing.png as the brand and style reference when it exists.",
      "Draw the illustration alone: no UI, no text, no logo, plain background matching the app's page color, generous margin. Do not change any other file.",
    ].join("\n")
    context.store.log("illustration", `${task.id}: drawing ${entry.to}`)
    const outcome = await runAgent(context, executor, "illustrator", `${task.id}-illustration-${basename(entry.to, ".png")}`, planningTools, prompt, { writablePaths: [entry.to, promptFileOf(entry.to)] })
    if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `illustrator ${outcome.failureClass}: ${outcome.result.summary}` }
    if (!existsSync(target)) return { kind: "failed", reason: `the illustrator did not draw ${entry.to}: ${outcome.result.summary.slice(0, 500)}` }
    mkdirSync(cacheDir, { recursive: true })
    cpSync(target, cached)
    cpSync(join(dir, promptFileOf(entry.to)), promptFileOf(cached))
  }
  return null
}

// A missing source fails the attempt with a clear reason instead of letting the worker guess.
function copyTaskFiles(dir: string, task: Task): void {
  for (const entry of task.copy ?? []) {
    const source = join(dir, entry.from)
    if (!existsSync(source)) throw new Error(`${task.id}: copy source ${entry.from} does not exist`)
    mkdirSync(join(dir, entry.to, ".."), { recursive: true })
    cpSync(source, join(dir, entry.to), { recursive: true })
  }
}

function brandingImages(dir: string): string[] {
  const path = join(dir, "design/branding")
  return existsSync(path) ? readdirSync(path).filter((file) => imagePattern.test(file)) : []
}

// The newest QA round of main holds a screenshot of every route of the running app.
function latestAppScreenshots(projectDir: string): string | null {
  const qaDir = join(projectDir, ".agent-team", "qa")
  if (!existsSync(qaDir)) return null
  const rounds = readdirSync(qaDir).map((name) => Number(/^round-(\d+)$/.exec(name)?.[1])).filter((round) => round > 0).sort((left, right) => right - left)
  return rounds.length ? join(qaDir, `round-${rounds[0]}`) : null
}

function changeSteps(phase: PlanningPhase, definition: PhaseDefinition, change: Change): PhaseStep[] {
  const instructions = `Change mode for ${change.id}: the app already exists. Change only what ${changePath(change.id, "request.md")} needs.`
  if (phase === "branding") {
    return [
      {
        name: phase,
        instructions: [
          instructions,
          "Draw only the screens the change adds or changes. Number them after the highest existing image, and draw a mobile version of each.",
          `Attach design/branding/02-landing.png and the closest screenshot in ${appReferenceDir}/ as the brand and style reference. Reuse the Style section of design/branding/README.md and the structure of the saved .prompt.txt files, so the new screens match the app people already use.`,
          `Draw each new illustration the new screens show on its own in ${illustrationsDir}/, as in the Illustrations section of the README. Reuse an existing illustration when it fits.`,
          "Save each prompt next to its image, and add the new images to the README. Do not redraw or delete existing images.",
        ].join("\n"),
        validate: definition.validate,
        before: (context, dir) => {
          const screenshots = latestAppScreenshots(context.projectDir)
          if (!screenshots) return
          mkdirSync(join(dir, appReferenceDir), { recursive: true })
          for (const file of readdirSync(screenshots).filter((name) => imagePattern.test(name))) cpSync(join(screenshots, file), join(dir, appReferenceDir, file))
        },
        after: async (_context, dir) => rmSync(join(dir, appReferenceDir), { recursive: true, force: true }),
      },
    ]
  }
  if (phase !== "plan") return [{ name: phase, instructions, validate: definition.validate }]
  return [
    {
      name: phase,
      instructions,
      validate: definition.validate,
      after: async (context, dir) => {
        const tasks = validateChangePlan(dir, change.id, new Set(context.store.tasks().filter((task) => task.status === "merged").map((task) => task.id)))
        writeJson(join(dir, "tasks.json"), tasks)
        const added = tasks.filter((task) => task.change === change.id)
        context.store.log("plan", `${change.id}: appended ${added.length} tasks to tasks.json${added.length ? ` (${added.map((task) => task.id).join(", ")})` : ""}`)
      },
    },
  ]
}

export const researchPath = "docs/import/research.md"
const researchHeadings = ["## Product", "## Users", "## Stack", "## Routes", "## Commands", "## Sources", "## Open questions"]
export const importPhases = ["research", "spec", "architecture", "design"] as const satisfies readonly PhaseName[]
const importMode = "Import mode: this app already exists, and the team did not build it. Describe it exactly as it is today. Do not change app code and do not plan new features."

export function importing(context: Pick<PipelineContext, "config" | "store">): boolean {
  return Boolean(context.config.import) && context.store.meta(importDoneKey) !== "1"
}

// While a project is imported, the agents document the app as it is instead of designing a new one.
function importPhaseDefinition(phase: PhaseName): PhaseDefinition {
  const repository = "the repository code"
  switch (phase) {
    case "research":
      return {
        role: "importer",
        inputs: ["input.md", repository],
        outputs: [researchPath],
        validate: (dir) => requireHeadings(join(dir, researchPath), researchHeadings),
        tools: [...planningTools, "web_fetch", "web_search"],
      }
    case "spec":
      return { ...phaseDefinitions.spec, inputs: ["input.md", researchPath, repository] }
    case "architecture": {
      const base = phaseDefinitions.architecture
      return {
        ...base,
        inputs: [researchPath, "docs/spec.md", repository],
        outputs: [...base.outputs, "deploy.json ({ install, start, port } that run the app in production mode)"],
        validate: (dir, config) => {
          base.validate(dir, config)
          requireFile(join(dir, "deploy.json"))
        },
      }
    }
    case "design": {
      const base = phaseDefinitions.design
      return {
        ...base,
        inputs: [researchPath, "docs/spec.md", "docs/architecture.md", "the app's existing styles, templates, and components"],
        outputs: ["design/tokens.css", "docs/design-system.md", "docs/design.md"],
        commits: base.commits?.filter((commit) => !commit.matches.some((match) => match.startsWith("design/logo") || match.startsWith(faviconDir))),
        reviewed: false,
      }
    }
    default:
      return phaseDefinitions[phase]
  }
}

const importInstructions: Partial<Record<PhaseName, string>> = {
  research: `${importMode} Study the repository and the URLs in input.md.`,
  spec: `${importMode} User stories describe what users can do today. Put what you could not tell from the code under ## Open questions.`,
  architecture: `${importMode} Record the stack, structure, and commands the repository really uses. ## Commands holds install and test commands that work in this repository; leave test out when it has no tests. Write deploy.json so the orchestrator can start the app.`,
  design: [
    importMode,
    "Extract design/tokens.css from the app's existing styles: colors, fonts, spacing, and radius, with --primary as the main brand color.",
    "Describe the existing components in docs/design-system.md.",
    "In docs/design.md, write one section per existing page with a `Route: /path` line. Mark pages that need a login with `Access: signed in`, and add a `Login: /path` line when the app has a login page.",
    "Do not write logos or a /design-system page.",
  ].join("\n"),
}

function validateSpecDelta(dir: string, id: string): void {
  const deltaPath = join(dir, changePath(id, "spec.md"))
  requireHeadings(deltaPath, specDeltaHeadings)
  const spec = readFileSync(join(dir, "docs/spec.md"), "utf8")
  const missing = [...new Set(readFileSync(deltaPath, "utf8").match(/\bUS-\d+\b/g) ?? [])].filter((story) => !new RegExp(`\\b${story}\\b`).test(spec))
  if (missing.length) throw new Error(`docs/spec.md does not have the stories from the delta: ${missing.join(", ")}. Add them to docs/spec.md too.`)
}

function cssVariables(css: string): string[] {
  return [...new Set([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]))]
}

// The planner writes only the new tasks; tasks.json must be untouched, or already hold exactly the appended list.
// Returns the full list: the existing tasks, then the new ones marked with the change id.
export function validateChangePlan(dir: string, id: string, mergedIds: ReadonlySet<string>): Task[] {
  const committed = fileAtRef(dir, "HEAD", "tasks.json")
  if (committed === null) throw new Error("tasks.json is missing on the change branch")
  const existing = JSON.parse(committed) as Task[]
  const deltaPath = join(dir, changePath(id, "tasks.json"))
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(requireFile(deltaPath), "utf8"))
  } catch (error) {
    throw new Error(`${changePath(id, "tasks.json")} is not valid JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(raw)) throw new Error(`${changePath(id, "tasks.json")} must be a JSON array of new tasks`)
  const existingIds = new Set(existing.map((task) => task.id))
  const firstId = Number(nextTaskId(existing).slice(1))
  const problems: string[] = []
  for (const task of raw as Task[]) {
    if (existingIds.has(task?.id)) problems.push(`${task.id} already exists; new tasks need new ids from ${nextTaskId(existing)}`)
    else if (typeof task?.id !== "string" || !/^T\d+$/.test(task.id) || Number(task.id.slice(1)) < firstId) problems.push(`${task?.id}: new ids continue after the highest existing one, from ${nextTaskId(existing)}`)
  }
  if (problems.length) throw new Error(`the change plan is invalid:\n- ${problems.join("\n- ")}`)
  const added = (raw as Task[]).map((task) => ({ ...task, change: id }))
  const tasks = [...existing, ...added]
  orderTasks(validateTasks(tasks, readStack(dir)?.sharedPaths))
  for (const task of added) {
    const conflict = changeTaskConflict(task, existing, mergedIds)
    if (conflict) problems.push(`${task.id}: ${conflict}`)
  }
  if (problems.length) throw new Error(`the change plan is invalid:\n- ${problems.join("\n- ")}`)
  const current = JSON.stringify(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")))
  if (current !== JSON.stringify(existing) && current !== JSON.stringify(tasks)) {
    throw new Error(`tasks.json was edited. Restore it and write only the new tasks to ${changePath(id, "tasks.json")}`)
  }
  return tasks
}

// An imported app keeps its own logo, so its design system has no logo files to check.
function validateDesignSystem(dir: string, config?: PipelineConfig): void {
  const tokens = readFileSync(requireFile(join(dir, "design/tokens.css")), "utf8")
  if (!tokens.includes("--primary:")) throw new Error("design/tokens.css has no --primary variable")
  if (!config?.import) {
    for (const logo of ["design/logo.svg", markPath]) requireSvg(join(dir, logo))
    validateMark(dir)
  }
  requireHeadings(join(dir, "docs/design-system.md"), designSystemHeadings)
}

function validateScreens(dir: string, config: PipelineConfig): void {
  const design = readFileSync(requireFile(join(dir, "docs/design.md")), "utf8")
  if (config.target === "api") return
  if (!parseDesignScreens(design).some((screen) => screen.route !== designSystemRoute)) throw new Error("docs/design.md lists no `Route: /path` line")
}

// The spec's first heading names the product; the project folder is the fallback.
function productName(projectDir: string, dir: string): string {
  const specPath = join(dir, "docs/spec.md")
  const heading = existsSync(specPath) ? /^#\s+(.+)$/m.exec(readFileSync(specPath, "utf8"))?.[1].trim() : null
  return heading || basename(projectDir)
}

const designSystemHeadings = ["## Principles", "## Color", "## Typography", "## Spacing and radius", "## Components", "## Icons", "## Logo"]
const imagePattern = /\.(png|jpe?g|webp)$/i

export function validateBranding(dir: string, count: number, mobile = false, dark = false): void {
  const brandingDir = join(dir, "design/branding")
  requireFile(join(brandingDir, "01-logo.png"))
  requireFile(join(brandingDir, "README.md"))
  const images = readdirSync(brandingDir).filter((file) => imagePattern.test(file) && file !== "01-logo.png")
  const screens = images.filter((file) => !mobileImagePattern.test(file) && !darkImagePattern.test(file))
  if (dark && !images.some((file) => darkImagePattern.test(file) && !mobileImagePattern.test(file))) throw new Error("design/branding/ has no dark theme image; expected 02-landing.dark.png, the landing redrawn in the dark theme")
  if (screens.length < count - 1) throw new Error(`design/branding/ has ${screens.length} desktop screen images; expected at least ${count - 1}`)
  const illustrations = existsSync(join(dir, illustrationsDir)) ? readdirSync(join(dir, illustrationsDir)).filter((file) => imagePattern.test(file)) : []
  if (!illustrations.some((file) => /^hero\./i.test(file))) throw new Error(`${illustrationsDir}/ has no hero.png: draw the landing's hero illustration alone, so workers can copy it instead of redrawing it`)
  if (!mobile) return
  const missing = screens.filter((file) => !images.includes(mobileImageName(file)))
  if (missing.length) throw new Error(`design/branding/ has no mobile version of: ${missing.join(", ")} (expected ${missing.map(mobileImageName).join(", ")})`)
}

const mobileImagePattern = /\.mobile\.(png|jpe?g|webp)$/i
const darkImagePattern = /\.dark\.(png|jpe?g|webp)$/i
export function validateConcepts(dir: string, variations: number, style = autoStyle): string[] {
  requireFile(join(dir, conceptsDir, "README.md"))
  const ids = conceptIds(dir)
  if (ids.length < variations) throw new Error(`${conceptsDir}/ has ${ids.length} directions (${ids.join(", ") || "none"}); expected ${variations}: a, b, c`)
  for (const id of ids) {
    for (const file of ["logo.png", "landing.png", "style.md"]) requireFile(join(dir, conceptsDir, id, file))
  }
  const problems = conceptStyleProblems(Object.fromEntries(ids.map((id) => [id, readFileSync(join(dir, conceptsDir, id, "style.md"), "utf8")])), style)
  if (problems.length) throw new Error(`the concept styles do not match the catalog:\n- ${problems.join("\n- ")}`)
  return ids
}

export function mobileImageName(file: string): string {
  return file.replace(/\.(png|jpe?g|webp)$/i, ".mobile.$1")
}

function requireSvg(path: string): void {
  const content = readFileSync(requireFile(path), "utf8").replace(/^\uFEFF/, "").trim()
  const withoutProlog = content.replace(/^<\?xml[\s\S]*?\?>\s*/, "").replace(/^(<!--[\s\S]*?-->\s*)*/, "")
  if (!/^<svg[\s>]/.test(withoutProlog) || !/<\/svg>\s*$/.test(content)) throw new Error(`${path} is not an SVG file with an <svg> root`)
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
  // Replaces the per-task UI smoke check (tests use a stub instead of Docker).
  smokeCheck?: SmokeCheck
  // Replaces the Docker favicon render, the same way.
  renderFavicons?: typeof generateFavicons
  // Replaces the Docker render of the marketing pieces.
  renderMarketing?: typeof renderMarketing
  // Replace the Docker deploy and the app container check, the same way.
  deploy?: typeof deployProject
  appRunning?: (projectDir: string) => boolean
}

// Why the run stopped, shown on the dashboard. kind "budget" offers to raise the budget.
export interface RunStop {
  outcome: Exclude<RunOutcome, "completed">
  kind: "budget" | "other"
  reason: string
  at: string
}

const runStopKey = "run.stop"
// Per-run state that the step functions report into, keyed by context so parallel test runs stay apart.
const runStates = new WeakMap<PipelineContext, { stopReason: string | null; budgetExceeded: boolean }>()

function runState(context: PipelineContext) {
  let state = runStates.get(context)
  if (!state) {
    state = { stopReason: null, budgetExceeded: false }
    runStates.set(context, state)
  }
  return state
}

// Records the full reason for a pause or failure; the events keep only a short slice.
// Once the budget stops the run, the pauses it causes further up keep the budget message.
function noteStop(context: PipelineContext, reason: string): void {
  const state = runState(context)
  if (!state.budgetExceeded) state.stopReason = reason
}

// Keeps the lines that explain a command failure (npm error lines and the like), else the last lines.
export function keyFailureLines(output: string, maxLines = 15): string {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim())
  const key = lines.filter((line) => /\bnpm (error|ERR!)|\berror\b|\bERR_|\bfailed\b|\bcannot\b|\bnot found\b|\bexception\b/i.test(line))
  return (key.length ? key.slice(0, maxLines) : lines.slice(-maxLines)).join("\n")
}

function summarizeStop(reason: string): string {
  const [first, ...rest] = reason.trim().split("\n")
  if (!rest.length) return first.slice(0, 2000)
  return `${first.slice(0, 500)}\n${keyFailureLines(rest.join("\n"))}`.slice(0, 4000)
}

type AttemptResult =
  | { kind: "passed" }
  // diff is the rejected change, kept so the next attempt can fix it instead of starting over.
  | { kind: "failed"; reason: string; diff?: string }
  | { kind: "blocked"; reason: string; block: Block }
  | { kind: "infrastructure"; reason: string }
  | { kind: "budget"; reason: string; limitUsd: number; diff: string }

// "replanned" means tasks.json changed on main, so the caller reloads it before going on.
// "skipped": autonomy.decide: auto set the task aside, and the run goes on with the others.
type TaskOutcome = RunOutcome | "replanned" | "skipped"

export interface PreviousAttempt {
  reason: string
  diff: string | null
  // Reasons from attempts before the last one, oldest first. Without them a retry can undo an earlier fix.
  earlierReasons?: string[]
}

export async function runPipeline(context: PipelineContext): Promise<RunOutcome> {
  const { store } = context
  const state = runState(context)
  state.stopReason = null
  state.budgetExceeded = false
  store.setMeta(runStopKey, "")
  let outcome = await runStages(context)
  if (state.budgetExceeded && outcome === "paused") outcome = "awaiting_approval"
  if (!state.budgetExceeded && !context.signal.aborted) await learnLessons(context, { force: outcome === "completed" })
  if (outcome !== "completed") {
    const lastEvent = store.lastEvent()
    const reason = state.stopReason ?? lastEvent?.message ?? "no reason recorded"
    const stop: RunStop = { outcome, kind: state.budgetExceeded ? "budget" : "other", reason: summarizeStop(reason), at: new Date().toISOString() }
    store.setMeta(runStopKey, JSON.stringify(stop))
  }
  return outcome
}

// Every workspace starts from and lands on this branch: the open change's branch, else main.
export function landingBranch(context: Pick<PipelineContext, "store">): string {
  return context.store.currentChange()?.branch ?? "main"
}

async function runStages(context: PipelineContext): Promise<RunOutcome> {
  if (importing(context)) return runImport(context)
  for (const phase of Object.keys(phaseDefinitions) as PlanningPhase[]) {
    const outcome = await runPlanningPhase(context, phase)
    if (outcome !== "completed") return outcome
    if (phase === "architecture") requestChangeDesign(context)
  }
  return runTasks(context)
}

// The first run of an imported project: document the app, record how it stands, then wait for change requests.
async function runImport(context: PipelineContext): Promise<RunOutcome> {
  const { store } = context
  for (const phase of importPhases) {
    const outcome = await runPlanningPhase(context, phase)
    if (outcome !== "completed") return outcome
  }
  const baseline = await runBaselinePhase(context)
  if (baseline !== "completed") return baseline
  // Nothing is built at import, and the app deploys with the first change.
  for (const phase of ["branding", "marketing", "plan", "qa", "deploy"]) store.setPhase(phase, "approved")
  store.setMeta(importDoneKey, "1")
  store.log("import", "import complete: the app is documented; request a change to work on it")
  return "completed"
}

// Runs the tests and screenshots every route of main once. The screenshots land in design/branding/ as the
// reference QA compares with, and the failures become the baseline that later QA rounds judge regressions against.
async function runBaselinePhase(context: PipelineContext): Promise<RunOutcome> {
  const { projectDir, config, store } = context
  if (store.phaseStatus("baseline") === "approved") return "completed"
  store.setPhase("baseline", "running")
  const outDir = join(projectDir, dirname(baselinePath), "screenshots")
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const name = "import-baseline"
  const workspace = createWorkspace(projectDir, name, "main")
  let executor: Executor | null = null
  try {
    executor = await createExecutor(context, workspace.path, name)
    const tests = await runTestGate(context, executor, workspace.path, name)
    // A repository without a lockfile gets one from the install; kept, so no task trips over it later. Other install output goes.
    const installOutput = changedFiles(workspace.path)
    restorePaths(workspace.path, installOutput.filter((file) => !lockfileNames.has(basename(file))))
    let visual: VisualReport | null = null
    let copied = 0
    if (config.target !== "api") {
      const design = readFileSync(join(workspace.path, "docs/design.md"), "utf8")
      const screens = parseDesignScreens(design).filter((screen) => screen.route !== designSystemRoute)
      visual = await captureScreenshots({ projectDir, outDir, screens, signal: context.signal, login: { route: parseLoginRoute(design), access: ensureDemoAccess(store) }, ref: "main" })
      copied = copyBaselineScreenshots(visual, outDir, workspace.path)
    }
    const lockfiles = changedFiles(workspace.path).filter((file) => lockfileNames.has(basename(file)))
    if (copied || lockfiles.length) {
      const title = copied ? "design(branding): add screenshots of the imported app" : "chore: add the lockfile the install created"
      commitAndRebase(workspace, title, [{ message: "chore: add the lockfile the install created", files: lockfiles }])
      context.github.land({ workspace, title, body: `The import baseline captured ${copied} screenshots${lockfiles.length ? ` and added ${lockfiles.join(", ")}` : ""}.` })
    }
    const baseline = createBaseline({ commit: commitOf(projectDir, "main"), tests, visual, summary: tests.passed ? "" : keyFailureLines(tests.output) })
    writeBaseline(projectDir, baseline)
    const cleanup = cleanupRequest(baseline)
    if (cleanup) store.setMeta(importCleanupKey, cleanup)
    store.log("import", baseline.failures.length ? `baseline: ${baseline.failures.length} ${baseline.failures.length === 1 ? "problem" : "problems"} found in the imported app: ${baseline.failures.map((failure) => failure.message).join("; ").slice(0, 1000)}` : "baseline: tests pass and every route loads")
    store.setPhase("baseline", "approved")
    return "completed"
  } catch (error) {
    store.setPhase("baseline", "pending")
    noteStop(context, `baseline paused: ${(error as Error).message}`)
    store.log("import", `baseline paused: ${(error as Error).message.slice(0, 300)}`)
    return "paused"
  } finally {
    await executor?.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

// Copies each route's screenshots to design/branding/<slug>.png and <slug>.mobile.png, and lists them in the README.
function copyBaselineScreenshots(visual: VisualReport, outDir: string, dir: string): number {
  const brandingDir = join(dir, "design/branding")
  mkdirSync(brandingDir, { recursive: true })
  const lines = ["# Branding", "", "Screenshots of the imported app, taken by the import baseline. QA compares later changes with them.", ""]
  let copied = 0
  for (const route of visual.routes) {
    if (!route.file) continue
    cpSync(join(outDir, route.file), join(brandingDir, `${route.slug}.png`))
    lines.push(`- \`${route.slug}.png\`: ${route.route}`)
    copied += 1
    if (!route.mobile?.file) continue
    cpSync(join(outDir, route.mobile.file), join(brandingDir, `${route.slug}.mobile.png`))
    copied += 1
  }
  if (copied) writeFileSync(join(brandingDir, "README.md"), `${lines.join("\n")}\n`)
  return copied
}

// An imported app has no /design-system page, and its reference image for a route is the baseline screenshot.
function importedScreens(screens: QaScreen[], dir: string): QaScreen[] {
  return screens
    .filter((screen) => screen.route !== designSystemRoute)
    .map((screen) => ({ ...screen, branding: screen.branding ?? (existsSync(join(dir, "design/branding", `${screen.slug}.png`)) ? `${screen.slug}.png` : null) }))
}

// After a change merges, the QA result it passed with becomes the baseline, and the cleanup suggestion follows it.
function advanceBaseline(context: PipelineContext): void {
  const { projectDir, store } = context
  if (!promoteNextBaseline(projectDir)) return
  store.log("import", "baseline updated from the change's QA pass")
  if (!store.meta(importCleanupKey)) return
  const cleanup = cleanupRequest(readBaseline(projectDir)!)
  if (cleanup) store.setMeta(importCleanupKey, cleanup)
  else store.deleteMeta(importCleanupKey)
}

// Runs once per change, after its architecture is approved (by the run or at a gate).
function requestChangeDesign(context: PipelineContext): void {
  const { config, projectDir, store } = context
  const change = store.currentChange()
  const checkedKey = `change.${change?.id}.design`
  if (!change || store.meta(checkedKey)) return
  const delta = fileAtRef(projectDir, change.branch, changePath(change.id, "architecture.md")) ?? ""
  const needed = designNeededPattern.test(delta.split("\n").find((line) => line.trim()) ?? "") && config.target !== "api"
  store.setMeta(checkedKey, needed ? "rerun" : "skipped")
  if (!needed) return
  store.setPhase("design", "pending")
  store.log("phase", `${change.id}: the architecture delta says Design: needed, so the design phase runs again`)
  if (config.branding.enabled && existsSync(join(projectDir, "design/branding/README.md"))) {
    store.setPhase("branding", "pending")
    store.log("phase", `${change.id}: the illustrator draws the new screens first, with the running app as the style reference`)
  }
}

async function runPlanningPhase(context: PipelineContext, phase: PhaseName): Promise<RunOutcome> {
  const { projectDir, config, store } = context
  const status = store.phaseStatus(phase)
  if (status === "approved") return "completed"
  if (status === "awaiting_approval") {
    store.log("gate", `phase "${phase}" is waiting for approval: agent-team approve ${projectDir} ${phase}`)
    return "awaiting_approval"
  }
  const skipReason =
    (phase === "design" || phase === "branding" || phase === "concepts" || phase === "marketing") && config.target === "api"
      ? "api-only target"
      : (phase === "branding" || phase === "concepts") && !config.branding.enabled
        ? "branding disabled in pipeline.yaml"
        : phase === "concepts" && config.branding.variations < 2
          ? "branding.variations is under 2"
          : phase === "concepts" && store.currentChange()
            ? "a change request keeps the chosen direction"
            : phase === "concepts" && store.phaseStatus("branding") === "approved"
              ? "the branding was drawn before the concepts phase existed"
        : phase === "marketing" && !config.marketing.enabled
          ? "marketing disabled in pipeline.yaml"
          : phase === "marketing" && store.currentChange()
            ? "a change request does not rerun marketing"
            : phase === "marketing" && store.phaseStatus("plan") === "approved" && !store.phases().some((row) => row.name === "marketing")
              ? "the project was planned before the marketing phase existed"
              : null
  if (skipReason) {
    store.setPhase(phase, "approved")
    store.log("phase", `${phase} skipped: ${skipReason}`)
    return "completed"
  }

  const change = store.currentChange()
  const definition = importing(context) ? importPhaseDefinition(phase) : change ? changePhaseDefinition(context, phase as PlanningPhase, change) : phaseDefinitions[phase as PlanningPhase]
  store.setPhase(phase, "running")
  if (definition.role === "architect") logTemplateHintConflicts(context)
  let previousError: string | null = null
  // Every rejection so far, oldest first, including each design review round. A retry starts from a fresh
  // workspace, so without the earlier ones it can undo a fix an earlier round asked for.
  const rejections: string[] = []
  for (let attempt = 1; attempt <= phaseAttempts; attempt++) {
    store.log("phase", `${phase}: attempt ${attempt} with ${definition.role}`)
    const result = await attemptPhase(context, phase, definition, attempt, rejections)
    if (result.kind === "infrastructure") {
      store.setPhase(phase, "pending")
      noteStop(context, `${phase} paused: ${result.reason}`)
      store.log("phase", `${phase}: paused: ${result.reason.slice(0, 300)}`)
      return "paused"
    }
    if (result.kind === "failed" || result.kind === "blocked") {
      previousError = result.reason
      if (rejections.at(-1) !== previousError) rejections.push(previousError)
      store.log("phase", `${phase}: output rejected: ${previousError}`)
      continue
    }
    archiveFeedback(projectDir, phase)
    if (phase === "concepts") store.deleteMeta(conceptChoiceKey)
    if (phase === "concepts" && !config.autonomy.gates.includes("concepts")) {
      const picked = await pickConcept(context)
      if (picked !== "completed") return picked
    }
    if (config.autonomy.gates.includes(phase as PlanningPhase)) {
      store.setPhase(phase, "awaiting_approval")
      store.log("gate", `phase "${phase}" ${gateReadyText}: agent-team approve ${projectDir} ${phase}`)
      return "awaiting_approval"
    }
    store.setPhase(phase, "approved")
    return "completed"
  }
  store.setPhase(phase, "failed")
  noteStop(context, `${phase} failed after ${phaseAttempts} attempts: ${previousError ?? "no reason"}`)
  return "failed"
}

// Planning agents also work in a throwaway worktree, so they never see the orchestrator state or write to main's .git.
// The phase runs its steps in order, then the design reviewer (for reviewed phases), and lands as one commit per group.
async function attemptPhase(context: PipelineContext, phase: PhaseName, definition: PhaseDefinition, attempt: number, rejections: string[]): Promise<AttemptResult> {
  const { projectDir, config, store } = context
  const previousErrors = [...rejections]
  const name = `phase-${phase}-${attempt}`
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  const change = store.currentChange()
  const changeNotes = change && (definition.role === "architect" || definition.role === "planner") ? [["## Code map (git ls-files, without lockfiles and assets)", "", "```", ...codeMap(trackedFiles(workspace.path)), "```"].join("\n")] : []
  const designStyleNotes = importing(context) ? [] : styleNotes({ phase, role: definition.role, dir: workspace.path, choice: store.meta(conceptChoiceKey), configured: config.branding.style, variations: config.branding.variations })
  const runPhaseAgent = async (subject: string, notes: string[]): Promise<AttemptResult | null> => {
    const outcome = await runAgent(context, executor, definition.role, subject, definition.tools ?? planningTools, phasePrompt(context, phase, previousErrors, [...notes, ...changeNotes, ...designStyleNotes], definition, change), { promptName: definition.promptName })
    if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `${outcome.failureClass}: ${outcome.result.summary}` }
    if (outcome.result.status !== "done") return { kind: "failed", reason: `agent ${outcome.result.status}: ${outcome.result.summary}` }
    return null
  }
  const validate = (check: (dir: string, config: PipelineConfig) => void): AttemptResult | null => {
    try {
      check(workspace.path, config)
      return null
    } catch (error) {
      return { kind: "failed", reason: (error as Error).message }
    }
  }
  // The orchestrator's own steps (the favicon render) need Docker, not an agent, so a failure pauses the run.
  const runAfter = async (step: PhaseStep): Promise<AttemptResult | null> => {
    if (!step.after) return null
    try {
      await step.after(context, workspace.path)
      return null
    } catch (error) {
      return { kind: "infrastructure", reason: `${phase} ${step.name}: ${(error as Error).message}` }
    }
  }
  const steps: PhaseStep[] = importing(context)
    ? [{ name: phase, instructions: importInstructions[phase] ?? importMode, validate: definition.validate }]
    : change ? changeSteps(phase as PlanningPhase, definition, change) : phase === "design" ? designSteps : phase === "marketing" ? marketingSteps : [{ name: phase, instructions: "", validate: definition.validate }]
  // A fix may change the logo mark, so the favicon set is rendered again.
  const rerunOrchestratorSteps = async (): Promise<AttemptResult | null> => {
    for (const step of steps) {
      const failure = await runAfter(step)
      if (failure) return failure
    }
    return null
  }
  try {
    for (const step of steps) {
      const subject = steps.length > 1 ? `${name}-${step.name}` : name
      step.before?.(context, workspace.path)
      const failure = (await runPhaseAgent(subject, step.instructions ? [step.instructions] : [])) ?? validate(step.validate) ?? (await runAfter(step))
      if (failure) return failure
    }
    const invalid = validate(definition.validate)
    if (invalid) return invalid

    if (definition.reviewed) {
      for (let round = 1; ; round++) {
        const review = await reviewPhase(context, executor, workspace.path, phase as PlanningPhase, `${name}-review-${round}`)
        if (review.kind !== "verdict") return review.result
        const { verdict } = review
        store.log("review", `${phase}: design review ${round}: ${verdict.verdict}${verdict.reasons.length ? `: ${verdict.reasons.join("; ").slice(0, 500)}` : ""}`)
        if (verdict.verdict === "pass") break
        const rejection = `the design reviewer rejected the ${phase} output.\nReasons: ${verdict.reasons.join("; ")}\nFixes: ${verdict.fixes.join("; ")}`
        rejections.push(rejection)
        if (round >= designReviewRounds) return { kind: "failed", reason: rejection }
        const fixNotes = [`The design reviewer rejected your output. Edit your existing files to fix every problem below. Do not start over.`, ...verdict.fixes.map((fix) => `- ${fix}`)]
        const failure =
          (await runPhaseAgent(`${name}-fix-${round}`, fixNotes)) ??
          validate(definition.validate) ??
          (await rerunOrchestratorSteps())
        if (failure) return failure
      }
    }

    if (phase === "architecture") ensureClaudeMemoryFile(context, workspace.path)
    const title = change ? `docs(${phase}): update ${phase} for ${change.id}` : importing(context) ? `docs(${phase}): document the imported app` : `docs(${phase}): add ${phase} artifacts`
    commitAndRebase(workspace, title, groupPhaseFiles(changedFiles(workspace.path), definition.commits ?? []))
    context.github.land({
      workspace,
      title,
      body: `Planning phase **${phase}**, written by the ${definition.role} agent (attempt ${attempt}).\n\nOutputs: ${definition.outputs.join(", ")}.`,
    })
    return { kind: "passed" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

type ReviewOutcome = { kind: "verdict"; verdict: ReviewVerdict } | { kind: "stopped"; result: AttemptResult }

// With no concepts gate, the design reviewer picks the direction the rest of the branding follows.
async function pickConcept(context: PipelineContext): Promise<RunOutcome> {
  const { projectDir, store } = context
  const workspace = createWorkspace(projectDir, "concepts-pick", landingBranch(context))
  const executor = await createExecutor(context, workspace.path, "concepts-pick")
  try {
    const ids = conceptIds(workspace.path)
    writeStyleCatalog(workspace.path)
    let previousError: string | null = null
    for (let attempt = 1; attempt <= reviewAttempts; attempt++) {
      const prompt = conceptPickPrompt(ids, previousError)
      const outcome = await runAgent(context, executor, "design-reviewer", `concepts-pick-${attempt}`, reviewerTools, prompt, { promptName: "concept-picker" })
      if (isInfrastructureFailure(outcome)) {
        noteStop(context, `concepts pick paused: ${outcome.result.summary}`)
        store.setPhase("concepts", "pending")
        return "paused"
      }
      try {
        const pick = parseConceptPick(outcome.result.summary, ids)
        store.setMeta(conceptChoiceKey, pick.choice)
        store.log("gate", `concepts: the design reviewer picked direction ${pick.choice}: ${pick.reason.slice(0, 300)}`)
        return "completed"
      } catch (error) {
        previousError = (error as Error).message
      }
    }
    store.setMeta(conceptChoiceKey, ids[0])
    store.log("gate", `concepts: no valid pick (${(previousError ?? "").slice(0, 200)}), using direction ${ids[0]}`)
    return "completed"
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

export function parseConceptPick(text: string, ids: string[]): { choice: string; reason: string } {
  const parsed = extractJsonObject(text) as any
  if (!ids.includes(parsed?.choice)) throw new Error(`choice must be one of ${ids.join(", ")}`)
  return { choice: parsed.choice, reason: String(parsed.reason ?? "") }
}

function conceptPickPrompt(ids: string[], previousError: string | null): string {
  const lines = [
    `Pick one of these directions: ${ids.join(", ")}.`,
    "",
    ...ids.flatMap((id) => [`- ${id}: ${conceptsDir}/${id}/logo.png, ${conceptsDir}/${id}/landing.png, ${conceptsDir}/${id}/style.md`]),
    "",
    `Read input.md, docs/spec.md, and ${conceptsDir}/README.md.`,
    `Each style.md names its catalog style on its "Style:" line. ${styleCatalogDir}/<id>.md says who each style fits and who it does not: prefer the direction whose style fits the brief's users.`,
  ]
  if (previousError) lines.push("", `Your previous answer was rejected. Fix this: ${previousError}`)
  return lines.join("\n")
}

async function reviewPhase(context: PipelineContext, executor: Executor, dir: string, phase: PlanningPhase, subject: string): Promise<ReviewOutcome> {
  const change = context.store.currentChange()
  const style = phase === "concepts" ? null : chosenStyleId(dir, context.store.meta(conceptChoiceKey), context.config.branding.style)
  if (style || phase === "concepts") writeStyleCatalog(dir)
  const prompt = (previousError: string | null) => designReviewPrompt({ phase, config: context.config, files: trackedAndNewFiles(dir), previousError, changeId: change?.id ?? null, style })
  return reviewWithRetries(context, executor, subject, "design-reviewer", prompt)
}

// Runs a read-only reviewer until it gives a valid verdict, at most reviewAttempts times.
async function reviewWithRetries(context: PipelineContext, executor: Executor, subject: string, promptName: string, prompt: (previousError: string | null) => string): Promise<ReviewOutcome> {
  let previousError: string | null = null
  for (let attempt = 1; attempt <= reviewAttempts; attempt++) {
    const outcome = await runAgent(context, executor, "design-reviewer", attempt === 1 ? subject : `${subject}-${attempt}`, reviewerTools, prompt(previousError), { promptName })
    if (isInfrastructureFailure(outcome)) return { kind: "stopped", result: { kind: "infrastructure", reason: `design reviewer ${outcome.failureClass}: ${outcome.result.summary}` } }
    if (outcome.result.status !== "done") return { kind: "stopped", result: { kind: "failed", reason: `design reviewer ${outcome.result.status}: ${outcome.result.summary}` } }
    try {
      return { kind: "verdict", verdict: parseVerdict(outcome.result.summary) }
    } catch (error) {
      previousError = (error as Error).message
      context.store.log("review", `${subject}: verdict rejected: ${previousError.slice(0, 300)}`)
    }
  }
  return { kind: "stopped", result: { kind: "failed", reason: `the design reviewer gave no valid verdict: ${previousError}` } }
}

function trackedAndNewFiles(dir: string): string[] {
  return [...new Set([...trackedFiles(dir), ...changedFiles(dir)])].filter((file) => existsSync(join(dir, file))).sort()
}

export function designReviewPrompt(input: { phase: PlanningPhase; config: PipelineConfig; files: string[]; previousError: string | null; changeId?: string | null; style?: string | null }): string {
  const { phase, files } = input
  const images = files.filter((file) => (file.startsWith("design/") || file.startsWith(`${marketingDir}/`)) && imagePattern.test(file))
  const lines = [`Review the ${phase} phase output. Project target: ${input.config.target}.`, ""]
  if (phase === "concepts") {
    lines.push(
      `Expected: ${input.config.branding.variations} directions in ${conceptsDir}/ (a, b, c...), each with logo.png, landing.png, and style.md, plus ${conceptsDir}/README.md.`,
      "Read input.md and docs/spec.md. The directions must be truly different from each other (logo idea, color, and layout), each one consistent in itself, and each landing a realistic product screen with real content in the brief's language.",
      input.config.branding.style === autoStyle
        ? `Each style.md names a different style from the catalog in ${styleCatalogDir}/README.md. Open each named style's file (${styleCatalogDir}/<id>.md). Fail a direction whose style does not fit the brief's users (its "Avoid for" list), that does not look like its style, or that shows one of its failure modes.`
        : `Every direction uses the "${input.config.branding.style}" style the person chose. Read ${styleCatalogDir}/${input.config.branding.style}.md. Fail a direction that does not look like that style or that shows one of its failure modes.`,
    )
  } else if (phase === "branding" && input.changeId) {
    lines.push(
      `Change ${input.changeId}: expected new screen images (desktop and mobile) for the screens the change adds, drawn in the style of the existing images. Read ${changePath(input.changeId, "spec.md")}.`,
      "Fail new screens that do not match the existing images in colors, type, layout, and components.",
    )
  } else if (phase === "branding") {
    lines.push(
      `Expected: the logo, ${input.config.branding.count - 1} desktop screens${input.config.branding.mobile ? ", and a mobile version of each screen" : ""}, and design/branding/README.md.`,
      "Read input.md and docs/spec.md for what the product must show.",
    )
  } else if (phase === "marketing") {
    lines.push(
      `Expected: ${input.config.marketing.pieces} pieces in ${copyPath}, one art image per piece in ${marketingDir}/art/, and each piece rendered by the orchestrator in these formats: ${input.config.marketing.formats.join(", ")}.`,
      `${manifestPath} lists every rendered file. Read input.md and docs/spec.md for the problem the product solves.`,
      "Judge the rendered pieces: the text is legible over the art, the copy is in the language of input.md, the art shows the problem without text or other brands in it, the logo and colors match the brand, and stock photos carry a credit.",
    )
  } else {
    lines.push(
      "Check design/tokens.css, design/logo.svg, design/logo-mark.svg, docs/design-system.md, and docs/design.md.",
      `The favicon set in ${faviconDir}/ was rendered from design/logo-mark.svg by the orchestrator. Judge the rendered PNGs, not only the SVG.`,
      "Read docs/spec.md for the user stories.",
    )
  }
  if (input.style && phase !== "concepts" && phase !== "marketing") {
    lines.push(`The chosen visual style is "${input.style}". Read ${styleCatalogDir}/${input.style}.md. Fail output that drifts from its signature details or shows one of its failure modes.`)
  }
  lines.push("", "## Images to open", "", ...(images.length ? images.map((file) => `- ${file}`) : ["none"]))
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

function logTemplateHintConflicts(context: PipelineContext): void {
  const { config, projectDir, store } = context
  const stack = config.template ? readStack(projectDir) : null
  if (!stack) return
  for (const hint of conflictingHints(stack, config.stackHints.avoid)) {
    store.log("template", `stack hint "avoid: ${hint}" conflicts with the ${stack.name} template; the template wins and the hint is dropped`)
  }
}

// With a template, the architecture must keep its commands and must not touch the scaffold's deploy.json.
function validateTemplateArchitecture(dir: string, config: PipelineConfig): void {
  const stack = config.template ? readStack(dir) : null
  if (!stack) return
  const problems: string[] = []
  for (const file of ["docs/architecture.md", "AGENTS.md"]) {
    for (const mismatch of commandMismatches(readFileSync(join(dir, file), "utf8"), stack)) problems.push(`${file} ## Commands: ${mismatch}`)
  }
  const expected = templateDeployPlan(stack)
  const deployPath = join(dir, "deploy.json")
  const deploy = existsSync(deployPath) ? JSON.parse(readFileSync(deployPath, "utf8")) : null
  if (deploy?.install !== expected.install || deploy?.start !== expected.start || deploy?.port !== expected.port) {
    problems.push(`deploy.json belongs to the ${stack.name} template; restore it to ${JSON.stringify(expected)}`)
  }
  if (problems.length) throw new Error(`the architecture does not match the ${stack.name} template:\n- ${problems.join("\n- ")}`)
}

// Claude Code reads CLAUDE.md, Codex reads AGENTS.md; the import keeps one source of truth.
function ensureClaudeMemoryFile(context: PipelineContext, dir: string): void {
  const path = join(dir, "CLAUDE.md")
  if (existsSync(path)) return
  writeFileSync(path, "@AGENTS.md\n")
  context.store.log("phase", "architecture: created CLAUDE.md that imports AGENTS.md")
}

export function phasePrompt(
  context: Pick<PipelineContext, "projectDir" | "config"> & { store?: Store },
  phase: PhaseName,
  previousError: string | string[] | null,
  notes: string[] = [],
  definition = phaseDefinitions[phase as PlanningPhase],
  change: Change | null = null,
): string {
  const { config, projectDir } = context
  const lines = [
    ...(change ? [`Change mode: change request ${change.id}. The app is built and live. Read the request in ${changePath(change.id, "request.md")}.`] : []),
    `Project target: ${config.target}.`,
    `Read these inputs: ${definition.inputs.join(", ")}.`,
    `Write these outputs: ${definition.outputs.join(", ")}.`,
  ]
  if (definition.role === "illustrator" && phase === "concepts") {
    lines.push(`Draw ${config.branding.variations} distinct directions, in folders ${"abcd".slice(0, config.branding.variations).split("").join(", ")}.`)
  } else if (definition.role === "illustrator" && !change) {
    const choice = context.store?.meta(conceptChoiceKey)
    if (choice) {
      lines.push(
        `Direction ${choice} was chosen in the concepts phase. Build on it: start 01-logo.png from ${conceptsDir}/${choice}/logo.png (redraw it cleanly, keep the idea), copy the style block from ${conceptsDir}/${choice}/style.md into every screen prompt, and attach ${conceptsDir}/${choice}/landing.png as the style reference for 02-landing.png. Keep 02-landing.png close to it. Ignore the other directions.`,
      )
      const feedback = readFeedback(projectDir, "concepts")
      if (feedback) lines.push("", "The person who chose it also wrote:", "", feedback.trim())
    }
    lines.push(`Generate ${config.branding.count} images in total: the logo first, then ${config.branding.count - 1} desktop screens.`)
    lines.push(config.branding.mobile ? "Then draw a mobile version of every desktop screen, named like the desktop file with .mobile before the extension." : "Do not draw mobile screens.")
    if (config.branding.dark) {
      lines.push(
        "Last, draw 02-landing.dark.png by style transfer: attach 02-landing.png and ask for the same screen in a dark theme. Keep the layout, every string, and the accent color; change only the background, surface, border, and text colors. Add the dark hex values to the `## Style` section of the README.",
      )
    }
  }
  if (definition.role === "marketer") {
    lines.push(`Write ${config.marketing.pieces} pieces. The orchestrator renders each one in these formats: ${config.marketing.formats.join(", ")}.`)
  }
  const stack = config.template ? readStack(projectDir) : null
  if (stack && (definition.role === "architect" || definition.role === "planner")) lines.push(...templatePromptLines(stack, definition.role))
  const conflicts = stack ? conflictingHints(stack, config.stackHints.avoid) : []
  const avoid = config.stackHints.avoid.filter((hint) => !conflicts.includes(hint))
  if (config.stackHints.prefer.length) lines.push(`Preferred technologies: ${config.stackHints.prefer.join(", ")}.`)
  if (avoid.length) lines.push(`Avoid: ${avoid.join(", ")}.`)
  const feedback = readFeedback(projectDir, phase)
  if (feedback) {
    lines.push("A human reviewed your last output and asked for these changes:", feedback.trim())
    lines.push("Edit your existing outputs to address this feedback. Do not start over.")
  }
  // Earlier rejections come first so a retry keeps those fixes; the last one is what to fix now.
  const previousErrors = previousError === null ? [] : typeof previousError === "string" ? [previousError] : previousError
  if (previousErrors.length > 1) {
    lines.push("Earlier outputs were rejected for these reasons too. Keep those fixes in place:")
    previousErrors.slice(0, -1).forEach((reason, index) => lines.push(`${index + 1}. ${reason.trim()}`))
  }
  const lastError = previousErrors.at(-1)
  if (lastError) lines.push(`Your previous output was rejected. Fix this: ${lastError}`)
  lines.push(...notes)
  return lines.join("\n")
}

// Informational only: a broken package.json fails later, in the step that needs it.
function logResolvedCommands(context: PipelineContext): void {
  try {
    context.store.log("commands", formatCommands(resolveCommands(context.projectDir)))
  } catch (error) {
    context.store.log("commands", `could not resolve the commands: ${(error as Error).message.slice(0, 300)}`)
  }
}

async function runTasks(context: PipelineContext): Promise<RunOutcome> {
  const { store } = context
  logResolvedCommands(context)
  const change = store.currentChange()
  if (change && !loadLandedTasks(context).some((task) => task.change === change.id)) return finishDocsOnlyChange(context, change)
  const built = await buildTasks(context)
  if (built !== "completed") return built
  let deployUrl: string | null = null
  const deploy = async () => {
    if (change) {
      const merged = await mergeChange(context, change)
      if (merged !== "completed") return merged
      advanceBaseline(context)
    }
    // On a resume with nothing to build, the phase may be approved while the app has no URL or its container stopped.
    const result = (await ensureDeployed(context)) ?? (await runDeployPhase(context))
    deployUrl = result.url
    return result.outcome
  }
  const outcome = await runQaPhase(context, deploy)
  if (outcome !== "completed") return outcome
  const access = ensureDemoAccess(store)
  if (deployUrl) store.log("deploy", `live at ${deployUrl}; log in as ${access.email} (the password is on the dashboard)`)
  if (change) context.github.changeFinished(change, deployUrl ? `The change is merged and live at ${deployUrl}.` : "The change is merged into main.")
  context.github.runCompleted(deployUrl)
  return "completed"
}

// F5 in docs/change-requests.md: the planner found nothing to build, so the docs merge without build, QA, or a redeploy.
async function finishDocsOnlyChange(context: PipelineContext, change: Change): Promise<RunOutcome> {
  const { store } = context
  store.log("change", `${change.id} has no new tasks; merging its docs without build, QA, or a redeploy`)
  const merged = await mergeChange(context, change)
  if (merged !== "completed") return merged
  store.setPhase("qa", "approved")
  store.setPhase("deploy", "approved")
  context.github.changeFinished(change, "The change needed no code. Its docs are merged into main; the app was not redeployed.")
  // No redeploy for the docs, but an app that was never deployed, or whose container stopped, goes live now.
  const deployed = await ensureDeployed(context)
  return deployed?.outcome ?? "completed"
}

// D3: one merge of the change branch into main, after QA passed. main is merged into the branch first when it moved,
// so the final merge never rewrites history; a conflict stops for a person.
async function mergeChange(context: PipelineContext, change: Change): Promise<RunOutcome> {
  const { config, projectDir, store } = context
  const approvalKey = `change.${change.id}.mergeApproved`
  if (config.autonomy.changeMerge === "manual" && store.meta(approvalKey) !== "1") {
    noteStop(context, `change ${change.id} ${changeWaitingText}: approve it on the dashboard to merge ${change.branch} into main`)
    store.log("change", `change ${change.id} ${changeWaitingText} into main (autonomy.changeMerge is manual)`)
    return "awaiting_approval"
  }
  try {
    // A hand edit of pipeline.yaml stays uncommitted in the project folder, and git refuses to merge over it.
    if (commitPaths(projectDir, ["pipeline.yaml"], "chore: save project settings")) store.log("change", `${change.id}: committed the uncommitted pipeline.yaml on main before the merge`)
    if (!isAncestor(projectDir, "main", change.branch)) {
      const workspace = createWorkspace(projectDir, `change-${change.id}-sync`, change.branch)
      try {
        const conflicts = mergeInto(workspace, "main", `chore(${change.id}): merge main into the change`)
        if (conflicts.length) {
          noteStop(context, `change ${change.id} ${changeWaitingText}: it conflicts with main in ${conflicts.join(", ")}. Merge main into ${change.branch} by hand, then resume`)
          store.log("change", `change ${change.id} ${changeWaitingText}: conflicts with main in ${conflicts.join(", ")}`)
          return "awaiting_approval"
        }
        fastForward(projectDir, workspace.branch, change.branch)
        store.log("change", `${change.id}: main moved during the change, so it was merged into ${change.branch}`)
      } finally {
        removeWorkspace(projectDir, workspace)
      }
    }
    const pullRequest = context.github.mergeChange(change, changePullRequestBody(context, change))
    if (!pullRequest) mergeIntoMain(projectDir, change.branch, `feat: ${changeTitle(change)}`)
    store.finishChange(change.id, "merged", pullRequest)
    store.log("change", `${changeMergedPrefix} ${change.id} into main${pullRequest ? ` through ${pullRequest}` : ""}`)
    return "completed"
  } catch (error) {
    noteStop(context, `change ${change.id} could not merge into main: ${(error as Error).message}`)
    store.log("change", `${change.id}: the merge into main failed: ${(error as Error).message.slice(0, 300)}`)
    return "paused"
  }
}

function changePullRequestBody(context: PipelineContext, change: Change): string {
  const { projectDir, store } = context
  const delta = fileAtRef(projectDir, change.branch, changePath(change.id, "spec.md")) ?? "(no spec delta)"
  const tasks = loadLandedTasks(context).filter((task) => task.change === change.id)
  const round = store.meta("qa.round")
  return [
    `Change request ${change.id}.`,
    "",
    "## Spec delta",
    "",
    delta.trim().slice(0, 20_000),
    "",
    "## Tasks",
    "",
    ...(tasks.length ? tasks.map((task) => `- ${task.id}: ${task.title}`) : ["none"]),
    "",
    "## QA",
    "",
    context.config.qa.enabled && round ? `QA passed in round ${round}.` : "QA is off for this project.",
  ].join("\n")
}

// During a change, tasks.json on main is the one from before the change; the branch holds the new tasks.
function landedTasksText(context: PipelineContext): string {
  const change = context.store.currentChange()
  if (!change) return readFileSync(join(context.projectDir, "tasks.json"), "utf8")
  const text = fileAtRef(context.projectDir, change.branch, "tasks.json")
  if (text === null) throw new Error(`tasks.json is missing on ${change.branch}`)
  return text
}

function loadLandedTasks(context: PipelineContext): Task[] {
  return parseTasks(landedTasksText(context))
}

// Runs every task in tasks.json that is not merged yet, up to config.parallelTasks at once.
// A task starts once its dependencies are merged and no running task can write the same paths.
// QA fix tasks and replans change tasks.json, so a replan waits for the running tasks, then reloads it.
async function buildTasks(context: PipelineContext): Promise<RunOutcome> {
  const { projectDir, config, store } = context
  let loadedText = ""
  const load = () => {
    loadedText = landedTasksText(context)
    const tasks = parseTasks(loadedText)
    store.syncTasks(tasks.map((task) => task.id))
    context.github.syncTaskIssues(tasks)
    return tasks
  }
  // The project lead can add or change tasks while the build runs (on the change branch during a change).
  const reloadIfChanged = () => {
    if (landedTasksText(context) !== loadedText) tasks = load()
  }
  let tasks = load()
  const running = new Map<string, { task: Task; result: Promise<{ id: string; outcome: TaskOutcome }> }>()
  let stop: RunOutcome | null = null
  let replanned = false
  for (;;) {
    if (!stop && !replanned) {
      reloadIfChanged()
      stop = blockedStop(context, tasks.filter((task) => !running.has(task.id)))
      if (!stop) {
        for (const task of tasks) {
          if (running.size >= config.parallelTasks) break
          if (!isReady(store, task, running)) continue
          const result = runTask(context, task).then((outcome) => ({ id: task.id, outcome }))
          running.set(task.id, { task, result })
        }
      }
    }
    if (!running.size) {
      if (stop) return stop
      if (replanned) {
        replanned = false
        tasks = load()
        continue
      }
      const unmerged = tasks.filter((task) => store.task(task.id).status !== "merged")
      if (!unmerged.length) break
      const skipped = unmerged.filter((task) => isAutoSkipped(store, task.id))
      if (skipped.length) {
        noteStop(context, `${skipped.map((task) => task.id).join(", ")} skipped by autonomy.decide: auto; nothing else can start: ${unmerged.map((task) => task.id).join(", ")} are not merged`)
        return "failed"
      }
      noteStop(context, `no task can start: ${unmerged.map((task) => task.id).join(", ")} wait on tasks that are not merged`)
      return "failed"
    }
    const { id, outcome } = await Promise.race([...running.values()].map((entry) => entry.result))
    running.delete(id)
    if (outcome === "replanned") replanned = true
    else if (outcome !== "completed" && outcome !== "skipped") stop ??= outcome
  }
  store.log("run", "all tasks merged")
  return "completed"
}

function isReady(store: Store, task: Task, running: Map<string, { task: Task }>): boolean {
  if (running.has(task.id) || store.task(task.id).status === "merged" || isAutoSkipped(store, task.id)) return false
  if (!task.dependsOn.every((dependency) => store.task(dependency)?.status === "merged")) return false
  return ![...running.values()].some((entry) => pathsOverlap(entry.task.allowedPaths, task.allowedPaths))
}

function blockedStop(context: PipelineContext, tasks: Task[]): RunOutcome | null {
  const { projectDir, store } = context
  const task = tasks.find((candidate) => store.task(candidate.id).status === "blocked" && !isAutoSkipped(store, candidate.id))
  if (!task) return null
  const row = store.task(task.id)
  if (row.humanReason) {
    noteStop(context, `${task.id} ${humanDecisionText}: ${row.humanReason}`)
    store.log("gate", `${task.id} ${humanDecisionText}: ${row.humanReason.slice(0, 500)}. Edit tasks.json if needed, then: agent-team retry ${projectDir} ${task.id}`)
    return "awaiting_approval"
  }
  noteStop(context, `${task.id} is blocked: ${row.lastFailure}`)
  store.log("task", `${task.id} is blocked: ${row.lastFailure}. Fix it, then: agent-team retry ${projectDir} ${task.id}`)
  return "failed"
}

async function runTask(context: PipelineContext, task: Task): Promise<TaskOutcome> {
  const { config, projectDir, store } = context
  const maxRetries = config.roles.worker.maxRetries ?? 3
  store.deleteMeta(autoSkipKey(task.id))
  while (store.task(task.id).attempts < maxRetries) {
    const { attempts, lastFailure } = store.task(task.id)
    const attempt = attempts + 1
    store.updateTask(task.id, "running", lastFailure)
    store.log("task", `${task.id} "${task.title}": attempt ${attempt}/${maxRetries}`)
    context.github.taskStarted(task, attempt)

    const earlierReasons = Array.from({ length: Math.max(attempts - 1, 0) }, (_, index) => readAttemptReason(projectDir, task.id, index + 1)).filter((reason): reason is string => Boolean(reason))
    const previous = lastFailure ? { reason: lastFailure, diff: readAttemptDiff(projectDir, task.id, attempts), earlierReasons } : null
    const result = await attemptTask(context, task, attempt, previous)
    switch (result.kind) {
      case "passed":
        store.countAttempt(task.id)
        store.updateTask(task.id, "merged")
        store.log("task", `${task.id} merged`)
        context.github.taskMerged(task)
        return "completed"
      case "infrastructure":
        store.updateTask(task.id, "pending", lastFailure)
        noteStop(context, `${task.id} paused: ${result.reason}`)
        store.log("task", `${task.id} paused, attempt not counted: ${result.reason.slice(0, 300)}`)
        return "paused"
      case "blocked":
        store.countAttempt(task.id)
        store.updateTask(task.id, "blocked", result.reason)
        store.log("task", `${task.id} blocked by worker: ${result.reason.slice(0, 300)}`)
        return handleBlock(context, task, result.block)
      case "budget":
        // Not counted: the worker ran out of money, not ideas. Its diff is saved under the current count so the next attempt resumes from it.
        writeAttemptDiff(projectDir, task.id, attempts, result.reason, result.diff)
        store.setMeta(taskBudgetStopKey(task.id), String(result.limitUsd))
        if (decidesAlone(context)) {
          const decided = decideBudget(context, task, result.limitUsd, result.reason)
          if (decided === "retry") continue
          return decided
        }
        return requireHuman(context, task, `${result.reason}. Approve more budget to continue.`)
      case "failed":
        store.countAttempt(task.id)
        writeAttemptDiff(projectDir, task.id, attempt, result.reason, result.diff ?? "")
        if (lastFailure && normalizeFailure(lastFailure) === normalizeFailure(result.reason)) {
          store.updateTask(task.id, "blocked", result.reason)
          store.log("task", `${task.id} failed the same way on attempts ${attempt - 1} and ${attempt}; replanning instead of retrying`)
          return handleBlock(context, task, { kind: "spec", needPaths: [], reason: `the same failure repeated on two attempts in a row:\n${result.reason}` })
        }
        store.updateTask(task.id, "pending", result.reason)
        store.log("task", `${task.id} failed: ${result.reason.slice(0, 500)}`)
        context.github.attemptFailed(task, attempt, result.reason)
    }
  }
  store.updateTask(task.id, "blocked", store.task(task.id).lastFailure)
  noteStop(context, `${task.id} blocked after ${maxRetries} attempts: ${store.task(task.id).lastFailure ?? "no reason"}`)
  store.log("task", `${task.id} blocked after ${maxRetries} attempts`)
  context.github.taskBlocked(task, store.task(task.id).lastFailure ?? "max attempts reached")
  return "failed"
}

async function handleBlock(context: PipelineContext, task: Task, block: Block): Promise<TaskOutcome> {
  const { store } = context
  // A scope block for files the task already owns means a tool call was refused, not that the plan is wrong.
  // A replan cannot fix that, so the task retries once with a note instead of spending its replan or a human gate.
  if (block.kind === "scope" && block.needPaths.length && !filesOutsideScope(block.needPaths, task.allowedPaths).length) {
    const key = `task.${task.id}.inScopeRetry`
    if (!store.meta(key)) {
      store.setMeta(key, "1")
      const note = "Every file listed is already inside allowedPaths, so this is not a scope problem. Edit those files with the Edit and Write tools, not through Bash."
      store.updateTask(task.id, "pending", `${formatBlock(block)}\n${note}`)
      store.log("task", `${task.id}: asked for files it already owns; retrying with a note instead of replanning`)
      return "replanned"
    }
  }
  if (store.task(task.id).replans >= maxReplansPerTask) {
    const reason = `${task.id} was already replanned once and is blocked again. ${formatBlock(block)}`
    return decideScope(context, task, reason)
  }
  store.log("replan", `${task.id}: asking the planner to replan (${block.kind} block)`)
  const result = await replanTask(context, task, block)
  if (result.kind === "infrastructure") {
    store.updateTask(task.id, "pending", formatBlock(block))
    noteStop(context, `${task.id} paused during a replan: ${result.reason}`)
    store.log("replan", `${task.id}: paused before the replan finished: ${result.reason.slice(0, 300)}`)
    return "paused"
  }
  store.countReplan(task.id)
  if (result.kind === "human") {
    const reason = `${result.reason}\n${formatBlock(block)}`
    return decideScope(context, task, reason)
  }
  store.resetTask(task.id)
  if (!result.tasks.some((entry) => entry.id === task.id)) store.removeTask(task.id)
  store.log("replan", `${task.id}: ${result.summary}; attempts reset`)
  return "replanned"
}

const maxAutoApprovals = 2

// autonomy.autoApproveScope: gives a blocked task the files it asked for, as the dashboard's Approve button would,
// instead of stopping the run. null means a person decides: the mode is off, nothing was asked for, or the task
// already used its automatic approvals.
// With unlimited (autonomy.decide: auto), the switch and the maxAutoApprovals limit do not apply.
async function autoApproveScope(context: PipelineContext, task: Task, reason: string, unlimited = false): Promise<TaskOutcome | null> {
  const { projectDir, store } = context
  // Reread so the dashboard switch applies to a running build.
  let enabled = context.config.autonomy.autoApproveScope
  try {
    enabled = loadConfig(join(projectDir, "pipeline.yaml")).autonomy.autoApproveScope
  } catch {}
  if (!enabled && !unlimited) return null
  const paths = suggestedPaths(reason)
  const countKey = `task.${task.id}.autoApprovals`
  const used = Number(store.meta(countKey) ?? 0)
  if (!paths.length || (used >= maxAutoApprovals && !unlimited)) return null
  const setting = unlimited ? "autonomy.decide is auto" : "autonomy.autoApproveScope is on"
  const workspace = createWorkspace(projectDir, `auto-approve-${task.id}-${used + 1}`, landingBranch(context))
  try {
    const current = loadTasks(join(workspace.path, "tasks.json"))
    const { tasks, owners } = widenTask(current, task.id, paths, (id) => store.task(id)?.status === "merged")
    const body = [`${task.id} asked for files outside its scope, and ${setting}.`, "", ...paths.map((path) => `- ${path}`), ...(owners.length ? ["", `It now waits for ${owners.join(", ")}.`] : [])].join("\n")
    landTasksFile(context, workspace, tasks, `chore(plan): widen ${task.id} automatically`, body)
  } catch (error) {
    store.log("task", `${task.id}: automatic scope approval failed, asking a person: ${(error as Error).message.slice(0, 300)}`)
    return null
  } finally {
    removeWorkspace(projectDir, workspace)
  }
  store.setMeta(countKey, String(used + 1))
  store.resetTask(task.id)
  store.log(unlimited ? "autonomy" : "task", `${task.id}: scope approved automatically (${paths.join(", ")}) because ${setting}; attempts reset`)
  return "replanned"
}

// ---------- autonomy.decide: auto ----------

// Reread so a change in pipeline.yaml applies to a running build.
function decidesAlone(context: PipelineContext): boolean {
  let mode = context.config.autonomy.decide
  try {
    mode = loadConfig(join(context.projectDir, "pipeline.yaml")).autonomy.decide
  } catch {}
  return mode === "auto"
}

const autoSkipKey = (taskId: string) => `task.${taskId}.autoSkipped`
const autoBudgetKey = (taskId: string) => `task.${taskId}.autoBudgetRaised`
const autoBudgetRaiseFactor = 1.5

function isAutoSkipped(store: Store, taskId: string): boolean {
  return store.task(taskId)?.status === "blocked" && store.meta(autoSkipKey(taskId)) === "1"
}

// A scope block: widen the task with the files it asked for, with no limit on how often. A task that asks again
// for files it already has (or names none) would loop, so it is set aside instead.
async function decideScope(context: PipelineContext, task: Task, reason: string): Promise<TaskOutcome> {
  if (!decidesAlone(context)) return (await autoApproveScope(context, task, reason)) ?? requireHuman(context, task, reason)
  const paths = suggestedPaths(reason)
  if (!paths.length) return skipTask(context, task, reason, "it named no files to add")
  if (!filesOutsideScope(paths, task.allowedPaths).length) return skipTask(context, task, reason, `it asked again for files it already has (${paths.join(", ")})`)
  return (await autoApproveScope(context, task, reason, true)) ?? skipTask(context, task, reason, "its scope could not be widened")
}

// A task out of its own budget: +50% once when the run budget still has that much left, else set it aside.
function decideBudget(context: PipelineContext, task: Task, limitUsd: number, reason: string): "retry" | "skipped" {
  const { store } = context
  const raised = Math.round(limitUsd * autoBudgetRaiseFactor * 100) / 100
  const left = currentRunBudget(context) - store.projectCost().usd
  if (store.meta(autoBudgetKey(task.id)) === "1") return skipTask(context, task, reason, "its budget was already raised once")
  if (left < raised) return skipTask(context, task, reason, `the run budget has $${Math.max(left, 0).toFixed(2)} left, less than the $${raised.toFixed(2)} a raise needs`)
  store.setMeta(autoBudgetKey(task.id), "1")
  store.setMeta(taskBudgetKey(task.id), String(raised))
  store.deleteMeta(taskBudgetStopKey(task.id))
  store.log("autonomy", `${task.id}: budget raised from $${limitUsd.toFixed(2)} to $${raised.toFixed(2)} because autonomy.decide is auto and the run budget has $${left.toFixed(2)} left`)
  return "retry"
}

// Blocks the task without waiting for a person, records why on its GitHub issue, and lets the run go on.
// agent-team retry puts it back in the queue.
function skipTask(context: PipelineContext, task: Task, reason: string, why: string): "skipped" {
  const { store } = context
  const text = `${reason}\nSkipped automatically because autonomy.decide is auto: ${why}.`
  store.updateTask(task.id, "blocked", text)
  store.setMeta(autoSkipKey(task.id), "1")
  store.log("autonomy", `${task.id} skipped: ${why}. The run goes on with the other tasks. To retry: agent-team retry ${context.projectDir} ${task.id}`)
  context.github.taskBlocked(task, text)
  return "skipped"
}

function requireHuman(context: PipelineContext, task: Task, reason: string): RunOutcome {
  context.store.requireHuman(task.id, reason)
  noteStop(context, `${task.id} ${humanDecisionText}: ${reason}`)
  context.store.log("gate", `${task.id} ${humanDecisionText}: ${reason.slice(0, 500)}. Edit tasks.json if needed, then: agent-team retry ${context.projectDir} ${task.id}`)
  context.github.taskBlocked(task, reason)
  return "awaiting_approval"
}

function mergedTaskIds(statuses: Record<string, string>): Set<string> {
  return new Set(Object.keys(statuses).filter((id) => statuses[id] === "merged"))
}

type ReplanResult = ReplanDecision | { kind: "infrastructure"; reason: string }

// The planner gets the blocked task, the block, every task with its status, and the tracked files,
// and answers with one action. A valid "apply" lands on main like QA fix tasks do.
async function replanTask(context: PipelineContext, task: Task, block: Block): Promise<ReplanResult> {
  const { projectDir, store } = context
  const name = `replan-${task.id}`
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const tasks = loadTasks(join(workspace.path, "tasks.json"))
    const statuses = Object.fromEntries(tasks.map((entry) => [entry.id, store.task(entry.id)?.status ?? "pending"]))
    const files = trackedFiles(workspace.path)
    let previousError: string | null = null
    for (let attempt = 1; attempt <= phaseAttempts; attempt++) {
      const prompt = replanPrompt({ task, block, tasks, statuses, files, previousError })
      const outcome = await runAgent(context, executor, "planner", `${name}-${attempt}`, replannerTools, prompt, { promptName: "replanner" })
      if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `planner ${outcome.failureClass}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      let decision: ReplanDecision
      try {
        decision = decideReplan(tasks, task.id, parseReplanAction(outcome.result.summary), mergedTaskIds(statuses))
      } catch (error) {
        previousError = (error as Error).message
        store.log("replan", `${task.id}: answer rejected: ${previousError.slice(0, 300)}`)
        continue
      }
      if (decision.kind === "apply") {
        landTasksFile(context, workspace, decision.tasks, `chore(plan): replan ${task.id}`, [`${task.id} was blocked:`, "", "```", formatBlock(block).slice(0, 3000), "```", "", `The planner ${decision.summary}.`].join("\n"))
      }
      return decision
    }
    return { kind: "human", reason: `the planner gave no usable replan: ${previousError ?? "no answer"}` }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

export function replanPrompt(input: { task: Task; block: Block; tasks: Task[]; statuses: Record<string, string>; files: string[]; previousError: string | null }): string {
  const { task, block, files } = input
  const listed = files.slice(0, maxListedFiles)
  const lines = [
    `Task ${task.id} is blocked. Replan it.`,
    "",
    "## Blocked task",
    "",
    "```json",
    JSON.stringify(task, null, 2),
    "```",
    "",
    "## Block reported by the worker",
    "",
    "```json",
    JSON.stringify(block, null, 2),
    "```",
    "",
    "## All tasks",
    "",
    ...input.tasks.map((entry) => `- ${entry.id} [${input.statuses[entry.id] ?? "pending"}] ${entry.title}; dependsOn: ${entry.dependsOn.join(", ") || "none"}; allowedPaths: ${entry.allowedPaths.join(", ")}`),
    "",
    "## Tracked files (git ls-files)",
    "",
    ...listed,
  ]
  if (files.length > listed.length) lines.push(`[${files.length - listed.length} more files not shown]`)
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

// The smoke check uses fixed container names per project, so parallel tasks take turns.
let smokeQueue: Promise<unknown> = Promise.resolve()
function serializeSmoke<T>(check: () => Promise<T>): Promise<T> {
  const result = smokeQueue.then(check, check)
  smokeQueue = result.catch(() => {})
  return result
}

function workerBudget(context: PipelineContext, taskId: string): number {
  const raised = Number(context.store.meta(taskBudgetKey(taskId)))
  return raised > 0 ? raised : context.config.budget.perTaskUsd
}

async function attemptTask(context: PipelineContext, task: Task, attempt: number, previous: PreviousAttempt | null): Promise<AttemptResult> {
  const { projectDir, store } = context
  const workspace = createWorkspace(projectDir, `${task.id}-${attempt}`, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, `${task.id}-${attempt}`)
  const rejected = (reason: string): AttemptResult => ({ kind: "failed", reason, diff: stagedDiff(workspace.path) })
  try {
    const setupCommand = workspaceSetupCommand(workspace.path)
    if (setupCommand) {
      const setup = await runCommand(context, executor, setupCommand, `${task.id}-${attempt}-setup`)
      if (!setup.passed) return { kind: "infrastructure", reason: `workspace setup failed (${setupCommand}):\n${setup.output}` }
    }

    const drawn = await drawTaskIllustrations(context, executor, workspace.path, task)
    if (drawn) return drawn
    copyTaskFiles(workspace.path, task)
    const files = trackedFiles(workspace.path)
    const hasProgress = existsSync(join(workspace.path, progressPath))
    const dependencyFiles = dependencyChanges(store, task)
    const prompt = workerPrompt({ task, previous, codeMap: codeMap(files), dependencyFiles, hasProgress, similar: similarSolutions(context, task) })
    const budgetUsd = workerBudget(context, task.id)
    const worker = await runAgent(context, executor, "worker", `${task.id}-worker-${attempt}`, workerTools(task), prompt, { writablePaths: task.allowedPaths, budgetUsd })
    if (isInfrastructureFailure(worker)) return { kind: "infrastructure", reason: `worker ${worker.failureClass}: ${worker.result.summary}` }
    if (worker.failureClass === "budget") return { kind: "budget", reason: `worker reached its $${budgetUsd.toFixed(2)} budget`, limitUsd: budgetUsd, diff: stagedDiff(workspace.path) }
    if (worker.result.status !== "done") return rejected(`worker ${worker.result.status}: ${worker.result.summary}`)
    const block = parseBlock(worker.result.summary)
    if (block) return { kind: "blocked", reason: formatBlock(block), block }

    // Workers cannot write these, but tools they run can (next dev adds its own block to AGENTS.md), so put them back.
    const forbidden = changedFiles(workspace.path).filter((file) => orchestratorFiles.includes(file))
    if (forbidden.length) {
      restorePaths(workspace.path, forbidden)
      store.log("task", `${task.id} attempt ${attempt}: restored files that only the orchestrator writes: ${forbidden.join(", ")}`)
    }
    const changed = changedFiles(workspace.path)
    const outside = filesOutsideScope(changed, [...task.allowedPaths, ...(task.illustrations ?? []).flatMap((entry) => [entry.to, promptFileOf(entry.to)])])
    if (outside.length) return rejected(`edited files outside allowedPaths: ${outside.join(", ")}`)

    const verification = await runCheck(context, executor, task.verify, `${task.id}-${attempt}-verify`, `${task.id} verify`)
    if (!verification.passed) return rejected(`verify command failed:\n${verification.output}`)

    let screenshotsDir: string | null = null
    if (task.ui) {
      const access = ensureDemoAccess(store)
      const smoke = await serializeSmoke(() => (context.smokeCheck ?? runUiSmoke)({ projectDir, worktree: workspace.path, task, attempt, signal: context.signal, access }))
      // Before the app first boots, a start failure is expected and skipped. After that it is a regression: twelve tasks
      // once merged unchecked because the app stopped starting.
      if (smoke.kind === "skipped" && store.meta(smokePassedKey) && /app did not start/.test(smoke.reason)) {
        store.log("smoke", `${task.id} attempt ${attempt}: the app started before this task and does not start now`)
        return rejected(`the app no longer starts after this change (it started before). Fix the start:\n${smoke.reason}`)
      }
      if (smoke.kind === "skipped") store.log("smoke", `${task.id} attempt ${attempt}: UI smoke check skipped: ${smoke.reason.slice(0, 500)}`)
      else if (smoke.kind === "passed") {
        store.setMeta(smokePassedKey, "1")
        store.log("smoke", `${task.id} attempt ${attempt}: UI smoke check passed on ${smoke.routes} routes, desktop and mobile`)
        screenshotsDir = smoke.outDir ?? null
      } else {
        store.log("smoke", `${task.id} attempt ${attempt}: UI smoke check failed:\n${smoke.reason.slice(0, 1500)}`)
        return rejected(`UI smoke check failed:\n${smoke.reason}`)
      }
    }

    const diff = stagedDiff(workspace.path)
    const writer = worker.candidate ?? context.config.roles.worker
    const reviewInput = { task, diff, verifyOutput: verification.output, hasProgress, dependencyFiles }
    let verdict: ReviewVerdict | null = null
    let reviewError: string | null = null
    for (let reviewAttempt = 1; reviewAttempt <= reviewAttempts && !verdict; reviewAttempt++) {
      const subject = reviewAttempt === 1 ? `${task.id}-review-${attempt}` : `${task.id}-review-${attempt}-${reviewAttempt}`
      const review = await runAgent(context, executor, "reviewer", subject, reviewerTools, reviewPrompt({ ...reviewInput, previousError: reviewError }), {
        promptVariables: { writer: `${writer.runner} ${writer.model}` },
      })
      if (isInfrastructureFailure(review)) return { kind: "infrastructure", reason: `reviewer ${review.failureClass}: ${review.result.summary}` }
      if (review.result.status !== "done") return { kind: "failed", reason: `reviewer ${review.result.status}: ${review.result.summary}`, diff }
      try {
        verdict = parseVerdict(review.result.summary)
      } catch (error) {
        reviewError = (error as Error).message
        store.log("review", `${task.id} attempt ${attempt}: verdict rejected: ${reviewError.slice(0, 300)}`)
      }
    }
    if (!verdict) return { kind: "failed", reason: `the reviewer gave no valid verdict: ${reviewError}`, diff }
    const fileHashes = diffFileHashes(diff)
    store.recordReview({
      taskId: task.id,
      attempt,
      verdict: verdict.verdict,
      flaggedFiles: verdict.verdict === "fail" ? flaggedFiles(Object.keys(fileHashes), verdict) : [],
      fileHashes,
    })
    if (verdict.verdict !== "pass") {
      return { kind: "failed", reason: `reviewer rejected the change.\nReasons: ${verdict.reasons.join("; ")}\nFixes: ${verdict.fixes.join("; ")}`, diff }
    }

    if (screenshotsDir && existsSync(join(screenshotsDir, "report.json"))) {
      const review = await reviewScreens(context, executor, workspace.path, task, attempt, screenshotsDir)
      if (review.kind === "stopped") return review.result.kind === "failed" ? { ...review.result, diff } : review.result
      const { verdict: design } = review
      store.log("review", `${task.id} attempt ${attempt}: UI review ${design.verdict}${design.reasons.length ? `: ${design.reasons.join("; ").slice(0, 500)}` : ""}`)
      if (design.departures?.length) store.log("review", `${task.id}: departures from the branding: ${design.departures.join("; ").slice(0, 1000)}`)
      if (design.verdict !== "pass") {
        return { kind: "failed", reason: `the design reviewer rejected the screens.\nReasons: ${design.reasons.join("; ")}\nFixes: ${design.fixes.join("; ")}`, diff }
      }
    }

    const title = `feat(${task.id}): ${task.title}`
    const plan = parseCommitPlan(worker.result.summary, changed)
    if (plan.kind === "invalid") store.log("task", `${task.id} attempt ${attempt}: commit plan ignored, landing one commit: ${plan.reason}`)
    try {
      // Tasks run in parallel, so the progress entry goes on after the rebase; appending first would conflict on every merge.
      commitAndRebase(workspace, title, plan.kind === "groups" ? plan.groups : [])
      appendProgress(workspace.path, task, changed, worker.result.summary)
      amendCommit(workspace, title)
      context.github.land({ workspace, title, body: pullRequestBody(context, task, attempt, verdict) })
    } catch (error) {
      return { kind: "failed", reason: `merge failed: ${(error as Error).message}` }
    }
    store.setTaskFiles(task.id, changed)
    rememberSolution(context, task, changed, worker.result.summary, diff)
    store.log("progress", `${task.id}: appended to ${progressPath} (${changed.length} files)`)
    return { kind: "passed" }
  } catch (error) {
    store.log("harness", `${task.id} attempt ${attempt} crashed: ${(error as Error).message}`)
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

// The reviewer sees only its worktree, so the screenshots are copied in, and removed again before the commit.
async function reviewScreens(context: PipelineContext, executor: Executor, dir: string, task: Task, attempt: number, screenshotsDir: string): Promise<ReviewOutcome> {
  const reviewPath = join(".agent-team", "ui-review", `${task.id}-${attempt}`)
  const target = join(dir, reviewPath)
  cpSync(screenshotsDir, target, { recursive: true })
  try {
    const report = JSON.parse(readFileSync(join(target, "report.json"), "utf8")) as VisualReport
    const screens = parseDesignScreens(existsSync(join(dir, "docs/design.md")) ? readFileSync(join(dir, "docs/design.md"), "utf8") : "")
    const prompt = (previousError: string | null) => uiReviewPrompt({ task, report, reviewPath, screens, brandingImages: listBrandingImages(dir), previousError })
    return await reviewWithRetries(context, executor, `${task.id}-ui-review-${attempt}`, "ui-reviewer", prompt)
  } finally {
    rmSync(join(dir, ".agent-team", "ui-review"), { recursive: true, force: true })
  }
}

export function uiReviewPrompt(input: { task: Task; report: VisualReport; reviewPath: string; screens: QaScreen[]; brandingImages: string[]; previousError: string | null }): string {
  const { task, report, reviewPath } = input
  const mobile = report.mobileViewport ? `${report.mobileViewport.width}x${report.mobileViewport.height}` : "phone size"
  const lines = [
    `Review the screens of task ${task.id} "${task.title}".`,
    "",
    "## Task",
    "",
    ...task.acceptance.map((criterion) => `- ${criterion}`),
    "",
    `## Screenshots (desktop ${report.viewport.width}x${report.viewport.height}, mobile ${mobile})`,
    "",
  ]
  for (const route of report.routes) {
    const screen = input.screens.find((entry) => entry.route === route.route)
    const branding = screen?.branding ? `; branding design/branding/${screen.branding}` : ""
    const mobileBranding = screen?.branding && input.brandingImages.includes(`design/branding/${mobileImageName(screen.branding)}`) ? `, mobile branding design/branding/${mobileImageName(screen.branding)}` : ""
    const desktopShot = route.file ? `${reviewPath}/${route.file}` : "no screenshot"
    const mobileShot = route.mobile?.file ? `${reviewPath}/${route.mobile.file}` : "no screenshot"
    lines.push(`- \`${route.route}\`: desktop ${desktopShot}, mobile ${mobileShot}${branding}${mobileBranding}`)
    const tight = route.mobile?.layout?.tightTargets ?? []
    if (tight.length) lines.push(`  Tap targets under 44px on mobile: ${tight.join("; ")}`)
  }
  lines.push("", "Read docs/design.md, docs/design-system.md, and design/tokens.css.")
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

// Files merged by the tasks this one depends on, oldest dependency first.
function dependencyChanges(store: Store, task: Task): { taskId: string; files: string[] }[] {
  return task.dependsOn.map((taskId) => ({ taskId, files: store.taskFiles(taskId) }))
}

// The orchestrator, not the agent, keeps this log; it lands in the same commit as the task.
export function appendProgress(dir: string, task: Task, files: string[], workerSummary: string): void {
  const path = join(dir, progressPath)
  mkdirSync(join(dir, "docs"), { recursive: true })
  const header = existsSync(path) ? "" : "# Progress\n\nThe orchestrator appends one entry per merged task. Read it before you start.\n"
  const summary = workerSummary.trim().split("\n").map((line) => line.trim()).filter(Boolean).slice(0, maxSummaryLines)
  const entry = [
    "",
    `## ${task.id}: ${task.title}`,
    "",
    `Files: ${files.length ? files.map((file) => `\`${file}\``).join(", ") : "none"}`,
    "",
    ...(summary.length ? summary.map((line) => `> ${line}`) : ["> (no summary)"]),
    "",
  ].join("\n")
  writeFileSync(path, `${existsSync(path) ? readFileSync(path, "utf8").trimEnd() + "\n" : header}${entry}`)
}

// A compact tree of the tracked files, without lockfiles and binary assets, capped at maxLines lines.
export function codeMap(files: string[], maxLines = maxCodeMapLines): string[] {
  const shown = files.filter((file) => !lockfileNames.has(file.split("/").pop() ?? "") && !assetPattern.test(file)).sort()
  const lines: string[] = []
  const openDirectories: string[] = []
  for (const file of shown) {
    const parts = file.split("/")
    let depth = 0
    while (depth < openDirectories.length && depth < parts.length - 1 && openDirectories[depth] === parts[depth]) depth++
    openDirectories.length = depth
    for (; depth < parts.length - 1; depth++) {
      lines.push(`${"  ".repeat(depth)}${parts[depth]}/`)
      openDirectories.push(parts[depth])
    }
    lines.push(`${"  ".repeat(depth)}${parts[depth]}`)
  }
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), `[${lines.length - maxLines + 1} more lines not shown]`]
}

function attemptDiffPath(projectDir: string, taskId: string, attempt: number): string {
  return join(projectDir, ".agent-team", "attempts", `${taskId}-${attempt}.diff`)
}

// The file starts with the failure reason as `# ` lines, then the diff, so `git apply` still reads it.
function writeAttemptDiff(projectDir: string, taskId: string, attempt: number, reason: string, diff: string): void {
  const path = attemptDiffPath(projectDir, taskId, attempt)
  mkdirSync(join(projectDir, ".agent-team", "attempts"), { recursive: true })
  const header = [`Attempt ${attempt} of ${taskId} was rejected.`, "Reason:", ...reason.split("\n")].map((line) => `# ${line}`.trimEnd())
  writeFileSync(path, `${header.join("\n")}\n\n${capDiff(diff)}`)
}

function readAttemptDiff(projectDir: string, taskId: string, attempt: number): string | null {
  const path = attemptDiffPath(projectDir, taskId, attempt)
  // Attempt 0 holds the diff of a first attempt that stopped at its budget, which is not counted.
  if (attempt < 0 || !existsSync(path)) return null
  const lines = readFileSync(path, "utf8").split("\n")
  const start = lines.findIndex((line) => !line.startsWith("#"))
  const diff = lines.slice(start === -1 ? lines.length : start).join("\n").trim()
  return diff || null
}

function readAttemptReason(projectDir: string, taskId: string, attempt: number): string | null {
  const path = attemptDiffPath(projectDir, taskId, attempt)
  if (!existsSync(path)) return null
  const lines = readFileSync(path, "utf8").split("\n")
  const end = lines.findIndex((line) => !line.startsWith("#"))
  const header = lines.slice(0, end === -1 ? lines.length : end).map((line) => line.replace(/^# ?/, ""))
  const start = header.indexOf("Reason:")
  return start === -1 ? null : header.slice(start + 1).join("\n").trim() || null
}

function capDiff(diff: string): string {
  return diff.length > maxAttemptDiffLength ? `${diff.slice(0, maxAttemptDiffLength)}\n[diff truncated at 40 KB]` : diff
}

async function runQaPhase(context: PipelineContext, deploy: () => Promise<RunOutcome>): Promise<RunOutcome> {
  const { config, store } = context
  if (!config.qa.enabled) {
    if (store.phaseStatus("qa") !== "approved") {
      store.setPhase("qa", "approved")
      store.log("phase", "qa skipped: disabled in pipeline.yaml")
    }
    return deploy()
  }
  return runQaLoop(store, config.qa.maxRounds, {
    runRound: async (round) => {
      const result = await runQaRound(context, round)
      if (result.kind === "infrastructure") noteStop(context, `QA round ${round} paused: ${result.reason}`)
      if (result.kind === "invalid") noteStop(context, `QA round ${round} gave no usable verdict: ${result.reason}`)
      return result
    },
    applyFixes: (round, tasks) => appendFixTasks(context, round, tasks),
    build: () => buildTasks(context),
    deploy,
  })
}

interface TestGateResult {
  install: string | null
  command: string | null
  passed: boolean
  output: string
}

// Round artifacts go to .agent-team/qa/round-<n>/ (.agent-team/qa/<changeId>/round-<n>/ during a change):
// tests.json, report.json, <route-slug>.png, verdict.json.
export function qaRoundPath(changeId: string | null, round: number): string {
  return changeId ? join(".agent-team", "qa", changeId, `round-${round}`) : join(".agent-team", "qa", `round-${round}`)
}

async function runQaRound(context: PipelineContext, round: number): Promise<QaRoundResult> {
  const { projectDir, config, store } = context
  const change = store.currentChange()
  const roundPath = qaRoundPath(change?.id ?? null, round)
  const outDir = join(projectDir, roundPath)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const name = `qa-${round}`
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const tests = await runTestGate(context, executor, workspace.path, name)
    writeJson(join(outDir, "tests.json"), tests)
    store.log("qa", `round ${round}: tests ${tests.command ? (tests.passed ? "passed" : "failed") : "not found"}`)

    let visual: VisualReport | null = null
    let screens: QaScreen[] = []
    if (config.target === "api") {
      store.log("qa", `round ${round}: visual gate skipped: api-only target`)
    } else {
      const designPath = join(workspace.path, "docs/design.md")
      const design = existsSync(designPath) ? readFileSync(designPath, "utf8") : ""
      screens = config.import ? importedScreens(parseDesignScreens(design), workspace.path) : parseDesignScreens(design)
      visual = await captureScreenshots({ projectDir, outDir, screens, signal: context.signal, login: { route: parseLoginRoute(design), access: ensureDemoAccess(store) }, ref: landingBranch(context) })
      const broken = visual.routes.filter((route) => route.error || (route.status ?? 0) >= 400).length
      store.log("qa", visual.startError ? `round ${round}: app did not start: ${visual.startError.slice(0, 300)}` : `round ${round}: ${visual.routes.length} screenshots, ${broken} broken routes`)
      // The reviewer sees only its worktree, so the round's files are copied in at the same relative path.
      cpSync(outDir, join(workspace.path, roundPath), { recursive: true })
    }

    const existing = loadTasks(join(workspace.path, "tasks.json"))
    const baseline = config.import ? readBaseline(projectDir) : null
    const { regressions, preexisting } = splitFailures(gateFailures(tests, visual), tests.output, baseline)
    const hardFailures = regressions.map((failure) => failure.message)
    if (noPageRendered(visual)) {
      hardFailures.push(noPageRenderedMessage)
      store.log("qa", `round ${round}: ${noPageRenderedMessage}`)
    }
    if (preexisting.length) store.log("qa", `round ${round}: ${preexisting.length} failures were already in the import baseline and do not fail the round`)
    const changeScope = change ? { id: change.id, routes: [...new Set(existing.filter((task) => task.change === change.id).flatMap((task) => task.routes ?? []))] } : null
    let previousError: string | null = null
    for (let attempt = 1; attempt <= phaseAttempts; attempt++) {
      const prompt = qaPrompt({ round, roundPath, target: config.target, resolveAll: config.qa.resolveAll, appLimits: appLimitsText, agentLimits: config.harness.isolation === "docker" ? `${config.harness.docker.memory} memory, ${config.harness.docker.cpus} CPUs` : "the host, no container limits", tests, visual, screens, brandingImages: listBrandingImages(workspace.path), existing, hardFailures, preexisting: preexisting.map((failure) => failure.message), imported: Boolean(config.import), previousError, change: changeScope })
      const outcome = await runAgent(context, executor, "qa", `qa-${round}-review-${attempt}`, qaTools, prompt)
      if (isInfrastructureFailure(outcome)) return { kind: "infrastructure", reason: `qa ${outcome.failureClass}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      try {
        const verdict = parseQaVerdict(outcome.result.summary, round, existing)
        if (verdict.verdict === "pass" && hardFailures.length) throw new Error(`the verdict cannot be pass while these gates fail: ${hardFailures.join("; ")}`)
        if (verdict.verdict === "pass" && config.qa.resolveAll && verdict.findings.length) throw new Error("qa.resolveAll is on, so a pass may not list findings: return fail with a fix task that covers every finding, minor ones included")
        writeJson(join(outDir, "verdict.json"), { round, ...verdict, preexisting: preexisting.map((failure) => failure.message) })
        if (verdict.verdict === "pass" && baseline) writeBaseline(projectDir, createBaseline({ commit: commitOf(projectDir, landingBranch(context)), tests, visual, summary: tests.passed ? "" : keyFailureLines(tests.output) }), nextBaselinePath)
        return verdict.verdict === "pass" ? { kind: "pass", findings: verdict.findings } : { kind: "fail", findings: verdict.findings, tasks: verdict.tasks }
      } catch (error) {
        previousError = (error as Error).message
        store.log("qa", `round ${round}: verdict rejected: ${previousError.slice(0, 300)}`)
      }
    }
    writeJson(join(outDir, "verdict.json"), { round, verdict: "invalid", reason: previousError, findings: [], tasks: [] })
    return { kind: "invalid", reason: previousError ?? "no verdict" }
  } catch (error) {
    return { kind: "infrastructure", reason: (error as Error).message }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}

async function runTestGate(context: PipelineContext, executor: Executor, dir: string, subject: string): Promise<TestGateResult> {
  const { install, test: command } = resolveCommands(dir)
  if (!command) return { install, command, passed: true, output: "No test command in docs/architecture.md or package.json." }
  if (install) {
    const setup = await runCommand(context, executor, install, `${subject}-install`)
    if (!setup.passed) return { install, command, passed: false, output: `install failed (${install}):\n${setup.output}` }
  }
  const result = await runCheck(context, executor, command, `${subject}-test`, "QA tests")
  return { install, command, passed: result.passed, output: result.output }
}

export function qaHardFailures(tests: TestGateResult, visual: VisualReport | null): string[] {
  return gateFailures(tests, visual).map((failure) => failure.message)
}

function listBrandingImages(dir: string): string[] {
  for (const brandingDir of ["design/branding", "design/mockups"]) {
    const path = join(dir, brandingDir)
    if (existsSync(path)) return readdirSync(path).filter((file) => imagePattern.test(file)).sort().map((file) => `${brandingDir}/${file}`)
  }
  return []
}

function qaPrompt(input: {
  resolveAll: boolean
  appLimits: string
  agentLimits: string
  round: number
  roundPath: string
  target: PipelineConfig["target"]
  tests: TestGateResult
  visual: VisualReport | null
  screens: QaScreen[]
  brandingImages: string[]
  existing: Task[]
  hardFailures: string[]
  // Failures the import baseline already had; they never fail a round.
  preexisting?: string[]
  imported?: boolean
  previousError: string | null
  change?: { id: string; routes: string[] } | null
}): string {
  const { round, roundPath, tests, visual, change } = input
  const lines = [`QA round ${round}. Project target: ${input.target}.`, ""]
  if (change) {
    lines.push(
      `## Change ${change.id}`,
      "",
      `This round checks change request ${change.id}. Read ${changePath(change.id, "request.md")} and the spec delta ${changePath(change.id, "spec.md")}.`,
      `The change's routes: ${change.routes.length ? change.routes.map((route) => `\`${route}\``).join(", ") : "none listed"}.`,
      "Judge the change's routes against the delta. On other routes, fail only on regressions.",
      "",
    )
  }
  lines.push("## Gate 1: tests", "")
  if (tests.command) lines.push(`Install: \`${tests.install ?? "none"}\`. Test: \`${tests.command}\`. Result: ${tests.passed ? "passed" : "FAILED"}.`, "", "```", tests.output.trim(), "```")
  else lines.push(tests.output)
  lines.push("", "## Gate 2: screenshots", "")
  if (!visual) lines.push("Skipped: the target is api only.")
  else if (visual.startError) lines.push("The app did not start, so there are no screenshots:", "", "```", visual.startError, "```")
  else {
    if (visual.login) lines.push(visual.login.ok ? `Signed-in routes were captured after logging in at ${visual.login.route} with the demo account.` : `The demo account could not log in at ${visual.login.route}: ${visual.login.error}`, "")
    const mobile = visual.mobileViewport ? ` and on a phone at ${visual.mobileViewport.width}x${visual.mobileViewport.height}` : ""
    lines.push(`Each route was loaded at ${visual.viewport.width}x${visual.viewport.height}${mobile} and captured full page. Full report: ${roundPath}/report.json.`, "")
    for (const route of visual.routes) {
      const shot = route.file ? `${roundPath}/${route.file}` : "no screenshot"
      const status = route.error ? `error: ${route.error}` : `HTTP ${route.status ?? "unknown"}`
      const errors = route.consoleErrors.length ? `; console errors: ${route.consoleErrors.slice(0, 5).join(" | ")}` : "; no console errors"
      const branding = route.branding ? `; compare with design/branding/${route.branding}` : ""
      lines.push(`- \`${route.route}\`${route.signedIn ? " (signed in)" : ""}: ${shot}, ${status}${errors}${branding}`)
      if (!route.mobile) continue
      const mobileShot = route.mobile.file ? `${roundPath}/${route.mobile.file}` : `no screenshot (${route.mobile.error ?? "unknown error"})`
      const mobileBranding = route.branding && input.brandingImages.includes(`design/branding/${mobileImageName(route.branding)}`) ? `; compare with design/branding/${mobileImageName(route.branding)}` : ""
      const tight = route.mobile.layout?.tightTargets.length ? `; tap targets under 44px: ${route.mobile.layout.tightTargets.join(" | ")}` : ""
      lines.push(`  - mobile: ${mobileShot}${mobileBranding}${tight}`)
    }
  }
  lines.push("", "## References", "")
  lines.push(`Branding images: ${input.brandingImages.join(", ") || "none"}.`)
  if (input.imported) lines.push("This app was imported. Its branding images are screenshots of the app at import, not a target design: a route may differ from them only where the change asks for it.")
  lines.push("Read docs/spec.md, docs/design.md, docs/design-system.md, and design/tokens.css.")
  lines.push("", "## Tasks", "")
  lines.push(`Existing task ids (all merged): ${input.existing.map((task) => task.id).join(", ")}.`)
  lines.push(`Name fix tasks Q${round}01, Q${round}02, and so on.`)
  lines.push("", "## Environment", "", `The test gate runs in the agent container (${input.agentLimits}). The app runs in its own container: ${input.appLimits}. Blame a crash or out-of-memory error on the app only when these limits do not explain it.`)
  if (input.resolveAll) lines.push("", "Resolve all is on: every finding, minor ones included, needs a fix task. A pass must have an empty findings list.")
  if (input.hardFailures.length) lines.push("", "These gates failed, so the verdict must be fail with a fix task for each:", ...input.hardFailures.map((failure) => `- ${failure}`))
  if (input.preexisting?.length) lines.push("", "These failures were already there when the app was imported. Do not fail the round or add fix tasks for them, and do not list them as findings:", ...input.preexisting.map((failure) => `- ${failure}`))
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

async function appendFixTasks(context: PipelineContext, round: number, tasks: Task[]): Promise<void> {
  const { projectDir } = context
  const workspace = createWorkspace(projectDir, `qa-fixes-${round}`, landingBranch(context))
  try {
    const current = JSON.parse(readFileSync(join(workspace.path, "tasks.json"), "utf8")) as Task[]
    const changeId = context.store.currentChange()?.id
    const added = tasks.filter((task) => !current.some((existing) => existing.id === task.id)).map((task) => (changeId ? { ...task, change: changeId } : task))
    const body = [`QA round ${round} failed. The QA agent added these fix tasks:`, "", ...added.map((task) => `- ${task.id}: ${task.title}`)].join("\n")
    landTasksFile(context, workspace, [...current, ...added], `chore(qa): add round ${round} fix tasks`, body)
  } finally {
    removeWorkspace(projectDir, workspace)
  }
}

// Writes tasks.json in a worktree from main, checks it, and lands it on main through the normal merge path.
export function landTasksFile(context: PipelineContext, workspace: Workspace, tasks: Task[], title: string, body: string): void {
  const path = join(workspace.path, "tasks.json")
  writeJson(path, tasks)
  loadTasks(path)
  commitAndRebase(workspace, title)
  context.github.land({ workspace, title, body })
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

// Brings the live app up when deploy is on but there is no URL or the app container stopped, for example an old
// project whose deploy phase was approved without a URL. Returns null when there was nothing to do.
export async function ensureDeployed(context: PipelineContext): Promise<{ outcome: RunOutcome; url: string | null } | null> {
  const { projectDir, config, store } = context
  if (!config.deploy.enabled) return null
  const url = store.meta("deploy.url")
  if (url && (context.appRunning ?? appContainerRunning)(projectDir)) return null
  // runDeployPhase skips an approved phase that has a URL, so reset it: the URL is gone or its container stopped.
  if (store.phaseStatus("deploy") === "approved") store.setPhase("deploy", "pending")
  store.log("deploy", url ? "the app container is not running; deploying again" : "deploy is on but the app has no URL; deploying")
  return runDeployPhase(context)
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
  // The build uses fakes for third-party keys; the live app waits until a person enters or skips each one.
  const missing = missingSecrets(projectSecretStatuses(projectDir, store))
  if (missing.length) {
    store.setPhase("deploy", "awaiting_approval")
    store.setMeta(deployErrorKey, `Waiting for secrets: ${missing.join(", ")}. Enter or skip them in Settings > Secrets.`)
    store.log("gate", `phase "deploy" ${secretsWaitingText}: ${missing.join(", ")}`)
    return { outcome: "awaiting_approval", url: null }
  }
  store.setPhase("deploy", "running")
  let failure: string | null = null
  for (let attempt = 1; attempt <= deployAttempts; attempt++) {
    if (failure) {
      store.log("deploy", `attempt ${attempt}: asking the worker to fix the deploy`)
      const fix = await attemptDeployFix(context, attempt, failure)
      if (fix.kind === "infrastructure") {
        store.setPhase("deploy", "pending")
        noteStop(context, `deploy paused: ${fix.reason}`)
        store.log("deploy", `paused: ${fix.reason.slice(0, 300)}`)
        return { outcome: "paused", url: null }
      }
      if (fix.kind !== "passed") {
        failure = `${failure}\n\nThe previous fix attempt failed: ${fix.reason}`
        continue
      }
    }
    const result = await (context.deploy ?? deployProject)(projectDir, store)
    recordDeployResult(projectDir, store, result)
    if (result.url !== null) {
      store.setPhase("deploy", "approved")
      return { outcome: "completed", url: result.url }
    }
    if (result.stage === "secrets") {
      store.setPhase("deploy", "pending")
      noteStop(context, `deploy paused: ${result.error}`)
      return { outcome: "paused", url: null }
    }
    if (result.stage === "tunnel") {
      store.setPhase("deploy", "pending")
      noteStop(context, `deploy paused: the app runs, but its public URL did not answer: ${result.error}`)
      store.log("deploy", "paused: the app runs, but the tunnel failed; no code fix is attempted")
      return { outcome: "paused", url: null }
    }
    failure = result.error
  }
  store.setPhase("deploy", "failed")
  noteStop(context, `deploy failed after ${deployAttempts} attempts: ${failure ?? "no reason"}`)
  store.log("deploy", `gave up after ${deployAttempts} attempts. Fix it, then: agent-team run ${projectDir}`)
  return { outcome: "failed", url: null }
}

export function deployFixTemplateLines(dir: string): string[] {
  const stack = readStack(dir)
  if (!stack) return []
  const plan = templateDeployPlan(stack)
  return [
    "",
    `The start setup comes from the ${stack.name} template (${stackFile}). Keep deploy.json equal to ${JSON.stringify(plan)}, so it stays in line with ${stackFile}. Do not edit ${stackFile}. Fix the app code or the npm scripts instead.`,
  ]
}

async function attemptDeployFix(context: PipelineContext, attempt: number, failure: string): Promise<AttemptResult> {
  const { projectDir } = context
  const name = `deploy-fix-${attempt}`
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const setupCommand = workspaceSetupCommand(workspace.path)
    if (setupCommand) {
      const setup = await runCommand(context, executor, setupCommand, `${name}-setup`)
      if (!setup.passed) return { kind: "infrastructure", reason: `workspace setup failed (${setupCommand}):\n${setup.output}` }
    }
    const prompt = [
      "The finished app failed to start in production. Make it deployable without changing its features.",
      "",
      "The platform runs `<install> && <start>` from deploy.json in a node:24 container with PORT=3000, HOST=0.0.0.0, and NODE_ENV=production, then probes http://127.0.0.1:$PORT.",
      "Without deploy.json it falls back to `npm start`, then to serving a static index.html.",
      "",
      "Write or fix deploy.json at the repository root ({ \"install\": ..., \"start\": ..., \"port\": 3000 }) and the start script so the app serves on 0.0.0.0:$PORT. Keep the tests passing. Do not edit docs/ or contracts/.",
      ...deployFixTemplateLines(workspace.path),
      "",
      "Deploy failure:",
      failure,
    ].join("\n")
    const worker = await runAgent(context, executor, "worker", `${name}-worker`, ["read", "edit", "write", "bash:npm", "bash:npx", "bash:node", "bash:ls"], prompt)
    if (isInfrastructureFailure(worker)) return { kind: "infrastructure", reason: `worker ${worker.failureClass}: ${worker.result.summary}` }
    if (worker.result.status !== "done") return { kind: "failed", reason: `worker ${worker.result.status}: ${worker.result.summary}` }

    const forbidden = changedFiles(workspace.path).filter((file) => file.startsWith("docs/") || file.startsWith("contracts/") || file === stackFile)
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
      workspace,
      title,
      body: ["The deploy phase could not start the app. The worker agent changed the start setup.", "", "```", failure.slice(0, 3000), "```"].join("\n"),
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

// A spent budget is not infrastructure: pausing would let the doctor resume and spend again. Workers ask a person instead.
export function isInfrastructureFailure(outcome: HarnessOutcome): boolean {
  return outcome.failureClass !== null && outcome.failureClass !== "agent_failure" && outcome.failureClass !== "budget"
}

let egressProxy: ReturnType<typeof ensureEgressProxy> | null = null

// readOnlyPaths defaults to the project's .git, which a project worktree's .git file points to.
export async function createExecutor(context: PipelineContext, hostDir: string, name: string, readOnlyPaths?: string[]): Promise<Executor> {
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
    readOnlyPaths: readOnlyPaths ?? (hostDir === projectDir ? [] : [join(projectDir, ".git")]),
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

// Runs a test command and, when it fails, once more; a pass on the rerun is logged as flaky and accepted.
async function runCheck(context: PipelineContext, executor: Executor, command: string, subject: string, label: string): Promise<{ passed: boolean; output: string }> {
  const first = await runCommand(context, executor, command, subject)
  if (first.passed || context.signal.aborted) return first
  const rerun = await runCommand(context, executor, command, `${subject}-rerun`)
  if (rerun.passed) context.store.log("flaky", `${label} failed, then passed on a rerun (\`${command}\`). First output:\n${first.output.slice(-1500)}`)
  return rerun
}

function workerTools(task: Task): string[] {
  const verifyExecutable = task.verify.trim().split(/\s+/)[0]
  return [...new Set(["read", "edit", "write", "bash:npm", "bash:npx", "bash:node", "bash:mkdir", "bash:ls", `bash:${verifyExecutable}`])]
}

export interface WorkerPromptInput {
  task: Task
  previous: PreviousAttempt | null
  // Compact `git ls-files` tree of the worktree.
  codeMap?: string[]
  // Files merged by each task in dependsOn.
  dependencyFiles?: { taskId: string; files: string[] }[]
  hasProgress?: boolean
  similar?: Solution[]
}

// Memory must never break a task, so errors mean no similar solutions.
function similarSolutions(context: PipelineContext, task: Task): Solution[] {
  const { learning } = context.config
  if (!learning?.enabled || !learning.memory || !learning.maxSimilarTasks) return []
  try {
    const text = [task.title, ...task.acceptance, ...task.allowedPaths].join(" ")
    return searchSolutions(memoryPath(context.projectDir), { text, excludeProject: basename(context.projectDir), stacks: projectStacks(context.projectDir), limit: learning.maxSimilarTasks })
  } catch (error) {
    context.store.log("learning", `${task.id}: solution search failed: ${(error as Error).message.slice(0, 200)}`)
    return []
  }
}

function rememberSolution(context: PipelineContext, task: Task, files: string[], workerSummary: string, diff: string): void {
  const { learning } = context.config
  if (!learning?.enabled || !learning.memory) return
  try {
    const summary = workerSummary.replace(/```json[\s\S]*?```\s*$/, "").trim()
    recordSolution(memoryPath(context.projectDir), { project: basename(context.projectDir), taskId: task.id, title: task.title, acceptance: task.acceptance, files, summary, diff, stacks: projectStacks(context.projectDir) })
  } catch (error) {
    context.store.log("learning", `${task.id}: could not record the solution: ${(error as Error).message.slice(0, 200)}`)
  }
}

// The worker and reviewer read the progress log whenever it exists, and a change task's request.
function withProgressReadPath(task: Task, hasProgress: boolean | undefined): Task {
  const extra = [...(hasProgress ? [progressPath] : []), ...(task.change ? [changePath(task.change, "request.md")] : [])].filter((path) => !task.readPaths.includes(path))
  return extra.length ? { ...task, readPaths: [...extra, ...task.readPaths] } : task
}

function dependencySection(dependencyFiles: { taskId: string; files: string[] }[] | undefined): string | null {
  if (!dependencyFiles?.length) return null
  const lines = dependencyFiles.map(({ taskId, files }) => `- ${taskId}: ${files.length ? files.join(", ") : "no recorded files"}`)
  return ["## Files changed by the tasks this one depends on", "", ...lines].join("\n")
}

// The one place that builds the worker's task prompt.
export function workerPrompt(input: WorkerPromptInput): string {
  const { task, previous } = input
  const sections = ["Implement this task:", JSON.stringify(withProgressReadPath(task, input.hasProgress), null, 2)]
  if (input.hasProgress) sections.push(`Read ${progressPath} first: it lists what earlier tasks built.`)
  const dependencies = dependencySection(input.dependencyFiles)
  if (dependencies) sections.push(dependencies)
  const similar = formatSolutions(input.similar ?? [])
  if (similar) sections.push(similar)
  if (input.codeMap?.length) sections.push(["## Code map (git ls-files, without lockfiles and assets)", "", "```", ...input.codeMap, "```"].join("\n"))
  if (previous) {
    sections.push(
      [
        "## Previous attempt",
        "",
        "Your previous attempt was rejected. Fix the listed problems; do not start over. Your worktree starts clean from main, so reapply the parts of the previous diff that were right, then fix the problems.",
        "",
        "Why it was rejected:",
        "",
        "```",
        previous.reason.trim(),
        "```",
      ].join("\n"),
    )
    if (previous.earlierReasons?.length) {
      sections.push(
        [
          "Earlier attempts were rejected for these reasons too. Keep those fixes in place:",
          "",
          ...previous.earlierReasons.map((reason, index) => [`Attempt ${index + 1}:`, "", "```", reason.trim(), "```"].join("\n")),
        ].join("\n"),
      )
    }
    if (previous.diff) sections.push(["Previous diff:", "", "```diff", previous.diff, "```"].join("\n"))
  }
  return sections.join("\n\n")
}

export interface ReviewPromptInput {
  task: Task
  diff: string
  verifyOutput: string
  previousError: string | null
  hasProgress?: boolean
  dependencyFiles?: { taskId: string; files: string[] }[]
}

// The goal comes first and again after the diff, so a long diff does not push it out of focus.
export function reviewPrompt(input: ReviewPromptInput): string {
  const { task, diff } = input
  const maxDiffLength = 60_000
  const shownDiff = diff.length > maxDiffLength ? `${diff.slice(0, maxDiffLength)}\n[diff truncated]` : diff
  const sections = ["Task:", JSON.stringify(withProgressReadPath(task, input.hasProgress), null, 2)]
  if (input.hasProgress) sections.push(`${progressPath} lists what earlier tasks built. Read it for context.`)
  const dependencies = dependencySection(input.dependencyFiles)
  if (dependencies) sections.push(`${dependencies}\n\nRead them when the diff builds on them.`)
  sections.push("Verify output (passed):", input.verifyOutput, "Diff:", shownDiff)
  sections.push(
    [
      `## Reminder: the goal of ${task.id}`,
      "",
      task.title,
      "",
      "Acceptance criteria:",
      ...task.acceptance.map((criterion) => `- ${criterion}`),
      "",
      "Judge the diff above against these criteria.",
    ].join("\n"),
  )
  if (input.previousError) sections.push(`Your previous answer was rejected: ${input.previousError}. End with exactly one \`\`\`json block that holds the verdict object.`)
  return sections.join("\n\n")
}

export interface ReviewVerdict {
  verdict: "pass" | "fail"
  reasons: string[]
  fixes: string[]
  // UI review only: gaps too small to fail the task, logged on the project timeline.
  departures?: string[]
}

export function parseVerdict(text: string): ReviewVerdict {
  const parsed = extractJsonObject(text) as any
  if (parsed?.verdict !== "pass" && parsed?.verdict !== "fail") throw new Error('verdict must be "pass" or "fail"')
  const reasons = parsed.reasons ?? []
  const fixes = parsed.fixes ?? []
  if (!isStringList(reasons) || !isStringList(fixes)) throw new Error("reasons and fixes must be arrays of strings")
  if (parsed.verdict === "fail" && !reasons.length) throw new Error("a fail verdict needs at least one reason")
  const departures = isStringList(parsed.departures) ? parsed.departures : []
  return { verdict: parsed.verdict, reasons, fixes, ...(departures.length ? { departures } : {}) }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

export interface AgentOptions {
  // Globs the agent may edit; the Claude runner turns them into path-scoped permission rules.
  writablePaths?: string[]
  // Prompt file in prompts/, when it differs from the role name (the replanner runs as the planner role).
  promptName?: string
  // Values for {{name}} placeholders in the system prompt.
  promptVariables?: Record<string, string>
  // Replaces budget.perTaskUsd for this call.
  budgetUsd?: number
}

// Rereads pipeline.yaml so a budget raised from the dashboard applies to the live run.
function currentRunBudget(context: PipelineContext): number {
  try {
    context.config.budget.runUsd = loadConfig(join(context.projectDir, "pipeline.yaml")).budget.runUsd
  } catch {}
  return context.config.budget.runUsd
}

// Returned instead of calling an agent once the run budget is spent; callers treat it as a pause.
function budgetStop(context: PipelineContext, subject: string): HarnessOutcome | null {
  const { store } = context
  const state = runState(context)
  const spent = store.projectCost()
  const runUsd = currentRunBudget(context)
  if (spent.usd < runUsd) return null
  if (!state.budgetExceeded) {
    state.budgetExceeded = true
    const codex = spent.unreportedCalls ? `; ${spent.unreportedCalls} calls (codex) reported no cost and are not counted` : ""
    const message = `${budgetReachedPrefix}: $${spent.usd.toFixed(2)} reported of $${runUsd.toFixed(2)} (budget.runUsd)${codex}. Stopped before ${subject}. Raise budget.runUsd in pipeline.yaml, then resume`
    state.stopReason = message
    store.log("budget", message)
  }
  return {
    result: { status: "aborted", summary: "run budget reached", costUsd: null, tokens: null, durationMs: 0, exitCode: null, diagnostics: "" },
    candidate: null,
    failureClass: "aborted",
  }
}

export async function runAgent(context: PipelineContext, executor: Executor, role: Role, subject: string, allowedTools: string[], taskPrompt: string, options: AgentOptions = {}): Promise<HarnessOutcome> {
  const { config, harness } = context
  const stopped = budgetStop(context, subject)
  if (stopped) return stopped
  return harness.run(
    config.roles[role],
    {
      role,
      subject,
      systemPrompt: withLessons(context, role, taskPrompt, fillPrompt(loadPrompt(options.promptName ?? role), options.promptVariables ?? {})),
      taskPrompt,
      allowedTools,
      writablePaths: options.writablePaths,
      budgetUsd: options.budgetUsd ?? config.budget.perTaskUsd,
      transcriptPath: (candidate: Candidate, attempt: number) => transcriptPath(context, `${subject}-${candidate.runner}-${attempt}.log`),
    },
    executor,
  )
}

// Appends the role's lessons that best fit the task prompt; learning must never break an agent call, so errors drop
// the lessons.
function withLessons(context: PipelineContext, role: Role, taskPrompt: string, systemPrompt: string): string {
  const { learning } = context.config
  if (!learning?.enabled || !learning.maxLessonsPerRole) return systemPrompt
  try {
    const lessons = formatLessons(lessonsFor(loadLessons(lessonsPath(context.projectDir)), role, learning.maxLessonsPerRole, projectStacks(context.projectDir), Date.now(), taskPrompt))
    return lessons ? `${systemPrompt.trimEnd()}\n\n${lessons}\n` : systemPrompt
  } catch {
    return systemPrompt
  }
}

function transcriptPath(context: PipelineContext, fileName: string): string {
  const dir = join(context.projectDir, ".agent-team", "transcripts")
  mkdirSync(dir, { recursive: true })
  return join(dir, fileName)
}

export function fillPrompt(prompt: string, variables: Record<string, string>): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => variables[name] ?? placeholder)
}

function loadPrompt(name: string): string {
  return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8")
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
