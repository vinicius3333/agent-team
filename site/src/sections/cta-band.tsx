import { Download } from "lucide-react"
import { PixelCluster } from "@/components/pixel-art"
import { repositoryUrl } from "@/components/site-header"

export function CtaBand() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
      <div className="relative flex flex-col items-center gap-6 overflow-hidden rounded-3xl border border-primary/20 bg-accent/70 px-6 py-12 text-center md:flex-row md:justify-between md:px-12 md:text-left">
        <PixelCluster className="-top-4 -left-6 w-24 opacity-70" />
        <h2 className="relative font-mono text-2xl font-bold tracking-tight text-balance sm:text-3xl">Write the brief. Approve the gates. Ship the app.</h2>
        <a
          href={`${repositoryUrl}#install`}
          className="relative inline-flex shrink-0 items-center gap-2.5 rounded-xl bg-primary px-6 py-3.5 font-mono font-medium text-primary-foreground shadow-[0_12px_30px_-12px_rgb(124_58_237/0.7)] hover:bg-primary/90"
        >
          <Download size={18} /> Install agent-team
        </a>
      </div>
    </section>
  )
}
