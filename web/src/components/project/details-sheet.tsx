import type { ReactNode } from "react"
import { ExternalLink, FileText, Terminal } from "lucide-react"
import type { Attempt, PipelineStep, ProjectDetail, PullRequest, RoleConfig } from "@/api/types"
import { pipelineSteps } from "@/api/types"
import { CopyButton } from "@/components/copy-button"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { formatClock, formatCost, formatDateTime, formatDuration } from "@/lib/format"
import { attemptNumber, deployState, describeCandidate, maxRetries, phaseDocuments, phaseOutputs, phaseRoles, skippedPhases, stepLabels, taskCounts } from "@/lib/pipeline"
import { useProjectView, type Panel, type TranscriptRequest } from "./context"
import { DocumentView } from "./document-view"
import { EventList, EventType } from "./events"
import { RetryButton } from "./tasks-card"
import { runnerCooldown } from "./system-tab"
import { transcriptRequest } from "./attempts-tab"

interface PanelContent {
  title: string
  subtitle: string
  body: ReactNode
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== "")
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {visible.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Paths({ list }: { list: string[] }) {
  if (!list.length) return <span className="text-muted-foreground">none</span>
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((path) => (
        <code key={path} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
          {path}
        </code>
      ))}
    </div>
  )
}

function Candidate({ role }: { role: RoleConfig | undefined }) {
  return <span className="font-mono text-xs">{describeCandidate(role)}</span>
}

function CallButton({ attempt, label }: { attempt: Attempt; label: string }) {
  const { openTranscript } = useProjectView()
  return <CallRow label={label} sub={`${attempt.runner} ${attempt.model}`} status={attempt.status} detail={[formatDuration(attempt.durationMs), attempt.failureClass, attempt.costUsd ? formatCost(attempt.costUsd, 3) : null, formatClock(attempt.createdAt)].filter(Boolean).join(" · ")} onClick={() => openTranscript(transcriptRequest(attempt))} />
}

function CommandButton({ file, subject, label }: { file: string; subject: string; label: string }) {
  const { openTranscript } = useProjectView()
  const request: TranscriptRequest = { file, subject, role: label, runner: "host", model: "sh" }
  return <CallRow label={label} sub={file} icon={<Terminal className="size-3.5" aria-hidden="true" />} onClick={() => openTranscript(request)} />
}

function CallRow({ label, sub, status, detail, icon, onClick }: { label: string; sub: string; status?: string; detail?: string; icon?: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" aria-label={`Open transcript: ${label}, ${sub}`}>
      <span className="flex items-center gap-2">
        {icon}
        <span className="font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{sub}</span>
        {status && <StatusBadge status={status} />}
      </span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </button>
  )
}

function pullRequestFor(detail: ProjectDetail, prefix: string): PullRequest | null {
  return detail.github?.pullRequests.find((pr) => pr.title.startsWith(prefix)) ?? null
}

function GithubLinks({ detail, issueNumber, pr }: { detail: ProjectDetail; issueNumber: number | null; pr: PullRequest | null }) {
  const repo = detail.github?.repoUrl
  if (!(repo && issueNumber) && !pr) return null
  return (
    <Section title="GitHub">
      <div className="flex flex-wrap gap-2">
        {repo && issueNumber && (
          <Button variant="outline" size="sm" asChild>
            <a href={`${repo}/issues/${issueNumber}`} target="_blank" rel="noopener noreferrer">
              Issue #{issueNumber} <ExternalLink />
            </a>
          </Button>
        )}
        {pr && (
          <Button variant="outline" size="sm" asChild>
            <a href={pr.url} target="_blank" rel="noopener noreferrer">
              PR #{pr.number} · {pr.state.toLowerCase()} <ExternalLink />
            </a>
          </Button>
        )}
      </div>
    </Section>
  )
}

