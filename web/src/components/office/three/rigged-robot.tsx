import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal, useFrame } from "@react-three/fiber"
import { Html, useAnimations, useGLTF } from "@react-three/drei"
import { AnimationClip, Box3, Euler, Mesh, Quaternion, Vector3, type Bone, type Group, type MeshStandardMaterial, type Object3D } from "three"
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
  // Bones that the working motion rotates, with their rest rotations.
  fidget: { bone: Bone; rest: Quaternion }[]
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
    const bones = new Map<string, Bone>()
    instance.traverse((child) => {
      if ((child as Bone).isBone && !bones.has(child.name)) bones.set(child.name, child as Bone)
    })
    const head = bones.get("head") ?? null
    const fidget = fidgetBones.flatMap((name) => {
      const bone = bones.get(name)
      return bone ? [{ bone, rest: bone.quaternion.clone() }] : []
    })
    let face: Rig["face"] = null
    if (head) {
      const bone: Bone = head
      const visor = new Vector3((box.min.x + box.max.x) / 2, box.min.y + height * 0.57, box.max.z + height * 0.01)
      const scale = bone.getWorldScale(new Vector3()).x
      face = { position: bone.worldToLocal(visor.clone()), width: (width * 0.7) / scale }
    }
    return { scene: instance, scale: robotHeight / height, lift: -box.min.y * (robotHeight / height), head, fidget, face }
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
    // Blender exports from frame 1, and the last frame repeats the first. Starting at time 0
    // makes the loop close on that repeated frame instead of holding it twice.
    const start = Math.min(...tracks.map((track) => track.times[0]))
    if (!Number.isFinite(start) || start <= 0) return new AnimationClip(clip.name, clip.duration, tracks)
    const shifted = tracks.map((track) => track.clone().shift(-start))
    return new AnimationClip(clip.name, clip.duration - start, shifted)
  })
}

const fidgetBones = ["head", "antenna", "chest", "forearm.L", "forearm.R"]
const fidgetRotation = new Euler()
const fidgetQuaternion = new Quaternion()

// The "type" clip barely moves the forearms, which the chair hides from the camera,
// so a working robot also nods, glances, sways, and wiggles its antenna.
function fidgetAngles(name: string, time: number): [number, number, number] {
  const tap = (phase: number) => Math.max(0, Math.sin(time * 14 + phase)) * 0.25
  switch (name) {
    case "head":
      return [Math.sin(time * 2.4) * 0.06 - 0.08, Math.sin(time * 0.6) * 0.18, Math.sin(time * 1.1) * 0.04]
    case "antenna":
      return [Math.sin(time * 5) * 0.2, 0, Math.sin(time * 7.3) * 0.3]
    case "chest":
      return [0, Math.sin(time * 0.6) * 0.06, Math.sin(time * 1.2) * 0.03]
    case "forearm.L":
      return [tap(0), 0, 0]
    case "forearm.R":
      return [tap(Math.PI), 0, 0]
    default:
      return [0, 0, 0]
  }
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
  const fidget = useRef(0)
  // Runs before the mixer (hooks subscribe in call order): bones that no active clip drives
  // would otherwise keep last frame's fidget and drift further every frame.
  useFrame(() => {
    for (const { bone, rest } of rig.fidget) bone.quaternion.copy(rest)
  })
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

  useFrame(({ clock }, delta) => {
    const working = !moving && spot.pose === "desk" && desk.state === "working"
    fidget.current += ((working ? 1 : 0) - fidget.current) * Math.min(1, delta * 3)
    if (fidget.current < 1e-3) return
    for (const { bone } of rig.fidget) {
      const [x, y, z] = fidgetAngles(bone.name, clock.elapsedTime)
      fidgetRotation.set(x * fidget.current, y * fidget.current, z * fidget.current)
      bone.quaternion.multiply(fidgetQuaternion.setFromEuler(fidgetRotation))
    }
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
