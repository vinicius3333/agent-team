import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { conceptsDir } from "./concepts.ts"

// The style catalog: named visual styles (palettes, type pairings, layout, signature details, failure modes) researched
// from current landing pages, some measured from the live sites' computed CSS. The concepts phase draws one style per
// direction; later phases follow the chosen direction's style.
export const designStylesPath = new URL("../knowledge/design-styles.json", import.meta.url)
export const autoStyle = "auto"
// Under .agent-team/ so the copy in a worktree is gitignored, never committed, and not in the design reviewer's image list.
export const styleCatalogDir = ".agent-team/design-styles"

export const paletteRoles = ["background", "surface", "border", "ink", "muted", "primary", "onPrimary", "secondary"] as const
export type PaletteRole = (typeof paletteRoles)[number]

export interface StylePalette {
  name: string
  mode: "light" | "dark"
  roles: Record<PaletteRole, string>
  note?: string
}

export interface DesignStyle {
  id: string
  name: string
  description: string
  mood: string[]
  fitsWhen: string[]
  avoidWhen: string[]
  layout: Record<string, string>
  typography: { pairings: { display: string; body: string; note?: string; freeSubstitute?: string }[]; scale: string }
  // The style's hero is a real-time 3D scene, so the planner adds a React Three Fiber task.
  webgl?: boolean
  palettes: StylePalette[]
  signature: Record<string, string>
  implementation: { libraries: string[]; tailwind: string; performance: string[]; accessibility: string[] }
  failureModes: string[]
  references: { url: string; measured: boolean; note?: string }[]
}

export interface DesignFundamental {
  id: string
  check: string
  pass: string
  sources: string[]
}

export interface DesignCatalog {
  updated: string
  styles: DesignStyle[]
  fundamentals: DesignFundamental[]
  sources: { title: string; url: string }[]
}

let cachedCatalog: DesignCatalog | null = null

export function loadDesignCatalog(): DesignCatalog {
  cachedCatalog ??= JSON.parse(readFileSync(designStylesPath, "utf8")) as DesignCatalog
  return cachedCatalog
}

export function designStyleIds(catalog = loadDesignCatalog()): string[] {
  return catalog.styles.map((style) => style.id)
}

export function findDesignStyle(id: string, catalog = loadDesignCatalog()): DesignStyle | undefined {
  return catalog.styles.find((style) => style.id === id)
}

// WCAG 2.x relative luminance contrast of two #RRGGBB colors.
export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    const [red, green, blue] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left)
  return (lighter + 0.05) / (darker + 0.05)
}

const hexPattern = /^#[0-9A-Fa-f]{6}$/
const styleIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
// Text pairs that must pass WCAG AA for body text (4.5:1).
const textPairs: [PaletteRole, PaletteRole][] = [
  ["ink", "background"],
  ["muted", "background"],
  ["onPrimary", "primary"],
]

export function catalogProblems(catalog: DesignCatalog): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const style of catalog.styles ?? []) {
    const label = `style "${style.id}"`
    if (!styleIdPattern.test(style.id ?? "")) problems.push(`${label}: the id must be kebab-case`)
    if (seen.has(style.id)) problems.push(`${label}: the id is used twice`)
    seen.add(style.id)
    if (style.id === autoStyle) problems.push(`${label}: "${autoStyle}" is reserved`)
    for (const field of ["name", "description"] as const) if (!style[field]?.trim()) problems.push(`${label}: ${field} is empty`)
    for (const field of ["mood", "fitsWhen", "avoidWhen", "failureModes"] as const) if (!style[field]?.length) problems.push(`${label}: ${field} needs at least one entry`)
    if (!style.typography?.pairings?.length) problems.push(`${label}: typography.pairings needs at least one pairing`)
    if (!style.references?.some((reference) => /^https:\/\//.test(reference.url))) problems.push(`${label}: references needs at least one https URL`)
    if (!style.palettes?.length) problems.push(`${label}: palettes needs at least one palette`)
    for (const palette of style.palettes ?? []) {
      const where = `${label} palette "${palette.name}"`
      if (palette.mode !== "light" && palette.mode !== "dark") problems.push(`${where}: mode must be light or dark`)
      const invalid = paletteRoles.filter((role) => !hexPattern.test(palette.roles?.[role] ?? ""))
      if (invalid.length) {
        problems.push(`${where}: ${invalid.join(", ")} must be #RRGGBB`)
        continue
      }
      for (const [text, background] of textPairs) {
        const ratio = contrastRatio(palette.roles[text], palette.roles[background])
        if (ratio < 4.5) problems.push(`${where}: ${text} on ${background} is ${ratio.toFixed(2)}:1, under the 4.5:1 WCAG AA minimum`)
      }
    }
  }
  if (!catalog.fundamentals?.length) problems.push("fundamentals needs at least one entry")
  return problems
}

function bullets(items: string[]): string[] {
  return items.map((item) => `- ${item}`)
}

function titleCase(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, " $1").toLowerCase()
}

