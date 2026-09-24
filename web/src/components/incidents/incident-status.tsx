import type { IncidentStatus } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const labels: Record<IncidentStatus, string> = {
  open: "Open",
  diagnosing: "Diagnosing",
  fixed: "Fixed",
  gave_up: "Gave up",
}

const styles: Record<IncidentStatus, string> = {
  open: "border-warning/40 bg-warning/10 text-warning",
  diagnosing: "border-primary/40 bg-primary/10 text-primary",
  fixed: "border-success/40 bg-success/10 text-success",
  gave_up: "border-destructive/40 bg-destructive/10 text-destructive",
}

export const causeLabels: Record<string, string> = {
  agent_team_bug: "agent-team bug",
  project_state: "Project state",
  external: "External",
  unknown: "Unknown",
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <Badge variant="outline" className={cn(styles[status])}>
      {labels[status]}
    </Badge>
  )
}
