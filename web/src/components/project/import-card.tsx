import { useState } from "react"
import { AlertTriangle, CheckCircle2, Download, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { api, urls } from "@/api/client"
import type { ImportBaseline } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

// Matches routeSlug in src/qa.ts: the baseline stores each route's screenshot as design/branding/<slug>.png.
function routeSlug(route: string): string {
  return route.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"
}

function brokenRoute(route: ImportBaseline["routes"][number]): boolean {
  return Boolean(route.error) || (route.status ?? 0) >= 400
}

function Stat({ ok, title, value, lines }: { ok: boolean; title: string; value: string; lines: string[] }) {
  const Icon = ok ? CheckCircle2 : AlertTriangle
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <span className="flex items-center gap-2 text-sm font-medium">
        <Icon className={cn("size-4", ok ? "text-success" : "text-warning")} aria-hidden="true" /> {title}
      </span>
      <span className="text-sm">{value}</span>
      {lines.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {lines.slice(0, 5).map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
          {lines.length > 5 && <li>and {lines.length - 5} more</li>}
        </ul>
      )}
    </div>
  )
}

function BaselineStats({ baseline }: { baseline: ImportBaseline }) {
  const broken = baseline.routes.filter(brokenRoute)
  const failingTests = baseline.tests.failing
  const testsValue = !baseline.tests.command ? "No test command" : baseline.tests.passed ? "All tests pass" : failingTests.length ? `${failingTests.length} failing` : "The test run failed"
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat ok={baseline.app.started} title="App starts" value={baseline.app.started ? "Install and start worked" : "The app did not start"} lines={baseline.app.error ? [baseline.app.error.slice(0, 200)] : []} />
      <Stat ok={baseline.tests.passed} title="Tests" value={testsValue} lines={failingTests} />
      <Stat
        ok={!broken.length}
        title="Routes"
        value={baseline.routes.length ? `${baseline.routes.length - broken.length} of ${baseline.routes.length} load` : "No routes captured"}
        lines={broken.map((route) => `${route.route}: ${route.error ?? `HTTP ${route.status}`}`)}
      />
    </div>
  )
}

function CleanupSuggestion({ request }: { request: string }) {
  const { name, detail } = useProjectView()
  const [busy, setBusy] = useState<"start" | "dismiss" | null>(null)
  const act = async (action: "start" | "dismiss") => {
    setBusy(action)
    try {
      if (action === "start") {
        const { id, started } = await api.startCleanup(name)
        if (started) toast.success(`Cleanup change ${id} opened. The team is planning it.`)
        else toast.warning(`Cleanup change ${id} opened, but a run is still active. Resume the run once it stops.`)
      } else {
        await api.dismissCleanup(name)
        toast.success("Cleanup suggestion dismissed")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not work.")
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-accent p-4 text-accent-foreground sm:flex-row sm:items-center">
      <Sparkles className="size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Suggested cleanup change</p>
        <p className="line-clamp-3 text-sm whitespace-pre-wrap">{request.split("\n").slice(2).join("\n")}</p>
        <p className="mt-1 text-xs">It starts only when you choose. Later changes pass QA with these problems in place.</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button onClick={() => act("start")} disabled={busy !== null || !detail.canRequestChange}>
          {busy === "start" && <Loader2 className="animate-spin" />} Start cleanup change
        </Button>
        <Button variant="outline" onClick={() => act("dismiss")} disabled={busy !== null}>
          {busy === "dismiss" && <Loader2 className="animate-spin" />} Dismiss
        </Button>
      </div>
    </div>
  )
}

export function ImportCard() {
  const { name, detail } = useProjectView()
  const imported = detail.import
  if (!imported) return null
  const { baseline } = imported
  const screenshots = baseline?.routes.filter((route) => !route.error) ?? []
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="size-5" aria-hidden="true" /> {imported.done ? (baseline?.failures.length ? "Imported with warnings" : "Imported") : "Importing"}
        </CardTitle>
        <CardDescription className="break-all">
          From <span className="font-mono">{imported.source}</span>
          {imported.urls.length > 0 && <> · reads {imported.urls.join(", ")}</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {baseline ? <BaselineStats baseline={baseline} /> : <p className="text-sm text-muted-foreground">The baseline runs after the design step. It runs the tests and screenshots every route.</p>}
        {screenshots.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {screenshots.map((route) => (
              <li key={route.route} className="flex flex-col gap-1">
                <img src={urls.brandingImage(name, `${routeSlug(route.route)}.png`)} alt={`Screenshot of ${route.route}`} loading="lazy" className="aspect-[16/10] w-full rounded-md border bg-muted object-cover object-top" onError={(event) => (event.currentTarget.style.visibility = "hidden")} />
                <span className={cn("truncate font-mono text-xs", brokenRoute(route) ? "text-destructive" : "text-muted-foreground")}>{route.route}</span>
              </li>
            ))}
          </ul>
        )}
        {imported.cleanup && <CleanupSuggestion request={imported.cleanup} />}
      </CardContent>
    </Card>
  )
}
