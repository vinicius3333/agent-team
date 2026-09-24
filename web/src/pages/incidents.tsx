import { useEffect, useState } from "react"
import { Link, useParams } from "react-router"
import { ExternalLink, FileText, GitPullRequest } from "lucide-react"
import { api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import type { Incident, IncidentCall } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { causeLabels, IncidentStatusBadge } from "@/components/incidents/incident-status"
import { PageHeader } from "@/components/page-header"
import type { TranscriptRequest } from "@/components/project/context"
import { TranscriptSheet } from "@/components/project/transcript-sheet"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCost, formatDateTime, formatDuration, formatRelative } from "@/lib/format"

const refreshMs = 10_000

function usePolled<T>(load: () => Promise<T>, key: string) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let cancelled = false
    const refresh = () =>
      load()
        .then((result) => !cancelled && (setValue(result), setError(null)))
        .catch((reason: Error) => !cancelled && setError(reason))
    void refresh()
    const timer = setInterval(refresh, refreshMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return { value, error }
}

function ExternalLinks({ incident }: { incident: Incident }) {
  return (
    <span className="flex flex-wrap gap-3">
      {incident.prUrl && (
        <a href={incident.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          <GitPullRequest className="size-3.5" aria-hidden="true" /> Pull request
        </a>
      )}
      {incident.issueUrl && (
        <a href={incident.issueUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          <ExternalLink className="size-3.5" aria-hidden="true" /> Issue
        </a>
      )}
    </span>
  )
}

function incidentPath(incident: Incident): string {
  return `/incidents/${encodeURIComponent(incident.project)}/${encodeURIComponent(incident.id)}`
}

export function IncidentsPage() {
  const { value: incidents, error } = usePolled(api.incidents, "all")
  return (
    <>
      <PageHeader title="Incidents" description="Runs the doctor diagnosed and tried to repair. The newest come first." />
      <Card className="py-0">
        {error && !incidents ? (
          <EmptyState title="Could not load incidents">{error.message}</EmptyState>
        ) : !incidents ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </div>
        ) : !incidents.length ? (
          <EmptyState title="No incidents">When a run stops for a reason a machine can fix, the doctor opens an incident here. Start it with agent-team doctor &lt;runsDir&gt;.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cause</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Links</TableHead>
                <TableHead className="min-w-64">Diagnosis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((incident) => (
                <TableRow key={`${incident.project}/${incident.id}`}>
                  <TableCell className="align-top">
                    <Link to={incidentPath(incident)} className="font-medium hover:underline">
                      {incident.project}
                    </Link>
                    <div className="text-xs text-muted-foreground">{formatRelative(incident.createdAt)}</div>
                  </TableCell>
                  <TableCell className="align-top">
                    <IncidentStatusBadge status={incident.status} />
                  </TableCell>
                  <TableCell className="align-top">{incident.cause ? causeLabels[incident.cause] : "—"}</TableCell>
                  <TableCell className="text-right align-top tabular-nums">{incident.attempts}</TableCell>
                  <TableCell className="text-right align-top tabular-nums">{formatCost(incident.costUsd)}</TableCell>
                  <TableCell className="align-top text-sm">
                    <ExternalLinks incident={incident} />
                  </TableCell>
                  <TableCell className="max-w-md align-top text-sm whitespace-normal text-muted-foreground">
                    <span className="line-clamp-3">{incident.diagnosis ?? incident.reason.split("\n")[0]}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  )
}

function callRequest(call: IncidentCall): TranscriptRequest {
  return { file: call.transcript, subject: call.subject, role: call.role, runner: call.runner, model: call.model }
}

export function IncidentPage() {
  const { project = "", id = "" } = useParams()
  const { value: incident, error } = usePolled(() => api.incident(project, id), `${project}/${id}`)
  const [transcript, setTranscript] = useState<TranscriptRequest | null>(null)
  const { value: projectExists } = useAsync(() => api.project(project).then(() => true), [project])
  const breadcrumbs = [{ label: "Incidents", to: "/incidents" }, { label: `${project} · ${id}` }]

  if (error && !incident) {
    return (
      <>
        <PageHeader title="Incident" breadcrumbs={breadcrumbs} />
        <Card>
          <EmptyState title="Could not load this incident">{error.message}</EmptyState>
        </Card>
      </>
    )
  }
  if (!incident) return <Skeleton className="h-64" />

  return (
    <>
      <PageHeader
        title={incident.project}
        badge={<IncidentStatusBadge status={incident.status} />}
        breadcrumbs={breadcrumbs}
        description={`Opened ${formatDateTime(incident.createdAt)}. ${incident.attempts} attempts, ${formatCost(incident.costUsd)}.`}
        actions={
          projectExists && (
            <Button variant="outline" asChild>
              <Link to={`/projects/${encodeURIComponent(incident.project)}`}>Open project</Link>
            </Button>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Stop</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>
              Kind: {incident.kind}. Subject: {incident.subject ?? "unknown"}.
            </p>
            <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs break-words whitespace-pre-wrap">{incident.reason}</pre>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Diagnosis</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">Cause: {incident.cause ? causeLabels[incident.cause] : "not known yet"}</p>
            <p className="whitespace-pre-wrap">{incident.diagnosis ?? "The doctor has not answered yet."}</p>
            <ExternalLinks incident={incident} />
            {incident.branch && <p className="font-mono text-xs text-muted-foreground">Branch: {incident.branch}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Actions taken</CardTitle>
          </CardHeader>
          <CardContent>
            {incident.actions.length ? (
              <ol className="flex flex-col gap-3 text-sm">
                {incident.actions.map((action, index) => (
                  <li key={index} className="border-l-2 pl-3">
                    <p className="font-medium">
                      {action.action.replace(/_/g, " ")} <span className="text-xs font-normal text-muted-foreground">{formatDateTime(action.at)}</span>
                    </p>
                    <p className="line-clamp-6 break-words whitespace-pre-wrap text-muted-foreground">{action.detail}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">No actions yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Doctor transcripts</CardTitle>
          </CardHeader>
          <CardContent>
            {incident.calls.length ? (
              <ul className="flex flex-col gap-2 text-sm">
                {incident.calls.map((call) => (
                  <li key={call.transcript} className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{call.subject}</span>
                      <span className="text-xs text-muted-foreground">
                        {call.runner} {call.model} · {call.status} · {formatDuration(call.durationMs)} · {call.costUsd == null ? "n/a" : formatCost(call.costUsd, 3)}
                      </span>
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setTranscript(callRequest(call))}>
                      <FileText /> Transcript
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No doctor calls yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <TranscriptSheet project={incident.project} request={transcript} onClose={() => setTranscript(null)} />
    </>
  )
}
