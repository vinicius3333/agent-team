import { cn } from "@/lib/utils"

export function EmptyActivityIllustration({ className }: { className?: string }) {
  const rows = [
    { y: 30, width: 44 },
    { y: 50, width: 34 },
    { y: 70, width: 44 },
    { y: 90, width: 28 },
  ]
  return (
    <svg viewBox="0 0 120 120" fill="none" aria-hidden="true" className={cn("size-24", className)}>
      <path d="M34 34v56" className="text-muted-foreground" stroke="currentColor" strokeWidth="2" />
      {rows.map((row, index) => (
        <g key={row.y}>
          {index === 0 ? (
            <circle cx="34" cy={row.y} r="5" className="fill-card text-primary" stroke="currentColor" strokeWidth="3" />
          ) : (
            <circle cx="34" cy={row.y} r="5" className="fill-muted" />
          )}
          <rect x="48" y={row.y - 3} width={row.width} height="6" rx="3" className="fill-muted" />
        </g>
      ))}
    </svg>
  )
}
