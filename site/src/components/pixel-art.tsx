// Each pattern row is one line of pixels: "x" is ink, "o" is violet, "." is empty.
const patterns = {
  document: ["xxxxxx..", "x....xx.", "x.ooo..x", "x......x", "x.oooo.x", "x......x", "x.ooo..x", "xxxxxxxx"],
  pencil: [".....xx.", "....xoox", "...xoox.", "..xoox..", ".xoox...", "xoox....", "xxx.....", "xx......"],
  package: ["..xxxx..", ".xoooox.", "xxxxxxxx", "x..xx..x", "x..xx..x", "x......x", "x......x", "xxxxxxxx"],
  budget: ["...o...", ".ooooo.", "o..o...", ".oooo..", "...o..o", "ooooo..", "...o..."],
  lock: ["..xxx..", ".x...x.", ".x...x.", "ooooooo", "ooo.ooo", "ooo.ooo", "ooooooo"],
  chat: [".xxxxxx.", "x......x", "x.o.o.ox", "x......x", ".xxxxxx.", "..x.....", ".x......"],
} as const

export type PixelIconName = keyof typeof patterns

export function PixelIcon({ name, size = 32 }: { name: PixelIconName; size?: number }) {
  const rows = patterns[name]
  const width = Math.max(...rows.map((row) => row.length))
  return (
    <svg viewBox={`0 0 ${width} ${rows.length}`} width={size} height={(size * rows.length) / width} aria-hidden="true" shapeRendering="crispEdges">
      {rows.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === "." ? null : <rect key={`${x},${y}`} x={x} y={y} width={0.86} height={0.86} className={cell === "o" ? "fill-primary" : "fill-foreground"} />,
        ),
      )}
    </svg>
  )
}

// A small scatter of squares for section corners; fixed coordinates so it renders the same every time.
const clusterSquares = [
  [0, 0, 0.9], [2, 0, 0.45], [5, 1, 0.3], [1, 2, 0.6], [3, 2, 0.9], [6, 3, 0.45], [2, 4, 0.3], [4, 4, 0.6], [0, 5, 0.45], [5, 6, 0.3],
] as const

export function PixelCluster({ className, flip = false }: { className?: string; flip?: boolean }) {
  return (
    <svg viewBox="0 0 7 7" className={`pointer-events-none absolute w-28 text-primary ${className ?? ""}`} style={flip ? { transform: "scale(-1, -1)" } : undefined} aria-hidden="true">
      {clusterSquares.map(([x, y, opacity]) => (
        <rect key={`${x},${y}`} x={x} y={y} width={0.62} height={0.62} fill="currentColor" opacity={opacity} />
      ))}
    </svg>
  )
}
