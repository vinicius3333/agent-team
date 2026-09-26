import { useState } from "react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { planningPhases, type PlanningPhase } from "@/api/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { gateHints, stepLabels } from "@/lib/pipeline"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

// autonomy.gates for an existing project: the run reads it when the next planning phase finishes.
export function GatesCard({ gates, branding }: { gates: PlanningPhase[]; branding: boolean }) {
  const { name } = useProjectView()
  const [value, setValue] = useState(gates)
  const [saving, setSaving] = useState(false)
  const change = async (phase: PlanningPhase, checked: boolean) => {
    const previous = value
    const next = checked ? [...value, phase] : value.filter((gate) => gate !== phase)
    setSaving(true)
    setValue(next)
    try {
      await api.setGates(name, next)
      toast.success(checked ? `The build pauses after ${stepLabels[phase].toLowerCase()}.` : `${stepLabels[phase]} no longer waits for you.`)
    } catch (error) {
      setValue(previous)
      toast.error(error instanceof Error ? error.message : "Could not save the gates.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approval gates</CardTitle>
        <CardDescription>The build pauses after each checked step until you approve it. A step already waiting for you still needs your approval.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {planningPhases.map((phase) => {
          const unavailable = !branding && (phase === "branding" || phase === "concepts")
          return (
            <div key={phase} className={cn("flex items-start gap-3", unavailable && "opacity-50")}>
              <Checkbox
                id={`project-gate-${phase}`}
                checked={value.includes(phase)}
                disabled={saving || unavailable}
                onCheckedChange={(checked) => void change(phase, checked === true)}
                aria-describedby={`project-gate-${phase}-help`}
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={`project-gate-${phase}`}>After {stepLabels[phase].toLowerCase()}</Label>
                <p id={`project-gate-${phase}-help`} className="text-xs text-muted-foreground">
                  {gateHints[phase]}
                </p>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
