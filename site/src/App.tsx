import { Download, Star } from "lucide-react"
import { useState } from "react"
import { BuildPlayer } from "@/build-video/build-player"
import type { RoleName } from "@/build-video/stages"
import { BriefCard } from "@/components/brief-card"
import { FlowArrow } from "@/components/flow-arrow"
import { PixelField } from "@/components/pixel-field"
import { RoleOrbit } from "@/components/role-orbit"
import { repositoryUrl, SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { ControlSection } from "@/sections/control-section"
import { CtaBand } from "@/sections/cta-band"
import { InstallSection } from "@/sections/install-section"
import { PipelineSection } from "@/sections/pipeline-section"
import { RunnersSection } from "@/sections/runners-section"

function Hero() {
  const [activeRoles, setActiveRoles] = useState<RoleName[]>([])

  return (
    <section className="relative">
      <PixelField className="inset-x-0 -top-20 bottom-0 h-[calc(100%+5rem)] w-full" />
      <div className="relative mx-auto flex max-w-[1400px] flex-col items-center px-4 pt-10 pb-20 sm:px-6 lg:pt-14">
        <h1 className="text-center font-mono text-4xl font-bold tracking-tight text-balance sm:text-5xl lg:text-6xl">From a paragraph to a pull request.</h1>
        <p className="mt-5 max-w-2xl text-center text-lg text-balance text-muted-foreground sm:text-xl">
          agent-team turns a plain-text brief into a tested web app. A team of AI agents plans it, builds the tasks in parallel, and reviews each one.
        </p>

        <div className="mt-12 grid w-full items-center gap-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,300px)_auto_minmax(0,1.25fr)] lg:gap-2">
          <BriefCard />
          <FlowArrow className="mx-auto rotate-90 lg:rotate-0" />
          <RoleOrbit activeRoles={activeRoles} />
          <FlowArrow className="mx-auto rotate-90 lg:rotate-0" />
          <BuildPlayer onActiveRolesChange={setActiveRoles} />
        </div>

        <div className="mt-12 flex flex-col gap-3 sm:flex-row">
          <a
            href="#install"
            className="inline-flex items-center justify-center gap-2.5 rounded-lg bg-primary px-6 py-3 font-mono font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download size={18} /> Install agent-team
          </a>
          <a
            href={repositoryUrl}
            className="inline-flex items-center justify-center gap-2.5 rounded-lg border border-border bg-card px-6 py-3 font-mono font-medium hover:bg-muted"
          >
            <Star size={18} /> Star on GitHub
          </a>
        </div>
        <p className="mt-6 font-mono text-sm text-muted-foreground">MIT licensed · Node 22.18+ · Docker</p>
      </div>
    </section>
  )
}

export function App() {
  return (
    <div className="overflow-x-clip">
      <SiteHeader />
      <main>
        <Hero />
        <PipelineSection />
        <ControlSection />
        <RunnersSection />
        <InstallSection />
        <CtaBand />
      </main>
      <SiteFooter />
    </div>
  )
}
