import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { ensureScreenshotImage } from "./screenshots.ts"

const execFileAsync = promisify(execFile)
const renderTimeoutMs = 5 * 60_000

export const faviconDir = "design/favicon"
export const markPath = "design/logo-mark.svg"

interface IconSpec {
  file: string
  size: number
  // Opaque background, for icons that platforms show on their own tile.
  background: string | null
  padding: number
}

const icoSizes = [16, 32, 48]
const icons: IconSpec[] = [
  ...icoSizes.map((size) => ({ file: `favicon-${size}.png`, size, background: null, padding: 0 })),
  { file: "apple-touch-icon.png", size: 180, background: "#ffffff", padding: 0.12 },
  { file: "icon-192.png", size: 192, background: null, padding: 0 },
  { file: "icon-512.png", size: 512, background: null, padding: 0 },
  { file: "icon-maskable-512.png", size: 512, background: "#ffffff", padding: 0.2 },
]

export const faviconFiles = ["favicon.svg", "favicon.ico", "site.webmanifest", ...icons.map((icon) => icon.file)]

// Rendered in a browser, the mark has no page styles, so theme variables and currentColor would draw black.
export function validateMark(dir: string): void {
  const svg = readFileSync(join(dir, markPath), "utf8")
  if (/var\(|currentColor/i.test(svg)) throw new Error(`${markPath} must use literal colors (hex or rgb), not var() or currentColor: the favicon renders it without the app's styles`)
  const viewBox = /viewBox\s*=\s*"([^"]+)"/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number)
  if (!viewBox || viewBox.length !== 4 || viewBox[2] !== viewBox[3]) throw new Error(`${markPath} needs a square viewBox, for example viewBox="0 0 64 64"`)
}

// ICO files may hold PNG images directly; every browser since IE Vista reads them.
export function packIco(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = Buffer.alloc(16 * pngs.length)
  let offset = header.length + entries.length
  pngs.forEach(({ size, data }, index) => {
    const entry = index * 16
    entries.writeUInt8(size >= 256 ? 0 : size, entry)
    entries.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    entries.writeUInt16LE(1, entry + 4)
    entries.writeUInt16LE(32, entry + 6)
    entries.writeUInt32LE(data.length, entry + 8)
    entries.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, entries, ...pngs.map((png) => png.data)])
}

export function themeColor(tokensCss: string): string | null {
  return /--primary:\s*([^;]+);/.exec(tokensCss)?.[1].trim() ?? null
}

export function webManifest(name: string, color: string | null): string {
  const manifest = {
    name,
    short_name: name.slice(0, 12),
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    ...(color ? { theme_color: color } : {}),
    background_color: "#ffffff",
    display: "standalone",
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

// Writes design/favicon/ from design/logo-mark.svg. The PNG sizes come from a headless browser in Docker.
export async function generateFavicons(options: { dir: string; name: string; signal: AbortSignal }): Promise<void> {
  const { dir } = options
  validateMark(dir)
  const outDir = join(dir, faviconDir)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const image = await ensureScreenshotImage()
  await execFileAsync(
    "docker",
    [
      "run", "--rm",
      "--network", "none",
      "--init",
      "--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--shm-size", "256m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000",
      "-e", "HOME=/tmp",
      "-e", `ICONS=${JSON.stringify(icons)}`,
      "-v", `${join(dir, markPath)}:/in/mark.svg:ro`,
      "-v", `${outDir}:/out`,
      image, "node", "/opt/qa/render-icons.mjs",
    ],
    { timeout: renderTimeoutMs, signal: options.signal },
  )
  for (const icon of icons) {
    if (!existsSync(join(outDir, icon.file))) throw new Error(`the icon renderer wrote no ${icon.file}`)
  }
  const ico = packIco(icoSizes.map((size) => ({ size, data: readFileSync(join(outDir, `favicon-${size}.png`)) })))
  writeFileSync(join(outDir, "favicon.ico"), ico)
  copyFileSync(join(dir, markPath), join(outDir, "favicon.svg"))
  const tokensPath = join(dir, "design/tokens.css")
  writeFileSync(join(outDir, "site.webmanifest"), webManifest(options.name, existsSync(tokensPath) ? themeColor(readFileSync(tokensPath, "utf8")) : null))
}
