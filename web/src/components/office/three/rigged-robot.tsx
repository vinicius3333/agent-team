import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal, useFrame } from "@react-three/fiber"
import { Html, useAnimations, useGLTF } from "@react-three/drei"
import { AnimationClip, Box3, Mesh, Vector3, type Bone, type Group, type MeshStandardMaterial, type Object3D } from "three"
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js"
import robotUrl from "@/assets/office/models/robot-rigged.glb?url"
import type { Desk, DeskState } from "@/lib/office"
import { Face } from "./face"

export type Pose = "desk" | "sofa" | "standing"

export interface Spot {
  x: number
  z: number
  pose: Pose
}

const robotHeight = 1.15
const walkSpeed = 1.3
// How high the hips sit above the robot's feet, as a fraction of its height (matches rig_robot.py).
const hipsFraction = 0.13
const seatHeights: Record<Pose, number> = { desk: 0.5, sofa: 0.42, standing: 0 }

interface Rig {
  scene: Object3D
  scale: number
  // The mesh is centered on its origin; this lifts it so the feet touch the floor.
  lift: number
  head: Bone | null
  // Visor center in the head bone's space, and its width in that space.
  face: { position: Vector3; width: number } | null
}

function useRig(): { rig: Rig; animations: AnimationClip[] } {
  const { scene, animations } = useGLTF(robotUrl)
  const rig = useMemo(() => {
    const instance = cloneSkinned(scene)
    instance.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = true
        child.frustumCulled = false
        // The generated texture ships with metalness 1, which renders black without an environment map.
        const material = child.material as MeshStandardMaterial
        material.metalness = 0
        material.roughness = 0.55
      }
    })
    instance.updateMatrixWorld(true)
    const box = new Box3().setFromObject(instance)
    const height = box.max.y - box.min.y
    const width = box.max.x - box.min.x
    let head: Bone | null = null
    instance.traverse((child) => {
      if (!head && (child as Bone).isBone && child.name === "head") head = child as Bone
    })
    let face: Rig["face"] = null
    if (head) {
      const bone: Bone = head
      const visor = new Vector3((box.min.x + box.max.x) / 2, box.min.y + height * 0.57, box.max.z + height * 0.01)
      const scale = bone.getWorldScale(new Vector3()).x
      face = { position: bone.worldToLocal(visor.clone()), width: (width * 0.7) / scale }
    }
    return { scene: instance, scale: robotHeight / height, lift: -box.min.y * (robotHeight / height), head, face }
  }, [scene])
  const clips = useMemo(() => layerableClips(animations, scene), [animations, scene])
  return { rig, animations: clips }
}

// Blender bakes every bone into every clip. Dropping the tracks that never leave the rest pose
// leaves each clip with only the bones it moves, so clips can play together (sit + type).
function layerableClips(clips: AnimationClip[], scene: Object3D): AnimationClip[] {
  const rest = new Map<string, number[]>()
  scene.traverse((child) => {
    if (!(child as Bone).isBone) return
    rest.set(`${child.name}.quaternion`, child.quaternion.toArray())
    rest.set(`${child.name}.position`, child.position.toArray())
    rest.set(`${child.name}.scale`, child.scale.toArray())
  })
  return clips.map((clip) => {
    const tracks = clip.tracks.filter((track) => {
      const restValue = rest.get(track.name)
      if (!restValue) return true
      const size = restValue.length
      for (let index = 0; index < track.values.length; index++) {
        if (Math.abs(Math.abs(track.values[index]) - Math.abs(restValue[index % size])) > 1e-3) return true
      }
      return false
    })
    return new AnimationClip(clip.name, clip.duration, tracks)
  })
}

// Which clips play together: legs (sit or walk) plus an upper-body clip.
function clipsFor(pose: Pose, state: DeskState, moving: boolean): string[] {
  if (moving) return ["walk"]
  const legs = pose === "standing" ? [] : ["sit"]
  if (pose === "desk") {
    if (state === "working") return [...legs, "type"]
    if (state === "waiting") return [...legs, "wave"]
    if (state === "failed") return [...legs, "slump"]
  }
  if (pose === "standing" && state === "done") return ["cheer"]
  return [...legs, "idle"]
}

export function RiggedRobot({ desk, spot, label, onOpen }: { desk: Desk; spot: Spot; label: ReactNode; onOpen: () => void }) {
  const { rig, animations } = useRig()
  const group = useRef<Group>(null)
  const { actions } = useAnimations(animations, group)
  const [moving, setMoving] = useState(false)
  const [hovered, setHovered] = useState(false)
  const target = useMemo(() => new Vector3(spot.x, 0, spot.z), [spot.x, spot.z])
  const clips = clipsFor(spot.pose, desk.state, moving).join(",")

  useEffect(() => {
    const active = clips.split(",")
    for (const [name, action] of Object.entries(actions)) {
      if (!action) continue
      if (active.includes(name)) action.reset().fadeIn(0.3).play()
      else action.fadeOut(0.3)
    }
  }, [actions, clips])

  useFrame((_, delta) => {
    const node = group.current
    if (!node) return
    const flat = new Vector3(node.position.x, 0, node.position.z)
    const remaining = target.clone().sub(flat)
    const distance = remaining.length()
    const isMoving = distance > 0.05
    if (isMoving !== moving) setMoving(isMoving)
    const seatY = isMoving ? 0 : Math.max(0, seatHeights[spot.pose] - robotHeight * hipsFraction)
    if (isMoving) {
      const step = Math.min(distance, walkSpeed * delta)
      node.position.addScaledVector(remaining.normalize(), step)
      turnTowards(node, Math.atan2(remaining.x, remaining.z), delta)
    } else {
      // A working robot faces its monitor; one that needs you turns to the camera.
      turnTowards(node, spot.pose === "desk" && desk.state === "working" ? Math.PI : 0, delta)
    }
    node.position.y += (seatY - node.position.y) * Math.min(1, delta * 8)
  })

  return (
    <group
      ref={group}
      position={[spot.x, 0, spot.z]}
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = ""
      }}
    >
      <primitive object={rig.scene} scale={rig.scale} position-y={rig.lift} />
      {rig.head &&
        rig.face &&
        createPortal(
          <group position={rig.face.position}>
            <Face state={desk.state} size={rig.face.width} />
          </group>,
          rig.head,
        )}
      <Html position={[0, robotHeight + 0.15, 0]} style={{ transform: "translateX(-50%)" }} zIndexRange={[20, 0]}>
        <div className={spot.pose === "desk" || hovered ? "opacity-100" : "opacity-0"}>{label}</div>
      </Html>
    </group>
  )
}

function turnTowards(node: Object3D, angle: number, delta: number) {
  let difference = angle - node.rotation.y
  difference = Math.atan2(Math.sin(difference), Math.cos(difference))
  node.rotation.y += difference * Math.min(1, delta * 6)
}

useGLTF.preload(robotUrl)
