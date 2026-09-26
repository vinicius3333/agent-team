import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { conceptChoiceKey } from "./concepts.ts"
import { chosenStyleId, styleCatalogDir, writeStyleCatalog } from "./design-styles.ts"
import { createWorkspace, removeWorkspace } from "./harness/workspace.ts"
import { copyLatestQaRound } from "./improve.ts"
import { extractJsonObject } from "./json.ts"
import { createExecutor, isInfrastructureFailure, landingBranch, runAgent, type PipelineContext } from "./pipeline.ts"

// The design judge scores the built app's screenshots against a fixed rubric, so evals can track visual quality
// across orchestrator changes. It reads; it never edits the project.
export const designDimensions = ["hierarchy", "typography", "color", "layout", "style_fidelity", "originality", "mobile", "polish"] as const
export type DesignDimension = (typeof designDimensions)[number]

export interface DesignScore {
  // 0 to 100: the mean of the dimension scores, computed here so the agent cannot round it up.
  score: number
  dimensions: Record<DesignDimension, { score: number; notes: string }>
  // The catalog style the app was meant to follow, or null when none was chosen.
  style: string | null
  summary: string
  issues: string[]
}

export type DesignJudgeResult = { kind: "scored"; design: DesignScore } | { kind: "skipped"; reason: string }

export const designScorePath = join(".agent-team", "evaluations", "design.json")
const judgeAttempts = 2
const maxIssues = 8
const brandingDir = "design/branding"
const imagePattern = /\.(png|jpe?g|webp)$/i

export function parseDesignScore(text: string, style: string | null): DesignScore {
  const parsed = extractJsonObject(text) as any
  const errors: string[] = []
  const dimensions = {} as DesignScore["dimensions"]
  for (const dimension of designDimensions) {
    const entry = parsed?.dimensions?.[dimension]
    const score = Number(entry?.score)
    if (!Number.isFinite(score) || score < 0 || score > 100) errors.push(`dimensions.${dimension}.score must be a number from 0 to 100`)
    dimensions[dimension] = { score: Math.round(score), notes: String(entry?.notes ?? "") }
  }
  if (!Array.isArray(parsed?.issues)) errors.push("issues must be an array of strings")
  if (errors.length) throw new Error(`invalid design score:\n- ${errors.join("\n- ")}`)
  const issues = parsed.issues.map((issue: unknown) => String(issue ?? "").trim()).filter(Boolean).slice(0, maxIssues)
  const score = Math.round(designDimensions.reduce((sum, dimension) => sum + dimensions[dimension].score, 0) / designDimensions.length)
  return { score, dimensions, style, summary: String(parsed.summary ?? ""), issues }
}

export function designJudgePrompt(input: { screenshots: string; branding: string[]; style: string | null; previousError: string | null }): string {
  const lines = [
    "Score the design of the built app.",
    "",
    "## Sources",
    "",
    `- Screenshots of every route, desktop and mobile: \`${input.screenshots}/\` (report.json lists them). Open every one.`,
    `- The fundamentals every style must pass: \`${styleCatalogDir}/README.md\`.`,
    input.style ? `- The chosen visual style: \`${styleCatalogDir}/${input.style}.md\`. Score style_fidelity against it, and count its failure modes.` : "- No catalog style was chosen: score style_fidelity against the branding images and docs/design-system.md alone.",
    input.branding.length ? `- The approved branding images: ${input.branding.map((file) => `\`${brandingDir}/${file}\``).join(", ")}.` : "- There are no branding images.",
    "- The brief `input.md`, `docs/design-system.md`, and `design/tokens.css`.",
  ]
  if (input.previousError) lines.push("", `Your previous answer was rejected. Fix this: ${input.previousError}`)
  return lines.join("\n")
}

// Runs in a throwaway worktree with the last QA round copied in. Returns why it skipped when there is nothing to score.
export async function judgeDesign(context: PipelineContext): Promise<DesignJudgeResult> {
  const { projectDir, config, store } = context
  if (config.target === "api") return { kind: "skipped", reason: "api-only target" }
  const name = "design-judge"
  const workspace = createWorkspace(projectDir, name, landingBranch(context))
  const executor = await createExecutor(context, workspace.path, name)
  try {
    const screenshots = copyLatestQaRound(context, workspace.path)
    if (!screenshots) return { kind: "skipped", reason: "no QA screenshots" }
    writeStyleCatalog(workspace.path)
    const style = chosenStyleId(workspace.path, store.meta(conceptChoiceKey), config.branding.style)
    const brandingPath = join(workspace.path, brandingDir)
    const branding = existsSync(brandingPath) ? readdirSync(brandingPath).filter((file) => imagePattern.test(file)).sort() : []
    let previousError: string | null = null
    for (let attempt = 1; attempt <= judgeAttempts; attempt++) {
      const prompt = designJudgePrompt({ screenshots, branding, style, previousError })
      const outcome = await runAgent(context, executor, "evaluator", `${name}-${attempt}`, ["read"], prompt, { promptName: "design-judge" })
      if (isInfrastructureFailure(outcome) || outcome.result.status === "aborted") return { kind: "skipped", reason: `design judge ${outcome.result.status}: ${outcome.result.summary}` }
      if (outcome.result.status !== "done") {
        previousError = `agent ${outcome.result.status}: ${outcome.result.summary}`
        continue
      }
      try {
        const design = parseDesignScore(outcome.result.summary, style)
        mkdirSync(join(projectDir, ".agent-team", "evaluations"), { recursive: true })
        writeFileSync(join(projectDir, designScorePath), `${JSON.stringify({ ...design, at: new Date().toISOString() }, null, 2)}\n`)
        store.log("eval", `design score ${design.score}/100${style ? ` (style ${style})` : ""}: ${design.summary.slice(0, 300)}`)
        return { kind: "scored", design }
      } catch (error) {
        previousError = (error as Error).message
        store.log("eval", `design score rejected: ${previousError.slice(0, 300)}`)
      }
    }
    return { kind: "skipped", reason: `no valid design score: ${previousError}` }
  } finally {
    await executor.dispose()
    removeWorkspace(projectDir, workspace)
  }
}
