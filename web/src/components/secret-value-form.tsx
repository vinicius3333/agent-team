import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// A write-only value field: the server never sends a saved value back, so the field always starts empty.
export function SecretValueForm({
  name,
  onSave,
  disabledReason,
  children,
  className,
}: {
  name: string
  onSave: (value: string) => Promise<void>
  disabledReason?: string | null
  children?: React.ReactNode
  className?: string
}) {
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!value) return
    setSaving(true)
    try {
      await onSave(value)
      setValue("")
    } catch {
      // onSave already told the person; the value stays so they can retry.
    } finally {
      setSaving(false)
    }
  }
  const disabled = Boolean(disabledReason) || saving
  return (
    <form onSubmit={submit} className={cn("flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center", className)} title={disabledReason ?? undefined}>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`Value for ${name}`}
        placeholder="Paste value"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        className="h-11 font-mono placeholder:font-sans sm:h-9 sm:w-56"
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={disabled || !value} className="h-11 flex-1 sm:h-9 sm:flex-none">
          {saving && <Loader2 className="animate-spin" />} Save
        </Button>
        {children}
      </div>
    </form>
  )
}
