import { useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { DoubleSide, type Group } from "three"
import type { DeskState } from "@/lib/office"

const faceColors: Record<DeskState, string> = {
  working: "#b79bff",
  waiting: "#fcd34d",
  done: "#6ee7b7",
  failed: "#fca5a5",
  idle: "#93a4c8",
  skipped: "#93a4c8",
}

// Double-sided: the rig's head bone faces away from its local +z, which would cull one-sided planes.
function Glow({ color }: { color: string }) {
  return <meshBasicMaterial color={color} side={DoubleSide} toneMapped={false} />
}

// Eyes and mouth drawn on the robot's visor; `size` is the visor width so it scales with the model.
export function Face({ state, size }: { state: DeskState; size: number }) {
  const eyes = useRef<Group>(null)
  const color = faceColors[state]
  const spacing = size * 0.2
  const eye = size * 0.1

  useFrame(({ clock }) => {
    if (!eyes.current) return
    const blinking = (state === "working" || state === "waiting") && clock.elapsedTime % 4 < 0.12
    eyes.current.scale.y = blinking ? 0.15 : 1
  })

  return (
    <group>
      <group ref={eyes} position={[0, size * 0.04, 0]}>
        {[-spacing, spacing].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            {(state === "working" || state === "waiting") && (
              <mesh>
                <circleGeometry args={[state === "waiting" ? eye * 1.25 : eye, 24]} />
                <Glow color={color} />
              </mesh>
            )}
            {state === "done" && (
              <mesh rotation-z={0}>
                <torusGeometry args={[eye, eye * 0.28, 8, 24, Math.PI]} />
                <Glow color={color} />
              </mesh>
            )}
            {state === "failed" &&
              [Math.PI / 4, -Math.PI / 4].map((angle) => (
                <mesh key={angle} rotation-z={angle}>
                  <planeGeometry args={[eye * 2.2, eye * 0.5]} />
                  <Glow color={color} />
                </mesh>
              ))}
            {(state === "idle" || state === "skipped") && (
              <mesh>
                <planeGeometry args={[eye * 2, eye * 0.6]} />
                <Glow color={color} />
              </mesh>
            )}
          </group>
        ))}
      </group>
      {state === "done" && (
        <mesh position={[0, -size * 0.1, 0]} rotation-z={Math.PI}>
          <torusGeometry args={[eye * 1.1, eye * 0.25, 8, 24, Math.PI]} />
          <Glow color={color} />
        </mesh>
      )}
      {state === "waiting" && (
        <mesh position={[0, -size * 0.13, 0]}>
          <ringGeometry args={[eye * 0.45, eye * 0.8, 24]} />
          <Glow color={color} />
        </mesh>
      )}
    </group>
  )
}
