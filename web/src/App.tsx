import { lazy, Suspense } from "react"
import { BrowserRouter, Link, Route, Routes } from "react-router"
import { AuthProvider, useAuth } from "@/api/auth-context"
import { ProjectsProvider } from "@/api/projects-context"
import { EmptyState } from "@/components/empty-state"
import { Layout } from "@/components/layout"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/hooks/use-theme"
import { IncidentPage, IncidentsPage } from "@/pages/incidents"
import { LoginPage } from "@/pages/login"
import { ImportProjectPage } from "@/pages/import-project"
import { NewProjectPage } from "@/pages/new-project"
import { ProjectsPage } from "@/pages/projects"
import { SettingsPage } from "@/pages/settings"

const ProjectPage = lazy(() => import("@/pages/project").then((module) => ({ default: module.ProjectPage })))

function NotFound() {
  return (
    <Card>
      <EmptyState title="This page does not exist">
        <Button asChild variant="outline" className="mt-3">
          <Link to="/">Back to projects</Link>
        </Button>
      </EmptyState>
    </Card>
  )
}

// Nothing below mounts before login, so no polling or EventSource runs into 401s.
function Dashboard() {
  const { status } = useAuth()
  if (status === "loading") return null
  if (status === "anonymous") return <LoginPage />
  return (
    <ProjectsProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<ProjectsPage />} />
            <Route path="new" element={<NewProjectPage />} />
            <Route path="import" element={<ImportProjectPage />} />
            <Route path="projects/:name/:phase?/:view?" element={
                <Suspense fallback={null}>
                  <ProjectPage />
                </Suspense>
              } />
            <Route path="incidents" element={<IncidentsPage />} />
            <Route path="incidents/:project/:id" element={<IncidentPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ProjectsProvider>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <Dashboard />
          <Toaster position="bottom-right" />
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
