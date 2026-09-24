import { Bot, Brain, FileText, MessageSquare, Pencil, Terminal, Wrench } from "lucide-react"
import type { LiveActivity, LiveAgent } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDuration, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

const activityIcons: Record<LiveActivity["kind"], typeof Terminal> = {
  command: Terminal,
  edit: Pencil,
  read: FileText,
  message: MessageSquare,
  reasoning: Brain,
  tool: Wrench,
}

const fileStatusClasses: Record<string, string> = {
  "??": "text-success",
  A: "text-success",
  D: "text-destructive",
}

function fileStatusLabel(status: string): string {
  return status === "??" ? "new" : status
}

function AgentCard({ agent }: { agent: LiveAgent }) {
  const { openTranscript } = useProjectView()
  const elapsed = Date.now() - Date.parse(agent.startedAt)
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{agent.role}</span>
        <span className="text-sm text-muted-foreground">{agent.subject}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {agent.runner} {agent.model} · {formatDuration(elapsed)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">Last output {agent.updatedAt ? formatRelative(agent.updatedAt) : "not yet"}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent steps</span>
          {agent.activity.length ? (
            <ol className="flex flex-col gap-1">
              {agent.activity.map((step, index) => {
                const Icon = activityIcons[step.kind]
                return (
                  <li key={index} className="flex min-w-0 items-start gap-2 text-xs">
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className={cn("min-w-0 break-words", step.kind === "message" || step.kind === "reasoning" ? "whitespace-pre-wrap" : "font-mono", step.kind === "reasoning" && "text-muted-foreground italic")}>{step.text}</span>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">No steps yet. Some runners only report when they finish.</p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Changed files ({agent.changedFiles.length})</span>
          {agent.changedFiles.length ? (
            <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
              {agent.changedFiles.map((file) => (
                <li key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
                  <span className={cn("w-8 shrink-0 font-mono font-semibold", fileStatusClasses[file.status] ?? "text-warning")}>{fileStatusLabel(file.status)}</span>
                  <span className="min-w-0 font-mono break-all">{file.path}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No files changed yet.</p>
          )}
        </div>
      </div>
      <Button variant="outline" size="sm" className="self-start" onClick={() => openTranscript({ file: agent.transcript, subject: agent.subject, role: agent.role, runner: agent.runner, model: agent.model, live: true })}>
        Open live transcript
      </Button>
    </div>
  )
}

export function LiveAgentsCard() {
  const { detail } = useProjectView()
  const agents = detail.liveAgents ?? []
  if (!agents.length) return null
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Working now</CardTitle>
        <CardDescription>What each agent did last and the files it changed so far. Updates every few seconds.</CardDescription>
        <CardAction>
          <Bot className="size-4 text-muted-foreground" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {agents.map((agent) => (
          <AgentCard key={agent.transcript} agent={agent} />
        ))}
      </CardContent>
    </Card>
  )
}
