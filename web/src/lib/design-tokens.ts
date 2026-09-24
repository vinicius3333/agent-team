export type TokenMap = Record<string, string>

export interface ThemeTokens {
  light: TokenMap
  dark: TokenMap
}

function declarations(body: string): TokenMap {
  const tokens: TokenMap = {}
  for (const declaration of body.split(";")) {
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration)
    if (match) tokens[match[1]] = match[2].replace(/\s+/g, " ")
  }
  return tokens
}

// Reads the shadcn theme the designer writes: `:root` holds light values, `.dark` overrides them.
export function parseTokens(css: string): ThemeTokens {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const light: TokenMap = {}
  const darkOverrides: TokenMap = {}
  for (const match of source.matchAll(/(:root|\.dark)\s*\{([^}]*)\}/g)) Object.assign(match[1] === ":root" ? light : darkOverrides, declarations(match[2]))
  return { light, dark: { ...light, ...darkOverrides } }
}

// Swaps var(--token) references for their values, so an SVG shown as an image keeps the theme colors.
export function resolveVariables(text: string, tokens: TokenMap): string {
  let resolved = text
  for (let depth = 0; depth < 5 && resolved.includes("var("); depth++) {
    resolved = resolved.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string, fallback?: string) => tokens[name] ?? fallback?.trim() ?? whole)
  }
  return resolved
}

export function isColor(value: string): boolean {
  return typeof CSS !== "undefined" && CSS.supports("color", value)
}

let canvasContext: CanvasRenderingContext2D | null = null

// The browser parses any CSS color (hex, rgb, hsl, oklch); drawing one pixel gives plain sRGB.
export function toRgb(value: string): [number, number, number] | null {
  if (!isColor(value)) return null
  canvasContext ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!canvasContext) return null
  canvasContext.clearRect(0, 0, 1, 1)
  canvasContext.fillStyle = "#000"
  canvasContext.fillStyle = value
  canvasContext.fillRect(0, 0, 1, 1)
  const [red, green, blue] = canvasContext.getImageData(0, 0, 1, 1).data
  return [red, green, blue]
}

export function toHex(value: string): string | null {
  const rgb = toRgb(value)
  return rgb ? `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}` : null
}

function luminance([red, green, blue]: [number, number, number]): number {
  const linear = (channel: number) => {
    const scaled = channel / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

// WCAG 2.2 contrast ratio, from 1 to 21.
export function contrastRatio(foreground: string, background: string): number | null {
  const [first, second] = [toRgb(foreground), toRgb(background)]
  if (!first || !second) return null
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

export type ContrastLevel = "AAA" | "AA" | "AA large" | "fail"

export function contrastLevel(ratio: number): ContrastLevel {
  if (ratio >= 7) return "AAA"
  if (ratio >= 4.5) return "AA"
  if (ratio >= 3) return "AA large"
  return "fail"
}
