import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"

export function CopyButton({ value, label = "Copy" }: { value: string | (() => string); label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof value === "string" ? value : value())
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard access can be denied outside secure contexts.
    }
  }
  return (
    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={copy} aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  )
}
