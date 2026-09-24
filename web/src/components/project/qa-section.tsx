import { useState } from "react"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { api, urls } from "@/api/client"
import { useAsync } from "@/api/hooks"
import type { QaRound, QaRouteReport } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

const logoPattern = /^01-logo\./

// The designer names the branding image per screen; older designs do not, so fall back to matching the file name.
export function matchBranding(route: QaRouteReport, images: string[]): string {
  if (route.branding && images.includes(route.branding)) return route.branding
  const screens = images.filter((image) => !logoPattern.test(image))
  const bare = (image: string) => image.replace(/^\d+-/, "").replace(/\.\w+$/, "").toLowerCase()
  if (route.route === "/") return screens.find((image) => ["home", "dashboard", "landing", "index"].includes(bare(image))) ?? screens[0] ?? ""
  return screens.find((image) => bare(image) === route.slug) ?? screens.find((image) => bare(image).includes(route.slug) || route.slug.includes(bare(image))) ?? ""
}

function Framed({ label, src, alt }: { label: string; src: string | null; alt: string }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="truncate text-xs text-muted-foreground">{label}</figcaption>
      {src ? (
        <a href={src} target="_blank" rel="noopener noreferrer" className="block max-h-[28rem] overflow-y-auto rounded-md border bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <img src={src} alt={alt} loading="lazy" className="h-auto w-full" />
        </a>
      ) : (
        <div className="flex aspect-[16/10] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">No image</div>
      )}
    </figure>
  )
}

function RouteComparison({ name, round, route, image, brandingImages }: { name: string; round: number; route: QaRouteReport; image: string | null; brandingImages: string[] }) {
  const [branding, setBranding] = useState(() => matchBranding(route, brandingImages))
  const failed = Boolean(route.error) || (route.status ?? 0) >= 400
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex flex-wrap items-center gap-2 px-4">
        <CardTitle className="font-mono text-sm">{route.route}</CardTitle>
        <StatusBadge status={failed ? "failed" : "approved"} label={route.error ? "did not load" : `HTTP ${route.status ?? "?"}`} />
        {route.consoleErrors.length > 0 && <StatusBadge status="awaiting_approval" label={`${route.consoleErrors.length} console ${route.consoleErrors.length === 1 ? "error" : "errors"}`} />}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Compare with
          <select
            value={branding}
            onChange={(event) => setBranding(event.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <option value="">nothing</option>
            {brandingImages.map((file) => (
              <option key={file} value={file}>
                {file}
              </option>
            ))}
          </select>
        </label>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {route.error && <p className="text-sm text-destructive">{route.error}</p>}
        <div className="grid gap-3 md:grid-cols-2">
          <Framed label={`Screenshot · ${route.file ?? "none"}`} src={image ? urls.qaFile(name, round, image) : null} alt={`Screenshot of ${route.route}`} />
          <Framed label={branding ? `Branding · ${branding}` : "Branding · none selected"} src={branding ? urls.brandingImage(name, branding) : null} alt={branding ? `Branding image ${branding}` : ""} />
        </div>
        {route.consoleErrors.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Console errors</summary>
            <pre className="mt-1 overflow-x-auto rounded-md border bg-muted/40 p-2 whitespace-pre-wrap">{route.consoleErrors.join("\n")}</pre>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

function RoundView({ name, round, brandingImages }: { name: string; round: QaRound; brandingImages: string[] }) {
  const { verdict, tests, report } = round
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Round {round.round}</span>
        <StatusBadge status={verdict?.verdict ?? "running"} label={verdict ? undefined : "in progress"} />
        {verdict?.tasks.length ? <span className="text-muted-foreground">Fix tasks: {verdict.tasks.map((task) => task.id).join(", ")}</span> : null}
        {report && (
          <Button variant="ghost" size="sm" asChild className="ml-auto">
            <a href={urls.qaFile(name, round.round, "report.json")} target="_blank" rel="noopener noreferrer">
              report.json <ExternalLink />
            </a>
          </Button>
        )}
      </div>
      {verdict?.verdict === "invalid" && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>The QA agent gave no usable verdict</AlertTitle>
          <AlertDescription>{verdict.reason}</AlertDescription>
        </Alert>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Findings</h3>
        {verdict?.findings.length ? (
          <ul className="flex flex-col gap-2">
            {verdict.findings.map((finding, index) => (
              <li key={index} className="rounded-md border px-3 py-2 text-sm">
                <p className="font-medium">
                  {finding.screen && <code className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{finding.screen}</code>}
                  {finding.title}
                </p>
                {finding.detail && <p className="mt-1 text-muted-foreground">{finding.detail}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{verdict ? "No findings." : "The QA agent has not answered yet."}</p>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tests</h3>
        {tests ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={tests.passed ? "pass" : "fail"} label={tests.command ? (tests.passed ? "passed" : "failed") : "no test command"} />
              {tests.command && <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{tests.command}</code>}
            </div>
            <details open={!tests.passed} className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Output</summary>
              <pre className="mt-1 max-h-80 overflow-auto rounded-md border bg-muted/40 p-2 whitespace-pre-wrap">{tests.output}</pre>
            </details>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Not run yet.</p>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Screens</h3>
        {report?.startError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>The app did not start</AlertTitle>
            <AlertDescription>
              <pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap">{report.startError}</pre>
            </AlertDescription>
          </Alert>
        ) : report?.routes.length ? (
          report.routes.map((route) => (
            <RouteComparison
              key={`${round.round}-${route.route}`}
              name={name}
              round={round.round}
              route={route}
              image={route.file && round.images.includes(route.file) ? route.file : null}
              brandingImages={brandingImages}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{report ? "No routes." : "No screenshots: the target is api only, or they are still being taken."}</p>
        )}
      </section>
    </div>
  )
}

export function QaSection() {
  const { name, detail } = useProjectView()
  const phase = detail.phases.find((entry) => entry.name === "qa")
  const version = `${phase?.status ?? ""}-${phase?.updatedAt ?? ""}-${detail.qa?.round ?? ""}`
  const rounds = useAsync(() => api.qa(name), [name, version])
  const branding = useAsync(() => api.branding(name), [name])
  const [selected, setSelected] = useState<number | null>(null)

  if (rounds.loading && rounds.value === null) return <Skeleton className="h-48 w-full" />
  if (!rounds.value?.length) {
    return <EmptyState title="No QA rounds yet">After the build, QA runs the tests, screenshots every route, and compares them with the branding.</EmptyState>
  }
  const current = rounds.value.find((round) => round.round === selected) ?? rounds.value[0]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="QA rounds">
        {rounds.value.map((round) => (
          <Button key={round.round} size="sm" variant={round.round === current.round ? "secondary" : "outline"} aria-pressed={round.round === current.round} onClick={() => setSelected(round.round)}>
            Round {round.round}
            <span className={cn("size-2 rounded-full", round.verdict?.verdict === "pass" ? "bg-success" : round.verdict ? "bg-destructive" : "bg-primary")} aria-hidden="true" />
          </Button>
        ))}
      </div>
      <RoundView name={name} round={current} brandingImages={branding.value ?? []} />
    </div>
  )
}
