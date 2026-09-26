import { useState, type ReactNode } from "react"
import { Link } from "react-router"
import { Bot, Gauge, Loader2, Play, Repeat, Sparkles, UserRound, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { api, ApiError } from "@/api/client"
import type { Finding, FindingSeverity, FindingSource, InsightAgent, InsightRun, MetricPoint, OperateSnapshot } from "@/api/types"
import { Markdown } from "@/components/markdown"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useProjectView } from "@/components/project/context"
import { formatRelative } from "@/lib/format"
import { projectPath } from "@/lib/navigation"
import { agentLabels, formatNumber, type MetricTone } from "@/lib/operate"
import { cn } from "@/lib/utils"

const severityClasses: Record<FindingSeverity, string> = {
  high: "bg-destructive/10 text-destructive border-destructive/20",
  medium: "bg-warning/10 text-warning border-warning/25",
  low: "bg-muted text-muted-foreground border-border",
}

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <span className={cn("inline-flex w-18 shrink-0 justify-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize", severityClasses[severity])}>{severity}</span>
}

const sourceIcons: Record<FindingSource, LucideIcon> = {
  monitoring: Bot,
  analytics: Bot,
  research: Bot,
  evaluator: Gauge,
  product: Sparkles,
  manual: UserRound,
  routine: Repeat,
}