export function styleMarkdown(style: DesignStyle): string {
  const lines = [
    `# ${style.name} (\`${style.id}\`)`,
    "",
    style.description,
    "",
    `Mood: ${style.mood.join(", ")}.`,
    "",
    "## Fits",
    "",
    ...bullets(style.fitsWhen),
    "",
    "## Avoid for",
    "",
    ...bullets(style.avoidWhen),
    "",
    "## Layout",
    "",
    ...Object.entries(style.layout).map(([key, value]) => `- ${titleCase(key)}: ${value}`),
    "",
    "## Typography",
    "",
    ...style.typography.pairings.map((pairing) => {
      const extras = [pairing.freeSubstitute ? `free substitute: ${pairing.freeSubstitute}` : null, pairing.note ?? null].filter(Boolean)
      return `- Display ${pairing.display}, body ${pairing.body}${extras.length ? ` (${extras.join("; ")})` : ""}`
    }),
    `- Scale: ${style.typography.scale}`,
    "",
    "## Palettes",
    "",
    "Every palette passes WCAG AA for ink, muted text, and button text. Start from one, then adapt it to the brief.",
  ]
  for (const palette of style.palettes) {
    lines.push("", `### ${palette.name} (${palette.mode})`, "", "| Role | Hex |", "| --- | --- |", ...paletteRoles.map((role) => `| ${role} | ${palette.roles[role]} |`))
    if (palette.note) lines.push("", palette.note)
  }
  lines.push(
    "",
    "## Signature details",
    "",
    ...Object.entries(style.signature).map(([key, value]) => `- ${titleCase(key)}: ${value}`),
    "",
    "## Implementation (React and Tailwind CSS v4)",
    "",
    `- Libraries: ${style.implementation.libraries.join("; ")}`,
    `- Tailwind: ${style.implementation.tailwind}`,
    "",
    "Performance:",
    "",
    ...bullets(style.implementation.performance),
    "",
    "Accessibility:",
    "",
    ...bullets(style.implementation.accessibility),
    "",
    "## Failure modes",
    "",
    "Each of these makes the style look cheap, generic, or machine-made. Avoid all of them.",
    "",
    ...bullets(style.failureModes),
    "",
    "## References",
    "",
    ...style.references.map((reference) => `- ${reference.url}${reference.measured ? " (measured)" : ""}${reference.note ? `: ${reference.note}` : ""}`),
  )
  return `${lines.join("\n")}\n`
}

export function catalogIndexMarkdown(catalog: DesignCatalog): string {
  const lines = [
    "# Design style catalog",
    "",
    `Updated ${catalog.updated}. One file per style in this folder. Each style lists when it fits, its layout, type pairings, WCAG AA palettes, signature details, implementation notes, and the failure modes that make it look generic.`,
    "",
    "## Styles",
    "",
    "| Id | Name | Mood | Fits | Avoid for |",
    "| --- | --- | --- | --- | --- |",
    ...catalog.styles.map((style) => `| \`${style.id}\` | ${style.name} | ${style.mood.join(", ")} | ${style.fitsWhen.join("; ")} | ${style.avoidWhen.join("; ")} |`),
    "",
    "## Fundamentals",
    "",
    "Every style must pass these, whatever it looks like.",
    "",
    ...catalog.fundamentals.map((fundamental) => `- **${fundamental.id}**: ${fundamental.check} Pass: ${fundamental.pass}`),
  ]
  return `${lines.join("\n")}\n`
}

