import { useCallback, useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router"
import { ExternalLink, Loader2, Play, Radio } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { useAsync, useProjectStream } from "@/api/hooks"
import { EmptyState } from "@/components/empty-state"
import { BuildFailedIllustration } from "@/components/illustrations/build-failed"
import { OfficeTab } from "@/components/office/office-tab"
import { OperateAnalytics } from "@/components/operate/analytics"
import { OperateChanges } from "@/components/operate/changes"
import { OperateCompetitors } from "@/components/operate/competitors"
import { OperateHealth } from "@/components/operate/health"
import { OperateNextSteps } from "@/components/operate/next-steps"
import { OperateOverview } from "@/components/operate/overview"
import { PageHeader } from "@/components/page-header"
import { AttemptsTab } from "@/components/project/attempts-tab"
import { BudgetCard } from "@/components/project/budget-card"
import { ChangeMergeCard, ChangeRequestCard } from "@/components/project/changes-card"
import { ConfigTab } from "@/components/project/config-tab"
import { panelKinds, ProjectViewContext, type Panel, type ProjectView, type TranscriptRequest } from "@/components/project/context"
import { DecisionCard } from "@/components/project/decision-card"
import { DeployCard } from "@/components/project/deploy-card"
import { DetailsSheet } from "@/components/project/details-sheet"
import { DocsTab } from "@/components/project/docs-tab"
import { EventsCard } from "@/components/project/events"
import { GatePanel } from "@/components/project/gate-panel"
import { MarketingPieces } from "@/components/project/marketing-tab"
import { ChatTab } from "@/components/project/chat-tab"
import { GithubCard } from "@/components/project/github-card"
import { ImportCard } from "@/components/project/import-card"
import { IncidentBanner } from "@/components/project/incident-banner"
import { LiveAgentsCard } from "@/components/project/live-agents"
import { ProjectBranding } from "@/components/project/branding"
import { QaSection } from "@/components/project/qa-section"
import { StatCards } from "@/components/project/stat-cards"
import { StopBanner } from "@/components/project/stop-banner"
import { PipelineStepper } from "@/components/project/stepper"
import { runnerCooldown, SystemTab } from "@/components/project/system-tab"
import { TasksCard } from "@/components/project/tasks-card"
import { TranscriptSheet } from "@/components/project/transcript-sheet"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { currentPhase, findView, isPhase, legacyTabs, phaseLabels, projectPath, type ProjectPhase } from "@/lib/navigation"
import { awaitingPhase, projectStatus, projectStatusLabels, stepLabels, taskCounts } from "@/lib/pipeline"
import type { PipelineStep, ProjectDetail } from "@/api/types"

function ResumeButton({ name }: { name: string }) {
  const [busy, setBusy] = useState(false)
  const resume = async () => {
    setBusy(true)
    try {
      await api.run(name)
      toast.success("Run started")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start a run.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button onClick={resume} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Play />} Resume run
    </Button>
  )
}

function Brief({ name }: { name: string }) {
  const { value } = useAsync(() => api.file(name, "input.md"), [name])
  const text = value?.replace(/^#.*$/gm, "").trim()
  if (!text) return null
  return <span className="line-clamp-2 max-w-3xl">{text}</span>
}

function HumanNeededBanner({ detail }: { detail: ProjectDetail }) {
  const task = detail.tasks.find((entry) => entry.status === "blocked" && entry.needsHuman)
  if (!task) return null
  return <DecisionCard task={task} />
}

function ProblemBanner({ detail }: { detail: ProjectDetail }) {
  if (detail.tasks.some((entry) => entry.status === "blocked" && entry.needsHuman)) return <HumanNeededBanner detail={detail} />
  const counts = taskCounts(detail.tasks)
  const failedPhase = detail.phases.find((phase) => phase.status === "failed")
  const cooling = ["claude", "codex"].map((runner) => runnerCooldown(detail.cooldowns, runner)).filter((entry) => entry !== null)
  if (!counts.blocked && !failedPhase && !cooling.length) return null
  const title = counts.blocked ? `${counts.blocked} ${counts.blocked === 1 ? "task is" : "tasks are"} blocked` : failedPhase ? `The ${stepLabels[failedPhase.name as PipelineStep]?.toLowerCase() ?? failedPhase.name} step failed` : "A runner is cooling down"
  const text = counts.blocked
    ? "A task used all its attempts. Open it to read the last failure, then retry it."
    : failedPhase
      ? "Open the step to read the agent transcripts, then resume the run."
      : cooling.map((entry) => `${entry.runner}: ${entry.reason}`).join(". ")
  return (
    <Card className="flex-row items-center gap-4 border-destructive/30 px-4 py-3">
      <BuildFailedIllustration className="size-16 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </Card>
  )
}

function ProjectViewContent({ phase, view, detail, stream, document, selectDocument }: { phase: ProjectPhase; view: string; detail: ProjectDetail; stream: ReturnType<typeof useProjectStream>["state"]; document: string; selectDocument: (path: string) => void }) {
  const key = `${phase}/${view}`
  switch (key) {
    case "build/overview":
      return (
        <>
          <PipelineStepper />
          <ImportCard />
          <ChangeRequestCard />
          <LiveAgentsCard />
          <BudgetCard />
          <StatCards />
          <EventsCard stream={stream} />
        </>
      )
    case "build/chat":
      return <ChatTab />
    case "build/office":
      return <OfficeTab />
    case "build/docs":
      return <DocsTab path={document} onSelect={selectDocument} />
    case "build/branding":
      return (
        <Card className="p-4">
          <ProjectBranding version={detail.phases.find((entry) => entry.name === "branding")?.updatedAt ?? ""} />
        </Card>
      )
    case "build/tasks":
      return <TasksCard />
    case "build/qa":
      return (
        <Card className="p-4">
          <QaSection />
        </Card>
      )
    case "launch/overview":
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <DeployCard />
          <GithubCard />
        </div>
      )
    case "launch/marketing":
      return <MarketingPieces version={detail.phases.find((entry) => entry.name === "marketing")?.updatedAt ?? ""} />
    case "operate/overview":
      return <OperateOverview />
    case "operate/health":
      return <OperateHealth />
    case "operate/analytics":
      return <OperateAnalytics />
    case "operate/competitors":
      return <OperateCompetitors />
    case "operate/next-steps":
      return <OperateNextSteps />
    case "operate/changes":
      return <OperateChanges />
    case "system/calls":
      return <AttemptsTab />
    case "system/runtime":
      return <SystemTab />
    case "system/budget":
      return <BudgetCard />
    case "system/config":
      return <ConfigTab />
    default:
      return null
  }
}

// On Operate > Changes the selected change and task extend the breadcrumb, so each level links back up.
function drillDownCrumbs(viewPath: string, viewLabel: string, params: URLSearchParams | null): { label: string; to?: string }[] {
  const change = params?.get("change")
  if (!change) return [{ label: viewLabel }]
  const task = params?.get("task")
  return [
    { label: viewLabel, to: viewPath },
    task ? { label: change, to: `${viewPath}?change=${encodeURIComponent(change)}` } : { label: change },
    ...(task ? [{ label: task }] : []),
  ]
}

function ProjectBody({ name, phase, view, detail, stream }: { name: string; phase: ProjectPhase; view: string; detail: ProjectDetail; stream: ReturnType<typeof useProjectStream>["state"] }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const [transcript, setTranscript] = useState<TranscriptRequest | null>(null)

  // The Changes drill-down keeps its own ?task= selection, which is not the task panel.
  const drillDown = phase === "operate" && view === "changes"
  const panel = useMemo<Panel | null>(() => {
    if (drillDown) return null
    const kind = panelKinds.find((key) => searchParams.has(key))
    return kind ? { kind, id: searchParams.get(kind) ?? "" } : null
  }, [searchParams, drillDown])
  const document = searchParams.get("doc") ?? "input.md"

  const update = useCallback(
    (change: (params: URLSearchParams) => void) =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          change(next)
          return next
        },
        { replace: true },
      ),
    [setSearchParams],
  )

  const context = useMemo<ProjectView>(
    () => ({
      name,
      detail,
      openPanel: (next) =>
        update((params) => {
          panelKinds.forEach((key) => params.delete(key))
          params.set(next.kind, next.id)
        }),
      closePanel: () => update((params) => panelKinds.forEach((key) => params.delete(key))),
      openTranscript: setTranscript,
      showDocument: (path) => navigate(`${projectPath(name, "build", "docs")}?${new URLSearchParams({ doc: path })}`),
      showTab: (tab) => {
        const [targetPhase, targetView] = legacyTabs[tab] ?? ["build", "overview"]
        navigate(projectPath(name, targetPhase, targetView))
      },
    }),
    [name, detail, update, navigate],
  )

  const status = projectStatus(detail)
  const gate = awaitingPhase(detail)
  const completed = status === "done"
  const humanNeeded = detail.tasks.some((entry) => entry.status === "blocked" && entry.needsHuman)
  const badgeStatus = status === "done" ? "done" : status === "idle" ? "stopped" : status
  const viewLabel = findView(phase, view)?.label ?? view

  return (
    <ProjectViewContext.Provider value={context}>
      <PageHeader
        breadcrumbs={[
          { label: name, to: projectPath(name) },
          { label: phaseLabels[phase], to: projectPath(name, phase) },
          ...drillDownCrumbs(projectPath(name, phase, view), viewLabel, drillDown ? searchParams : null),
        ]}
        title={name}
        badge={
          <>
            <StatusBadge status={badgeStatus} label={projectStatusLabels[status]} />
            {detail.active && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                <Radio className="size-3.5 animate-pulse" aria-hidden="true" /> Live
              </span>
            )}
          </>
        }
        description={
          phase === "build" && view === "overview" ? (
            <span className="flex flex-col gap-1">
              <Brief name={name} />
              {detail.current && <span className="text-sm">Now working on {detail.current}</span>}
            </span>
          ) : undefined
        }
        actions={
          <>
            {detail.deploy?.url && (
              <Button variant="outline" asChild>
                <a href={detail.deploy.url} target="_blank" rel="noopener noreferrer" title={detail.deploy.url}>
                  <span className={detail.deploy.status === "live" ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-warning"} aria-hidden="true" />
                  Open live preview <ExternalLink />
                </a>
              </Button>
            )}
            {!detail.active && !completed && !gate && detail.stop?.kind !== "budget" && <ResumeButton name={name} />}
          </>
        }
      />
      <div className="flex min-w-0 flex-col gap-4">
        {gate && <GatePanel phase={gate} />}
        <ChangeMergeCard />
        <IncidentBanner />
        {!gate && !humanNeeded && <StopBanner />}
        <ProblemBanner detail={detail} />
        <ProjectViewContent phase={phase} view={view} detail={detail} stream={stream} document={document} selectDocument={(path) => update((params) => params.set("doc", path))} />
      </div>
      <DetailsSheet panel={panel} />
      <TranscriptSheet project={name} request={transcript} onClose={() => setTranscript(null)} />
    </ProjectViewContext.Provider>
  )
}

