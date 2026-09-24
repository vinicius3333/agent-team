import { useTheme } from "@/hooks/use-theme"
import { cn } from "@/lib/utils"

export function Logo({ className }: { className?: string }) {
  const { resolved } = useTheme()
  return (
    <span className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <img src={resolved === "dark" ? "/symbol-dark.svg" : "/symbol-light.svg"} alt="" className="size-7" />
      <span className="text-lg">agent-team</span>
    </span>
  )
}
