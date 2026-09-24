import type { ReactNode } from "react"
import { useSearchParams } from "react-router"
import { ArrowLeft, Check, CircleAlert, Clock, Coins, Loader2 } from "lucide-react"
import type { Attempt, ProjectDetail, Task } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AbandonButton, ChangeRequestCard, PullRequestLink } from "@/components/project/changes-card"
import { transcriptRequest } from "@/components/project/attempts-tab"
import { useProjectView } from "@/components/project/context"
import { useIsMobile } from "@/hooks/use-mobile"
import { formatCost, formatDateTime, formatDuration } from "@/lib/format"
import { stepStates } from "@/lib/pipeline"
import { cn } from "@/lib/utils"

const initialBuild = "C000"

interface ChangeEntry {
  id: string
  title: string
  status: string
  createdAt: string | null
  tasks: Task[]
}

function changeEntries(detail: ProjectDetail): ChangeEntry[] {
  const changes = [...(detail.changes ?? [])].sort((a, b) => a.id.localeCompare(b.id))
  const initialTasks = detail.tasks.filter((task) => !task.change)
  const initialDone = changes.length > 0 || (initialTasks.length > 0 && initialTasks.every((task) => task.status === "merged"))
  return [
    { id: initialBuild, title: "Initial build", status: initialDone ? "merged" : "running", createdAt: detail.phases.find((phase) => phase.name === "spec")?.updatedAt ?? null, tasks: initialTasks },
    ...changes.map((change) => ({ id: change.id, title: change.title, status: change.status === "open" ? "running" : change.status, createdAt: change.createdAt, tasks: detail.tasks.filter((task) => task.change === change.id) })),
  ]
}

type StepTone = "done" | "current" | "failed" | "pending"
const stepLabels = { plan: "Plan", build: "Build", qa: "QA", deploy: "Deploy" } as const
type Step = keyof typeof stepLabels

// The phases table only holds the latest run, so earlier changes show their final outcome.
function changeSteps(detail: ProjectDetail, entry: ChangeEntry): Record<Step, StepTone> {
  const steps = Object.keys(stepLabels) as Step[]
  if (entry.status === "merged") return Object.fromEntries(steps.map((step) => [step, "done"])) as Record<Step, StepTone>
  if (entry.status !== "running") return Object.fromEntries(steps.map((step) => [step, entry.status === "failed" ? "failed" : "pending"])) as Record<Step, StepTone>
  const states = new Map(stepStates(detail).map((state) => [state.step, state.status]))
  const merged = entry.tasks.filter((task) => task.status === "merged").length
  const tone = (status: string | undefined): StepTone =>
    status === "done" || status === "approved" || status === "skipped" ? "done" : status === "failed" ? "failed" : status === "running" || status === "awaiting_approval" ? "current" : "pending"
  return {
    plan: tone(states.get("plan")),
    build: entry.tasks.length && merged === entry.tasks.length ? "done" : entry.tasks.some((task) => task.status === "blocked") ? "failed" : entry.tasks.length ? "current" : "pending",
    qa: tone(states.get("qa")),
    deploy: tone(states.get("deploy")),
  }
}

