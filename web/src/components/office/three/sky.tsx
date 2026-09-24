import { useMemo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import {
  BufferAttribute,
  Color,
  type AmbientLight,
  type DirectionalLight,
  type HemisphereLight,
  type Mesh,
  type PlaneGeometry,
  type PointLight,
  type PointsMaterial,
  type Scene,
} from "three"
import { backdropZ, daylight, orbit, sceneHours, skyColors, type SceneTime } from "./day-cycle"
import { floor, lamps } from "./layout"
import { ModelSkyline } from "./skyline-models"
import { ModelSunAndMoon } from "./sky-models"

const horizonZ = backdropZ

// Deterministic pseudo-random numbers so the skyline and stars stay put between renders.
function seeded(seed: number) {
  let value = seed
  return () => {
    value = (value * 16807) % 2147483647
    return (value - 1) / 2147483646
  }
}

function Backdrop({ time }: { time: SceneTime }) {
  const geometry = useRef<PlaneGeometry>(null)
  const top = useMemo(() => new Color(), [])
  const bottom = useMemo(() => new Color(), [])
  useFrame(({ scene }) => {
    const plane = geometry.current
    if (!plane) return
    skyColors(sceneHours(time), top, bottom)
    let colors = plane.getAttribute("color") as BufferAttribute | undefined
    if (!colors) {
      colors = new BufferAttribute(new Float32Array(4 * 3), 3)
      plane.setAttribute("color", colors)
    }
    // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right.
    colors.setXYZ(0, top.r, top.g, top.b)
    colors.setXYZ(1, top.r, top.g, top.b)
    colors.setXYZ(2, bottom.r, bottom.g, bottom.b)
    colors.setXYZ(3, bottom.r, bottom.g, bottom.b)
    colors.needsUpdate = true
    ;(scene as Scene).background = bottom
  })
  return (
    <mesh position={[0, 7, backdropZ]}>
      <planeGeometry ref={geometry} args={[80, 22, 1, 1]} />
      <meshBasicMaterial vertexColors toneMapped={false} />
    </mesh>
  )
}

function Stars({ time }: { time: SceneTime }) {
  const material = useRef<PointsMaterial>(null)
  const positions = useMemo(() => {
    const random = seeded(7)
    const values = new Float32Array(160 * 3)
    for (let index = 0; index < 160; index++) {
      values.set([(random() - 0.5) * 50, 0.8 + random() * 6, backdropZ + 0.1], index * 3)
    }
    return values
  }, [])
  useFrame(() => {
    if (material.current) material.current.opacity = daylight(sceneHours(time)).night
  })
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial ref={material} color="#ffffff" size={2.2} sizeAttenuation={false} transparent depthWrite={false} />
    </points>
  )
}


const groundLevel = -0.25
const roadZ = -floor.depth / 2 - 1.15

// The office sits on a concrete slab in a paved plaza, with a street between it and the skyline.
function Ground() {
  const far = horizonZ
  const near = 40
  const dashes = Array.from({ length: 30 }, (_, index) => -29 + index * 2)
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, groundLevel, (far + near) / 2]} receiveShadow>
        <planeGeometry args={[90, near - far]} />
        <meshStandardMaterial color="#d3cdc3" />
      </mesh>
      <mesh position={[0, groundLevel / 2, 0]} receiveShadow castShadow>
        <boxGeometry args={[floor.width + 0.8, -groundLevel - 0.004, floor.depth + 0.8]} />
        <meshStandardMaterial color="#b9ad9c" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, groundLevel + 0.005, roadZ]} receiveShadow>
        <planeGeometry args={[90, 1.3]} />
        <meshStandardMaterial color="#5b5b66" />
      </mesh>
      {dashes.map((x) => (
        <mesh key={x} rotation-x={-Math.PI / 2} position={[x, groundLevel + 0.01, roadZ]}>
          <planeGeometry args={[0.9, 0.08]} />
          <meshStandardMaterial color="#f1ede4" />
        </mesh>
      ))}
    </group>
  )
}

export function Sky({ time }: { time: SceneTime }) {
  return (
    <group>
      <Backdrop time={time} />
      <Stars time={time} />
      <ModelSunAndMoon time={time} orbit={{ backdropZ, position: orbit }} />
      <group position-y={groundLevel}>
        <ModelSkyline time={time} z={backdropZ + 2.2} />
      </group>
      <Ground />
    </group>
  )
}

