import { useState } from "react"
import { CircleDollarSign, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { Task } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { maxRetries, taskCounts } from "@/lib/pipeline"
import { useProjectView } from "./context"

export function RetryButton({ task, size = "sm" }: { task: Task; size?: "sm" | "default" }) {
  const { name } = useProjectView()
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await api.retry(name, task.id)
      toast.success(`Retrying ${task.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not retry ${task.id}.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation()
        void retry()
      }}
      aria-label={`Retry ${task.id}`}
    >
      {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
    </Button>
  )
}

// Matches taskBudgetRaiseFactor in src/project.ts.
const taskBudgetRaiseFactor = 2

export function ApproveBudgetButton({ task, size = "sm" }: { task: Task & { budgetStopUsd: number }; size?: "sm" | "default" }) {
  const { name } = useProjectView()
  const [busy, setBusy] = useState(false)
  const raisedUsd = (task.budgetStopUsd * taskBudgetRaiseFactor).toFixed(2)
  const approve = async () => {
    setBusy(true)
    try {
      await api.approveTaskBudget(name, task.id)
      toast.success(`${task.id} can now spend up to $${raisedUsd}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not approve the budget for ${task.id}.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      type="button"
      size={size}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation()
        void approve()
      }}
      aria-label={`Approve a $${raisedUsd} budget for ${task.id}`}
    >
      {busy ? <Loader2 className="animate-spin" /> : <CircleDollarSign />} Approve ${raisedUsd}
    </Button>
  )
}

export function TaskAction({ task, size = "sm" }: { task: Task; size?: "sm" | "default" }) {
  if (task.budgetStopUsd) return <ApproveBudgetButton task={{ ...task, budgetStopUsd: task.budgetStopUsd }} size={size} />
  if (task.status === "blocked") return <RetryButton task={task} size={size} />
  return null
}

export function TasksCard() {
  const { detail, openPanel } = useProjectView()
  const limit = maxRetries(detail)
  const counts = taskCounts(detail.tasks)
  const workerFor = (taskId: string) => detail.attempts.find((attempt) => attempt.role === "worker" && attempt.subject.startsWith(`${taskId}-`))
  const configuredWorker = detail.config?.roles.worker

  return (
    <Card className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle>Tasks</CardTitle>
        <CardDescription>
          {detail.tasks.length ? `${counts.merged} merged, ${counts.running} running, ${counts.pending} pending, ${counts.blocked} blocked` : "No plan yet"}
        </CardDescription>
        <CardAction className="text-sm text-muted-foreground tabular-nums">{detail.tasks.length} total</CardAction>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {detail.tasks.length === 0 ? (
          <EmptyState title="Tasks appear after the plan step">The planner writes tasks.json. Each task then gets a worker and a reviewer.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Task</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="hidden md:table-cell">Worker</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Attempts</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.tasks.map((task) => {
                const worker = workerFor(task.id) ?? configuredWorker
                return (
                  <TableRow
                    key={task.id}
                    tabIndex={0}
                    className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                    onClick={() => openPanel({ kind: "task", id: task.id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        openPanel({ kind: "task", id: task.id })
                      }
                    }}
                    aria-label={`${task.id} ${task.title}, ${task.status}. Show details`}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">{task.id}</TableCell>
                    <TableCell className="max-w-[12rem] whitespace-normal sm:max-w-none">
                      <div className="line-clamp-2">{task.title}</div>
                      {task.budgetStopUsd ? (
                        <div className="text-xs text-destructive">Budget reached (${task.budgetStopUsd.toFixed(2)}): approve more to continue</div>
                      ) : (
                        task.lastFailure && task.status !== "merged" && <div className="text-xs text-destructive">Last attempt failed</div>
                      )}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{worker ? `${worker.runner} ${worker.model}` : "—"}</TableCell>
                    <TableCell>
                      <StatusBadge status={task.status} />
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{task.attempts ? `${task.attempts} / ${limit}` : "—"}</TableCell>
                    <TableCell className="text-right">
                      <TaskAction task={task} />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
