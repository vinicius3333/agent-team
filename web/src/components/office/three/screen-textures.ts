import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from "three"

const background = "#15121f"
const syntax = {
  keyword: "#c4a1ff",
  name: "#8fd3ff",
  string: "#7ee2b8",
  number: "#ffc978",
  comment: "#6b6788",
  plain: "#e6e3f0",
}

type Token = [kind: keyof typeof syntax, text: string]

const code: Token[][] = [
  [["comment", "// derive each agent's desk state"]],
  [["keyword", "export function "], ["name", "officeDesks"], ["plain", "(detail) {"]],
  [["keyword", "  const "], ["plain", "steps = "], ["name", "stepStates"], ["plain", "(detail)"]],
  [["keyword", "  return "], ["plain", "planning."], ["name", "map"], ["plain", "((desk) => ({"]],
  [["plain", "    ...desk,"]],
  [["plain", "    state: "], ["name", "deskState"], ["plain", "(desk.step),"]],
  [["plain", "    bubble: "], ["string", '"Waiting for review"'], ["plain", ","]],
  [["plain", "  }))"]],
  [["plain", "}"]],
  [],
  [["keyword", "async function "], ["name", "runTask"], ["plain", "(task) {"]],
  [["keyword", "  for "], ["plain", "(let attempt = "], ["number", "1"], ["plain", "; attempt <= "], ["number", "3"], ["plain", ";) {"]],
  [["keyword", "    const "], ["plain", "result = "], ["keyword", "await "], ["name", "worker"], ["plain", "(task)"]],
  [["keyword", "    if "], ["plain", "(result.passed) "], ["keyword", "return "], ["string", '"merged"']],
  [["plain", "    attempt++"]],
  [["plain", "  }"]],
  [["keyword", "  return "], ["string", '"blocked"']],
  [["plain", "}"]],
  [],
  [["comment", "// POST /api/tasks"]],
  [["plain", "app."], ["name", "post"], ["plain", "("], ["string", '"/api/tasks"'], ["plain", ", "], ["keyword", "async "], ["plain", "(req) => {"]],
  [["keyword", "  const "], ["plain", "body = "], ["name", "validate"], ["plain", "(req.body)"]],
  [["keyword", "  await "], ["plain", "db.tasks."], ["name", "insert"], ["plain", "(body)"]],
  [["keyword", "  return "], ["plain", "{ status: "], ["number", "201"], ["plain", " }"]],
  [["plain", "})"]],
  [],
  [["name", "test"], ["plain", "("], ["string", '"shouts in uppercase"'], ["plain", ", () => {"]],
  [["plain", "  "], ["name", "expect"], ["plain", "("], ["name", "shout"], ["plain", "("], ["string", '"hi"'], ["plain", ")).toBe("], ["string", '"HI!"'], ["plain", ")"]],
  [["plain", "})"]],
  [],
]

function canvas(width: number, height: number) {
  const element = document.createElement("canvas")
  element.width = width
  element.height = height
  const context = element.getContext("2d")!
  context.fillStyle = background
  context.fillRect(0, 0, width, height)
  return { element, context }
}

function toTexture(element: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(element)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function codeTexture(): CanvasTexture {
  const lineHeight = 22
  const { element, context } = canvas(512, lineHeight * code.length)
  context.font = "15px ui-monospace, SFMono-Regular, Menlo, monospace"
  context.textBaseline = "middle"
  code.forEach((line, index) => {
    const y = index * lineHeight + lineHeight / 2
    context.fillStyle = syntax.comment
    context.fillText(String(index + 1).padStart(2, " "), 8, y)
    let x = 40
    for (const [kind, text] of line) {
      context.fillStyle = syntax[kind]
      context.fillText(text, x, y)
      x += context.measureText(text).width
    }
  })
  const texture = toTexture(element)
  texture.wrapT = RepeatWrapping
  // The screen shows about a third of the listing; the rest scrolls into view.
  texture.repeat.set(1, 0.35)
  return texture
}

function doneTexture(): CanvasTexture {
  const { element, context } = canvas(512, 320)
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillStyle = "#34d399"
  context.font = "bold 110px system-ui, sans-serif"
  context.fillText("✓", 256, 120)
  context.font = "600 34px system-ui, sans-serif"
  context.fillText("All checks passed", 256, 230)
  return toTexture(element)
}

function idleTexture(): CanvasTexture {
  const { element, context } = canvas(512, 320)
  context.fillStyle = "#0c0a14"
  context.fillRect(0, 0, 512, 320)
  context.strokeStyle = "#3b2f66"
  context.lineWidth = 10
  context.beginPath()
  for (let corner = 0; corner < 6; corner++) {
    const angle = (Math.PI / 3) * corner + Math.PI / 6
    const x = 256 + Math.cos(angle) * 60
    const y = 160 + Math.sin(angle) * 60
    if (corner === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
  context.stroke()
  return toTexture(element)
}

let cache: { code: CanvasTexture; done: CanvasTexture; idle: CanvasTexture } | null = null

// Textures are built once; each monitor clones the code texture so it can scroll on its own.
export function screenTextures() {
  cache ??= { code: codeTexture(), done: doneTexture(), idle: idleTexture() }
  return cache
}

export function scrollingCode(): Texture {
  const texture = screenTextures().code.clone()
  texture.offset.y = Math.random()
  texture.needsUpdate = true
  return texture
}
