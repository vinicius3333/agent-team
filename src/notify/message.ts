import { keyFailureLines } from "../pipeline.ts"
import type { Notification, NotificationKind, ProjectEvent, Severity } from "./events.ts"

export interface Message {
  kind: NotificationKind | "test" | "digest"
  severity: Severity
  project: string
  title: string
  body: string
  url: string | null
  at: string
  eventId: number | null
  costUsd: number | null
}

export interface MessageContext {
  dashboardUrl: string | null
  costUsd: number | null
}

export const titleMaxLength = 80
export const bodyMaxLength = 500

// Phases whose output is one document open the Docs tab on it; the others have their own tab.
const phaseLinks: Record<string, string> = {
  spec: "tab=docs&doc=docs/spec.md",
  architecture: "tab=docs&doc=docs/architecture.md",
  design: "tab=docs&doc=docs/design.md",
  branding: "tab=branding",
  marketing: "tab=marketing",
  plan: "tab=overview",
}

// Header values in fetch must be Latin-1, so the ellipsis is three dots.
export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function failureBody(reason: string): string {
  const [first, ...rest] = reason.trim().split("\n")
  const details = rest.length ? keyFailureLines(rest.join("\n"), 5) : ""
  return details ? `${first}\n${details}` : first
}

function projectLink(dashboardUrl: string | null, project: string, query = ""): string | null {
  if (!dashboardUrl) return null
  return `${dashboardUrl}/projects/${encodeURIComponent(project)}${query ? `?${query}` : ""}`
}

function describe(project: string, notification: Notification, dashboardUrl: string | null): { line: string; body: string; url: string | null } {
  const { reason } = notification
  switch (notification.kind) {
    case "gate": {
      const phase = notification.phase ?? "a phase"
      return { line: `${phase} is ready for review`, body: "Approve or request changes.", url: projectLink(dashboardUrl, project, phaseLinks[phase] ?? "") }
    }
    case "budget":
      return { line: "run budget reached", body: failureBody(reason), url: projectLink(dashboardUrl, project) }
    case "qa_failed":
      return { line: "QA stopped after failed rounds", body: failureBody(reason), url: projectLink(dashboardUrl, project, "tab=qa") }
    case "paused":
      return { line: "run paused", body: failureBody(reason), url: projectLink(dashboardUrl, project) }
    case "failed":
      return { line: "run failed", body: failureBody(reason), url: projectLink(dashboardUrl, project) }
    case "stopped":
      return { line: "run stopped", body: "Stopped by Ctrl+C, the dashboard, or a service restart.", url: projectLink(dashboardUrl, project) }
    case "finished":
      return { line: "run completed", body: "The run finished.", url: projectLink(dashboardUrl, project) }
    case "live":
      return { line: "app is live", body: `Live at ${notification.liveUrl}. The password is on the dashboard.`, url: projectLink(dashboardUrl, project) }
    case "incident": {
      const gaveUp = notification.severity === "action"
      const url = dashboardUrl && notification.incidentId ? `${dashboardUrl}/incidents/${encodeURIComponent(project)}/${encodeURIComponent(notification.incidentId)}` : null
      return { line: gaveUp ? "the doctor gave up on an incident" : "the doctor opened an incident", body: failureBody(reason), url }
    }
  }
}

export function buildMessage(project: string, notification: Notification, event: ProjectEvent, context: MessageContext): Message {
  const { line, body, url } = describe(project, notification, context.dashboardUrl)
  return {
    kind: notification.kind,
    severity: notification.severity,
    project,
    title: truncate(`${project}: ${line}`, titleMaxLength),
    body: truncate(body, bodyMaxLength),
    url,
    at: event.at,
    eventId: event.id,
    costUsd: context.costUsd,
  }
}

export function buildDigest(project: string, messages: Message[], context: MessageContext, now: Date): Message {
  const lines = messages.map((message) => `- ${message.title.slice(project.length + 2)}`)
  return {
    kind: "digest",
    severity: messages.some((message) => message.severity === "action") ? "action" : "info",
    project,
    title: truncate(`${project}: ${messages.length} updates`, titleMaxLength),
    body: truncate(lines.join("\n"), bodyMaxLength),
    url: projectLink(context.dashboardUrl, project),
    at: now.toISOString(),
    eventId: messages.at(-1)?.eventId ?? null,
    costUsd: context.costUsd,
  }
}

export function buildTestMessage(dashboardUrl: string | null, now: Date): Message {
  return {
    kind: "test",
    severity: "info",
    project: "agent-team",
    title: "agent-team: test notification",
    body: "This channel works. You will get a message here when a run needs you.",
    url: dashboardUrl,
    at: now.toISOString(),
    eventId: null,
    costUsd: null,
  }
}
