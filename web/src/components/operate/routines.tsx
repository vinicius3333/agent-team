import { useState, type ReactNode } from "react"
import { AlertTriangle, Bot, CircleCheck, CircleDashed, Loader2, Play, Plus } from "lucide-react"
import { toast } from "sonner"
import { api, urls } from "@/api/client"
import type { Routine, RoutineConfig, RoutineOutput, RoutinesSnapshot } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useProjectView } from "@/components/project/context"
import { formatCost, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { emptyRoutine, RoutineSheet } from "./routine-sheet"
import { useRoutines } from "./use-operate"

type Filter = "all" | RoutineOutput
const filterLabels: Record<Filter, string> = { all: "All", backlog: "Findings", marketing: "Marketing", report: "Reports" }
const outputLabels: Record<RoutineOutput, string> = { backlog: "Backlog", marketing: "Marketing", report: "Report" }
const imagePattern = /\.(png|jpe?g|webp)$/i

function toConfig(routine: Routine): RoutineConfig {
  const { id, name, role, instructions, trigger, everyDays, output, budgetUsd, enabled } = routine
  return { id, name, role, instructions, trigger, everyDays, output, budgetUsd, enabled }
}

function everyText(days: number): string {
  if (days === 1) return "Every day"
  if (days < 1) return `Every ${Math.round(days * 24)} h`
  return `Every ${days} days`
}

function scheduleText(routine: Routine): string {
  if (!routine.enabled) return "Off"
  if (routine.trigger === "manual") return "By hand"
  if (routine.trigger === "sprint") return "After each sprint"
  if (routine.trigger === "deploy") return "After each deploy"
  if (!routine.nextDueAt) return everyText(routine.everyDays)
  return `${everyText(routine.everyDays)} · ${dueText(routine.nextDueAt)}`
}

function dueText(nextDueAt: string): string {
  const hours = (Date.parse(nextDueAt) - Date.now()) / (60 * 60_000)
  if (hours <= 0) return "due now"
  if (hours < 24) return `next in ${Math.ceil(hours)} h`
  return `next ${new Date(nextDueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
}

function LastRun({ routine }: { routine: Routine }) {
  const run = routine.lastRun
  if (routine.running) {
    return (
      <span className="flex items-center gap-1.5 text-primary">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Running
      </span>
    )
  }
  if (!run) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <CircleDashed className="size-4" aria-hidden="true" /> Not run yet
      </span>
    )
  }
  if (run.status === "failed") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-warning" title={run.summary}>
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" /> <span className="truncate">{run.summary.split(":")[0] || "Failed"}</span>
      </span>
    )
  }
  const outcome = run.files.length ? `${run.files.length} ${routine.output === "report" ? "report" : run.files.length === 1 ? "image" : "images"}` : `${run.findings} ${run.findings === 1 ? "finding" : "findings"}`
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground" title={`${formatRelative(run.startedAt)}: ${run.summary}`}>
      <CircleCheck className="size-4 text-success" aria-hidden="true" /> {outcome}
    </span>
  )
}

function Chips({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>
}

function RoutineCard({ routine, onEdit, onToggle, onRun }: { routine: Routine; onEdit: () => void; onToggle: (enabled: boolean) => void; onRun: () => void }) {
  const { name } = useProjectView()
  const images = (routine.lastRun?.files ?? []).filter((file) => imagePattern.test(file.file)).slice(0, 3)
  return (
    <Card className={cn("gap-3 py-4", !routine.enabled && "opacity-60")}>
      <CardHeader className="flex flex-row items-center gap-2 px-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="size-4" aria-hidden="true" />
        </span>
        <span className="flex-1 font-mono text-xs text-muted-foreground">{routine.role}</span>
        <Switch checked={routine.enabled} onCheckedChange={onToggle} aria-label={`${routine.enabled ? "Turn off" : "Turn on"} ${routine.name}`} />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 px-4">
        <button type="button" onClick={onEdit} className="text-left">
          <h3 className="font-semibold hover:underline">{routine.name}</h3>
          <p className="line-clamp-2 text-sm text-muted-foreground">{routine.instructions}</p>
        </button>
        <Chips>
          {routine.capabilities.map((capability) => (
            <Badge key={capability} variant="secondary" className="font-normal">
              {capability}
            </Badge>
          ))}
          <Badge variant="outline" className="font-normal">
            {outputLabels[routine.output]}
          </Badge>
          {routine.builtIn && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              Built-in
            </Badge>
          )}
        </Chips>
        {images.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {images.map((image) => (
              <a key={image.file} href={urls.raw(name, image.file)} target="_blank" rel="noreferrer" title={image.caption}>
                <img src={urls.raw(name, image.file)} alt={image.caption || "Generated image"} className="aspect-square w-full rounded-md border object-cover" loading="lazy" />
              </a>
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-2 border-t px-4 pt-3 text-sm">
        <span className="text-muted-foreground">{scheduleText(routine)}</span>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <LastRun routine={routine} />
          </div>
          <span className="tabular-nums text-muted-foreground">{routine.lastRun?.costUsd != null ? formatCost(routine.lastRun.costUsd) : "—"}</span>
          <Button variant="outline" size="sm" className="h-11 sm:h-8" disabled={routine.runBlocker !== null} title={routine.runBlocker ?? undefined} onClick={onRun}>
            <Play /> Run now
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}

function MonthlyCap({ snapshot, onSave }: { snapshot: RoutinesSnapshot; onSave: (monthlyUsd: number) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(snapshot.monthlyUsd))
  const amount = Number(value)
  if (!editing) {
    return (
      <p className="text-sm text-muted-foreground">
        Routines spent {formatCost(snapshot.spentUsd30d)} of {formatCost(snapshot.monthlyUsd, 0)} in the last 30 days.{" "}
        <Button variant="link" className="h-auto p-0" onClick={() => setEditing(true)}>
          Change the cap
        </Button>
      </p>
    )
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={async (event) => {
        event.preventDefault()
        if (await onSave(amount)) setEditing(false)
      }}
    >
      <label htmlFor="routines-cap">Monthly cap ($)</label>
      <Input id="routines-cap" type="number" min={1} value={value} onChange={(event) => setValue(event.target.value)} className="h-11 w-24 sm:h-8" />
      <Button type="submit" size="sm" className="h-11 sm:h-8" disabled={!(amount > 0)}>
        Save
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-11 sm:h-8" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  )
}

type Editing = { routine: RoutineConfig; builtIn: boolean; key: number } | null

export function OperateRoutines() {
  const { name, detail } = useProjectView()
  const { snapshot, error, refresh } = useRoutines()
  const [filter, setFilter] = useState<Filter>("all")
  const [editing, setEditing] = useState<Editing>(null)
  const routines = snapshot?.routines ?? []
  const shown = routines.filter((routine) => filter === "all" || routine.output === filter)

  const save = async (list: RoutineConfig[], monthlyUsd = snapshot!.monthlyUsd, message = "Routines saved.") => {
    try {
      await api.saveRoutines(name, monthlyUsd, list)
      toast.success(message)
      await refresh()
      return true
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not save the routines.")
      return false
    }
  }
  const configs = () => routines.map(toConfig)
  const replace = (routine: RoutineConfig) => (routine.id ? configs().map((entry) => (entry.id === routine.id ? routine : entry)) : [...configs(), routine])
  const run = async (routine: Routine) => {
    try {
      await api.runRoutine(name, routine.id)
      toast.success(`${routine.name} started.`)
      await refresh()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not start the routine.")
    }
  }
  const openEditor = (routine: RoutineConfig, builtIn: boolean) => setEditing({ routine, builtIn, key: Date.now() })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Routines</h2>
          <p className="text-sm text-muted-foreground">Recurring jobs you give to one agent. Each run has a budget cap and writes its output where you choose.</p>
        </div>
        <Button className="h-11 sm:h-9" disabled={!snapshot || detail.config === null} onClick={() => openEditor(emptyRoutine, false)}>
          <Plus /> New routine
        </Button>
      </div>
      {!snapshot ? (
        error ? (
          <Card>
            <EmptyState title="Could not load routines">{error.message}</EmptyState>
          </Card>
        ) : (
          <Skeleton className="h-64" />
        )
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter the routines">
            {(Object.keys(filterLabels) as Filter[]).map((entry) => (
              <Button key={entry} variant={filter === entry ? "default" : "outline"} aria-pressed={filter === entry} onClick={() => setFilter(entry)} className="h-10 rounded-full md:h-9">
                {filterLabels[entry]}
                {entry === "all" && ` ${routines.length}`}
              </Button>
            ))}
          </div>
          {!snapshot.live && <p className="text-sm text-muted-foreground">The app is not live yet. Scheduled routines start once it is; Run now works any time.</p>}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((routine) => (
              <RoutineCard
                key={routine.id}
                routine={routine}
                onEdit={() => openEditor(toConfig(routine), routine.builtIn)}
                onToggle={(enabled) => void save(replace({ ...toConfig(routine), enabled }), undefined, `${routine.name} is ${enabled ? "on" : "off"}.`)}
                onRun={() => void run(routine)}
              />
            ))}
          </div>
          <MonthlyCap key={snapshot.monthlyUsd} snapshot={snapshot} onSave={(monthlyUsd) => save(configs(), monthlyUsd, "Monthly cap saved.")} />
        </>
      )}
      {editing && snapshot && (
        <RoutineSheet
          key={editing.key}
          open
          initial={editing.routine}
          builtIn={editing.builtIn}
          roles={snapshot.roles}
          onOpenChange={(open) => !open && setEditing(null)}
          onSave={(routine) => save(replace(routine), undefined, editing.routine.id ? "Routine saved." : `${routine.name} created.`)}
          onDelete={editing.routine.id && !editing.builtIn ? () => save(configs().filter((entry) => entry.id !== editing.routine.id), undefined, "Routine deleted.") : undefined}
        />
      )}
    </div>
  )
}
