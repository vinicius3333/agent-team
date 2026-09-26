import { useState } from "react"
import { Link } from "react-router"
import { CalendarClock, Check, ChevronRight, Gauge, Loader2, Play, Plus, Wallet, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { Finding, Sprint, SprintSnapshot, Task } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useProjectView } from "@/components/project/context"
import { formatCost, formatDateTime } from "@/lib/format"
import { projectPath } from "@/lib/navigation"
import { cn } from "@/lib/utils"
import { SourceLabel } from "./shared"
import { SprintSettingsDialog } from "./sprint-settings-dialog"
import { useFindings, useSprints } from "./use-operate"

const dayMs = 24 * 60 * 60_000

function dueText(nextDueAt: string | null): string {
  if (!nextDueAt) return "as soon as the app is ready"
  const days = Math.ceil((Date.parse(nextDueAt) - Date.now()) / dayMs)
  if (days <= 0) return "due now"
  return days === 1 ? "in 1 day" : `in ${days} days`
}

function StatCard({ icon: Icon, label, value, className, children }: { icon: LucideIcon; label: string; value: string; className?: string; children?: React.ReactNode }) {
  return (
    <Card className={cn("gap-3 py-4", className)}>
      <CardContent className="flex flex-col gap-1.5 px-4">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" /> {label}
        </span>
        <span className="text-xl font-semibold tabular-nums sm:text-2xl">{value}</span>
        {children}
      </CardContent>
    </Card>
  )
}

function nextSprintText(snapshot: SprintSnapshot, active: Sprint | null): { value: string; note: string } {
  const { settings } = snapshot
  if (!settings.enabled) return { value: "Off", note: "Turn on sprints.enabled" }
  if (active) return { value: `After sprint ${active.number}`, note: `${settings.everyDays} days after it ends` }
  if (!snapshot.nextDueAt) return { value: "Soon", note: "Once the app is live" }
  return { value: dueText(snapshot.nextDueAt), note: formatDateTime(snapshot.nextDueAt) }
}

function StatCards({ snapshot, active }: { snapshot: SprintSnapshot; active: Sprint | null }) {
  const { settings, spentUsd30d, sprints } = snapshot
  const next = nextSprintText(snapshot, active)
  const scored = sprints.filter((sprint) => sprint.score !== null)
  const [latest, previous] = scored
  const scoreDelta = latest && previous ? latest.score! - previous.score! : null
  const spentPercent = Math.min(100, Math.round((spentUsd30d / settings.monthlyUsd) * 100))
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
      <StatCard icon={CalendarClock} label="Next sprint" value={next.value}>
        <span className="text-xs text-muted-foreground">{next.note}</span>
      </StatCard>
      <StatCard icon={Wallet} label="Spent in 30 days" value={`${formatCost(spentUsd30d)} of ${formatCost(settings.monthlyUsd, 0)}`}>
        <Progress value={spentPercent} className="h-1.5" aria-label={`${spentPercent}% of the monthly sprint budget`} />
      </StatCard>
      <StatCard className="col-span-2 sm:col-span-1" icon={Gauge} label="App score" value={latest ? `${latest.score} / 100` : "Not scored"}>
        {scoreDelta !== null ? (
          <span className={cn("text-xs font-medium", scoreDelta >= 0 ? "text-success" : "text-warning")}>
            {scoreDelta >= 0 ? "+" : ""}
            {scoreDelta} since sprint {previous.number}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">The evaluator scores the app each sprint</span>
        )}
      </StatCard>
    </div>
  )
}

type StepState = "done" | "active" | "pending"

