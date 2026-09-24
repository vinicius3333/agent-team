import { useProjectView } from "@/components/project/context"
import { officeDesks, type DeskRole, type DeskState } from "@/lib/office"
import { models } from "./clay"
import { chairOffset, deskSeats, deskTopHeight } from "./layout"
import { Clay, Monitor } from "./models"

const monitorCounts: Partial<Record<DeskRole, number>> = { worker: 2, reviewer: 2, qa: 3 }

function Workstation({ role, state }: { role: Exclude<DeskRole, "deploy">; state: DeskState }) {
  const seat = deskSeats[role]
  const count = monitorCounts[role] ?? 1
  const spacing = 0.5
  return (
    <group position={[seat.x, 0, seat.z]}>
      <Clay spec={models.desk} position={[0, 0, 0]} />
      {Array.from({ length: count }, (_, index) => (
        <Monitor key={index} position={[(index - (count - 1) / 2) * spacing, deskTopHeight, -0.18]} state={state} />
      ))}
      <Clay spec={models.chair} position={[0, 0, chairOffset]} />
    </group>
  )
}

export function Workstations() {
  const { detail } = useProjectView()
  const states = new Map(officeDesks(detail).map((desk) => [desk.role, desk.state]))
  return (
    <group>
      {(Object.keys(deskSeats) as Exclude<DeskRole, "deploy">[]).map((role) => (
        <Workstation key={role} role={role} state={states.get(role) ?? "idle"} />
      ))}
    </group>
  )
}
