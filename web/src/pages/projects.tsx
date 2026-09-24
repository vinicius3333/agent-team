import { Link } from "react-router"
import { Activity, CircleDollarSign, ExternalLink, ListChecks, Plus, ServerCrash } from "lucide-react"
import { useProjectList } from "@/api/projects-context"
import type { ProjectSummary } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { EmptyProjectsIllustration } from "@/components/illustrations/empty-projects"
import { PageHeader } from "@/components/page-header"
import { StatusBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { formatProjectCost, formatRelative } from "@/lib/format"
import { projectStatus, projectStatusLabels } from "@/lib/pipeline"

function ProjectCard({ project }: { project: ProjectSummary }) {
  const status = projectStatus(project)
  const total = Object.values(project.counts).reduce((sum, count) => sum + (count ?? 0), 0)
  const merged = project.counts.merged ?? 0
  const badgeStatus = status === "done" ? "done" : status === "idle" ? "stopped" : status
  return (
    <Card className="relative min-w-0 gap-3 py-4 transition hover:border-primary/40 hover:shadow-sm">
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={`/projects/${encodeURIComponent(project.name)}`}
            className="min-w-0 font-semibold break-all after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
          >
            {project.name}
          </Link>
          <StatusBadge status={badgeStatus} label={projectStatusLabels[status]} />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{project.current ? `Now: ${project.current}` : (project.lastEvent?.message ?? "No activity yet")}</span>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <ListChecks className="size-3.5" aria-hidden="true" /> Tasks
            </span>
            <span className="tabular-nums">{total ? `${merged} / ${total}` : "no plan yet"}</span>
          </div>
          <Progress value={total ? (merged / total) * 100 : 0} aria-label={`${merged} of ${total} tasks merged`} />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-3">
            <span>Last activity {formatRelative(project.lastEvent?.at)}</span>
            <span className="flex items-center gap-1 tabular-nums" title="Claude reports cost. Codex does not.">
              <CircleDollarSign className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Cost</span>
              {formatProjectCost(project.costUsd, project.costUnreported)}
            </span>
          </span>
          {project.live && project.liveUrl && (
            <a href={project.liveUrl} target="_blank" rel="noopener noreferrer" className="relative z-10 inline-flex items-center gap-1 rounded-md bg-success/10 px-2 py-0.5 font-medium text-success hover:bg-success/20">
              Live <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function ProjectsPage() {
  const { projects, online } = useProjectList()
  return (
    <>
      <PageHeader
        title="Projects"
        description="Every build your agent team runs on this server."
        actions={
          <Button asChild>
            <Link to="/new">
              <Plus /> New project
            </Link>
          </Button>
        }
      />
      {!online && (
        <Alert variant="destructive" className="mb-4">
          <ServerCrash />
          <AlertTitle>The server does not answer</AlertTitle>
          <AlertDescription>Check that agent-team ui is running. This page retries every 5 seconds.</AlertDescription>
        </Alert>
      )}
      {projects === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <EmptyState illustration={<EmptyProjectsIllustration />} title="No projects yet">
            <p>Describe an idea and your agent team plans, designs, and builds it.</p>
            <Button asChild className="mt-4">
              <Link to="/new">
                <Plus /> Start your first project
              </Link>
            </Button>
          </EmptyState>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.name} project={project} />
          ))}
        </div>
      )}
    </>
  )
}
