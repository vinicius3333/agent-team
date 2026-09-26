import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeFailure } from "./replan.ts"

export type IncidentStatus = "open" | "diagnosing" | "fixed" | "gave_up"
export type IncidentKind = "failed" | "paused" | "stalled" | "crashed"
export const incidentCauses = ["agent_team_bug", "project_state", "external", "unknown"] as const
export type IncidentCause = (typeof incidentCauses)[number]

export interface IncidentAction {
  at: string
  action: string
  detail: string
}

export interface Incident {
  id: string
  project: string
  fingerprint: string
  kind: IncidentKind
  reason: string
  // The task id or planning phase the stop names, used to pick transcripts and to see the run move past it.
  subject: string | null
  status: IncidentStatus
  attempts: number
  costUsd: number
  // Missing in incidents saved before token tracking.
  tokens?: number
  diagnosis: string | null
  cause: IncidentCause | null
  actions: IncidentAction[]
  branch: string | null
  prUrl: string | null
  issueUrl: string | null
  createdAt: string
  updatedAt: string
  resumedAt: string | null
  succeededAt: string | null
  closedAt: string | null
  // Missing in incidents saved before the doctor merged its own pull requests.
  mergedAt?: string | null
  // Why the doctor stopped trying to merge; a person merges from here.
  mergeError?: string | null
  // The commit on main that carries the fix; the issue closes once the live install matches it.
  mergeCommit?: string | null
}

export const incidentIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

export function incidentsDir(projectDir: string): string {
  return join(projectDir, ".agent-team", "incidents")
}

export function incidentId(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-")
}

// The same stop, told apart from a new one: times, durations, temp paths, and dollar amounts removed.
export function fingerprint(kind: string, reason: string): string {
  const firstLine = reason.trim().split("\n")[0] ?? ""
  const normalized = normalizeFailure(firstLine).replace(/\$\d+(?:\.\d+)?/g, "<usd>")
  return `${kind}:${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`
}

export function subjectOf(reason: string): string | null {
  const task = /\b([A-Z]{1,3}\d{2,4}[a-z]?)\b/.exec(reason)?.[1]
  if (task) return task
  return /^(spec|architecture|branding|design|marketing|plan|deploy)\b/.exec(reason.trim())?.[1] ?? (/^QA round/.test(reason.trim()) ? "qa" : null)
}

export function listIncidents(projectDir: string): Incident[] {
  const dir = incidentsDir(projectDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => incidentIdPattern.test(file.replace(/\.json$/, "")) && file.endsWith(".json"))
    .sort()
    .reverse()
    .map((file) => readIncident(projectDir, file.replace(/\.json$/, "")))
    .filter((incident): incident is Incident => incident !== null)
}

export function readIncident(projectDir: string, id: string): Incident | null {
  if (!incidentIdPattern.test(id)) return null
  const path = join(incidentsDir(projectDir), `${id}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Incident
  } catch {
    return null
  }
}

// Written to a temporary file first, so the dashboard never reads half a record.
export function saveIncident(projectDir: string, incident: Incident): Incident {
  const dir = incidentsDir(projectDir)
  mkdirSync(dir, { recursive: true })
  incident.updatedAt = new Date().toISOString()
  const path = join(dir, `${incident.id}.json`)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(incident, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return incident
}

export function openIncident(projectDir: string): Incident | null {
  return listIncidents(projectDir).find((incident) => incident.status === "open" || incident.status === "diagnosing") ?? null
}
