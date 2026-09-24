import { useState } from "react"
import { Loader2, Pencil } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { ProjectConfig } from "@/api/types"
import { EmptyState } from "@/components/empty-state"
import { invalidRoles, pickEditable, RoleModelsEditor, type RoleModels } from "@/components/role-models-editor"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { planningPhases } from "@/api/types"
import { stepLabels } from "@/lib/pipeline"
import { LeadSettingsCard } from "./lead-settings-card"
import { useProjectView } from "./context"

function EditModelsDialog({ config }: { config: ProjectConfig }) {
  const { name, detail } = useProjectView()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<RoleModels>({})
  const [saving, setSaving] = useState(false)
  const fallbacks = Object.fromEntries(Object.entries(config.roles).map(([role, value]) => [role, value.fallbacks]))
  const invalid = invalidRoles(models).length > 0

  const changeOpen = (next: boolean) => {
    if (next) setModels(pickEditable(config.roles))
    setOpen(next)
  }
  const save = async () => {
    setSaving(true)
    try {
      await api.saveRoles(name, models)
      toast.success("Models saved. The next run uses them.")
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the models.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil /> Edit models
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit agent models</DialogTitle>
          <DialogDescription>Changes apply to the next run. Saving commits pipeline.yaml to the project repo.</DialogDescription>
        </DialogHeader>
        {detail.active && <p className="rounded-md bg-warning/10 p-2 text-sm text-warning">A run is in progress. Wait until it stops to save.</p>}
        <RoleModelsEditor value={models} fallbacks={fallbacks} onChange={setModels} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || invalid || detail.active}>
            {saving && <Loader2 className="animate-spin" />} Save models
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function templateLabel(template: NonNullable<ProjectConfig["template"]>): string {
  const newer = template.latest !== null && template.latest > template.version ? ` (v${template.latest} available)` : ""
  return `${template.name} template v${template.version}${newer}`
}

export function ConfigTab() {
  const { detail } = useProjectView()
  const config = detail.config
  if (!config) {
    return (
      <Card>
        <EmptyState title="No readable pipeline.yaml">The server could not parse this project's pipeline.yaml.</EmptyState>
      </Card>
    )
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="gap-3">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="grid gap-1.5">
              <CardTitle>Roles and models</CardTitle>
              <CardDescription>From pipeline.yaml. Fallbacks run in order when the main model hits a limit.</CardDescription>
            </div>
            <EditModelsDialog config={config} />
          </div>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Runner and model</TableHead>
                <TableHead className="hidden sm:table-cell">Fallbacks</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Max tries</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(config.roles).map(([role, value]) => (
                <TableRow key={role}>
                  <TableCell className="font-medium">{role}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {value.runner} {value.model}
                    {value.fallbacks.length > 0 && <div className="text-muted-foreground sm:hidden">then {value.fallbacks.map((fallback) => `${fallback.runner} ${fallback.model}`).join(", ")}</div>}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{value.fallbacks.length ? value.fallbacks.map((fallback) => `${fallback.runner} ${fallback.model}`).join(" → ") : "none"}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{value.maxRetries ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="h-fit gap-3">
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Target</dt>
            <dd className="font-mono">{config.target}</dd>
            <dt className="text-muted-foreground">Stack</dt>
            <dd>{config.template ? templateLabel(config.template) : "Custom (architect chooses)"}</dd>
            <dt className="text-muted-foreground">Gates</dt>
            <dd className="flex flex-wrap gap-1">
              {config.gates.length ? planningPhases.filter((phase) => config.gates.includes(phase)).map((phase) => <Badge key={phase} variant="secondary">{stepLabels[phase]}</Badge>) : "none, fully autonomous"}
            </dd>
            <dt className="text-muted-foreground">Branding</dt>
            <dd>{config.branding?.enabled === false ? "off" : `on${config.branding?.count ? `, ${config.branding.count} images` : ""}`}</dd>
            <dt className="text-muted-foreground">GitHub</dt>
            <dd>{config.publish.github.enabled ? "on" : "off"}</dd>
          </dl>
        </CardContent>
      </Card>
      <LeadSettingsCard />
    </div>
  )
}
