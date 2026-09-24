import { useState } from "react"
import { Download, ImageIcon, Sparkles } from "lucide-react"
import { api, urls } from "@/api/client"
import { useAsync } from "@/api/hooks"
import type { MarketingFormat, MarketingManifest, MarketingPiece } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useProjectView } from "./context"

const formatLabels: Record<MarketingFormat, string> = { og: "Open Graph", square: "Square", story: "Story", x: "X" }

type RenderedFile = MarketingPiece["files"][number]

function downloadName(file: string): string {
  return file.split("/").pop() ?? file
}

// Browsers allow several downloads from one click when each link is clicked in turn.
function downloadAll(project: string, files: string[]) {
  for (const file of files) {
    const link = document.createElement("a")
    link.href = urls.raw(project, file)
    link.download = downloadName(file)
    link.click()
  }
}

function RenderedThumb({ project, file, onOpen }: { project: string; file: RenderedFile; onOpen: () => void }) {
  return (
    <figure className="flex w-fit min-w-0 flex-col gap-1.5">
      <button
        type="button"
        onClick={onOpen}
        className="self-start overflow-hidden rounded-md border bg-muted/40 transition hover:border-primary/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <img
          src={urls.raw(project, file.file)}
          alt={`${formatLabels[file.format]} piece`}
          loading="lazy"
          style={{ aspectRatio: `${file.width} / ${file.height}` }}
          className="h-36 w-auto object-cover"
        />
      </button>
      <figcaption className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-xs leading-tight">
          <span className="block font-medium">{formatLabels[file.format]}</span>
          <span className="text-muted-foreground tabular-nums">
            {file.width} × {file.height}
          </span>
        </span>
        <Button variant="outline" size="icon-sm" asChild>
          <a href={urls.raw(project, file.file)} download={downloadName(file.file)} aria-label={`Download ${downloadName(file.file)}`}>
            <Download />
          </a>
        </Button>
      </figcaption>
    </figure>
  )
}

function PieceCard({ project, piece, format, onOpen }: { project: string; piece: MarketingPiece; format: MarketingFormat | "all"; onOpen: (file: RenderedFile) => void }) {
  const files = piece.files.filter((file) => format === "all" || file.format === format)
  const stock = piece.image.source === "stock"
  return (
    <Card className="grid gap-4 p-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold capitalize">{piece.id.replace(/-/g, " ")}</h3>
          <Badge variant="secondary">
            {stock ? <ImageIcon /> : <Sparkles />}
            {stock ? "Stock photo" : "Generated"}
          </Badge>
        </div>
        <p className="text-lg leading-snug font-bold text-balance">{piece.headline}</p>
        <p className="text-sm text-muted-foreground">{piece.subtitle}</p>
        <Badge variant="outline" className="w-fit">
          CTA: {piece.cta}
        </Badge>
        <dl className="mt-1 grid gap-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline font-medium text-foreground">Problem: </dt>
            <dd className="inline">{piece.problem}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Why this image: </dt>
            <dd className="inline">{piece.image.reason}</dd>
          </div>
          {stock && (
            <div>
              <dt className="sr-only">Credit</dt>
              <dd>
                {piece.image.url ? (
                  <a href={piece.image.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
                    {piece.image.credit}
                  </a>
                ) : (
                  piece.image.credit
                )}{" "}
                · {piece.image.license}
              </dd>
            </div>
          )}
        </dl>
      </div>
      <div className="-mx-4 flex items-start gap-3 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
        {files.map((file) => (
          <RenderedThumb key={file.file} project={project} file={file} onOpen={() => onOpen(file)} />
        ))}
      </div>
    </Card>
  )
}

export function MarketingPieces({ version = "" }: { version?: string }) {
  const { name } = useProjectView()
  const [format, setFormat] = useState<MarketingFormat | "all">("all")
  const [open, setOpen] = useState<RenderedFile | null>(null)
  const { value, loading } = useAsync(async () => JSON.parse(await api.file(name, "marketing/manifest.json")) as MarketingManifest, [name, version])

  if (loading && value === null) return <Skeleton className="h-64 w-full rounded-xl" />
  if (!value?.pieces.length) {
    return (
      <Card>
        <EmptyState title="No marketing pieces yet">The marketer writes the copy after the design phase, and the orchestrator renders each piece in marketing/.</EmptyState>
      </Card>
    )
  }

  const formats = [...new Map(value.pieces.flatMap((piece) => piece.files).map((file) => [file.format, file])).values()]
  const allFiles = value.pieces.flatMap((piece) => piece.files).filter((file) => format === "all" || file.format === format)

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle>Marketing pieces</CardTitle>
          <CardDescription>
            {value.pieces.length} pieces · {formats.length} formats · language {value.language}
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => downloadAll(name, allFiles.map((file) => file.file))}>
              <Download /> Download {format === "all" ? "all" : formatLabels[format]}
            </Button>
          </CardAction>
        </CardHeader>
        <div className="-mb-1 overflow-x-auto px-4 pb-1">
          <ToggleGroup type="single" variant="outline" value={format} onValueChange={(next) => next && setFormat(next as MarketingFormat | "all")}>
            <ToggleGroupItem value="all" className="px-4">
              All
            </ToggleGroupItem>
            {formats.map((file) => (
              <ToggleGroupItem key={file.format} value={file.format} className="h-auto flex-col gap-0 px-4 py-1 text-xs leading-tight">
                <span className="font-medium">{formatLabels[file.format]}</span>
                <span className="text-muted-foreground tabular-nums">
                  {file.width} × {file.height}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </Card>
      {value.pieces.map((piece) => (
        <PieceCard key={piece.id} project={name} piece={piece} format={format} onOpen={setOpen} />
      ))}
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="max-h-[95vh] w-[calc(100vw-1rem)] max-w-5xl gap-3 p-3 sm:max-w-5xl sm:p-4">
          <DialogTitle className="pr-8 font-mono text-sm">{open && downloadName(open.file)}</DialogTitle>
          <DialogDescription className="sr-only">Rendered marketing piece.</DialogDescription>
          {open && (
            <>
              <div className="overflow-auto rounded-md border bg-muted/30" style={{ maxHeight: "calc(95vh - 8rem)" }}>
                <img src={urls.raw(name, open.file)} alt={`${formatLabels[open.format]} piece`} className="mx-auto h-auto max-h-[calc(95vh-9rem)] max-w-full" />
              </div>
              <Button variant="outline" size="sm" className="self-end" asChild>
                <a href={urls.raw(name, open.file)} download={downloadName(open.file)}>
                  <Download /> Download
                </a>
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
