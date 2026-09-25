import { useState } from "react"
import { CircleAlert, FileText, Info, Loader2, MessageSquare, PauseCircle, Play, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { Markdown } from "@/components/markdown"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { phaseDocuments, stepLabels } from "@/lib/pipeline"
import type { PipelineStep } from "@/api/types"
import { StatusBadge } from "@/components/status-badge"
import { DocumentView } from "./document-view"
import { ProjectBranding } from "./branding"
import { ConceptPicker } from "./concept-picker"
import { DesignSystemPreview } from "./design-system-preview"
import { MarketingPieces } from "./marketing-tab"
import { useProjectView } from "./context"

const feedbackLimit = 4000

function PlanOutput() {
  const { detail, openPanel } = useProjectView()
  const changeId = detail.change?.id
  const tasks = changeId ? detail.tasks.filter((task) => task.change === changeId) : detail.tasks
  if (changeId && !tasks.length) return <p className="text-sm text-muted-foreground">The planner added no tasks: the change needs no code.</p>
  if (!tasks.length) return <DocumentView path="tasks.json" />
  return (
    <ol className="flex flex-col divide-y rounded-md border">
      {tasks.map((task) => (
        <li key={task.id}>
          <button type="button" className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={() => openPanel({ kind: "task", id: task.id })}>
            <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{task.title}</span>
              {task.acceptance.length > 0 && <span className="text-xs text-muted-foreground">{task.acceptance.length} acceptance criteria</span>}
            </span>
            {task.dependsOn.length > 0 && <span className="text-xs text-muted-foreground">after {task.dependsOn.join(", ")}</span>}
          </button>
        </li>
      ))}
    </ol>
  )
}

function PhaseOutputs({ phase, version, onSuggest, choice, onChoose }: { phase: string; version: string; onSuggest: (text: string) => void; choice: string | null; onChoose: (id: string) => void }) {
  const { detail } = useProjectView()
  const delta = phase === "spec" ? detail.change?.specDelta : phase === "architecture" ? detail.change?.architectureDelta : null
  const documents = phaseDocuments[phase] ?? []
  const showBranding = phase === "branding" || phase === "design"
  const tabs = [
    ...(phase === "concepts" ? [{ id: "concepts", label: "Directions" }] : []),
    ...(delta ? [{ id: "change-delta", label: `${detail.change?.id} delta` }] : []),
    ...(phase === "design" ? [{ id: "design-system", label: "Design system" }] : []),
    ...(showBranding ? [{ id: "branding", label: "Branding" }] : []),
    ...(phase === "marketing" ? [{ id: "marketing", label: "Pieces" }] : []),
    ...documents.map((path) => ({ id: path, label: path.split("/").pop() ?? path })),
  ]
  if (!tabs.length) return null
  return (
    <Tabs defaultValue={tabs[0].id}>
      {tabs.length > 1 && (
        <TabsList className="max-w-full overflow-x-auto">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
      {phase === "concepts" && (
        <TabsContent value="concepts">
          <ConceptPicker version={version} selected={choice} onSelect={onChoose} />
        </TabsContent>
      )}
      {delta && (
        <TabsContent value="change-delta">
          <Markdown text={delta} />
        </TabsContent>
      )}
      {phase === "design" && (
        <TabsContent value="design-system">
          <DesignSystemPreview version={version} onSuggest={onSuggest} />
        </TabsContent>
      )}
      {showBranding && (
        <TabsContent value="branding">
          <ProjectBranding version={version} />
        </TabsContent>
      )}
      {phase === "marketing" && (
        <TabsContent value="marketing">
          <MarketingPieces version={version} />
        </TabsContent>
      )}
      {documents.map((path) => (
        <TabsContent key={path} value={path}>
          {path === "tasks.json" ? <PlanOutput /> : <DocumentView path={path} version={version} />}
        </TabsContent>
      ))}
    </Tabs>
  )
}

export function GatePanel({ phase }: { phase: string }) {
  const { name, detail } = useProjectView()
  const [message, setMessage] = useState("")
  const [choice, setChoice] = useState<string | null>(null)
  const needsChoice = phase === "concepts"
  const [busy, setBusy] = useState<"approve" | "feedback" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const label = stepLabels[phase as PipelineStep] ?? phase
  const pending = detail.feedback?.[phase]
  const version = detail.phases.find((entry) => entry.name === phase)?.updatedAt ?? ""

  const approve = async () => {
    if (needsChoice && !choice) {
      setError("Choose a direction first.")
      return
    }
    setBusy("approve")
    setError(null)
    try {
      const { started } = await api.approve(name, phase, needsChoice ? (choice ?? undefined) : undefined)
      if (started) toast.success(`${label} approved. The build continues.`)
      else toast.warning(`${label} approved, but a run is still active. Resume the run once it stops.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approval failed.")
    } finally {
      setBusy(null)
    }
  }

  const requestChanges = async () => {
    if (!message.trim()) {
      setError("Write what the agents should change.")
      return
    }
    setBusy("feedback")
    setError(null)
    try {
      const { started } = await api.feedback(name, phase, message.trim())
      setMessage("")
      if (started) toast.success(`Feedback sent. The ${label.toLowerCase()} step runs again.`)
      else toast.warning("Feedback saved, but a run is still active. Resume the run once it stops.")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send feedback.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="gate-title" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="min-w-0 border-warning/40">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <FileText className="size-5 text-muted-foreground" aria-hidden="true" /> Review the {label.toLowerCase()} output
            {detail.change && <span className="font-mono text-sm text-muted-foreground">for change {detail.change.id}</span>}
          </CardTitle>
          <CardDescription>Read what the agents wrote, then approve it or ask for changes.</CardDescription>
        </CardHeader>
        <CardContent>
          <PhaseOutputs phase={phase} version={version} choice={choice} onChoose={(id) => { setChoice(id); setError(null) }} onSuggest={(text) => setMessage((current) => (current.trim() ? `${current.trim()}\n\n${text}` : text).slice(0, feedbackLimit))} />
        </CardContent>
      </Card>
      <Card className="h-fit border-warning/40 lg:sticky lg:top-4">
        <CardHeader>
          <CardTitle id="gate-title" className="flex items-center justify-between gap-2 text-xl">
            {label} approval
            <StatusBadge status="awaiting_approval" label="Waiting" />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-3 text-sm">
            <li className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <span className="font-medium">Gate after {label.toLowerCase()}</span>
                <span className="block text-muted-foreground">You asked to review this step.</span>
              </span>
            </li>
            <li className="flex gap-3">
              <PauseCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <span>
                <span className="font-medium">The build is paused</span>
                <span className="block text-muted-foreground">The agents wait for your decision.</span>
              </span>
            </li>
          </ul>
          {pending && (
            <Alert>
              <MessageSquare />
              <AlertTitle>Feedback waiting for the agents</AlertTitle>
              <AlertDescription>
                <Markdown text={pending} className="max-h-48 w-full overflow-y-auto text-xs" />
              </AlertDescription>
            </Alert>
          )}
          <Separator />
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="gate-feedback">Feedback</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {message.length} / {feedbackLimit}
              </span>
            </div>
            <Textarea
              id="gate-feedback"
              value={message}
              maxLength={feedbackLimit}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Tell the agents what to change…"
              className="min-h-28"
              aria-describedby="gate-feedback-help"
            />
            <p id="gate-feedback-help" className="text-xs text-muted-foreground">
              Only needed when you request changes.
            </p>
          </div>
          {error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2">
            <Button size="lg" onClick={approve} disabled={busy !== null || (needsChoice && !choice)}>
              {busy === "approve" ? <Loader2 className="animate-spin" /> : <Play />} {needsChoice ? (choice ? `Approve direction ${choice.toUpperCase()}` : "Choose a direction") : "Approve"}
            </Button>
            <Button size="lg" variant="outline" onClick={requestChanges} disabled={busy !== null}>
              {busy === "feedback" ? <Loader2 className="animate-spin" /> : <MessageSquare />} Request changes
            </Button>
          </div>
          <p className="flex gap-2 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" aria-hidden="true" /> Approve resumes the build. Request changes reruns this step with your feedback.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
