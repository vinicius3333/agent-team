import { execFile } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { marketingFormats, type MarketingFormat } from "./config.ts"
import { ensureScreenshotImage } from "./screenshots.ts"

const execFileAsync = promisify(execFile)
const renderScript = fileURLToPath(new URL("../docker/qa/render-marketing.mjs", import.meta.url))
const renderTimeoutMs = 5 * 60_000

export const marketingDir = "marketing"
export const copyPath = "marketing/copy.json"
export const manifestPath = "marketing/manifest.json"
const artPattern = /^marketing\/art\/[a-z0-9-]+\.(png|jpe?g|webp)$/
const pieceIdPattern = /^[a-z0-9][a-z0-9-]{0,39}$/
const renderedPattern = /^[a-z0-9-]+-(og|square|story|x)\.png$/
export const imageSources = ["stock", "generated"] as const
export const layouts = ["overlay", "split"] as const

export const copyLimits = { headline: 60, subtitle: 140, cta: 24, problem: 200 }

export interface MarketingImage {
  file: string
  source: (typeof imageSources)[number]
  reason: string
  // Stock photos only: the page the photo came from and the attribution its license needs.
  url?: string
  credit?: string
  license?: string
}

export interface MarketingPiece {
  id: string
  problem: string
  headline: string
  subtitle: string
  cta: string
  layout: (typeof layouts)[number]
  image: MarketingImage
}

export interface MarketingCopy {
  language: string
  pieces: MarketingPiece[]
}

export interface MarketingManifest {
  language: string
  pieces: (MarketingPiece & { files: { format: MarketingFormat; file: string; width: number; height: number }[] })[]
}

export function validateMarketing(dir: string, expectedPieces: number): MarketingCopy {
  const path = join(dir, copyPath)
  if (!existsSync(path)) throw new Error(`${copyPath} is missing`)
  let copy: MarketingCopy
  try {
    copy = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`${copyPath} is not valid JSON: ${(error as Error).message}`)
  }
  const errors: string[] = []
  if (typeof copy.language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(copy.language)) errors.push("language must be a BCP 47 tag such as en or pt-BR")
  if (!Array.isArray(copy.pieces)) throw new Error(`${copyPath} has no pieces array`)
  if (copy.pieces.length !== expectedPieces) errors.push(`expected ${expectedPieces} pieces, found ${copy.pieces.length}`)
  const ids = new Set<string>()
  for (const [index, piece] of copy.pieces.entries()) {
    const label = `pieces[${index}]${piece?.id ? ` (${piece.id})` : ""}`
    if (!pieceIdPattern.test(piece?.id ?? "")) errors.push(`${label}.id must be lowercase letters, digits, and dashes`)
    else if (ids.has(piece.id)) errors.push(`${label}.id is used twice`)
    ids.add(piece?.id)
    for (const [field, limit] of Object.entries(copyLimits)) {
      const value = (piece as unknown as Record<string, unknown>)?.[field]
      if (typeof value !== "string" || !value.trim()) errors.push(`${label}.${field} is missing`)
      else if (value.length > limit) errors.push(`${label}.${field} has ${value.length} characters; the limit is ${limit}`)
    }
    if (!layouts.includes(piece?.layout)) errors.push(`${label}.layout must be ${layouts.join(" or ")}`)
    const image = piece?.image
    if (!image || !imageSources.includes(image.source)) {
      errors.push(`${label}.image.source must be ${imageSources.join(" or ")}`)
      continue
    }
    if (!artPattern.test(image.file ?? "")) errors.push(`${label}.image.file must be marketing/art/<name>.png, .jpg, or .webp`)
    else if (!existsSync(join(dir, image.file))) errors.push(`${label}.image.file ${image.file} does not exist`)
    if (!image.reason?.trim()) errors.push(`${label}.image.reason is missing: say why you chose a stock photo or a generated image`)
    if (image.source === "stock" && (!image.url?.startsWith("https://") || !image.credit?.trim() || !image.license?.trim())) {
      errors.push(`${label}.image needs url, credit, and license for a stock photo`)
    }
  }
  if (errors.length) throw new Error(`${copyPath} is invalid:\n- ${errors.join("\n- ")}`)
  return copy
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

export function renderedFileName(pieceId: string, format: MarketingFormat): string {
  return `${pieceId}-${format}.png`
}