export function ProjectPage() {
  const { name = "", phase, view } = useParams()
  const [searchParams] = useSearchParams()
  const { detail, state, missing } = useProjectStream(name)

  const legacyTab = searchParams.get("tab")
  if (legacyTab !== null) {
    const [targetPhase, targetView] = legacyTabs[legacyTab] ?? ["build", "overview"]
    const params = new URLSearchParams(searchParams)
    params.delete("tab")
    const query = params.toString()
    return <Navigate replace to={`${projectPath(name, targetPhase, targetView)}${query ? `?${query}` : ""}`} />
  }
  if (phase !== undefined && !isPhase(phase)) return <Navigate replace to={projectPath(name)} />
  if (phase === "build" && view === "lead") return <Navigate replace to={`${projectPath(name, "build", "chat")}${searchParams.size ? `?${searchParams}` : ""}`} />
  if (isPhase(phase) && !findView(phase, view)) return <Navigate replace to={`${projectPath(name, phase)}${searchParams.size ? `?${searchParams}` : ""}`} />

  if (missing) {
    return (
      <Card>
        <EmptyState title={`No project named ${name}`}>
          <Button asChild variant="outline" className="mt-3">
            <Link to="/">Back to projects</Link>
          </Button>
        </EmptyState>
      </Card>
    )
  }
  if (!detail) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={`Loading ${name}`}>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    )
  }
  if (!isPhase(phase) || !view) {
    const target = currentPhase({ ...detail, deployed: detail.deploy?.status === "live" })
    return <Navigate replace to={`${projectPath(name, target)}${searchParams.size ? `?${searchParams}` : ""}`} />
  }
  return <ProjectBody name={name} phase={phase} view={view} detail={detail} stream={state} />
}
