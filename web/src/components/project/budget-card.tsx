import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { formatCost, formatTokens } from "@/lib/format"
import { costByRole, totalCost } from "@/lib/pipeline"
import { useProjectView } from "./context"

export function BudgetCard() {
  const { detail } = useProjectView()
  const budget = detail.budget
  const roles = costByRole(detail.attempts)
  const percent = budget && budget.runUsd > 0 ? Math.min(100, Math.round((budget.spentUsd / budget.runUsd) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spend</CardTitle>
        <CardDescription>
          {budget ? `${formatCost(budget.spentUsd)} of ${formatCost(budget.runUsd)} run budget` : `${formatCost(totalCost(detail.attempts))} spent. No run budget is set.`}
          {budget?.unreportedCalls ? `, plus ${budget.unreportedCalls} codex calls with no reported cost` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {budget && (
          <div className="flex items-center gap-3">
            <Progress value={percent} aria-label="Run budget spent" />
            <span className="w-12 shrink-0 text-right text-sm text-muted-foreground tabular-nums">{percent}%</span>
          </div>
        )}
        {roles.length ? (
          <ul className="divide-y text-sm">
            {roles.map((entry) => (
              <li key={entry.role} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <span className="min-w-0 flex-1 font-medium">{entry.role}</span>
                <span className="text-muted-foreground tabular-nums">{entry.calls} calls</span>
                <span className="text-muted-foreground tabular-nums">{formatTokens(entry.tokens)} tokens</span>
                <span className="w-20 text-right tabular-nums">{entry.unreported === entry.calls ? "—" : formatCost(entry.cost)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No agent calls yet.</p>
        )}
      </CardContent>
    </Card>
  )
}
