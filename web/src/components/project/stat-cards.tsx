import { useEffect, useState } from "react"
import { Bot, CircleDollarSign, Clock, ListChecks, type LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatCost, formatDuration } from "@/lib/format"
import { elapsedMs, taskCounts, totalCost } from "@/lib/pipeline"
import { useProjectView } from "./context"

function Stat({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  const content = (
    <Card className="flex-row items-center gap-3 px-3 py-3 sm:px-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-base leading-tight font-semibold break-words tabular-nums sm:text-lg">{value}</div>
      </div>
    </Card>
  )
  if (!hint) return content
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} className="rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          {content}
        </div>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

export function StatCards() {
  const { detail } = useProjectView()
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!detail.active) return
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [detail.active])

  const counts = taskCounts(detail.tasks)
  const cost = totalCost(detail.attempts)
  const runners = new Set(detail.attempts.map((attempt) => attempt.runner))
  const unreported = detail.attempts.filter((attempt) => attempt.costUsd == null).length
  const costValue = !detail.attempts.length ? "—" : cost === 0 && unreported ? "n/a (codex)" : `${formatCost(cost)}${unreported ? " + n/a" : ""}`
  const costHint = unreported ? `Claude reports cost. Codex reports none, so ${unreported} of ${detail.attempts.length} calls have no cost.` : `Reported by ${[...runners].join(", ") || "the runners"}.`

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat icon={Clock} label="Elapsed" value={formatDuration(elapsedMs(detail))} />
      <Stat icon={CircleDollarSign} label="Cost" value={costValue} hint={costHint} />
      <Stat icon={ListChecks} label="Tasks done" value={detail.tasks.length ? `${counts.merged} / ${detail.tasks.length}` : "—"} />
      <Stat icon={Bot} label="Agent calls" value={String(detail.attempts.length)} />
    </div>
  )
}
