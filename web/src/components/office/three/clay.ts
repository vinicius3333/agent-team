import { useMemo } from "react"
import { useGLTF } from "@react-three/drei"
import { Box3, BufferGeometry, Color, Float32BufferAttribute, Mesh } from "three"
import chairUrl from "@/assets/office/models/chair.glb?url"
import deskUrl from "@/assets/office/models/desk.glb?url"
import bookshelfUrl from "@/assets/office/models/bookshelf.glb?url"
import lampUrl from "@/assets/office/models/lamp.glb?url"
import plantUrl from "@/assets/office/models/plant.glb?url"
import moonUrl from "@/assets/office/models/moon.glb?url"
import monitorUrl from "@/assets/office/models/monitor.glb?url"
import rocketUrl from "@/assets/office/models/rocket.glb?url"
import sofaUrl from "@/assets/office/models/sofa.glb?url"

// The generated models have geometry only (no normals, UVs or textures), so each one is
// painted in horizontal bands: `upTo` is a fraction of the model's height, bottom to top.
interface Band {
  upTo: number
  color: string
}

export interface ModelSpec {
  url: string
  height: number
  // Optional footprint width; stretches x and z when the generated proportions are off.
  width?: number
  rotationY: number
  bands: Band[]
}

export const models = {
  chair: { url: chairUrl, height: 1.0, rotationY: Math.PI / 2, bands: [{ upTo: 0.36, color: "#44445a" }, { upTo: 1, color: "#8b5cf6" }] },
  desk: { url: deskUrl, height: 0.76, width: 1.5, rotationY: 0, bands: [{ upTo: 0.86, color: "#4a4a5e" }, { upTo: 1, color: "#e2bb8a" }] },
  plant: { url: plantUrl, height: 1.1, rotationY: 0, bands: [{ upTo: 0.3, color: "#f1ede4" }, { upTo: 1, color: "#3f9d5a" }] },
  moon: { url: moonUrl, height: 1.2, rotationY: 0, bands: [{ upTo: 1, color: "#f3e7c1" }] },
  lamp: { url: lampUrl, height: 1.6, rotationY: 0, bands: [{ upTo: 0.66, color: "#3a3a48" }, { upTo: 1, color: "#f6e7c8" }] },
  sofa: { url: sofaUrl, height: 0.85, width: 2.2, rotationY: 0, bands: [{ upTo: 0.12, color: "#4a3a2e" }, { upTo: 1, color: "#7c4ddb" }] },
  bookshelf: {
    url: bookshelfUrl,
    height: 1.8,
    rotationY: 0,
    bands: [
      { upTo: 0.06, color: "#a87a4f" },
      { upTo: 0.22, color: "#7c6fd6" },
      { upTo: 0.28, color: "#a87a4f" },
      { upTo: 0.46, color: "#3fa58f" },
      { upTo: 0.52, color: "#a87a4f" },
      { upTo: 0.7, color: "#e0a458" },
      { upTo: 0.76, color: "#a87a4f" },
      { upTo: 1, color: "#b98a5a" },
    ],
  },
  rocket: { url: rocketUrl, height: 1.3, rotationY: 0, bands: [{ upTo: 0.34, color: "#7c3aed" }, { upTo: 0.76, color: "#f4f1fb" }, { upTo: 1, color: "#7c3aed" }] },
  monitor: { url: monitorUrl, height: 0.5, rotationY: 0, bands: [{ upTo: 0.14, color: "#3b3b4f" }, { upTo: 1, color: "#4b4b63" }] },
} satisfies Record<string, ModelSpec>

interface ClayModel {
  geometry: BufferGeometry
  box: Box3
  // How far forward (+z) the model reaches above 40% of its height; the monitor's screen face.
  upperFront: number
}

export function useClayModel(spec: ModelSpec): ClayModel {
  const { scene } = useGLTF(spec.url)
  return useMemo(() => {
    let source: Mesh | null = null
    scene.traverse((child) => {
      if (!source && child instanceof Mesh) source = child
    })
    if (!source) throw new Error(`${spec.url} has no mesh`)
    const mesh: Mesh = source
    mesh.updateWorldMatrix(true, false)
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    geometry.rotateY(spec.rotationY)
    geometry.computeBoundingBox()
    const raw = geometry.boundingBox!
    const scale = spec.height / (raw.max.y - raw.min.y)
    const footprintScale = spec.width ? spec.width / (raw.max.x - raw.min.x) : scale
    geometry.translate(-(raw.min.x + raw.max.x) / 2, -raw.min.y, -(raw.min.z + raw.max.z) / 2)
    geometry.scale(footprintScale, scale, footprintScale)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()

    const positions = geometry.getAttribute("position")
    const colors = new Float32Array(positions.count * 3)
    const palette = spec.bands.map((band) => ({ upTo: band.upTo, color: new Color(band.color) }))
    let upperFront = -Infinity
    for (let index = 0; index < positions.count; index++) {
      const heightFraction = positions.getY(index) / spec.height
      const band = palette.find((entry) => heightFraction <= entry.upTo) ?? palette[palette.length - 1]
      band.color.toArray(colors, index * 3)
      if (heightFraction > 0.4) upperFront = Math.max(upperFront, positions.getZ(index))
    }
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3))
    return { geometry, box: geometry.boundingBox!.clone(), upperFront }
  }, [scene, spec])
}


Object.values(models).forEach((spec) => useGLTF.preload(spec.url))
