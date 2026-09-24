import type { ComponentType, CSSProperties } from "react"
import { ClipboardList, CodeXml, DraftingCompass, FlaskConical, Palette, Rocket as RocketIcon, SearchCheck, SquareKanban, Stethoscope, SwatchBook } from "lucide-react"
import officeDay from "@/assets/office/office-day.webp"
import officeNight from "@/assets/office/office-night.webp"
import { useProjectView } from "@/components/project/context"
import { Card } from "@/components/ui/card"
import { useTheme } from "@/hooks/use-theme"
import { officeDesks, type Desk, type DeskRole, type DeskState } from "@/lib/office"
import { cn } from "@/lib/utils"
import { Robot, Rocket, type Pose } from "./robot"

// Positions are percentages of the 1600x1000 background. A spot is where the robot's
// bottom edge goes: the chair seat at a desk, the sofa seat, or the feet when standing.
interface Spot {
  left: number
  top: number
  pose: "seat" | "sofa" | "standing"
}

const deskSpots: Record<DeskRole, Spot> = {
  pm: { left: 16.9, top: 24, pose: "seat" },
  architect: { left: 38.5, top: 24, pose: "seat" },
  illustrator: { left: 60.2, top: 24, pose: "seat" },
  designer: { left: 82.6, top: 24, pose: "seat" },
  planner: { left: 16.1, top: 52, pose: "seat" },
  worker: { left: 42.5, top: 52, pose: "seat" },
  reviewer: { left: 57.6, top: 52, pose: "seat" },
  qa: { left: 83.8, top: 51, pose: "seat" },
  deploy: { left: 50, top: 81, pose: "standing" },
  doctor: { left: 84, top: 79, pose: "seat" },
}

const loungeSpots: Spot[] = [
  { left: 7.5, top: 84, pose: "sofa" },
  { left: 12.8, top: 79.5, pose: "sofa" },
  { left: 19.5, top: 83, pose: "standing" },
  { left: 23.3, top: 89, pose: "sofa" },
  { left: 32.5, top: 63, pose: "standing" },
  { left: 36.5, top: 62, pose: "standing" },
  { left: 29.5, top: 97, pose: "standing" },
  { left: 68, top: 63, pose: "standing" },
  { left: 72, top: 62, pose: "standing" },
  { left: 17.3, top: 78.5, pose: "sofa" },
]

const roleIcons: Record<DeskRole, ComponentType<{ className?: string }>> = {
  pm: ClipboardList,
  architect: DraftingCompass,
  illustrator: Palette,
  designer: SwatchBook,
  planner: SquareKanban,
  worker: CodeXml,
  reviewer: SearchCheck,
  qa: FlaskConical,
  deploy: RocketIcon,
  doctor: Stethoscope,
}

const stateLabels: Record<DeskState, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Needs approval",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
}

const stateDotClasses: Record<DeskState, string> = {
  idle: "bg-zinc-400",
  working: "bg-primary motion-safe:animate-pulse",
  waiting: "bg-warning",
  done: "bg-success",
  failed: "bg-destructive",
  skipped: "bg-zinc-300",
}

const atDesk = (state: DeskState) => state === "working" || state === "waiting" || state === "failed"

function position(spot: Spot): CSSProperties {
  return { left: `${spot.left}%`, top: `${spot.top}%` }
}

function NameTag({ desk }: { desk: Desk }) {
  const Icon = roleIcons[desk.role]
  return (
    <span className="inline-flex items-center gap-[0.35em] rounded-full border border-black/10 bg-white/90 px-[0.6em] py-[0.15em] font-medium whitespace-nowrap text-zinc-800 shadow-sm backdrop-blur-sm">
      <span className={cn("size-[0.55em] rounded-full", stateDotClasses[desk.state])} aria-hidden="true" />
      <Icon className="size-[1em] text-primary" />
      {desk.label}
    </span>
  )
}

function SpeechBubble({ desk }: { desk: Desk }) {
  if (!desk.bubble) return null
  return (
    <div
      className={cn(
        "absolute bottom-full left-1/2 mb-[0.4em] w-max max-w-[16em] -translate-x-1/2 rounded-[0.8em] border bg-white px-[0.7em] py-[0.35em] text-center leading-snug text-zinc-800 shadow-md",
        "after:absolute after:top-full after:left-1/2 after:-translate-x-1/2 after:border-[0.4em] after:border-transparent after:border-t-white",
        desk.state === "waiting" && "border-amber-400",
        desk.state === "failed" && "border-red-400",
      )}
    >
      <span className="line-clamp-2">{desk.bubble}</span>
    </div>
  )
}

