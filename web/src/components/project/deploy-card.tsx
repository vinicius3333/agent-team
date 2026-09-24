import { ExternalLink, Globe } from "lucide-react"
import { CopyButton } from "@/components/copy-button"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { deployState } from "@/lib/pipeline"
import { useProjectView } from "./context"

export function DeployCard() {
  const { detail, openPanel } = useProjectView()
  const deploy = detail.deploy
  const state = deployState(detail)
  if (!deploy || (deploy.status === "missing" && state.status === "pending")) return null
  const label = state.note || deploy.status
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-5" aria-hidden="true" /> Live deployment
        </CardTitle>
        <CardAction>
          <StatusBadge status={deploy.status === "live" ? "live" : state.status} label={label} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {deploy.url ? (
          <div className="flex items-center gap-1">
            <a href={deploy.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-mono text-sm text-primary hover:underline">
              {deploy.url}
            </a>
            <CopyButton value={deploy.url} label="Copy live URL" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No public URL yet.</p>
        )}
        {detail.access && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="truncate font-mono">{detail.access.email}</dd>
            <CopyButton value={detail.access.email} label="Copy demo email" />
            <dt className="text-muted-foreground">Password</dt>
            <dd className="truncate font-mono">{detail.access.password}</dd>
            <CopyButton value={detail.access.password} label="Copy demo password" />
          </dl>
        )}
        <div className="flex flex-wrap gap-2">
          {deploy.url && (
            <Button asChild size="sm">
              <a href={deploy.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Open app
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => openPanel({ kind: "phase", id: "deploy" })}>
            Deploy details
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
