import { createContext, useContext } from "react"
import type { ProjectDetail } from "@/api/types"

export const panelKinds = ["task", "phase", "event", "runner", "container"] as const
export type PanelKind = (typeof panelKinds)[number]

export interface Panel {
  kind: PanelKind
  id: string
}

export interface TranscriptRequest {
  file: string
  subject: string
  role: string
  runner: string
  model: string
}

export interface ProjectView {
  name: string
  detail: ProjectDetail
  openPanel: (panel: Panel) => void
  closePanel: () => void
  openTranscript: (request: TranscriptRequest) => void
  showDocument: (path: string) => void
  showTab: (tab: string) => void
}

export const ProjectViewContext = createContext<ProjectView | null>(null)

export function useProjectView(): ProjectView {
  const value = useContext(ProjectViewContext)
  if (!value) throw new Error("useProjectView must be used inside the project page")
  return value
}
