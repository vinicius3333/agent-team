import { ExternalLink } from "lucide-react"
import { Link } from "react-router"
import { EmptyState } from "@/components/empty-state"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectView } from "@/components/project/context"
import { projectPath } from "@/lib/navigation"
import { rankFindings } from "@/lib/operate"
import { AgentSummaryCard, ConfigLink, SeverityBadge } from "./shared"
import { useFindings, useOperateSnapshot } from "./use-operate"

export function OperateCompetitors() {
  const { name } = useProjectView()
  const { snapshot, error, refresh } = useOperateSnapshot()
  const { findings } = useFindings()
  if (!snapshot) {
    if (error) return <Card><EmptyState title="Could not load research">{error.message}</EmptyState></Card>
    return <Skeleton className="h-64" />
  }
  const research = rankFindings((findings ?? []).filter((finding) => finding.source === "research"))
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Competitors</CardTitle>
            <CardDescription>From operate.competitors in pipeline.yaml</CardDescription>
          </CardHeader>
          <CardContent>
            {snapshot.config.competitors.length ? (
              <ul className="divide-y text-sm">
                {snapshot.config.competitors.map((url) => (
                  <li key={url}>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="flex min-h-10 items-center gap-2 py-2 break-all text-primary hover:underline">
                      {url.replace(/^https?:\/\//, "")} <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No competitors listed. The researcher searches the web from the spec. To name some, add <code className="font-mono">operate.competitors</code>; see <ConfigLink>System → Config</ConfigLink>.
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>Research findings</CardTitle>
          </CardHeader>
          <CardContent>
            {research.length ? (
              <ul className="divide-y">
                {research.map((finding) => (
                  <li key={finding.id}>
                    <Link to={`${projectPath(name, "operate", "next-steps")}?finding=${finding.id}`} className="flex min-h-10 items-start gap-3 rounded-md py-3 hover:bg-muted/60">
                      <SeverityBadge severity={finding.severity} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{finding.title}</span>
                        <span className="line-clamp-2 text-xs text-muted-foreground">{finding.evidence}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No open research findings.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <AgentSummaryCard agent="research" title="Research agent" run={snapshot.runs.research} onRefresh={refresh} markdown />
    </div>
  )
}
