import { changeRequestMaxLength, openChange, ProjectError } from "../project.ts"
import type { Change, Finding, Store } from "../store.ts"

export function findingRequest(finding: Finding): string {
  return `${finding.title}\n\n${finding.proposal}\n\nWhy: ${finding.evidence}\n`
}

function openFinding(store: Store, id: number): Finding {
  const finding = Number.isInteger(id) ? store.finding(id) : null
  if (!finding) throw new ProjectError(404, `unknown finding "${id}"`)
  if (finding.status !== "open") throw new ProjectError(409, `Finding ${id} is already ${finding.status}.`)
  return finding
}

// Throws what openChange throws (a run is alive, a change is open, the build is not done), and then leaves the finding open.
export function approveFinding(projectDir: string, store: Store, id: number): Change {
  const finding = openFinding(store, id)
  const change = openChange(projectDir, store, findingRequest(finding))
  store.setFindingStatus(finding.id, "approved", change.id)
  store.log("operate", `finding ${finding.id} approved as change ${change.id}: ${finding.title}`)
  return change
}

export const approveFindingsMax = 20

// Each item's title and proposal, then the trail back to the backlog. Trims the item text, never the trail.
export function findingsRequest(picked: Finding[]): string {
  const trail = ["Backlog items:", ...picked.map((item) => `- #${item.id} [${item.source}, ${item.severity}] ${item.title}`)].join("\n")
  const text = picked.map((item) => `${item.title}\n\n${item.proposal}`).join("\n\n")
  const room = changeRequestMaxLength - trail.length - 2
  const body = text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text
  return `${body}\n\n${trail}`
}

// Checks every id before it opens one change, so a bad id or a refused change leaves every item open.
export function approveFindings(projectDir: string, store: Store, ids: unknown): Change {
  if (!Array.isArray(ids) || ids.length === 0) throw new ProjectError(400, "Pick at least one backlog item.")
  if (ids.length > approveFindingsMax) throw new ProjectError(400, `Pick at most ${approveFindingsMax} backlog items at once.`)
  if (!ids.every((id) => Number.isInteger(id))) throw new ProjectError(400, "Every id must be a whole number.")
  const unique = [...new Set(ids as number[])]
  const picked = unique.map((id) => openFinding(store, id))
  const change = openChange(projectDir, store, findingsRequest(picked))
  for (const item of picked) store.setFindingStatus(item.id, "approved", change.id)
  store.log("operate", `findings ${picked.map((item) => item.id).join(", ")} approved as change ${change.id}`)
  return change
}

export function dismissFinding(store: Store, id: number): void {
  const finding = openFinding(store, id)
  store.setFindingStatus(finding.id, "dismissed")
  store.log("operate", `finding ${finding.id} dismissed: ${finding.title}`)
}
