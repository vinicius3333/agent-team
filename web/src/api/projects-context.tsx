import { createContext, useContext, type ReactNode } from "react"
import { useProjects } from "@/api/hooks"

type ProjectsContextValue = ReturnType<typeof useProjects>

const ProjectsContext = createContext<ProjectsContextValue | null>(null)

export function ProjectsProvider({ children }: { children: ReactNode }) {
  return <ProjectsContext.Provider value={useProjects()}>{children}</ProjectsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useProjectList(): ProjectsContextValue {
  const value = useContext(ProjectsContext)
  if (!value) throw new Error("useProjectList must be used inside ProjectsProvider")
  return value
}