function Steps({ steps }: { steps: { label: string; detail?: string; state: StepState }[] }) {
  return (
    <ol className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-0">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center gap-3 sm:flex-1 sm:flex-col sm:gap-1.5 sm:text-center">
          <span className="flex items-center sm:w-full">
            <span className={cn("hidden h-px flex-1 sm:block", index === 0 ? "invisible" : step.state === "pending" ? "bg-border" : "bg-primary")} />
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border-2",
                step.state === "done" && "border-success bg-success text-white",
                step.state === "active" && "border-primary bg-background",
                step.state === "pending" && "border-border bg-muted",
              )}
            >
              {step.state === "done" ? <Check className="size-3.5" aria-hidden="true" /> : step.state === "active" ? <span className="size-2 rounded-full bg-primary" /> : null}
            </span>
            <span className={cn("hidden h-px flex-1 sm:block", index === steps.length - 1 ? "invisible" : steps[index + 1].state === "pending" ? "bg-border" : "bg-primary")} />
          </span>
          <span className="flex flex-1 items-baseline justify-between gap-2 text-sm sm:flex-col sm:items-center sm:gap-0">
            <span className={cn(step.state === "pending" && "text-muted-foreground")}>{step.label}</span>
            {step.detail && <span className="text-xs text-muted-foreground tabular-nums">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

function sprintSteps(sprint: Sprint, tasks: Task[], phase: (name: string) => string): { label: string; detail?: string; state: StepState }[] {
  if (sprint.status === "planning") {
    return [
      { label: "Evaluate and plan", state: "active" },
      { label: "Spec and tasks", state: "pending" },
      { label: "Build", state: "pending" },
      { label: "QA and deploy", state: "pending" },
    ]
  }
  const own = tasks.filter((task) => task.change === sprint.changeId)
  const merged = own.filter((task) => task.status === "merged").length
  const planned = phase("plan") === "approved"
  const built = planned && own.length > 0 && merged === own.length
  return [
    { label: "Evaluate and plan", state: "done" },
    { label: "Spec and tasks", state: planned ? "done" : "active" },
    { label: "Build", detail: own.length ? `${merged}/${own.length} tasks` : undefined, state: built ? "done" : planned ? "active" : "pending" },
    { label: "QA and deploy", state: built ? "active" : "pending" },
  ]
}

function ActiveSprintCard({ sprint, snapshot }: { sprint: Sprint; snapshot: SprintSnapshot }) {
  const { name, detail } = useProjectView()
  const { findings } = useFindings("approved")
  const picked = (findings ?? []).filter((finding) => sprint.changeId && finding.changeId === sprint.changeId)
  const phase = (phaseName: string) => detail.phases.find((entry) => entry.name === phaseName)?.status ?? "pending"
  const spent = Math.max(0, snapshot.projectCostUsd - sprint.costAtStart)
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Sprint {sprint.number}</CardTitle>
          <StatusBadge status={sprint.status} />
          {sprint.changeId && (
            <Badge variant="secondary" asChild>
              <Link to={projectPath(name, "operate", "changes")}>Change {sprint.changeId}</Link>
            </Badge>
          )}
        </div>
        <p className="text-lg font-semibold">{sprint.goal || "The evaluator and the PM are choosing this sprint's goal."}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Steps steps={sprintSteps(sprint, detail.tasks, phase)} />
        {picked.length > 0 && <PickedItems items={picked} />}
        <p className="text-xs text-muted-foreground">
          {formatCost(spent)} of {formatCost(snapshot.settings.budgetUsd, 0)} sprint budget
        </p>
      </CardContent>
    </Card>
  )
}

function PickedItems({ items }: { items: Finding[] }) {
  const { name } = useProjectView()
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">Picked items</h3>
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.id}>
            <Link to={`${projectPath(name, "operate", "next-steps")}?finding=${item.id}`} className="flex min-h-11 items-center gap-3 py-2 hover:bg-muted/60">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row-reverse sm:items-center sm:justify-end sm:gap-3">
                <span className="min-w-0 text-sm sm:flex-1 sm:truncate">{item.title}</span>
                <SourceLabel source={item.source} className="flex sm:w-36 sm:shrink-0" />
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function historyGoal(sprint: Sprint): string {
  if (sprint.goal) return sprint.goal
  if (sprint.status === "skipped") return "Nothing worth building"
  return sprint.note || "No goal"
}