// One HTML page per piece and format. Sizes use vmin so each layout scales with its canvas.
// The inline script shrinks the headline until the text block fits, so long translations never overflow.
export function marketingPage(input: { piece: MarketingPiece; format: MarketingFormat; language: string; productName: string; hasTokens: boolean }): string {
  const { piece, format } = input
  const { width, height } = marketingFormats[format]
  const portrait = height > width
  const credit = piece.image.source === "stock" ? `<p class="credit">${escapeHtml(`${piece.image.credit} · ${piece.image.license}`)}</p>` : ""
  const art = `art/${basename(piece.image.file)}`
  return `<!doctype html>
<html lang="${escapeHtml(input.language)}">
<head>
<meta charset="utf-8">
${input.hasTokens ? '<link rel="stylesheet" href="tokens.css">' : ""}
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    font-family: var(--font-sans, system-ui, "Noto Sans", "DejaVu Sans", sans-serif);
    background: var(--background, #ffffff);
    color: var(--foreground, #111111);
    display: flex;
    flex-direction: ${piece.layout === "split" && !portrait ? "row" : "column"};
  }
  .art { flex: 1 1 50%; min-height: 0; background: url("${art}") center / cover no-repeat; }
  .text {
    flex: 1 1 50%; min-height: 0; display: flex; flex-direction: column; justify-content: center;
    gap: 3vmin; padding: 7vmin;
  }
  .overlay .art { position: absolute; inset: 0; }
  .overlay .shade { position: absolute; inset: 0; background: linear-gradient(${portrait ? "to top" : "to right"}, rgba(0,0,0,.82) 0%, rgba(0,0,0,.55) 45%, rgba(0,0,0,.05) 100%); }
  .overlay .text { position: absolute; ${portrait ? "left: 0; right: 0; bottom: 0; height: 58%; justify-content: flex-end;" : "top: 0; bottom: 0; left: 0; width: 62%;"} color: #ffffff; }
  .logo { height: 7vmin; width: auto; align-self: flex-start; }
  .overlay .logo { background: #ffffff; padding: 1.4vmin 2.2vmin; border-radius: 1.6vmin; height: 9.8vmin; }
  h1 { font-size: 8.5vmin; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em; text-wrap: balance; }
  .subtitle { font-size: 3.6vmin; line-height: 1.35; opacity: .92; text-wrap: pretty; }
  .cta {
    align-self: flex-start; font-size: 3.2vmin; font-weight: 700; padding: 2vmin 4vmin; border-radius: var(--radius, 1.4vmin);
    background: var(--primary, #2563eb); color: var(--primary-foreground, #ffffff);
  }
  .credit { position: absolute; right: 2vmin; bottom: 1.6vmin; font-size: 1.6vmin; color: #ffffff; opacity: .75; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
  .split .credit { color: var(--foreground, #111111); opacity: .6; text-shadow: none; }
</style>
</head>
<body class="${piece.layout}">
  <div class="art" role="img" aria-label="${escapeHtml(piece.problem)}"></div>
  ${piece.layout === "overlay" ? '<div class="shade"></div>' : ""}
  <div class="text">
    <img class="logo" src="logo.svg" alt="${escapeHtml(input.productName)}">
    <h1>${escapeHtml(piece.headline)}</h1>
    <p class="subtitle">${escapeHtml(piece.subtitle)}</p>
    <span class="cta">${escapeHtml(piece.cta)}</span>
  </div>
  ${credit}
  <script>
    const text = document.querySelector(".text")
    const headline = document.querySelector("h1")
    let size = parseFloat(getComputedStyle(headline).fontSize)
    while (text.scrollHeight > text.clientHeight + 1 && size > 12) {
      size -= 2
      headline.style.fontSize = size + "px"
    }
  </script>
</body>
</html>
`
}

// Renders every piece in every format with the Playwright image, offline, into marketing/<piece>-<format>.png.
export async function renderMarketing(options: { dir: string; productName: string; formats: MarketingFormat[]; expectedPieces: number; signal: AbortSignal }): Promise<MarketingManifest> {
  const { dir, formats } = options
  const copy = validateMarketing(dir, options.expectedPieces)
  const outDir = join(dir, marketingDir)
  for (const file of readdirSync(outDir)) if (renderedPattern.test(file)) rmSync(join(outDir, file))
  const stage = mkdtempSync(join(tmpdir(), "agent-team-marketing-"))
  try {
    cpSync(join(outDir, "art"), join(stage, "art"), { recursive: true })
    cpSync(join(dir, "design/logo.svg"), join(stage, "logo.svg"))
    const tokens = join(dir, "design/tokens.css")
    if (existsSync(tokens)) cpSync(tokens, join(stage, "tokens.css"))
    const jobs = copy.pieces.flatMap((piece) =>
      formats.map((format) => {
        const page = `${piece.id}-${format}.html`
        writeFileSync(join(stage, page), marketingPage({ piece, format, language: copy.language, productName: options.productName, hasTokens: existsSync(tokens) }))
        return { page, file: renderedFileName(piece.id, format), ...marketingFormats[format] }
      }),
    )
    mkdirSync(outDir, { recursive: true })
    const image = await ensureScreenshotImage()
    await execFileAsync(
      "docker",
      [
        "run", "--rm",
        "--network", "none",
        "--init",
        "--memory", "2g", "--cpus", "1", "--pids-limit", "256", "--shm-size", "512m",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "1000:1000",
        "-e", "HOME=/tmp",
        "-e", `JOBS=${JSON.stringify(jobs)}`,
        "-v", `${renderScript}:/opt/qa/render-marketing.mjs:ro`,
        "-v", `${stage}:/in:ro`,
        "-v", `${outDir}:/out`,
        image, "node", "/opt/qa/render-marketing.mjs",
      ],
      { timeout: renderTimeoutMs, signal: options.signal },
    )
    for (const job of jobs) {
      if (!existsSync(join(outDir, job.file))) throw new Error(`the marketing renderer wrote no ${job.file}`)
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  const manifest: MarketingManifest = {
    language: copy.language,
    pieces: copy.pieces.map((piece) => ({
      ...piece,
      files: formats.map((format) => ({ format, file: `${marketingDir}/${renderedFileName(piece.id, format)}`, ...marketingFormats[format] })),
    })),
  }
  writeFileSync(join(dir, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
