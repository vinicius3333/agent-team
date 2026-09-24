import type { HealthState, OperateSnapshot } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDateTime, formatRelative } from "@/lib/format"
import { formatNumber, hourlyUptime, latencyTone, uptimeTone, type HourStatus } from "@/lib/operate"
import { cn } from "@/lib/utils"
import { AgentSummaryCard, LineChart, ToneDot } from "./shared"
import { useOperateSnapshot } from "./use-operate"

const stateLabels: Record<HealthState, string> = { up: "Up", down: "Down", unknown: "Unknown" }

const hourClasses: Record<HourStatus, string> = {
  up: "bg-success",
  down: "bg-destructive",
  none: "bg-muted",
}

function StateCard({ snapshot }: { snapshot: OperateSnapshot }) {
  const { health } = snapshot
  const tone = health.state === "down" ? "down" : health.state === "unknown" ? "none" : uptimeTone(health)
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ToneDot tone={tone} /> {stateLabels[health.state]}
        </CardTitle>
        <CardDescription>
          {health.lastCheckAt ? `Last check ${formatRelative(health.lastCheckAt)}` : snapshot.live ? "No health check yet. The doctor probes the live URL every 5 minutes." : "The app is not deployed, so nothing is probed."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs text-muted-foreground">Uptime 7d</dt>
            <dd className="text-lg font-semibold tabular-nums">{health.uptime7d === null ? "—" : `${health.uptime7d.toFixed(2)}%`}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              p95 latency 24h <ToneDot tone={latencyTone(health)} />
            </dt>
            <dd className="text-lg font-semibold tabular-nums">{health.p95LatencyMs24h === null ? "—" : `${formatNumber(health.p95LatencyMs24h)} ms`}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

function UptimeBar({ snapshot }: { snapshot: OperateSnapshot }) {
  const cells = hourlyUptime(snapshot.checks)
  const downHours = cells.filter((cell) => cell === "down").length
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Uptime, last 7 days</CardTitle>
        <CardDescription>One cell per hour. {downHours ? `${downHours} ${downHours === 1 ? "hour" : "hours"} with a failed check.` : "No failed checks."}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="flex h-8 gap-px" role="img" aria-label={`Hourly uptime for 7 days: ${downHours} hours with a failed check`}>
          {cells.map((cell, index) => (
            <span key={index} className={cn("min-w-0 flex-1 first:rounded-l-sm last:rounded-r-sm", hourClasses[cell])} />
          ))}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>7 days ago</span>
          <span>now</span>
        </div>
      </CardContent>
    </Card>
  )
}

function LatencyCard({ snapshot }: { snapshot: OperateSnapshot }) {
  const since = Date.now() - 24 * 60 * 60_000
  const points = snapshot.checks.filter((check) => check.latencyMs !== null && Date.parse(check.at) >= since).map((check) => ({ at: check.at, value: check.latencyMs! }))
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Latency, last 24 hours</CardTitle>
        <CardDescription>Average response time of the health probe</CardDescription>
      </CardHeader>
      <CardContent>
        <LineChart points={points} label="Latency over 24 hours" format={(value) => `${formatNumber(value)} ms`} time />
      </CardContent>
    </Card>
  )
}

function FailuresCard({ snapshot }: { snapshot: OperateSnapshot }) {
  const failures = snapshot.checks.filter((check) => !check.ok).slice(-10).reverse()
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Recent failures</CardTitle>
      </CardHeader>
      <CardContent>
        {failures.length ? (
          <ul className="divide-y text-sm">
            {failures.map((check) => (
              <li key={check.at} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                <span>{formatDateTime(check.at)}</span>
                <span className="font-mono text-xs text-muted-foreground">{check.statusCode ? `HTTP ${check.statusCode}` : "no response"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No failed checks in the last 7 days.</p>
        )}
      </CardContent>
    </Card>
  )
}

export function OperateHealth() {
  const { snapshot, error, refresh } = useOperateSnapshot()
  if (!snapshot) {
    if (error) return <Card><EmptyState title="Could not load health data">{error.message}</EmptyState></Card>
    return <Skeleton className="h-64" />
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <StateCard snapshot={snapshot} />
        <UptimeBar snapshot={snapshot} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <LatencyCard snapshot={snapshot} />
        <FailuresCard snapshot={snapshot} />
      </div>
      <AgentSummaryCard agent="monitoring" title="Monitoring agent" run={snapshot.runs.monitoring} onRefresh={refresh} />
    </div>
  )
}
