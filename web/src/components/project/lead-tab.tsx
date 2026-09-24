import { useMemo, useState, type ReactNode } from "react"
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { Bot, Check, Loader2, SendHorizontal, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { ChatMessage, LeadAction } from "@/api/types"
import { Markdown } from "@/components/markdown"
import { useProjectView } from "@/components/project/context"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { describeCandidate, projectStatus, projectStatusLabels, taskCounts } from "@/lib/pipeline"
import { TokenCount } from "@/components/token-count"

interface LeadMetadata {
  messageId: number
  actions: LeadAction[]
}

const suggestions = ["What is the team working on now?", "Why did the last task fail?", "What should I do next?"]

function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: String(message.id),
    role: message.author === "human" ? "user" : "assistant",
    content: [{ type: "text", text: message.body }],
    createdAt: new Date(message.at),
    metadata: { custom: { messageId: message.id, actions: message.actions } satisfies LeadMetadata },
  }
}

const actionLabels: Record<LeadAction["kind"], (action: LeadAction) => string> = {
  retry: (action) => `Retry ${"taskId" in action ? action.taskId : "task"}`,
  resume: () => "Resume run",
  approve: (action) => `Approve ${"phase" in action ? action.phase : "phase"}`,
  request_changes: (action) => `Send ${"phase" in action ? action.phase : "phase"} back`,
  raise_budget: () => "Raise budget and resume",
}

async function applyAction(project: string, action: LeadAction): Promise<void> {
  switch (action.kind) {
    case "retry":
      return void (await api.retry(project, action.taskId))
    case "resume":
      return void (await api.run(project))
    case "approve":
      return void (await api.approve(project, action.phase))
    case "request_changes":
      return void (await api.feedback(project, action.phase, action.message))
    case "raise_budget":
      return void (await api.raiseBudget(project))
  }
}

function ActionCard({ messageId, index, action }: { messageId: number; index: number; action: LeadAction }) {
  const { name } = useProjectView()
  const [busy, setBusy] = useState(false)
  const label = actionLabels[action.kind](action)
  const decide = async (state: "applied" | "dismissed") => {
    setBusy(true)
    try {
      if (state === "applied") await applyAction(name, action)
      await api.chatAction(name, messageId, index, state)
      if (state === "applied") toast.success(label)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not ${label.toLowerCase()}.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex max-w-md flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium text-primary">Suggested action</p>
      {action.reason && <p className="text-sm text-muted-foreground">{action.reason}</p>}
      {action.kind === "request_changes" && <p className="text-sm whitespace-pre-wrap">{action.message}</p>}
      {action.state === "proposed" ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => decide("applied")}>
            {busy && <Loader2 className="animate-spin" />} {label}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("dismissed")}>
            Dismiss
          </Button>
        </div>
      ) : (
        <p className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          {action.state === "applied" ? <Check className="size-4" /> : <X className="size-4" />}
          {label}: {action.state}
        </p>
      )}
    </div>
  )
}

function LeadAvatar() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
      <Bot className="size-4" />
    </span>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  const { name } = useProjectView()
  const metadata = useAuiState((state) => state.message.metadata.custom as Partial<LeadMetadata> | undefined)
  return (
    <MessagePrimitive.Root className="flex gap-3">
      <LeadAvatar />
      <div className="flex min-w-0 max-w-[85%] flex-col gap-2">
        <div className="rounded-2xl border bg-card px-4 py-2 text-sm">
          <MessagePrimitive.Parts>{({ part }) => (part.type === "text" ? <Markdown text={part.text} project={name} /> : null)}</MessagePrimitive.Parts>
        </div>
        {metadata?.messageId !== undefined &&
          metadata.actions?.map((action, index) => <ActionCard key={index} messageId={metadata.messageId!} index={index} action={action} />)}
      </div>
    </MessagePrimitive.Root>
  )
}

function Thinking() {
  return (
    <div className="flex items-center gap-3" role="status">
      <LeadAvatar />
      <span className="inline-flex items-center gap-2 rounded-2xl border bg-card px-4 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Project lead is thinking…
      </span>
    </div>
  )
}

function Thread({ thinking }: { thinking: boolean }) {
  const { detail } = useProjectView()
  return (
    <ThreadPrimitive.Root className="flex h-[min(70vh,720px)] flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <LeadAvatar />
        <div>
          <p className="font-medium">Project lead</p>
          <p className="text-xs text-muted-foreground">{describeCandidate(detail.config?.roles.lead)}. Reads the project, never edits it.</p>
        </div>
      </div>
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <ThreadPrimitive.Empty>
          <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Ask the lead about the plan, a failure, or what to do next.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map((prompt) => (
                <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send asChild>
                  <Button variant="outline" size="sm">
                    {prompt}
                  </Button>
                </ThreadPrimitive.Suggestion>
              ))}
            </div>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        {thinking && <Thinking />}
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="flex items-end gap-2 border-t p-3">
        <ComposerPrimitive.Input
          rows={2}
          maxLength={4000}
          placeholder="Ask the lead about this project"
          aria-label="Message to the project lead"
          className="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <ComposerPrimitive.Send asChild>
          <Button>
            <SendHorizontal /> Send
          </Button>
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  )
}

function ContextCard() {
  const { detail } = useProjectView()
  const counts = taskCounts(detail.tasks)
  const status = projectStatus(detail)
  const rows: [string, ReactNode][] = [
    ["Now", detail.current ?? "—"],
    ["Tasks", `${counts.merged} of ${detail.tasks.length} merged${counts.blocked ? `, ${counts.blocked} blocked` : ""}`],
    ["Tokens", detail.budget ? <TokenCount tokens={detail.budget.spentTokens ?? 0} usd={detail.budget.spentUsd} label /> : "—"],
    ["Run", projectStatusLabels[status]],
  ]
  return (
    <Card className="gap-3 p-4">
      <p className="font-medium">What the lead sees</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">It also reads the brief, docs, tasks.json, and agent transcripts. It suggests actions; you apply them. Chat cost does not count against the run budget.</p>
    </Card>
  )
}

export function LeadTab() {
  const { name, detail } = useProjectView()
  const stored = detail.chat?.messages ?? []
  // Shown until the stream delivers the stored copy, so the message does not vanish for up to two seconds.
  const [pending, setPending] = useState<string | null>(null)
  const pendingDelivered = pending !== null && stored.some((message) => message.author === "human" && message.body === pending)
  const visiblePending = pendingDelivered ? null : pending
  const thinking = Boolean(detail.chat?.thinking) || visiblePending !== null

  const messages = useMemo(() => {
    const converted = stored.map(toThreadMessage)
    if (visiblePending) converted.push({ id: "pending", role: "user", content: [{ type: "text", text: visiblePending }] })
    return converted
  }, [stored, visiblePending])

  const onNew = async (message: AppendMessage) => {
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim()
    if (!text) return
    setPending(text)
    try {
      await api.chat(name, text)
    } catch (error) {
      setPending(null)
      toast.error(error instanceof Error ? error.message : "Could not send the message.")
    }
  }

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    // isRunning would add an empty placeholder reply; the Thinking row shows progress instead.
    isSendDisabled: thinking,
    onNew,
  })

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="gap-0 overflow-hidden p-0">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread thinking={thinking} />
        </AssistantRuntimeProvider>
      </Card>
      <div>
        <ContextCard />
      </div>
    </div>
  )
}