function Agent({ desk, spot, onOpen }: { desk: Desk; spot: Spot; onOpen: () => void }) {
  const pose: Pose = spot.pose === "standing" ? "standing" : spot.pose === "seat" && desk.state === "working" ? "back" : "front"
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${desk.label}: ${stateLabels[desk.state]}${desk.bubble ? `. ${desk.bubble}` : ""}`}
      title={`${desk.label}: ${stateLabels[desk.state]}`}
      className="group absolute flex w-[5.4%] -translate-x-1/2 -translate-y-full flex-col items-center outline-none transition-[left,top] duration-[2500ms] ease-in-out motion-reduce:transition-none"
      style={{ ...position(spot), zIndex: Math.round(spot.top * 10) }}
    >
      <SpeechBubble desk={desk} />
      <Robot state={desk.state} pose={pose} className="transition-transform group-hover:-translate-y-[4%] group-focus-visible:-translate-y-[4%]" />
      <span
        className={cn(
          "absolute top-full left-1/2 mt-[0.3em] -translate-x-1/2 transition-opacity group-focus-visible:ring-2 group-focus-visible:ring-ring",
          spot.pose !== "seat" && "pointer-events-none opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      >
        <NameTag desk={desk} />
      </span>
    </button>
  )
}

function LaunchPad({ desk, onOpen }: { desk: Desk; onOpen: () => void }) {
  const launching = desk.state === "working"
  const shown = launching || desk.state === "done"
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Deploy: ${stateLabels[desk.state]}`}
      className="group absolute z-10 flex w-[3.4%] -translate-x-1/2 -translate-y-full flex-col items-center outline-none"
      style={position(deskSpots.deploy)}
    >
      <SpeechBubble desk={desk} />
      <Rocket launching={launching} className={cn("transition-opacity duration-700", shown ? "opacity-100" : "opacity-0")} />
      <span className="absolute top-full left-1/2 mt-[0.3em] -translate-x-1/2">
        <NameTag desk={desk} />
      </span>
    </button>
  )
}

// While the reviewer works, the task card hops from the worker's desk to the reviewer's.
function Courier({ label }: { label: string }) {
  const from = deskSpots.worker
  const to = deskSpots.reviewer
  const style = {
    "--from-left": `${from.left}%`,
    "--from-top": `${from.top - 6}%`,
    "--to-left": `${to.left}%`,
    "--to-top": `${to.top - 6}%`,
  } as CSSProperties
  return (
    <div className="pointer-events-none absolute z-20 -translate-x-1/2 motion-safe:animate-[office-fly_2.2s_ease-in-out_infinite] motion-reduce:hidden" style={style} aria-hidden="true">
      <div className="motion-safe:animate-[office-hop_2.2s_ease-in-out_infinite] rounded-[0.3em] bg-white px-[0.5em] py-[0.2em] font-mono font-semibold text-primary shadow-md ring-1 ring-primary/40">{label}</div>
    </div>
  )
}

function Legend() {
  const states: DeskState[] = ["working", "waiting", "done", "failed", "idle"]
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      {states.map((state) => (
        <span key={state} className="inline-flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", stateDotClasses[state])} aria-hidden="true" />
          {stateLabels[state]}
        </span>
      ))}
      <span>Agents at their desk are busy. Agents in the lounge are done or idle.</span>
    </div>
  )
}

export function OfficeScene() {
  const { detail, openPanel } = useProjectView()
  const { resolved } = useTheme()
  const desks = officeDesks(detail).filter((desk) => desk.state !== "skipped")

  const open = (target: Desk) => {
    if (target.task) openPanel({ kind: "task", id: target.task.id })
    else if (target.step) openPanel({ kind: "phase", id: target.step })
  }

  let lounge = 0
  const spotFor = (desk: Desk): Spot => (atDesk(desk.state) || lounge >= loungeSpots.length ? deskSpots[desk.role] : loungeSpots[lounge++])

  const deploy = desks.find((desk) => desk.role === "deploy")
  const reviewer = desks.find((desk) => desk.role === "reviewer")

  return (
    <Card className="gap-3 p-3">
      <div className="@container relative aspect-[16/10] w-full overflow-hidden rounded-lg text-[clamp(8px,1.05cqw,13px)]">
        <img src={resolved === "dark" ? officeNight : officeDay} alt="" className="absolute inset-0 size-full object-cover select-none" draggable={false} />
        {desks
          .filter((desk) => desk.role !== "deploy")
          .map((desk) => (
            <Agent key={desk.role} desk={desk} spot={spotFor(desk)} onOpen={() => open(desk)} />
          ))}
        {deploy && <LaunchPad desk={deploy} onOpen={() => open(deploy)} />}
        {reviewer?.state === "working" && reviewer.task && <Courier label={reviewer.task.id} />}
      </div>
      <Legend />
    </Card>
  )
}
