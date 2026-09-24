import { matchPath, useLocation } from "react-router"
import { isPhase, type ProjectPhase } from "@/lib/navigation"

export interface ProjectRoute {
  name: string
  phase: ProjectPhase | null
  view: string | null
}

export function useProjectRoute(): ProjectRoute | null {
  const { pathname } = useLocation()
  const match = matchPath("/projects/:name/:phase?/:view?", pathname)
  if (!match?.params.name) return null
  const phase = isPhase(match.params.phase) ? match.params.phase : null
  return { name: match.params.name, phase, view: match.params.view ?? null }
}
