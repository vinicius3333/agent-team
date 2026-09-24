import { useMemo } from "react"
import { useGLTF } from "@react-three/drei"
import { Box3, Color, Mesh, type MeshStandardMaterial, type Object3D } from "three"

export interface TexturedModel {
  // Call once per placement; clones share geometry and materials.
  instance: () => Object3D
  materials: MeshStandardMaterial[]
  // Size after scaling the model to the requested height, feet on y = 0.
  width: number
  depth: number
}

// Loads a textured generated model, normalizes it to `height`, and makes its texture able to
// glow: `emissiveMap` reuses the color texture, so raising `emissiveIntensity` lights it up.
export function useTexturedModel(url: string, height: number, glow = 0): TexturedModel {
  const { scene } = useGLTF(url)
  return useMemo(() => {
    const root = scene.clone(true)
    const materials: MeshStandardMaterial[] = []
    root.traverse((child) => {
      if (!(child instanceof Mesh)) return
      child.castShadow = true
      child.receiveShadow = true
      const material = (child.material as MeshStandardMaterial).clone()
      material.metalness = 0
      material.roughness = 0.7
      material.emissiveMap = material.map
      material.emissive = new Color("#ffffff")
      material.emissiveIntensity = glow
      child.material = material
      materials.push(material)
    })
    const box = new Box3().setFromObject(root)
    const scale = height / (box.max.y - box.min.y)
    root.scale.setScalar(scale)
    root.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale, -((box.min.z + box.max.z) / 2) * scale)
    const wrapper = { root }
    return {
      instance: () => wrapper.root.clone(true),
      materials,
      width: (box.max.x - box.min.x) * scale,
      depth: (box.max.z - box.min.z) * scale,
    }
  }, [scene, height, glow])
}
