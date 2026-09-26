import { useState } from "react"
import { Loader2, Settings } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { SprintSettings } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useProjectView } from "@/components/project/context"

const intervalPresets = [3, 7, 14, 30]
const customInterval = "custom"

type Draft = Omit<SprintSettings, "everyDays" | "budgetUsd" | "monthlyUsd" | "maxItems"> & { everyDays: string; budgetUsd: string; monthlyUsd: string; maxItems: string }

function toDraft(settings: SprintSettings): Draft {
  return { ...settings, everyDays: String(settings.everyDays), budgetUsd: String(settings.budgetUsd), monthlyUsd: String(settings.monthlyUsd), maxItems: String(settings.maxItems) }
}

// Mirrors sprintProblems in src/config.ts, so the dialog explains a bad value before the server rejects it.
function draftProblem(draft: Draft): string | null {
  const everyDays = Number(draft.everyDays)
  const budget = Number(draft.budgetUsd)
  const monthly = Number(draft.monthlyUsd)
  const items = Number(draft.maxItems)
  if (!(everyDays > 0)) return "The interval must be more than 0 days."
  if (!(budget > 0)) return "The budget per sprint must be more than $0."
  if (!(monthly >= budget)) return "The monthly cap must be at least the budget per sprint."
  if (!Number.isInteger(items) || items < 1 || items > 10) return "Items per sprint must be a whole number from 1 to 10."
  return null
}

function nextDueText(lastFinishedAt: string | null, everyDays: number): string {
  if (!lastFinishedAt || !(everyDays > 0)) return "The first sprint starts once the app is live."
  const due = new Date(Date.parse(lastFinishedAt) + everyDays * 24 * 60 * 60_000)
  return `Next sprint: ${due.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}.`
}

export function SprintSettingsDialog({ settings, lastFinishedAt, onSaved }: { settings: SprintSettings; lastFinishedAt: string | null; onSaved: () => void }) {
  const { name } = useProjectView()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => toDraft(settings))
  const [custom, setCustom] = useState(false)
  const [saving, setSaving] = useState(false)
  const problem = draftProblem(draft)
  const everyDays = Number(draft.everyDays)
  const preset = custom || !intervalPresets.includes(everyDays) ? customInterval : String(everyDays)
  const sprintsPerMonth = Math.floor(Number(draft.monthlyUsd) / Number(draft.budgetUsd))

  const changeOpen = (next: boolean) => {
    if (next) {
      setDraft(toDraft(settings))
      setCustom(!intervalPresets.includes(settings.everyDays))
    }
    setOpen(next)
  }
  const update = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }))
  const choosePreset = (value: string) => {
    if (!value) return
    setCustom(value === customInterval)
    if (value !== customInterval) update({ everyDays: value })
  }
  const save = async () => {
    setSaving(true)
    try {
      await api.saveSprintSettings(name, { ...draft, everyDays, budgetUsd: Number(draft.budgetUsd), monthlyUsd: Number(draft.monthlyUsd), maxItems: Number(draft.maxItems) })
      toast.success(draft.enabled ? `Sprints run every ${everyDays} days.` : "Sprints are off.")
      setOpen(false)
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the sprint settings.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-11 sm:h-9">
          <Settings /> Sprint settings
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sprint settings</DialogTitle>
          <DialogDescription>Changes apply from the next sprint. Saving commits pipeline.yaml.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3">
            <Switch id="sprint-enabled" checked={draft.enabled} onCheckedChange={(enabled) => update({ enabled })} aria-describedby="sprint-enabled-help" className="mt-0.5" />
            <div className="grid gap-0.5">
              <Label htmlFor="sprint-enabled">Run sprints</Label>
              <p id="sprint-enabled-help" className="text-xs text-muted-foreground">
                The doctor starts a sprint on this schedule once the app is live.
              </p>
            </div>
          </div>
          <div className="grid gap-2">
            <Label id="sprint-interval">Interval</Label>
            <ToggleGroup type="single" variant="outline" value={preset} onValueChange={choosePreset} aria-labelledby="sprint-interval" className="w-full flex-wrap">
              {intervalPresets.map((days) => (
                <ToggleGroupItem key={days} value={String(days)} className="h-11 flex-1 sm:h-9">
                  {days} days
                </ToggleGroupItem>
              ))}
              <ToggleGroupItem value={customInterval} className="h-11 flex-1 sm:h-9">
                Custom
              </ToggleGroupItem>
            </ToggleGroup>
            {preset === customInterval && (
              <div className="flex items-center gap-2">
                <Input type="number" min={0.25} step={0.25} value={draft.everyDays} onChange={(event) => update({ everyDays: event.target.value })} aria-label="Days between sprints" className="h-11 w-28 sm:h-9" />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Days from the end of one sprint to the start of the next. {draft.enabled && nextDueText(lastFinishedAt, everyDays)}</p>
          </div>
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="sprint-budget">Budget per sprint ($)</Label>
                <Input id="sprint-budget" type="number" min={1} value={draft.budgetUsd} onChange={(event) => update({ budgetUsd: event.target.value })} className="h-11 sm:h-9" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sprint-monthly">Monthly cap ($)</Label>
                <Input id="sprint-monthly" type="number" min={1} value={draft.monthlyUsd} onChange={(event) => update({ monthlyUsd: event.target.value })} className="h-11 sm:h-9" />
              </div>
            </div>
            {sprintsPerMonth >= 1 && (
              <p className="text-xs text-muted-foreground">
                At most {sprintsPerMonth} {sprintsPerMonth === 1 ? "sprint fits" : "sprints fit"} in the monthly cap.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sprint-items">Items per sprint</Label>
            <Input id="sprint-items" type="number" min={1} max={10} value={draft.maxItems} onChange={(event) => update({ maxItems: event.target.value })} className="h-11 w-28 sm:h-9" />
          </div>
          <div className="flex items-start gap-3">
            <Switch id="sprint-features" checked={draft.newFeatures} onCheckedChange={(newFeatures) => update({ newFeatures })} aria-describedby="sprint-features-help" className="mt-0.5" />
            <div className="grid gap-0.5">
              <Label htmlFor="sprint-features">PM may propose new features</Label>
              <p id="sprint-features-help" className="text-xs text-muted-foreground">
                Up to 2 ideas the brief does not ask for.
              </p>
            </div>
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} className="h-11 sm:h-9">
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || problem !== null} className="h-11 sm:h-9">
            {saving && <Loader2 className="animate-spin" />} Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
