import { useState } from "react"
import { Check, ChevronDown, FileCode, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { Task } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { TaskAction } from "./tasks-card"
import { useProjectView } from "./context"

const previewLength = 280

// A quoted BLOCKED {"kind","needPaths","reason"} object shows as its reason text; the paths are listed below it.
function blockReason(reason: string): string {
  const match = /BLOCKED:\s*(?:\w+\s*:\s*)?\{[^{]*?"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(reason)
  if (!match) return reason
  try {
    return `${reason.slice(0, match.index).trim()}\n\n${JSON.parse(`"${match[1]}"`)}`
  } catch {
    return reason
  }
}

// Worker summaries end with a JSON commit plan and use markdown emphasis; neither helps a person decide.
function readableReason(reason: string): string {
  return blockReason(reason)
    .replace(/```json[\s\S]*?```/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// A blocked task that waits for a person: why, what the agents suggest, and one click to approve or drop it.
export function DecisionCard({ task }: { task: Task }) {
  const { name } = useProjectView()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<"approve" | "drop" | null>(null)
  const reason = readableReason(task.needsHuman ?? "")
  const long = reason.length > previewLength
  const shown = expanded || !long ? reason : `${reason.slice(0, previewLength).trimEnd()}…`
  const paths = task.suggestedPaths ?? []

  const act = async (kind: "approve" | "drop") => {
    setBusy(kind)
    try {
      if (kind === "approve") {
        await api.approveSuggestion(name, task.id)
        toast.success(`${task.id} can now edit ${paths.length} more ${paths.length === 1 ? "file" : "files"}. The build continues.`)
      } else {
        await api.dropTask(name, task.id)
        toast.success(`${task.id} dropped. The build continues without it.`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The decision could not be saved.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card role="alert" className="w-full min-w-0 gap-3 border-warning/40 px-4 py-3">
      <div className="min-w-0">
        <p className="font-medium">
          {task.id} needs your decision <span className="font-normal text-muted-foreground">· {task.title}</span>
        </p>
        <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{shown}</p>
        {long && (
          <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary sm:min-h-0">
            <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" /> {expanded ? "Show less" : "Show details"}
          </button>
        )}
      </div>
      {paths.length > 0 && (
        <div className="min-w-0 rounded-md border bg-muted/40 p-3">
          <p className="text-sm font-medium">Suggested: let {task.id} edit these files, then retry it</p>
          <ul className="mt-2 flex flex-col gap-1">
            {paths.map((path) => (
              <li key={path} className="flex min-w-0 items-start gap-2 font-mono text-xs [overflow-wrap:anywhere]">
                <FileCode className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                {path}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">If another unfinished task owns one of them, {task.id} waits for it.</p>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {paths.length > 0 ? (
          <Button onClick={() => void act("approve")} disabled={busy !== null} className="min-h-11 sm:min-h-9">
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve and retry
          </Button>
        ) : (
          <TaskAction task={task} size="default" />
        )}
        <Button variant="outline" onClick={() => void act("drop")} disabled={busy !== null} className="min-h-11 sm:min-h-9">
          {busy === "drop" ? <Loader2 className="animate-spin" /> : <X />} Reject: drop {task.id}
        </Button>
      </div>
    </Card>
  )
}
