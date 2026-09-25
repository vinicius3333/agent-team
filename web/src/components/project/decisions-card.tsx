import { useState } from "react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useProjectView } from "./context"

// autonomy.autoApproveScope for an existing project: the run reads it at its next decision.
export function DecisionsCard({ enabled }: { enabled: boolean }) {
  const { name } = useProjectView()
  const [value, setValue] = useState(enabled)
  const [saving, setSaving] = useState(false)
  const change = async (next: boolean) => {
    setSaving(true)
    setValue(next)
    try {
      await api.setAutoApproveScope(name, next)
      toast.success(next ? "Scope requests are approved automatically." : "Scope requests wait for you.")
    } catch (error) {
      setValue(!next)
      toast.error(error instanceof Error ? error.message : "Could not save the setting.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Decisions</CardTitle>
        <CardDescription>What the build decides on its own.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-3">
          <Switch id="auto-approve-scope" checked={value} disabled={saving} onCheckedChange={(next) => void change(next)} aria-describedby="auto-approve-scope-help" />
          <div className="grid gap-0.5">
            <Label htmlFor="auto-approve-scope">Approve scope requests automatically</Label>
            <p id="auto-approve-scope-help" className="text-xs text-muted-foreground">
              When a task needs files outside its scope, it gets them and the build keeps going, as if you clicked Approve. After two such approvals on one task, it asks you. Budget and other decisions still wait for you.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
