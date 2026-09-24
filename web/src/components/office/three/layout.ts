import type { DeskRole } from "@/lib/office"

// World units are meters. The camera looks from +z (front) toward -z (the window wall).
export const floor = { width: 17, depth: 11 }

export interface Room {
  id: string
  // Center and size of the room's floor area.
  x: number
  z: number
  width: number
  depth: number
  // Rooms are open toward the camera; these are the walls that exist.
  walls: ("back" | "left" | "right")[]
  rug: string
}

export const rooms: Room[] = [
  { id: "pm", x: -6.2, z: -3.6, width: 3.8, depth: 2.8, walls: ["back", "left", "right"], rug: "#b8a4f0" },
  { id: "architect", x: -2.1, z: -3.6, width: 3.8, depth: 2.8, walls: ["back", "left", "right"], rug: "#9fb4f5" },
  { id: "illustrator", x: 2.1, z: -3.6, width: 3.8, depth: 2.8, walls: ["back", "left", "right"], rug: "#d9a8e8" },
  { id: "designer", x: 6.2, z: -3.6, width: 3.8, depth: 2.8, walls: ["back", "left", "right"], rug: "#b8a4f0" },
  { id: "planner", x: -6.2, z: 0.2, width: 3.8, depth: 2.6, walls: ["back", "left", "right"], rug: "#a99be8" },
  { id: "bullpen", x: 0, z: 0.2, width: 5, depth: 2.6, walls: [], rug: "#8f7ae0" },
  { id: "qa", x: 6.2, z: 0.2, width: 3.8, depth: 2.6, walls: ["back", "left", "right"], rug: "#a99be8" },
  { id: "lounge", x: -5.9, z: 3.9, width: 4.4, depth: 2.6, walls: ["back", "left"], rug: "#9d86ec" },
  { id: "deploy", x: 0, z: 3.9, width: 4.6, depth: 2.6, walls: ["back"], rug: "#3f3f55" },
  { id: "doctor", x: 6.2, z: 3.9, width: 3.8, depth: 2.6, walls: ["back", "right"], rug: "#a99be8" },
]

// Where each agent's desk sits. The chair is in front of the desk (toward the camera),
// so a seated robot faces the monitor with its back to the viewer.
export interface Seat {
  x: number
  z: number
}

export const deskSeats: Record<Exclude<DeskRole, "deploy">, Seat> = {
  pm: { x: -6.2, z: -3.9 },
  architect: { x: -2.1, z: -3.9 },
  illustrator: { x: 2.1, z: -3.9 },
  designer: { x: 6.2, z: -3.9 },
  planner: { x: -6.2, z: -0.1 },
  worker: { x: -1.2, z: -0.1 },
  reviewer: { x: 1.2, z: -0.1 },
  qa: { x: 6.2, z: -0.1 },
  doctor: { x: 6.2, z: 3.6 },
}

export const deskDepth = 0.8
export const chairOffset = 0.75
export const launchPad = { x: 0, z: 3.9 }

export const wallHeight = 1.1
export const wallThickness = 0.12
export const windowWallHeight = 2.6
export const deskTopHeight = 0.76

export interface Palette {
  floor: string
  plank: string
  wall: string
  wallTop: string
  sky: string
  frame: string
}

export const palettes: Record<"light" | "dark", Palette> = {
  light: { floor: "#e2b98a", plank: "#d6a877", wall: "#f4efe8", wallTop: "#d9d0c4", sky: "#bfe3ff", frame: "#8b8fa3" },
  dark: { floor: "#6b4a33", plank: "#5c3f2b", wall: "#6d6a86", wallTop: "#56536d", sky: "#1b1f4a", frame: "#3a3a4f" },
}

export type Placement = [x: number, z: number, rotationY?: number]

export const plants: Placement[] = [
  [-7.7, -4.7],
  [-4.6, -4.7],
  [-0.5, -4.7],
  [3.7, -4.7],
  [7.7, -4.7],
  [-7.7, -0.8],
  [-2.9, -0.9],
  [2.9, -0.9],
  [7.7, -0.8],
  [-7.7, 4.9],
  [-3.9, 2.9],
  [-2.1, 4.9],
  [2.1, 4.9],
  [7.7, 4.9],
  [4.6, 2.9],
]

export const bookshelves: Placement[] = [
  [-7.6, -3.3, Math.PI / 2],
  [-3.6, -3.3, Math.PI / 2],
  [7.6, -3.3, -Math.PI / 2],
  [-7.6, 0.6, Math.PI / 2],
  [7.6, 4.0, -Math.PI / 2],
]

export const lamps: Placement[] = [
  [-7.6, 3.0],
  [-4.2, 3.0],
  [0.7, -4.7],
  [4.6, -4.7],
  [4.7, 3.0],
]
