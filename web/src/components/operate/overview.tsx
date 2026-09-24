import type { ReactNode } from "react"
import { Link } from "react-router"
import { ChevronRight, Clock, Loader2, UserPlus, Users, Zap, type LucideIcon } from "lucide-react"
import type { Finding, OperateSnapshot } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectView } from "@/components/project/context"
import { formatRelative } from "@/lib/format"
import { projectPath } from "@/lib/navigation"
import { formatNumber, latencyTone, percentDelta, pointDelta, rankFindings, sourceLabels, trendTone, uptimeTone, type MetricTone } from "@/lib/operate"
import { cn } from "@/lib/utils"
import { ConfigLink, SeverityBadge, Sparkline, ToneDot, useFindingActions } from "./shared"
import { useFindings, useOperateSnapshot } from "./use-operate"

function StatCard({ icon: Icon, label, value, tone, delta, chart, empty }: { icon: LucideIcon; label: string; value: string | null; tone: MetricTone; delta?: string | null; chart?: ReactNode; empty: ReactNode }) {
  const worse = tone === "worse" || tone === "down"
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" /> {label}
        </span>
        {value === null ? (
          <span className="text-sm text-muted-foreground">
            No data yet. <span className="block">{empty}</span>
          </span>
        ) : (
          <>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ToneDot tone={tone} />
              <span className="text-2xl font-semibold tabular-nums">{value}</span>
              {delta && <span className={cn("text-sm font-medium tabular-nums", worse ? "text-warning" : "text-success")}>{delta}</span>}
            </span>
            {chart}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function StatCards({ snapshot }: { snapshot: OperateSnapshot }) {
  const { health, metrics, series, config } = snapshot
  const posthogHint = config.posthog ? "The analytics agent has not stored numbers yet." : <ConfigLink>Set up PostHog</ConfigLink>
  const healthHint = snapshot.live ? "The first health probe runs within 5 minutes." : "The app is not deployed yet."
  const wau = metrics.wau
  const conversion = metrics.signup_conversion
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard icon={Clock} label="Uptime 7d" value={health.uptime7d === null ? null : `${health.uptime7d.toFixed(2)}%`} tone={uptimeTone(health)} empty={healthHint} />
      <StatCard icon={Zap} label="p95 latency" value={health.p95LatencyMs24h === null ? null : `${formatNumber(health.p95LatencyMs24h)} ms`} tone={latencyTone(health)} empty={healthHint} />
      <StatCard icon={Users} label="Weekly active users" value={wau ? formatNumber(wau.value) : null} tone={trendTone(wau)} delta={percentDelta(wau)} chart={<Sparkline points={series.wau} />} empty={posthogHint} />
      <StatCard icon={UserPlus} label="Signup conversion" value={conversion ? `${conversion.value.toFixed(1)}%` : null} tone={trendTone(conversion)} delta={pointDelta(conversion)} empty={posthogHint} />
    </div>
  )
}

function OpenFindingsCard({ findings }: { findings: Finding[] }) {
  const { name } = useProjectView()
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Open findings</CardTitle>
      </CardHeader>
      <CardContent className="px-2 sm:px-4">
        {findings.length ? (
          <ul className="divide-y">
            {findings.slice(0, 5).map((finding) => (
              <li key={finding.id}>
                <Link
                  to={`${projectPath(name, "operate", "next-steps")}?finding=${finding.id}`}
                  className="flex min-h-10 items-center gap-3 rounded-md px-2 py-3 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <SeverityBadge severity={finding.severity} />
                  <span className="hidden w-24 shrink-0 text-sm text-muted-foreground sm:block">{sourceLabels[finding.source]}</span>
                  <span className="min-w-0 flex-1 text-sm">{finding.title}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No open findings">The agents write findings here after each run.</EmptyState>
        )}
      </CardContent>
    </Card>
  )
}

function NextStepsCard({ findings, onChange }: { findings: Finding[]; onChange: () => void }) {
  const { detail } = useProjectView()
  const { approve, busy } = useFindingActions(onChange)
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Suggested next steps</CardTitle>
        <CardDescription>The top open findings</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {findings.length ? (
          <ol className="divide-y">
            {findings.slice(0, 3).map((finding, index) => (
              <li key={finding.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium tabular-nums">{index + 1}</span>
                <span className="min-w-0 flex-1 text-sm">{finding.title}</span>
                <Button variant="link" className="h-10 px-2 md:h-9" disabled={busy !== null || detail.active} onClick={() => approve(finding)}>
                  {busy === finding.id && <Loader2 className="animate-spin" />} Create change
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState title="Nothing to suggest">Next steps come from open findings.</EmptyState>
        )}
        <p className="mt-auto pt-4 text-xs text-muted-foreground">Agents suggest. You approve.</p>
      </CardContent>
    </Card>
  )
}

export function OperateOverview() {
  const { snapshot, error, refresh } = useOperateSnapshot()
  const { findings, refresh: refreshFindings } = useFindings()
  if (!snapshot) {
    if (error) return <Card><EmptyState title="Could not load Operate data">{error.message}</EmptyState></Card>
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-32" />)}
      </div>
    )
  }
  const ranked = rankFindings(findings ?? [])
  const onChange = () => {
    void refresh()
    void refreshFindings()
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">How it is running</h2>
        <p className="text-sm text-muted-foreground">
          {snapshot.health.lastCheckAt ? `Last check ${formatRelative(snapshot.health.lastCheckAt)}` : "No health check yet"}
          {!snapshot.enabled && " · Operate agents are off in pipeline.yaml"}
        </p>
      </div>
      <StatCards snapshot={snapshot} />
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <OpenFindingsCard findings={ranked} />
        <NextStepsCard findings={ranked} onChange={onChange} />
      </div>
    </div>
  )
}
