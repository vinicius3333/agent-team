import type { DesignStyleSummary } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const paletteRoles = ["background", "surface", "ink", "primary", "secondary"] as const

export function paletteSwatches(palette: DesignStyleSummary["palette"]): string[] {
  return paletteRoles.map((role) => palette[role])
}

export function StyleSwatches({ colors, className }: { colors: string[]; className?: string }) {
  return (
    <span role="img" aria-label={`Colors: ${colors.join(", ")}`} className={cn("flex gap-1.5", className)}>
      {colors.map((color, index) => (
        <span key={`${color}-${index}`} className="size-7 rounded-md border border-black/10 dark:border-white/15" style={{ backgroundColor: color }} title={color} />
      ))}
    </span>
  )
}

export function StyleName({ style }: { style: DesignStyleSummary }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary">{style.name}</Badge>
      {style.webgl && <Badge className="bg-primary/10 text-primary">3D</Badge>}
    </span>
  )
}
