import { Check } from "lucide-react"
import { api, urls } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { EmptyState } from "@/components/empty-state"
import { Markdown } from "@/components/markdown"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

// One card per direction: the landing screen large, the logo small, and the style block. Clicking a card selects it.
export function ConceptPicker({ version, selected, onSelect }: { version: string; selected: string | null; onSelect?: (id: string) => void }) {
  const { name } = useProjectView()
  const { value, loading } = useAsync(() => api.concepts(name), [name, version])
  if (loading && value === null) return <Skeleton className="h-64 w-full" />
  if (!value?.concepts.length) return <EmptyState title="No directions yet">The illustrator saves them in design/concepts/.</EmptyState>
  const current = selected ?? value.choice
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Logo and style directions" className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {value.concepts.map((concept) => {
          const active = current === concept.id
          const landing = concept.images.find((image) => image.startsWith("landing")) ?? concept.images[0]
          const logo = concept.images.find((image) => image.startsWith("logo"))
          return (
            <button
              key={concept.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!onSelect}
              onClick={() => onSelect?.(concept.id)}
              className={cn(
                "group flex flex-col overflow-hidden rounded-lg border bg-card text-left transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none enabled:hover:border-primary/50",
                active && "border-primary ring-2 ring-primary/30",
              )}
            >
              {landing && <img src={urls.conceptImage(name, concept.id, landing)} alt={`Direction ${concept.id.toUpperCase()}: landing page`} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />}
              <span className="flex items-center gap-3 border-t p-3">
                {logo && <img src={urls.conceptImage(name, concept.id, logo)} alt={`Direction ${concept.id.toUpperCase()}: logo`} className="size-12 shrink-0 rounded-md border bg-white object-contain" />}
                <span className="min-w-0 flex-1 font-medium">Direction {concept.id.toUpperCase()}</span>
                {active && (
                  <span className="flex items-center gap-1 text-sm text-primary">
                    <Check className="size-4" aria-hidden="true" /> Chosen
                  </span>
                )}
              </span>
              {concept.style && <Markdown text={concept.style} className="max-h-40 overflow-y-auto border-t px-3 py-2 text-xs text-muted-foreground" />}
            </button>
          )
        })}
      </div>
      {value.readme && (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">What the illustrator says about each direction</summary>
          <Markdown text={value.readme} className="mt-2" />
        </details>
      )}
    </div>
  )
}
