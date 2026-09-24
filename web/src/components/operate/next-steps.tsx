import { useState, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import { Bot, Check, ChevronRight, Loader2, X } from "lucide-react"
import type { Finding, InsightAgent } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectView } from "@/components/project/context"
import { useIsMobile } from "@/hooks/use-mobile"
import { formatRelative } from "@/lib/format"
import { agentLabels, rankFindings, sourceLabels } from "@/lib/operate"
import { cn } from "@/lib/utils"
import { FunnelBars, SeverityBadge, useFindingActions } from "./shared"
import { useFindings, useOperateSnapshot } from "./use-operate"

type Filter = "all" | InsightAgent
const filters: Filter[] = ["all", "monitoring", "analytics", "research"]

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant={pressed ? "default" : "outline"} aria-pressed={pressed} onClick={onClick} className="h-10 rounded-full md:h-9">
      {children}
    </Button>
  )
}

function FindingRow({ finding, selected, onSelect }: { finding: Finding; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn("flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:items-center", selected && "bg-primary/5")}
      >
        <SeverityBadge severity={finding.severity} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{finding.title}</span>
          <span className="line-clamp-2 text-xs text-muted-foreground sm:line-clamp-1">{finding.evidence}</span>
          <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground sm:hidden">
            <Bot className="size-3.5" aria-hidden="true" /> {agentLabels[finding.source]}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <Bot className="size-4" aria-hidden="true" /> {agentLabels[finding.source]}
        </span>
        <ChevronRight className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
      </button>
    </li>
  )
}

function FindingDetail({ finding, onChange }: { finding: Finding; onChange: () => void }) {
  const { detail } = useProjectView()
  const { approve, dismiss, busy } = useFindingActions(onChange)
  const open = finding.status === "open"
  const { snapshot } = useOperateSnapshot()
  // Findings carry no chart data, so the funnel shows only for analytics findings that cite it.
  const showFunnel = finding.source === "analytics" && /funnel/i.test(finding.evidence) && Boolean(snapshot?.funnel.length)
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <SeverityBadge severity={finding.severity} />
        <span>{sourceLabels[finding.source]}</span>
        <span>· updated {formatRelative(finding.updatedAt)}</span>
      </div>
      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">Evidence</h3>
        <p className="whitespace-pre-line text-muted-foreground">{finding.evidence}</p>
      </section>
      {showFunnel && snapshot && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Signup funnel, last 30 days</h3>
          <FunnelBars funnel={snapshot.funnel} />
        </section>
      )}
      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">Proposed change</h3>
        <p className="whitespace-pre-line text-muted-foreground">{finding.proposal}</p>
      </section>
      {open ? (
        <div className="flex flex-col gap-2">
          <Button onClick={() => approve(finding)} disabled={busy !== null || detail.active} className="h-10">
            {busy === finding.id ? <Loader2 className="animate-spin" /> : <Check />} Approve as change
          </Button>
          <Button variant="outline" onClick={() => dismiss(finding)} disabled={busy !== null} className="h-10">
            <X /> Dismiss
          </Button>
          {detail.active && <p className="text-xs text-muted-foreground">A run is active. Approve once it stops.</p>}
        </div>
      ) : (
        <p className="text-muted-foreground">
          {finding.status === "approved" ? `Approved as change ${finding.changeId ?? ""}.` : "Dismissed."}
        </p>
      )}
    </div>
  )
}

export function OperateNextSteps() {
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useState<Filter>("all")
  const [dismissed, setDismissed] = useState(false)
  const { findings, error, refresh } = useFindings(dismissed ? "dismissed" : "open")
  const selectedId = Number(searchParams.get("finding"))
  const select = (id: number | null) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (id === null) next.delete("finding")
        else next.set("finding", String(id))
        return next
      },
      { replace: true },
    )

  const visible = rankFindings((findings ?? []).filter((finding) => filter === "all" || finding.source === filter))
  const selected = (findings ?? []).find((finding) => finding.id === selectedId) ?? null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Next steps</h2>
        <p className="text-sm text-muted-foreground">Open findings from the Operate agents, most severe first</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter findings">
        {filters.map((entry) => (
          <Chip key={entry} pressed={filter === entry} onClick={() => setFilter(entry)}>
            {entry === "all" ? "All" : sourceLabels[entry]}
          </Chip>
        ))}
        <Chip pressed={dismissed} onClick={() => setDismissed((value) => !value)}>
          Dismissed
        </Chip>
      </div>
      <div className={cn("grid items-start gap-4", selected && !isMobile && "md:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]")}>
        <Card className="py-0">
          {!findings ? (
            error ? (
              <EmptyState title="Could not load findings">{error.message}</EmptyState>
            ) : (
              <Skeleton className="m-4 h-40" />
            )
          ) : visible.length ? (
            <ul className="divide-y">
              {visible.map((finding) => (
                <FindingRow key={finding.id} finding={finding} selected={finding.id === selected?.id} onSelect={() => select(finding.id)} />
              ))}
            </ul>
          ) : (
            <EmptyState title={dismissed ? "No dismissed findings" : "No open findings"}>{dismissed ? "Findings you dismiss show up here." : "The agents write findings after each run. Start one from Health, Analytics, or Competitors."}</EmptyState>
          )}
        </Card>
        {selected && !isMobile && (
          <Card className="sticky top-4">
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 text-lg font-semibold">{selected.title}</h2>
                <Button variant="ghost" size="icon" onClick={() => select(null)} aria-label="Close finding">
                  <X />
                </Button>
              </div>
              <FindingDetail finding={selected} onChange={refresh} />
            </CardContent>
          </Card>
        )}
      </div>
      {isMobile && (
        <Sheet open={selected !== null} onOpenChange={(open) => !open && select(null)}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
            {selected && (
              <>
                <SheetHeader>
                  <SheetTitle>{selected.title}</SheetTitle>
                  <SheetDescription>{agentLabels[selected.source]}</SheetDescription>
                </SheetHeader>
                <div className="px-4 pb-6">
                  <FindingDetail finding={selected} onChange={refresh} />
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
