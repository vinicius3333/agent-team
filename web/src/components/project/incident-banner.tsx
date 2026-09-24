import { Link } from "react-router"
import { ExternalLink, Stethoscope } from "lucide-react"
import { IncidentStatusBadge } from "@/components/incidents/incident-status"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { formatRelative } from "@/lib/format"
import { useProjectView } from "./context"

// Shown while the doctor works on an incident in this project.
export function IncidentBanner() {
  const { name, detail } = useProjectView()
  const incident = detail.incident
  if (!incident) return null
  return (
    <Card role="status" className="flex-col items-start gap-3 border-primary/40 px-4 py-3 sm:flex-row sm:items-center">
      <Stethoscope className="size-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          The doctor is looking at this stop
          <IncidentStatusBadge status={incident.status} />
          <span className="text-xs font-normal text-muted-foreground">
            opened {formatRelative(incident.createdAt)}, {incident.attempts} {incident.attempts === 1 ? "attempt" : "attempts"} so far
          </span>
        </p>
        <p className="mt-1 line-clamp-2 text-sm break-words text-muted-foreground">{incident.reason}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        {incident.issueUrl && (
          <Button variant="outline" asChild>
            <a href={incident.issueUrl} target="_blank" rel="noopener noreferrer">
              Issue <ExternalLink />
            </a>
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to={`/incidents/${encodeURIComponent(name)}/${encodeURIComponent(incident.id)}`}>View incident</Link>
        </Button>
      </div>
    </Card>
  )
}
