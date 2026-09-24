import type { DeskState } from "@/lib/office"
import { cn } from "@/lib/utils"

export type Pose = "back" | "front" | "standing"

const eyeClasses: Record<DeskState, string> = {
  working: "fill-violet-300",
  waiting: "fill-amber-300",
  done: "stroke-emerald-300",
  failed: "stroke-red-400",
  idle: "stroke-zinc-400",
  skipped: "stroke-zinc-500",
}

function Eyes({ state }: { state: DeskState }) {
  const color = eyeClasses[state]
  if (state === "working" || state === "waiting") {
    return (
      <g className={cn(color, "origin-center [transform-box:fill-box] motion-safe:animate-[office-blink_4s_ease-in-out_infinite]")}>
        <circle cx="33" cy="25" r="3.2" />
        <circle cx="47" cy="25" r="3.2" />
      </g>
    )
  }
  if (state === "done") {
    return (
      <g className={color} strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d="M30 26q3-4.5 6 0M44 26q3-4.5 6 0" />
      </g>
    )
  }
  if (state === "failed") {
    return (
      <g className={color} strokeWidth="2.6" strokeLinecap="round">
        <path d="M31 22l4 5M35 22l-4 5M45 22l4 5M49 22l-4 5" />
      </g>
    )
  }
  return (
    <g className={color} strokeWidth="2.6" strokeLinecap="round">
      <path d="M30 26h6M44 26h6" />
    </g>
  )
}

function Mug() {
  return (
    <g>
      <rect x="62" y="50" width="9" height="10" rx="2" className="fill-primary" />
      <path d="M71 53h2a2 2 0 0 1 0 4h-2" className="stroke-primary" strokeWidth="1.6" fill="none" />
      <path d="M64 46q1.5-2 0-4M68 46q1.5-2 0-4" className="stroke-foreground/30 motion-safe:animate-[office-steam_2.4s_ease-in-out_infinite]" strokeWidth="1.2" strokeLinecap="round" fill="none" />
    </g>
  )
}

function Back({ working }: { working: boolean }) {
  return (
    <g className={cn(working ? "motion-safe:animate-[office-bob_1.6s_ease-in-out_infinite]" : "motion-safe:animate-[office-bob_4s_ease-in-out_infinite]")}>
      <path d="M40 9V3" className="stroke-zinc-500" strokeWidth="2" />
      <circle cx="40" cy="3" r="3.2" className={cn(working ? "fill-primary motion-safe:animate-pulse" : "fill-zinc-400")} />
      <rect x="11" y="40" width="9" height="14" rx="4.5" className={cn("fill-zinc-50 stroke-zinc-400", working && "motion-safe:animate-[office-type_0.3s_ease-in-out_infinite_alternate]")} strokeWidth="1.6" />
      <rect x="60" y="40" width="9" height="14" rx="4.5" className={cn("fill-zinc-50 stroke-zinc-400", working && "motion-safe:animate-[office-type_0.3s_ease-in-out_0.15s_infinite_alternate]")} strokeWidth="1.6" />
      <rect x="19" y="38" width="42" height="28" rx="11" className="fill-zinc-100 stroke-zinc-400" strokeWidth="1.6" />
      <path d="M32 48h16M32 54h16" className="stroke-zinc-300" strokeWidth="2" strokeLinecap="round" />
      <rect x="16" y="8" width="48" height="34" rx="14" className="fill-white stroke-zinc-400" strokeWidth="1.6" />
      <rect x="12" y="19" width="5" height="12" rx="2.5" className="fill-violet-300" />
      <rect x="63" y="19" width="5" height="12" rx="2.5" className="fill-violet-300" />
      <path d="M30 22h20M30 28h20" className="stroke-zinc-200" strokeWidth="2.4" strokeLinecap="round" />
    </g>
  )
}

