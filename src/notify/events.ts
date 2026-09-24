import type { RunStop } from "../pipeline.ts"

// The pipeline logs these exact phrases, and the notifier matches on them.
export const gateReadyText = "is ready for review"
export const budgetReachedPrefix = "run budget reached"
export const qaStoppedPrefix = "stopped after"
export const interruptPrefix = "interrupt received"
export const incidentOpenedPrefix = "opened incident"
export const incidentGaveUpText = "gave up"
export const changeOpenedPrefix = "opened change"
export const changeMergedPrefix = "merged change"
// Logged when a change stops before its final merge: manual merge mode or a conflict with main.
export const changeWaitingText = "waits for a merge"

// A paused run with this reason waits for a runner cooldown; the doctor resumes it.
export const cooldownPattern = /cooling down|no runner available|rate_limit/i

export const notificationKinds = ["gate", "budget", "qa_failed", "paused", "failed", "stopped", "finished", "live", "incident", "change"] as const
export type NotificationKind = (typeof notificationKinds)[number]
export type Severity = "action" | "info"

export interface ProjectEvent {
  id: number
  at: string
  type: string
  message: string
}

export interface Notification {
  kind: NotificationKind
  severity: Severity
  reason: string
  phase?: string
  liveUrl?: string
  incidentId?: string
  changeId?: string
}

export interface MappingContext {
  cooldowns: boolean
  // True when an "interrupt received" event came after the last "finished:" event.
  interrupted: boolean
}

const gatePattern = new RegExp(`^phase "([a-z]+)" ${gateReadyText}`)
const livePattern = /^live at (\S+?)(?:;|$)/
const incidentOpenedPattern = new RegExp(`^${incidentOpenedPrefix} (\\S+): (.*)`, "s")
const changePattern = new RegExp(`^(?:${changeOpenedPrefix} (C\\d+)|${changeMergedPrefix} (C\\d+)|change (C\\d+) ${changeWaitingText})`)
const incidentGaveUpPattern = new RegExp(`^incident (\\S+): ${incidentGaveUpText}: (.*)`, "s")

export function notificationFor(event: ProjectEvent, stop: RunStop | null, context: MappingContext): Notification | null {
  const { type, message } = event
  if (type === "gate") {
    const phase = gatePattern.exec(message)?.[1]
    return phase ? { kind: "gate", severity: "action", reason: message, phase } : null
  }
  if (type === "budget" && message.startsWith(budgetReachedPrefix)) return { kind: "budget", severity: "action", reason: message }
  if (type === "qa" && message.startsWith(qaStoppedPrefix)) return { kind: "qa_failed", severity: "action", reason: message }
  if (type === "deploy") {
    const liveUrl = livePattern.exec(message)?.[1]
    return liveUrl ? { kind: "live", severity: "info", reason: liveUrl, liveUrl } : null
  }
  if (type === "doctor") {
    const opened = incidentOpenedPattern.exec(message)
    if (opened) return { kind: "incident", severity: "info", reason: opened[2], incidentId: opened[1] }
    const gaveUp = incidentGaveUpPattern.exec(message)
    if (gaveUp) return { kind: "incident", severity: "action", reason: `gave up: ${gaveUp[2]}`, incidentId: gaveUp[1] }
    return null
  }
  if (type === "change") {
    const match = changePattern.exec(message)
    if (!match) return null
    const waiting = Boolean(match[3])
    return { kind: "change", severity: waiting ? "action" : "info", reason: message, changeId: match[1] ?? match[2] ?? match[3] }
  }
  if (type !== "run") return null
  if (message.startsWith(interruptPrefix)) return { kind: "stopped", severity: "info", reason: message }
  if (message === "finished: completed") return { kind: "finished", severity: "info", reason: "completed" }
  // A stop by the operator already sent "stopped"; the pause or failure it causes is not news.
  if (context.interrupted) return null
  const reason = stop?.reason ?? "no reason recorded"
  if (message === "finished: failed") return { kind: "failed", severity: "action", reason }
  if (message === "finished: paused") {
    if (cooldownPattern.test(reason) && !context.cooldowns) return null
    return { kind: "paused", severity: "action", reason }
  }
  return null
}
