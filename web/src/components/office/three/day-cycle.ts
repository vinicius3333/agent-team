import { Color } from "three"

// One simulated day passes in this many real seconds. The scene starts at the viewer's local time.
export const secondsPerDay = 180

export interface Daylight {
  hours: number
  // -1 at midnight, 0 at sunrise/sunset, 1 at noon.
  sunHeight: number
  // 0 in full daylight, 1 at night; eases across dusk and dawn.
  night: number
}

// Where the scene clock starts and whether it runs. A frozen clock stays at `startHours`.
export interface SceneTime {
  startHours: number
  running: boolean
  // performance.now() when this clock was set, so switching modes never jumps.
  since: number
}

export function sceneHours(time: SceneTime): number {
  if (!time.running) return time.startHours
  const elapsedSeconds = (performance.now() - time.since) / 1000
  return (time.startHours + (elapsedSeconds * 24) / secondsPerDay) % 24
}

export function daylight(hours: number): Daylight {
  const sunHeight = Math.sin(((hours - 6) / 12) * Math.PI)
  const night = 1 - smoothstep(-0.15, 0.2, sunHeight)
  return { hours, sunHeight, night }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return x * x * (3 - 2 * x)
}

interface SkyStop {
  hours: number
  top: string
  bottom: string
}

const skyStops: SkyStop[] = [
  { hours: 0, top: "#060a22", bottom: "#161b45" },
  { hours: 4.5, top: "#0b1030", bottom: "#231f55" },
  { hours: 5.8, top: "#2c3470", bottom: "#c0708a" },
  { hours: 6.6, top: "#6fa3df", bottom: "#ffb27a" },
  { hours: 8.5, top: "#4f9fef", bottom: "#bfe3ff" },
  { hours: 16, top: "#4f9fef", bottom: "#c9e8ff" },
  { hours: 17.6, top: "#5a6db8", bottom: "#ffa05e" },
  { hours: 18.6, top: "#2a2c68", bottom: "#b8567a" },
  { hours: 19.8, top: "#0b1030", bottom: "#231f55" },
  { hours: 24, top: "#060a22", bottom: "#161b45" },
]

export function skyColors(hours: number, top: Color, bottom: Color) {
  const index = skyStops.findIndex((stop) => stop.hours > hours)
  const next = skyStops[Math.max(1, index)]
  const previous = skyStops[Math.max(0, index - 1)]
  const mix = (hours - previous.hours) / (next.hours - previous.hours)
  top.set(previous.top).lerp(new Color(next.top), mix)
  bottom.set(previous.bottom).lerp(new Color(next.bottom), mix)
}

export const backdropZ = -9.5

// The sun rises on the left and sets on the right; the moon follows the opposite arc.
export function orbit(hours: number, offset: number): [number, number] {
  const angle = ((hours - 6 + offset) / 12) * Math.PI
  return [-Math.cos(angle) * 12, Math.sin(angle) * 2.2 + 0.1]
}