function LiveUrl({ url }: { url: string | null | undefined }) {
  if (!url) return <span className="text-muted-foreground">none</span>
  return (
    <span className="flex items-center gap-1">
      <a href={url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-mono text-xs text-primary hover:underline">
        {url}
      </a>
      <CopyButton value={url} label="Copy URL" />
    </span>
  )
}

function TaskLink({ id }: { id: string }) {
  const { openPanel } = useProjectView()
  return (
    <button type="button" className="font-mono text-xs text-primary hover:underline" onClick={() => openPanel({ kind: "task", id })}>
      {id}
    </button>
  )
}

function taskPanel(detail: ProjectDetail, id: string): PanelContent {
  const task = detail.tasks.find((entry) => entry.id === id)
  if (!task) return { title: id, subtitle: "Task not found", body: <p className="text-sm text-muted-foreground">This task is not in the current plan.</p> }
  const calls = detail.attempts.filter((attempt) => attempt.subject.startsWith(`${id}-`)).slice().reverse()
  const numbers = [...new Set(calls.map((attempt) => attemptNumber(attempt.subject)))].sort((a, b) => a - b)
  const pattern = new RegExp(`\\b${id}\\b`)
  const related = detail.events.filter((event) => pattern.test(event.message))
  const merged = task.status === "merged"
  return {
    title: `${task.id} · ${task.title}`,
    subtitle: `${task.phase ?? "task"}${task.story ? ` · ${task.story}` : ""}`,
    body: (
      <>
        <Facts
          rows={[
            ["Status", <StatusBadge status={task.status} />],
            ["Phase", task.phase ?? "—"],
            ["Story", task.story ?? ""],
            ["Attempts", `${task.attempts} / ${maxRetries(detail)}`],
            [
              "Depends on",
              task.dependsOn.length ? (
                <span className="flex flex-wrap gap-2">
                  {task.dependsOn.map((dependency) => (
                    <TaskLink key={dependency} id={dependency} />
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">nothing</span>
              ),
            ],
            ["Worker", <Candidate role={detail.config?.roles.worker} />],
            ["Reviewer", <Candidate role={detail.config?.roles.reviewer} />],
          ]}
        />
        {task.status === "blocked" && (
          <div>
            <RetryButton task={task} size="default" />
          </div>
        )}
        <GithubLinks detail={detail} issueNumber={task.issueNumber} pr={pullRequestFor(detail, `feat(${id})`)} />
        {task.acceptance.length > 0 && (
          <Section title="Acceptance criteria">
            <ul className="flex flex-col gap-1.5 text-sm">
              {task.acceptance.map((criterion) => (
                <li key={criterion} className="flex gap-2">
                  <span aria-hidden="true" className={merged ? "text-success" : "text-muted-foreground"}>
                    {merged ? "✓" : "○"}
                  </span>
                  <span>{criterion}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {task.verify && (
          <Section title="Verify">
            <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1">
              <code className="min-w-0 flex-1 font-mono text-xs break-all">{task.verify}</code>
              <CopyButton value={task.verify} label="Copy command" />
            </div>
          </Section>
        )}
        <Section title="Scope">
          <Facts
            rows={[
              ["Allowed paths", <Paths list={task.allowedPaths} />],
              ["Reads", <Paths list={task.readPaths} />],
            ]}
          />
        </Section>
        {task.lastFailure && (
          <Section title="Last failure">
            <details open={task.status === "blocked"} className="rounded-md border border-destructive/30 bg-destructive/5">
              <summary className="cursor-pointer px-3 py-2 text-sm">{task.lastFailure.split("\n")[0].slice(0, 120)}</summary>
              <pre className="max-h-80 overflow-auto border-t border-destructive/20 px-3 py-2 font-mono text-xs whitespace-pre-wrap">{task.lastFailure}</pre>
            </details>
          </Section>
        )}
        <Section title="Agent calls">
          {numbers.length ? (
            <div className="flex flex-col gap-2">
              {numbers.map((number) => {
                const group = calls.filter((attempt) => attempt.subject.endsWith(`-${number}`))
                const workers = group.filter((attempt) => attempt.role === "worker")
                const reviews = group.filter((attempt) => attempt.role === "reviewer")
                return (
                  <div key={number} className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Attempt {number}</p>
                    <CommandButton file={`${id}-${number}-setup.log`} subject={`${id}-${number}`} label="setup" />
                    {workers.map((attempt) => (
                      <CallButton key={attempt.id} attempt={attempt} label="worker" />
                    ))}
                    {workers.some((attempt) => attempt.status === "done") && <CommandButton file={`${id}-${number}-verify.log`} subject={`${id}-${number}`} label="verify" />}
                    {reviews.map((attempt) => (
                      <CallButton key={attempt.id} attempt={attempt} label="review" />
                    ))}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No agent calls yet.</p>
          )}
        </Section>
        <Section title="Related activity">
          <EventList events={related.slice(-40)} />
        </Section>
      </>
    ),
  }
}

function deployPanel(detail: ProjectDetail): PanelContent {
  const deploy = detail.deploy
  const state = deployState(detail)
  const events = detail.events.filter((event) => event.type === "deploy")
  return {
    title: "Deploy",
    subtitle: state.note || state.status,
    body: (
      <>
        {deploy?.url && (
          <Button asChild>
            <a href={deploy.url} target="_blank" rel="noopener noreferrer">
              Open live preview <ExternalLink />
            </a>
          </Button>
        )}
        <Facts
          rows={[
            ["Status", <StatusBadge status={deploy?.status === "live" ? "live" : state.status} label={state.note || undefined} />],
            ["URL", <LiveUrl url={deploy?.url} />],
            ["App container", deploy ? <span className="font-mono text-xs">{deploy.appContainer} · {deploy.app}</span> : ""],
            ["Tunnel", deploy ? <span className="font-mono text-xs">{deploy.tunnelContainer} · {deploy.tunnel}</span> : ""],
          ]}
        />
        <p className="text-xs text-muted-foreground">
          Quick tunnel URLs change when the tunnel container restarts. Redeploy with <code className="font-mono">agent-team deploy &lt;projectDir&gt;</code>.
        </p>
        <Section title="Deploy events">
          <EventList events={events.slice(-40)} />
        </Section>
      </>
    ),
  }
}

function buildPanel(detail: ProjectDetail, openPanel: (panel: Panel) => void): PanelContent {
  const counts = taskCounts(detail.tasks)
  return {
    title: "Build",
    subtitle: `${counts.merged}/${detail.tasks.length} tasks merged`,
    body: (
      <>
        <Facts
          rows={[
            ["Pending", counts.pending],
            ["Running", counts.running],
            ["Merged", counts.merged],
            ["Blocked", counts.blocked],
            ["Worker", <Candidate role={detail.config?.roles.worker} />],
            ["Reviewer", <Candidate role={detail.config?.roles.reviewer} />],
            ["Max attempts", maxRetries(detail)],
            ["Live preview", <LiveUrl url={detail.deploy?.url} />],
          ]}
        />
        <Section title="Tasks">
          {detail.tasks.length ? (
            <div className="flex flex-col gap-1.5">
              {detail.tasks.map((task) => (
                <button key={task.id} type="button" onClick={() => openPanel({ kind: "task", id: task.id })} className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
                  <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <StatusBadge status={task.status} />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No plan yet.</p>
          )}
        </Section>
      </>
    ),
  }
}

function phasePanel(detail: ProjectDetail, phase: string, view: ReturnType<typeof useProjectView>): PanelContent {
  if (phase === "deploy") return deployPanel(detail)
  if (phase === "build") return buildPanel(detail, view.openPanel)
  const role = phaseRoles[phase] ?? phase
  const row = detail.phases.find((entry) => entry.name === phase)
  const status = skippedPhases(detail).has(phase) ? "skipped" : (row?.status ?? "pending")
  const calls = detail.attempts.filter((attempt) => attempt.subject.startsWith(`phase-${phase}-`)).slice().reverse()
  const related = detail.events.filter((event) => new RegExp(`\\b${phase}\\b`).test(event.message) && ["phase", "gate", "github"].includes(event.type))
  const documents = phaseDocuments[phase] ?? []
  const feedback = detail.feedback?.[phase]
  return {
    title: stepLabels[phase as PipelineStep] ?? phase,
    subtitle: `${role} agent`,
    body: (
      <>
        <Facts
          rows={[
            ["Status", <StatusBadge status={status} />],
            ["Role", role],
            ["Model", <Candidate role={detail.config?.roles[role]} />],
            ["Gate", detail.config?.gates.includes(phase as never) ? "human approval required" : "none"],
            ["Updated", row?.updatedAt ? formatDateTime(row.updatedAt) : ""],
          ]}
        />
        {feedback && (
          <Section title="Pending feedback">
            <pre className="rounded-md border bg-muted/40 p-3 font-sans text-sm whitespace-pre-wrap">{feedback}</pre>
          </Section>
        )}
        <Section title="Outputs">
          <Paths list={phaseOutputs[phase] ?? []} />
          <div className="flex flex-wrap gap-2">
            {documents.map((path) => (
              <Button key={path} variant="outline" size="sm" onClick={() => view.showDocument(path)}>
                <FileText /> Open {path}
              </Button>
            ))}
            {(phase === "branding" || phase === "design") && (
              <Button variant="outline" size="sm" onClick={() => view.showTab("branding")}>
                Open branding gallery
              </Button>
            )}
          </div>
        </Section>
        <GithubLinks detail={detail} issueNumber={null} pr={pullRequestFor(detail, `docs(${phase})`)} />
        <Section title="Agent calls">
          {calls.length ? (
            <div className="flex flex-col gap-1.5">
              {calls.map((attempt) => (
                <CallButton key={attempt.id} attempt={attempt} label={`attempt ${attemptNumber(attempt.subject) || ""}`} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No agent calls yet.</p>
          )}
        </Section>
        <Section title="Related activity">
          <EventList events={related.slice(-40)} />
        </Section>
      </>
    ),
  }
}

function eventPanel(detail: ProjectDetail, id: string, openPanel: (panel: Panel) => void): PanelContent {
  const event = detail.events.find((entry) => String(entry.id) === id)
  if (!event) return { title: "Event", subtitle: "", body: <p className="text-sm text-muted-foreground">This event is no longer in the recent log.</p> }
  const taskIds = [...new Set(event.message.match(/\bT\d+\b/g) ?? [])].filter((taskId) => detail.tasks.some((task) => task.id === taskId))
  const phases = pipelineSteps.filter((step) => step !== "build" && new RegExp(`\\b${step}\\b`).test(event.message))
  return {
    title: `${event.type} event`,
    subtitle: formatDateTime(event.at),
    body: (
      <>
        <Facts
          rows={[
            ["Time", formatDateTime(event.at)],
            ["Type", <EventType type={event.type} />],
          ]}
        />
        <Section title="Message">
          <p className="rounded-md border bg-muted/40 p-3 text-sm break-words whitespace-pre-wrap">{event.message}</p>
        </Section>
        {(taskIds.length > 0 || phases.length > 0) && (
          <Section title="Related">
            <div className="flex flex-wrap gap-2">
              {taskIds.map((taskId) => (
                <Button key={taskId} variant="outline" size="sm" onClick={() => openPanel({ kind: "task", id: taskId })}>
                  Open task {taskId}
                </Button>
              ))}
              {phases.map((phase) => (
                <Button key={phase} variant="outline" size="sm" onClick={() => openPanel({ kind: "phase", id: phase })}>
                  Open {stepLabels[phase].toLowerCase()} step
                </Button>
              ))}
            </div>
          </Section>
        )}
      </>
    ),
  }
}

function runnerPanel(detail: ProjectDetail, runner: string): PanelContent {
  const cooldown = runnerCooldown(detail.cooldowns, runner)
  const calls = detail.attempts.filter((attempt) => attempt.runner === runner)
  const failures = calls.filter((attempt) => attempt.failureClass)
  const roles = Object.entries(detail.config?.roles ?? {})
    .filter(([, role]) => role.runner === runner || role.fallbacks.some((fallback) => fallback.runner === runner))
    .map(([name, role]) => `${name}${role.runner === runner ? "" : " (fallback)"}`)
  return {
    title: runner,
    subtitle: cooldown ? "cooling down" : "healthy",
    body: (
      <>
        <Facts
          rows={[
            ["Health", cooldown ? <StatusBadge status="cooling" label="cooling down" /> : <StatusBadge status="healthy" />],
            ["Cooldown until", cooldown ? formatDateTime(cooldown.until) : ""],
            ["Reason", cooldown?.reason ?? ""],
            ["Used by", roles.join(", ")],
            ["Calls", `${calls.length} recent · ${failures.length} with a failure class`],
          ]}
        />
        <Section title="Recent calls">
          {calls.length ? (
            <div className="flex flex-col gap-1.5">
              {calls.slice(0, 25).map((attempt) => (
                <CallButton key={attempt.id} attempt={attempt} label={`${attempt.role} · ${attempt.subject}`} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No calls yet.</p>
          )}
        </Section>
      </>
    ),
  }
}

function containerPanel(detail: ProjectDetail, name: string): PanelContent {
  const container = detail.containers.find((entry) => entry.name === name)
  return {
    title: name,
    subtitle: "agent container",
    body: container ? (
      <Facts
        rows={[
          ["Name", <span className="font-mono text-xs">{container.name}</span>],
          ["Status", container.status],
          ["Running for", container.runningFor],
        ]}
      />
    ) : (
      <p className="text-sm text-muted-foreground">This container has stopped.</p>
    ),
  }
}

function docPanel(path: string, showDocument: (path: string) => void): PanelContent {
  return {
    title: path.split("/").pop() ?? path,
    subtitle: path,
    body: (
      <>
        <div>
          <Button variant="outline" size="sm" onClick={() => showDocument(path)}>
            Open in documents
          </Button>
        </div>
        <DocumentView path={path} compact />
      </>
    ),
  }
}

export function DetailsSheet({ panel }: { panel: Panel | null }) {
  const view = useProjectView()
  const { detail } = view
  const content: PanelContent | null = !panel
    ? null
    : panel.kind === "task"
      ? taskPanel(detail, panel.id)
      : panel.kind === "phase"
        ? phasePanel(detail, panel.id, view)
        : panel.kind === "event"
          ? eventPanel(detail, panel.id, view.openPanel)
          : panel.kind === "runner"
            ? runnerPanel(detail, panel.id)
            : panel.kind === "container"
              ? containerPanel(detail, panel.id)
              : docPanel(panel.id, view.showDocument)

  return (
    <Sheet open={content !== null} onOpenChange={(open) => !open && view.closePanel()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        {content && (
          <>
            <SheetHeader className="border-b pr-12">
              <SheetTitle className="break-words">{content.title}</SheetTitle>
              <SheetDescription>{content.subtitle}</SheetDescription>
            </SheetHeader>
            <div key={`${panel?.kind}-${panel?.id}`} className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
              {content.body}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
