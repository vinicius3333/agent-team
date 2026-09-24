import { useMemo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { useGLTF } from "@react-three/drei"
import type { Group, Mesh, MeshBasicMaterial } from "three"
import sunUrl from "@/assets/office/models/sun.glb?url"
import { models, useClayModel } from "./clay"
import { daylight, sceneHours, type SceneTime } from "./day-cycle"
import { useTexturedModel } from "./textured"

// The camera looks from this angle around the y axis; the sun and moon turn to face it.
const cameraAzimuth = Math.atan2(5, 15)

const sunHeightUnits = 1.7

interface Orbit {
  backdropZ: number
  position: (hours: number, offset: number) => [number, number]
}

export function ModelSunAndMoon({ time, orbit }: { time: SceneTime; orbit: Orbit }) {
  const sunModel = useTexturedModel(sunUrl, sunHeightUnits, 0.85)
  const moonModel = useClayModel(models.moon)
  const sun = useMemo(() => sunModel.instance(), [sunModel])
  const sunGroup = useRef<Group>(null)
  const sunBody = useRef<Group>(null)
  const moon = useRef<Mesh>(null)
  const glow = useRef<Mesh>(null)
  const glowMaterial = useRef<MeshBasicMaterial>(null)

  useFrame(() => {
    const hours = sceneHours(time)
    const { sunHeight } = daylight(hours)
    const [sunX, sunY] = orbit.position(hours, 0)
    const [moonX, moonY] = orbit.position(hours, 12)
    sunGroup.current?.position.set(sunX, sunY, orbit.backdropZ + 0.35)
    const seconds = performance.now() / 1000
    const body = sunBody.current
    if (body) {
      // Idle: a slow sway, a gentle bob and a breathing pulse.
      body.rotation.z = Math.sin(seconds * 0.7) * 0.09
      body.position.y = Math.sin(seconds * 1.1) * 0.06
      body.scale.setScalar(1 + Math.sin(seconds * 1.6) * 0.025)
    }
    glow.current?.position.set(sunX, sunY, orbit.backdropZ + 0.1)
    moon.current?.position.set(moonX, moonY - 0.6, orbit.backdropZ + 0.35)
    if (glowMaterial.current) glowMaterial.current.opacity = 0.18 + Math.max(0, sunHeight) * 0.12
  })

  return (
    <group>
      <mesh ref={glow}>
        <circleGeometry args={[1.5, 48]} />
        <meshBasicMaterial ref={glowMaterial} color="#ffd36b" transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={sunGroup} rotation-y={cameraAzimuth}>
        <group ref={sunBody}>
          <group position-y={-sunHeightUnits / 2}>
            <primitive object={sun} />
          </group>
        </group>
      </group>
      <mesh ref={moon} geometry={moonModel.geometry} rotation-y={cameraAzimuth}>
        <meshStandardMaterial vertexColors emissive="#fff1c8" emissiveIntensity={0.55} roughness={0.9} />
      </mesh>
    </group>
  )
}

useGLTF.preload(sunUrl)
