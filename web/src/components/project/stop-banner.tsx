import { useState } from "react"
import { CircleDollarSign, Loader2, PauseCircle, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { formatCost, formatRelative } from "@/lib/format"
import { useProjectView } from "./context"

const outcomeTitles = {
  paused: "The run paused",
  failed: "The run stopped on a failure",
  awaiting_approval: "The run is waiting for you",
} as const

function RaiseBudgetButton() {
  const { name } = useProjectView()
  const [busy, setBusy] = useState(false)
  const raise = async () => {
    setBusy(true)
    try {
      const { runUsd, started } = await api.raiseBudget(name)
      if (started) toast.success(`Budget raised to ${formatCost(runUsd)}. The run continues.`)
      else toast.warning(`Budget raised to ${formatCost(runUsd)}, but a run is still active.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not raise the budget.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button onClick={raise} disabled={busy} className="shrink-0">
      {busy ? <Loader2 className="animate-spin" /> : <CircleDollarSign />} Raise budget and resume
    </Button>
  )
}

// Shows why the last run stopped, with the key error lines, while no run is active.
export function StopBanner() {
  const { detail } = useProjectView()
  const stop = detail.stop
  if (!stop || detail.active) return null
  const budget = stop.kind === "budget"
  const budgetText = detail.budget
    ? `${formatCost(detail.budget.spentUsd)} of ${formatCost(detail.budget.runUsd)} spent${detail.budget.unreportedCalls ? `, plus ${detail.budget.unreportedCalls} codex calls with no reported cost` : ""}. Raising adds 50%.`
    : null
  const Icon = budget ? CircleDollarSign : stop.outcome === "failed" ? TriangleAlert : PauseCircle
  return (
    <Card role="status" className="flex-col items-start gap-3 border-warning/40 px-4 py-3 sm:flex-row sm:items-center">
      <Icon className="size-5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {budget ? "The run budget is spent" : outcomeTitles[stop.outcome]}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{formatRelative(stop.at)}</span>
        </p>
        {budget && budgetText && <p className="text-sm text-muted-foreground">{budgetText}</p>}
        <pre className="mt-1 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{stop.reason}</pre>
      </div>
      {budget && <RaiseBudgetButton />}
    </Card>
  )
}
