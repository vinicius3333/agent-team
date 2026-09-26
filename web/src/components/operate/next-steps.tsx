import { useState, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import { ArrowRight, CalendarClock, Check, ChevronRight, Loader2, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { Finding, FindingSeverity, FindingSource } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectView } from "@/components/project/context"
import { useIsMobile } from "@/hooks/use-mobile"
import { formatRelative } from "@/lib/format"
import { agentLabels, rankFindings, sourceLabels } from "@/lib/operate"
import { cn } from "@/lib/utils"
import { FunnelBars, SeverityBadge, SourceLabel, useFindingActions } from "./shared"
import { useStartSprint } from "./sprints"
import { useFindings, useOperateSnapshot, useSprints } from "./use-operate"

type Filter = "all" | FindingSource
const filters: Filter[] = ["all", "monitoring", "analytics", "research", "evaluator", "product", "manual", "routine"]
const titleMaxLength = 200
const detailMaxLength = 2000

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
          <SourceLabel source={finding.source} className="mt-1 flex sm:hidden" />
        </span>
        <SourceLabel source={finding.source} className="hidden shrink-0 sm:flex" />
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
        <span>{agentLabels[finding.source]}</span>
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

function AddItemForm({ onAdded, onCancel }: { onAdded: (item: Finding) => void; onCancel: () => void }) {
  const { name } = useProjectView()
  const [title, setTitle] = useState("")
  const [detail, setDetail] = useState("")
  const [severity, setSeverity] = useState<FindingSeverity>("medium")
  const [saving, setSaving] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const item = await api.addBacklogItem(name, { title: title.trim(), detail: detail.trim(), severity })
      toast.success("Added to the backlog. The next sprint weighs it with the rest.")
      onAdded(item)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not add the item.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backlog-title">Title</Label>
        <Input id="backlog-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={titleMaxLength} required autoFocus placeholder="Dark mode" className="h-11 md:h-9" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backlog-detail">Detail</Label>
        <Textarea id="backlog-detail" value={detail} onChange={(event) => setDetail(event.target.value)} maxLength={detailMaxLength} rows={4} placeholder="What should change, and how to tell it works." />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label id="backlog-priority">Priority</Label>
        <ToggleGroup type="single" variant="outline" value={severity} onValueChange={(value) => value && setSeverity(value as FindingSeverity)} aria-labelledby="backlog-priority" className="w-full">
          {(["high", "medium", "low"] as const).map((level) => (
            <ToggleGroupItem key={level} value={level} className="h-11 flex-1 capitalize md:h-9">
              {level}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex flex-col gap-2">
        <Button type="submit" disabled={saving || !title.trim()} className="h-11 md:h-10">
          {saving ? <Loader2 className="animate-spin" /> : <Plus />} Add to backlog
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="h-11 md:h-10">
          Cancel
        </Button>
      </div>
      <p className="border-t pt-3 text-xs text-muted-foreground">Items stay open until a sprint picks them or you dismiss them.</p>
    </form>
  )
}

function NextSprintBar() {
  const { snapshot, refresh } = useSprints()
  const { start, starting } = useStartSprint(refresh)
  if (!snapshot?.settings.enabled) return null
  const active = snapshot.sprints.find((sprint) => sprint.status === "planning" || sprint.status === "building")
  const days = snapshot.nextDueAt ? Math.ceil((Date.parse(snapshot.nextDueAt) - Date.now()) / (24 * 60 * 60_000)) : 0
  const text = active ? `Sprint ${active.number} is ${active.status}` : days > 0 ? `Next sprint in ${days === 1 ? "1 day" : `${days} days`}` : "Next sprint as soon as the app is ready"
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-lg border bg-card px-4 py-2 text-sm">
      <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {text} · picks up to {snapshot.settings.maxItems} items
      </span>
      {!active && snapshot.startBlocker === null && (
        <Button variant="link" onClick={start} disabled={starting} className="h-auto px-0">
          {starting ? <Loader2 className="animate-spin" /> : null} Start now <ArrowRight />
        </Button>
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
  const adding = searchParams.get("add") === "1"
  const updateParams = (change: (params: URLSearchParams) => void) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        change(next)
        return next
      },
      { replace: true },
    )
  const select = (id: number | null) =>
    updateParams((params) => {
      params.delete("add")
      if (id === null) params.delete("finding")
      else params.set("finding", String(id))
    })
  const setAdding = (open: boolean) =>
    updateParams((params) => {
      params.delete("finding")
      if (open) params.set("add", "1")
      else params.delete("add")
    })
  const onAdded = (item: Finding) => {
    void refresh()
    setDismissed(false)
    select(item.id)
  }

  const visible = rankFindings((findings ?? []).filter((finding) => filter === "all" || finding.source === filter))
  const selected = (findings ?? []).find((finding) => finding.id === selectedId) ?? null
  const panelOpen = adding || selected !== null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Backlog</h2>
          <p className="text-sm text-muted-foreground">The next sprint picks from these items. Add your own ideas; the product manager weighs them with the rest.</p>
        </div>
        <Button onClick={() => setAdding(true)} className="h-11 sm:h-9">
          <Plus /> Add item
        </Button>
      </div>
      <NextSprintBar />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter the backlog">
        {filters.map((entry) => (
          <Chip key={entry} pressed={filter === entry} onClick={() => setFilter(entry)}>
            {entry === "all" ? "All" : sourceLabels[entry]}
          </Chip>
        ))}
        <Chip pressed={dismissed} onClick={() => setDismissed((value) => !value)}>
          Dismissed
        </Chip>
      </div>
      <div className={cn("grid items-start gap-4", panelOpen && !isMobile && "md:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]")}>
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
            <EmptyState title={dismissed ? "No dismissed items" : "The backlog is empty"}>{dismissed ? "Items you dismiss show up here." : "The Operate agents and the evaluator add items as they run. Add your own with Add item."}</EmptyState>
          )}
        </Card>
        {adding && !isMobile && (
          <Card className="sticky top-4">
            <CardContent className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">Add to backlog</h2>
              <AddItemForm onAdded={onAdded} onCancel={() => setAdding(false)} />
            </CardContent>
          </Card>
        )}
        {selected && !adding && !isMobile && (
          <Card className="sticky top-4">
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 text-lg font-semibold">{selected.title}</h2>
                <Button variant="ghost" size="icon" onClick={() => select(null)} aria-label="Close item">
                  <X />
                </Button>
              </div>
              <FindingDetail finding={selected} onChange={refresh} />
            </CardContent>
          </Card>
        )}
      </div>
      {isMobile && (
        <Sheet open={adding} onOpenChange={(open) => !open && setAdding(false)}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Add to backlog</SheetTitle>
              <SheetDescription>The next sprint weighs it with the rest.</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-6">
              <AddItemForm onAdded={onAdded} onCancel={() => setAdding(false)} />
            </div>
          </SheetContent>
        </Sheet>
      )}
      {isMobile && (
        <Sheet open={selected !== null && !adding} onOpenChange={(open) => !open && select(null)}>
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
