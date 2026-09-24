import { useRef, useState } from "react"
import type { MeshBasicMaterial } from "three"
import { useFrame } from "@react-three/fiber"
import type { DeskState } from "@/lib/office"
import { models, useClayModel, type ModelSpec } from "./clay"
import { screenTextures, scrollingCode } from "./screen-textures"

export function Clay({ spec, position, rotationY = 0 }: { spec: ModelSpec; position: [number, number, number]; rotationY?: number }) {
  const { geometry } = useClayModel(spec)
  return (
    <mesh geometry={geometry} position={position} rotation-y={rotationY} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.75} />
    </mesh>
  )
}

// Tints multiply the screen texture: amber when waiting for approval, red after a failure.
const screenTints: Record<DeskState, string> = {
  working: "#ffffff",
  waiting: "#ffd48a",
  done: "#ffffff",
  failed: "#ff9a9a",
  idle: "#ffffff",
  skipped: "#ffffff",
}

// A monitor model plus a screen showing code, a passing check, or a screensaver.
export function Monitor({ position, state }: { position: [number, number, number]; state: DeskState }) {
  const { geometry, box, upperFront } = useClayModel(models.monitor)
  const [code] = useState(scrollingCode)
  const screen = useRef<MeshBasicMaterial>(null)
  const width = (box.max.x - box.min.x) * 0.84
  const height = (box.max.y - box.min.y) * 0.52
  const textures = screenTextures()
  const map = state === "done" ? textures.done : state === "idle" || state === "skipped" ? textures.idle : code
  useFrame((_, delta) => {
    if (state === "working" && screen.current?.map) screen.current.map.offset.y -= delta * 0.04
  })
  return (
    <group position={position}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.6} />
      </mesh>
      <mesh position={[0, box.min.y + (box.max.y - box.min.y) * 0.64, upperFront + 0.004]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial ref={screen} map={map} color={screenTints[state]} toneMapped={false} />
      </mesh>
    </group>
  )
}
