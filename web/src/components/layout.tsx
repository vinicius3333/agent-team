import { Link, Outlet } from "react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { Logo } from "@/components/logo"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"

export function Layout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur md:hidden">
          <SidebarTrigger aria-label="Open menu" />
          <Link to="/" aria-label="agent-team home">
            <Logo className="[&_span]:text-base" />
          </Link>
        </header>
        <main className="mx-auto w-full max-w-7xl min-w-0 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
