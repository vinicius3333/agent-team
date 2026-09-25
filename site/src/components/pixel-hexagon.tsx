type Point = readonly [number, number]

// Same geometry as docs/brand/logo/symbol.svg, sampled onto a pixel grid.
const accentFacet: Point[] = [[-5, -86.6], [19, -48], [-12, 5], [-57, 74.5], [-100, 0], [-50, -86.6]]
const inkFacets: Point[][] = [
  [[-5, -86.6], [50, -86.6], [100, 0], [70, 52], [-12, 5], [19, -48]],
  [[-12, 5], [70, 52], [50, 86.6], [-50, 86.6], [-57, 74.5]],
]
const gapLines: [Point, Point][] = [
  [[-5, -90], [19, -48]],
  [[19, -48], [-12, 5]],
  [[-12, 5], [-59, 78]],
  [[-12, 5], [74, 54]],
]

const cellSize = 9
const gapWidth = 5.5

function isInside([x, y]: Point, polygon: Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distanceToSegment([x, y]: Point, [[x1, y1], [x2, y2]]: [Point, Point]) {
  const lengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2
  const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / lengthSquared))
  return Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)))
}

type Cell = { x: number; y: number; accent: boolean; delay: number }

const cells: Cell[] = []
for (let y = -99; y < 100; y += cellSize) {
  for (let x = -108; x < 110; x += cellSize) {
    const center: Point = [x + cellSize / 2, y + cellSize / 2]
    if (gapLines.some((line) => distanceToSegment(center, line) < gapWidth)) continue
    const accent = isInside(center, accentFacet)
    if (!accent && !inkFacets.some((facet) => isInside(center, facet))) continue
    cells.push({ x, y, accent, delay: ((x * 7 + y * 13) % 17) * 45 + 400 })
  }
}

export function PixelHexagon({ className }: { className?: string }) {
  return (
    <svg viewBox="-110 -100 220 200" className={className} aria-hidden="true">
      {cells.map((cell) => (
        <rect
          key={`${cell.x},${cell.y}`}
          x={cell.x}
          y={cell.y}
          width={cellSize - 1.5}
          height={cellSize - 1.5}
          className={`pixel-assemble ${cell.accent ? "fill-primary" : "fill-foreground"}`}
          style={{ animationDelay: `${Math.abs(cell.delay)}ms` }}
        />
      ))}
    </svg>
  )
}
