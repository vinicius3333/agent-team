import { useEffect, useState } from "react"
import { CheckCircle2, XCircle } from "lucide-react"
import { api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { CopyButton } from "@/components/copy-button"
import { Markdown } from "@/components/markdown"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatCost, formatDuration, formatTokens } from "@/lib/format"
import { cleanCommand, parseTranscript, parseVerdict, type TranscriptEntry } from "@/lib/transcript"
import { cn } from "@/lib/utils"
import type { TranscriptRequest } from "./context"

const liveRefreshMs = 3000

function Label({ children }: { children: string }) {
  return <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</span>
}

function VerdictCard({ text }: { text: string }) {
  const verdict = parseVerdict(text)
  if (!verdict) return null
  return (
    <div className={cn("flex flex-col gap-2 rounded-md border p-3 text-sm", verdict.pass ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5")}>
      <div className={cn("flex items-center gap-2 font-semibold", verdict.pass ? "text-success" : "text-destructive")}>
        {verdict.pass ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
        {verdict.pass ? "Pass" : "Fail"}
      </div>
      {verdict.reasons.length > 0 && (
        <div>
          <p className="font-medium">Reasons</p>
          <ul className="list-disc pl-5">
            {verdict.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {verdict.fixes.length > 0 && (
        <div>
          <p className="font-medium">Fixes</p>
          <ul className="list-disc pl-5">
            {verdict.fixes.map((fix) => (
              <li key={fix}>{fix}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function statValue(key: string, value: string | number | boolean): string {
  if (key === "tokens" || key === "input" || key === "output") return formatTokens(Number(value))
  if (key === "duration") return formatDuration(Number(value))
  return String(value)
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "message":
      return parseVerdict(entry.text) ? (
        <div className="flex flex-col gap-1">
          <Label>Reviewer verdict</Label>
          <VerdictCard text={entry.text} />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Label>Agent</Label>
          <div className="rounded-md border bg-card p-3">
            <Markdown text={entry.text} />
          </div>
        </div>
      )
    case "command":
      return (
        <div className="overflow-hidden rounded-md border">
          <div className="flex items-start gap-2 bg-muted/50 px-3 py-2">
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{cleanCommand(entry.command)}</code>
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]", entry.exitCode === 0 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>exit {entry.exitCode ?? "?"}</span>
          </div>
          {entry.output && (
            <details className="border-t">
              <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">Output ({entry.output.split("\n").length} lines)</summary>
              <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">{entry.output.slice(-6000)}</pre>
            </details>
          )}
        </div>
      )
    case "files":
      return (
        <ul className="flex flex-col gap-1 rounded-md border p-2">
          {entry.changes.map((change) => (
            <li key={`${change.kind}-${change.path}`} className="flex items-center gap-2 text-xs">
              <span className={cn("w-4 text-center font-mono font-semibold", change.kind === "add" ? "text-success" : change.kind === "delete" ? "text-destructive" : "text-warning")}>{change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "M"}</span>
              <span className="font-mono break-all">{String(change.path).replace(/^\/workspace\//, "")}</span>
            </li>
          ))}
        </ul>
      )
    case "meta":
      return (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(entry.stats)
            .filter((pair): pair is [string, string | number | boolean] => pair[1] != null && pair[0] !== "cost")
            .map(([key, value]) => (
              <span
                key={key}
                className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs"
                title={key === "tokens" && entry.stats.cost != null ? `Estimated cost: ${formatCost(Number(entry.stats.cost), 3)}` : undefined}
              >
                {key}: {statValue(key, value)}
              </span>
            ))}
        </div>
      )
    case "error":
      return (
        <div className="flex flex-col gap-1">
          <Label>Error</Label>
          <pre className="rounded-md border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs whitespace-pre-wrap text-destructive">{entry.text}</pre>
        </div>
      )
    case "stderr":
      return (
        <details className="rounded-md border border-destructive/30">
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">stderr</summary>
          <pre className="max-h-80 overflow-auto border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap">{entry.text.slice(-6000)}</pre>
        </details>
      )
    case "tool":
      return (
        <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
          <span className="shrink-0 font-semibold">{entry.name}</span>
          <code className="min-w-0 font-mono break-all text-muted-foreground">{entry.detail.replace(/^\/workspace\//, "")}</code>
        </div>
      )
    case "raw":
      return <pre className="overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{entry.text}</pre>
  }
}

function TranscriptBody({ project, request }: { project: string; request: TranscriptRequest }) {
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!request.live) return
    const timer = setInterval(() => setRefresh((count) => count + 1), liveRefreshMs)
    return () => clearInterval(timer)
  }, [request.live])
  const { value, error, loading } = useAsync(() => api.transcript(project, request.file), [project, request.file, refresh])
  if (loading && value === null) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }
  const text = error ? "Transcript not found." : (value ?? "")
  const entries = parseTranscript(text)
  return (
    <Tabs defaultValue="timeline" className="min-h-0 flex-1 gap-0">
      <TabsList className="mx-4 mt-3">
        <TabsTrigger value="timeline">Transcript</TabsTrigger>
        <TabsTrigger value="raw">Raw</TabsTrigger>
      </TabsList>
      <TabsContent value="timeline" className="min-h-0 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          {entries.length ? entries.map((entry, index) => <Entry key={index} entry={entry} />) : <p className="text-sm text-muted-foreground">Empty transcript.</p>}
        </div>
      </TabsContent>
      <TabsContent value="raw" className="relative min-h-0 overflow-y-auto p-4">
        <div className="absolute top-5 right-5">
          <CopyButton value={text} label="Copy transcript" />
        </div>
        <pre className="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all whitespace-pre-wrap">{text}</pre>
      </TabsContent>
    </Tabs>
  )
}

export function TranscriptSheet({ project, request, onClose }: { project: string; request: TranscriptRequest | null; onClose: () => void }) {
  const attempt = request ? /-(\d+)\.log$/.exec(request.file)?.[1] : undefined
  return (
    <Sheet open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        {request && (
          <>
            <SheetHeader className="border-b pr-12">
              <SheetTitle className="break-words">
                {request.subject} · {request.role}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs break-all">
                {request.runner} {request.model} · {request.file}
                {attempt ? ` · runner attempt ${attempt}` : ""}
              </SheetDescription>
            </SheetHeader>
            <TranscriptBody key={request.file} project={project} request={request} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
