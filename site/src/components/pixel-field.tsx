import { useEffect, useRef } from "react"

const cellSize = 22
const pixelSize = 11
const hoverRadius = 150

// Pixels are dense in the corners and sparse near the middle, like a frame around the hero.
function densityAt(x: number, y: number, width: number, height: number) {
  const fromCornerX = Math.min(x, width - x) / width
  const fromTopOrBottom = Math.min(y, height - y) / height
  return Math.max(0, 0.34 - fromCornerX * 1.1 - fromTopOrBottom * 0.9)
}

type Cell = { x: number; y: number; restingAlpha: number; alpha: number; hoverStrength: number }

// The canvas listens on the window, so it can sit behind content that takes the pointer.
export function PixelField({ className }: { className: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const context = canvas.getContext("2d")!
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const color = getComputedStyle(canvas).color
    let cells: Cell[] = []
    let pointer: { x: number; y: number } | null = null
    let frameId = 0

    const layout = () => {
      const ratio = window.devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = width * ratio
      canvas.height = height * ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      cells = []
      for (let y = 0; y < height; y += cellSize) {
        for (let x = 0; x < width; x += cellSize) {
          const restingAlpha = Math.random() < densityAt(x, y, width, height) ? 0.15 + Math.random() * 0.45 : 0
          cells.push({ x, y, restingAlpha, alpha: restingAlpha, hoverStrength: 0.35 + Math.random() * 0.5 })
        }
      }
    }

    const draw = () => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = color
      let settled = true
      for (const cell of cells) {
        let target = cell.restingAlpha
        if (pointer) {
          const distance = Math.hypot(cell.x + pixelSize / 2 - pointer.x, cell.y + pixelSize / 2 - pointer.y)
          if (distance < hoverRadius) target = Math.max(target, (1 - distance / hoverRadius) * cell.hoverStrength)
        }
        cell.alpha += (target - cell.alpha) * 0.12
        if (Math.abs(target - cell.alpha) > 0.005) settled = false
        if (cell.alpha < 0.01) continue
        context.globalAlpha = cell.alpha
        context.fillRect(cell.x, cell.y, pixelSize, pixelSize)
      }
      frameId = settled ? 0 : requestAnimationFrame(draw)
    }

    const redraw = () => {
      if (!frameId) frameId = requestAnimationFrame(draw)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      const bounds = canvas.getBoundingClientRect()
      pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
      redraw()
    }

    const onPointerLeave = () => {
      pointer = null
      redraw()
    }

    const onResize = () => {
      layout()
      redraw()
    }

    layout()
    draw()
    window.addEventListener("resize", onResize)
    if (!reducedMotion) {
      window.addEventListener("pointermove", onPointerMove)
      document.documentElement.addEventListener("pointerleave", onPointerLeave)
    }
    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("pointermove", onPointerMove)
      document.documentElement.removeEventListener("pointerleave", onPointerLeave)
    }
  }, [])

  return <canvas ref={canvasRef} className={`pointer-events-none absolute text-primary ${className}`} aria-hidden="true" />
}
