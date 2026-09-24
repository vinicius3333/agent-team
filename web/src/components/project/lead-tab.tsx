import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { Bot, FileText, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { api, urls } from "@/api/client"
import type { ChatDetails, ChatMessage, LeadAction, LiveActivity, ProjectDetail } from "@/api/types"
import { Markdown } from "@/components/markdown"
import { useProjectView } from "@/components/project/context"
import { ActionCard } from "@/components/project/lead-action-card"
import { LeadComposer } from "@/components/project/lead-composer"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { describeCandidate, projectStatus, projectStatusLabels, taskCounts } from "@/lib/pipeline"
import { formatCost } from "@/lib/format"
import { TokenCount } from "@/components/token-count"

interface MessageMetadata {
  messageId: number
  actions: LeadAction[]
  details: ChatDetails
  last: boolean
}

const noDetails: ChatDetails = { attachments: [], filesRead: [], followUps: [] }
const maxActivityLines = 6

// Lets follow-up chips send a message without going through the composer.
const SendContext = createContext<(text: string) => void>(() => {})

// Starter prompts follow what the project needs now, so the first question is one click away.
function starterPrompts(detail: ProjectDetail): string[] {
  const prompts: string[] = []
  const blocked = detail.tasks.find((task) => task.status === "blocked")
  const waiting = detail.phases.find((phase) => phase.status === "awaiting_approval")
  if (detail.stop?.kind === "budget") prompts.push("How much budget do we need to finish?")
  if (blocked) prompts.push(`Why is ${blocked.id} blocked?`)
  if (waiting) prompts.push(`What should I check before approving ${waiting.name}?`)
  prompts.push("What is the team working on now?", "What should I do next?", "I want to add a feature")
  return [...new Set(prompts)].slice(0, 4)
}

function toThreadMessage(message: ChatMessage, last: boolean): ThreadMessageLike {
  return {
    id: String(message.id),
    role: message.author === "human" ? "user" : "assistant",
    content: [{ type: "text", text: message.body }],
    createdAt: new Date(message.at),
    metadata: { custom: { messageId: message.id, actions: message.actions, details: message.details ?? noDetails, last } satisfies MessageMetadata },
  }
}

function useMetadata() {
  return useAuiState((state) => state.message.metadata.custom as Partial<MessageMetadata> | undefined)
}

function LeadAvatar() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
      <Bot className="size-4" />
    </span>
  )
}

function Attachments({ files }: { files: string[] }) {
  const { name } = useProjectView()
  if (!files.length) return null
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {files.map((file) => (
        <a key={file} href={urls.chatUpload(name, file)} target="_blank" rel="noreferrer" className="block size-24 overflow-hidden rounded-lg border">
          <img src={urls.chatUpload(name, file)} alt="Attached image" className="size-full object-cover" />
        </a>
      ))}
    </div>
  )
}

