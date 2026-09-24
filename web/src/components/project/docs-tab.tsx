import { useMemo, useState } from "react"
import { Expand, FileText, PanelRight } from "lucide-react"
import { api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { pinnedDocuments } from "@/lib/pipeline"
import { cn } from "@/lib/utils"
import { DocumentView } from "./document-view"
import { useProjectView } from "./context"

export function DocsTab({ path, onSelect }: { path: string; onSelect: (path: string) => void }) {
  const { name, detail, openPanel } = useProjectView()
  const [reader, setReader] = useState(false)
  const lastEvent = detail.events.at(-1)?.id ?? 0
  const { value: markdownFiles } = useAsync(() => api.markdownFiles(name), [name, Math.floor(lastEvent / 5)])
  const files = useMemo(() => {
    const extra = (markdownFiles ?? []).filter((file) => !pinnedDocuments.includes(file))
    return { pinned: pinnedDocuments, extra }
  }, [markdownFiles])
  const version = detail.phases.map((phase) => phase.updatedAt).join("|")

  const fileButton = (file: string) => (
    <li key={file}>
      <button
        type="button"
        onClick={() => onSelect(file)}
        aria-current={file === path ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          file === path && "bg-accent font-medium text-accent-foreground",
        )}
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate" title={file}>
          {file}
        </span>
      </button>
    </li>
  )

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="lg:hidden">
        <Label htmlFor="doc-picker" className="mb-2">
          Document
        </Label>
        <select id="doc-picker" value={path} onChange={(event) => onSelect(event.target.value)} className="h-9 w-full rounded-md border bg-card px-3 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          {files.pinned.map((file) => (
            <option key={file}>{file}</option>
          ))}
          {files.extra.length > 0 && (
            <optgroup label="All Markdown files">
              {files.extra.map((file) => (
                <option key={file}>{file}</option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <Card className="hidden h-fit py-3 lg:flex">
        <CardContent className="px-2">
          <nav aria-label="Documents">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Pipeline</p>
            <ul>{files.pinned.map(fileButton)}</ul>
            {files.extra.length > 0 && (
              <>
                <p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">All Markdown files</p>
                <ul>{files.extra.map(fileButton)}</ul>
              </>
            )}
          </nav>
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-sm font-medium break-all">{path}</h2>
            <div className="flex gap-2">
              {/\.md$/i.test(path) && (
                <Button variant="outline" size="sm" onClick={() => openPanel({ kind: "doc", id: path })}>
                  <PanelRight /> Open in panel
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setReader(true)}>
                <Expand /> Expand
              </Button>
            </div>
          </div>
          <DocumentView key={path} path={path} version={version} />
        </CardContent>
      </Card>
      <Dialog open={reader} onOpenChange={setReader}>
        <DialogContent className="flex h-[95vh] w-[calc(100vw-1rem)] max-w-5xl flex-col gap-3 sm:max-w-5xl">
          <DialogTitle className="pr-8 font-mono text-sm break-all">{path}</DialogTitle>
          <DialogDescription className="sr-only">Document reader</DialogDescription>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <DocumentView path={path} version={version} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
