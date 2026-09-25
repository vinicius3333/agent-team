import type { ReactNode } from "react"

export function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <span className="flex items-center gap-2 font-mono text-xs font-medium tracking-[0.14em] text-primary uppercase">
        <span className="size-2 bg-primary" aria-hidden="true" />
        {eyebrow}
      </span>
      <h2 className="font-mono text-4xl font-bold tracking-tight text-balance sm:text-5xl">{title}</h2>
      <p className="text-lg leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}
