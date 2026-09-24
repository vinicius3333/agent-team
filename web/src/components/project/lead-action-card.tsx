import { useState } from "react"
import { Check, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { LeadAction } from "@/api/types"
import { Button } from "@/components/ui/button"
import { useProjectView } from "./context"

export const actionLabels: { [Kind in LeadAction["kind"]]: (action: Extract<LeadAction, { kind: Kind }>) => string } = {
  retry: (action) => `Retry ${action.taskId}`,
  resume: () => "Resume run",
  approve: (action) => `Approve ${action.phase}`,
  request_changes: (action) => `Send ${action.phase} back`,
  raise_budget: () => "Raise budget by 50%",
  add_task: () => "Add task",
  edit_task: (action) => `Change ${action.taskId}`,
}

export function actionLabel(action: LeadAction): string {
  return (actionLabels[action.kind] as (action: LeadAction) => string)(action)
}

function List({ label, items }: { label: string; items: string[] | undefined }) {
  if (!items?.length) return null
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="list-disc pl-5 text-sm">
        {items.map((item) => (
          <li key={item} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Paths({ label, paths }: { label: string; paths: string[] | undefined }) {
  if (!paths?.length) return null
  return (
    <p className="text-xs text-muted-foreground">
      {label}:{" "}
      {paths.map((path) => (
        <code key={path} className="mr-1 rounded bg-muted px-1 py-0.5 font-mono">
          {path}
        </code>
      ))}
    </p>
  )
}

function ActionDetails({ action }: { action: LeadAction }) {
  switch (action.kind) {
    case "request_changes":
      return <p className="text-sm whitespace-pre-wrap">{action.message}</p>
    case "add_task":
      return (
        <div className="flex flex-col gap-2 rounded-md border bg-card p-2">
          <p className="text-sm font-medium">{action.task.title}</p>
          {action.task.story && <p className="text-sm text-muted-foreground">{action.task.story}</p>}
          <List label="Done when" items={action.task.acceptance} />
          <Paths label="May edit" paths={action.task.allowedPaths} />
          {action.task.dependsOn.length > 0 && <p className="text-xs text-muted-foreground">After {action.task.dependsOn.join(", ")}</p>}
        </div>
      )
    case "edit_task":
      return (
        <div className="flex flex-col gap-2 rounded-md border bg-card p-2">
          {action.changes.title && <p className="text-sm font-medium">{action.changes.title}</p>}
          {action.changes.story && <p className="text-sm text-muted-foreground">{action.changes.story}</p>}
          <List label="Done when" items={action.changes.acceptance} />
          <Paths label="May edit" paths={action.changes.allowedPaths} />
          <Paths label="May read" paths={action.changes.readPaths} />
          {action.changes.verify && <Paths label="Verify" paths={[action.changes.verify]} />}
        </div>
      )
    default:
      return null
  }
}

export function ActionCard({ messageId, index, action }: { messageId: number; index: number; action: LeadAction }) {
  const { name } = useProjectView()
  const [busy, setBusy] = useState(false)
  const label = actionLabel(action)
  const decide = async (state: "applied" | "dismissed") => {
    setBusy(true)
    try {
      const result = await api.chatAction(name, messageId, index, state)
      if (state === "applied") toast.success(result.note ? `${result.note[0].toUpperCase()}${result.note.slice(1)}.` : label)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not ${label.toLowerCase()}.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex max-w-lg flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium text-primary">Suggested action</p>
      {action.reason && <p className="text-sm text-muted-foreground">{action.reason}</p>}
      <ActionDetails action={action} />
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