function HistoryCard({ sprints }: { sprints: Sprint[] }) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-base">History</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y sm:hidden">
          {sprints.map((sprint) => (
            <li key={sprint.number} className="flex min-h-11 flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                Sprint {sprint.number} <StatusBadge status={sprint.status} />
                <span className="text-muted-foreground tabular-nums">
                  {sprint.score !== null && `${sprint.score} · `}
                  {sprint.costUsd !== null && formatCost(sprint.costUsd)}
                </span>
              </span>
              <span className="text-sm text-muted-foreground">{historyGoal(sprint)}</span>
            </li>
          ))}
        </ul>
        <Table className="hidden sm:table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Sprint</TableHead>
              <TableHead>Goal</TableHead>
              <TableHead className="w-20">Score</TableHead>
              <TableHead className="w-24">Change</TableHead>
              <TableHead className="w-24">Cost</TableHead>
              <TableHead className="w-28">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sprints.map((sprint) => (
              <TableRow key={sprint.number}>
                <TableCell className="tabular-nums">{sprint.number}</TableCell>
                <TableCell className="whitespace-normal" title={sprint.note || undefined}>
                  {historyGoal(sprint)}
                </TableCell>
                <TableCell className="tabular-nums">{sprint.score ?? "–"}</TableCell>
                <TableCell className="font-mono text-xs">{sprint.changeId ?? "–"}</TableCell>
                <TableCell className="tabular-nums">{sprint.costUsd === null ? "–" : formatCost(sprint.costUsd)}</TableCell>
                <TableCell>
                  <StatusBadge status={sprint.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function useStartSprint(onStarted: () => void) {
  const { name } = useProjectView()
  const [starting, setStarting] = useState(false)
  const start = async () => {
    setStarting(true)
    try {
      await api.startSprint(name)
      toast.success("Sprint started. The evaluator is scoring the app.")
      onStarted()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not start the sprint.")
    } finally {
      setStarting(false)
    }
  }
  return { start, starting }
}

export function OperateSprints() {
  const { name } = useProjectView()
  const { snapshot, error, refresh } = useSprints()
  const { start, starting } = useStartSprint(refresh)
  const active = snapshot?.sprints.find((sprint) => sprint.status === "planning" || sprint.status === "building") ?? null
  const finished = (snapshot?.sprints ?? []).filter((sprint) => sprint !== active)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Sprints</h2>
          <p className="text-sm text-muted-foreground">
            {snapshot ? `Every ${snapshot.settings.everyDays} days the team evaluates the live app, picks backlog items, and ships them as one change.` : "The team evaluates the live app, picks backlog items, and ships them as one change."}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {snapshot && <SprintSettingsDialog settings={snapshot.settings} lastFinishedAt={snapshot.sprints[0]?.finishedAt ?? null} onSaved={refresh} />}
          <Button variant="outline" asChild className="h-11 sm:h-9">
            <Link to={`${projectPath(name, "operate", "next-steps")}?add=1`}>
              <Plus /> Add to backlog
            </Link>
          </Button>
          <Button onClick={start} disabled={!snapshot || starting} title={snapshot?.startBlocker ?? undefined} className="h-11 sm:h-9">
            {starting ? <Loader2 className="animate-spin" /> : <Play />} Start sprint now
          </Button>
        </div>
      </div>
      {!snapshot ? (
        error ? (
          <Card>
            <EmptyState title="Could not load sprints">{error.message}</EmptyState>
          </Card>
        ) : (
          <Skeleton className="h-64" />
        )
      ) : (
        <>
          {snapshot.startBlocker && !active && <p className="text-sm text-muted-foreground">No sprint can start now: {snapshot.startBlocker}.</p>}
          <StatCards snapshot={snapshot} active={active} />
          {active && <ActiveSprintCard sprint={active} snapshot={snapshot} />}
          {finished.length ? (
            <HistoryCard sprints={finished} />
          ) : (
            !active && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">No sprints yet</CardTitle>
                  <CardDescription>
                    {snapshot.settings.enabled
                      ? `The doctor starts the first sprint once the build is live. ${snapshot.backlogSize} backlog items are waiting.`
                      : "Sprints are off. Turn them on in Sprint settings, and keep the doctor running."}
                  </CardDescription>
                </CardHeader>
              </Card>
            )
          )}
        </>
      )}
    </div>
  )
}