// Writes the catalog as Markdown into a worktree, for the agents that read it.
export function writeStyleCatalog(dir: string, catalog = loadDesignCatalog()): void {
  const target = join(dir, styleCatalogDir)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, "README.md"), catalogIndexMarkdown(catalog))
  for (const style of catalog.styles) writeFileSync(join(target, `${style.id}.md`), styleMarkdown(style))
}

const styleLinePattern = /^[\s>*_-]*Style\**\s*:\s*\**\s*`?([a-z0-9-]+)`?/im

// The style id a concept's style.md names on its "Style: <id>" line.
export function conceptStyle(text: string): string | null {
  return styleLinePattern.exec(text)?.[1] ?? null
}

// A fixed style must be used by every direction; with auto, each direction names a different catalog style.
export function conceptStyleProblems(styles: Record<string, string>, configured: string, catalog = loadDesignCatalog()): string[] {
  const known = new Set(designStyleIds(catalog))
  const problems: string[] = []
  for (const [id, text] of Object.entries(styles)) {
    const style = conceptStyle(text)
    if (!style) problems.push(`${id}/style.md must start with a "Style: <id>" line naming a style from ${styleCatalogDir}/README.md`)
    else if (!known.has(style)) problems.push(`${id}/style.md names unknown style "${style}"; pick one of ${[...known].join(", ")}`)
    else if (configured !== autoStyle && style !== configured) problems.push(`${id}/style.md names "${style}", but the person chose "${configured}" for every direction`)
  }
  if (configured === autoStyle) {
    const byStyle = new Map<string, string[]>()
    for (const [id, text] of Object.entries(styles)) {
      const style = conceptStyle(text)
      if (style) byStyle.set(style, [...(byStyle.get(style) ?? []), id])
    }
    for (const [style, ids] of byStyle) if (ids.length > 1) problems.push(`directions ${ids.join(" and ")} both use "${style}"; each direction needs a different style`)
  }
  return problems
}

// The style the rest of the pipeline follows: the configured one, else the one the chosen concept names.
export function chosenStyleId(dir: string, choice: string | null, configured: string, catalog = loadDesignCatalog()): string | null {
  if (configured !== autoStyle) return findDesignStyle(configured, catalog) ? configured : null
  if (!choice) return null
  const path = join(dir, conceptsDir, choice, "style.md")
  if (!existsSync(path)) return null
  const style = conceptStyle(readFileSync(path, "utf8"))
  return style && findDesignStyle(style, catalog) ? style : null
}

export interface StyleNoteInput {
  phase: string
  role: string
  dir: string
  // The concept a person or the design reviewer picked, or null before the pick.
  choice: string | null
  configured: string
  variations: number
}

