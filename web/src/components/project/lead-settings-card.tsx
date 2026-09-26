import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { leadActionKinds, type LeadActionKind, type LeadSettings } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useProjectView } from "./context"

const defaults: LeadSettings = { actions: [...leadActionKinds], autoApply: [], chatBudgetUsd: 2, access: "read" }
const maxChatBudgetUsd = 20

type LeadAccess = NonNullable<LeadSettings["access"]>

const accessChoices: { value: LeadAccess; label: string }[] = [
  { value: "read", label: "Limited" },
  { value: "full", label: "Full" },
]

const kindDescriptions: Record<LeadActionKind, { label: string; effect: string }> = {
  retry: { label: "Retry a task", effect: "Resets a blocked task so it runs again." },
  resume: { label: "Resume the run", effect: "Starts a stopped run." },
  approve: { label: "Approve a phase", effect: "Passes a gate that waits for you." },
  request_changes: { label: "Send a phase back", effect: "Reruns a phase with the lead's notes." },
  raise_budget: { label: "Raise the budget", effect: "Adds 50% to budget.runUsd. Spends more money." },
  add_task: { label: "Add a task", effect: "Appends a task to tasks.json. A worker builds it and a reviewer checks it." },
  edit_task: { label: "Change a task", effect: "Edits a pending or blocked task in tasks.json." },
}

function sameSettings(first: LeadSettings, second: LeadSettings): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

export function LeadSettingsCard() {
  const { name, detail } = useProjectView()
  const current = detail.config?.lead ?? defaults
  // Unset access means limited, the stored value "read".
  const saved: LeadSettings = { ...current, access: current.access ?? "read" }
  const [draft, setDraft] = useState<LeadSettings>(saved)
  const [budgetText, setBudgetText] = useState(String(saved.chatBudgetUsd))
  const [saving, setSaving] = useState(false)
  const savedKey = JSON.stringify(saved)

  // Follows the stream when nothing is being edited here.
  useEffect(() => {
    const next = JSON.parse(savedKey) as LeadSettings
    setDraft(next)
    setBudgetText(String(next.chatBudgetUsd))
  }, [savedKey])

  const budget = Number(budgetText)
  const budgetValid = Number.isFinite(budget) && budget > 0 && budget <= maxChatBudgetUsd
  const next = { ...draft, chatBudgetUsd: budgetValid ? budget : draft.chatBudgetUsd }
  const dirty = !sameSettings(next, saved)

  const toggle = (field: "actions" | "autoApply", kind: LeadActionKind, on: boolean) => {
    setDraft((current) => {
      const list = on ? [...current[field], kind] : current[field].filter((entry) => entry !== kind)
      const ordered = leadActionKinds.filter((entry) => list.includes(entry))
      // Turning off a suggestion also turns off applying it without a click.
      if (field === "actions" && !on) return { ...current, actions: ordered, autoApply: current.autoApply.filter((entry) => entry !== kind) }
      return { ...current, [field]: ordered }
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.saveLeadSettings(name, next)
      toast.success("Lead permissions saved. The next answer uses them.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the lead permissions.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="gap-3 lg:col-span-2">
      <CardHeader>
        <CardTitle>Project lead permissions</CardTitle>
        <CardDescription>
          What the lead may suggest in the chat, and what applies without a click. With limited access, the lead never edits files itself; code changes go through tasks. Saved to pipeline.yaml for this project only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-0 sm:px-6">
        <div className="flex flex-col gap-1.5 px-6 sm:px-0">
          <Label id="lead-access">Access</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={draft.access ?? "read"}
            onValueChange={(value) => value && setDraft((current) => ({ ...current, access: value as LeadAccess }))}
            aria-labelledby="lead-access"
            className="w-full sm:w-fit"
          >
            {accessChoices.map((choice) => (
              <ToggleGroupItem key={choice.value} value={choice.value} className="h-11 flex-1 sm:h-9 sm:flex-none sm:px-4">
                {choice.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">Full access lets the lead edit any file and run any command in the project folder, with no review.</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead className="w-28 text-center">May suggest</TableHead>
              <TableHead className="w-28 text-center">Auto-apply</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leadActionKinds.map((kind) => {
              const allowed = draft.actions.includes(kind)
              return (
                <TableRow key={kind}>
                  <TableCell className="whitespace-normal">
                    <p className="font-medium">{kindDescriptions[kind].label}</p>
                    <p className="text-xs text-muted-foreground">{kindDescriptions[kind].effect}</p>
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch checked={allowed} onCheckedChange={(on) => toggle("actions", kind, on)} aria-label={`Lead may suggest: ${kindDescriptions[kind].label}`} />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={draft.autoApply.includes(kind)}
                      disabled={!allowed}
                      onCheckedChange={(on) => toggle("autoApply", kind, on)}
                      aria-label={`Apply without a click: ${kindDescriptions[kind].label}`}
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-1.5 px-6 sm:px-0">
          <Label htmlFor="lead-chat-budget">Budget per answer (USD)</Label>
          <Input
            id="lead-chat-budget"
            type="number"
            inputMode="decimal"
            min={0.1}
            max={maxChatBudgetUsd}
            step="0.1"
            value={budgetText}
            onChange={(event) => setBudgetText(event.target.value)}
            aria-invalid={!budgetValid}
            className="w-32"
          />
          <p className="text-xs text-muted-foreground">{budgetValid ? "Chat cost never counts against the run budget." : `Enter an amount above $0 and at most $${maxChatBudgetUsd}.`}</p>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(saved)
            setBudgetText(String(saved.chatBudgetUsd))
          }}
        >
          Reset
        </Button>
        <Button onClick={save} disabled={!dirty || !budgetValid || saving}>
          {saving && <Loader2 className="animate-spin" />} Save permissions
        </Button>
      </CardFooter>
    </Card>
  )
}
