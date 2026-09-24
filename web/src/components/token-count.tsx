import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatCost, formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"

interface TokenCountProps {
  tokens: number | null | undefined
  // Null when the runner reports no cost (codex).
  usd: number | null | undefined
  label?: boolean
  digits?: number
  className?: string
}

// Shows tokens used; the dollar estimate appears on hover or focus.
export function TokenCount({ tokens, usd, label = false, digits = 2, className }: TokenCountProps) {
  const text = tokens == null ? "—" : `${formatTokens(tokens)}${label ? " tokens" : ""}`
  const estimate = usd == null ? "Estimated cost: not reported by this runner" : `Estimated cost: ${formatCost(usd, digits)}`
  const detail = tokens == null ? "Tokens were not recorded for this call." : `${tokens.toLocaleString()} tokens. ${estimate}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("cursor-help tabular-nums underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", className)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  )
}
