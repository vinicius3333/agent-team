import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router"
import { Check, ChevronRight, LogOut, PanelLeftClose, PanelLeftOpen, Plus, Settings, Stethoscope } from "lucide-react"
import { useAuth } from "@/api/auth-context"
import { api } from "@/api/client"
import { useProjectList } from "@/api/projects-context"
import type { ProjectSummary } from "@/api/types"
import { Logo } from "@/components/logo"
import { StatusDot } from "@/components/status-badge"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { useProjectRoute, type ProjectRoute } from "@/hooks/use-project-route"
import { currentPhase, phaseLabels, phaseProgress, phaseViews, projectPath, projectPhases, type ProjectPhase } from "@/lib/navigation"
import { projectStatus } from "@/lib/pipeline"
import { cn } from "@/lib/utils"

// Desktop keeps the shadcn sizes; the mobile sheet gets 40px touch targets.
const touchButton = "h-10 md:h-8"
const touchSubButton = "h-10 md:h-7"

function projectPhase(project: ProjectSummary): ProjectPhase {
  return currentPhase({ ...project, deployed: project.live })
}

function initials(name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2)
  return letters.toUpperCase()
}

function viewBadge(project: ProjectSummary, view: string): number {
  if (view === "next-steps") return project.openFindings ?? 0
  if (view === "tasks") return project.counts.blocked ?? 0
  return 0
}

function PhaseIcon({ phase, current }: { phase: ProjectPhase; current: ProjectPhase }) {
  if (phase === "system") return <Settings className="size-3.5 text-muted-foreground" aria-hidden="true" />
  const progress = phaseProgress(phase, current)
  if (progress === "done") return <Check className="size-3.5 text-success" aria-label="Done" />
  if (progress === "current") return <span className="mx-1 size-2 shrink-0 rounded-full bg-primary" aria-label="Current phase" />
  return <span className="mx-1 size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden="true" />
}

function PhaseTree({ project, route, current }: { project: ProjectSummary; route: ProjectRoute; current: ProjectPhase }) {
  const activePhase = route.phase ?? current
  const [openPhases, setOpenPhases] = useState<Set<ProjectPhase>>(() => new Set([activePhase]))
  const toggle = (phase: ProjectPhase) =>
    setOpenPhases((previous) => {
      const next = new Set(previous)
      if (next.has(phase)) next.delete(phase)
      else next.add(phase)
      return next
    })

  return (
    <SidebarMenuSub className="mr-0 pr-0">
      {projectPhases.map((phase) => {
        const future = phaseProgress(phase, current) === "future" && phase !== "system"
        return (
          <Collapsible key={phase} asChild open={openPhases.has(phase)} onOpenChange={() => toggle(phase)}>
            <SidebarMenuSubItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuSubButton asChild size="sm" className={cn(touchSubButton, "font-medium tracking-wide uppercase", future && "text-muted-foreground")}>
                  <button type="button" className="group/phase w-full">
                    <ChevronRight className="size-3.5! transition-transform group-data-[state=open]/phase:rotate-90" aria-hidden="true" />
                    <PhaseIcon phase={phase} current={current} />
                    <span>{phaseLabels[phase]}</span>
                  </button>
                </SidebarMenuSubButton>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 ml-3 flex flex-col gap-1">
                  {phaseViews[phase].map((view) => {
                    const badge = viewBadge(project, view.id)
                    return (
                      <SidebarMenuSubItem key={view.id}>
                        <SidebarMenuSubButton asChild isActive={route.phase === phase && route.view === view.id} className={touchSubButton}>
                          <Link to={projectPath(project.name, phase, view.id)}>
                            <view.icon />
                            <span className="flex-1">{view.label}</span>
                            {badge > 0 && (
                              <span className="ml-auto rounded-md bg-primary/10 px-1.5 text-xs font-medium text-primary tabular-nums" aria-label={`${badge} ${view.id === "tasks" ? "blocked" : "open"}`}>
                                {badge}
                              </span>
                            )}
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )
                  })}
                </ul>
              </CollapsibleContent>
            </SidebarMenuSubItem>
          </Collapsible>
        )
      })}
    </SidebarMenuSub>
  )
}

function ProjectTree({ projects, route }: { projects: ProjectSummary[]; route: ProjectRoute | null }) {
  return (
    <SidebarMenu>
      {projects.map((project) => {
        const expanded = route?.name === project.name
        const current = projectPhase(project)
        return (
          <Collapsible key={project.name} asChild open={expanded}>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={expanded && !route?.phase} className={touchButton}>
                <Link to={projectPath(project.name)} aria-expanded={expanded}>
                  <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} aria-hidden="true" />
                  <StatusDot status={projectStatus(project)} />
                  <span>{project.name}</span>
                </Link>
              </SidebarMenuButton>
              <CollapsibleContent>{route && expanded && <PhaseTree key={route.phase ?? current} project={project} route={route} current={current} />}</CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        )
      })}
    </SidebarMenu>
  )
}

