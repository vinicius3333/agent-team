import { ChartColumn } from "lucide-react"
import type { OperateSnapshot } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/operate"
import { AgentSummaryCard, BarChart, ConfigLink, FunnelBars, LineChart } from "./shared"
import { useOperateSnapshot } from "./use-operate"

const configExample = `operate:
  posthog:
    host: https://us.posthog.com
    projectId: "12345"
    publicKey: phc_xxx
    apiKeyEnv: POSTHOG_API_KEY`

function NoPosthog() {
  return (
    <Card>
      <EmptyState illustration={<ChartColumn className="size-8 text-muted-foreground" aria-hidden="true" />} title="PostHog is not set up">
        <p>
          Add an <code className="font-mono">operate.posthog</code> block to <code className="font-mono">pipeline.yaml</code>. The app sends events with the public key, and the analytics agent reads them with the personal API key from the named env var.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-left font-mono text-xs">{configExample}</pre>
        <p className="mt-3">
          See <ConfigLink>System → Config</ConfigLink>.
        </p>
      </EmptyState>
    </Card>
  )
}

function FunnelCard({ funnel }: { funnel: OperateSnapshot["funnel"] }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Signup funnel</CardTitle>
        <CardDescription>Distinct people per step over 30 days</CardDescription>
      </CardHeader>
      <CardContent>
        {funnel.length ? (
          <FunnelBars funnel={funnel} />
        ) : (
          <p className="text-sm text-muted-foreground">No funnel data yet.</p>
        )}
      </CardContent>
    </Card>
  )
}

function TopEventsCard({ events }: { events: OperateSnapshot["topEvents"] }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Top events</CardTitle>
        <CardDescription>Custom events, 30-day totals</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length ? (
          <ul className="divide-y text-sm">
            {[...events].sort((a, b) => b.count - a.count).map((event) => (
              <li key={event.event} className="flex items-center justify-between gap-4 py-2">
                <span className="min-w-0 truncate font-mono text-xs" title={event.event}>
                  {event.event}
                </span>
                <span className="tabular-nums">{formatNumber(event.count)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No custom events yet.</p>
        )}
      </CardContent>
    </Card>
  )
}

export function OperateAnalytics() {
  const { snapshot, error, refresh } = useOperateSnapshot()
  if (!snapshot) {
    if (error) return <Card><EmptyState title="Could not load analytics">{error.message}</EmptyState></Card>
    return <Skeleton className="h-64" />
  }
  if (!snapshot.config.posthog) return <NoPosthog />
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Weekly active users</CardTitle>
          </CardHeader>
          <CardContent>
            <LineChart points={snapshot.series.wau} label="Weekly active users" format={formatNumber} />
          </CardContent>
        </Card>
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Pageviews per day</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart points={snapshot.series.pageviews} label="Pageviews per day" format={formatNumber} />
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <FunnelCard funnel={snapshot.funnel} />
        <TopEventsCard events={snapshot.topEvents} />
      </div>
      <AgentSummaryCard agent="analytics" title="Analytics agent" run={snapshot.runs.analytics} onRefresh={refresh} />
    </div>
  )
}
