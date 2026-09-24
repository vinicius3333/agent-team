import { openChange, ProjectError } from "../project.ts"
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

export function dismissFinding(store: Store, id: number): void {
  const finding = openFinding(store, id)
  store.setFindingStatus(finding.id, "dismissed")
  store.log("operate", `finding ${finding.id} dismissed: ${finding.title}`)
}