function ProjectRail({ projects, route }: { projects: ProjectSummary[]; route: ProjectRoute | null }) {
  const active = projects.find((project) => project.name === route?.name)
  const phase = active ? (route?.phase ?? projectPhase(active)) : null
  return (
    <>
      <SidebarMenu>
        {projects.map((project) => (
          <SidebarMenuItem key={project.name}>
            <SidebarMenuButton asChild isActive={project.name === route?.name} tooltip={project.name}>
              <Link to={projectPath(project.name)}>
                <span className="relative flex size-full items-center justify-center text-[0.65rem] font-semibold">
                  {initials(project.name)}
                  <StatusDot status={projectStatus(project)} className="absolute right-0 bottom-0 size-1.5" />
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
      {active && phase && (
        <>
          <SidebarSeparator className="my-2" />
          <SidebarMenu>
            {phaseViews[phase].map((view) => {
              const badge = viewBadge(active, view.id)
              return (
                <SidebarMenuItem key={view.id}>
                  <SidebarMenuButton asChild isActive={route?.phase === phase && route?.view === view.id} tooltip={`${phaseLabels[phase]} / ${view.label}`}>
                    <Link to={projectPath(active.name, phase, view.id)} className="relative">
                      <view.icon />
                      <span className="sr-only">{view.label}</span>
                    </Link>
                  </SidebarMenuButton>
                  {badge > 0 && (
                    <span className="pointer-events-none absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[0.6rem] font-semibold text-primary-foreground" aria-label={`${badge}`}>
                      {badge}
                    </span>
                  )}
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </>
      )}
    </>
  )
}

export function AppSidebar() {
  const { projects, online } = useProjectList()
  const { mode, source, refresh } = useAuth()
  const canLogOut = mode.includes("password") && source === "session"
  const logOut = async () => {
    try {
      await api.logout()
    } finally {
      await refresh()
    }
  }
  const { pathname, search } = useLocation()
  const { state, isMobile, toggleSidebar, setOpenMobile } = useSidebar()
  const route = useProjectRoute()
  const rail = state === "collapsed" && !isMobile
  const openIncidents = (projects ?? []).filter((project) => project.incident).length

  useEffect(() => setOpenMobile(false), [pathname, search, setOpenMobile])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className={cn("flex-row items-center justify-between gap-2", rail ? "flex-col px-2 py-3" : "px-4 py-4")}>
        <Link to="/" aria-label="agent-team home" className="rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <Logo className={rail ? "[&>span]:hidden" : undefined} />
        </Link>
        {!isMobile && (
          <Button variant="ghost" size="icon" className="size-8" onClick={toggleSidebar} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} title={rail ? "Expand sidebar" : "Collapse sidebar"}>
            {rail ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel asChild>
            <Link to="/" className="tracking-wide uppercase hover:text-sidebar-foreground">
              Projects
            </Link>
          </SidebarGroupLabel>
          <SidebarGroupAction asChild title="New project">
            <Link to="/new" aria-label="New project">
              <Plus />
            </Link>
          </SidebarGroupAction>
          <SidebarGroupContent>
            {projects === null && online ? (
              <SidebarMenu>
                {[0, 1, 2].map((index) => (
                  <SidebarMenuItem key={index}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : rail ? (
              <ProjectRail projects={projects ?? []} route={route} />
            ) : (
              <ProjectTree projects={projects ?? []} route={route} />
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname.startsWith("/incidents")} tooltip="Incidents" className={touchButton}>
              <Link to="/incidents">
                <Stethoscope />
                <span>Incidents</span>
              </Link>
            </SidebarMenuButton>
            {openIncidents > 0 && (
              <SidebarMenuBadge className="top-2.5 md:top-1.5" aria-label={`${openIncidents} open`}>
                {openIncidents}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === "/settings"} tooltip="Settings" className={touchButton}>
              <Link to="/settings">
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center justify-between gap-2 px-2 py-1 group-data-[collapsible=icon]:hidden">
          <div className="flex items-center gap-2 text-sm" role="status">
            <StatusDot status={online ? "live" : "failed"} className={online ? "" : "animate-none"} />
            <div className="leading-tight">
              <div className="font-medium">Self-hosted</div>
              <div className="text-xs text-muted-foreground">{online ? "Connected" : "Server unreachable"}</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {canLogOut && (
              <Button variant="ghost" size="icon" className="size-10 md:size-8" onClick={() => void logOut()} aria-label="Log out" title="Log out">
                <LogOut />
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
