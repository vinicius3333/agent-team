import { Link, NavLink, useLocation } from "react-router"
import { FolderKanban, Globe, Plus, Settings } from "lucide-react"
import { useProjectList } from "@/api/projects-context"
import { Logo } from "@/components/logo"
import { StatusDot } from "@/components/status-badge"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar"
import { projectStatus, projectStatusLabels } from "@/lib/pipeline"

const mainLinks = [
  { to: "/", label: "Projects", icon: FolderKanban, end: true },
  { to: "/new", label: "New project", icon: Plus, end: true },
  { to: "/settings", label: "Settings", icon: Settings, end: true },
]

export function AppSidebar() {
  const { projects, online } = useProjectList()
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const close = () => setOpenMobile(false)

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-4">
        <Link to="/" onClick={close} className="rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <Logo />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainLinks.map((link) => (
                <SidebarMenuItem key={link.to}>
                  <SidebarMenuButton asChild isActive={link.to === "/" ? pathname === "/" : pathname.startsWith(link.to)}>
                    <NavLink to={link.to} end={link.end} onClick={close}>
                      <link.icon />
                      <span>{link.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Recent projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects === null && online
                ? [0, 1, 2].map((index) => (
                    <SidebarMenuItem key={index}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))
                : (projects ?? []).map((project) => {
                    const status = projectStatus(project)
                    const path = `/projects/${encodeURIComponent(project.name)}`
                    return (
                      <SidebarMenuItem key={project.name}>
                        <SidebarMenuButton asChild isActive={pathname === path} className="h-auto py-1.5">
                          <NavLink to={path} onClick={close}>
                            <StatusDot status={status} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{project.name}</span>
                              <span className="block truncate text-xs text-muted-foreground">{project.current ?? projectStatusLabels[status]}</span>
                            </span>
                          </NavLink>
                        </SidebarMenuButton>
                        {project.live && (
                          <SidebarMenuBadge title={project.liveUrl ? `Live at ${project.liveUrl}` : "Live"}>
                            <Globe className="size-3.5 text-success" aria-label="Live" />
                          </SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    )
                  })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <div className="flex items-center gap-2 text-sm" role="status">
            <StatusDot status={online ? "live" : "failed"} className={online ? "" : "animate-none"} />
            <div className="leading-tight">
              <div className="font-medium">Self-hosted</div>
              <div className="text-xs text-muted-foreground">{online ? "Connected" : "Server unreachable"}</div>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
