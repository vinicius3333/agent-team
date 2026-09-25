import { CheckCircle2, CircleAlert, CircleDashed, CircleMinus, Clock, Loader2, PauseCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { humanize } from "@/lib/format"

type Tone = "success" | "running" | "warning" | "danger" | "neutral"

const toneClasses: Record<Tone, string> = {
  success: "bg-success/10 text-success border-success/20",
  running: "bg-primary/10 text-primary border-primary/20",
  warning: "bg-warning/10 text-warning border-warning/25",
  danger: "bg-destructive/10 text-destructive border-destructive/20",
  neutral: "bg-muted text-muted-foreground border-border",
}

const statusTones: Record<string, Tone> = {
  approved: "success",
  done: "success",
  merged: "success",
  live: "success",
  healthy: "success",
  pass: "success",
  running: "running",
  starting: "running",
  working: "running",
  planning: "running",
  building: "running",
  awaiting_approval: "warning",
  open: "warning",
  cooling: "warning",
  agent_failure: "warning",
  blocked: "danger",
  failed: "danger",
  fail: "danger",
  error: "danger",
  pending: "neutral",
  skipped: "neutral",
  abandoned: "neutral",
  stopped: "neutral",
  idle: "neutral",
  missing: "neutral",
}

export function toneOf(status: string): Tone {
  return statusTones[status] ?? "neutral"
}

function StatusIcon({ status }: { status: string }) {
  const className = "size-3.5"
  const tone = toneOf(status)
  if (status === "running" || status === "starting" || status === "working" || status === "planning" || status === "building") return <Loader2 className={cn(className, "animate-spin")} />
  if (status === "awaiting_approval") return <PauseCircle className={className} />
  if (status === "skipped") return <CircleMinus className={className} />
  if (status === "pending") return <Clock className={className} />
  if (tone === "success") return <CheckCircle2 className={className} />
  if (tone === "danger" || tone === "warning") return <CircleAlert className={className} />
  return <CircleDashed className={className} />
}

export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap", toneClasses[toneOf(status)], className)}>
      <StatusIcon status={status} />
      {label ?? humanize(status)}
    </span>
  )
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const colors: Record<Tone, string> = {
    success: "bg-success",
    running: "bg-primary animate-pulse",
    warning: "bg-warning",
    danger: "bg-destructive",
    neutral: "bg-muted-foreground/50",
  }
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", colors[toneOf(status)], className)} />
}
