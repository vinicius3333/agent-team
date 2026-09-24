import { useState } from "react"
import { FileText } from "lucide-react"
import { api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { CopyButton } from "@/components/copy-button"
import { extractHeadings, Markdown } from "@/components/markdown"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { prettyJson } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

export function useDocument(name: string, path: string, version: string) {
  return useAsync(() => api.file(name, path), [name, path, version])
}

export function DocumentBody({ path, text, compact = false }: { path: string; text: string; compact?: boolean }) {
  const { name, showDocument } = useProjectView()
  const [mode, setMode] = useState<"rendered" | "source">("rendered")
  const isMarkdown = /\.md$/i.test(path)
  const headings = isMarkdown && !compact ? extractHeadings(text) : []

  if (!isMarkdown) {
    return (
      <div className="relative">
        <div className="absolute top-2 right-2">
          <CopyButton value={text} label="Copy file" />
        </div>
        <pre className="max-h-[70vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{path.endsWith(".json") ? prettyJson(text) : text}</pre>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(value) => value && setMode(value as "rendered" | "source")} aria-label="View mode">
          <ToggleGroupItem value="rendered" className="px-3">
            Rendered
          </ToggleGroupItem>
          <ToggleGroupItem value="source" className="px-3">
            Source
          </ToggleGroupItem>
        </ToggleGroup>
        <CopyButton value={text} label="Copy Markdown" />
      </div>
      {mode === "source" ? (
        <pre className="overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text}</pre>
      ) : (
        <div className={cn("grid gap-6", headings.length > 2 && "lg:grid-cols-[12rem_minmax(0,1fr)]")}>
          {headings.length > 2 && (
            <nav aria-label="Contents" className="hidden lg:block">
              <div className="sticky top-4 max-h-[70vh] overflow-y-auto border-l pl-3 text-sm">
                <p className="mb-2 font-medium">Contents</p>
                <ul className="flex flex-col gap-1">
                  {headings.map((heading, index) => (
                    <li key={`${heading.id}-${index}`} style={{ paddingLeft: `${(heading.level - 1) * 0.75}rem` }}>
                      <a
                        href={`#md-${heading.id}`}
                        onClick={(event) => {
                          event.preventDefault()
                          document.getElementById(`md-${heading.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                        }}
                        className="line-clamp-2 text-muted-foreground hover:text-foreground"
                      >
                        {heading.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          )}
          <Markdown text={text || "_Empty document._"} project={name} path={path} onOpenDocument={showDocument} className="min-w-0" />
        </div>
      )}
    </div>
  )
}

export function DocumentView({ path, version = "", compact = false }: { path: string; version?: string; compact?: boolean }) {
  const { name } = useProjectView()
  const { value, error, loading } = useDocument(name, path, version)
  if (loading && value === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    )
  }
  if (error || value === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <FileText className="size-4" aria-hidden="true" /> Not written yet ({path}).
      </p>
    )
  }
  return <DocumentBody path={path} text={value} compact={compact} />
}