// Seated robots show only their upper body so the chair in the scene reads as the seat.
// "back" faces the monitor; "front" turns toward the viewer.
export function Robot({ state, pose, className }: { state: DeskState; pose: Pose; className?: string }) {
  const working = state === "working"
  const standing = pose === "standing"
  const height = standing ? 96 : 66
  return (
    <svg viewBox={`0 0 80 ${height}`} fill="none" aria-hidden="true" className={cn("w-full overflow-visible drop-shadow-[0_3px_3px_rgb(0_0_0/0.25)]", className)}>
      {pose === "back" ? (
        <Back working={working} />
      ) : (
        <g className={cn(working ? "motion-safe:animate-[office-bob_1.6s_ease-in-out_infinite]" : "motion-safe:animate-[office-bob_4s_ease-in-out_infinite]")}>
          <path d="M40 9V3" className="stroke-zinc-500" strokeWidth="2" />
          <circle cx="40" cy="3" r="3.2" className={cn(working ? "fill-primary motion-safe:animate-pulse" : state === "waiting" ? "fill-amber-400" : state === "failed" ? "fill-red-500" : "fill-zinc-400")} />
          <rect x="21" y="40" width="38" height="26" rx="10" className="fill-zinc-50 stroke-zinc-400" strokeWidth="1.6" />
          <rect x="31" y="47" width="18" height="7" rx="3.5" className={cn(working ? "fill-primary/80" : "fill-zinc-300")} />
          <rect x="16" y="8" width="48" height="34" rx="14" className="fill-white stroke-zinc-400" strokeWidth="1.6" />
          <rect x="12" y="19" width="5" height="12" rx="2.5" className="fill-violet-300" />
          <rect x="63" y="19" width="5" height="12" rx="2.5" className="fill-violet-300" />
          <rect x="22" y="14" width="36" height="22" rx="11" className="fill-zinc-900" />
          <Eyes state={state} />
          {state === "waiting" ? (
            <>
              <rect x="11" y="44" width="9" height="16" rx="4.5" className="fill-zinc-50 stroke-zinc-400" strokeWidth="1.6" />
              <rect x="66" y="14" width="9" height="22" rx="4.5" className="origin-bottom fill-zinc-50 stroke-zinc-400 [transform-box:fill-box] motion-safe:animate-[office-wave_0.6s_ease-in-out_infinite_alternate]" strokeWidth="1.6" />
            </>
          ) : (
            <>
              <rect x="11" y="44" width="9" height="16" rx="4.5" className="fill-zinc-50 stroke-zinc-400" strokeWidth="1.6" />
              <rect x="60" y="44" width="9" height="16" rx="4.5" className="fill-zinc-50 stroke-zinc-400" strokeWidth="1.6" />
            </>
          )}
          {state === "done" && <Mug />}
        </g>
      )}
      {standing && (
        <g className="fill-zinc-50 stroke-zinc-400" strokeWidth="1.6">
          <ellipse cx="40" cy="93" rx="22" ry="3" className="fill-black/20 stroke-none" />
          <rect x="27" y="64" width="10" height="26" rx="5" />
          <rect x="43" y="64" width="10" height="26" rx="5" />
        </g>
      )}
    </svg>
  )
}

export function Rocket({ launching, className }: { launching: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 40 70" fill="none" aria-hidden="true" className={cn("w-full overflow-visible drop-shadow-[0_4px_4px_rgb(0_0_0/0.3)]", className)}>
      <g className={cn(launching ? "motion-safe:animate-[office-bob_0.25s_ease-in-out_infinite]" : "motion-safe:animate-[office-bob_5s_ease-in-out_infinite]")}>
        <path d="M14 56q6 16 12 0z" className={cn("fill-amber-400", launching ? "motion-safe:animate-pulse" : "opacity-0")} />
        <path d="M20 2c10 8 13 24 11 46H9C7 26 10 10 20 2z" className="fill-white stroke-zinc-400" strokeWidth="1.6" />
        <circle cx="20" cy="24" r="6" className="fill-primary stroke-zinc-400" strokeWidth="1.6" />
        <path d="M9 36L2 52h8zM31 36l7 16h-8z" className="fill-primary stroke-zinc-400" strokeWidth="1.6" strokeLinejoin="round" />
        <rect x="14" y="48" width="12" height="8" rx="2" className="fill-zinc-400" />
      </g>
    </svg>
  )
}