function Stepper({ steps }: { steps: Record<Step, StepTone> }) {
  return (
    <ol className="flex items-start">
      {(Object.keys(stepLabels) as Step[]).map((step, index) => (
        <li key={step} className="flex flex-1 flex-col items-center gap-1 text-xs">
          <span className="relative flex w-full justify-center">
            {index > 0 && <span className="absolute top-1/2 right-1/2 left-[-50%] -z-0 h-px bg-border" aria-hidden="true" />}
            <span
              className={cn(
                "relative flex size-7 items-center justify-center rounded-full border bg-card font-medium tabular-nums",
                steps[step] === "done" && "border-primary text-primary",
                steps[step] === "current" && "border-primary bg-primary text-primary-foreground",
                steps[step] === "failed" && "border-destructive bg-destructive text-white",
              )}
            >
              {steps[step] === "done" ? <Check className="size-4" aria-hidden="true" /> : steps[step] === "failed" ? <CircleAlert className="size-4" aria-hidden="true" /> : index + 1}
            </span>
          </span>
          <span className={cn(steps[step] === "current" ? "font-medium text-primary" : "text-muted-foreground")}>
            {stepLabels[step]}
            <span className="sr-only">: {steps[step]}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function SelectableRow({ selected, onClick, children, label }: { selected: boolean; onClick: () => void; children: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      aria-label={label}
      className={cn(
        "flex min-h-10 w-full items-start gap-3 border-l-2 border-transparent px-4 py-3 text-left hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        selected && "border-primary bg-primary/5",
      )}
    >
      {children}
    </button>
  )
}

function BackLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" onClick={onClick} className="h-10 self-start px-2">
      <ArrowLeft /> {children}
    </Button>
  )
}

function ChangesColumn({ entries, selected, onSelect }: { entries: ChangeEntry[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <Card className="gap-2 pb-2">
      <CardHeader>
        <CardTitle>Changes</CardTitle>
      </CardHeader>
      <ul className="divide-y">
        {entries.map((entry) => (
          <li key={entry.id}>
            <SelectableRow selected={entry.id === selected} onClick={() => onSelect(entry.id)} label={`${entry.id} ${entry.title}`}>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  <span className="font-mono text-xs text-muted-foreground">{entry.id}</span> {entry.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.tasks.length} {entry.tasks.length === 1 ? "task" : "tasks"}
                  {entry.createdAt && `, ${new Date(entry.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}`}
                </span>
              </span>
              <StatusBadge status={entry.status} label={entry.status === "running" ? "building" : undefined} />
            </SelectableRow>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ChangeColumn({ entry, selectedTask, onSelect }: { entry: ChangeEntry | null; selectedTask: string | null; onSelect: (id: string) => void }) {
  const { detail } = useProjectView()
  if (!entry) return <Card><EmptyState title="Select a change">Its steps and tasks show here.</EmptyState></Card>
  const change = detail.changes?.find((candidate) => candidate.id === entry.id)
  return (
    <Card className="gap-4 pb-2">
      <CardHeader>
        <CardTitle>
          <span className="font-mono text-muted-foreground">{entry.id}</span> {entry.title}
        </CardTitle>
        {change && (
          <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <PullRequestLink url={change.prUrl} />
            <span>Cost {formatCost(change.costUsd)}</span>
            {change.finishedAt && <span>Finished {formatDateTime(change.finishedAt)}</span>}
            <AbandonButton change={change} />
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <Stepper steps={changeSteps(detail, entry)} />
      </CardContent>
      {entry.tasks.length ? (
        <ul className="divide-y border-t">
          {entry.tasks.map((task) => (
            <li key={task.id}>
              <SelectableRow selected={task.id === selectedTask} onClick={() => onSelect(task.id)} label={`${task.id} ${task.title}`}>
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{task.id}</span> {task.title}
                </span>
                <StatusBadge status={task.status} />
              </SelectableRow>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-6 pb-4 text-sm text-muted-foreground">No tasks yet. They appear once the plan is ready.</p>
      )}
    </Card>
  )
}

interface CallEntry {
  key: string
  role: string
  runner: string
  model: string
  status: string
  durationMs: number | null
  costUsd: number | null
  open: () => void
}

function taskCalls(detail: ProjectDetail, taskId: string, openTranscript: ReturnType<typeof useProjectView>["openTranscript"]): CallEntry[] {
  const prefix = `${taskId}-`
  const finished = detail.attempts
    .filter((attempt: Attempt) => attempt.subject.startsWith(prefix))
    .slice()
    .reverse()
    .map((attempt) => ({ key: `attempt-${attempt.id}`, role: attempt.role, runner: attempt.runner, model: attempt.model, status: attempt.status, durationMs: attempt.durationMs, costUsd: attempt.costUsd, open: () => openTranscript(transcriptRequest(attempt)) }))
  const live = (detail.liveAgents ?? [])
    .filter((agent) => agent.subject.startsWith(prefix))
    .map((agent) => ({
      key: `live-${agent.subject}`,
      role: agent.role,
      runner: agent.runner,
      model: agent.model,
      status: "running",
      durationMs: null,
      costUsd: null,
      open: () => openTranscript({ file: agent.transcript, subject: agent.subject, role: agent.role, runner: agent.runner, model: agent.model, live: true }),
    }))
  return [...finished, ...live]
}

function CallIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
  if (status === "done" || status === "pass" || status === "merged") return <Check className="size-5 rounded-full bg-success p-0.5 text-white" aria-hidden="true" />
  return <CircleAlert className="size-5 text-warning" aria-hidden="true" />
}

function CallsColumn({ task }: { task: Task | null }) {
  const { detail, openTranscript } = useProjectView()
  if (!task) return <Card><EmptyState title="Select a task">Its agent calls show here.</EmptyState></Card>
  const calls = taskCalls(detail, task.id, openTranscript)
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>
          <span className="font-mono text-muted-foreground">{task.id}</span> Agent calls
        </CardTitle>
      </CardHeader>
      <CardContent>
        {calls.length ? (
          <ol className="flex flex-col gap-5">
            {calls.map((call) => (
              <li key={call.key} className="flex gap-3">
                <CallIcon status={call.status} />
                <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium capitalize">{call.role}</span>
                    <StatusBadge status={call.status} />
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {call.runner} {call.model}
                  </span>
                  <span className="flex gap-4 text-xs text-muted-foreground tabular-nums">
                    <span className="flex items-center gap-1">
                      <Clock className="size-3.5" aria-hidden="true" /> {call.status === "running" ? "running" : formatDuration(call.durationMs)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Coins className="size-3.5" aria-hidden="true" /> {call.costUsd === null ? "—" : formatCost(call.costUsd)}
                    </span>
                  </span>
                  <Button variant="link" onClick={call.open} className="h-10 self-start px-0 md:h-7">
                    Open transcript
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No agent calls for this task. Older calls may be past the latest 300 the server returns.</p>
        )}
      </CardContent>
    </Card>
  )
}

export function OperateChanges() {
  const { detail } = useProjectView()
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const entries = changeEntries(detail)
  const entry = entries.find((candidate) => candidate.id === searchParams.get("change")) ?? null
  const task = entry?.tasks.find((candidate) => candidate.id === searchParams.get("task")) ?? null

  const select = (change: string | null, taskId: string | null) =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (change) next.set("change", change)
      else next.delete("change")
      if (taskId) next.set("task", taskId)
      else next.delete("task")
      return next
    })

  const changes = <ChangesColumn entries={entries} selected={entry?.id ?? null} onSelect={(id) => select(id, null)} />
  const tasks = <ChangeColumn entry={entry} selectedTask={task?.id ?? null} onSelect={(id) => select(entry?.id ?? null, id)} />
  const calls = <CallsColumn task={task} />

  return (
    <div className="flex flex-col gap-4">
      <ChangeRequestCard />
      {isMobile ? (
        task && entry ? (
          <div className="flex flex-col gap-2">
            <BackLink onClick={() => select(entry.id, null)}>
              {entry.id} {entry.title}
            </BackLink>
            {calls}
          </div>
        ) : entry ? (
          <div className="flex flex-col gap-2">
            <BackLink onClick={() => select(null, null)}>Changes</BackLink>
            {tasks}
          </div>
        ) : (
          changes
        )
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-3">
          {changes}
          {tasks}
          {calls}
        </div>
      )}
    </div>
  )
}
