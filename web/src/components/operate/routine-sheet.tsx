import { useState } from "react"
import { Image, Info, Loader2, Pencil, Search, Trash2, TrendingUp, type LucideIcon } from "lucide-react"
import { routineOutputs, routineTriggers, type RoutineConfig, type RoutineOutput, type RoutinesSnapshot, type RoutineTrigger } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

interface Template {
  label: string
  icon: LucideIcon
  routine: Pick<RoutineConfig, "name" | "role" | "instructions" | "output" | "budgetUsd">
}

const templates: Template[] = [
  {
    label: "Marketing images",
    icon: Image,
    routine: { name: "Weekly social posts", role: "marketer", output: "marketing", budgetUsd: 2, instructions: "Make 3 square Instagram images about this week's best features. Use the brand colors and the logo. Keep the text under 8 words per image." },
  },
  {
    label: "Market research",
    icon: Search,
    routine: { name: "Market research", role: "researcher", output: "backlog", budgetUsd: 1, instructions: "Find what users of similar products ask for in reviews and forums. Log the gaps this app should close." },
  },
  {
    label: "SEO audit",
    icon: TrendingUp,
    routine: { name: "SEO keyword scan", role: "researcher", output: "report", budgetUsd: 1, instructions: "Find 10 search terms our users type that the landing page misses. Suggest a title and a description for each." },
  },
  { label: "Custom", icon: Pencil, routine: { name: "", role: "pm", output: "report", budgetUsd: 1, instructions: "" } },
]

export const triggerLabels: Record<RoutineTrigger, string> = { interval: "Every N days", sprint: "After each sprint", deploy: "After each deploy", manual: "Manual" }
const outputDescriptions: Record<RoutineOutput, { label: string; detail: string }> = {
  marketing: { label: "Marketing", detail: "Images in marketing/routines/" },
  backlog: { label: "Backlog", detail: "Findings the next sprint weighs" },
  report: { label: "Report", detail: "A doc in docs/routines/" },
}

export const emptyRoutine: RoutineConfig = { id: "", trigger: "interval", everyDays: 7, enabled: true, ...templates[0].routine }

function draftProblem(draft: RoutineConfig, builtIn: boolean, canDrawImages: boolean): string | null {
  if (draft.trigger === "interval" && !(draft.everyDays > 0)) return "The interval must be more than 0 days."
  if (builtIn) return null
  if (!draft.name.trim()) return "Give the routine a name."
  if (!draft.instructions.trim()) return "Tell the agent what to do."
  if (!(draft.budgetUsd > 0 && draft.budgetUsd <= 10)) return "The budget per run must be above $0 and at most $10."
  if (draft.output === "marketing" && !canDrawImages) return "Marketing images need a role on the codex runner, which can generate images."
  return null
}