export function Lighting({ time }: { time: SceneTime }) {
  const sun = useRef<DirectionalLight>(null)
  const ambient = useRef<AmbientLight>(null)
  const hemisphere = useRef<HemisphereLight>(null)
  const lampLights = useRef<(PointLight | null)[]>([])
  const colors = useMemo(
    () => ({
      noon: new Color("#fff1dc"),
      low: new Color("#ff9d5c"),
      moon: new Color("#9fb0ff"),
      ambientDay: new Color("#ffffff"),
      ambientNight: new Color("#6b6fd6"),
      skyDay: new Color("#fff6e5"),
      skyNight: new Color("#2a2e6e"),
    }),
    [],
  )
  useFrame(() => {
    const hours = sceneHours(time)
    const { sunHeight, night } = daylight(hours)
    const light = sun.current
    if (light) {
      const [x, y] = orbit(hours, night > 0.5 ? 12 : 0)
      light.position.set(x * 0.8, Math.max(y, 1.5) + 4, -8)
      if (night > 0.5) light.color.copy(colors.moon)
      else light.color.lerpColors(colors.low, colors.noon, Math.min(1, Math.max(0, sunHeight * 2.5)))
      light.intensity = night > 0.5 ? 0.35 * night : 1.9 * (1 - night)
    }
    if (ambient.current) {
      ambient.current.intensity = 0.3 + 0.55 * (1 - night)
      ambient.current.color.lerpColors(colors.ambientDay, colors.ambientNight, night)
    }
    if (hemisphere.current) {
      hemisphere.current.intensity = 0.35 + 0.45 * (1 - night)
      hemisphere.current.color.lerpColors(colors.skyDay, colors.skyNight, night)
    }
    lampLights.current.forEach((lamp) => {
      if (lamp) lamp.intensity = night * 3
    })
  })
  return (
    <group>
      <ambientLight ref={ambient} />
      <hemisphereLight ref={hemisphere} groundColor="#d9c2a3" />
      <directionalLight
        ref={sun}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-bias={-0.0005}
      />
      {lamps.map(([x, z], index) => (
        <pointLight
          key={`${x},${z}`}
          ref={(light) => {
            lampLights.current[index] = light
          }}
          position={[x, 1.45, z]}
          color="#ffc978"
          distance={4.5}
          decay={1.4}
        />
      ))}
    </group>
  )
}

export function WallClock({ time }: { time: SceneTime }) {
  const hourHand = useRef<Mesh>(null)
  const minuteHand = useRef<Mesh>(null)
  useFrame(() => {
    const hours = sceneHours(time)
    const minutes = (hours % 1) * 60
    if (hourHand.current) hourHand.current.parent!.rotation.z = -((hours % 12) / 12) * Math.PI * 2
    if (minuteHand.current) minuteHand.current.parent!.rotation.z = -(minutes / 60) * Math.PI * 2
  })
  return (
    <group position={[0, 2.05, -floor.depth / 2 + 0.16]}>
      <mesh rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.42, 0.42, 0.08, 48]} />
        <meshStandardMaterial color="#7c3aed" />
      </mesh>
      <mesh position={[0, 0, 0.045]}>
        <circleGeometry args={[0.36, 48]} />
        <meshStandardMaterial color="#fbfaf7" />
      </mesh>
      {Array.from({ length: 12 }, (_, index) => {
        const angle = (index / 12) * Math.PI * 2
        return (
          <mesh key={index} position={[Math.sin(angle) * 0.3, Math.cos(angle) * 0.3, 0.05]} rotation-z={-angle}>
            <boxGeometry args={[0.02, index % 3 === 0 ? 0.07 : 0.04, 0.01]} />
            <meshStandardMaterial color="#2a2a3a" />
          </mesh>
        )
      })}
      <group position={[0, 0, 0.06]}>
        <mesh ref={hourHand} position={[0, 0.09, 0]}>
          <boxGeometry args={[0.035, 0.18, 0.01]} />
          <meshStandardMaterial color="#1e1b3a" />
        </mesh>
      </group>
      <group position={[0, 0, 0.07]}>
        <mesh ref={minuteHand} position={[0, 0.13, 0]}>
          <boxGeometry args={[0.022, 0.26, 0.01]} />
          <meshStandardMaterial color="#7c3aed" />
        </mesh>
      </group>
      <mesh position={[0, 0, 0.08]}>
        <circleGeometry args={[0.03, 16]} />
        <meshStandardMaterial color="#1e1b3a" />
      </mesh>
    </group>
  )
}
