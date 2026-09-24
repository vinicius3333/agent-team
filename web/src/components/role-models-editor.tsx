import { useState } from "react"
import { Lock } from "lucide-react"
import type { RoleCandidate, RunnerName } from "@/api/types"
import { Input } from "@/components/ui/input"

export type RoleModels = Record<string, RoleCandidate>

export const editableRoles = ["pm", "architect", "illustrator", "designer", "planner", "worker", "reviewer", "qa"] as const

const roleLabels: Record<string, string> = {
  pm: "PM",
  architect: "Architect",
  illustrator: "Illustrator",
  designer: "Designer",
  planner: "Planner",
  worker: "Workers",
  reviewer: "Reviewer",
  qa: "QA",
}

const runners: RunnerName[] = ["claude", "codex"]

export const modelOptions: Record<RunnerName, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.5"],
}

const lockedRunners: Record<string, { runner: RunnerName; reason: string }> = {
  illustrator: { runner: "codex", reason: "Codex only: it draws the images." },
}

export const modelPattern = /^[A-Za-z0-9._:-]{1,64}$/

const otherOption = "__other__"

const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 md:text-sm dark:bg-input/30"

export function invalidRoles(models: RoleModels): string[] {
  return Object.entries(models)
    .filter(([, candidate]) => !modelPattern.test(candidate.model))
    .map(([role]) => role)
}

// The editable roles present in a role map, in pipeline order.
export function pickEditable(roles: Record<string, RoleCandidate>): RoleModels {
  return Object.fromEntries(editableRoles.filter((role) => roles[role]).map((role) => [role, { runner: roles[role].runner, model: roles[role].model }]))
}

interface RoleRowProps {
  role: string
  value: RoleCandidate
  fallbacks: RoleCandidate[]
  onChange: (value: RoleCandidate) => void
}

function RoleRow({ role, value, fallbacks, onChange }: RoleRowProps) {
  const runner = (runners.includes(value.runner as RunnerName) ? value.runner : "claude") as RunnerName
  const known = modelOptions[runner].includes(value.model)
  const [custom, setCustom] = useState(!known)
  const lock = lockedRunners[role]
  const invalid = !modelPattern.test(value.model)
  const id = `role-${role}`

  const changeRunner = (next: RunnerName) => {
    setCustom(false)
    onChange({ runner: next, model: modelOptions[next][0] })
  }
  const changeModel = (next: string) => {
    if (next === otherOption) {
      setCustom(true)
      onChange({ runner, model: "" })
      return
    }
    setCustom(false)
    onChange({ runner, model: next })
  }

  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[7rem_7rem_minmax(0,1fr)] sm:items-start">
      <div className="pt-2 text-sm font-medium">{roleLabels[role] ?? role}</div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-runner`} className="sr-only">
          {roleLabels[role]} runner
        </label>
        <select id={`${id}-runner`} className={selectClass} value={runner} disabled={Boolean(lock)} onChange={(event) => changeRunner(event.target.value as RunnerName)}>
          {runners.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {lock && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" aria-hidden="true" /> {lock.reason}
          </p>
        )}
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-model`} className="sr-only">
          {roleLabels[role]} model
        </label>
        <select id={`${id}-model`} className={selectClass} value={custom ? otherOption : value.model} onChange={(event) => changeModel(event.target.value)}>
          {modelOptions[runner].map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          <option value={otherOption}>Other…</option>
        </select>
        {custom && (
          <Input
            aria-label={`${roleLabels[role]} custom model`}
            value={value.model}
            onChange={(event) => onChange({ runner, model: event.target.value.trim() })}
            placeholder="Model name"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            className="font-mono"
          />
        )}
        {custom && invalid && <p className="text-xs text-destructive">Use 1 to 64 letters, digits, dots, dashes, underscores, or colons.</p>}
        {fallbacks.length > 0 && <p className="font-mono text-xs text-muted-foreground">then {fallbacks.map((fallback) => `${fallback.runner} ${fallback.model}`).join(" → ")}</p>}
      </div>
    </li>
  )
}

interface RoleModelsEditorProps {
  value: RoleModels
  fallbacks?: Record<string, RoleCandidate[]>
  onChange: (value: RoleModels) => void
}

export function RoleModelsEditor({ value, fallbacks = {}, onChange }: RoleModelsEditorProps) {
  return (
    <ul className="flex flex-col divide-y">
      {editableRoles
        .filter((role) => value[role])
        .map((role) => (
          <RoleRow key={role} role={role} value={value[role]} fallbacks={fallbacks[role] ?? []} onChange={(next) => onChange({ ...value, [role]: next })} />
        ))}
    </ul>
  )
}
