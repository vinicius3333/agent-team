import { useCallback, useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { ExternalLink, Loader2, Play, Radio } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { useAsync, useProjectStream } from "@/api/hooks"
import { EmptyState } from "@/components/empty-state"
import { BuildFailedIllustration } from "@/components/illustrations/build-failed"
import { PageHeader } from "@/components/page-header"
import { AttemptsTab } from "@/components/project/attempts-tab"
import { ConfigTab } from "@/components/project/config-tab"
import { panelKinds, ProjectViewContext, type Panel, type ProjectView, type TranscriptRequest } from "@/components/project/context"
import { DeployCard } from "@/components/project/deploy-card"
import { DetailsSheet } from "@/components/project/details-sheet"
import { DocsTab } from "@/components/project/docs-tab"
import { EventsCard } from "@/components/project/events"
import { GatePanel } from "@/components/project/gate-panel"
import { GithubCard } from "@/components/project/github-card"
import { ProjectBranding } from "@/components/project/branding"
import { StatCards } from "@/components/project/stat-cards"
import { PipelineStepper } from "@/components/project/stepper"
import { RunnerHealthCard, runnerCooldown } from "@/components/project/system-tab"
import { SystemTab } from "@/components/project/system-tab"
import { TasksCard } from "@/components/project/tasks-card"
import { TranscriptSheet } from "@/components/project/transcript-sheet"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { awaitingPhase, projectStatus, projectStatusLabels, stepLabels, taskCounts } from "@/lib/pipeline"
import type { PipelineStep, ProjectDetail } from "@/api/types"

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "docs", label: "Docs" },
  { id: "branding", label: "Branding" },
  { id: "attempts", label: "Agent calls" },
  { id: "system", label: "System" },
  { id: "config", label: "Config" },
] as const

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

function ProblemBanner({ detail }: { detail: ProjectDetail }) {
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

function ProjectBody({ name, detail, stream }: { name: string; detail: ProjectDetail; stream: ReturnType<typeof useProjectStream>["state"] }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [transcript, setTranscript] = useState<TranscriptRequest | null>(null)

  const panel = useMemo<Panel | null>(() => {
    const kind = panelKinds.find((key) => searchParams.has(key))
    return kind ? { kind, id: searchParams.get(kind) ?? "" } : null
  }, [searchParams])
  const tab = searchParams.get("tab") ?? "overview"
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

  const view = useMemo<ProjectView>(
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
      showDocument: (path) =>
        update((params) => {
          panelKinds.forEach((key) => params.delete(key))
          params.set("tab", "docs")
          params.set("doc", path)
        }),
      showTab: (next) =>
        update((params) => {
          panelKinds.forEach((key) => params.delete(key))
          params.set("tab", next)
        }),
    }),
    [name, detail, update],
  )

  const status = projectStatus(detail)
  const gate = awaitingPhase(detail)
  const completed = status === "done"
  const badgeStatus = status === "done" ? "done" : status === "idle" ? "stopped" : status

  return (
    <ProjectViewContext.Provider value={view}>
      <PageHeader
        breadcrumbs={[{ label: "Projects", to: "/" }, { label: name }]}
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
          <span className="flex flex-col gap-1">
            <Brief name={name} />
            {detail.current && <span className="text-sm">Now working on {detail.current}</span>}
          </span>
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
            {!detail.active && !completed && !gate && <ResumeButton name={name} />}
          </>
        }
      />
      <div className="flex flex-col gap-4">
        <PipelineStepper />
        {gate && <GatePanel phase={gate} />}
        <ProblemBanner detail={detail} />
        <StatCards />
        <Tabs value={tab} onValueChange={(next) => update((params) => params.set("tab", next))}>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList>
              {tabs.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="overview" className="mt-2 flex flex-col gap-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <TasksCard />
              <EventsCard stream={stream} />
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <DeployCard />
              <GithubCard />
              <RunnerHealthCard />
            </div>
          </TabsContent>
          <TabsContent value="docs" className="mt-2">
            <DocsTab path={document} onSelect={(path) => update((params) => params.set("doc", path))} />
          </TabsContent>
          <TabsContent value="branding" className="mt-2">
            <Card className="p-4">
              <ProjectBranding version={detail.phases.find((phase) => phase.name === "branding")?.updatedAt ?? ""} />
            </Card>
          </TabsContent>
          <TabsContent value="attempts" className="mt-2">
            <AttemptsTab />
          </TabsContent>
          <TabsContent value="system" className="mt-2">
            <SystemTab />
          </TabsContent>
          <TabsContent value="config" className="mt-2">
            <ConfigTab />
          </TabsContent>
        </Tabs>
      </div>
      <DetailsSheet panel={panel} />
      <TranscriptSheet project={name} request={transcript} onClose={() => setTranscript(null)} />
    </ProjectViewContext.Provider>
  )
}

export function ProjectPage() {
  const { name = "" } = useParams()
  const { detail, state, missing } = useProjectStream(name)

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
  return <ProjectBody name={name} detail={detail} stream={state} />
}
