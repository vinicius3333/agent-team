import { useEffect, useLayoutEffect, useRef } from "react"
import type { ProjectEvent } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { EmptyActivityIllustration } from "@/components/illustrations/empty-activity"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatClock } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { StreamState } from "@/api/hooks"
import { useProjectView } from "./context"

const typeClasses: Record<string, string> = {
  phase: "bg-chart-1/10 text-chart-1",
  task: "bg-chart-3/10 text-chart-3",
  merge: "bg-success/10 text-success",
  gate: "bg-warning/10 text-warning",
  deploy: "bg-chart-2/10 text-chart-2",
  publish: "bg-chart-5/10 text-chart-5",
  github: "bg-chart-5/10 text-chart-5",
  error: "bg-destructive/10 text-destructive",
}

export function EventType({ type }: { type: string }) {
  return <span className={cn("inline-flex shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-medium", typeClasses[type] ?? "bg-muted text-muted-foreground")}>{type}</span>
}

export function EventList({ events, className, follow = false }: { events: ProjectEvent[]; className?: string; follow?: boolean }) {
  const { openPanel } = useProjectView()
  const listRef = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const list = listRef.current
    if (follow && list && pinned.current) list.scrollTop = list.scrollHeight
  }, [events, follow])

  useEffect(() => {
    const list = listRef.current
    if (!list || !follow) return
    const onScroll = () => {
      pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    }
    list.addEventListener("scroll", onScroll)
    return () => list.removeEventListener("scroll", onScroll)
  }, [follow])

  if (!events.length) return <EmptyState illustration={<EmptyActivityIllustration />} title="No activity yet" />
  return (
    <ol ref={listRef} className={cn("flex flex-col overflow-y-auto", className)}>
      {events.map((event) => (
        <li key={event.id}>
          <button
            type="button"
            onClick={() => openPanel({ kind: "event", id: String(event.id) })}
            className="grid w-full grid-cols-[auto_auto_1fr] items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <time dateTime={event.at} className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
              {formatClock(event.at)}
            </time>
            <EventType type={event.type} />
            <span className="min-w-0 break-words whitespace-pre-line [overflow-wrap:anywhere]">{event.message}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}

export function EventsCard({ stream }: { stream: StreamState }) {
  const { detail } = useProjectView()
  return (
    <Card className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle>Live events</CardTitle>
        <CardAction>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
            <span className={cn("size-2 rounded-full", stream === "open" ? "animate-pulse bg-primary" : "bg-warning")} aria-hidden="true" />
            {stream === "open" ? "Streaming" : stream === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <EventList events={detail.events} follow className="max-h-[28rem]" />
      </CardContent>
    </Card>
  )
}