// Task prompt lines that point a phase agent at the catalog. Writes the catalog into the worktree when a line needs it.
export function styleNotes(input: StyleNoteInput, catalog = loadDesignCatalog()): string[] {
  const { phase, role, dir, configured } = input
  if (phase === "concepts") {
    writeStyleCatalog(dir, catalog)
    const styleLine = (id: string) => `Start each ${conceptsDir}/<direction>/style.md with the line "Style: ${id}".`
    if (configured !== autoStyle) {
      return [
        `The person chose the "${configured}" style for every direction. Read ${styleCatalogDir}/${configured}.md and ${styleCatalogDir}/README.md (the fundamentals).`,
        "Vary the logo idea, the palette (start from the style's palettes), the type pairing, and the layout within that style, and avoid its failure modes.",
        styleLine(configured),
      ]
    }
    return [
      `Read the style catalog in ${styleCatalogDir}/README.md. Pick ${input.variations} different styles that fit the brief and its users (check each style's "Fits" and "Avoid for"), one per direction.`,
      `Read each picked style's file (${styleCatalogDir}/<id>.md) before you draw its direction. Start from one of its palettes and type pairings, keep its signature details, and avoid its failure modes.`,
      styleLine("<id>"),
      `Say in ${conceptsDir}/README.md which style each direction uses and why it fits.`,
    ]
  }
  const id = chosenStyleId(dir, input.choice, configured, catalog)
  const style = id ? findDesignStyle(id, catalog) : undefined
  if (!id || !style) return []
  const file = `${styleCatalogDir}/${id}.md`
  const webglTask = `The chosen visual style ("${id}") has a real-time 3D hero. Plan one task that builds the scene with three, @react-three/fiber, and @react-three/drei, following the performance and accessibility rules in ${file}: a static poster image as the first paint, the canvas loaded lazily, a fallback to the poster on phones, without WebGL, and with reduced motion, and every model, texture, and environment map bundled in the app, because the QA browser has no internet.`
  switch (role) {
    case "illustrator":
      writeStyleCatalog(dir, catalog)
      return [`The chosen direction follows the "${id}" style. Read ${file}. Keep its signature details in every screen and avoid its failure modes.`]
    case "designer":
      writeStyleCatalog(dir, catalog)
      return [
        `The chosen visual style is "${id}". Read ${file} and the fundamentals in ${styleCatalogDir}/README.md.`,
        "Carry the style's type scale, signature details (radius, borders, shadows, textures, motion), and implementation notes into docs/design-system.md. List its failure modes in ## Principles as things workers must avoid. The branding images win on colors.",
        ...(style.webgl ? ["This style has a real-time 3D hero. In docs/design.md, describe the landing's 3D scene: what it shows, how it reacts to the pointer and scroll, which tokens it takes its colors from, and the static poster image that stands in on phones, without WebGL, and with reduced motion."] : []),
      ]
    case "planner":
      if (!style.webgl) return []
      writeStyleCatalog(dir, catalog)
      return [webglTask]
    case "architect":
      // The architecture runs before the concepts phase, so only a style the person fixed up front is known here.
      if (!style.webgl) return []
      writeStyleCatalog(dir, catalog)
      return [`The person chose the "${id}" visual style, which has a real-time 3D hero. Add three, @react-three/fiber, and @react-three/drei to the stack, and read the performance and accessibility rules in ${file}.`]
    default:
      return []
  }
}

// Swatch roles found on a concept's style.md lines, in display order; the first matching keyword names the role.
const conceptSwatchRoles: [role: string, keyword: RegExp][] = [
  ["background", /\bbackground\b|\bbg\b/i],
  ["surface", /\bsurface\b|\bcard\b/i],
  ["ink", /\bink\b|\btext\b|\bforeground\b/i],
  ["primary", /\bprimary\b|\baccent\b/i],
  ["secondary", /\bsecondary\b/i],
]
const excludedSwatchLine = /\bmuted\b|\bborder\b|\bsuccess\b|\bwarning\b|\bdestructive\b|\berror\b|\bdark\b/i

// The direction's own colors, read from its style block; empty when it names fewer than three roles.
export function conceptSwatches(text: string): string[] {
  const found = new Map<string, string>()
  for (const line of text.split("\n")) {
    const hex = /#[0-9A-Fa-f]{6}\b/.exec(line)?.[0]
    if (!hex || excludedSwatchLine.test(line)) continue
    const role = conceptSwatchRoles.find(([name, keyword]) => !found.has(name) && keyword.test(line))?.[0]
    if (role) found.set(role, hex.toUpperCase())
  }
  const colors = conceptSwatchRoles.map(([name]) => found.get(name)).filter((color): color is string => Boolean(color))
  return colors.length >= 3 ? colors : []
}