function UserMessage() {
  const metadata = useMetadata()
  return (
    <MessagePrimitive.Root className="flex flex-col items-end gap-2">
      <Attachments files={metadata?.details?.attachments ?? []} />
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function FilesRead({ files }: { files: string[] }) {
  const { showDocument } = useProjectView()
  if (!files.length) return null
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        Read {files.length} {files.length === 1 ? "file" : "files"}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 pl-4">
        {files.map((entry) => {
          const path = entry.replace(/^(Read|Glob|Grep|LS) /, "")
          const readable = entry.startsWith("Read ") && path.endsWith(".md")
          return (
            <li key={entry} className="flex items-center gap-1 font-mono break-all">
              <FileText className="size-3 shrink-0" />
              {readable ? (
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => showDocument(path)}>
                  {entry}
                </button>
              ) : (
                entry
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

function FollowUps({ prompts, disabled }: { prompts: string[]; disabled: boolean }) {
  const send = useContext(SendContext)
  if (!prompts.length) return null
  return (
    <div className="flex flex-wrap gap-2" aria-label="Suggested follow-ups">
      {prompts.map((prompt) => (
        <Button key={prompt} variant="outline" size="sm" className="h-auto py-1 text-left whitespace-normal" disabled={disabled} onClick={() => send(prompt)}>
          <Sparkles className="text-primary" /> {prompt}
        </Button>
      ))}
    </div>
  )
}

function AssistantMessage() {
  const { name, detail } = useProjectView()
  const metadata = useMetadata()
  const details = metadata?.details ?? noDetails
  return (
    <MessagePrimitive.Root className="flex gap-3">
      <LeadAvatar />
      <div className="flex min-w-0 max-w-[85%] flex-col gap-2">
        <div className="rounded-2xl border bg-card px-4 py-2 text-sm">
          <MessagePrimitive.Parts>{({ part }) => (part.type === "text" ? <Markdown text={part.text} project={name} /> : null)}</MessagePrimitive.Parts>
        </div>
        <FilesRead files={details.filesRead} />
        {metadata?.messageId !== undefined &&
          metadata.actions?.map((action, index) => <ActionCard key={index} messageId={metadata.messageId!} index={index} action={action} />)}
        {metadata?.last && <FollowUps prompts={details.followUps} disabled={Boolean(detail.chat?.thinking)} />}
      </div>
    </MessagePrimitive.Root>
  )
}

const activityVerbs: Record<LiveActivity["kind"], string> = {
  read: "Reading",
  command: "Running",
  edit: "Editing",
  message: "",
  reasoning: "",
  tool: "Using",
}

// Shows what the lead is doing while it answers, from its live transcript.
function Thinking({ activity }: { activity: LiveActivity[] }) {
  const steps = activity.slice(-maxActivityLines)
  return (
    <div className="flex gap-3" role="status" aria-live="polite">
      <LeadAvatar />
      <div className="flex min-w-0 max-w-[85%] flex-col gap-1 rounded-2xl border bg-card px-4 py-2 text-sm">
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Project lead is {steps.length ? "working" : "thinking"}…
        </span>
        {steps.map((step, index) => {
          const narrative = step.kind === "message" || step.kind === "reasoning"
          return (
            <p key={index} className={narrative ? "line-clamp-3 text-sm whitespace-pre-wrap" : "truncate font-mono text-xs text-muted-foreground"}>
              {narrative ? step.text : `${activityVerbs[step.kind]} ${step.text.replace(/^(Read|Glob|Grep|LS) /, "")}`}
            </p>
          )
        })}
      </div>
    </div>
  )
}

function Thread({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string, attachments: string[]) => Promise<boolean>; onStop: () => void }) {
  const { detail } = useProjectView()
  const settings = detail.config?.lead
  const autoApply = settings?.autoApply.length ? ` Applies ${settings.autoApply.join(", ").replace(/_/g, " ")} on its own.` : ""
  return (
    <ThreadPrimitive.Root className="flex h-[min(75vh,760px)] flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <LeadAvatar />
        <div>
          <p className="font-medium">Project lead</p>
          <p className="text-xs text-muted-foreground">
            {describeCandidate(detail.config?.roles.lead)}. Reads the project and suggests actions; changes to code go through tasks.{autoApply}
          </p>
        </div>
      </div>
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <ThreadPrimitive.Empty>
          <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Ask about the plan or a failure, ask for a change, or attach a screenshot. You can also dictate.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {starterPrompts(detail).map((prompt) => (
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
        {busy && <Thinking activity={detail.chat?.activity ?? []} />}
      </ThreadPrimitive.Viewport>
      <LeadComposer busy={busy} onSend={onSend} onStop={onStop} />
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
      <p className="text-xs text-muted-foreground">
        It also reads the brief, docs, tasks.json, and agent transcripts. Each answer may cost up to {formatCost(detail.config?.lead?.chatBudgetUsd ?? 2)}. Chat cost does not count against the run budget
        {detail.spend ? ` (${formatCost(detail.spend.chatUsd)} so far)` : ""}. Change what it may do in the Config tab.
      </p>
    </Card>
  )
}

export function LeadTab() {
  const { name, detail } = useProjectView()
  const stored = useMemo(() => detail.chat?.messages ?? [], [detail.chat?.messages])
  // Shown until the stream delivers the stored copy, so the message does not vanish for up to two seconds.
  const [pending, setPending] = useState<{ text: string; attachments: string[] } | null>(null)
  const pendingDelivered = pending !== null && stored.some((message) => message.author === "human" && message.body === pending.text)
  const visiblePending = pendingDelivered ? null : pending
  const busy = Boolean(detail.chat?.thinking) || visiblePending !== null

  const messages = useMemo(() => {
    const lastLead = stored.findLastIndex((message) => message.author === "lead")
    const converted = stored.map((message, index) => toThreadMessage(message, index === lastLead && index === stored.length - 1))
    if (visiblePending) {
      converted.push({
        id: "pending",
        role: "user",
        content: [{ type: "text", text: visiblePending.text }],
        metadata: { custom: { details: { ...noDetails, attachments: visiblePending.attachments } } },
      })
    }
    return converted
  }, [stored, visiblePending])

  const send = async (text: string, attachments: string[] = []): Promise<boolean> => {
    if (!text.trim() || busy) return false
    setPending({ text, attachments })
    try {
      await api.chat(name, text, attachments)
      return true
    } catch (error) {
      setPending(null)
      toast.error(error instanceof Error ? error.message : "Could not send the message.")
      return false
    }
  }

  const stop = async () => {
    try {
      await api.chatStop(name)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not stop the lead.")
    }
  }

  const onNew = async (message: AppendMessage) => {
    await send(message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim())
  }

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    // isRunning would add an empty placeholder reply; the Thinking row shows progress instead.
    isSendDisabled: busy,
    onNew,
  })

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="gap-0 overflow-hidden p-0">
        <SendContext.Provider value={(text) => void send(text)}>
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread busy={busy} onSend={send} onStop={stop} />
          </AssistantRuntimeProvider>
        </SendContext.Provider>
      </Card>
      <div>
        <ContextCard />
      </div>
    </div>
  )
}
