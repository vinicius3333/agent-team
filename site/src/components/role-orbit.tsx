import { Brush, FileText, ListChecks, Network, Palette, Search, ShieldCheck, Users, type LucideIcon } from "lucide-react"
import type { RoleName } from "@/build-video/stages"
import { PixelHexagon } from "@/components/pixel-hexagon"

const roles: { name: RoleName; icon: LucideIcon }[] = [
  { name: "PM", icon: FileText },
  { name: "Architect", icon: Network },
  { name: "Illustrator", icon: Brush },
  { name: "Designer", icon: Palette },
  { name: "Planner", icon: ListChecks },
  { name: "Workers", icon: Users },
  { name: "Reviewer", icon: Search },
  { name: "QA", icon: ShieldCheck },
]

export function RoleOrbit({ activeRoles }: { activeRoles: RoleName[] }) {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[340px]">
      <div className="absolute inset-[13%] rounded-full border-2 border-dashed border-primary/25" />
      <PixelHexagon className="absolute inset-[29%]" />
      <ul aria-label="Agent roles">
        {roles.map((role, index) => {
          const angle = (index / roles.length) * 2 * Math.PI - Math.PI / 2
          const active = activeRoles.includes(role.name)
          const Icon = role.icon
          return (
            <li
              key={role.name}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
              style={{ left: `${50 + Math.cos(angle) * 37}%`, top: `${50 + Math.sin(angle) * 37}%` }}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={`grid size-11 place-items-center rounded-full border transition-all duration-300 ${
                  active
                    ? "scale-110 border-primary bg-primary text-primary-foreground shadow-[0_0_0_6px_rgb(124_58_237/0.18)]"
                    : "border-border bg-card text-primary"
                }`}
              >
                <Icon size={19} />
              </span>
              <span
                className={`rounded-md border px-1.5 text-[11px] font-medium whitespace-nowrap transition-colors duration-300 ${
                  active ? "border-primary/40 bg-accent text-accent-foreground" : "border-border bg-card text-foreground"
                }`}
              >
                {role.name}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
