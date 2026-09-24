import type { Attempt } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatClock, formatCost, formatDuration } from "@/lib/format"
import { costByRole, totalCost } from "@/lib/pipeline"
import { useProjectView } from "./context"

export function transcriptRequest(attempt: Attempt) {
  return { file: attempt.transcript, subject: attempt.subject, role: attempt.role, runner: attempt.runner, model: attempt.model }
}

function CostByRoleCard() {
  const { detail } = useProjectView()
  const rows = costByRole(detail.attempts)
  const total = totalCost(detail.attempts)
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Cost by role</CardTitle>
        <CardDescription>Claude reports cost. Codex does not, so its calls show n/a.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Runners</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.role}>
                <TableCell className="font-medium">{row.role}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{row.runners.join(", ")}</TableCell>
                <TableCell className="text-right tabular-nums">{row.calls}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {row.unreported === row.calls ? "n/a" : formatCost(row.cost, 3)}
                  {row.unreported > 0 && row.unreported < row.calls && <span className="text-muted-foreground"> + n/a</span>}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-semibold">Total</TableCell>
              <TableCell className="hidden sm:table-cell" />
              <TableCell className="text-right tabular-nums">{detail.attempts.length}</TableCell>
              <TableCell className="text-right font-mono font-semibold tabular-nums">{formatCost(total, 3)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function percent(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "—"
}

function ReviewerCard() {
  const { detail } = useProjectView()
  const metrics = detail.reviewer
  if (!metrics?.reviews) return null
  const rows = [
    { label: "Reviews with a verdict", value: String(metrics.reviews) },
    { label: "Fail rate", value: `${percent(metrics.fails, metrics.reviews)} (${metrics.fails} of ${metrics.reviews})` },
    {
      label: "Fails later confirmed",
      value: metrics.followedFails ? `${metrics.confirmedFails} of ${metrics.followedFails}` : "—",
    },
  ]
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Reviewer</CardTitle>
        <CardDescription>A fail counts as confirmed when the next reviewed attempt of the task changed a file the reviewer flagged.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 sm:grid-cols-3">
          {rows.map((row) => (
            <div key={row.label}>
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

export function AttemptsTab() {
  const { detail, openTranscript } = useProjectView()
  if (!detail.attempts.length) {
    return (
      <Card>
        <EmptyState title="No agent calls yet">Every call to an agent shows up here with its transcript.</EmptyState>
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-3">
        <CardHeader>
          <CardTitle>Agent calls</CardTitle>
          <CardDescription>The latest {detail.attempts.length} calls. Select a row to read its transcript.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead className="hidden sm:table-cell">Role</TableHead>
                <TableHead className="hidden md:table-cell">Runner</TableHead>
                <TableHead className="hidden lg:table-cell">Started</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Failure class</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.attempts.map((attempt) => (
                <TableRow
                  key={attempt.id}
                  tabIndex={0}
                  className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                  onClick={() => openTranscript(transcriptRequest(attempt))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      openTranscript(transcriptRequest(attempt))
                    }
                  }}
                  aria-label={`Open transcript for ${attempt.subject}`}
                >
                  <TableCell className="font-mono text-xs">{attempt.subject}</TableCell>
                  <TableCell className="hidden sm:table-cell">{attempt.role}</TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">
                    {attempt.runner} {attempt.model}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{formatClock(attempt.createdAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(attempt.durationMs)}</TableCell>
                  <TableCell>
                    <StatusBadge status={attempt.status} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{attempt.failureClass ? <StatusBadge status={attempt.failureClass === "agent_failure" ? "agent_failure" : "failed"} label={attempt.failureClass} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{attempt.costUsd ? formatCost(attempt.costUsd, 3) : attempt.runner === "codex" ? "n/a" : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <ReviewerCard />
      <CostByRoleCard />
    </div>
  )
}
