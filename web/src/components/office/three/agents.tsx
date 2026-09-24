import { useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { Html } from "@react-three/drei"
import type { Group } from "three"
import { useProjectView } from "@/components/project/context"
import { officeDesks, type Desk, type DeskRole, type DeskState } from "@/lib/office"
import { cn } from "@/lib/utils"
import { models, useClayModel } from "./clay"
import { chairOffset, deskSeats, launchPad } from "./layout"
import { RiggedRobot, type Spot } from "./rigged-robot"

const loungeSpots: Spot[] = [
  { x: -6.75, z: 3.35, pose: "sofa" },
  { x: -6.1, z: 3.35, pose: "sofa" },
  { x: -5.45, z: 3.35, pose: "sofa" },
  { x: -4.4, z: 4.3, pose: "standing" },
  { x: -7.2, z: 4.5, pose: "standing" },
  { x: -3.3, z: 2.0, pose: "standing" },
  { x: -2.6, z: 2.3, pose: "standing" },
  { x: 3.2, z: 2.0, pose: "standing" },
  { x: 2.6, z: 2.3, pose: "standing" },
  { x: -1.6, z: -2.1, pose: "standing" },
]

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
  working: "bg-primary animate-pulse",
  waiting: "bg-amber-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-zinc-300",
}

const atDesk = (state: DeskState) => state === "working" || state === "waiting" || state === "failed"

function Label({ desk, visible }: { desk: Desk; visible: boolean }) {
  return (
    <div className={cn("pointer-events-none flex -translate-y-full flex-col items-center gap-1 transition-opacity", visible ? "opacity-100" : "opacity-0")}>
      {desk.bubble && (
        <div
          className={cn(
            "max-w-56 rounded-xl border bg-white px-2.5 py-1 text-center text-xs leading-snug text-zinc-800 shadow-md",
            desk.state === "waiting" && "border-amber-400",
            desk.state === "failed" && "border-red-400",
          )}
        >
          <span className="line-clamp-2">{desk.bubble}</span>
        </div>
      )}
      <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/90 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-zinc-800 shadow-sm">
        <span className={cn("size-2 rounded-full", stateDotClasses[desk.state])} aria-hidden="true" />
        {desk.label} · {stateLabels[desk.state]}
      </span>
    </div>
  )
}

function LaunchPad({ desk, onOpen }: { desk: Desk; onOpen: () => void }) {
  const { geometry } = useClayModel(models.rocket)
  const rocket = useRef<Group>(null)
  const launching = desk.state === "working"
  const shown = launching || desk.state === "done"
  useFrame(({ clock }) => {
    if (!rocket.current) return
    rocket.current.position.y = 0.2 + (launching ? Math.abs(Math.sin(clock.elapsedTime * 30)) * 0.03 : Math.sin(clock.elapsedTime) * 0.02)
  })
  return (
    <group position={[launchPad.x, 0, launchPad.z]} onClick={onOpen}>
      <mesh position={[0, 0.08, 0]} receiveShadow>
        <cylinderGeometry args={[1.0, 1.1, 0.16, 48]} />
        <meshStandardMaterial color="#3f3f55" />
      </mesh>
      <mesh position={[0, 0.165, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.7, 0.8, 48]} />
        <meshStandardMaterial color="#8b5cf6" emissive="#8b5cf6" emissiveIntensity={shown ? 1.5 : 0.3} toneMapped={false} />
      </mesh>
      {shown && (
        <group ref={rocket}>
          <mesh geometry={geometry} castShadow>
            <meshStandardMaterial vertexColors roughness={0.4} />
          </mesh>
          {launching && (
            <mesh position={[0, -0.05, 0]} rotation-x={Math.PI}>
              <coneGeometry args={[0.14, 0.4, 16]} />
              <meshStandardMaterial color="#fbbf24" emissive="#f97316" emissiveIntensity={2} toneMapped={false} />
            </mesh>
          )}
        </group>
      )}
      <Html position={[0, shown ? 1.9 : 0.6, 0]} style={{ transform: "translateX(-50%)" }} zIndexRange={[20, 0]}>
        <Label desk={desk} visible />
      </Html>
    </group>
  )
}

export function Agents() {
  const { detail, openPanel } = useProjectView()
  const desks = officeDesks(detail).filter((desk) => desk.state !== "skipped")
  const open = (desk: Desk) => {
    if (desk.task) openPanel({ kind: "task", id: desk.task.id })
    else if (desk.step) openPanel({ kind: "phase", id: desk.step })
  }

  let lounge = 0
  const spotFor = (desk: Desk): Spot => {
    const seat = deskSeats[desk.role as Exclude<DeskRole, "deploy">]
    const deskSpot: Spot = { x: seat.x, z: seat.z + chairOffset, pose: "desk" }
    if (atDesk(desk.state) || lounge >= loungeSpots.length) return deskSpot
    return loungeSpots[lounge++]
  }

  const deploy = desks.find((desk) => desk.role === "deploy")
  return (
    <group>
      {desks
        .filter((desk) => desk.role !== "deploy")
        .map((desk) => (
          <RiggedRobot key={desk.role} desk={desk} spot={spotFor(desk)} label={<Label desk={desk} visible />} onOpen={() => open(desk)} />
        ))}
      {deploy && <LaunchPad desk={deploy} onOpen={() => open(deploy)} />}
    </group>
  )
}
