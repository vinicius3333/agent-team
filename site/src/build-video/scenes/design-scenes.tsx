import { Smile } from "lucide-react"
import { FileChip, Pop, Rise } from "@/build-video/motion"

const screens = ["01-logo.png", "02-landing.png", "03-top-10.png"]

function ScreenSketch({ name, withLogo }: { name: string; withLogo: boolean }) {
  return (
    <div className="flex w-[150px] flex-col gap-2">
      <div className="flex h-[112px] flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
        {withLogo ? (
          <div className="m-auto grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Smile size={30} />
          </div>
        ) : (
          <>
            <div className="h-2.5 w-1/2 rounded bg-foreground/80" />
            <div className="h-2 w-3/4 rounded bg-muted-foreground/40" />
            <div className="mt-1 h-2 w-full rounded bg-muted" />
            <div className="h-2 w-full rounded bg-muted" />
            <div className="h-2 w-5/6 rounded bg-muted" />
            <div className="mt-auto h-4 w-16 rounded bg-primary" />
          </>
        )}
      </div>
      <div className="text-center font-mono text-[13px] text-muted-foreground">{name}</div>
    </div>
  )
}

export function BrandingScene() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-1 items-center justify-center gap-5 rounded-xl border border-border bg-muted/60">
        {screens.map((name, index) => (
          <Pop key={name} delay={index * 9}>
            <ScreenSketch name={name} withLogo={index === 0} />
          </Pop>
        ))}
      </div>
      <FileChip path="design/branding/README.md" delay={26} />
    </div>
  )
}

const swatches = [
  { role: "primary", hex: "#7C3AED" },
  { role: "ink", hex: "#0B0B10" },
  { role: "success", hex: "#15803D" },
  { role: "warning", hex: "#B45309" },
]

export function DesignScene() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-1 flex-col justify-center gap-7 rounded-xl border border-border bg-card px-6">
        <div className="flex justify-around">
          {swatches.map((swatch, index) => (
            <Pop key={swatch.role} delay={index * 4} className="flex flex-col items-center gap-1.5">
              <div className="size-14 rounded-xl border border-border" style={{ background: swatch.hex }} />
              <div className="font-mono text-[12px] text-muted-foreground">{swatch.hex}</div>
            </Pop>
          ))}
        </div>
        <Rise delay={16} className="flex items-center justify-between border-t border-border pt-4">
          <div className="flex items-baseline gap-3">
            <span className="text-[34px] font-bold">Aa</span>
            <span className="text-[15px] text-muted-foreground">Inter · JetBrains Mono</span>
          </div>
          <div className="flex gap-2">
            <span className="rounded-lg bg-primary px-4 py-2 text-[15px] font-medium text-primary-foreground">Post joke</span>
            <span className="rounded-lg border border-border px-4 py-2 text-[15px] font-medium">Cancel</span>
          </div>
        </Rise>
      </div>
      <div className="flex gap-2">
        <FileChip path="design/tokens.css" delay={24} />
        <FileChip path="docs/design-system.md" delay={28} />
      </div>
    </div>
  )
}