export function RoutineSheet({
  open,
  initial,
  builtIn,
  roles,
  onOpenChange,
  onSave,
  onDelete,
}: {
  open: boolean
  initial: RoutineConfig
  builtIn: boolean
  roles: RoutinesSnapshot["roles"]
  onOpenChange: (open: boolean) => void
  onSave: (routine: RoutineConfig) => Promise<boolean>
  onDelete?: () => Promise<boolean>
}) {
  const isMobile = useIsMobile()
  const isNew = !initial.id
  const [draft, setDraft] = useState(initial)
  const [template, setTemplate] = useState(templates[0].label)
  const [saving, setSaving] = useState(false)
  const role = roles.find((entry) => entry.role === draft.role)
  const canDrawImages = role?.runner === "codex"
  const problem = draftProblem(draft, builtIn, canDrawImages)
  const triggers = builtIn ? routineTriggers.filter((trigger) => trigger === "interval" || trigger === "manual") : routineTriggers
  const update = (changes: Partial<RoutineConfig>) => setDraft((current) => ({ ...current, ...changes }))

  const pickTemplate = (label: string) => {
    const picked = templates.find((entry) => entry.label === label)
    if (!picked) return
    setTemplate(label)
    update(picked.routine)
  }
  const run = async (action: () => Promise<boolean>) => {
    setSaving(true)
    try {
      if (await action()) onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? "bottom" : "right"} className={cn("gap-0 overflow-y-auto", isMobile ? "max-h-[92dvh]" : "w-full sm:max-w-lg")}>
        <SheetHeader>
          <SheetTitle>{isNew ? "New routine" : builtIn ? draft.name : "Edit routine"}</SheetTitle>
          <SheetDescription>{builtIn ? "A built-in Operate agent. Its data and prompt are fixed; you set when it runs." : "Pick an agent, tell it what to do, and when."}</SheetDescription>
        </SheetHeader>
        <form
          id="routine-form"
          className="flex flex-col gap-5 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!problem) void run(() => onSave(draft))
          }}
        >
          {isNew && (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Start from</legend>
              <div className="grid grid-cols-2 gap-2">
                {templates.map((entry) => (
                  <button
                    key={entry.label}
                    type="button"
                    aria-pressed={template === entry.label}
                    onClick={() => pickTemplate(entry.label)}
                    className={cn("flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted/60", template === entry.label && "border-primary bg-primary/5 text-primary")}
                  >
                    <entry.icon className="size-4 shrink-0" aria-hidden="true" /> {entry.label}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {!builtIn && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="routine-name">Name</Label>
                <Input id="routine-name" value={draft.name} onChange={(event) => update({ name: event.target.value })} className="h-11 sm:h-9" />
              </div>
              <div className="grid gap-2">
                <Label id="routine-agent">Agent</Label>
                <ToggleGroup type="single" variant="outline" value={draft.role} onValueChange={(value) => value && update({ role: value })} aria-labelledby="routine-agent" className="w-full flex-wrap">
                  {roles.map((entry) => (
                    <ToggleGroupItem key={entry.role} value={entry.role} className="h-11 flex-1 sm:h-9">
                      {entry.role}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {role && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">
                      {role.runner} {role.model}
                    </span>
                    {role.capabilities.length > 0 && ` · Can use: ${role.capabilities.join(", ").toLowerCase()}.`}
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="routine-instructions">Instructions</Label>
                <Textarea id="routine-instructions" rows={4} value={draft.instructions} onChange={(event) => update({ instructions: event.target.value })} />
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label id="routine-when">When</Label>
            <ToggleGroup type="single" variant="outline" value={draft.trigger} onValueChange={(value) => value && update({ trigger: value as RoutineTrigger })} aria-labelledby="routine-when" className="grid w-full grid-cols-2 sm:flex">
              {triggers.map((trigger) => (
                <ToggleGroupItem key={trigger} value={trigger} className="h-11 flex-1 px-2 sm:h-9">
                  {triggerLabels[trigger]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {draft.trigger === "interval" && (
              <div className="flex items-center gap-2">
                <Input type="number" min={0.25} step={0.25} value={draft.everyDays} onChange={(event) => update({ everyDays: Number(event.target.value) })} aria-label="Days between runs" className="h-11 w-28 sm:h-9" />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            )}
            {draft.trigger === "sprint" && <p className="text-xs text-muted-foreground">Runs once a sprint's change is merged and redeployed.</p>}
            {draft.trigger === "deploy" && <p className="text-xs text-muted-foreground">Runs after the app goes live again.</p>}
            {draft.trigger === "manual" && <p className="text-xs text-muted-foreground">Runs only when you click Run now.</p>}
          </div>
          {!builtIn && (
            <>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Output</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {routineOutputs.map((output) => {
                    const unavailable = output === "marketing" && !canDrawImages
                    return (
                      <label
                        key={output}
                        className={cn("flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm", draft.output === output && "border-primary bg-primary/5", unavailable && "cursor-not-allowed opacity-50")}
                        title={unavailable ? "Pick a role on the codex runner to generate images." : undefined}
                      >
                        <input type="radio" name="routine-output" value={output} checked={draft.output === output} disabled={unavailable} onChange={() => update({ output })} className="mt-0.5 accent-primary" />
                        <span className="grid gap-0.5">
                          <span className="font-medium">{outputDescriptions[output].label}</span>
                          <span className="text-xs text-muted-foreground">{outputDescriptions[output].detail}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>
              <div className="grid gap-1.5">
                <Label htmlFor="routine-budget">Budget per run ($)</Label>
                <Input id="routine-budget" type="number" min={0.1} max={10} step={0.1} value={draft.budgetUsd} onChange={(event) => update({ budgetUsd: Number(event.target.value) })} className="h-11 w-28 sm:h-9" />
              </div>
              <p className="flex gap-2 text-xs text-muted-foreground">
                <Info className="size-4 shrink-0" aria-hidden="true" /> Routines write only inside the project. Code changes go to the backlog for the next sprint.
              </p>
            </>
          )}
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </form>
        <SheetFooter className="border-t sm:flex-row sm:justify-end">
          {onDelete && (
            <Button type="button" variant="ghost" className="h-11 text-destructive sm:mr-auto sm:h-9" disabled={saving} onClick={() => void run(onDelete)}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="routine-form" className="h-11 sm:h-9" disabled={saving || problem !== null}>
            {saving && <Loader2 className="animate-spin" />} {isNew ? "Create routine" : "Save routine"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