export function SourceLabel({ source, className }: { source: FindingSource; className?: string }) {
  const Icon = sourceIcons[source]
  return (
    <span className={cn("items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Icon className="size-4" aria-hidden="true" /> {agentLabels[source]}
    </span>
  )
}

const toneClasses: Record<MetricTone, string> = {
  good: "bg-success",
  worse: "bg-warning",
  down: "bg-destructive",
  none: "bg-muted-foreground/40",
}

const toneLabels: Record<MetricTone, string> = {
  good: "fine",
  worse: "got worse",
  down: "down",
  none: "no data",
}

export function ToneDot({ tone }: { tone: MetricTone }) {
  return (
    <span className={cn("inline-block size-2.5 shrink-0 rounded-full", toneClasses[tone])} role="img" aria-label={`Status: ${toneLabels[tone]}`} />
  )
}

export function ConfigLink({ children }: { children: ReactNode }) {
  const { name } = useProjectView()
  return (
    <Link to={projectPath(name, "system", "config")} className="font-medium text-primary hover:underline">
      {children}
    </Link>
  )
}

export function useFindingActions(onChange: () => void) {
  const { name } = useProjectView()
  const [busy, setBusy] = useState<number | null>(null)

  const approve = async (finding: Finding) => {
    setBusy(finding.id)
    try {
      const { changeId, started } = await api.approveFinding(name, finding.id)
      if (started) toast.success(`Change ${changeId} opened. The team is planning it.`)
      else toast.warning(`Change ${changeId} opened, but a run is still active. Resume the run once it stops.`)
      onChange()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not approve the finding.")
      if (reason instanceof ApiError && reason.status === 409) onChange()
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async (finding: Finding) => {
    setBusy(finding.id)
    try {
      await api.dismissFinding(name, finding.id)
      toast.success("Finding dismissed.")
      onChange()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not dismiss the finding.")
    } finally {
      setBusy(null)
    }
  }

  return { approve, dismiss, busy }
}

export function RunNowButton({ agent, run, onStarted }: { agent: InsightAgent; run: InsightRun | null; onStarted: () => void }) {
  const { name } = useProjectView()
  const [busy, setBusy] = useState(false)
  const running = run?.status === "running"
  const start = async () => {
    setBusy(true)
    try {
      await api.runInsight(name, agent)
      toast.success(`The ${agentLabels[agent].toLowerCase()} started.`)
      onStarted()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not start the agent.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="outline" onClick={start} disabled={busy || running} className="h-10 md:h-9">
      {busy || running ? <Loader2 className="animate-spin" /> : <Play />} {running ? "Running" : "Run now"}
    </Button>
  )
}

export function AgentSummaryCard({ agent, title, run, onRefresh, markdown }: { agent: InsightAgent; title: string; run: InsightRun | null; onRefresh: () => void; markdown?: boolean }) {
  const { name } = useProjectView()
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {run ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={run.status} />
              <span>
                Started {formatRelative(run.startedAt)}
                {run.status !== "running" && ` · ${run.findings} ${run.findings === 1 ? "finding" : "findings"}`}
              </span>
            </span>
          ) : (
            `The ${agentLabels[agent].toLowerCase()} has not run yet.`
          )}
        </CardDescription>
        <CardAction>
          <RunNowButton agent={agent} run={run} onStarted={onRefresh} />
        </CardAction>
      </CardHeader>
      {run?.summary && (
        <CardContent>
          {markdown ? <Markdown text={run.summary} project={name} className="text-sm" /> : <p className="text-sm whitespace-pre-line">{run.summary}</p>}
        </CardContent>
      )}
    </Card>
  )
}

function scale(values: number[]) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  return (value: number) => (max === min ? 0.5 : (value - min) / (max - min))
}

export function Sparkline({ points, className }: { points: MetricPoint[]; className?: string }) {
  if (points.length < 2) return null
  const toY = scale(points.map((point) => point.value))
  const coordinates = points.map((point, index) => `${(index / (points.length - 1)) * 100},${28 - toY(point.value) * 26}`)
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-8 w-full overflow-visible", className)} aria-hidden="true">
      <polygon points={`0,30 ${coordinates.join(" ")} 100,30`} className="fill-primary/10" />
      <polyline points={coordinates.join(" ")} fill="none" vectorEffect="non-scaling-stroke" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

// A line with its area, the highest value, and the first and last timestamps. Plain SVG, sized by its container.
export function LineChart({ points, label, format, time }: { points: MetricPoint[]; label: string; format: (value: number) => string; time?: boolean }) {
  if (points.length < 2) return <p className="py-8 text-center text-sm text-muted-foreground">Not enough data yet.</p>
  const values = points.map((point) => point.value)
  const max = Math.max(...values)
  const toY = (value: number) => 95 - (max ? value / max : 0) * 90
  const coordinates = points.map((point, index) => `${(index / (points.length - 1)) * 100},${toY(point.value)}`)
  const stamp = time ? shortTime : shortDate
  return (
    <figure className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>max {format(max)}</span>
        <span>last {format(values.at(-1)!)}</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={`${label}: last value ${format(values.at(-1)!)}, highest ${format(max)}`}>
        <line x1="0" x2="100" y1="95" y2="95" vectorEffect="non-scaling-stroke" className="stroke-border" />
        <line x1="0" x2="100" y1="50" y2="50" vectorEffect="non-scaling-stroke" className="stroke-border" strokeDasharray="3 3" />
        <polygon points={`0,95 ${coordinates.join(" ")} 100,95`} className="fill-primary/10" />
        <polyline points={coordinates.join(" ")} fill="none" vectorEffect="non-scaling-stroke" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" />
      </svg>
      <figcaption className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{stamp(points[0].at)}</span>
        <span>{stamp(points.at(-1)!.at)}</span>
      </figcaption>
    </figure>
  )
}

export function BarChart({ points, label, format }: { points: MetricPoint[]; label: string; format: (value: number) => string }) {
  if (!points.length) return <p className="py-8 text-center text-sm text-muted-foreground">Not enough data yet.</p>
  const max = Math.max(...points.map((point) => point.value), 1)
  return (
    <figure className="flex flex-col gap-1">
      <div className="text-xs text-muted-foreground tabular-nums">max {format(max)}</div>
      <div className="flex h-40 items-end gap-0.5 border-b" role="img" aria-label={`${label}: ${points.map((point) => `${shortDate(point.at)} ${format(point.value)}`).join(", ")}`}>
        {points.map((point) => (
          <div key={point.at} className="min-w-0 flex-1 rounded-t-sm bg-primary/70" style={{ height: `${(point.value / max) * 100}%` }} title={`${shortDate(point.at)}: ${format(point.value)}`} />
        ))}
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{shortDate(points[0].at)}</span>
        <span>{shortDate(points.at(-1)!.at)}</span>
      </figcaption>
    </figure>
  )
}

export function FunnelBars({ funnel }: { funnel: OperateSnapshot["funnel"] }) {
  const first = funnel[0]?.count ?? 0
  return (
    <ul className="flex flex-col gap-3">
      {funnel.map((step) => {
        const share = first ? (step.count / first) * 100 : 0
        return (
          <li key={step.step} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_3rem] items-center gap-3 text-sm">
            <span className="truncate font-mono text-xs" title={step.step}>
              {step.step}
            </span>
            <span className="h-5 overflow-hidden rounded-sm bg-primary/10" title={`${formatNumber(step.count)} people`}>
              <span className="block h-full bg-primary" style={{ width: `${share}%` }} />
            </span>
            <span className="text-right tabular-nums">{Math.round(share)}%</span>
          </li>
        )
      })}
    </ul>
  )
}
