import { useState } from "react"
import { CircleAlert, ExternalLink, GitMerge, Loader2, MessageSquarePlus, Send } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ChangeSummary } from "@/api/types"
import { useProjectView } from "./context"

const requestLimit = 4000

// Shown once the build is complete, no run is alive, and no other change is open.
export function ChangeRequestCard() {
  const { name, detail } = useProjectView()
  const [request, setRequest] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!detail.canRequestChange) return null

  const submit = async () => {
    if (!request.trim()) {
      setError("Describe the change first.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { id, started } = await api.requestChange(name, request.trim())
      setRequest("")
      if (started) toast.success(`Change ${id} opened. The team is planning it.`)
      else toast.warning(`Change ${id} opened, but a run is still active. Resume the run once it stops.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open the change.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquarePlus className="size-5" aria-hidden="true" /> Request a change
        </CardTitle>
        <CardDescription>Describe what to add or change. The team plans only the change, builds it on a branch, runs QA, and redeploys.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Label htmlFor="change-request" className="sr-only">
          Change request
        </Label>
        <Textarea
          id="change-request"
          value={request}
          maxLength={requestLimit}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="Add CSV export to the reports page"
          className="min-h-20"
        />
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-4">
          <span className="text-right text-xs text-muted-foreground tabular-nums">
            {request.length} / {requestLimit}
          </span>
          <Button onClick={submit} disabled={busy} className="w-full sm:w-auto">
            {busy ? <Loader2 className="animate-spin" /> : <Send />} Submit
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// autonomy.changeMerge: manual. QA passed and the change waits for a person before it merges into main.
export function ChangeMergeCard() {
  const { name, detail } = useProjectView()
  const [busy, setBusy] = useState(false)
  const change = detail.change
  if (!change?.mergeWaiting || detail.active) return null
  const approve = async () => {
    setBusy(true)
    try {
      await api.approveChangeMerge(name, change.id)
      toast.success(`Change ${change.id} approved. It merges into main and deploys.`)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not approve the merge.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card role="status" className="flex-col items-start gap-3 border-warning/40 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="font-medium">Change {change.id} passed QA and waits for your approval</p>
        <p className="text-sm text-muted-foreground">
          Approve merges <span className="font-mono">{change.branch}</span> into main and redeploys the app.
        </p>
      </div>
      <Button onClick={approve} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <GitMerge />} Approve merge
      </Button>
    </Card>
  )
}

export function AbandonButton({ change }: { change: ChangeSummary }) {
  const { name, detail } = useProjectView()
  const [busy, setBusy] = useState(false)
  if (change.status !== "open" || detail.active) return null
  const abandon = async () => {
    if (!window.confirm(`Abandon change ${change.id}? Its tasks are removed and the phases go back to the last build.`)) return
    setBusy(true)
    try {
      await api.abandonChange(name, change.id)
      toast.success(`Change ${change.id} abandoned.`)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not abandon the change.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={abandon} disabled={busy}>
      {busy && <Loader2 className="animate-spin" />} Abandon
    </Button>
  )
}

export function PullRequestLink({ url }: { url: string | null }) {
  if (!url) return <span>No PR</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
      PR #{url.split("/").pop()} <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  )
}
