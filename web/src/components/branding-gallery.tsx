import { useState } from "react"
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react"
import { urls } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export function BrandingGallery({ project, images, className }: { project: string; images: string[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null)
  const current = open === null ? null : images[open]
  const step = (delta: number) => setOpen((index) => (index === null ? null : (index + delta + images.length) % images.length))

  return (
    <>
      <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3", className)}>
        {images.map((image, index) => (
          <button
            key={image}
            type="button"
            onClick={() => setOpen(index)}
            className="group overflow-hidden rounded-lg border bg-muted/40 text-left transition hover:border-primary/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <img src={urls.brandingImage(project, image)} alt={`Branding image ${image}`} loading="lazy" className="aspect-[16/10] w-full object-cover object-top transition group-hover:opacity-90" />
            <span className="block truncate border-t px-3 py-2 font-mono text-xs text-muted-foreground">
              {image} <span className="text-muted-foreground/70">({index + 1}/{images.length})</span>
            </span>
          </button>
        ))}
      </div>
      <Dialog open={current !== null} onOpenChange={(value) => !value && setOpen(null)}>
        <DialogContent
          className="max-h-[95vh] w-[calc(100vw-1rem)] max-w-6xl gap-3 p-3 sm:max-w-6xl sm:p-4"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") step(1)
            if (event.key === "ArrowLeft") step(-1)
          }}
        >
          <DialogTitle className="pr-8 font-mono text-sm">{current}</DialogTitle>
          <DialogDescription className="sr-only">Branding image. Use the arrow keys to see the next or previous image.</DialogDescription>
          {current && (
            <div className="overflow-auto rounded-md border bg-muted/30" style={{ maxHeight: "calc(95vh - 8rem)" }}>
              <img src={urls.brandingImage(project, current)} alt={`Branding image ${current}`} className="mx-auto h-auto max-w-full" />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => step(-1)} disabled={images.length < 2}>
                <ChevronLeft /> Previous
              </Button>
              <Button variant="outline" size="sm" onClick={() => step(1)} disabled={images.length < 2}>
                Next <ChevronRight />
              </Button>
            </div>
            {current && (
              <Button variant="ghost" size="sm" asChild>
                <a href={urls.brandingImage(project, current)} target="_blank" rel="noopener noreferrer">
                  Open image <ExternalLink />
                </a>
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
