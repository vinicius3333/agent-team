import { cn } from "@/lib/utils"

export function EmptyProjectsIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={cn("size-28", className)}>
      <path d="M40 26h24l14 24-14 24H40L26 50z" className="text-primary" stroke="currentColor" />
      <path d="M83 16c1.2 4.4 2.6 5.8 7 7-4.4 1.2-5.8 2.6-7 7-1.2-4.4-2.6-5.8-7-7 4.4-1.2 5.8-2.6 7-7z" className="text-primary" stroke="currentColor" fill="currentColor" fillOpacity="0.12" />
      <path d="M58 60h12l8 8v24a3 3 0 0 1-3 3H58a3 3 0 0 1-3-3V63a3 3 0 0 1 3-3z" className="fill-card text-muted-foreground" stroke="currentColor" />
      <path d="M70 60v8h8" className="text-muted-foreground" stroke="currentColor" />
    </svg>
  )
}
