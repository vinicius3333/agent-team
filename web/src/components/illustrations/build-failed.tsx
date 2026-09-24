import { cn } from "@/lib/utils"

export function BuildFailedIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={cn("size-24", className)}>
      <path d="M38 30h18l6 10-22 36-14-24z" className="fill-muted text-primary" stroke="currentColor" />
      <path d="M62 26h18l18 30-12 20-24-14 8-14z" className="fill-muted text-muted-foreground" stroke="currentColor" />
      <path d="M58 70l24 14-10 16H48l-4-6z" className="fill-muted text-muted-foreground" stroke="currentColor" />
      <path d="M92 82a6 6 0 0 0 8 8l-2-4-4-2zM94 90l-10 10" className="text-muted-foreground" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  )
}
