import { useMemo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { useGLTF } from "@react-three/drei"
import { Mesh, type Group, type MeshStandardMaterial } from "three"
import buildingApartmentUrl from "@/assets/office/models/building-apartment.glb?url"
import buildingOfficeUrl from "@/assets/office/models/building-office.glb?url"
import { daylight, sceneHours, type SceneTime } from "./day-cycle"
import { useTexturedModel } from "./textured"

// Deterministic pseudo-random numbers so the skyline stays put between renders.
function seeded(seed: number) {
  let value = seed
  return () => {
    value = (value * 16807) % 2147483647
    return (value - 1) / 2147483646
  }
}

export function ModelSkyline({ time, z }: { time: SceneTime; z: number }) {
  const office = useTexturedModel(buildingOfficeUrl, 1)
  const apartment = useTexturedModel(buildingApartmentUrl, 1)
  const variants = useMemo(() => [office, apartment], [office, apartment])

  const placements = useMemo(() => {
    const random = seeded(42)
    const list: { key: string; x: number; height: number; variant: number }[] = []
    for (let x = -22; x < 22; ) {
      const variant = Math.floor(random() * variants.length)
      const height = 1.0 + random() * 0.7
      const width = variants[variant].width * height
      list.push({ key: `${x}`, x: x + width / 2, height, variant })
      x += width + 0.25 + random() * 0.5
    }
    return list
  }, [variants])
  const instances = useMemo(() => placements.map((placement) => variants[placement.variant].instance()), [placements, variants])

  const skyline = useRef<Group>(null)
  useFrame(() => {
    const { night } = daylight(sceneHours(time))
    // At night the facade texture glows, so the painted windows light up.
    skyline.current?.traverse((child) => {
      if (child instanceof Mesh) (child.material as MeshStandardMaterial).emissiveIntensity = night * 0.45
    })
  })

  return (
    <group ref={skyline} position={[0, 0, z]}>
      {placements.map((placement, index) => (
        <group key={placement.key} position={[placement.x, 0, 0]} scale={placement.height}>
          <primitive object={instances[index]} />
        </group>
      ))}
    </group>
  )
}

useGLTF.preload(buildingOfficeUrl)
useGLTF.preload(buildingApartmentUrl)
