import { ArrowRight } from "lucide-react"

export function FlowArrow({ className }: { className?: string }) {
  return (
    <div className={`flex h-10 w-16 items-center justify-center ${className ?? ""}`} aria-hidden="true">
      <ArrowRight className="text-primary" size={26} strokeWidth={2.5} />
    </div>
  )
}
