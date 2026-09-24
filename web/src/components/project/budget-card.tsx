import { useState } from "react"
import { CircleDollarSign, Loader2, MessageSquare, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { ProjectDetail } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { formatCost } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

const warningShare = 0.8
const topTaskCount = 5
// Fewer merged tasks than this give a guess too noisy to show.
const minMergedForProjection = 2
const raisePresets = [
  { label: "+25%", factor: 1.25 },
  { label: "+50%", factor: 1.5 },
  { label: "×2", factor: 2 },
]

function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100
}

// Average build cost of merged tasks, applied to the tasks still to go. A rough guess: planning and QA also spend.
function projection(detail: ProjectDetail, remainingUsd: number): { text: string; short: boolean } | null {
  const spendByTask = new Map((detail.spend?.byTask ?? []).map((entry) => [entry.taskId, entry.usd]))
  const merged = detail.tasks.filter((task) => task.status === "merged" && spendByTask.has(task.id))
  const open = detail.tasks.filter((task) => task.status !== "merged")
  if (merged.length < minMergedForProjection || !open.length) return null
  const average = merged.reduce((sum, task) => sum + (spendByTask.get(task.id) ?? 0), 0) / merged.length
  const needed = average * open.length
  if (needed <= remainingUsd) return { text: `About ${formatCost(needed)} to build the ${open.length} open tasks, at ${formatCost(average)} per task so far.`, short: false }
  const lastAffordable = Math.floor(remainingUsd / average)
  const runsOutAt = open[lastAffordable]
  return {
    text: `At ${formatCost(average)} per task, the budget runs out around ${runsOutAt?.id ?? "the last task"}. The open tasks need about ${formatCost(needed - remainingUsd)} more.`,
    short: true,
  }
}

function BarList({ rows, max }: { rows: { label: string; hint?: string; usd: number }[]; max: number }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate" title={row.hint}>
            {row.label}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${max > 0 ? Math.max(2, (row.usd / max) * 100) : 0}%` }} />
          </span>
          <span className="text-right tabular-nums">{formatCost(row.usd)}</span>
        </li>
      ))}
    </ul>
  )
}

function RaiseBudget({ runUsd }: { runUsd: number }) {
  const { name, detail } = useProjectView()
  const [custom, setCustom] = useState("")
  const [busy, setBusy] = useState(false)
  const customValue = Number(custom)
  const customValid = custom.trim() !== "" && Number.isFinite(customValue) && customValue > runUsd

  const raise = async (target: number) => {
    setBusy(true)
    try {
      const result = await api.raiseBudget(name, roundCents(target))
      const next = result.started ? "The run continues." : detail.active ? "The live run uses it before its next agent call." : ""
      toast.success(`Budget raised to ${formatCost(result.runUsd)}. ${next}`.trim())
      setCustom("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not raise the budget.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="font-medium">Raise budget</p>
        <p className="text-sm text-muted-foreground">Applies to the live run at once, or resumes a stopped one.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {raisePresets.map((preset) => (
          <Button key={preset.label} variant="outline" size="sm" disabled={busy} onClick={() => raise(runUsd * preset.factor)} title={`New limit ${formatCost(runUsd * preset.factor)}`}>
            {preset.label}
          </Button>
        ))}
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (customValid) void raise(customValue)
          }}
        >
          <label className="sr-only" htmlFor="budget-custom">
            New budget limit in dollars
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <Input id="budget-custom" type="number" inputMode="decimal" min={runUsd + 0.01} step="0.01" placeholder="New limit" value={custom} onChange={(event) => setCustom(event.target.value)} className="h-8 w-28 pl-6" />
          </div>
          <Button type="submit" size="sm" disabled={busy || !customValid}>
            {busy && <Loader2 className="animate-spin" />} Apply
          </Button>
        </form>
      </div>
    </div>
  )
}

export function BudgetCard() {
  const { detail } = useProjectView()
  const budget = detail.budget
  if (!budget) return null
  const spend = detail.spend
  const share = budget.runUsd > 0 ? budget.spentUsd / budget.runUsd : 0
  const remaining = Math.max(0, budget.runUsd - budget.spentUsd)
  const tone = share >= 1 ? "bg-destructive" : share >= warningShare ? "bg-warning" : "bg-primary"
  const titles = new Map(detail.tasks.map((task) => [task.id, task.title]))
  const roles = (spend?.byRole ?? []).filter((row) => row.usd > 0)
  const tasks = (spend?.byTask ?? []).slice(0, topTaskCount)
  const otherTasks = (spend?.byTask ?? []).slice(topTaskCount).reduce((sum, row) => sum + row.usd, 0)
  const outlook = projection(detail, remaining)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleDollarSign className="size-4 text-primary" aria-hidden="true" /> Budget
        </CardTitle>
        <CardDescription>Reported agent cost against budget.runUsd.</CardDescription>
        <CardAction className="text-right">
          <p className="text-lg font-semibold tabular-nums">{formatCost(remaining)}</p>
          <p className="text-xs text-muted-foreground">remaining</p>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums">{formatCost(budget.spentUsd)}</span>
            <span className="text-muted-foreground"> of {formatCost(budget.runUsd)}</span>
            <span className="ml-2 text-muted-foreground tabular-nums">{Math.round(share * 100)}% used</span>
          </p>
          <div
            className="relative h-2.5 rounded-full bg-muted"
            role="progressbar"
            aria-label="Run budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(share * 100))}
          >
            <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${Math.min(100, share * 100)}%` }} />
            <span className="absolute -top-1 h-4.5 w-0.5 rounded bg-warning" style={{ left: `${warningShare * 100}%` }} title="80% of the budget" aria-hidden="true" />
          </div>
          {budget.unreportedCalls > 0 && <p className="text-xs text-muted-foreground">{budget.unreportedCalls} codex calls report no cost and are not counted.</p>}
        </div>

        {outlook && (
          <p className={cn("flex items-start gap-2 rounded-md border p-3 text-sm", outlook.short ? "border-warning/40 bg-warning/10" : "bg-muted/40")}>
            {outlook.short && <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />}
            <span>
              {outlook.text} <span className="text-muted-foreground">A rough estimate.</span>
            </span>
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="spend-by-role">
            <h3 id="spend-by-role" className="mb-3 text-sm font-medium">
              By role
            </h3>
            {roles.length ? <BarList rows={roles.map((row) => ({ label: row.role, usd: row.usd, hint: `${row.calls} calls` }))} max={roles[0].usd} /> : <p className="text-sm text-muted-foreground">No reported spend yet.</p>}
          </section>
          <section aria-labelledby="spend-by-task">
            <h3 id="spend-by-task" className="mb-3 text-sm font-medium">
              Top tasks <span className="font-normal text-muted-foreground">(worker and reviewer)</span>
            </h3>
            {tasks.length ? (
              <>
                <BarList rows={tasks.map((row) => ({ label: row.taskId, hint: titles.get(row.taskId), usd: row.usd }))} max={tasks[0].usd} />
                {otherTasks > 0 && <p className="mt-2 text-xs text-muted-foreground">Other tasks: {formatCost(otherTasks)}</p>}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No task has spent yet.</p>
            )}
          </section>
        </div>

        {spend && spend.chatCalls > 0 && (
          <p className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
            <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
            <span>
              Lead chat: <span className="font-medium tabular-nums">{formatCost(spend.chatUsd)}</span> over {spend.chatCalls} {spend.chatCalls === 1 ? "answer" : "answers"}, not counted in the budget.
            </span>
          </p>
        )}

        <RaiseBudget runUsd={budget.runUsd} />
      </CardContent>
    </Card>
  )
}
