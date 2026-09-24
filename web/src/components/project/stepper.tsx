import { Check, CircleMinus, Loader2, PauseCircle, X } from "lucide-react"
import { Card } from "@/components/ui/card"
import { stepLabels, stepStates, type StepStatus } from "@/lib/pipeline"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

const circleClasses: Record<StepStatus, string> = {
  approved: "bg-success text-success-foreground border-success",
  done: "bg-success text-success-foreground border-success",
  running: "bg-primary text-primary-foreground border-primary",
  awaiting_approval: "bg-warning text-warning-foreground border-warning",
  failed: "bg-destructive text-white border-destructive",
  skipped: "bg-muted text-muted-foreground border-border",
  pending: "bg-card text-muted-foreground border-border",
}

const noteClasses: Record<StepStatus, string> = {
  approved: "text-success",
  done: "text-success",
  running: "text-primary",
  awaiting_approval: "text-warning",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  pending: "text-muted-foreground",
}

function StepIcon({ status, index }: { status: StepStatus; index: number }) {
  if (status === "approved" || status === "done") return <Check className="size-4" />
  if (status === "running") return <Loader2 className="size-4 animate-spin" />
  if (status === "awaiting_approval") return <PauseCircle className="size-4" />
  if (status === "failed") return <X className="size-4" />
  if (status === "skipped") return <CircleMinus className="size-4" />
  return <span className="text-xs font-medium">{index + 1}</span>
}

export function PipelineStepper() {
  const { detail, openPanel } = useProjectView()
  const steps = stepStates(detail)
  return (
    <Card className="overflow-x-auto p-0">
      <ol className="flex min-w-max items-start px-2 py-4 sm:min-w-0" aria-label="Pipeline">
        {steps.map((state, index) => (
          <li key={state.step} className="relative flex flex-1 justify-center">
            {index < steps.length - 1 && (
              <span aria-hidden="true" className={cn("absolute top-4 left-[calc(50%+1.25rem)] h-px w-[calc(100%-2.5rem)]", state.status === "approved" || state.status === "done" || state.status === "skipped" ? "bg-success/50" : "bg-border")} />
            )}
            <button
              type="button"
              onClick={() => openPanel({ kind: "phase", id: state.step })}
              className="group flex w-20 flex-col items-center gap-1 rounded-md px-1 py-0.5 text-center focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:w-24"
              aria-label={`${stepLabels[state.step]}: ${state.note || state.status.replaceAll("_", " ")}. Show details`}
            >
              <span className={cn("flex size-8 items-center justify-center rounded-full border-2 transition group-hover:scale-105", circleClasses[state.status])}>
                <StepIcon status={state.status} index={index} />
              </span>
              <span className="text-xs font-medium sm:text-sm">{stepLabels[state.step]}</span>
              <span className={cn("text-[11px] leading-tight sm:text-xs", noteClasses[state.status])}>{state.note || "waiting"}</span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  )
}
