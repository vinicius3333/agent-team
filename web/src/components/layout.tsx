import { Link, Outlet } from "react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { Logo } from "@/components/logo"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { useProjectRoute } from "@/hooks/use-project-route"
import { findView } from "@/lib/navigation"

// The shadcn sidebar writes this cookie but does not read it back.
function sidebarOpenFromCookie(): boolean {
  return !document.cookie.split("; ").includes("sidebar_state=false")
}

function MobileTitle() {
  const route = useProjectRoute()
  if (!route) {
    return (
      <Link to="/" aria-label="agent-team home">
        <Logo className="[&_span]:text-base" />
      </Link>
    )
  }
  const view = route.phase ? findView(route.phase, route.view ?? undefined)?.label : null
  return (
    <p className="flex min-w-0 items-center gap-1 text-sm">
      <span className="truncate font-semibold">{route.name}</span>
      {view && (
        <>
          <span className="text-muted-foreground" aria-hidden="true">/</span>
          <span className="shrink-0 text-muted-foreground">{view}</span>
        </>
      )}
    </p>
  )
}

export function Layout() {
  return (
    <SidebarProvider defaultOpen={sidebarOpenFromCookie()}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur md:hidden">
          <SidebarTrigger aria-label="Open menu" className="size-10" />
          <MobileTitle />
        </header>
        <main className="mx-auto w-full max-w-7xl min-w-0 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
